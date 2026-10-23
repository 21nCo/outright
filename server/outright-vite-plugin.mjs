import { createOutrightRuntime } from "./outright-runtime.mjs";
import { recoverArchiveBeforeStartup, runtimeLaunchDirectory } from "./database.mjs";
import { withdrawReattachRecords } from "./managed-terminal.mjs";
import { writeStartupUnavailable } from "./startup-response.mjs";

// Config reloads can create the successor plugin before Vite closes the old
// server. A local shutdown is a known, finite lease owner, unlike an unrelated
// process holding the same database.
const shutdownRegistry = Symbol.for("outright.viteRuntimeShutdowns");
const shuttingDownRuntimes = globalThis[shutdownRegistry] ??= new Map();
// Vite's restart configures the replacement server before it closes the old
// one, so a plugin whose successor has finished configuring is closing for a
// restart.
// Its runtime then keeps live terminals for the successor to reattach; a
// close with no successor is a quit and ends them.
const serverRegistry = Symbol.for("outright.viteRuntimeServers");
const configuredPlugins = globalThis[serverRegistry] ??= new Map();
// Ctrl-C (SIGINT) and SIGTERM are an explicit quit of the whole process.
// Vite closes its current server on SIGTERM but leaves Ctrl-C to Node, which
// exits without any shutdown. Either signal forwards the quit to every
// runtime in the process, including one still shutting down for a restart,
// and the process exits only after each has stopped: a quit wins over a
// restart until its shells are handed back. One Ctrl-C can arrive twice at
// once (the terminal's process group and `npm run`'s forwarding), so only a
// later Ctrl-C forces the exit; the quit already withdrew every reattach
// record, so the shells it leaves are never reattached. Config reloads load
// this module afresh, so the handlers and their state are process-wide.
const REPEATED_SIGNAL_MS = 1000;
const interrupt = globalThis[Symbol.for("outright.viteInterrupt")] ??= { installed: false, stopping: false, servers: new Set() };
interrupt.plugins ??= new Set();
interrupt.quit ??= () => {
  interrupt.stopping = true;
  return Promise.allSettled([...interrupt.plugins].map((plugin) => plugin.quit()));
};
interrupt.handler ??= () => {
  if (interrupt.interrupted) {
    if (Date.now() - interrupt.interrupted >= REPEATED_SIGNAL_MS) process.exit(130);
    return;
  }
  interrupt.interrupted = Date.now();
  void Promise.allSettled([interrupt.quit(), ...[...interrupt.servers].map((server) => server.close())])
    .finally(() => { process.exitCode ??= 130; process.exit(); });
};
// Vite's own SIGTERM handler closes the current server and exits once its
// closeBundle settles, which awaits every quitting runtime.
interrupt.terminate ??= () => { void interrupt.quit(); };
function watchInterrupt() {
  // A quitting process keeps its handlers while its servers close, so a
  // repeated signal never takes Node's default exit.
  const wanted = interrupt.servers.size > 0 || interrupt.stopping;
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

export function outrightApiPlugin({ configUrl, createRuntime = createOutrightRuntime, recoverArchive = recoverArchiveBeforeStartup,
  launchDirectory = runtimeLaunchDirectory }) {
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
  // An explicit quit's first step withdraws every reattach record,
  // synchronously, even before a runtime exists.
  const withdraw = () => {
    if (runtime) runtime.withdrawReattach?.();
    else withdrawReattachRecords(launchDirectory());
  };
  const shutdown = () => {
    if (!recovery) return undefined;
    // Every close but a successor's restart is a quit: Ctrl-C, SIGTERM, the
    // q shortcut or a host closing the server, before or after the runtime
    // exists, and after a failed recovery.
    if (!restarting()) withdraw();
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
    withdraw();
    const done = shutdown() ?? Promise.resolve();
    if (runtimeStopping) runtime?.shutdown({ restart: false }).catch(() => {});
    return done;
  } };

  return {
    name: "outright-local-runtime",
    configureServer(server) {
      // Registered now, so it precedes Vite's SPA fallback.
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
      // A config reload that fails keeps the old server running, so this
      // server never takes over: it must not mark the old one as restarting,
      // register, or start a runtime that would take the lease and the shells
      // handed back. Vite runs this post hook only after every configureServer
      // hook and its own middleware setup succeeded, but later plugins' post
      // hooks still follow it. Only once they all returned does Vite append
      // its error middleware and finish creating the server, synchronously, so
      // a microtask sees whether it did before a restart closes the old server.
      // In middleware mode Vite still runs buildStart afterwards; a failure
      // there is not seen.
      return () => queueMicrotask(() => {
        if (server.middlewares.stack?.at(-1)?.handle?.name !== "viteErrorMiddleware") return;
        // A quit already under way ends the shells; this server never starts.
        if (interrupt.stopping) return;
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
      });
    },
    // Vite awaits plugin disposal before its signal handler exits the process.
    closeBundle() {
      const done = shutdown();
      return interrupt.stopping ? interrupt.quit().then(() => done) : done;
    },
  };
}
