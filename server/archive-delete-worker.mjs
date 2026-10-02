import Database from "better-sqlite3";
import { closeSync, openSync, statSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { archiveShadowPaths, cutoverArchiveShadow, prepareArchiveShadowCutover } from "./archive-shadow.mjs";

const { filename, conversationId, table, rowId, lockGate, copyGate, copyStepGate, copyPhase } = workerData;
const ownership = {
  run_events: `SELECT 1 FROM run_events AS item JOIN runs ON runs.id = item.run_id
    WHERE item.id = ? AND runs.conversation_id = ?`,
  messages: "SELECT 1 FROM messages WHERE id = ? AND conversation_id = ?",
  runs: "SELECT 1 FROM runs WHERE id = ? AND conversation_id = ?",
};
// The online backup holds a source read lock for one small step at a time.
// VACUUM INTO held one snapshot for the entire copy, pinning the live WAL
// while unrelated writers could append without a physical size bound.
const COPY_STEP_PAGES = 64;
const COPY_WAL_LIMIT_BYTES = 32 * 1024 * 1024;
const COPY_RESTART_LIMIT = 2;
const COPY_TOTAL_WORK_FACTOR = 3;

let source;
let shadow;
try {
  if (!Object.hasOwn(ownership, table)) throw new Error("Invalid archive deletion source");
  // Keep the primary available throughout the size-dependent copy, deletion
  // and vacuum. The parent verifies that no source row changed before the
  // short final fence and cutover; a changed snapshot is discarded on retry.
  source = new Database(filename);
  source.pragma("busy_timeout = 250");
  let checkpoint;
  try { checkpoint = source.pragma("wal_checkpoint(TRUNCATE)")[0]; }
  catch (error) {
    if (!["SQLITE_BUSY", "SQLITE_LOCKED"].includes(error.code)) throw error;
    throw Object.assign(new Error("Archive source WAL is busy"), { code: "ARCHIVE_SOURCE_BUSY" });
  }
  if (checkpoint?.busy) throw Object.assign(new Error("Archive source WAL is busy"), { code: "ARCHIVE_SOURCE_BUSY" });
  parentPort.postMessage({ ready: "copy" });
  await new Promise((resolve, reject) => {
    parentPort.once("message", (message) => message === "proceed" ? resolve() : reject(new Error("Invalid archive maintenance command")));
  });
  const { next } = archiveShadowPaths(filename);
  // Reserve the fixed sibling name without following a symlink created by a
  // local process between the parent preflight and VACUUM INTO.
  closeSync(openSync(next, "wx", 0o600));
  if (copyPhase instanceof SharedArrayBuffer) {
    Atomics.store(new Int32Array(copyPhase), 0, 1);
    Atomics.notify(new Int32Array(copyPhase), 0);
  }
  let previousRemaining = Infinity;
  let restarts = 0;
  let copiedPages = 0;
  let initialPages;
  let probedStep = false;
  await source.backup(next, { progress({ totalPages, remainingPages }) {
    if (!probedStep && copyStepGate instanceof SharedArrayBuffer) {
      probedStep = true;
      const signal = new Int32Array(copyStepGate);
      if (Atomics.compareExchange(signal, 0, 0, 1) === 0) {
        Atomics.notify(signal, 0);
        if (Atomics.wait(signal, 0, 1, 10_000) === "timed-out") throw new Error("Archive copy step probe timed out");
      }
    }
    // A different connection's write restarts SQLite's online backup. Stop
    // repeated copies under sustained writes; the durable marker retries
    // after the source is quiet, without consuming another full shadow copy.
    if (remainingPages > previousRemaining && ++restarts > COPY_RESTART_LIMIT) {
      throw Object.assign(new Error("Archive source changed repeatedly during copy"), { code: "ARCHIVE_SOURCE_BUSY" });
    }
    initialPages ??= totalPages;
    copiedPages += COPY_STEP_PAGES;
    if (copiedPages > Math.max(initialPages, totalPages) * COPY_TOTAL_WORK_FACTOR + 1024) {
      throw Object.assign(new Error("Archive copy exceeded its bounded work budget"), { code: "ARCHIVE_SOURCE_BUSY" });
    }
    previousRemaining = remainingPages;
    let walBytes;
    try { walBytes = statSync(`${filename}-wal`, { throwIfNoEntry: false })?.size ?? 0; }
    catch (error) {
      if (!["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
      throw Object.assign(new Error("Archive source WAL usage is temporarily unknown"), { code: "ARCHIVE_SOURCE_BUSY" });
    }
    if (walBytes > COPY_WAL_LIMIT_BYTES) {
      throw Object.assign(new Error("Archive source WAL exceeded the copy budget"), { code: "ARCHIVE_SOURCE_BUSY" });
    }
    return COPY_STEP_PAGES;
  } });
  if (copyPhase instanceof SharedArrayBuffer) {
    Atomics.store(new Int32Array(copyPhase), 0, 2);
    Atomics.notify(new Int32Array(copyPhase), 0);
  }
  if (copyGate instanceof SharedArrayBuffer) {
    const signal = new Int32Array(copyGate);
    if (Atomics.compareExchange(signal, 0, 0, 1) === 0) {
      Atomics.notify(signal, 0);
      if (Atomics.wait(signal, 0, 1, 5000) === "timed-out") throw new Error("Archive copy probe timed out");
    }
  }
  shadow = new Database(next);
  shadow.pragma("foreign_keys = ON");
  shadow.pragma("secure_delete = FAST");
  // Source writes remain allowed during the copy, so compare reclamation to
  // the copied snapshot. The parent rejects this candidate if source changed.
  const beforeUsage = shadow.prepare("SELECT bytes, measured FROM retained_usage WHERE id = 1").get();
  const archive = shadow.prepare("SELECT archived, deleting FROM conversations WHERE id = ?").get(conversationId);
  if (!archive?.archived || !archive.deleting) throw new Error("Archive deletion marker is missing");
  if (shadow.prepare(`SELECT 1 FROM runs WHERE conversation_id = ? AND (status IN ('queued', 'launching', 'running')
    OR (status = 'interrupted' AND recovery_decision IS NULL)) LIMIT 1`).get(conversationId)) {
    throw new Error("Archive has active or recoverable work");
  }
  if (!shadow.prepare(ownership[table]).get(rowId, conversationId)) throw new Error("Archive row ownership changed");
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
  // The primary remains available while the shadow reclaims overflow pages.
  shadow.exec("VACUUM");
  if (shadow.pragma("foreign_key_check").length) {
    throw new Error("Archive shadow failed foreign-key validation");
  }
  shadow.close();
  shadow = undefined;
  // Preparation validates the closed candidate and records its digest. A
  // second full integrity scan here would read the whole archive twice.
  prepareArchiveShadowCutover(filename);
  parentPort.postMessage({ ready: "cutover" });
  await new Promise((resolve, reject) => {
    parentPort.once("message", (message) => message === "proceed" ? resolve() : reject(new Error("Invalid archive cutover command")));
  });
  if (lockGate instanceof SharedArrayBuffer) {
    const signal = new Int32Array(lockGate);
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0);
    if (Atomics.wait(signal, 0, 1, 5000) === "timed-out") throw new Error("Archive lock probe timed out");
  }
  let finalCheckpoint;
  try { finalCheckpoint = source.pragma("wal_checkpoint(TRUNCATE)")[0]; }
  catch (error) {
    if (!["SQLITE_BUSY", "SQLITE_LOCKED"].includes(error.code)) throw error;
    throw Object.assign(new Error("Archive source WAL is busy at cutover"), { code: "ARCHIVE_SOURCE_BUSY" });
  }
  if (finalCheckpoint?.busy) throw Object.assign(new Error("Archive source WAL is busy at cutover"), { code: "ARCHIVE_SOURCE_BUSY" });
  source.close();
  source = undefined;
  cutoverArchiveShadow(filename);
  parentPort.postMessage({ ok: true });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error.message, code: error.code });
} finally {
  shadow?.close();
  source?.close();
}
