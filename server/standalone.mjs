import connect from "connect";
import { createServer } from "node:http";
import path from "node:path";
import sirv from "sirv";
import { recoverArchiveBeforeStartup } from "./database.mjs";
import { createOutrightRuntime } from "./outright-runtime.mjs";
import { writeStartupUnavailable } from "./startup-response.mjs";

const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";
const app = connect();
const httpServer = createServer(app);
let runtime;
let startupError;
let stopping = false;

app.use((request, response, next) => {
  if (!request.url.startsWith("/api/")) return next();
  if (runtime) {
    runtime.handleRequest(request, response).then((handled) => { if (!handled && !response.writableEnded) next(); }).catch(next);
    return;
  }
  writeStartupUnavailable(response, startupError);
});
httpServer.on("upgrade", (_request, socket) => {
  if (!runtime) {
    socket.write(startupError
      ? "HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n"
      : "HTTP/1.1 503 Service Unavailable\r\nRetry-After: 1\r\nConnection: close\r\n\r\n");
    socket.destroy();
  }
});

app.use(sirv(process.env.OUTRIGHT_CLIENT_DIR || path.resolve(import.meta.dirname, "../dist/client"), {
  dev: false,
  etag: true,
  single: true,
}));

httpServer.listen(port, host, () => {
  console.info(`Outright is running at http://${host}:${port}`);
});

const recovery = recoverArchiveBeforeStartup().catch((error) => {
  startupError = error;
  console.error("Runtime recovery failed; database requires inspection", error);
}).then(async () => {
  if (stopping || startupError) return;
  try {
    runtime = createOutrightRuntime({ configUrl: new URL("../outright.config.json", import.meta.url) });
    runtime.attach({ middlewares: { use() {} }, httpServer });
  } catch (error) {
    console.error("Runtime initialization failed", error);
    stopping = true;
    process.exitCode = 1;
    try { await runtime?.shutdown(); }
    catch (shutdownError) { console.error("Runtime initialization cleanup failed", shutdownError); }
    httpServer.close();
    httpServer.closeIdleConnections?.();
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    stopping = true;
    try {
      await recovery;
      try { await runtime?.shutdown(); }
      catch (error) {
        if (error.code !== "OUTRIGHT_SHUTDOWN_RECOVERY_PENDING") throw error;
        await runtime.whenShutdownComplete();
      }
      httpServer.close(() => process.exit(0));
      httpServer.closeIdleConnections?.();
    } catch (error) {
      console.error("Runtime shutdown failed", error);
      process.exitCode = 1;
      // The runtime has released its database lease, but terminal disposal
      // failed. End the HTTP host with a failing status instead of waiting
      // forever on a server that can no longer serve work.
      if (error.code === "OUTRIGHT_SHUTDOWN_DISPOSAL_FAILED") {
        httpServer.close(() => process.exit(1));
        httpServer.closeIdleConnections?.();
      }
    }
  });
}
