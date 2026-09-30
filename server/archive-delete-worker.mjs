import Database from "better-sqlite3";
import { parentPort, workerData } from "node:worker_threads";

const { filename, conversationId, table, rowId, lockGate } = workerData;
const ownership = {
  run_events: `SELECT 1 FROM run_events AS item JOIN runs ON runs.id = item.run_id
    WHERE item.id = ? AND runs.conversation_id = ?`,
  messages: "SELECT 1 FROM messages WHERE id = ? AND conversation_id = ?",
  runs: "SELECT 1 FROM runs WHERE id = ? AND conversation_id = ?",
};

let db;
try {
  if (!Object.hasOwn(ownership, table)) throw new Error("Invalid archive deletion source");
  db = new Database(filename);
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  // FAST unlinks overflow pages without overwriting every byte under the
  // writer lock. SQLite/WAL retains physical pages until ordinary checkpoint
  // maintenance; the archive stays inaccessible from the durable marker on.
  db.pragma("secure_delete = FAST");
  db.transaction(() => {
    const archive = db.prepare("SELECT archived, deleting FROM conversations WHERE id = ?").get(conversationId);
    if (!archive?.archived || !archive.deleting) throw new Error("Archive deletion marker is missing");
    if (db.prepare(`SELECT 1 FROM runs WHERE conversation_id = ? AND (status IN ('queued', 'launching', 'running')
      OR (status = 'interrupted' AND recovery_decision IS NULL)) LIMIT 1`).get(conversationId)) {
      throw new Error("Archive has active or recoverable work");
    }
    if (!db.prepare(ownership[table]).get(rowId, conversationId)) throw new Error("Archive row ownership changed");
    // A test-only gate makes the adverse SQLite lock ordering observable.
    if (lockGate instanceof SharedArrayBuffer) {
      const signal = new Int32Array(lockGate);
      Atomics.store(signal, 0, 1);
      Atomics.notify(signal, 0);
      if (Atomics.wait(signal, 0, 1, 5000) === "timed-out") throw new Error("Archive lock probe timed out");
    }
    if (!db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(rowId).changes) throw new Error("Archive row disappeared");
  }).immediate();
  parentPort.postMessage({ ok: true });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error.message });
} finally {
  db?.close();
}
