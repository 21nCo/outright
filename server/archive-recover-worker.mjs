import { parentPort, workerData } from "node:worker_threads";
import { recoverArchiveShadow } from "./archive-shadow.mjs";

try {
  recoverArchiveShadow(workerData.filename, { sourceUnmoved: workerData.sourceUnmoved });
  parentPort.postMessage({ ok: true });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error.message });
}
