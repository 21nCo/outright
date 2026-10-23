import { createOutrightRuntime } from "./outright-runtime.mjs";
import { recoverArchiveBeforeStartup } from "./database.mjs";
import { writeStartupUnavailable } from "./startup-response.mjs";

// Config reloads can create the successor plugin before Vite closes the old
// server. A local shutdown is a known, finite lease owner, unlike an unrelated
// process holding the same database.
const shutdownRegistry = Symbol.for("outright.viteRuntimeShutdowns");
const shuttingDownRuntimes = globalThis[shutdownRegistry] ??= new Map();
// Vite's restart configures the replacement server before it closes the old
// one, so a plugin whose successor has configured is closing for a restart.
// Its runtime then keeps live terminals for the successor to reattach; a
// close with no successor is a quit and ends them.
const serverRegistry = Symbol.for("outright.viteRuntimeServers");
const configuredPlugins = globalThis[serverRegistry] ??= new Map();
// Ctrl-C (SIGINT) and SIGTERM are an explicit quit of the whole process.
// Vite closes its current server on SIGTERM but leaves Ctrl-C to Node, which
// exits without any shutdown. Either signal forwards the quit to every
// runtime in the process, including one still shutting down for a restart,
// and the process exits only after each has stopped: a quit wins over a
// restart until its shells are handed back. A second Ctrl-C exits at once.
// Config reloads load this module afresh, so the handlers and their state
// are process-wide.
const interrupt = globalThis[Symbol.for("outright.viteInterrupt")] ??= { installed: false, stopping: false, servers: new Set() };
interrupt.plugins ??= new Set();
interrupt.quit ??= () => {
  interrupt.stopping = true;
  return Promise.allSettled([...interrupt.plugins].map((plugin) => plugin.quit()));
};
interrupt.handler ??= () => {
  if (interrupt.interrupted) process.exit(130);
  interrupt.interrupted = true;
  void Promise.allSettled([interrupt.quit(), ...[...interrupt.servers].map((server) => server.close())])
    .finally(() => { process.exitCode ??= 130; process.exit(); });
};
// Vite's own SIGTERM handler closes the current server and exits once its
// closeBundle settles, which awaits every quitting runtime.
interrupt.terminate ??= () => { void interrupt.quit(); };
function watchInterrupt() {
  const wanted = interrupt.servers.size > 0;
  if (wanted === interrupt.installed) return;
  interrupt.installed = wanted;
  if (wanted) {
    process.on("SIGINT", interrupt.handler);
    process.prependListener("SIGTERM", interrupt.terminate);
  } else {
    process.off("SIGINT", interrupt.handler);
    process.off("SIGTERM", interrupt.terminate);
  }
}

