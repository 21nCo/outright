import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";
import { recoverArchiveShadow } from "./archive-shadow.mjs";

let lease;
try {
  if (workerData.runtimeLease) {
    lease = new Database(`${workerData.filename}.runtime-lease`);
    lease.pragma("busy_timeout = 250");
    lease.pragma("locking_mode = EXCLUSIVE");
    lease.exec("BEGIN EXCLUSIVE; COMMIT;");
  }
  recoverArchiveShadow(workerData.filename, { sourceUnmoved: workerData.sourceUnmoved });
  parentPort.postMessage({ ok: true });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error.message, code: error.code });
} finally {
  lease?.close();
}
