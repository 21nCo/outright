import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// At most eight exited runs can await their SQLite transaction. A final
// assistant checkpoint is capped at 1 MiB, so these sidecars remain bounded
// even when storage is unavailable during shutdown.
const MAX_RECORD_BYTES = 2 * 1024 * 1024;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

function invalidRunOutcome(runId) {
  const error = new Error(`Invalid run outcome record: ${runId}`);
  error.code = "OUTRIGHT_INVALID_RUN_OUTCOME";
  return error;
}

function validTranscriptTimestamp(createdAt, finishedAt, checkCurrentClock = false) {
  if (typeof createdAt !== "string") return false;
  const created = Date.parse(createdAt);
  const finished = Date.parse(finishedAt);
  return Number.isFinite(created) && Number.isFinite(finished)
    && created <= finished + MAX_CLOCK_SKEW_MS
    && (!checkCurrentClock || created <= Date.now() + MAX_CLOCK_SKEW_MS);
}

function recordPath(directory, runId) {
  if (!RUN_ID.test(runId)) throw new Error("Invalid run outcome ID");
  return path.join(directory, `${runId}.outcome.json`);
}

function syncDirectory(directory) {
  if (process.platform === "win32") return;
  const fd = openSync(directory, "r");
  try { fsyncSync(fd); }
  finally { closeSync(fd); }
}

export function saveRunOutcome(directory, runId, outcome) {
  const destination = recordPath(directory, runId);
  if (outcome.transcriptMessage && !validTranscriptTimestamp(outcome.transcriptMessage.createdAt, outcome.finishedAt, true)) {
    throw new Error("Invalid run outcome transcript timestamp");
  }
  const base = { ...outcome, version: 2, runId,
    message: Buffer.from(String(outcome.message ?? "")).subarray(0, 4000).toString("utf8"),
    transcriptOmitted: Boolean(outcome.transcriptOmitted),
    transcriptMessage: outcome.transcriptMessage ?? null };
  let record = JSON.stringify(base);
  if (Buffer.byteLength(record) > MAX_RECORD_BYTES && base.transcriptMessage) {
    // An unusually escape-heavy final body cannot expand the journal past
    // its cap. Record the omission explicitly with the terminal result.
    base.transcriptMessage = null;
    base.transcriptOmitted = true;
    record = JSON.stringify(base);
  }
  if (Buffer.byteLength(record) > MAX_RECORD_BYTES) throw new Error("Run outcome exceeds its recovery budget");
  const temporary = `${destination}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, record);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, destination);
    syncDirectory(directory);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch { /* The rename may have succeeded. */ }
    throw error;
  }
}

export function readRunOutcome(directory, runId) {
  // Imported legacy rows may have arbitrary IDs. Only runs created with the
  // current UUID namespace can own a sidecar in the private launch directory.
  if (!RUN_ID.test(runId)) return null;
  const filename = recordPath(directory, runId);
  let stat;
  try { stat = lstatSync(filename); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) throw invalidRunOutcome(runId);
  let record;
  try { record = JSON.parse(readFileSync(filename, "utf8")); }
  catch { throw invalidRunOutcome(runId); }
  if (![1, 2].includes(record?.version) || record.runId !== runId
    || !["completed", "failed", "stopped"].includes(record.status)
    || typeof record.finishedAt !== "string" || !Number.isFinite(Date.parse(record.finishedAt))
    || typeof record.message !== "string" || Buffer.byteLength(record.message) > 4096
    || !(record.exitCode === null || Number.isSafeInteger(record.exitCode))
    || (record.status === "completed" && (record.exitCode !== 0 || record.message !== ""))
    || (record.version === 2 && (typeof record.transcriptOmitted !== "boolean"
      || (record.transcriptMessage !== null && (typeof record.transcriptMessage !== "object"
        || Array.isArray(record.transcriptMessage)
        || typeof record.transcriptMessage.id !== "string"
        || !record.transcriptMessage.id.startsWith(`${runId}:`)
        || record.transcriptMessage.payload?.runId !== runId
        || record.transcriptMessage.role !== "assistant"
        || record.transcriptMessage.kind !== "text"
        || typeof record.transcriptMessage.body !== "string"
        || typeof record.transcriptMessage.conversationId !== "string"
        || !validTranscriptTimestamp(record.transcriptMessage.createdAt, record.finishedAt)))))) {
    throw invalidRunOutcome(runId);
  }
  return record;
}

export function removeRunOutcome(directory, runId) {
  if (!RUN_ID.test(runId)) return;
  try { unlinkSync(recordPath(directory, runId)); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}