export function outrightApiPlugin({ configUrl, createRuntime = createOutrightRuntime, recoverArchive = recoverArchiveBeforeStartup }) {
  let runtime = null;
  let recovery;
  let closing;
  let startupError;
  let stopping = false;
  let closeRequested = false;
  let runtimeStopping = false;
  const leaseKey = configUrl.href;
  const instance = { succeeded: false, inherited: false };
  // A restart is a successor's configure, never a close that Ctrl-C began.
  const restarting = () => instance.succeeded && !interrupt.stopping;
  let interruptServer = null;
  const abort = new AbortController();
  const wait = (promise) => new Promise((resolve, reject) => {
    if (stopping) return resolve();
    const onAbort = () => resolve();
    abort.signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => { abort.signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { abort.signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
  const retryLease = async (operation, retryCodes) => {
    const deadline = Date.now() + 15_000;
    while (!stopping) {
      try { return await operation(); } // NOSONAR S9382: lease acquisition retries until its deadline
      catch (error) {
        if (!retryCodes.includes(error.code)) throw error;
        const predecessor = shuttingDownRuntimes.get(leaseKey);
        if (predecessor && predecessor !== closing) {
          // A failed predecessor disposal is not evidence that this lease is
          // still held. Recheck the physical lease before classifying our own
          // startup; a failed shutdown may already have released it.
          await wait(predecessor.catch(() => {})); // NOSONAR S9382: waits for the predecessor before rechecking the lease
          continue;
        }
        if (Date.now() >= deadline) throw error;
        await wait(new Promise((resolve) => setTimeout(resolve, 100))); // NOSONAR S9382: backoff between lease retries
      }
    }
  };
  const shutdown = () => {
    if (!recovery) return undefined;
    // A quit must reach shells a predecessor handed to this server for a
    // restart, so a successor still starting finishes and then quits. Any
    // other close abandons startup. The first close decides.
    if (closeRequested ? stopping : !instance.inherited || restarting() || runtime) {
      stopping = true;
      abort.abort();
    }
    closeRequested = true;
    if (configuredPlugins.get(leaseKey) === instance) configuredPlugins.delete(leaseKey);
    interrupt.servers.delete(interruptServer);
    watchInterrupt();
    closing ??= recovery.then(async () => {
      // Asked when the runtime starts to stop, after any quit signal.
      runtimeStopping = true;
      try { await runtime?.shutdown({ restart: restarting() }); }
      catch (error) {
        if (error.code !== "OUTRIGHT_SHUTDOWN_RECOVERY_PENDING") throw error;
        await runtime.whenShutdownComplete();
      }
    });
    // Recovery itself can own the SQLite lease before a runtime exists.
    // Register its disposal too, so a successor does not apply the deadline
    // for an unknown external owner to a known local handoff.
    shuttingDownRuntimes.set(leaseKey, closing);
    const clear = () => {
      if (shuttingDownRuntimes.get(leaseKey) === closing) shuttingDownRuntimes.delete(leaseKey);
      interrupt.plugins.delete(quitter);
    };
    closing.then(clear, clear);
    return closing;
  };
  // An explicit quit for this plugin's runtime, whether or not it is already
  // shutting down for a restart.
  const quitter = { quit() {
    const done = shutdown() ?? Promise.resolve();
    if (runtimeStopping) runtime?.shutdown({ restart: false }).catch(() => {});
    return done;
  } };

  return {
    name: "outright-local-runtime",
    configureServer(server) {
      const predecessor = configuredPlugins.get(leaseKey);
      if (predecessor && predecessor !== instance) {
        predecessor.succeeded = true;
        instance.inherited = true;
      }
      configuredPlugins.set(leaseKey, instance);
      interrupt.plugins.add(quitter);
      // A middleware-mode server belongs to a host that owns its signals.
      if (server.httpServer && !server.config?.server?.middlewareMode && typeof server.close === "function") {
        interruptServer = server;
        interrupt.servers.add(server);
        watchInterrupt();
      }
      server.middlewares.use((request, response, next) => {
        if (!request.url.startsWith("/api/")) return next();
        if (runtime) {
          runtime.handleRequest(request, response).then((handled) => { if (!handled && !response.writableEnded) next(); }).catch(next);
          return;
        }
        writeStartupUnavailable(response, startupError);
      });
      server.httpServer?.on("upgrade", (request, socket) => {
        // Vite owns its HMR upgrades on this shared server. Only the runtime
        // events endpoint belongs to us while archive recovery is pending.
        if (!runtime && request.url?.split("?", 1)[0] === "/api/events") {
          socket.write(startupError
            ? "HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n"
            : "HTTP/1.1 503 Service Unavailable\r\nRetry-After: 1\r\nConnection: close\r\n\r\n");
          socket.destroy();
        }
      });
      // Vite can rebuild its config in the same process. closeBundle is not
      // guaranteed on that path, so release the old lease with its server.
      server.httpServer?.once("close", () => { void shutdown()?.catch((error) => console.error("Runtime shutdown failed", error)); });
      recovery = Promise.resolve().then(() => retryLease(recoverArchive, ["SQLITE_BUSY"])).then(async () => {
        if (stopping) return;
        // The replacement server may configure before the prior server's
        // asynchronous shutdown releases SQLite. Both recovery and runtime
        // construction share that temporary lease overlap.
        // The runtime asks whether a successor has configured when it decides
        // to keep its terminals, whichever close event starts its shutdown.
        runtime = await retryLease(() => createRuntime({ configUrl, hostRestarting: restarting }),
          ["OUTRIGHT_RUNTIME_LEASE_HELD"]);
        if (stopping || closeRequested) return;
        runtime.attach({ ...server, middlewares: { use() {} } });
      }).catch(async (error) => {
        try { await runtime?.shutdown(); }
        catch (shutdownError) { console.error("Runtime initialization cleanup failed", shutdownError); }
        runtime = null;
        startupError = error;
        console.error("Runtime recovery failed; database requires inspection", error);
      });
    },
    // Vite awaits plugin disposal before its signal handler exits the process.
    closeBundle() {
      const done = shutdown();
      return interrupt.stopping ? interrupt.quit().then(() => done) : done;
    },
  };
}
