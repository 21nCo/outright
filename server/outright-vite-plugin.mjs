import { createOutrightRuntime } from "./outright-runtime.mjs";
import { recoverArchiveBeforeStartup } from "./database.mjs";
import { writeStartupUnavailable } from "./startup-response.mjs";

// Config reloads can create the successor plugin before Vite closes the old
// server. A local shutdown is a known, finite lease owner, unlike an unrelated
// process holding the same database.
const shutdownRegistry = Symbol.for("outright.viteRuntimeShutdowns");
const shuttingDownRuntimes = globalThis[shutdownRegistry] ??= new Map();

export function outrightApiPlugin({ configUrl, createRuntime = createOutrightRuntime, recoverArchive = recoverArchiveBeforeStartup }) {
  let runtime = null;
  let recovery;
  let closing;
  let startupError;
  let stopping = false;
  const leaseKey = configUrl.href;
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
      try { return await operation(); }
      catch (error) {
        if (!retryCodes.includes(error.code)) throw error;
        const predecessor = shuttingDownRuntimes.get(leaseKey);
        if (predecessor && predecessor !== closing) {
          // A failed predecessor disposal is not evidence that this lease is
          // still held. Recheck the physical lease before classifying our own
          // startup; a failed shutdown may already have released it.
          await wait(predecessor.catch(() => {}));
          continue;
        }
        if (Date.now() >= deadline) throw error;
        await wait(new Promise((resolve) => setTimeout(resolve, 100)));
      }
    }
  };
  const shutdown = () => {
    if (!recovery) return undefined;
    stopping = true;
    abort.abort();
    closing ??= recovery.then(async () => {
      try { await runtime?.shutdown(); }
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
        runtime = await retryLease(() => createRuntime({ configUrl }), ["OUTRIGHT_RUNTIME_LEASE_HELD"]);
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
