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
// Vite closes its server on SIGTERM but leaves Ctrl-C (SIGINT) to Node,
// which exits without any shutdown, so shells would outlive the quit as
// after a crash. Ctrl-C is an explicit quit: it closes every configured
// server, which has no successor, then exits. A second Ctrl-C exits at once.
// Config reloads load this module afresh, so the handler and its state are
// process-wide.
const interrupt = globalThis[Symbol.for("outright.viteInterrupt")] ??= { installed: false, stopping: false, servers: new Set() };
interrupt.handler ??= () => {
  if (interrupt.stopping) process.exit(130);
  interrupt.stopping = true;
  void Promise.allSettled([...interrupt.servers].map((server) => server.close()))
    .finally(() => { process.exitCode ??= 130; process.exit(); });
};
function watchInterrupt() {
  const wanted = interrupt.servers.size > 0;
  if (wanted === interrupt.installed) return;
  interrupt.installed = wanted;
  if (wanted) process.on("SIGINT", interrupt.handler);
  else process.off("SIGINT", interrupt.handler);
}

export function outrightApiPlugin({ configUrl, createRuntime = createOutrightRuntime, recoverArchive = recoverArchiveBeforeStartup }) {
  let runtime = null;
  let recovery;
  let closing;
  let startupError;
  let stopping = false;
  const leaseKey = configUrl.href;
  const instance = { succeeded: false };
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
    stopping = true;
    abort.abort();
    if (configuredPlugins.get(leaseKey) === instance) configuredPlugins.delete(leaseKey);
    interrupt.servers.delete(interruptServer);
    watchInterrupt();
    const restart = restarting();
    closing ??= recovery.then(async () => {
      try { await runtime?.shutdown({ restart }); }
      catch (error) {
        if (error.code !== "OUTRIGHT_SHUTDOWN_RECOVERY_PENDING") throw error;
        await runtime.whenShutdownComplete();
      }
    });
    // Recovery itself can own the SQLite lease before a runtime exists.
    // Register its disposal too, so a successor does not apply the deadline
    // for an unknown external owner to a known local handoff.
    shuttingDownRuntimes.set(leaseKey, closing);
    const clear = () => { if (shuttingDownRuntimes.get(leaseKey) === closing) shuttingDownRuntimes.delete(leaseKey); };
    closing.then(clear, clear);
    return closing;
  };

  return {
    name: "outright-local-runtime",
    configureServer(server) {
      const predecessor = configuredPlugins.get(leaseKey);
      if (predecessor && predecessor !== instance) predecessor.succeeded = true;
      configuredPlugins.set(leaseKey, instance);
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
        if (stopping) return;
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
      return shutdown();
    },
  };
}
