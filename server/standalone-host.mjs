import connect from "connect";
import { createServer } from "node:http";
import path from "node:path";
import sirv from "sirv";
import { recoverArchiveBeforeStartup, runtimeLaunchDirectory } from "./database.mjs";
import { withdrawReattachRecords } from "./managed-terminal.mjs";
import { createOutrightRuntime } from "./outright-runtime.mjs";
import { writeStartupUnavailable } from "./startup-response.mjs";

// One Ctrl-C can reach this process twice at once: the terminal signals its
// whole process group and `npm run` forwards the same signal. A repeat this
// soon after the first is the same quit; a later one forces the exit.
export const REPEATED_SIGNAL_MS = 1000;

export function startStandalone({ recoverArchive = recoverArchiveBeforeStartup, createRuntime = createOutrightRuntime } = {}) {
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
    console.info(`Outright is running at http://${host}:${httpServer.address()?.port ?? port}`);
  });

  const recovery = recoverArchive().catch((error) => {
    startupError = error;
    console.error("Runtime recovery failed; database requires inspection", error);
  }).then(async () => {
    if (stopping || startupError) return;
    try {
      runtime = createRuntime({ configUrl: new URL("../outright.config.json", import.meta.url) });
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

  // SIGINT and SIGTERM are an explicit quit, which ends every terminal. A
  // launcher that restarts Outright (an update or a settings change) sends
  // { type: "outright.shutdown", intent: "restart" } over its IPC channel
  // instead; live terminals then survive for the next runtime to reattach.
  // The runtime joins overlapping requests into its one shutdown.
  async function stop({ restart = false } = {}) {
    stopping = true;
    // A quit first withdraws every reattach record, before it waits for
    // anything, so a forced exit or a quit before the runtime exists leaves
    // no shell for a later start to reattach; that start ends them.
    if (!restart) {
      if (runtime) runtime.withdrawReattach();
      else withdrawReattachRecords(runtimeLaunchDirectory());
    }
    try {
      await recovery;
      try { await runtime?.shutdown({ restart }); }
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
  }
  let signalledAt = 0;
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
    if (signalledAt) {
      if (Date.now() - signalledAt >= REPEATED_SIGNAL_MS) process.exit(130);
      return;
    }
    signalledAt = Date.now();
    void stop();
  });
  process.on("message", (message) => {
    if (message?.type !== "outright.shutdown" || !["restart", "quit"].includes(message.intent)) return;
    void stop({ restart: message.intent === "restart" });
  });
}
