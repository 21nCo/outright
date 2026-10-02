import { createOutrightRuntime } from "./outright-runtime.mjs";
import { recoverArchiveBeforeStartup } from "./database.mjs";

export function outrightApiPlugin({ configUrl, createRuntime = createOutrightRuntime, recoverArchive = recoverArchiveBeforeStartup }) {
  let runtime = null;
  let recovery;
  let startupError;
  let stopping = false;

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
      server.httpServer?.on("upgrade", (_request, socket) => {
        if (!runtime) { socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n"); socket.destroy(); }
      });
      recovery = Promise.resolve().then(() => recoverArchive()).then(() => {
        if (stopping) return;
        runtime = createRuntime({ configUrl });
        runtime.attach({ ...server, middlewares: { use() {} } });
      }).catch((error) => {
        startupError = error;
        console.error("Runtime recovery failed; database requires inspection", error);
      });
    },
    // Vite awaits plugin disposal before its signal handler exits the process.
    closeBundle() {
      if (!recovery) return;
      stopping = true;
      return recovery.then(() => runtime?.shutdown());
    },
  };
}
