import connect from "connect";
import { createServer } from "node:http";
import path from "node:path";
import sirv from "sirv";
import { createOutrightRuntime } from "./outright-runtime.mjs";

const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";
const app = connect();
const httpServer = createServer(app);
const runtime = createOutrightRuntime({ configUrl: new URL("../outright.config.json", import.meta.url) });

runtime.attach({ middlewares: app, httpServer });
app.use(sirv(path.resolve(import.meta.dirname, "../dist/client"), {
  dev: false,
  etag: true,
  single: true,
}));

httpServer.listen(port, host, () => {
  console.info(`Outright is running at http://${host}:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    try {
      await runtime.shutdown();
      httpServer.close(() => process.exit(0));
      httpServer.closeIdleConnections?.();
    } catch (error) {
      console.error("Runtime shutdown failed; process ownership is retained", error);
      process.exitCode = 1;
    }
  });
}
