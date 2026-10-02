import { createOutrightRuntime } from "./outright-runtime.mjs";
import { recoverArchiveBeforeStartup } from "./database.mjs";

export function outrightApiPlugin({ configUrl, createRuntime = createOutrightRuntime, recoverArchive = recoverArchiveBeforeStartup }) {
  let runtime = null;
  let recovery;
  let closing;
  let startupError;
  let stopping = false;
  const retryLease = async (operation, retryCodes) => {
    const deadline = Date.now() + 15_000;
    while (!stopping) {
      try { return await operation(); }
      catch (error) {
        if (!retryCodes.includes(error.code) || Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  };
  const shutdown = () => {
    if (!recovery) return undefined;
    stopping = true;
    closing ??= recovery.then(() => runtime?.shutdown());
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
        response.writeHead(startupError ? 500 : 503, { "content-type": "application/json", ...(!startupError ? { "retry-after": "1" } : {}) });
        response.end(JSON.stringify({ error: startupError ? "Runtime recovery failed; database requires inspection" : "Runtime recovery is in progress" }));
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
