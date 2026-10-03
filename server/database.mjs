import Database from "better-sqlite3";
import { chmodSync, existsSync, lstatSync, mkdirSync, opendirSync, readFileSync, realpathSync, rmSync, statfsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { foldFindText } from "../src/lib/find-text.js";
import { RESOURCE_BUDGETS, RETAINED_MESSAGE_FIELDS, RETAINED_ROW_OVERHEAD_BYTES } from "./resource-budgets.mjs";
import { allocatedDatabaseUsage, archiveShadowPaths, beginArchiveShadow, recoverArchiveShadow } from "./archive-shadow.mjs";

const DEFAULT_SETTINGS = {
  provider: "codex",
  model: "",
  reasoningEffort: "medium",
  approvalPolicy: "workspace-write",
  editor: "zed",
  maxConcurrentRuns: RESOURCE_BUDGETS.maxConcurrentRuns,
  maxQueuedRuns: RESOURCE_BUDGETS.maxQueuedRuns,
  maxRetainedMiB: RESOURCE_BUDGETS.maxRetainedMiB,
  retentionDays: RESOURCE_BUDGETS.retentionDays,
  notifications: true,
  theme: "system",
};

const MAX_RUN_EVENT_PAYLOAD_BYTES = 256 * 1024;
const MAX_RUN_EVENT_RETAINED_BYTES = RESOURCE_BUDGETS.maxRunEventBytes;
const MAX_MESSAGE_PAGE_BYTES = 8 * 1024 * 1024;
const MAX_INLINE_MESSAGE_BYTES = 64 * 1024;
const FIND_SCAN_BYTES = 8 * 1024 * 1024;
// Keep one synchronous fold small enough for responsive event delivery even
// after earlier searches have increased heap pressure in a long session.
const FIND_CHUNK_BYTES = 16 * 1024;
const SEARCH_CANDIDATES = 256;
const SEARCH_MESSAGE_BYTES = 16 * 1024;
const SEARCH_QUERY_BYTES = 256;
const SEARCH_RESPONSE_BYTES = 128 * 1024;
const RETAINED_COLUMNS = [
  ["settings", "key, value"],
  ["project_groups", "id, name, created_at"],
  ["project_memberships", "project_id, group_id"],
  ["conversations", "id, project_id, worktree_id, worktree_path, title, provider, model, provider_session_id, created_at, updated_at"],
  ["messages", RETAINED_MESSAGE_FIELDS.join(", ")],
  ["runs", "id, conversation_id, worktree_path, provider, model, reasoning_effort, approval_policy, prompt, status, pid, provider_session_id, created_at, started_at, finished_at, exit_code, error, cost_usd, input_tokens, output_tokens, recovery_class, recovery_decision, transcript_omitted"],
  ["run_events", "run_id, type, payload, created_at"],
  ["run_event_usage", "run_id"],
  ["trusted_projects", "project_id, project_path, trusted_at"],
  ["audit_log", "action, target, details, created_at"],
  ["prompt_templates", "id, title, prompt, created_at"],
];
const RUN_RETAINED_FIELDS = RETAINED_COLUMNS.find(([name]) => name === "runs")[1];

const SETTING_RULES = {
  provider: (value) => typeof value === "string" && ["codex", "claude"].includes(value),
  model: (value) => typeof value === "string" && value.length <= 200,
  reasoningEffort: (value) => ["low", "medium", "high", "xhigh"].includes(value),
  approvalPolicy: (value) => ["read-only", "workspace-write", "danger-full-access"].includes(value),
  editor: (value) => ["zed", "code", "cursor", "finder"].includes(value),
  maxConcurrentRuns: (value) => Number.isInteger(value) && value >= 1 && value <= 8,
  maxQueuedRuns: (value) => Number.isInteger(value) && value >= 1 && value <= 256,
  maxRetainedMiB: (value) => Number.isInteger(value) && value >= 64 && value <= 4096,
  retentionDays: (value) => Number.isInteger(value) && value >= 1 && value <= 3650,
  notifications: (value) => typeof value === "boolean",
  theme: (value) => ["system", "light", "dark"].includes(value),
};

// An interrupted cutover may need to authenticate a multi-gigabyte file.
// Do that on a worker while holding the runtime lease before opening SQLite.
export async function recoverArchiveBeforeStartup(options = {}) {
  const dataDirectory = path.resolve(options.dataDirectory
    ?? process.env.OUTRIGHT_DATA_DIR
    ?? path.join(os.homedir(), ".outright"));
  const requestedFilename = options.filename ?? path.join(dataDirectory, "outright.db");
  if (requestedFilename === ":memory:") return;
  mkdirSync(path.dirname(path.resolve(requestedFilename)), { recursive: true, mode: 0o700 });
  const filename = path.join(realpathSync(path.dirname(path.resolve(requestedFilename))), path.basename(requestedFilename));
  if (existsSync(archiveShadowPaths(filename).state)) await recoverArchiveOnWorker(filename, false, true);
}

export function createOutrightDatabase(options = {}) {
  const dataDirectory = path.resolve(options.dataDirectory
    ?? process.env.OUTRIGHT_DATA_DIR
    ?? path.join(os.homedir(), ".outright"));
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const requestedFilename = options.filename ?? path.join(dataDirectory, "outright.db");
  if (requestedFilename !== ":memory:") mkdirSync(path.dirname(path.resolve(requestedFilename)), { recursive: true, mode: 0o700 });
  // Lease, sidecars, worker and source must all use one name for the same
  // physical parent directory. A lexical alias must not acquire a second lease.
  const filename = requestedFilename === ":memory:" ? requestedFilename
    : path.join(realpathSync(path.dirname(path.resolve(requestedFilename))), path.basename(requestedFilename));
  // Launch handshake records live next to the database: the launch wrapper
  // durably records its own process identity here before the runtime may
  // authorize the provider to run, so a crash between spawning and recording
  // the pid never loses process ownership. When an explicit filename outside
  // the data directory is used, the records follow that file instead.
  const launchDirectory = path.resolve(options.launchDirectory
    ?? (filename && path.isAbsolute(filename) ? path.join(path.dirname(filename), "launches") : path.join(dataDirectory, "launches")));
  // An explicit filename may live outside the data directory; its parent must
  // exist for the database (and the launch records beside it) to open.
  if (filename && path.isAbsolute(filename)) mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  if (filename !== ":memory:" || options.launchDirectory) preparePrivateLaunchDirectory(launchDirectory);
  const storageFilename = filename;
  let { db, leaseDb } = openRuntimeStorage(filename, storageFilename, Boolean(options.runtimeLease));
  let maintenance = false;
  let maintenanceCapacity;
  let maintenanceError;
  let activeMessageFinds = 0;
  let closing = false;
  let migrationTick;
  let migrationRetry;
  let deletionTick;
  let deletionTickKind;
  let deletionCursor = 0;
  let deletionScanWrapped = false;
  let migrationError = null;
  const deletionsInFlight = new Set();
  const deletionWorkers = new Set();
  const deletionFailures = new Map();
  const deletionBusyDeferrals = new Map();
  const pausedDeletions = new Set();
  const deletionRetryBaseMs = Number.isFinite(options.deletionRetryBaseMs) && options.deletionRetryBaseMs >= 1
    ? options.deletionRetryBaseMs : 1000;
  const deletionIdleWaiters = new Set();
  const closeWaiters = new Set();
  const releaseLeaseIfIdle = () => {
    if (!closing && !deletionWorkers.size && !maintenance) db.pragma("busy_timeout = 5000");
    if (closing && !deletionWorkers.size && leaseDb) { leaseDb.close(); leaseDb = undefined; }
    if (closing && !deletionWorkers.size) {
      for (const resolve of closeWaiters) resolve();
      closeWaiters.clear();
    }
    if (!deletionWorkers.size || closing) {
      for (const resolve of deletionIdleWaiters) resolve();
      deletionIdleWaiters.clear();
    }
    if (!closing) options.onDeletionWorkerExit?.();
  };
  const deletionContext = { isClosing: () => closing, filename: storageFilename, currentDb: () => db,
    workers: deletionWorkers, lockGate: options.deletionWorkerGate, cutoverStatGate: options.deletionCutoverStatGate, copyGate: options.deletionCopyGate,
    copyStepGate: options.deletionCopyStepGate, copyPhase: options.deletionCopyPhase,
    canMaintain: () => activeMessageFinds === 0 && deletionsInFlight.size === 1,
    onWorkerStart: () => {
      const free = statfsSync(path.dirname(storageFilename), { bigint: true });
      const sourceBytes = statSync(storageFilename, { bigint: true }).size
        + (existsSync(`${storageFilename}-wal`) ? statSync(`${storageFilename}-wal`, { bigint: true }).size : 0n);
      if (free.bavail * free.bsize < sourceBytes * 2n + 16n * 1024n * 1024n) {
        throw databaseError(507, "Archive maintenance needs free disk space for a recoverable copy");
      }
      beginArchiveShadow(storageFilename);
      return { changes: db.prepare("SELECT total_changes() AS count").get().count, dataVersion: db.pragma("data_version", { simple: true }) };
    },
    onWorkerReady: (snapshot) => {
      if (activeMessageFinds || deletionsInFlight.size !== 1
        || db.prepare("SELECT 1 FROM runs WHERE status IN ('launching', 'running') LIMIT 1").get()) {
        const error = databaseError(503, "Archive maintenance must wait for other work");
        error.code = "ARCHIVE_DEFERRED";
        throw error;
      }
      const currentSnapshot = { changes: db.prepare("SELECT total_changes() AS count").get().count,
        dataVersion: db.pragma("data_version", { simple: true }) };
      if (snapshot.changes !== currentSnapshot.changes || snapshot.dataVersion !== currentSnapshot.dataVersion) {
        if (process.env.OUTRIGHT_DEBUG === "1") console.warn("[outright:archive-snapshot]", snapshot, currentSnapshot);
        const error = databaseError(503, "Archive changed during shadow cleanup; retry when idle");
        error.code = "ARCHIVE_SNAPSHOT_CHANGED";
        throw error;
      }
      maintenanceCapacity = api.capacity();
      maintenance = true;
      db.close();
      db = undefined;
      options.onDeletionWorkerStart?.();
    },
    onWorkerExit: () => {
      if (!closing && !db) {
        db = openDataConnection(storageFilename);
        reserveRecoveryHeadroom(db);
      }
      maintenance = false;
      maintenanceCapacity = undefined;
      maintenanceError = undefined;
      releaseLeaseIfIdle();
      if (!closing) { continueMigrations(); scheduleDeletionResume(); }
    },
    onWorkerRecoveryFailure: (error) => {
      maintenanceError = error.message;
      for (const resolve of deletionIdleWaiters) resolve();
      deletionIdleWaiters.clear();
      if (closing) releaseLeaseIfIdle();
    } };
  const continueMigrations = () => {
    if (closing || maintenance || !migrationPending(db)) return;
    migrationTick = setImmediate(() => {
      migrationTick = undefined;
      if (closing || maintenance) return;
      try { advanceMigrations(db); migrationError = null; }
      catch (error) {
        migrationError = error;
        options.onMigrationError?.(error);
        migrationRetry = setTimeout(() => { migrationRetry = undefined; continueMigrations(); }, 1000);
        return;
      }
      if (!migrationPending(db)) options.onMigrationComplete?.();
      continueMigrations();
    });
  };
  continueMigrations();
  const scheduleDeletionResume = (delayMs = 0) => {
    if (closing) return;
    // Cancel only the matching handle type. Clearing an Immediate as a Timer
    // can cancel an unrelated request timer on Node's shared handle table.
    if (deletionTickKind === "timeout") clearTimeout(deletionTick);
    else if (deletionTickKind === "immediate") clearImmediate(deletionTick);
    deletionTickKind = delayMs ? "timeout" : "immediate";
    deletionTick = delayMs ? setTimeout(resumeDeletions, delayMs) : setImmediate(resumeDeletions);
  };
  const resumeDeletions = () => {
    if (closing) return;
    if (maintenance) return;
    // Visit at most one page per tick. Failed markers can be numerous, but
    // each retry must leave the runtime event loop available to new work.
    const candidates = db.prepare("SELECT rowid, id FROM conversations WHERE deleting = 1 AND rowid > ? ORDER BY rowid LIMIT 64");
    const rows = candidates.all(deletionCursor);
    if (!rows.length) {
      const wrap = deletionCursor !== 0 && !deletionScanWrapped;
      deletionCursor = 0;
      deletionScanWrapped = wrap;
      // Visit earlier rowids once, then stop if no marker can run. A full
      // page of paused markers must not schedule an endless immediate loop.
      if (wrap) scheduleDeletionResume();
      return;
    }
    const pending = rows.find((row) => !pausedDeletions.has(row.id) && !deletionsInFlight.has(row.id));
    deletionCursor = pending?.rowid ?? rows.at(-1).rowid;
    if (!pending) {
      if (rows.length === 64) scheduleDeletionResume();
      else {
        const wrap = !deletionScanWrapped;
        deletionCursor = 0;
        deletionScanWrapped = wrap;
        if (wrap) scheduleDeletionResume();
      }
      return;
    }
    deletionScanWrapped = false;
    deleteArchivedInBatches(db, pending.id, deletionsInFlight, { ...deletionContext, automatic: true })
      .then((result) => {
        if (result.deleted) {
          deletionFailures.delete(pending.id);
          deletionBusyDeferrals.delete(pending.id);
          pausedDeletions.delete(pending.id);
        }
        const busyCount = result.sourceBusy ? (deletionBusyDeferrals.get(pending.id) ?? 0) + 1 : 0;
        if (busyCount) deletionBusyDeferrals.set(pending.id, busyCount);
        else deletionBusyDeferrals.delete(pending.id);
        // Keep the deferred marker eligible on the next wrap, but visit
        // later markers first. Resetting to zero here starved every sibling
        // behind a giant row while an unrelated run remained active.
        scheduleDeletionResume(result.sourceBusy ? Math.min(300_000, 1000 * 2 ** Math.min(busyCount, 9))
          : result.deferred ? 250 : 0);
      })
      .catch((error) => {
        options.onDeletionError?.(error);
        const failures = (deletionFailures.get(pending.id) ?? 0) + 1;
        deletionFailures.set(pending.id, failures);
        if (failures >= 5) pausedDeletions.add(pending.id);
        else deletionCursor = 0;
        scheduleDeletionResume(pausedDeletions.has(pending.id) ? 0 : Math.min(16_000, deletionRetryBaseMs * 2 ** (failures - 1)));
      });
  };
  if (db.prepare("SELECT 1 FROM conversations WHERE deleting = 1 LIMIT 1").get()) {
    scheduleDeletionResume();
  }

  // Optional retained-data writes use the shared SQLite byte counter. The
  // database trigger below is the final guard for every tracked table. Keep a
  // reserve for run state, recovery decisions and omission markers.
  const retainedReserveBytes = 1024 * 1024;
  function withinRetainedBudget(write, reserve = retainedReserveBytes) {
    if (migrationPending(db)) throw databaseError(507, "Retained history is being migrated; retry when capacity is available");
    try { return db.transaction(() => {
      const before = retainedBytes(db);
      const result = write();
      const limit = Math.max(0, Number(db.prepare("SELECT value FROM settings WHERE key = 'maxRetainedMiB'").get()?.value ?? DEFAULT_SETTINGS.maxRetainedMiB) * 1024 * 1024 - reserve);
      const after = retainedBytes(db);
      // Archiving, clearing metadata, and shrinking retained text must remain
      // possible when a lowered quota already puts history over the limit.
      if (after > limit && after > before) throw databaseError(507, "Retained history is full; archive conversations, then delete selected archived chats or clean up older history");
      return result;
    }).immediate(); }
    catch (error) {
      if (error?.message?.includes("OUTRIGHT_RETAINED_LIMIT")) throw databaseError(507, "Retained history is full; archive conversations, then delete selected archived chats or clean up older history");
      throw error;
    }
  }

  function writeAudit(action, details = {}) {
    db.prepare("INSERT INTO audit_log (action, target, details, created_at) VALUES (?, ?, ?, ?)")
      .run(action, String(details.target ?? "").slice(0, 512), serializePayload(details, 4 * 1024), now());
    trimAudit(db);
  }

  function writeCriticalAudit(action, details = {}) {
    db.transaction(() => {
      reserveRecoveryHeadroom(db, undefined, true);
      writeAudit(action, details);
      reserveRecoveryHeadroom(db);
    }).immediate();
  }

  const api = {
    filename,
    launchDirectory,
    get maintenanceActive() { return maintenance; },
    close: () => {
      if (closing) return deletionWorkers.size ? new Promise((resolve) => closeWaiters.add(resolve)) : Promise.resolve();
      closing = true;
      for (const resolve of deletionIdleWaiters) resolve();
      deletionIdleWaiters.clear();
      if (migrationTick) clearImmediate(migrationTick);
      if (migrationRetry) clearTimeout(migrationRetry);
      if (deletionTickKind === "timeout") clearTimeout(deletionTick);
      else if (deletionTickKind === "immediate") clearImmediate(deletionTick);
      for (const worker of deletionWorkers) void worker.terminate().catch(() => {});
      db?.close();
      db = undefined;
      releaseLeaseIfIdle();
      return deletionWorkers.size ? new Promise((resolve) => closeWaiters.add(resolve)) : Promise.resolve();
    },
    getSettings() {
      const rows = db.prepare("SELECT key, value FROM settings").all();
      return rows.reduce((settings, row) => {
        if (row.key === "_defaultGroupsInitialized") return settings;
        settings[row.key] = parseJson(row.value, row.value);
        return settings;
      }, { ...DEFAULT_SETTINGS });
    },
    updateSettings(patch) {
      validateSettingsPatch(patch);
      if (migrationPending(db)) throw databaseError(507, "Retained history is being migrated; retry when capacity is available");
      const statement = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
      const update = db.transaction((entries) => {
        const before = retainedBytes(db);
        const optionalLimit = Math.max(this.getSettings().maxRetainedMiB, patch.maxRetainedMiB ?? 0) * 1024 * 1024 - retainedReserveBytes;
        // Lowering a quota must not make the existing database unopenable or
        // prevent recovery decisions. Other settings in this patch may not
        // consume the reserve that existed before the quota change.
        if (patch.maxRetainedMiB !== undefined) {
          const target = patch.maxRetainedMiB * 1024 * 1024;
          reserveRecoveryHeadroom(db, target);
        }
        for (const [key, value] of entries) statement.run(key, JSON.stringify(value));
        if (patch.maxRetainedMiB !== undefined) reserveRecoveryHeadroom(db);
        if (retainedBytes(db) > before && retainedBytes(db) > optionalLimit) {
          throw databaseError(507, "Retained history is full; archive conversations, then delete selected archived chats or clean up older history");
        }
      });
      update.immediate(Object.entries(patch));
      return this.getSettings();
    },
    capacity() {
      const disk = allocatedDatabaseUsage(storageFilename);
      const settings = this.getSettings();
      const queued = db.prepare("SELECT COUNT(*) AS count FROM runs WHERE status = 'queued'").get().count;
      const active = db.prepare("SELECT COUNT(*) AS count FROM runs WHERE status IN ('launching', 'running')").get().count;
      const recoverable = db.prepare("SELECT COUNT(*) AS count FROM runs WHERE status = 'interrupted' AND recovery_decision IS NULL").get().count;
      const cleanupPending = Boolean(db.prepare("SELECT 1 FROM conversations WHERE deleting = 1 LIMIT 1").get());
      const measured = retainedMeasured(db);
      const migrating = migrationPending(db);
      const bytes = measured ? retainedBytes(db) : null;
      const maxRetainedBytes = settings.maxRetainedMiB * 1024 * 1024;
      let migrationStatus = "ready";
      if (migrationError) migrationStatus = "error";
      else if (migrating) migrationStatus = "migrating";
      let retainedUsageStatus = "measuring";
      if (measured) retainedUsageStatus = "measured";
      else if (migrationError) retainedUsageStatus = "error";
      return { queued, active, recoverable, cleanupPending, cleanupPaused: pausedDeletions.size, retainedBytes: bytes,
        retainedUsageStatus,
        migrationStatus,
        availableForNewWorkBytes: measured && !migrating ? Math.max(0, maxRetainedBytes - retainedReserveBytes - bytes) : 0, limits: {
        maxQueuedRuns: settings.maxQueuedRuns, maxConcurrentRuns: settings.maxConcurrentRuns,
        maxRetainedBytes, reservedRetainedBytes: retainedReserveBytes, retentionDays: settings.retentionDays,
        maxRunTranscriptItems: RESOURCE_BUDGETS.maxRunTranscriptItems, maxRunTranscriptBytes: RESOURCE_BUDGETS.maxRunTranscriptBytes,
        maxRunEventBytes: MAX_RUN_EVENT_RETAINED_BYTES,
      }, cpuUsage: null, memoryUsage: null, diskAllocatedBytes: disk.bytes,
      diskUsageStatus: disk.status };
    },
    canLaunchRun() {
      // Keep enough ordinary retained space for a newly launched run to
      // record its first output. The separate reserve remains for recovery
      // and terminal transitions.
      const capacity = this.capacity();
      // A durable deletion marker protects its own conversation, but does
      // not reserve every free agent slot. Only the short final cutover
      // pauses launches; a long unrelated run may keep an oversized delete
      // deferred without starving the queue.
      return !maintenance && capacity.diskUsageStatus !== "unknown" && capacity.availableForNewWorkBytes >= 64 * 1024;
    },
    listDeletableArchivedConversations({ limit = 100, cursor = null } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw databaseError(400, "Archived history page size must be 1 to 100");
      let after = null;
      if (cursor !== null) {
        if (typeof cursor !== "string" || cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw databaseError(400, "Archived history cursor is invalid");
        try {
          after = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
          if (Buffer.from(JSON.stringify(after)).toString("base64url") !== cursor || !Array.isArray(after) || after.length !== 2
            || after.some((part) => typeof part !== "string" || !part || part.length > 512)) throw new Error("invalid cursor");
        } catch { throw databaseError(400, "Archived history cursor is invalid"); }
      }
      // Project only short previews in SQLite, so a page of legacy multi-MiB
      // titles never crosses the native/JS boundary in full.
      const rows = db.prepare(`SELECT id, substr(title, 1, 257) AS title,
          substr(worktree_path, 1, 257) AS worktreePath, updated_at AS updatedAt FROM conversations
        WHERE archived = 1 AND deleting = 0 AND NOT EXISTS (SELECT 1 FROM runs WHERE conversation_id = conversations.id
          AND (status IN ('queued', 'launching', 'running') OR (status = 'interrupted' AND recovery_decision IS NULL)))
        AND (? IS NULL OR updated_at < ? OR (updated_at = ? AND id < ?))
        ORDER BY updated_at DESC, id DESC LIMIT ?`).all(after?.[0] ?? null, after?.[0] ?? null, after?.[0] ?? null, after?.[1] ?? null, limit + 1);
      return boundedArchivedPage(rows, limit);
    },
    deleteArchivedConversation(id, confirmation) {
      if (typeof id !== "string" || !id || id.length > 200 || confirmation !== id) {
        throw databaseError(400, "Confirm the exact archived conversation id before deleting it");
      }
      if (deletionsInFlight.has(id)) throw databaseError(409, "Archived conversation deletion is in progress");
      pausedDeletions.delete(id);
      deletionFailures.delete(id);
      return deleteArchivedInBatches(db, id, deletionsInFlight, deletionContext)
        .then((result) => {
          if (result.deleted) { pausedDeletions.delete(id); deletionFailures.delete(id); }
          if (result.deferred) { scheduleDeletionResume(250); }
          return result;
        })
        .catch((error) => {
          if (!closing) { scheduleDeletionResume(1000); }
          throw error;
        });
    },
    // Each eligible conversation is fenced before bounded child-row batches.
    // The fence survives restart, so interruption cannot expose a partly
    // deleted conversation to a new run or unarchive operation.
    pruneHistory({ before, limit = 100 } = {}) {
      const maximum = Date.now() - this.getSettings().retentionDays * 86_400_000;
      const requested = before ?? new Date(maximum).toISOString();
      const cutoffTime = typeof requested === "string" ? Date.parse(requested) : Number.NaN;
      if (!Number.isFinite(cutoffTime) || cutoffTime > maximum) {
        throw databaseError(400, "Retention cutoff must be a valid date within the saved retention window");
      }
      // SQLite compares updated_at as ISO text, so bind the parsed instant in
      // the same format rather than a caller's locale or timezone spelling.
      const cutoff = new Date(cutoffTime).toISOString();
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw databaseError(400, "Retention limit must be 1 to 1000");
      const ids = db.prepare(`SELECT id FROM conversations WHERE archived = 1 AND (deleting = 1 OR (pinned = 0 AND updated_at < ?))
          AND NOT EXISTS (SELECT 1 FROM runs WHERE conversation_id = conversations.id
            AND (status IN ('queued', 'launching', 'running') OR (status = 'interrupted' AND recovery_decision IS NULL)))
          ORDER BY updated_at, id LIMIT ?`).all(cutoff, limit).map((row) => row.id);
      return (async () => {
        const deleted = [];
        let deferred = 0;
        for (const id of ids) {
          try {
            const result = await deleteArchivedInBatches(db, id, deletionsInFlight, { ...deletionContext, automatic: true });
            if (result.deleted) {
              deleted.push(id);
              pausedDeletions.delete(id);
              deletionFailures.delete(id);
            }
            else if (result.deferred) { deferred += 1; scheduleDeletionResume(250); }
          }
          catch (error) {
            if (error.statusCode !== 404 && error.statusCode !== 409) {
              if (!closing) { scheduleDeletionResume(1000); }
              throw error;
            }
          }
        }
        return { deleted: deleted.length, deferred, ids: deleted };
      })();
    },
    listGroups() {
      const groups = db.prepare("SELECT id, name, position, created_at AS createdAt FROM project_groups ORDER BY position, created_at").all();
      const memberships = Object.fromEntries(db.prepare("SELECT project_id, group_id FROM project_memberships").all().map((row) => [row.project_id, row.group_id]));
      return { groups, memberships };
    },
    ensureDefaultGroups(projects) {
      if (db.prepare("SELECT 1 FROM settings WHERE key = '_defaultGroupsInitialized'").get()) return;
      const existing = this.listGroups().groups;
      if (existing.length && !existing.some((group) => ["Core systems", "Experiments"].includes(group.name))) return;
      // Keep both groups, every discovered membership, and the completion
      // marker in one quota-checked transaction. A failed first scan can be
      // retried after cleanup without leaving a partial default hierarchy.
      withinRetainedBudget(() => {
        const groups = this.listGroups().groups;
        const core = groups.find((group) => group.name === "Core systems") ?? this.createGroup("Core systems");
        const experiments = groups.find((group) => group.name === "Experiments") ?? this.createGroup("Experiments");
        const memberships = this.listGroups().memberships;
        for (const project of projects) {
          if (memberships[project.id]) continue;
          this.setProjectGroup(project.id, /experiment|prototype|playground/i.test(`${project.name} ${project.path}`) ? experiments.id : core.id);
        }
        db.prepare("INSERT INTO settings (key, value) VALUES ('_defaultGroupsInitialized', 'true')").run();
      });
    },
    createGroup(name) {
      if (retainedBytes(db) >= this.getSettings().maxRetainedMiB * 1024 * 1024) {
        throw databaseError(507, "Retained history is full; archive conversations, then delete selected archived chats or clean up older history");
      }
      const id = randomUUID();
      const position = db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS position FROM project_groups").get().position;
      withinRetainedBudget(() => db.prepare("INSERT INTO project_groups (id, name, position, created_at) VALUES (?, ?, ?, ?)").run(id, name.trim(), position, now()));
      return db.prepare("SELECT id, name, position, created_at AS createdAt FROM project_groups WHERE id = ?").get(id);
    },
    updateGroup(id, patch) {
      if (typeof patch.name === "string" && patch.name.trim()) withinRetainedBudget(() => db.prepare("UPDATE project_groups SET name = ? WHERE id = ?").run(patch.name.trim(), id));
      if (Number.isInteger(patch.position)) db.prepare("UPDATE project_groups SET position = ? WHERE id = ?").run(patch.position, id);
      return db.prepare("SELECT id, name, position, created_at AS createdAt FROM project_groups WHERE id = ?").get(id);
    },
    deleteGroup(id) {
      return db.prepare("DELETE FROM project_groups WHERE id = ?").run(id).changes > 0;
    },
    setProjectGroup(projectId, groupId) {
      if (!groupId) db.prepare("DELETE FROM project_memberships WHERE project_id = ?").run(projectId);
      else withinRetainedBudget(() => db.prepare("INSERT INTO project_memberships (project_id, group_id) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET group_id = excluded.group_id").run(projectId, groupId));
    },
    listConversations(filters = {}) {
      const where = ["archived = ?", "deleting = 0"];
      const values = [filters.archived ? 1 : 0];
      if (filters.projectId) { where.push("project_id = ?"); values.push(filters.projectId); }
      if (filters.worktreeId) { where.push("worktree_id = ?"); values.push(filters.worktreeId); }
      return db.prepare(`SELECT ${conversationColumns()} FROM conversations WHERE ${where.join(" AND ")} ORDER BY pinned DESC, tab_position, updated_at DESC`).all(...values);
    },
    getConversation(id) {
      return db.prepare(`SELECT ${conversationColumns()} FROM conversations WHERE id = ? AND deleting = 0`).get(id);
    },
    createConversation(input) {
      if (retainedBytes(db) >= this.getSettings().maxRetainedMiB * 1024 * 1024) {
        throw databaseError(507, "Retained history is full; archive conversations, then delete selected archived chats or clean up older history");
      }
      const id = randomUUID();
      const timestamp = now();
      const position = db.prepare("SELECT COALESCE(MAX(tab_position), -1) + 1 AS position FROM conversations WHERE project_id = ? AND worktree_id = ?").get(input.projectId, input.worktreeId).position;
      withinRetainedBudget(() => db.prepare(`INSERT INTO conversations (id, project_id, worktree_id, worktree_path, title, provider, model, tab_position, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, input.projectId, input.worktreeId, input.worktreePath, input.title?.trim() || "New agent chat", input.provider || "codex", input.model || "", position, timestamp, timestamp));
      return this.getConversation(id);
    },
    updateConversation(id, patch) {
      if (db.prepare("SELECT deleting FROM conversations WHERE id = ?").get(id)?.deleting) {
        throw databaseError(409, "Archived conversation deletion is in progress");
      }
      if (patch.archived !== undefined && typeof patch.archived !== "boolean") {
        throw databaseError(400, "Conversation archived state must be a boolean");
      }
      if (patch.providerSessionId != null && (typeof patch.providerSessionId !== "string" || Buffer.byteLength(patch.providerSessionId) > 4096)) {
        throw databaseError(400, "Provider session id is invalid");
      }
      if (patch.archived === true && this.findUnresolvedInterruptedRun(id)) {
        throw databaseError(409, "Resolve the interrupted run before archiving this conversation");
      }
      const fields = [];
      const values = [];
      for (const [key, column] of Object.entries({ title: "title", provider: "provider", model: "model", archived: "archived", pinned: "pinned", providerSessionId: "provider_session_id", tabPosition: "tab_position" })) {
        if (patch[key] === undefined) continue;
        fields.push(`${column} = ?`);
        values.push(typeof patch[key] === "boolean" ? Number(patch[key]) : patch[key]);
      }
      if (fields.length) {
        fields.push("updated_at = ?");
        values.push(now(), id);
        const update = () => db.prepare(`UPDATE conversations SET ${fields.join(", ")} WHERE id = ?`).run(...values);
        withinRetainedBudget(update);
      }
      return this.getConversation(id);
    },
    moveConversation(id, destination) {
      if (db.prepare("SELECT deleting FROM conversations WHERE id = ?").get(id)?.deleting) {
        throw databaseError(409, "Archived conversation deletion is in progress");
      }
      const unresolved = this.listUnresolvedInterruptedRuns(id);
      if (unresolved.some((run) => !run.worktreePath || run.worktreePath !== destination.worktreePath)) {
        throw databaseError(409, "Resolve the interrupted run before moving this conversation away from its recovery worktree");
      }
      const position = db.prepare("SELECT COALESCE(MAX(tab_position), -1) + 1 AS position FROM conversations WHERE project_id = ? AND worktree_id = ?").get(destination.projectId, destination.worktreeId).position;
      withinRetainedBudget(() => {
        const changed = db.prepare("UPDATE conversations SET project_id = ?, worktree_id = ?, worktree_path = ?, tab_position = ?, updated_at = ? WHERE id = ? AND deleting = 0")
          .run(destination.projectId, destination.worktreeId, destination.worktreePath, position, now(), id).changes;
        if (!changed) throw databaseError(409, "Conversation is unavailable for moving");
      });
      return this.getConversation(id);
    },
    listMessages(conversationId) {
      assertConversationNotDeleting(db, conversationId);
      assertMessageOrderReady(db);
      return db.prepare(`SELECT search_order AS searchOrder, id, conversation_id AS conversationId, role, kind, body, payload, created_at AS createdAt
        FROM message_order AS ordered JOIN messages AS m ON m.id = ordered.message_key WHERE ordered.scope = ? ORDER BY ordered.ordinal`).all(conversationId).map(hydratePayload);
    },
    messageCount(conversationId) {
      assertConversationNotDeleting(db, conversationId);
      return db.prepare("SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?").get(conversationId).count;
    },
    listMessagePage(conversationId, options = {}) {
      assertConversationNotDeleting(db, conversationId);
      assertMessageOrderReady(db);
      const limit = Math.max(1, Math.min(500, Number(options.limit) || 200));
      if (options.beforeId && options.afterId) throw databaseError(400, "Choose one message cursor");
      // Select a contiguous cursor window by stored byte lengths before any
      // body or payload crosses into JavaScript. Each row also has an inline
      // ceiling, so five retained pages cannot grow with legacy large rows.
      const candidateColumns = `search_order AS messageRowId, id,
        COALESCE(LENGTH(CAST(body AS BLOB)), 0) AS bodyBytes,
        COALESCE(LENGTH(CAST(payload AS BLOB)), 0) AS payloadBytes`;
      let candidates;
      if (options.beforeId) {
        const cursor = db.prepare("SELECT search_order AS rowid FROM messages WHERE conversation_id = ? AND id = ?").get(conversationId, options.beforeId);
        if (!cursor) throw databaseError(400, "Message cursor was not found");
        candidates = db.prepare(`SELECT ${candidateColumns}
          FROM message_order AS ordered JOIN messages AS m ON m.id = ordered.message_key WHERE ordered.scope = ? AND ordered.ordinal < ? ORDER BY ordered.ordinal DESC LIMIT ?`).all(conversationId, cursor.rowid, limit);
      } else if (options.afterId) {
        const cursor = db.prepare("SELECT search_order AS rowid FROM messages WHERE conversation_id = ? AND id = ?").get(conversationId, options.afterId);
        if (!cursor) throw databaseError(400, "Message cursor was not found");
        candidates = db.prepare(`SELECT ${candidateColumns}
          FROM message_order AS ordered JOIN messages AS m ON m.id = ordered.message_key WHERE ordered.scope = ? AND ordered.ordinal > ? ORDER BY ordered.ordinal ASC LIMIT ?`).all(conversationId, cursor.rowid, limit);
      } else {
        candidates = db.prepare(`SELECT ${candidateColumns}
          FROM message_order AS ordered JOIN messages AS m ON m.id = ordered.message_key WHERE ordered.scope = ? ORDER BY ordered.ordinal DESC LIMIT ?`).all(conversationId, limit);
      }
      let selectedBytes = 2048;
      const selected = [];
      for (const candidate of candidates) {
        // Count stored bytes, including fields projected only as excerpts.
        // Otherwise JSON metadata extraction could scan dozens of giant
        // legacy payloads even though the HTTP response itself is short.
        const bytes = candidate.bodyBytes + candidate.payloadBytes + 512;
        if (selected.length && selectedBytes + bytes > MAX_MESSAGE_PAGE_BYTES) break;
        selected.push(candidate);
        selectedBytes += bytes;
      }
      if (!options.afterId) selected.reverse();
      let messages = [];
      if (selected.length) {
        const rows = db.prepare(`SELECT search_order AS messageRowId, id, conversation_id AS conversationId, role, kind,
          CASE WHEN COALESCE(LENGTH(CAST(body AS BLOB)), 0) > ? THEN SUBSTR(CAST(body AS BLOB), 1, ?) ELSE body END AS body,
          CASE WHEN COALESCE(LENGTH(CAST(body AS BLOB)), 0) > ? THEN SUBSTR(CAST(body AS BLOB), -?) ELSE NULL END AS bodySuffix,
          CASE WHEN COALESCE(LENGTH(CAST(payload AS BLOB)), 0) > ? THEN NULL ELSE payload END AS payload,
          CASE WHEN COALESCE(LENGTH(CAST(payload AS BLOB)), 0) BETWEEN ? AND ? THEN CASE WHEN json_valid(payload) THEN json_extract(payload, '$.runId') END END AS runId,
          CASE WHEN COALESCE(LENGTH(CAST(payload AS BLOB)), 0) BETWEEN ? AND ? THEN CASE WHEN json_valid(payload) THEN json_extract(payload, '$.provider') END END AS provider,
          CASE WHEN COALESCE(LENGTH(CAST(payload AS BLOB)), 0) BETWEEN ? AND ? THEN CASE WHEN json_valid(payload) THEN json_extract(payload, '$.checkpointEventSeq') END END AS checkpointEventSeq,
          created_at AS createdAt
          FROM message_order AS ordered JOIN messages AS m ON m.id = ordered.message_key WHERE ordered.scope = ? AND ordered.ordinal BETWEEN ? AND ? ORDER BY ordered.ordinal`)
          .all(MAX_INLINE_MESSAGE_BYTES, MAX_INLINE_MESSAGE_BYTES / 2,
            MAX_INLINE_MESSAGE_BYTES, MAX_INLINE_MESSAGE_BYTES / 2, MAX_INLINE_MESSAGE_BYTES,
            MAX_INLINE_MESSAGE_BYTES + 1, MAX_MESSAGE_PAGE_BYTES,
            MAX_INLINE_MESSAGE_BYTES + 1, MAX_MESSAGE_PAGE_BYTES,
            MAX_INLINE_MESSAGE_BYTES + 1, MAX_MESSAGE_PAGE_BYTES,
            conversationId, selected[0].messageRowId, selected.at(-1).messageRowId);
        const sizes = new Map(selected.map((row) => [row.id, row]));
        messages = rows.map(({ messageRowId, bodySuffix, runId, provider, checkpointEventSeq, ...row }) => {
          const size = sizes.get(row.id);
          const bodyExcerpt = size.bodyBytes > MAX_INLINE_MESSAGE_BYTES;
          const payloadOmitted = size.payloadBytes > MAX_INLINE_MESSAGE_BYTES;
          const body = Buffer.isBuffer(row.body) ? decodeMessagePrefix(row.body) : row.body;
          const payload = payloadOmitted ? { runId, provider, checkpointEventSeq } : parseJson(row.payload, null);
          const suffix = Buffer.isBuffer(bodySuffix) ? decodeMessageSuffix(bodySuffix) : "";
          return { ...row, body: bodyExcerpt ? `${body}\n[Middle text omitted from this page]\n${suffix}` : body,
            payload, searchOrder: messageRowId, ...(bodyExcerpt ? { findExcerpt: true } : {}),
            ...(payloadOmitted ? { payloadOmitted: true } : {}) };
        });
        let serializedBytes = 2 + messages.reduce((bytes, message) => bytes + Buffer.byteLength(JSON.stringify(message)) + 1, 0);
        while (messages.length > 1 && serializedBytes > MAX_MESSAGE_PAGE_BYTES - 2048) {
          const removed = options.afterId ? messages.pop() : messages.shift();
          serializedBytes -= Buffer.byteLength(JSON.stringify(removed)) + 1;
        }
      }
      const total = db.prepare("SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?").get(conversationId).count;
      const oldestRowId = messages[0]?.searchOrder;
      let olderCount = 0;
      if (oldestRowId) {
        olderCount = db.prepare("SELECT COUNT(*) AS count FROM message_order AS ordered JOIN messages AS m ON m.id = ordered.message_key WHERE ordered.scope = ? AND ordered.ordinal < ?")
          .get(conversationId, oldestRowId).count;
      } else if (options.afterId) olderCount = total;
      const hasMore = olderCount > 0;
      const newerCount = Math.max(0, total - olderCount - messages.length);
      return {
        messages,
        page: { hasMore, olderCount, hasLater: newerCount > 0, newerCount, total, beforeId: messages[0]?.id ?? null, limit },
      };
    },
    async findMessagePage(conversationId, query, afterId, direction = 1, signal,
      { originId = afterId, wrapped = false, byteOffset = 0, contextOffset = 0, leftContextOffset = 0, leftContextCased = null } = {}) {
      assertConversationNotDeleting(db, conversationId);
      assertMessageOrderReady(db);
      if (activeMessageFinds >= 8) throw databaseError(429, "Too many conversation searches; retry");
      activeMessageFinds += 1;
      try {
        const cursor = afterId ? db.prepare("SELECT search_order AS rowid FROM messages WHERE conversation_id = ? AND id = ?").get(conversationId, afterId) : null;
        if (afterId && !cursor) throw databaseError(400, "Message cursor was not found");
        const origin = originId ? db.prepare("SELECT search_order AS rowid FROM messages WHERE conversation_id = ? AND id = ?").get(conversationId, originId) : null;
        if (originId && !origin) throw databaseError(400, "Message cursor was not found");
        if (wrapped && !origin) throw databaseError(400, "Wrapped search requires an origin cursor");
        if (!Number.isSafeInteger(byteOffset) || byteOffset < 0 || (byteOffset && !cursor)) throw databaseError(400, "Search byte offset is invalid");
        if (!Number.isSafeInteger(contextOffset) || contextOffset < 0 || (contextOffset && (!cursor || contextOffset <= byteOffset))) throw databaseError(400, "Search context offset is invalid");
        if (!Number.isSafeInteger(leftContextOffset) || leftContextOffset < 0 || (leftContextOffset && !cursor)
          || (leftContextCased !== null && (typeof leftContextCased !== "boolean" || !contextOffset))) throw databaseError(400, "Search left context is invalid");
        const forward = direction !== -1;
        const order = forward ? "ASC" : "DESC";
        const comparison = forward ? ">" : "<";
        // Select identities and byte lengths first. Legacy bodies can exceed
        // the request budget, so each body is read in bounded BLOB sections.
        const columns = "search_order AS rowid, id, COALESCE(LENGTH(CAST(body AS BLOB)), 0) AS bodyBytes";
        const batch = db.prepare(`SELECT ${columns} FROM message_order AS ordered JOIN messages AS m ON m.id = ordered.message_key WHERE ordered.scope = ? AND ordered.ordinal ${comparison} ? ORDER BY ordered.ordinal ${order} LIMIT 8`);
        const wrappedBatch = origin && db.prepare(`SELECT ${columns} FROM message_order AS ordered JOIN messages AS m ON m.id = ordered.message_key WHERE ordered.scope = ? AND ordered.ordinal ${comparison} ? AND ordered.ordinal ${forward ? "<=" : ">="} ? ORDER BY ordered.ordinal ${order} LIMIT 8`);
        const resumeRow = db.prepare(`SELECT ${columns} FROM messages WHERE conversation_id = ? AND id = ?`);
        const bodyChunk = db.prepare("SELECT SUBSTR(CAST(COALESCE(body, '') AS BLOB), ?, ?) AS bytes FROM messages WHERE conversation_id = ? AND id = ?");
        const foldedQuery = foldFindText(query);
        const overlap = Math.max(1024, Buffer.byteLength(query) * 4 + 16);
        // One HTTP request scans a bounded amount of text. The client carries
        // the cursor forward until the full conversation has been searched.
        let scannedRows = 0;
        let scannedBytes = 0;
        const scan = async (initial, inWrappedSegment) => {
          let boundary = initial;
          let resumeOffset = inWrappedSegment === wrapped ? byteOffset : 0;
          let resumeContextOffset = inWrappedSegment === wrapped ? contextOffset : 0;
          let resumeLeftContextOffset = inWrappedSegment === wrapped ? leftContextOffset : 0;
          let resumeLeftContextCased = inWrappedSegment === wrapped ? leftContextCased : null;
          while (true) {
            if (signal?.aborted || closing) return null;
            const rows = resumeOffset || resumeContextOffset || resumeLeftContextOffset
              ? [resumeRow.get(conversationId, afterId)]
              : inWrappedSegment ? wrappedBatch.all(conversationId, boundary, origin.rowid) : batch.all(conversationId, boundary);
            if (!rows.length) return null;
            for (const row of rows) {
              if (!row) throw databaseError(400, "Message cursor was not found");
              let offset = resumeOffset;
              let contextResume = resumeContextOffset;
              let leftContextResume = resumeLeftContextOffset;
              let leftCasedResume = resumeLeftContextCased;
              resumeOffset = 0;
              resumeContextOffset = 0;
              resumeLeftContextOffset = 0;
              resumeLeftContextCased = null;
              if (offset > row.bodyBytes) throw databaseError(400, "Search byte offset is invalid");
              if (contextResume > row.bodyBytes) throw databaseError(400, "Search context offset is invalid");
              if (leftContextResume > row.bodyBytes) throw databaseError(400, "Search left context is invalid");
              while (offset < row.bodyBytes) {
                if (signal?.aborted || closing) return null;
                const start = Math.max(0, offset - overlap);
                // Include enough right context for Unicode lowercasing at the
                // charged chunk edge (notably Greek final sigma). The next
                // chunk charges these overlap bytes when it advances.
                const length = Math.min(row.bodyBytes - start, FIND_CHUNK_BYTES + offset - start + overlap);
                const stored = bodyChunk.get(start + 1, length, conversationId, row.id);
                if (!stored) return null; // The conversation was deleted during a yielded scan.
                const bytes = stored.bytes;
                // Resume overlap can start inside a UTF-8 character. Drop that
                // fragment before folding so byte positions remain exact.
                let skip = 0;
                while (skip < bytes.length && (bytes[skip] & 0xc0) === 0x80) skip += 1;
                const source = decodeMessagePrefix(bytes.subarray(skip));
                let leftContext = "";
                const needsLeftContext = start + skip > 0 && /^\p{Case_Ignorable}*Σ/u.test(source);
                if ((leftContextResume || leftCasedResume !== null) && !needsLeftContext) throw databaseError(409, "Search context changed; retry");
                if (needsLeftContext && leftCasedResume !== null) leftContext = leftCasedResume ? "A" : ".";
                else if (needsLeftContext) {
                  let contextEnd = leftContextResume || start + skip;
                  let decided = false;
                  while (contextEnd > 0 && scannedBytes < FIND_SCAN_BYTES) {
                    if (signal?.aborted || closing) return null;
                    const length = Math.min(FIND_CHUNK_BYTES, contextEnd, Math.max(4, FIND_SCAN_BYTES - scannedBytes));
                    const chunkStart = contextEnd - length;
                    const context = bodyChunk.get(chunkStart + 1, length, conversationId, row.id);
                    if (!context) return null;
                    let skipped = 0;
                    while (skipped < context.bytes.length && (context.bytes[skipped] & 0xc0) === 0x80) skipped += 1;
                    const contextText = decodeMessageSuffix(context.bytes);
                    for (const point of [...contextText].reverse()) {
                      if (/\p{Case_Ignorable}/u.test(point)) continue;
                      leftContext = /\p{Cased}/u.test(point) ? "A" : ".";
                      decided = true;
                      break;
                    }
                    contextEnd = chunkStart + skipped;
                    scannedBytes += length;
                    if (decided) break;
                    await new Promise((resolve) => setImmediate(resolve));
                  }
                  if (!decided && contextEnd > 0) return { partial: true, nextAfterId: row.id,
                    nextByteOffset: offset, nextLeftContextOffset: contextEnd, originId: originId ?? null, wrapped: inWrappedSegment };
                  if (!leftContext) leftContext = ".";
                }
                leftContextResume = 0;
                leftCasedResume = null;
                let rightContext = "";
                const decodedEnd = start + skip + Buffer.byteLength(source);
                const pendingContextOffset = contextResume;
                contextResume = 0;
                const needsRightContext = /Σ\p{Case_Ignorable}*$/u.test(source) && decodedEnd < row.bodyBytes;
                if (pendingContextOffset && !needsRightContext) throw databaseError(409, "Search context changed; retry");
                // Greek sigma lowercasing depends on the next non-ignorable
                // character. A run of combining marks can extend beyond the
                // ordinary overlap, so inspect it in yielded bounded reads.
                if (needsRightContext) {
                  let contextReadOffset = pendingContextOffset || decodedEnd;
                  let contextCased = false;
                  let decided = false;
                  while (contextReadOffset < row.bodyBytes && scannedBytes < FIND_SCAN_BYTES) {
                    if (signal?.aborted || closing) return null;
                    const context = bodyChunk.get(contextReadOffset + 1,
                      Math.min(FIND_CHUNK_BYTES, row.bodyBytes - contextReadOffset, Math.max(4, FIND_SCAN_BYTES - scannedBytes)), conversationId, row.id);
                    if (!context) return null;
                    const contextText = decodeMessagePrefix(context.bytes);
                    const contextBytes = Buffer.byteLength(contextText);
                    if (!contextBytes) throw databaseError(400, "Message body is not valid UTF-8");
                    for (const point of contextText) {
                      if (/\p{Case_Ignorable}/u.test(point)) continue;
                      contextCased = /\p{Cased}/u.test(point);
                      decided = true;
                      break;
                    }
                    contextReadOffset += contextBytes;
                    scannedBytes += contextBytes;
                    if (decided) break;
                    await new Promise((resolve) => setImmediate(resolve));
                  }
                  if (!decided && contextReadOffset < row.bodyBytes) return { partial: true, nextAfterId: row.id,
                    nextByteOffset: offset, nextContextOffset: contextReadOffset,
                    ...(leftContext ? { nextLeftContextCased: leftContext === "A" } : {}),
                    originId: originId ?? null, wrapped: inWrappedSegment };
                  rightContext = contextCased ? "A" : ".";
                }
                const foldedText = foldFindText(`${leftContext}${source}${rightContext}`);
                const folded = foldedText.slice(leftContext ? 1 : 0, rightContext ? -1 : undefined);
                let found = folded.indexOf(foldedQuery);
                while (found >= 0) {
                  let character = 0; let matchEnd = 0; let foldedPosition = 0;
                  for (const point of source) {
                    if (foldedPosition >= found + foldedQuery.length) break;
                    const nextFolded = foldedPosition + foldFindText(point).length;
                    if (nextFolded <= found) character += point.length;
                    matchEnd += point.length;
                    foldedPosition = nextFolded;
                  }
                  const matchByteOffset = start + skip + Buffer.byteLength(source.slice(0, character));
                  const matchEndByteOffset = start + skip + Buffer.byteLength(source.slice(0, matchEnd));
                  // The overlap may contain a match already scanned by the
                  // previous request; only new or crossing matches count.
                  if (matchEndByteOffset > offset && matchByteOffset < offset + FIND_CHUNK_BYTES) return { match: row, matchByteOffset };
                  found = folded.indexOf(foldedQuery, found + 1);
                }
                const advance = Math.min(FIND_CHUNK_BYTES, row.bodyBytes - offset);
                offset += advance;
                scannedBytes += advance;
                // The wrapped origin is inclusive and is the final row. If
                // its last byte exhausts the budget, the search is complete;
                // a same-ID, zero-offset continuation would be ambiguous.
                if (scannedBytes >= FIND_SCAN_BYTES && inWrappedSegment && row.id === originId && offset === row.bodyBytes) return null;
                if (scannedBytes >= FIND_SCAN_BYTES) return { partial: true, nextAfterId: row.id,
                  nextByteOffset: offset < row.bodyBytes ? offset : 0, originId: originId ?? null, wrapped: inWrappedSegment };
                await new Promise((resolve) => setImmediate(resolve));
              }
              boundary = row.rowid;
              scannedRows += 1;
              if (scannedRows >= 512) return { partial: true, nextAfterId: row.id, nextByteOffset: 0, originId: originId ?? null, wrapped: inWrappedSegment };
            }
            // SQLite is synchronous; yield after a small bounded batch so socket
            // delivery and other requests can run during large no-match searches.
            await new Promise((resolve) => setImmediate(resolve));
          }
        };
        let result = await scan(cursor?.rowid ?? (forward ? 0 : Number.MAX_SAFE_INTEGER), wrapped);
        if (!result && origin && !wrapped) result = await scan(forward ? 0 : Number.MAX_SAFE_INTEGER, true);
        if (signal?.aborted || closing) return { matchId: null, messages: [], messagePage: null };
        assertConversationNotDeleting(db, conversationId);
        if (result?.partial) return result;
        if (!result) return { matchId: null, messages: [], messagePage: null };
        const match = result.match;
        // Select by stored byte lengths before hydrating message bodies. A
        // 200-row Find window can otherwise serialize hundreds of MiB even
        // though the search scan itself has an 8 MiB work limit.
        const sizes = `SELECT search_order AS rowid, id, COALESCE(LENGTH(CAST(body AS BLOB)), 0) + COALESCE(LENGTH(CAST(payload AS BLOB)), 0) + 512 AS bytes
          FROM message_order AS ordered JOIN messages AS m ON m.id = ordered.message_key WHERE ordered.scope = ? AND ordered.ordinal`;
        const olderCandidates = db.prepare(`${sizes} <= ? ORDER BY ordered.ordinal DESC LIMIT 100`).all(conversationId, match.rowid);
        const newerCandidates = db.prepare(`${sizes} > ? ORDER BY ordered.ordinal ASC LIMIT 100`).all(conversationId, match.rowid);
        if (olderCandidates[0]?.id !== match.id) return { matchId: null, messages: [], messagePage: null };
        const maxBytes = 8 * 1024 * 1024;
        let remaining = maxBytes;
        const chosen = [olderCandidates[0]];
        remaining -= Math.min(olderCandidates[0].bytes, maxBytes);
        let olderIndex = 1; let newerIndex = 0;
        let olderBlocked = false; let newerBlocked = false;
        while (chosen.length < 200 && (!olderBlocked || !newerBlocked)) {
          for (const side of ["older", "newer"]) {
            if (side === "older" && !olderBlocked) {
              const candidate = olderCandidates[olderIndex];
              if (!candidate || candidate.bytes > remaining) olderBlocked = true;
              else { chosen.push(candidate); remaining -= candidate.bytes; olderIndex += 1; }
            } else if (side === "newer" && !newerBlocked) {
              const candidate = newerCandidates[newerIndex];
              if (!candidate || candidate.bytes > remaining) newerBlocked = true;
              else { chosen.push(candidate); remaining -= candidate.bytes; newerIndex += 1; }
            }
            if (chosen.length >= 200) break;
          }
        }
        const firstRow = Math.min(...chosen.map((row) => row.rowid));
        const lastRow = Math.max(...chosen.map((row) => row.rowid));
        const rows = db.prepare(`SELECT search_order AS messageRowId, id, conversation_id AS conversationId, role, kind,
          CASE WHEN COALESCE(LENGTH(CAST(body AS BLOB)), 0) > ? THEN SUBSTR(CAST(body AS BLOB), 1, ?) ELSE body END AS body,
          CASE WHEN COALESCE(LENGTH(CAST(body AS BLOB)), 0) > ? THEN SUBSTR(CAST(body AS BLOB), -?) ELSE NULL END AS bodySuffix,
          CASE WHEN COALESCE(LENGTH(CAST(payload AS BLOB)), 0) > ? THEN NULL ELSE payload END AS payload,
          COALESCE(LENGTH(CAST(payload AS BLOB)), 0) AS payloadBytes,
          CASE WHEN COALESCE(LENGTH(CAST(payload AS BLOB)), 0) BETWEEN ? AND ? THEN CASE WHEN json_valid(payload) THEN json_extract(payload, '$.runId') END END AS runId,
          CASE WHEN COALESCE(LENGTH(CAST(payload AS BLOB)), 0) BETWEEN ? AND ? THEN CASE WHEN json_valid(payload) THEN json_extract(payload, '$.provider') END END AS provider,
          CASE WHEN COALESCE(LENGTH(CAST(payload AS BLOB)), 0) BETWEEN ? AND ? THEN CASE WHEN json_valid(payload) THEN json_extract(payload, '$.checkpointEventSeq') END END AS checkpointEventSeq,
          created_at AS createdAt
          FROM message_order AS ordered JOIN messages AS m ON m.id = ordered.message_key WHERE ordered.scope = ? AND ordered.ordinal BETWEEN ? AND ? ORDER BY ordered.ordinal`)
          .all(MAX_INLINE_MESSAGE_BYTES, MAX_INLINE_MESSAGE_BYTES / 2, MAX_INLINE_MESSAGE_BYTES, MAX_INLINE_MESSAGE_BYTES / 2,
            MAX_INLINE_MESSAGE_BYTES, MAX_INLINE_MESSAGE_BYTES + 1, MAX_MESSAGE_PAGE_BYTES,
            MAX_INLINE_MESSAGE_BYTES + 1, MAX_MESSAGE_PAGE_BYTES,
            MAX_INLINE_MESSAGE_BYTES + 1, MAX_MESSAGE_PAGE_BYTES,
            conversationId, firstRow, lastRow);
        if (!rows.some((row) => row.id === match.id)) return { matchId: null, messages: [], messagePage: null };
        let messages = rows.map(({ messageRowId, bodySuffix, payloadBytes, runId, provider, checkpointEventSeq, ...row }) => {
          const payloadOmitted = payloadBytes > MAX_INLINE_MESSAGE_BYTES;
          const prefix = Buffer.isBuffer(row.body) ? decodeMessagePrefix(row.body) : row.body;
          const suffix = Buffer.isBuffer(bodySuffix) ? decodeMessageSuffix(bodySuffix) : "";
          return { ...row, body: bodySuffix ? `${prefix}\n[Middle text omitted from this page]\n${suffix}` : prefix,
            payload: payloadOmitted ? { runId, provider, checkpointEventSeq } : parseJson(row.payload, null),
            searchOrder: messageRowId, ...(bodySuffix ? { findExcerpt: true } : {}),
            ...(payloadOmitted ? { payloadOmitted: true } : {}) };
        });
        // The matched message itself may be larger than the context budget.
        // Return an explicit excerpt containing the match, then let normal
        // paging retrieve its complete body when the reader asks for it.
        const matchedMessage = messages.find((message) => message.id === match.id);
        if (matchedMessage && matchedMessage.findExcerpt) {
          const start = Math.max(0, result.matchByteOffset - 7_500);
          const length = Math.min(match.bodyBytes - start, 15_000 + Buffer.byteLength(query));
          const bytes = bodyChunk.get(start + 1, length, conversationId, match.id).bytes;
          matchedMessage.body = `${start ? "[Earlier text omitted from Find result]\n" : ""}${decodeMessageWindow(bytes)}${start + bytes.length < match.bodyBytes ? "\n[Later text omitted from Find result]" : ""}`;
        }
        let serializedBytes = 2 + messages.reduce((bytes, message) => bytes + Buffer.byteLength(JSON.stringify(message)) + 1, 0);
        while (serializedBytes > maxBytes && messages.length > 1) {
          // Drop the farther edge and preserve a contiguous page around match.
          const removed = messages.findIndex((message) => message.id === match.id) >= messages.length / 2
            ? messages.shift() : messages.pop();
          serializedBytes -= Buffer.byteLength(JSON.stringify(removed)) + 1;
        }
        const olderCount = db.prepare("SELECT COUNT(*) AS count FROM message_order AS ordered JOIN messages AS m ON m.id = ordered.message_key WHERE ordered.scope = ? AND ordered.ordinal < ?").get(conversationId, messages[0].searchOrder).count;
        const newerCount = db.prepare("SELECT COUNT(*) AS count FROM message_order AS ordered JOIN messages AS m ON m.id = ordered.message_key WHERE ordered.scope = ? AND ordered.ordinal > ?").get(conversationId, messages.at(-1).searchOrder).count;
        return { matchId: match.id, messages, messagePage: {
          hasMore: olderCount > 0, olderCount, hasLater: newerCount > 0, newerCount,
          total: olderCount + messages.length + newerCount, beforeId: messages[0].id, limit: 200,
        } };
      } finally { activeMessageFinds -= 1; }
    },
    getMessageBodyChunk(conversationId, messageId, offset) {
      assertConversationNotDeleting(db, conversationId);
      // Find returns excerpts for oversized matches. Read the full body by
      // identity in fixed-size byte sections. SQLite's TEXT LENGTH and SUBSTR
      // stop at an embedded NUL and count characters from the start of a row.
      // BLOB offsets include NULs and make consecutive reads linear in size.
      const row = db.prepare(`SELECT id, LENGTH(COALESCE(CAST(body AS BLOB), X'')) AS totalBytes,
        SUBSTR(COALESCE(CAST(body AS BLOB), X''), ? + 1, 65540) AS body
        FROM messages WHERE conversation_id = ? AND id = ?`).get(offset, conversationId, messageId);
      if (!row) return null;
      if (offset > row.totalBytes) throw databaseError(400, "Message body offset is invalid");
      const bytes = Buffer.from(row.body);
      let start = 0;
      while (start < Math.min(4, bytes.length) && bytes[start] >= 0x80 && bytes[start] < 0xc0) start += 1;
      if (start === 4 || (start === bytes.length && offset < row.totalBytes)) throw databaseError(400, "Message body offset is invalid");
      let end = Math.min(bytes.length, start + 65536);
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let body;
      while (end > start) {
        try { body = decoder.decode(bytes.subarray(start, end)); break; }
        catch { end -= 1; }
      }
      if (body === undefined && bytes.length > start) throw databaseError(400, "Message body is not valid UTF-8");
      const actualOffset = offset + start;
      const nextOffset = offset + end;
      return { id: row.id, body: body ?? "", offset: actualOffset, nextOffset, totalBytes: row.totalBytes, hasMore: nextOffset < row.totalBytes };
    },
    addMessage(input, { omissionRunId } = {}) {
      const message = { id: input.id ?? randomUUID(), createdAt: input.createdAt ?? now(), ...input };
      const insert = () => withinRetainedBudget(() => {
        const inserted = db.prepare("INSERT INTO messages (id, conversation_id, role, kind, body, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(message.id, message.conversationId, message.role, message.kind ?? "text", message.body ?? "", JSON.stringify(message.payload ?? null), message.createdAt);
      // Clamp instead of overwrite: a message must never move the
      // conversation's updated_at backwards in sidebar and search ordering.
      db.prepare("UPDATE conversations SET updated_at = MAX(updated_at, ?) WHERE id = ?").run(message.createdAt, message.conversationId);
        return { ...message, searchOrder: Number(inserted.lastInsertRowid) };
      }, retainedReserveBytes);
      if (!omissionRunId) return insert();
      return db.transaction(() => {
        try { return insert(); }
        catch (error) {
          if (error.statusCode !== 507) throw error;
          this.updateRun(omissionRunId, { transcriptOmitted: true });
          return null;
        }
      }).immediate();
    },
    upsertMessage(input, { omissionRunId } = {}) {
      const message = { id: input.id ?? randomUUID(), createdAt: input.createdAt ?? now(), ...input };
      const upsert = () => withinRetainedBudget(() => {
        db.prepare(`INSERT INTO messages (id, conversation_id, role, kind, body, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET role = excluded.role, kind = excluded.kind, body = excluded.body, payload = excluded.payload`)
        .run(message.id, message.conversationId, message.role, message.kind ?? "text", message.body ?? "", JSON.stringify(message.payload ?? null), message.createdAt);
      // Assistant checkpoints reuse one stable createdAt across the whole
      // stream, so the plain overwrite could regress updated_at after a newer
      // tool/user message advanced it; clamp to the newer timestamp instead.
      db.prepare("UPDATE conversations SET updated_at = MAX(updated_at, ?) WHERE id = ?").run(message.createdAt, message.conversationId);
        return hydratePayload(db.prepare(`SELECT search_order AS searchOrder, id, conversation_id AS conversationId, role, kind, body, payload, created_at AS createdAt
        FROM messages WHERE id = ?`).get(message.id));
      });
      if (!omissionRunId) return upsert();
      return db.transaction(() => {
        try { return upsert(); }
        catch (error) {
          if (error.statusCode !== 507) throw error;
          this.updateRun(omissionRunId, { transcriptOmitted: true });
          return null;
        }
      }).immediate();
    },
    createRun(input) {
      const insert = db.transaction(() => {
        if (db.prepare("SELECT deleting FROM conversations WHERE id = ?").get(input.conversationId)?.deleting) {
          throw databaseError(409, "Archived conversation deletion is in progress");
        }
        if (migrationPending(db)) throw databaseError(507, "Retained history is being migrated; retry when capacity is available");
        const settings = this.getSettings();
        if (db.prepare("SELECT COUNT(*) AS count FROM runs WHERE status = 'queued'").get().count >= settings.maxQueuedRuns) {
          throw databaseError(429, "Run queue is full; stop a queued run or wait for capacity");
        }
        if (retainedBytes(db) >= settings.maxRetainedMiB * 1024 * 1024) {
          throw databaseError(507, "Retained history is full; archive conversations, then delete selected archived chats or clean up older history");
        }
        const run = { id: randomUUID(), status: "queued", createdAt: now(), ...input };
        const worktreePath = run.worktreePath ?? this.getConversation(run.conversationId)?.worktreePath;
        if (!worktreePath) throw databaseError(400, "Run worktree path is required");
        db.prepare(`INSERT INTO runs (id, conversation_id, worktree_path, provider, model, reasoning_effort, approval_policy, prompt, status, provider_session_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(run.id, run.conversationId, worktreePath, run.provider, run.model ?? "", run.reasoningEffort ?? "medium", run.approvalPolicy, run.prompt, run.status, run.providerSessionId ?? null, run.createdAt);
        if (retainedBytes(db) > settings.maxRetainedMiB * 1024 * 1024 - retainedReserveBytes) {
          throw databaseError(507, "Retained history is full; archive conversations, then delete selected archived chats or clean up older history");
        }
        return this.getRun(run.id);
      });
      return insert.immediate();
    },
    submitRun(input, prompt) {
      const submit = db.transaction(() => {
        const run = this.createRun(input);
        const message = this.addMessage({ conversationId: input.conversationId, role: "user", kind: "text", body: prompt });
        return { run, message };
      });
      return withinRetainedBudget(() => submit.immediate());
    },
    getRun(id) {
      return db.prepare(`SELECT id, conversation_id AS conversationId, worktree_path AS worktreePath, provider, model, reasoning_effort AS reasoningEffort, approval_policy AS approvalPolicy,
        prompt, status, pid, provider_session_id AS providerSessionId, created_at AS createdAt, started_at AS startedAt,
        finished_at AS finishedAt, exit_code AS exitCode, error, cost_usd AS costUsd, input_tokens AS inputTokens,
        output_tokens AS outputTokens, recovery_class AS recoveryClass, recovery_decision AS recoveryDecision, transcript_omitted AS transcriptOmitted FROM runs WHERE id = ?`).get(id);
    },
    listRuns(conversationId, limit = 200) {
      const boundedLimit = Math.max(1, Math.min(500, Number(limit) || 200));
      return db.prepare(`SELECT id, conversation_id AS conversationId, worktree_path AS worktreePath, provider, model, reasoning_effort AS reasoningEffort, approval_policy AS approvalPolicy,
        prompt, status, pid, provider_session_id AS providerSessionId, created_at AS createdAt, started_at AS startedAt,
        finished_at AS finishedAt, exit_code AS exitCode, error, cost_usd AS costUsd, input_tokens AS inputTokens,
        output_tokens AS outputTokens, recovery_class AS recoveryClass, recovery_decision AS recoveryDecision, transcript_omitted AS transcriptOmitted FROM runs WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(conversationId, boundedLimit);
    },
    listUnresolvedInterruptedRuns(conversationId) {
      return db.prepare(`SELECT id, conversation_id AS conversationId, worktree_path AS worktreePath, provider, model, reasoning_effort AS reasoningEffort, approval_policy AS approvalPolicy,
        prompt, status, pid, provider_session_id AS providerSessionId, created_at AS createdAt, started_at AS startedAt,
        finished_at AS finishedAt, exit_code AS exitCode, error, cost_usd AS costUsd, input_tokens AS inputTokens,
        output_tokens AS outputTokens, recovery_class AS recoveryClass, recovery_decision AS recoveryDecision
        FROM runs WHERE conversation_id = ? AND status = 'interrupted' AND recovery_decision IS NULL ORDER BY created_at, rowid`).all(conversationId);
    },
    findUnresolvedInterruptedRun(conversationId) {
      return db.prepare(`SELECT id, conversation_id AS conversationId, worktree_path AS worktreePath, provider, model, reasoning_effort AS reasoningEffort, approval_policy AS approvalPolicy,
        prompt, status, pid, provider_session_id AS providerSessionId, created_at AS createdAt, started_at AS startedAt,
        finished_at AS finishedAt, exit_code AS exitCode, error, cost_usd AS costUsd, input_tokens AS inputTokens,
        output_tokens AS outputTokens, recovery_class AS recoveryClass, recovery_decision AS recoveryDecision
        FROM runs WHERE conversation_id = ? AND status = 'interrupted' AND recovery_decision IS NULL ORDER BY created_at, rowid LIMIT 1`).get(conversationId);
    },
    listUnresolvedInterruptedRunsForWorktree(worktreePath) {
      if (migrationJob(db, "recovery")) throw databaseError(503, "Recovery ownership is being indexed; retry shortly");
      return db.prepare(`SELECT runs.id, runs.conversation_id AS conversationId, runs.worktree_path AS worktreePath, runs.provider, runs.model,
        runs.reasoning_effort AS reasoningEffort, runs.approval_policy AS approvalPolicy, runs.prompt, runs.status, runs.pid,
        runs.provider_session_id AS providerSessionId, runs.created_at AS createdAt, runs.started_at AS startedAt,
        runs.finished_at AS finishedAt, runs.exit_code AS exitCode, runs.error, runs.cost_usd AS costUsd,
        runs.input_tokens AS inputTokens, runs.output_tokens AS outputTokens, runs.recovery_class AS recoveryClass,
        runs.recovery_decision AS recoveryDecision
        FROM recovery_scope AS scope JOIN runs ON runs.id = scope.run_id
        WHERE (scope.worktree_path = ? OR scope.worktree_path IS NULL) AND runs.status = 'interrupted' AND runs.recovery_decision IS NULL
        ORDER BY CASE WHEN scope.worktree_path IS NULL THEN 0 ELSE 1 END, runs.created_at, runs.rowid`).all(worktreePath);
    },
    findUnresolvedInterruptedRunForWorktree(worktreePath) {
      if (migrationJob(db, "recovery")) throw databaseError(503, "Recovery ownership is being indexed; retry shortly");
      return db.prepare(`SELECT runs.id, runs.conversation_id AS conversationId, runs.worktree_path AS worktreePath, runs.provider, runs.model,
        runs.reasoning_effort AS reasoningEffort, runs.approval_policy AS approvalPolicy, runs.prompt, runs.status, runs.pid,
        runs.provider_session_id AS providerSessionId, runs.created_at AS createdAt, runs.started_at AS startedAt,
        runs.finished_at AS finishedAt, runs.exit_code AS exitCode, runs.error, runs.cost_usd AS costUsd,
        runs.input_tokens AS inputTokens, runs.output_tokens AS outputTokens, runs.recovery_class AS recoveryClass,
        runs.recovery_decision AS recoveryDecision
        FROM recovery_scope AS scope JOIN runs ON runs.id = scope.run_id
        WHERE (scope.worktree_path = ? OR scope.worktree_path IS NULL) AND runs.status = 'interrupted' AND runs.recovery_decision IS NULL
        ORDER BY CASE WHEN scope.worktree_path IS NULL THEN 0 ELSE 1 END, runs.created_at, runs.rowid LIMIT 1`).get(worktreePath);
    },
    getLaunchHandshake(runId) {
      return readLaunchHandshake(launchDirectory, runId);
    },
    // Crash-consistent restart reconciliation: queued/running rows belong to a
    // dead runtime, so none of them can ever finish under this process. Mark
    // them "interrupted" with a best-effort process classification instead of
    // failing them outright, and leave the continuation decision to the
    // operator so uncertain side effects are never silently retried.
    reconcileInterruptedRuns({ probeAlive = defaultProbeRun } = {}) {
      const finishedAt = now();
      const counts = {};
      // Pending rows are selected inside the transaction and each update is
      // conditional on the row still being queued/running/launching: the
      // runtime that still owns a run can finish it between the selection and
      // the update, and that terminal state must never be overwritten with
      // "interrupted". The transaction runs in immediate mode: a deferred
      // transaction would upgrade from a read snapshot to a write while
      // another runtime commits, failing with SQLITE_BUSY_SNAPSHOT and
      // aborting startup.
      const reconcile = db.transaction(() => {
        // A legacy database may contain far more pending rows than the current
        // queue limit. Commit bounded batches so a crash preserves progress
        // and startup never materializes the entire backlog in JavaScript.
        const pending = db.prepare("SELECT id, status, pid FROM runs WHERE status IN ('queued', 'running', 'launching') ORDER BY rowid LIMIT 500").all();
        for (const run of pending) {
          let classification = "unknown";
          let pid = run.pid ?? null;
          if (run.status === "queued") classification = "never-started";
          else if (run.status === "launching") {
            // Crash-safe launch handshake: the provider is only authorized to
            // run AFTER the row durably reaches 'running' with a pid, so a row
            // still in 'launching' provably never started side effects. The
            // wrapper's self-recorded handshake pid is adopted for the record
            // (the wrapper exits on its own once its stdin closes), so the run
            // is resolvable by an explicit decision instead of being
            // permanently gated as an unverifiable tree.
            classification = "never-started";
            const handshake = readLaunchHandshake(launchDirectory, run.id);
            if (handshake) {
              pid = handshake.pid;
              // The identity is now durably adopted into the row. The sweep
              // below removes its no-longer-needed marker after commit.
            }
          }
          else if (run.pid != null) {
            const handshake = readLaunchHandshake(launchDirectory, run.id);
            classification = handshake?.completed === true
              && handshake.authorized === true
              && handshake.pid === run.pid
              ? "exited"
              : normalizeProbeResult(probeAlive(run.pid, handshake, run));
          }
          const result = db.prepare("UPDATE runs SET status = 'interrupted', pid = ?, finished_at = ?, recovery_class = ? WHERE id = ? AND status IN ('queued', 'running', 'launching')")
            .run(pid, finishedAt, classification, run.id);
          if (!result.changes) continue;
          counts[classification] = (counts[classification] ?? 0) + 1;
        }
        return pending.length;
      });
      while (reconcile.immediate()) { /* Each committed batch is recoverable after interruption. */ }
      // Preserve unresolved live/unknown ownership evidence across repeated
      // restarts; sweep adopted and stale records without retaining every run
      // ID or directory entry in memory.
      sweepLaunchHandshakes(launchDirectory, db);
      const count = Object.values(counts).reduce((sum, classified) => sum + classified, 0);
      return { count, counts };
    },
    // Records the operator's explicit continuation decision exactly once.
    // Discard fails the run; resume/retry keep it interrupted for the record
    // while the replacement run carries the work forward. The distinct
    // unverifiable decision preserves that an operator explicitly cleared a
    // legacy row whose process ownership could not be reconstructed.
    resolveInterruptedRun(id, decision) {
      const run = this.getRun(id);
      if (!run || !["discard", "discard-unverifiable", "resume-session", "retry"].includes(decision)) return null;
      if (run.status !== "interrupted" || run.recoveryDecision) return null;
      const discarded = decision === "discard" || decision === "discard-unverifiable";
      const status = discarded ? "failed" : "interrupted";
      const error = decision === "discard-unverifiable"
        ? "Discarded after explicit acknowledgement of unverifiable legacy recovery"
        : decision === "discard" ? "Discarded after restart recovery review" : null;
      const stamp = now();
      const resolve = db.transaction(() => {
        const result = db.prepare("UPDATE runs SET recovery_decision = ?, status = ?, error = ?, finished_at = ? WHERE id = ? AND status = 'interrupted' AND recovery_decision IS NULL")
          .run(decision, status, error, stamp, id);
        if (!result.changes) return false;
        writeCriticalAudit(`agent.run.recovery.${decision}`, { target: id, conversationId: run.conversationId, recoveryClass: run.recoveryClass });
        return true;
      });
      if (!resolve.immediate()) return null;
      return this.getRun(id);
    },
    beginInterruptedRunRecovery(id, decision, { providerSessionId } = {}) {
      if (!["resume-session", "retry"].includes(decision)) return null;
      if (providerSessionId != null && (typeof providerSessionId !== "string" || Buffer.byteLength(providerSessionId) > 4096)) {
        throw databaseError(400, "Provider session id is invalid");
      }
      const recover = db.transaction(() => {
        const interrupted = this.getRun(id);
        if (!interrupted || interrupted.status !== "interrupted" || interrupted.recoveryDecision) return null;
        const result = db.prepare("UPDATE runs SET recovery_decision = ?, finished_at = ? WHERE id = ? AND status = 'interrupted' AND recovery_decision IS NULL")
          .run(decision, now(), id);
        if (!result.changes) return null;
        const conversation = this.getConversation(interrupted.conversationId);
        if (conversation?.provider === interrupted.provider) {
          if (decision === "retry") this.updateConversation(interrupted.conversationId, { providerSessionId: null });
          else if (providerSessionId && conversation.providerSessionId !== providerSessionId) this.updateConversation(interrupted.conversationId, { providerSessionId });
        }
        const run = this.createRun({
          conversationId: interrupted.conversationId,
          worktreePath: interrupted.worktreePath,
          provider: interrupted.provider,
          model: interrupted.model,
          reasoningEffort: interrupted.reasoningEffort,
          approvalPolicy: interrupted.approvalPolicy,
          prompt: interrupted.prompt,
          providerSessionId: decision === "resume-session" ? providerSessionId : null,
        });
        writeCriticalAudit(`agent.run.recovery.${decision}`, { target: run.id, recoveredFrom: id, conversationId: interrupted.conversationId, recoveryClass: interrupted.recoveryClass });
        return { interrupted: this.getRun(id), run, conversation: this.getConversation(interrupted.conversationId) };
      });
      return recover.immediate();
    },
    updateRun(id, patch) {
      const { criticalFields, criticalValues, optionalFields, optionalValues } = runPatchAssignments(patch);
      const criticalUpdate = () => { if (criticalFields.length) db.prepare(`UPDATE runs SET ${criticalFields.join(", ")} WHERE id = ?`).run(...criticalValues, id); };
      const optionalUpdate = () => { if (optionalFields.length) withinRetainedBudget(() => db.prepare(`UPDATE runs SET ${optionalFields.join(", ")} WHERE id = ?`).run(...optionalValues, id)); };
      // A mixed update commits its state even if optional usage telemetry is
      // refused. Usage alone reports the quota error to its caller.
      if (criticalFields.length && optionalFields.length) {
        db.transaction(() => {
          criticalUpdate();
          try { optionalUpdate(); }
          catch (error) { if (error.statusCode !== 507) throw error; }
        }).immediate();
      } else {
        criticalUpdate();
        optionalUpdate();
      }
      return this.getRun(id);
    },
    finishRun(id, patch, transcriptMessage = null) {
      const finish = db.transaction(() => {
        let message = null;
        if (transcriptMessage) {
          try { message = this.upsertMessage(transcriptMessage); }
          catch (error) { if (error.statusCode !== 507) throw error; }
        }
        // The terminal state and the evidence of its omitted final checkpoint
        // must survive the same commit, including a crash immediately after it.
        const run = this.updateRun(id, message || !transcriptMessage ? patch : { ...patch, transcriptOmitted: true });
        writeCriticalAudit(`agent.run.${patch.status}`, { target: id, exitCode: patch.exitCode, error: patch.error || undefined });
        return { run, message };
      });
      return finish.immediate();
    },
    appendRunEvent(runId, type, payload) {
      if (migrationJob(db, "events")) return null;
      const commit = db.transaction(() => {
        const seq = db.prepare("SELECT COALESCE((SELECT last_seq FROM run_event_usage WHERE run_id = ?), 0) + 1 AS seq").get(runId).seq;
        const createdAt = now();
        const serialized = serializePayload(payload);
        const result = db.prepare("INSERT INTO run_events (run_id, seq, type, payload, created_at) VALUES (?, ?, ?, ?, ?)").run(runId, seq, type, serialized, createdAt);
        db.prepare(`INSERT INTO run_event_usage (run_id, bytes, last_seq) VALUES (?, ?, ?)
          ON CONFLICT(run_id) DO UPDATE SET bytes = bytes + excluded.bytes, last_seq = excluded.last_seq`).run(runId, Buffer.byteLength(serialized) + RETAINED_ROW_OVERHEAD_BYTES, seq);
        // Replay is a bounded tail. Durable transcript checkpoints and run
        // rows remain separate, so pruning does not erase recovery evidence.
        let bytes = db.prepare("SELECT bytes FROM run_event_usage WHERE run_id = ?").get(runId).bytes;
        const old = db.prepare(`SELECT id, seq, COALESCE(LENGTH(CAST(payload AS BLOB)), 0) + ${RETAINED_ROW_OVERHEAD_BYTES} AS bytes FROM run_events WHERE run_id = ? ORDER BY seq LIMIT 1`);
        const remove = db.prepare("DELETE FROM run_events WHERE id = ?");
        while (bytes > MAX_RUN_EVENT_RETAINED_BYTES || old.get(runId)?.seq <= seq - 2_000) {
          const row = old.get(runId);
          if (!row) break;
          remove.run(row.id);
          bytes -= row.bytes;
        }
        db.prepare("UPDATE run_event_usage SET bytes = ? WHERE run_id = ?").run(bytes, runId);
        return { id: Number(result.lastInsertRowid), runId, seq, type, payload: parseJson(serialized, null), createdAt };
      });
      try { return withinRetainedBudget(() => commit.immediate()); }
      catch (error) {
        if (error.statusCode !== 507) { throw error; }
        return null;
      }
    },
    appendRunEventWithMessage(runId, type, payload, transcriptMessage) {
      const commit = db.transaction(() => {
        const event = this.appendRunEvent(runId, type, payload);
        let message = null;
        try {
          message = this.upsertMessage({ ...transcriptMessage, payload: {
            ...transcriptMessage.payload, ...(event ? { checkpointEventSeq: event.seq } : {}),
          } });
        } catch (error) { if (error.statusCode !== 507) throw error; }
        if (!message) this.updateRun(runId, { transcriptOmitted: true });
        return { event, message };
      });
      return commit.immediate();
    },
    listRunEvents(runId, after = 0) {
      if (migrationJob(db, "events")) return [];
      const cursor = Number.isSafeInteger(Number(after)) && Number(after) >= 0 ? Number(after) : 0;
      return db.prepare("SELECT id, run_id AS runId, seq, type, payload, created_at AS createdAt FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT 2000")
        .all(runId, cursor).map(hydratePayload);
    },
    trustProject(projectId, projectPath) {
      withinRetainedBudget(() => {
        db.prepare("INSERT INTO trusted_projects (project_id, project_path, trusted_at) VALUES (?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET project_path = excluded.project_path, trusted_at = excluded.trusted_at")
          .run(projectId, projectPath, now());
        writeAudit("project.trusted", { target: projectId, path: projectPath });
      });
    },
    untrustProject(projectId) { db.transaction(() => {
      const result = db.prepare("DELETE FROM trusted_projects WHERE project_id = ?").run(projectId);
      if (result.changes) writeCriticalAudit("project.untrusted", { target: projectId });
    }).immediate(); },
    isProjectTrusted(projectId, projectPath) {
      const row = db.prepare("SELECT project_path FROM trusted_projects WHERE project_id = ?").get(projectId);
      return row?.project_path === projectPath;
    },
    listTrustedProjects() { return db.prepare("SELECT project_id AS projectId, project_path AS projectPath, trusted_at AS trustedAt FROM trusted_projects ORDER BY trusted_at DESC").all(); },
    audit(action, details = {}) {
      try {
        // Migration pauses optional history, but reconciliation and deletion
        // still need audit evidence. Triggers account for writes before or
        // after each retained scan cursor without double counting.
        if (migrationPending(db)) db.transaction(() => {
          reserveRecoveryHeadroom(db, undefined, true);
          writeAudit(action, details);
          reserveRecoveryHeadroom(db);
        }).immediate();
        else withinRetainedBudget(() => writeAudit(action, details));
        return true;
      } catch (error) {
        // Optional telemetry can be dropped at quota or during archive
        // cleanup. Material actions use auditAdmission or a critical audit.
        if (error.statusCode !== 507 && !(deletionWorkers.size && ["SQLITE_BUSY", "SQLITE_LOCKED"].includes(error.code))) throw error;
        return false;
      }
    },
    // Admission records are committed before an external side effect. They
    // spend ordinary retained capacity and can refuse work at the quota edge.
    auditAdmission(action, details = {}) {
      withinRetainedBudget(() => writeAudit(action, details));
    },
    auditCritical(action, details = {}) {
      writeCriticalAudit(action, details);
    },
    async auditRequired(action, details = {}) {
      while (true) {
        if (closing) throw databaseError(503, "Runtime closed before required audit could be recorded");
        try {
          writeCriticalAudit(action, details);
          return;
        } catch (error) {
          if (!deletionWorkers.size || !["SQLITE_BUSY", "SQLITE_LOCKED"].includes(error.code)) throw error;
          await new Promise((resolve) => deletionIdleWaiters.add(resolve));
        }
      }
    },
    listAudit(limit = 100) {
      const bounded = Math.max(1, Math.min(500, Number(limit) || 100));
      return db.prepare("SELECT id, action, target, details, created_at AS createdAt FROM audit_log ORDER BY id DESC LIMIT ?").all(bounded).map(hydrateDetails);
    },
    listTemplates() { return db.prepare("SELECT id, title, prompt, created_at AS createdAt FROM prompt_templates ORDER BY title").all(); },
    saveTemplate(input) {
      if (retainedBytes(db) >= this.getSettings().maxRetainedMiB * 1024 * 1024) {
        throw databaseError(507, "Retained history is full; archive conversations, then delete selected archived chats or clean up older history");
      }
      const id = input.id ?? randomUUID();
      withinRetainedBudget(() => db.prepare("INSERT INTO prompt_templates (id, title, prompt, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, prompt = excluded.prompt")
        .run(id, input.title.trim(), input.prompt.trim(), now()));
      return db.prepare("SELECT id, title, prompt, created_at AS createdAt FROM prompt_templates WHERE id = ?").get(id);
    },
    deleteTemplate(id) { return db.prepare("DELETE FROM prompt_templates WHERE id = ?").run(id).changes > 0; },
    search(query, limit = 40) {
      if (typeof query !== "string" || !query.trim() || Buffer.byteLength(query) > SEARCH_QUERY_BYTES) {
        throw databaseError(400, `Search query must contain 1 to ${SEARCH_QUERY_BYTES} UTF-8 bytes`);
      }
      const boundedLimit = Math.max(1, Math.min(40, Number.isInteger(limit) ? limit : 40));
      const needle = `%${query.trim().replace(/[\\%_]/g, "\\$&")}%`;
      // The palette only consumes conversation identities. Scan a fixed recent
      // window and skip oversized bodies before LIKE can materialize them.
      // Conversation Find remains available for the complete retained text.
      const fields = `c.id, c.project_id AS projectId, c.worktree_id AS worktreeId,
        substr(c.title, 1, 256) AS title, substr(c.provider, 1, 64) AS provider,
        substr(c.worktree_path, 1, 512) AS worktreePath, c.updated_at AS updatedAt`;
      const safeIdentity = `octet_length(c.id) <= 256 AND octet_length(c.project_id) <= 256
        AND octet_length(c.worktree_id) <= 256 AND octet_length(c.updated_at) <= 64
        AND octet_length(c.title) <= ${SEARCH_MESSAGE_BYTES}
        AND octet_length(c.provider) <= 4096 AND octet_length(c.worktree_path) <= 8192`;
      // This lookup is maintained when deletion is marked, before the
      // potentially long physical cleanup. Hidden rows cannot consume the
      // bounded candidate window or force a scan through an archive backlog.
      const visible = db.prepare(`SELECT source_rowid AS rowid FROM search_visible_conversations
        ORDER BY source_rowid DESC LIMIT ${SEARCH_CANDIDATES}`).all();
      const byTitle = db.prepare(`WITH recent AS MATERIALIZED
        (SELECT source_rowid AS rowid FROM search_recent_titles
          ORDER BY updated_at DESC, source_rowid DESC LIMIT ${SEARCH_CANDIDATES})
        SELECT ${fields} FROM recent JOIN conversations AS c ON c.rowid = recent.rowid
        WHERE c.deleting = 0 AND ${safeIdentity}
          AND c.title LIKE ? ESCAPE '\\'`).all(needle);
      // The 256 newest visible conversation heads cover the 256 newest
      // visible messages: an omitted head already has 256 newer heads ahead
      // of it. This keeps old, active chats eligible after many new chats.
      const scopes = db.prepare(`WITH recent_heads AS MATERIALIZED
        (SELECT source_rowid FROM search_message_heads
          ORDER BY latest_ordinal DESC LIMIT ${SEARCH_CANDIDATES})
        SELECT c.id FROM recent_heads AS heads
        JOIN conversations AS c ON c.rowid = heads.source_rowid
        WHERE c.deleting = 0 AND octet_length(c.id) <= 256
        LIMIT ${SEARCH_CANDIDATES}`).all();
      const nextOrdinal = db.prepare(`SELECT ordinal FROM message_order WHERE scope = ? AND ordinal < ?
        ORDER BY ordinal DESC LIMIT 1`);
      const heads = scopes.map(({ id }) => ({ id, ordinal: nextOrdinal.get(id, Number.MAX_SAFE_INTEGER)?.ordinal ?? 0 }));
      const ordinals = [];
      while (ordinals.length < SEARCH_CANDIDATES) {
        let newest;
        for (const head of heads) if (head.ordinal && (!newest || head.ordinal > newest.ordinal)) newest = head;
        if (!newest) break;
        ordinals.push(newest.ordinal);
        newest.ordinal = nextOrdinal.get(newest.id, newest.ordinal)?.ordinal ?? 0;
      }
      const byMessage = ordinals.length ? db.prepare(`SELECT DISTINCT ${fields} FROM messages AS m
        JOIN conversations AS c ON c.id = m.conversation_id
        WHERE m.rowid IN (${ordinals.map(() => "?").join(",")})
          AND c.deleting = 0 AND ${safeIdentity} AND octet_length(m.body) <= ${SEARCH_MESSAGE_BYTES}
          AND m.body LIKE ? ESCAPE '\\'`).all(...ordinals, needle) : [];
      const matched = [...new Map([...byTitle, ...byMessage].map((row) => [row.id, row])).values()];
      const conversations = [];
      let responseBytes = 64;
      for (const { updatedAt, ...row } of matched.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
        if (conversations.length === boundedLimit) break;
        const bytes = Buffer.byteLength(JSON.stringify(row)) + 1;
        if (responseBytes + bytes > SEARCH_RESPONSE_BYTES) break;
        conversations.push(row);
        responseBytes += bytes;
      }
      const partial = matched.length > conversations.length || Boolean(migrationJob(db, "search-visible")
        || migrationJob(db, "search-titles")
        || migrationJob(db, "search-heads")
        || migrationJob(db, "messages")
        || (visible.length === SEARCH_CANDIDATES && db.prepare(`SELECT 1 FROM search_visible_conversations
          WHERE source_rowid < ? LIMIT 1`).get(visible.at(-1).rowid))
        || heads.some((head) => head.ordinal)
        || db.prepare(`SELECT 1 FROM messages WHERE rowid > ? LIMIT 1`).get(ordinals[0] ?? 0)
        || db.prepare(`SELECT 1 FROM messages WHERE rowid < ? LIMIT 1`).get(ordinals.at(-1) ?? 0)
        || db.prepare(`SELECT 1 FROM conversations WHERE rowid < ? LIMIT 1`).get(visible.at(-1)?.rowid ?? 0)
        || (ordinals.length && db.prepare(`SELECT 1 FROM messages WHERE rowid IN (${ordinals.map(() => "?").join(",")})
          AND octet_length(body) > ${SEARCH_MESSAGE_BYTES} LIMIT 1`).get(...ordinals))
        || db.prepare(`WITH recent AS MATERIALIZED
          (SELECT source_rowid AS rowid FROM search_visible_conversations
            ORDER BY source_rowid DESC LIMIT ${SEARCH_CANDIDATES})
          SELECT 1 FROM recent JOIN conversations AS c ON c.rowid = recent.rowid
          WHERE NOT (${safeIdentity}) LIMIT 1`).get());
      return { conversations, partial };
    },
  };
  return new Proxy(api, { get(target, key, receiver) {
    const member = Reflect.get(target, key, receiver);
    if (typeof member !== "function") return member;
    if (!maintenance || key === "close") return member.bind(receiver);
    if (key === "capacity") return () => {
      const disk = allocatedDatabaseUsage(storageFilename);
      return { ...maintenanceCapacity, migrationStatus: "maintenance", maintenanceError,
        availableForNewWorkBytes: 0, diskAllocatedBytes: disk.bytes,
        diskUsageStatus: disk.status === "unknown" ? "unknown" : "partial" };
    };
    if (key === "canLaunchRun") return () => false;
    if (key === "audit") return () => false;
    if (key === "auditRequired") return async (...args) => {
      if (maintenanceError) throw databaseError(503, `Archive maintenance recovery failed: ${maintenanceError}`);
      await new Promise((resolve) => deletionIdleWaiters.add(resolve));
      if (maintenanceError) throw databaseError(503, `Archive maintenance recovery failed: ${maintenanceError}`);
      if (closing) throw databaseError(503, "Runtime closed during archive maintenance");
      return receiver.auditRequired(...args);
    };
    return () => { throw databaseError(503, "Archive maintenance is running; retry shortly"); };
  } });
}

function boundedArchivedPage(rows, limit) {
  const preview = (value) => {
    const characters = Array.from(value);
    return characters.length > 256 ? `${characters.slice(0, 256).join("")}…` : value;
  };
  const conversations = [];
  let serializedBytes = 4096; // JSON wrapper and a maximum-length next cursor.
  for (const candidate of rows) {
    if (conversations.length === limit) break;
    const row = { ...candidate, title: preview(candidate.title), worktreePath: preview(candidate.worktreePath) };
    const rowBytes = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (serializedBytes + rowBytes > 256 * 1024) {
      if (!conversations.length) throw databaseError(507, "Archived history identity is too large to list safely");
      break;
    }
    conversations.push(row);
    serializedBytes += rowBytes;
  }
  const last = conversations.at(-1);
  return { conversations, nextCursor: rows.length > conversations.length
    ? Buffer.from(JSON.stringify([last.updatedAt, last.id])).toString("base64url") : null };
}

function openDataConnection(filename) {
  const db = new Database(filename);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}

function openRuntimeStorage(filename, storageFilename, runtimeLease) {
  let db;
  let leaseDb;
  try {
    // The companion lock survives the source close and shadow cutover. It is
    // also held before recovery examines interrupted file transitions.
    if (runtimeLease) {
      if (filename === ":memory:") throw new Error("A runtime lease requires a database file");
      leaseDb = new Database(`${storageFilename}.runtime-lease`);
      leaseDb.pragma("busy_timeout = 250");
      leaseDb.pragma("locking_mode = EXCLUSIVE");
      leaseDb.exec("BEGIN EXCLUSIVE; COMMIT;");
    }
    if (storageFilename !== ":memory:") {
      if (existsSync(archiveShadowPaths(storageFilename).state)) {
        throw new Error("Interrupted archive maintenance requires asynchronous startup recovery");
      }
      recoverArchiveShadow(storageFilename);
      const source = existsSync(storageFilename) ? lstatSync(storageFilename) : null;
      if (source && (source.nlink !== 1 || !source.isFile())) throw new Error("A runtime database must be a private regular file");
    }
    db = openDataConnection(filename);
    migrate(db);
    advanceMigrations(db);
    return { db, leaseDb };
  } catch (error) {
    db?.close();
    leaseDb?.close();
    if (runtimeLease && ["SQLITE_BUSY", "SQLITE_LOCKED"].includes(error?.code)) {
      const leaseError = new Error("Another Outright runtime already owns this database", { cause: error });
      leaseError.code = "OUTRIGHT_RUNTIME_LEASE_HELD";
      throw leaseError;
    }
    throw error;
  }
}

function runPatchAssignments(patch) {
  if (patch.providerSessionId != null && (typeof patch.providerSessionId !== "string" || Buffer.byteLength(patch.providerSessionId) > 4096)) {
    throw databaseError(400, "Provider session id is invalid");
  }
  const criticalFields = [];
  const criticalValues = [];
  const optionalFields = [];
  const optionalValues = [];
  for (const [key, column] of Object.entries({ status: "status", pid: "pid", providerSessionId: "provider_session_id", startedAt: "started_at", finishedAt: "finished_at", exitCode: "exit_code", error: "error", costUsd: "cost_usd", inputTokens: "input_tokens", outputTokens: "output_tokens", recoveryClass: "recovery_class", recoveryDecision: "recovery_decision", transcriptOmitted: "transcript_omitted" })) {
    if (patch[key] === undefined) continue;
    const optional = ["costUsd", "inputTokens", "outputTokens"].includes(key);
    (optional ? optionalFields : criticalFields).push(key === "transcriptOmitted" ? `${column} = MAX(${column}, ?)` : `${column} = ?`);
    (optional ? optionalValues : criticalValues).push(key === "transcriptOmitted" ? Number(Boolean(patch[key])) : patch[key]);
  }
  return { criticalFields, criticalValues, optionalFields, optionalValues };
}

// A marked archive is hidden from new work. Bounded rows are removed on the
// runtime connection; a giant legacy row is reclaimed in a shadow database
// while the primary stays available for unrelated work. Only the final
// cutover closes it behind the process lease.
function deleteArchivedInBatches(db, id, inFlight, { automatic = false, isClosing, filename, workers, lockGate, cutoverStatGate, copyGate, copyStepGate, copyPhase, currentDb, canMaintain, onWorkerStart, onWorkerReady, onWorkerExit, onWorkerRecoveryFailure }) {
  if (inFlight.has(id)) throw databaseError(409, "Archived conversation deletion is in progress");
  inFlight.add(id);
  const run = async () => {
    try {
      markArchivedForDeletion(db, id, automatic);
      while (true) {
        if (isClosing()) throw databaseError(503, "Runtime closed during archived conversation deletion; cleanup will resume on restart");
        db = currentDb();
        const result = await advanceArchiveDeletion(db, id,
          { filename, workers, lockGate, cutoverStatGate, copyGate, copyStepGate, copyPhase, canMaintain, onWorkerStart, onWorkerReady, onWorkerExit, onWorkerRecoveryFailure, isClosing });
        if (result) return result;
        await new Promise((resolve) => setImmediate(resolve));
      }
    } finally { inFlight.delete(id); }
  };
  return run();
}

async function advanceArchiveDeletion(db, id, { filename, workers, lockGate, cutoverStatGate, copyGate, copyStepGate, copyPhase, canMaintain, onWorkerStart, onWorkerReady, onWorkerExit, onWorkerRecoveryFailure, isClosing }) {
  const step = db.transaction(() => deleteArchivedBatch(db, id, filename)).immediate();
  if (step.done) { onWorkerExit(); return { deleted: 1, id }; }
  if (!step.oversized) return null;
  // The durable marker lets an active run or another cleanup finish before
  // this exclusive offline phase starts.
  if (workers.size || !canMaintain() || db.prepare("SELECT 1 FROM runs WHERE status IN ('launching', 'running') LIMIT 1").get()) {
    return { deleted: 0, deferred: true, id };
  }
  try { await deleteOversizedArchivedRow(filename, id, step.oversized, { workers, lockGate, cutoverStatGate, copyGate, copyStepGate, copyPhase, onWorkerStart, onWorkerReady, onWorkerExit, onWorkerRecoveryFailure }); }
  catch (error) {
    if (isClosing()) throw databaseError(503, "Runtime closed during archived conversation deletion; cleanup will resume on restart");
    if (["ARCHIVE_SNAPSHOT_CHANGED", "ARCHIVE_DEFERRED", "ARCHIVE_SOURCE_BUSY"].includes(error.code)) {
      return { deleted: 0, deferred: true, sourceBusy: error.code === "ARCHIVE_SOURCE_BUSY", id };
    }
    throw error;
  }
  return { deleted: 1, id };
}

function markArchivedForDeletion(db, id, automatic) {
  db.transaction(() => {
    const row = db.prepare("SELECT archived, pinned, deleting FROM conversations WHERE id = ?").get(id);
    if (!row) throw databaseError(404, "Conversation not found");
    if (!row.archived || (automatic && !row.deleting && row.pinned)
      || db.prepare(`SELECT 1 FROM runs WHERE conversation_id = ? AND (status IN ('queued', 'launching', 'running')
        OR (status = 'interrupted' AND recovery_decision IS NULL)) LIMIT 1`).get(id)) {
      throw databaseError(409, "Only archived conversations without active or unresolved recovery work can be deleted");
    }
    db.prepare("UPDATE conversations SET deleting = 1 WHERE id = ?").run(id);
  }).immediate();
}

function deleteArchivedBatch(db, id, filename) {
  const sources = [
    [`SELECT events.id, COALESCE(octet_length(events.payload), 0) + ${RETAINED_ROW_OVERHEAD_BYTES} AS bytes FROM run_events AS events
      JOIN runs ON runs.id = events.run_id WHERE runs.conversation_id = ? LIMIT 64`, "run_events"],
    [`SELECT id, COALESCE(octet_length(body), 0) + COALESCE(octet_length(payload), 0) + ${RETAINED_ROW_OVERHEAD_BYTES} AS bytes
      FROM messages WHERE conversation_id = ? LIMIT 64`, "messages"],
    [`SELECT id, ${retainedSizeExpression(RUN_RETAINED_FIELDS)} AS bytes
      FROM runs WHERE conversation_id = ? LIMIT 64`, "runs"],
  ];
  for (const [query, table] of sources) {
    const rows = db.prepare(query).all(id);
    if (!rows.length) continue;
    const remove = db.prepare(`DELETE FROM ${table} WHERE id = ?`);
    let bytes = 0;
    for (const row of rows) {
      if (!bytes && row.bytes > 256 * 1024 && filename !== ":memory:") {
        return { oversized: { table, rowId: row.id } };
      }
      if (bytes && bytes + row.bytes > 256 * 1024) break;
      remove.run(row.id);
      bytes += row.bytes;
    }
    return { done: false };
  }
  const deleted = db.prepare("DELETE FROM conversations WHERE id = ? AND deleting = 1").run(id).changes;
  if (deleted) {
    reserveRecoveryHeadroom(db, undefined, true);
    db.prepare("INSERT INTO audit_log (action, target, details, created_at) VALUES (?, ?, ?, ?)")
      .run("retention.archived.deleted", id, "{}", now());
    trimAudit(db);
    reserveRecoveryHeadroom(db);
  }
  return { done: true };
}

function deleteOversizedArchivedRow(filename, conversationId, oversized, lifecycle) {
  const { workers, lockGate, cutoverStatGate, copyGate, copyStepGate, copyPhase, onWorkerStart, onWorkerReady, onWorkerExit, onWorkerRecoveryFailure } = lifecycle;
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL("./archive-delete-worker.mjs", import.meta.url),
        { workerData: { filename, conversationId, ...oversized, lockGate, cutoverStatGate, copyGate, copyStepGate, copyPhase } });
    } catch (error) { reject(error); return; }
    workers.add(worker);
    let reply;
    let failure;
    let snapshot;
    worker.on("message", (message) => {
      if (message.ready) {
        try {
          if (message.ready === "copy") snapshot = onWorkerStart();
          else onWorkerReady(snapshot);
          worker.postMessage("proceed");
        }
        catch (error) { failure = error; void worker.terminate(); }
      } else reply = message;
    });
    worker.on("error", (error) => { failure = error; });
    worker.on("exit", async (code) => {
      const problem = failure ?? (code !== 0 || !reply?.ok
        ? Object.assign(new Error(reply?.error ?? `Archive deletion worker exited ${code}`), { code: reply?.code }) : null);
      try {
        // Integrity scans and interrupted-cutover recovery belong to a
        // worker. Keep the process lease while this worker is still tracked.
        if (problem) await recoverArchiveOnWorker(filename,
          ["ARCHIVE_SNAPSHOT_CHANGED", "ARCHIVE_DEFERRED", "ARCHIVE_SOURCE_BUSY"].includes(problem.code));
        workers.delete(worker);
        onWorkerExit();
        if (problem) reject(problem);
        else resolve();
      } catch (error) {
        workers.delete(worker);
        onWorkerRecoveryFailure(error);
        reject(new Error("Archive maintenance recovery failed; restart requires inspection", { cause: error }));
      }
    });
  });
}

function recoverArchiveOnWorker(filename, sourceUnmoved = false, runtimeLease = false) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./archive-recover-worker.mjs", import.meta.url), { workerData: { filename, sourceUnmoved, runtimeLease } });
    let reply;
    let failure;
    worker.on("message", (message) => { reply = message; });
    worker.on("error", (error) => { failure = error; });
    worker.on("exit", (code) => {
      if (failure || code !== 0 || !reply?.ok) reject(failure ?? Object.assign(
        new Error(reply?.error ?? `Archive recovery worker exited ${code}`), { code: reply?.code }));
      else resolve();
    });
  });
}

function trimAudit(db) {
  db.prepare(`DELETE FROM audit_log WHERE id <= (SELECT id FROM audit_log ORDER BY id DESC LIMIT 1 OFFSET 9999)
    AND target NOT IN (SELECT id FROM runs WHERE status IN ('queued', 'launching', 'running')
      OR (status = 'interrupted' AND recovery_decision IS NULL))`).run();
}

function migrate(db) {
  const hadRuns = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runs'").get());
  const hadMessages = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages'").get());
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS project_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS project_memberships (project_id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES project_groups(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, worktree_id TEXT NOT NULL, worktree_path TEXT NOT NULL,
      title TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', provider_session_id TEXT, tab_position INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0, deleting INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS conversations_scope ON conversations(project_id, worktree_id, archived, updated_at);
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'text', body TEXT NOT NULL DEFAULT '', payload TEXT, created_at TEXT NOT NULL,
      search_order INTEGER
    );
    CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id, created_at);
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      worktree_path TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', reasoning_effort TEXT NOT NULL DEFAULT 'medium', approval_policy TEXT NOT NULL, prompt TEXT NOT NULL,
      status TEXT NOT NULL, pid INTEGER, provider_session_id TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
      exit_code INTEGER, error TEXT, cost_usd REAL, input_tokens INTEGER, output_tokens INTEGER,
      recovery_class TEXT, recovery_decision TEXT, transcript_omitted INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS runs_conversation ON runs(conversation_id, created_at);
    CREATE TABLE IF NOT EXISTS run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT, created_at TEXT NOT NULL, UNIQUE(run_id, seq)
    );
    CREATE TABLE IF NOT EXISTS run_event_usage (run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE, bytes INTEGER NOT NULL, last_seq INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS trusted_projects (project_id TEXT PRIMARY KEY, project_path TEXT NOT NULL, trusted_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, target TEXT, details TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS prompt_templates (id TEXT PRIMARY KEY, title TEXT NOT NULL, prompt TEXT NOT NULL, created_at TEXT NOT NULL);
  `);
  db.exec("DROP TRIGGER IF EXISTS retained_hard_limit");
  try { db.exec("ALTER TABLE run_event_usage ADD COLUMN last_seq INTEGER NOT NULL DEFAULT 0"); } catch { /* Already migrated. */ }
  const version = db.pragma("user_version", { simple: true });
  db.exec(`CREATE TABLE IF NOT EXISTS migration_progress (
    kind TEXT PRIMARY KEY, cursor_text TEXT, cursor_number INTEGER NOT NULL DEFAULT 0,
    retained_bytes INTEGER NOT NULL DEFAULT 0, retained_items INTEGER NOT NULL DEFAULT 0,
    max_seq INTEGER NOT NULL DEFAULT 0
  )`);
  if (version < 1) db.prepare("INSERT OR IGNORE INTO migration_progress (kind) VALUES ('events')").run();
  prepareMessageOrderMigration(db, hadMessages);
  try { db.exec("ALTER TABLE conversations ADD COLUMN tab_position INTEGER NOT NULL DEFAULT 0"); } catch { /* Already migrated. */ }
  try { db.exec("ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0"); } catch { /* Already migrated. */ }
  try { db.exec("ALTER TABLE conversations ADD COLUMN deleting INTEGER NOT NULL DEFAULT 0"); } catch { /* Already migrated. */ }
  prepareVisibleConversationLookup(db);
  prepareRecentTitleLookup(db);
  prepareSearchMessageHeads(db);
  try { db.exec("ALTER TABLE runs ADD COLUMN reasoning_effort TEXT NOT NULL DEFAULT 'medium'"); } catch { /* Already migrated. */ }
  try { db.exec("ALTER TABLE runs ADD COLUMN pid INTEGER"); } catch { /* Already migrated. */ }
  try { db.exec("ALTER TABLE runs ADD COLUMN recovery_class TEXT"); } catch { /* Already migrated. */ }
  try { db.exec("ALTER TABLE runs ADD COLUMN recovery_decision TEXT"); } catch { /* Already migrated. */ }
  try { db.exec("ALTER TABLE runs ADD COLUMN worktree_path TEXT"); } catch { /* Already migrated. */ }
  try { db.exec("ALTER TABLE runs ADD COLUMN transcript_omitted INTEGER NOT NULL DEFAULT 0"); } catch { /* Already migrated. */ }
  // Building an index over a populated legacy runs table holds the startup
  // thread for an unbounded interval. A new database gets the direct index;
  // legacy databases build a small recovery-only lookup by durable cursor.
  if (!hadRuns) db.exec("CREATE INDEX IF NOT EXISTS runs_worktree_recovery ON runs(worktree_path, status, recovery_decision, created_at)");
  prepareRecoveryLookup(db, hadRuns, version);
  prepareRetainedMeasurement(db, version);
  reserveRecoveryHeadroom(db);
  db.exec(`CREATE TRIGGER retained_hard_limit BEFORE UPDATE ON retained_usage
    WHEN OLD.measured = 1 AND NEW.bytes > MAX(COALESCE((SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'maxRetainedMiB'), ${DEFAULT_SETTINGS.maxRetainedMiB}) * 1048576, OLD.legacy_ceiling)
    BEGIN SELECT RAISE(ABORT, 'OUTRIGHT_RETAINED_LIMIT'); END`);
  if (!migrationPending(db)) db.pragma("user_version = 4");
}

function prepareRecoveryLookup(db, hadRuns, version) {
  const hadLookup = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'recovery_scope'").get());
  const hadAllTriggers = ["runs_recovery_insert", "runs_recovery_update", "runs_recovery_delete"].every((name) =>
    Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name)));
  const path = (alias) => `CASE WHEN octet_length(${alias}.worktree_path) <= 4096 THEN ${alias}.worktree_path ELSE NULL END`;
  const unsettled = (alias) => `(${alias}.status IN ('queued', 'launching', 'running') OR (${alias}.status = 'interrupted' AND ${alias}.recovery_decision IS NULL))`;
  // DDL and the backfill marker must commit together. A pre-fix crash could
  // leave the table without its marker; missing triggers identify that state.
  db.transaction(() => {
    db.exec("CREATE TABLE IF NOT EXISTS recovery_scope (run_id TEXT PRIMARY KEY, worktree_path TEXT)");
    db.exec("CREATE INDEX IF NOT EXISTS recovery_scope_path ON recovery_scope(worktree_path, run_id)");
    if (hadRuns && (!hadLookup || !hadAllTriggers)) {
      db.prepare("INSERT OR IGNORE INTO migration_progress (kind, cursor_text) VALUES ('recovery', ?)")
        .run(version < 2 ? "backfill-terminal" : null);
    }
    db.exec(`CREATE TRIGGER IF NOT EXISTS runs_recovery_insert AFTER INSERT ON runs BEGIN
      INSERT INTO recovery_scope (run_id, worktree_path) SELECT NEW.id, ${path("NEW")} WHERE ${unsettled("NEW")}; END`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS runs_recovery_update AFTER UPDATE ON runs BEGIN
      DELETE FROM recovery_scope WHERE run_id = OLD.id;
      INSERT INTO recovery_scope (run_id, worktree_path) SELECT NEW.id, ${path("NEW")} WHERE ${unsettled("NEW")}; END`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS runs_recovery_delete AFTER DELETE ON runs BEGIN
      DELETE FROM recovery_scope WHERE run_id = OLD.id; END`);
  }).immediate();
}

function prepareVisibleConversationLookup(db) {
  db.transaction(() => {
    const existed = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'search_visible_conversations'").get());
    db.exec(`CREATE TABLE IF NOT EXISTS search_visible_conversations (
    source_rowid INTEGER PRIMARY KEY
  );
  CREATE TRIGGER IF NOT EXISTS search_visible_insert AFTER INSERT ON conversations
    WHEN NEW.deleting = 0 BEGIN
      INSERT OR IGNORE INTO search_visible_conversations (source_rowid) VALUES (NEW.rowid);
    END;
  CREATE TRIGGER IF NOT EXISTS search_visible_update AFTER UPDATE OF deleting ON conversations BEGIN
    DELETE FROM search_visible_conversations WHERE source_rowid = OLD.rowid;
    INSERT OR IGNORE INTO search_visible_conversations (source_rowid)
      SELECT NEW.rowid WHERE NEW.deleting = 0;
    END;
  CREATE TRIGGER IF NOT EXISTS search_visible_delete AFTER DELETE ON conversations BEGIN
    DELETE FROM search_visible_conversations WHERE source_rowid = OLD.rowid;
    END`);
    if (!existed && db.prepare("SELECT 1 FROM conversations LIMIT 1").get()) {
      db.prepare("INSERT OR IGNORE INTO migration_progress (kind) VALUES ('search-visible')").run();
    }
  }).immediate();
}

function prepareRecentTitleLookup(db) {
  db.transaction(() => {
    const existed = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'search_recent_titles'").get());
    // Build the ordered index while empty. Legacy titles enter in bounded
    // batches, and the triggers preserve concurrent edits across restarts.
    db.exec(`CREATE TABLE IF NOT EXISTS search_recent_titles (
      source_rowid INTEGER PRIMARY KEY, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS search_recent_titles_activity
      ON search_recent_titles(updated_at DESC, source_rowid DESC);
    CREATE TRIGGER IF NOT EXISTS search_titles_insert AFTER INSERT ON conversations
      WHEN NEW.deleting = 0 BEGIN
        INSERT INTO search_recent_titles (source_rowid, updated_at) VALUES (NEW.rowid, NEW.updated_at);
      END;
    CREATE TRIGGER IF NOT EXISTS search_titles_update AFTER UPDATE OF updated_at, deleting ON conversations BEGIN
      DELETE FROM search_recent_titles WHERE source_rowid = OLD.rowid AND NEW.deleting != 0;
      INSERT INTO search_recent_titles (source_rowid, updated_at)
        SELECT NEW.rowid, NEW.updated_at WHERE NEW.deleting = 0
        ON CONFLICT(source_rowid) DO UPDATE SET updated_at = excluded.updated_at;
      END;
    CREATE TRIGGER IF NOT EXISTS search_titles_delete AFTER DELETE ON conversations BEGIN
      DELETE FROM search_recent_titles WHERE source_rowid = OLD.rowid;
      END`);
    if (!existed && db.prepare("SELECT 1 FROM conversations LIMIT 1").get()) {
      db.prepare("INSERT OR IGNORE INTO migration_progress (kind) VALUES ('search-titles')").run();
    }
  }).immediate();
}

function prepareSearchMessageHeads(db) {
  db.transaction(() => {
    const existed = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'search_message_heads'").get());
    // Creating the ordered index while the table is empty keeps startup
    // independent of legacy history size. Backfill advances by conversation.
    db.exec(`CREATE TABLE IF NOT EXISTS search_message_heads (
      source_rowid INTEGER PRIMARY KEY, latest_ordinal INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS search_message_heads_recent ON search_message_heads(latest_ordinal DESC)`);
    if (!existed && db.prepare("SELECT 1 FROM conversations LIMIT 1").get()) {
      db.prepare("INSERT OR IGNORE INTO migration_progress (kind) VALUES ('search-heads')").run();
    }
    db.exec(`CREATE TRIGGER IF NOT EXISTS search_heads_message_insert AFTER INSERT ON message_order BEGIN
      INSERT INTO search_message_heads (source_rowid, latest_ordinal)
        SELECT rowid, NEW.ordinal FROM conversations WHERE id = NEW.scope AND deleting = 0
        ON CONFLICT(source_rowid) DO UPDATE SET latest_ordinal = MAX(latest_ordinal, excluded.latest_ordinal);
    END;
    CREATE TRIGGER IF NOT EXISTS search_heads_message_delete AFTER DELETE ON message_order BEGIN
      UPDATE search_message_heads SET latest_ordinal =
        (SELECT ordinal FROM message_order WHERE scope = OLD.scope ORDER BY ordinal DESC LIMIT 1)
        WHERE source_rowid = (SELECT rowid FROM conversations WHERE id = OLD.scope)
          AND latest_ordinal = OLD.ordinal
          AND EXISTS (SELECT 1 FROM message_order WHERE scope = OLD.scope);
      DELETE FROM search_message_heads
        WHERE source_rowid = (SELECT rowid FROM conversations WHERE id = OLD.scope)
          AND latest_ordinal = OLD.ordinal
          AND NOT EXISTS (SELECT 1 FROM message_order WHERE scope = OLD.scope);
    END;
    CREATE TRIGGER IF NOT EXISTS search_heads_conversation_update AFTER UPDATE OF deleting ON conversations BEGIN
      DELETE FROM search_message_heads WHERE source_rowid = OLD.rowid;
      INSERT INTO search_message_heads (source_rowid, latest_ordinal)
        SELECT NEW.rowid, ordinal FROM message_order WHERE scope = NEW.id AND NEW.deleting = 0
        ORDER BY ordinal DESC LIMIT 1;
    END;
    CREATE TRIGGER IF NOT EXISTS search_heads_conversation_delete AFTER DELETE ON conversations BEGIN
      DELETE FROM search_message_heads WHERE source_rowid = OLD.rowid;
    END`);
  }).immediate();
}

function prepareMessageOrderMigration(db, hadMessages) {
  const hadOrderTable = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'message_order'").get());
  if (!db.pragma("table_info(messages)").some((column) => column.name === "search_order")) {
    db.transaction(() => {
      db.exec("ALTER TABLE messages ADD COLUMN search_order INTEGER");
      db.prepare("INSERT OR IGNORE INTO migration_progress (kind) VALUES ('messages')").run();
    }).immediate();
  }
  // This table's key is constructed while empty. Inserting 64 identities per
  // migration tick avoids CREATE INDEX scanning a large legacy messages table
  // on the startup thread. Keep the old column for API cursors and old stores.
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS message_order (
      scope TEXT NOT NULL, ordinal INTEGER NOT NULL, message_key TEXT NOT NULL,
      PRIMARY KEY (scope, ordinal, message_key)
    ) WITHOUT ROWID`);
    if (hadMessages && !hadOrderTable) {
      // A pre-existing column migration may have a nonzero cursor, but the
      // newly created lookup has no entries yet. Restart that scan at zero.
      db.prepare("INSERT INTO migration_progress (kind, cursor_number) VALUES ('messages', 0) ON CONFLICT(kind) DO UPDATE SET cursor_number = 0").run();
    }
  }).immediate();
  // Earlier releases used this name for a column-only trigger. Replace it
  // once; avoid schema writes on every subsequent open of a large store.
  const insertTrigger = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'messages_search_order_insert'").get();
  if (!insertTrigger?.sql?.includes("message_order")) {
    db.exec("DROP TRIGGER IF EXISTS messages_search_order_insert");
    db.exec(`CREATE TRIGGER messages_search_order_insert AFTER INSERT ON messages
      BEGIN
        UPDATE messages SET search_order = NEW.rowid WHERE rowid = NEW.rowid;
        INSERT OR IGNORE INTO message_order (scope, ordinal, message_key)
          VALUES (NEW.conversation_id, NEW.rowid, NEW.id);
      END`);
  }
  db.exec(`CREATE TRIGGER IF NOT EXISTS messages_search_order_update AFTER UPDATE OF search_order, conversation_id, id ON messages
    BEGIN
      DELETE FROM message_order WHERE scope = OLD.conversation_id AND ordinal = OLD.search_order AND message_key = OLD.id;
      INSERT OR IGNORE INTO message_order (scope, ordinal, message_key)
        SELECT NEW.conversation_id, NEW.search_order, NEW.id WHERE NEW.search_order IS NOT NULL;
    END`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS messages_search_order_delete AFTER DELETE ON messages
    BEGIN DELETE FROM message_order WHERE scope = OLD.conversation_id AND ordinal = OLD.search_order AND message_key = OLD.id; END`);
}

function prepareRetainedMeasurement(db, version) {
  db.exec("CREATE TABLE IF NOT EXISTS retained_usage (id INTEGER PRIMARY KEY CHECK(id = 1), bytes INTEGER NOT NULL, legacy_ceiling INTEGER NOT NULL DEFAULT 0, measured INTEGER NOT NULL DEFAULT 0)");
  if (!db.pragma("table_info(retained_usage)").some((column) => column.name === "legacy_ceiling")) {
    db.exec("ALTER TABLE retained_usage ADD COLUMN legacy_ceiling INTEGER NOT NULL DEFAULT 0");
  }
  if (!db.pragma("table_info(retained_usage)").some((column) => column.name === "measured")) {
    db.exec("ALTER TABLE retained_usage ADD COLUMN measured INTEGER NOT NULL DEFAULT 0");
  }
  const counterCreated = db.prepare("INSERT OR IGNORE INTO retained_usage (id, bytes) VALUES (1, 0)").run().changes > 0;
  db.exec("CREATE TABLE IF NOT EXISTS retained_scans (table_name TEXT PRIMARY KEY, cursor INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0)");
  const scanExists = Boolean(db.prepare("SELECT 1 FROM retained_scans LIMIT 1").get());
  // A genuinely empty store has nothing to backfill. Avoid depending on an
  // 8 ms migration tick to complete before its first user write under load.
  if (counterCreated && !scanExists && RETAINED_COLUMNS.every(([table]) =>
    !db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())) {
    db.prepare("UPDATE retained_usage SET measured = 1 WHERE id = 1").run();
  } else if (version >= 2 && !counterCreated && !scanExists) {
    db.prepare("UPDATE retained_usage SET measured = 1 WHERE id = 1").run();
  } else if (!scanExists) {
    db.transaction(() => {
      db.prepare("UPDATE retained_usage SET bytes = 0, measured = 0 WHERE id = 1").run();
      const insert = db.prepare("INSERT INTO retained_scans (table_name) VALUES (?)");
      for (const [table] of RETAINED_COLUMNS) insert.run(table);
    }).immediate();
  }
  installRetainedTriggers(db);
}

function installRetainedTriggers(db) {
  for (const [table, fields] of RETAINED_COLUMNS) {
    for (const action of ["insert", "update", "delete"]) db.exec(`DROP TRIGGER IF EXISTS retained_${table}_${action}`);
    const counted = (alias) => `(measured = 1 OR COALESCE((SELECT done FROM retained_scans WHERE table_name = '${table}'), 0) = 1
      OR ${alias}.rowid <= COALESCE((SELECT cursor FROM retained_scans WHERE table_name = '${table}'), 0))`;
    const size = (alias) => retainedSizeExpression(fields, `${alias}.`);
    db.exec(`CREATE TRIGGER retained_${table}_insert AFTER INSERT ON ${table}
      BEGIN UPDATE retained_usage SET bytes = bytes + (${size("NEW")}) WHERE id = 1 AND ${counted("NEW")}; END`);
    db.exec(`CREATE TRIGGER retained_${table}_update AFTER UPDATE ON ${table}
      BEGIN UPDATE retained_usage SET bytes = bytes + (${size("NEW")}) - (${size("OLD")}) WHERE id = 1 AND ${counted("OLD")}; END`);
    db.exec(`CREATE TRIGGER retained_${table}_delete AFTER DELETE ON ${table}
      BEGIN UPDATE retained_usage SET bytes = bytes - (${size("OLD")}) WHERE id = 1 AND ${counted("OLD")}; END`);
  }
}

function migrationJob(db, kind) {
  return db.prepare("SELECT * FROM migration_progress WHERE kind = ?").get(kind);
}

function migrationPending(db) {
  return Boolean(db.prepare("SELECT 1 FROM migration_progress LIMIT 1").get()
    || db.prepare("SELECT 1 FROM retained_scans WHERE done = 0 LIMIT 1").get());
}

function retainedMeasured(db) {
  return db.prepare("SELECT measured FROM retained_usage WHERE id = 1").get().measured === 1;
}

function assertMessageOrderReady(db) {
  if (migrationJob(db, "messages")) throw databaseError(503, "Conversation history is being indexed; retry shortly");
}

// One tick visits at most 64 rows in each migration family and retained
// table. Cursors and byte adjustments commit together, so an interrupted
// upgrade resumes without recounting old rows or dropping live writes.
function advanceMigrations(db) {
  if (!migrationPending(db)) return;
  advanceRecoveryMigration(db);
  advanceEventMigration(db);
  advanceMessageMigration(db);
  advanceVisibleConversationMigration(db);
  advanceRecentTitleMigration(db);
  advanceSearchHeadsMigration(db);
  advanceRetainedMigration(db);
  if (!migrationPending(db)) db.pragma("user_version = 4");
}

function advanceVisibleConversationMigration(db) {
  const job = migrationJob(db, "search-visible");
  if (!job) return;
  db.transaction(() => {
    const rows = db.prepare("SELECT rowid AS scanRowId FROM conversations WHERE rowid > ? ORDER BY rowid LIMIT 64").all(job.cursor_number);
    const insert = db.prepare(`INSERT OR IGNORE INTO search_visible_conversations (source_rowid)
      SELECT rowid FROM conversations WHERE rowid = ? AND deleting = 0`);
    for (const row of rows) insert.run(row.scanRowId);
    if (rows.length < 64) db.prepare("DELETE FROM migration_progress WHERE kind = 'search-visible'").run();
    else db.prepare("UPDATE migration_progress SET cursor_number = ? WHERE kind = 'search-visible'").run(rows.at(-1).scanRowId);
  }).immediate();
}

function advanceRecentTitleMigration(db) {
  const job = migrationJob(db, "search-titles");
  if (!job) return;
  db.transaction(() => {
    const rows = db.prepare("SELECT rowid AS scanRowId FROM conversations WHERE rowid > ? ORDER BY rowid LIMIT 64").all(job.cursor_number);
    const insert = db.prepare(`INSERT INTO search_recent_titles (source_rowid, updated_at)
      SELECT rowid, updated_at FROM conversations WHERE rowid = ? AND deleting = 0
      ON CONFLICT(source_rowid) DO UPDATE SET updated_at = excluded.updated_at`);
    for (const row of rows) insert.run(row.scanRowId);
    if (rows.length < 64) db.prepare("DELETE FROM migration_progress WHERE kind = 'search-titles'").run();
    else db.prepare("UPDATE migration_progress SET cursor_number = ? WHERE kind = 'search-titles'").run(rows.at(-1).scanRowId);
  }).immediate();
}

function advanceSearchHeadsMigration(db) {
  const job = migrationJob(db, "search-heads");
  if (!job) return;
  db.transaction(() => {
    const rows = db.prepare("SELECT rowid AS scanRowId FROM conversations WHERE rowid > ? ORDER BY rowid LIMIT 64").all(job.cursor_number);
    const insert = db.prepare(`INSERT INTO search_message_heads (source_rowid, latest_ordinal)
      SELECT c.rowid, ordered.ordinal FROM conversations AS c
      JOIN message_order AS ordered ON ordered.scope = c.id
      WHERE c.rowid = ? AND c.deleting = 0
      ORDER BY ordered.ordinal DESC LIMIT 1
      ON CONFLICT(source_rowid) DO UPDATE SET latest_ordinal = MAX(latest_ordinal, excluded.latest_ordinal)`);
    for (const row of rows) insert.run(row.scanRowId);
    if (rows.length < 64) db.prepare("DELETE FROM migration_progress WHERE kind = 'search-heads'").run();
    else db.prepare("UPDATE migration_progress SET cursor_number = ? WHERE kind = 'search-heads'").run(rows.at(-1).scanRowId);
  }).immediate();
}

function advanceRecoveryMigration(db) {
  const job = migrationJob(db, "recovery");
  if (!job) return;
  db.transaction(() => {
    const rows = db.prepare(`SELECT rowid AS scanRowId, id, status, recovery_decision AS recoveryDecision,
      CASE WHEN octet_length(worktree_path) <= 4096 THEN worktree_path ELSE NULL END AS worktreePath
      FROM runs WHERE rowid > ? ORDER BY rowid LIMIT 64`).all(job.cursor_number);
    const insert = db.prepare("INSERT OR IGNORE INTO recovery_scope (run_id, worktree_path) VALUES (?, ?)");
    const backfill = db.prepare(`UPDATE runs SET worktree_path = (SELECT worktree_path FROM conversations WHERE id = runs.conversation_id)
      WHERE rowid = ? AND worktree_path IS NULL AND status IN ('completed', 'failed', 'stopped')
      AND (SELECT octet_length(worktree_path) FROM conversations WHERE id = runs.conversation_id) <= 4096`);
    for (const row of rows) {
      if (job.cursor_text === "backfill-terminal") backfill.run(row.scanRowId);
      if (["queued", "launching", "running"].includes(row.status) || (row.status === "interrupted" && row.recoveryDecision == null)) {
        insert.run(row.id, row.worktreePath);
      }
    }
    if (rows.length < 64) db.prepare("DELETE FROM migration_progress WHERE kind = 'recovery'").run();
    else db.prepare("UPDATE migration_progress SET cursor_number = ? WHERE kind = 'recovery'").run(rows.at(-1).scanRowId);
  }).immediate();
}

function advanceEventMigration(db) {
  const job = migrationJob(db, "events");
  if (!job) return;
  db.transaction(() => {
    let runId = job.cursor_text;
    let cursor = job.cursor_number;
    let bytes = job.retained_bytes;
    let items = job.retained_items;
    let maxSeq = job.max_seq;
    if (!cursor) {
      const next = db.prepare("SELECT run_id FROM run_events WHERE run_id > ? GROUP BY run_id ORDER BY run_id LIMIT 1").get(runId ?? "");
      if (!next) { db.prepare("DELETE FROM migration_progress WHERE kind = 'events'").run(); return; }
      runId = next.run_id;
      maxSeq = db.prepare("SELECT MAX(seq) AS seq FROM run_events WHERE run_id = ?").get(runId).seq;
      cursor = maxSeq + 1;
      bytes = 0;
      items = 0;
    }
    const rows = db.prepare(`SELECT id, seq, COALESCE(octet_length(payload), 0) + ${RETAINED_ROW_OVERHEAD_BYTES} AS size
      FROM run_events WHERE run_id = ? AND seq < ? ORDER BY seq DESC LIMIT 64`).all(runId, cursor);
    const remove = db.prepare("DELETE FROM run_events WHERE id = ?");
    for (const row of rows) {
      if (bytes + row.size > MAX_RUN_EVENT_RETAINED_BYTES || items >= 2000) remove.run(row.id);
      else { bytes += row.size; items += 1; }
    }
    if (rows.length < 64) {
      if (db.prepare("SELECT 1 FROM runs WHERE id = ?").get(runId)) {
        db.prepare(`INSERT INTO run_event_usage (run_id, bytes, last_seq) VALUES (?, ?, ?)
          ON CONFLICT(run_id) DO UPDATE SET bytes = excluded.bytes, last_seq = MAX(run_event_usage.last_seq, excluded.last_seq)`)
          .run(runId, bytes, maxSeq);
      }
      db.prepare(`UPDATE migration_progress SET cursor_text = ?, cursor_number = 0,
        retained_bytes = 0, retained_items = 0, max_seq = 0 WHERE kind = 'events'`).run(runId);
    } else {
      db.prepare(`UPDATE migration_progress SET cursor_text = ?, cursor_number = ?,
        retained_bytes = ?, retained_items = ?, max_seq = ? WHERE kind = 'events'`)
        .run(runId, rows.at(-1).seq, bytes, items, maxSeq);
    }
  }).immediate();
}

function advanceMessageMigration(db) {
  const job = migrationJob(db, "messages");
  if (!job) return;
  db.transaction(() => {
    const rows = db.prepare("SELECT rowid AS scanRowId, search_order AS ordinal FROM messages WHERE rowid > ? ORDER BY rowid LIMIT 64").all(job.cursor_number);
    const update = db.prepare("UPDATE messages SET search_order = rowid WHERE rowid = ? AND search_order IS NULL");
    // Keep legacy identifiers inside SQLite; old databases can contain large
    // raw strings that must not be materialized in a 64-row JavaScript batch.
    const order = db.prepare(`INSERT OR IGNORE INTO message_order (scope, ordinal, message_key)
      SELECT conversation_id, search_order, id FROM messages WHERE rowid = ?`);
    for (const row of rows) {
      if (row.ordinal === null) update.run(row.scanRowId);
      order.run(row.scanRowId);
    }
    if (rows.length < 64) db.prepare("DELETE FROM migration_progress WHERE kind = 'messages'").run();
    else db.prepare("UPDATE migration_progress SET cursor_number = ? WHERE kind = 'messages'").run(rows.at(-1).scanRowId);
  }).immediate();
}

function advanceRetainedMigration(db) {
  if (migrationJob(db, "recovery")) return;
  if (retainedMeasured(db)) return;
  db.transaction(() => {
    let remainingBytes = 256 * 1024;
    const started = performance.now();
    for (const [table, fields] of RETAINED_COLUMNS) {
      const scan = db.prepare("SELECT cursor, done FROM retained_scans WHERE table_name = ?").get(table);
      if (!scan || scan.done) continue;
      const rows = db.prepare(`SELECT rowid AS scanRowId, ${retainedSizeExpression(fields)} AS bytes FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT 64`).all(scan.cursor);
      // octet_length(column) reads SQLite's stored length metadata; it does
      // not hydrate giant legacy bodies into JavaScript. Still debit each row
      // against this tick's byte budget so one tick cannot reconcile dozens
      // of oversized rows. A single old row is the indivisible minimum.
      let bytes = 0;
      let processed = 0;
      for (const row of rows) {
        if (processed && (bytes + row.bytes > remainingBytes || performance.now() - started > 8)) break;
        bytes += row.bytes;
        processed += 1;
      }
      db.prepare("UPDATE retained_usage SET bytes = bytes + ? WHERE id = 1").run(bytes);
      db.prepare("UPDATE retained_scans SET cursor = ?, done = ? WHERE table_name = ?")
        .run(rows[processed - 1]?.scanRowId ?? scan.cursor, Number(rows.length < 64 && processed === rows.length), table);
      remainingBytes = Math.max(0, remainingBytes - bytes);
      if (remainingBytes === 0 || performance.now() - started > 8) break;
    }
    if (!db.prepare("SELECT 1 FROM retained_scans WHERE done = 0 LIMIT 1").get()) {
      reserveRecoveryHeadroom(db);
      db.prepare("UPDATE retained_usage SET measured = 1 WHERE id = 1").run();
      db.prepare("DELETE FROM retained_scans").run();
    }
  }).immediate();
}

function reserveRecoveryHeadroom(db, configured = Number(db.prepare("SELECT value FROM settings WHERE key = 'maxRetainedMiB'").get()?.value ?? DEFAULT_SETTINGS.maxRetainedMiB) * 1024 * 1024, criticalAudit = false) {
  const recoveryPending = Boolean(migrationJob(db, "recovery"));
  const unsettled = recoveryPending ? 0 : db.prepare("SELECT COUNT(*) AS count FROM recovery_scope").get().count;
  // Reserve transitions before they start even when legacy usage is just
  // below the cap. Each restart recalculates from the remaining unsettled
  // rows, so a crash partway through bounded reconciliation cannot strand
  // the backlog. Ordinary new-work admission still uses the configured cap.
  const bytes = retainedBytes(db);
  const headroom = criticalAudit || recoveryPending || unsettled || bytes > configured ? Math.max(1024 * 1024, unsettled * 256) : 0;
  const ceiling = bytes + headroom > configured ? bytes + headroom : 0;
  db.prepare("UPDATE retained_usage SET legacy_ceiling = ? WHERE id = 1").run(ceiling);
}

function conversationColumns() {
  return `id, project_id AS projectId, worktree_id AS worktreeId, worktree_path AS worktreePath, title, provider, model,
    provider_session_id AS providerSessionId, archived, pinned, tab_position AS tabPosition, created_at AS createdAt, updated_at AS updatedAt`;
}

function assertConversationNotDeleting(db, id) {
  // A deletion marker is durable across crashes, while child rows disappear
  // over several transactions. Never expose one of those partial snapshots.
  if (db.prepare("SELECT 1 FROM conversations WHERE id = ? AND deleting = 1").get(id)) {
    throw databaseError(404, "Conversation not found");
  }
}

function hydratePayload(row) { return { ...row, payload: parseJson(row.payload, null) }; }

function decodeMessagePrefix(bytes) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let length = bytes.length; length >= Math.max(0, bytes.length - 3); length -= 1) {
    try { return decoder.decode(bytes.subarray(0, length)); }
    catch { /* The byte cap may split a UTF-8 character. */ }
  }
  throw databaseError(400, "Message body is not valid UTF-8");
}
function decodeMessageSuffix(bytes) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let start = 0; start <= Math.min(3, bytes.length); start += 1) {
    try { return decoder.decode(bytes.subarray(start)); }
    catch { /* The byte cap may start inside a UTF-8 character. */ }
  }
  throw databaseError(400, "Message body is not valid UTF-8");
}
function decodeMessageWindow(bytes) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let start = 0; start <= Math.min(3, bytes.length); start += 1) {
    for (let end = bytes.length; end >= Math.max(start, bytes.length - 3); end -= 1) {
      try { return decoder.decode(bytes.subarray(start, end)); }
      catch { /* A bounded window may split a code point at either edge. */ }
    }
  }
  throw databaseError(400, "Message body is not valid UTF-8");
}
function hydrateDetails(row) { return { ...row, details: parseJson(row.details, {}) }; }
function parseJson(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }
function now() { return new Date().toISOString(); }
function retainedBytes(db) {
  return db.prepare("SELECT bytes FROM retained_usage WHERE id = 1").get().bytes;
}
function retainedSizeExpression(fields, prefix = "") {
  return `${RETAINED_ROW_OVERHEAD_BYTES} + ${fields.split(", ").map((field) => "COALESCE(octet_length(" + prefix + field + "), 0)").join(" + ")}`;
}
function preparePrivateLaunchDirectory(directory) {
  if (!directory || !path.isAbsolute(directory)) throw new Error("A private absolute launch directory is required");
  try { mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if (error?.code !== "EEXIST") throw error; }
  let stat = lstatSync(directory);
  const wrongOwner = typeof process.getuid === "function" && stat.uid !== process.getuid();
  if (stat.isSymbolicLink() || !stat.isDirectory() || wrongOwner) {
    throw new Error("Launch directory must be a private, non-symlink directory owned by the runtime user");
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    chmodSync(directory, 0o700);
    stat = lstatSync(directory);
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("Launch directory must not grant group or other permissions");
}
// Reads the launch wrapper's durable self-recorded process identity for a run
// still in the 'launching' phase. Absent or malformed records return null; the
// run then provably never reached authorization and reconciles as
// never-started.
function readLaunchHandshake(launchDirectory, runId) {
  try {
    const record = parseJson(readFileSync(path.join(launchDirectory, `${runId}.json`), "utf8"), null);
    if (record && Number.isSafeInteger(record.pid) && record.pid > 0) return record;
  } catch { /* No handshake record exists (or it is unreadable). */ }
  return null;
}
// Deletes handshake records that no longer belong to a pending run, so a
// runtime hard-killed after authorization cannot leak one stale file per
// crash. Records for rows that were actually running are kept: their wrapper
// may still be alive and removes its own record when it exits.
function sweepLaunchHandshakes(launchDirectory, db) {
  let directory;
  try { directory = opendirSync(launchDirectory); }
  catch { return; }
  const keep = db.prepare(`SELECT 1 FROM runs WHERE id = ? AND status = 'interrupted'
    AND recovery_decision IS NULL AND recovery_class IN ('alive', 'unknown')`);
  try {
    let entry;
    while ((entry = directory.readSync())) {
      if (!entry.name.endsWith(".json")) continue;
      const runId = entry.name.slice(0, -".json".length);
      if (keep.get(runId)) continue;
      try { rmSync(path.join(launchDirectory, entry.name), { force: true }); } catch { /* Already gone. */ }
    }
  } finally { directory.closeSync(); }
}
// Probes the run's whole process group, not just the detached leader PID: an
// exited leader can leave live provider descendants in process group `pid` that
// are still able to mutate the worktree. Anything not verifiably exited is
// reported conservatively.
//
// On platforms without a portable process-group ownership mechanism (Windows),
// a gone leader proves nothing about its descendants: the spawned tree is not
// owned, so only a live leader is verifiable and everything else is unknown.
export function defaultProbeRun(pid, platform = process.platform) {
  if (platform === "win32") {
    try { process.kill(pid, 0); return "alive"; }
    catch { return "unknown"; }
  }
  const targets = [pid, -pid];
  const results = targets.map((target) => {
    try { process.kill(target, 0); return "alive"; }
    catch (error) { return error.code === "ESRCH" ? "exited" : "unknown"; }
  });
  if (results.includes("alive")) return "alive";
  if (results.every((result) => result === "exited")) return "exited";
  return "unknown";
}

function normalizeProbeResult(value) {
  if (value === true) return "alive";
  if (value === false) return "exited";
  return ["alive", "exited", "unknown"].includes(value) ? value : "unknown";
}

export function serializePayload(payload, maxBytes = MAX_RUN_EVENT_PAYLOAD_BYTES) {
  const serialized = JSON.stringify(payload ?? null);
  if (Buffer.byteLength(serialized) <= maxBytes) return serialized;
  const originalBytes = Buffer.byteLength(serialized);
  let previewBytes = Math.max(0, maxBytes - 128);
  let bounded;
  do {
    const preview = Buffer.from(serialized).subarray(0, previewBytes).toString("utf8");
    bounded = JSON.stringify({ truncated: true, originalBytes, preview });
    previewBytes = Math.max(0, previewBytes - Math.max(32, Buffer.byteLength(bounded) - maxBytes));
  } while (Buffer.byteLength(bounded) > maxBytes && previewBytes > 0);
  return bounded;
}

function validateSettingsPatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw databaseError(400, "Settings must be an object");
  for (const [key, value] of Object.entries(patch)) {
    const validate = SETTING_RULES[key];
    if (!validate) throw databaseError(400, `Unknown setting: ${key}`);
    if (!validate(value)) throw databaseError(400, `Invalid value for setting: ${key}`);
  }
}

function databaseError(statusCode, message) { const error = new Error(message); error.statusCode = statusCode; return error; }

export { DEFAULT_SETTINGS };
