import Database from "better-sqlite3";
import { closeSync, openSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { archiveShadowPaths, cutoverArchiveShadow } from "./archive-shadow.mjs";

const { filename, conversationId, table, rowId, lockGate } = workerData;
const ownership = {
  run_events: `SELECT 1 FROM run_events AS item JOIN runs ON runs.id = item.run_id
    WHERE item.id = ? AND runs.conversation_id = ?`,
  messages: "SELECT 1 FROM messages WHERE id = ? AND conversation_id = ?",
  runs: "SELECT 1 FROM runs WHERE id = ? AND conversation_id = ?",
};

let source;
let shadow;
try {
  if (!Object.hasOwn(ownership, table)) throw new Error("Invalid archive deletion source");
  // Opening the source first lets the primary close without making its WAL
  // connection the last one. The parent fences runtime operations before it
  // sends `proceed`; the worker then owns all large copy/delete work.
  source = new Database(filename);
  source.pragma("busy_timeout = 250");
  parentPort.postMessage({ ready: true });
  await new Promise((resolve, reject) => {
    parentPort.once("message", (message) => message === "proceed" ? resolve() : reject(new Error("Invalid archive maintenance command")));
  });
  const { next } = archiveShadowPaths(filename);
  const checkpoint = source.pragma("wal_checkpoint(TRUNCATE)")[0];
  if (checkpoint?.busy) throw new Error("Archive source WAL is busy");
  source.pragma("locking_mode = EXCLUSIVE");
  source.exec("BEGIN EXCLUSIVE; COMMIT");
  // Reserve the fixed sibling name without following a symlink created by a
  // local process between the parent preflight and VACUUM INTO.
  closeSync(openSync(next, "wx", 0o600));
  source.prepare("VACUUM INTO ?").run(next);
  shadow = new Database(next);
  shadow.pragma("foreign_keys = ON");
  shadow.pragma("secure_delete = FAST");
  const beforeUsage = source.prepare("SELECT bytes, measured FROM retained_usage WHERE id = 1").get();
  const copiedUsage = shadow.prepare("SELECT bytes, measured FROM retained_usage WHERE id = 1").get();
  if (beforeUsage.bytes !== copiedUsage.bytes || beforeUsage.measured !== copiedUsage.measured) {
    throw new Error("Archive shadow did not preserve retained usage");
  }
  const archive = shadow.prepare("SELECT archived, deleting FROM conversations WHERE id = ?").get(conversationId);
  if (!archive?.archived || !archive.deleting) throw new Error("Archive deletion marker is missing");
  if (shadow.prepare(`SELECT 1 FROM runs WHERE conversation_id = ? AND (status IN ('queued', 'launching', 'running')
    OR (status = 'interrupted' AND recovery_decision IS NULL)) LIMIT 1`).get(conversationId)) {
    throw new Error("Archive has active or recoverable work");
  }
  if (!shadow.prepare(ownership[table]).get(rowId, conversationId)) throw new Error("Archive row ownership changed");
  if (lockGate instanceof SharedArrayBuffer) {
    const signal = new Int32Array(lockGate);
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0);
    if (Atomics.wait(signal, 0, 1, 5000) === "timed-out") throw new Error("Archive lock probe timed out");
  }
  // Finish this archive inside one shadow copy. Every child row has its own
  // transaction, so a second giant row cannot force another full copy of
  // all unrelated retained history. None of these transactions owns the live
  // database writer; the original remains available for crash rollback.
  for (const [selectSql, sourceTable] of [
    ["SELECT events.id FROM run_events AS events JOIN runs ON runs.id = events.run_id WHERE runs.conversation_id = ? LIMIT 1", "run_events"],
    ["SELECT id FROM messages WHERE conversation_id = ? LIMIT 1", "messages"],
    ["SELECT id FROM runs WHERE conversation_id = ? LIMIT 1", "runs"],
  ]) {
    const select = shadow.prepare(selectSql);
    const remove = shadow.prepare(`DELETE FROM ${sourceTable} WHERE id = ?`);
    while (true) {
      const row = select.get(conversationId);
      if (!row) break;
      if (shadow.transaction(() => remove.run(row.id)).immediate().changes !== 1) {
        throw new Error("Archive child row could not be deleted");
      }
    }
  }
  shadow.transaction(() => {
    if (!shadow.prepare("DELETE FROM conversations WHERE id = ? AND deleting = 1").run(conversationId).changes) {
      throw new Error("Archive marker disappeared during shadow cleanup");
    }
    shadow.prepare("UPDATE retained_usage SET legacy_ceiling = MAX(legacy_ceiling, bytes + 1048576) WHERE id = 1").run();
    shadow.prepare("INSERT INTO audit_log (action, target, details, created_at) VALUES (?, ?, ?, ?)")
      .run("retention.archived.deleted", conversationId, "{}", new Date().toISOString());
    shadow.prepare(`DELETE FROM audit_log WHERE id <= (SELECT id FROM audit_log ORDER BY id DESC LIMIT 1 OFFSET 9999)
      AND target NOT IN (SELECT id FROM runs WHERE status IN ('queued', 'launching', 'running')
        OR (status = 'interrupted' AND recovery_decision IS NULL))`).run();
  }).immediate();
  if (beforeUsage.measured && shadow.prepare("SELECT bytes FROM retained_usage WHERE id = 1").get().bytes >= beforeUsage.bytes) {
    throw new Error("Archive shadow did not debit the reclaimed row");
  }
  // The source remains fenced while the shadow reclaims its freed overflow
  // pages. This work may grow with old data, but owns no live writer.
  shadow.exec("VACUUM");
  if (shadow.pragma("integrity_check")[0]?.integrity_check !== "ok" || shadow.pragma("foreign_key_check").length) {
    throw new Error("Archive shadow failed integrity validation");
  }
  shadow.close();
  shadow = undefined;
  source.close();
  source = undefined;
  cutoverArchiveShadow(filename);
  parentPort.postMessage({ ok: true });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error.message });
} finally {
  shadow?.close();
  source?.close();
}
