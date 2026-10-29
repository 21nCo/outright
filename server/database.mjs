import Database from "better-sqlite3";
import { MAX_PENDING_RETENTION_CLEANUPS, backfillAuditEvidencePage, pendingCleanupSql,
  prepareAuditEvidence, trimAuditPage } from "./audit-retention.mjs";
import { chmodSync, existsSync, lstatSync, mkdirSync, opendirSync, readFileSync, realpathSync, rmSync, statfsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { foldFindText } from "../src/lib/find-text.js";
import { EXECUTION_ADAPTER_IDS, findExecutionAdapter, isModelName, isProviderSessionId, MODEL_NAME_REQUIREMENT } from "./execution-adapters/index.mjs";
import { RESOURCE_BUDGETS, RETAINED_MESSAGE_FIELDS, RETAINED_ROW_OVERHEAD_BYTES } from "./resource-budgets.mjs";
import { allocatedDatabaseUsage, archiveShadowPaths, beginArchiveShadow, recoverArchiveShadow } from "./archive-shadow.mjs";
import { readRunOutcome, removeRunOutcome, saveRunOutcome } from "./run-outcome-journal.mjs";

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
  // Detachable terminals: a graceful restart keeps live shells for the next
  // runtime to reattach. Turning it off ends every shell with its runtime.
  terminalReattach: true,
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
const TASK_TITLE_CHARACTERS = 500;
const TASK_OBJECTIVE_BYTES = 16 * 1024;
const TASK_RESPONSE_BYTES = 512 * 1024;
const TASK_THREAD_LIMIT = 200;
const TASK_THREAD_BYTES = 256 * 1024;
const TASK_THREAD_FIELD_CHARACTERS = 256;
// Scope ids come from discovered paths. One bound serves creation and list
// filters; it matches Node's default request header limit, so any id a URL
// can carry is accepted, and slugs of PATH_MAX paths fit with room to spare.
const TASK_SCOPE_ID_BYTES = 16 * 1024;
const RETAINED_COLUMNS = [
  ["settings", "key, value"],
  ["spaces", "id, name, created_at"],
  ["project_memberships", "project_id, space_id"],
  ["tasks", "id, space_id, project_id, worktree_id, worktree_path, title, objective"],
  ["conversations", "id, project_id, worktree_id, worktree_path, title, provider, model, provider_session_id, created_at, updated_at"],
  ["messages", RETAINED_MESSAGE_FIELDS.join(", ")],
  ["runs", "id, conversation_id, worktree_path, provider, model, reasoning_effort, approval_policy, prompt, status, pid, provider_session_id, created_at, started_at, finished_at, exit_code, error, cost_usd, input_tokens, output_tokens, recovery_class, recovery_decision, transcript_omitted"],
  ["run_events", "run_id, type, payload, created_at"],
  ["run_event_usage", "run_id"],
  ["trusted_projects", "project_id, project_path, trusted_at"],
  ["audit_log", "action, target, details, created_at"],
  ["prompt_templates", "id, title, prompt, created_at"],
  ["provider_accounts", "id, provider, label, home_path, created_at"],
  ["provider_account_selection", "provider, account_id"],
  ["provider_limit_windows", "account_id, provider, window_name, utilization, status, resets_at, observed_at, run_id, home_path"],
  ["run_accounts", "run_id, account_id, account_label, account_identity, bound_at, home_path"],
  ["run_account_pins", "run_id, account_id, home_path, home_known"],
  ["trusted_lifecycle_configs", "project_id, project_path, config_digest, trusted_at"],
  ["worktree_lifecycle", "worktree_path, project_id, state, updated_at"],
];
const RUN_RETAINED_FIELDS = RETAINED_COLUMNS.find(([name]) => name === "runs")[1];
// The account a run launched with, and the login key it used: the key of
// its CLI home, prefixed by the name of a credential variable that stood in
// for the home's login (null for a direct provider). A run that never
// launched has none. A recovery run
// is pinned to the account of the run it continues until it launches; a
// pin to a run from before accounts does not know that run's home.
const RUN_ACCOUNT_FIELDS = `account.account_id AS accountId, account.account_label AS accountLabel, account.account_identity AS accountIdentity,
  account.home_path AS accountHome, pin.account_id AS accountPinId, pin.home_path AS accountPinHome, pin.home_known AS accountPinHomeKnown`;
const RUN_ACCOUNT_JOINS = "LEFT JOIN run_accounts AS account ON account.run_id = runs.id LEFT JOIN run_account_pins AS pin ON pin.run_id = runs.id";
const PROVIDER_ACCOUNT_FIELDS = "id, provider, label, home_path AS homePath, created_at AS createdAt";
const MAX_ACCOUNTS_PER_PROVIDER = 16;
const MAX_TRUSTED_LIFECYCLE_CONFIGS = 16;
const MAX_WORKTREE_LIFECYCLE_STATES = 512;
// A running state is what archive maintenance waits for and what restore
// turns into an unconfirmed interruption. Retention keeps it, and every state
// the lifecycle service keeps (lifecycleStateKept), however many newer states
// are saved; the service forgets those whose worktree is gone.
const LIFECYCLE_STATE_RUNNING = "COALESCE(json_extract(state, '$.status'), '') = 'running'";
const LIFECYCLE_STATE_KEPT = `${LIFECYCLE_STATE_RUNNING} OR COALESCE(json_extract(state, '$.outcomeUnknown'), 0) <> 0
  OR COALESCE(json_extract(state, '$.status'), '') IN ('failed', 'cancelled', 'interrupted')
  OR COALESCE(json_extract(state, '$.checkpoints'), '{}') <> '{}'`;
const MAX_LIMIT_WINDOWS_PER_HOME = 8;

const SETTING_RULES = {
  provider: (value) => EXECUTION_ADAPTER_IDS.includes(value),
  model: isModelName,
  reasoningEffort: (value) => ["low", "medium", "high", "xhigh"].includes(value),
  approvalPolicy: (value) => ["read-only", "workspace-write", "danger-full-access"].includes(value),
  editor: (value) => ["zed", "code", "cursor", "finder"].includes(value),
  maxConcurrentRuns: (value) => Number.isInteger(value) && value >= 1 && value <= 8,
  maxQueuedRuns: (value) => Number.isInteger(value) && value >= 1 && value <= 256,
  maxRetainedMiB: (value) => Number.isInteger(value) && value >= 64 && value <= 4096,
  retentionDays: (value) => Number.isInteger(value) && value >= 1 && value <= 3650,
  notifications: (value) => typeof value === "boolean",
  theme: (value) => ["system", "light", "dark"].includes(value),
  terminalReattach: (value) => typeof value === "boolean",
};
const TERMINAL_OUTCOMES = ["terminal.create.failed", "terminal.exited", "terminal.closed", "terminal.recovered"];

function recordTerminalAuditRequest(scan, row, details, operationId) {
  if (["terminal.create.requested", "terminal.close.requested"].includes(row.action) && operationId) {
    const evidence = {};
    for (const key of ["cwd", "ownershipLabel", "handshakePath", "pid", "processIdentity"]) {
      if (details?.[key] != null) evidence[key] = details[key];
    }
    scan.requests.set(operationId, { action: row.action, target: row.target, operationId, details: evidence });
  }
}

function recordTerminalAuditOwner(scan, row, details) {
  if (["terminal.create.requested", "terminal.created", "terminal.create.unknown", "terminal.unknown", "terminal.reattached"].includes(row.action)
    && row.target) {
    const current = scan.owners.get(row.target) ?? { target: row.target, created: 0 };
    for (const key of ["cwd", "ownershipLabel", "handshakePath", "pid", "processIdentity"]) {
      if (details?.[key] != null) current[key] = details[key];
    }
    if (row.action === "terminal.created") current.created = 1;
    if (row.action === "terminal.unknown") current.unknownRecorded = true;
    // A reattached owner was live again; a later restart is a new unknown.
    if (row.action === "terminal.reattached") current.unknownRecorded = false;
    scan.owners.set(row.target, current);
  }
}

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

function applyTerminalAuditRow(scan, row) {
  scan.cursor = row.id;
  const details = parseJson(row.details, {});
  const operationId = typeof details?.operationId === "string" && details.operationId.length <= 128
    ? details.operationId : null;
  if (operationId) scan.requests.delete(operationId);
  recordTerminalAuditRequest(scan, row, details, operationId);
  recordTerminalAuditOwner(scan, row, details);
  if (TERMINAL_OUTCOMES.includes(row.action)) {
    scan.owners.delete(row.target);
  }
  if (scan.requests.size > 10_000 || scan.owners.size > 10_000) {
    throw new Error("Terminal audit recovery exceeds the bounded owner index");
  }
}

// The launch directory of a runtime opened with default options, once its
// data directory exists. A host that quits before its runtime exists
// withdraws reattach records there.
export function runtimeLaunchDirectory() {
  const dataDirectory = path.resolve(process.env.OUTRIGHT_DATA_DIR ?? path.join(os.homedir(), ".outright"));
  try { return path.join(realpathSync(dataDirectory), "launches"); } catch { return null; }
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
  const migrationHooks = { spaces: options.spacesMigrationStep, tasks: options.tasksMigrationStep };
  let { db, leaseDb } = openRuntimeStorage(filename, storageFilename, Boolean(options.runtimeLease), migrationHooks);
  let maintenance = false;
  let maintenanceCapacity;
  let maintenanceError;
  let activeMessageFinds = 0;
  let closing = false;
  let runReconciliationPending = false;
  let migrationTick;
  let migrationRetry;
  let terminalAuditTick;
  let terminalAuditRetry;
  let terminalAuditRetries = 0;
  const terminalAuditRetryBaseMs = Number.isFinite(options.terminalAuditRetryBaseMs)
    && options.terminalAuditRetryBaseMs >= 1 ? options.terminalAuditRetryBaseMs : 1000;
  let terminalAuditScan;
  let terminalReservationsCache;
  let terminalAuditCompletion = Promise.resolve();
  let completeTerminalAudit;
  let failTerminalAudit;
  let cleanupReconciliationTick;
  let cleanupReconciliationTickKind;
  let cleanupReconciliationPending = false;
  let cleanupReconciliationRetries = 0;
  const scheduleTerminalAudit = options.terminalAuditSchedule ?? setImmediate;
  let deletionTick;
  let deletionTickKind;
  let deletionCursor = 0;
  let deletionScanWrapped = false;
  // Where the last task retention scan stopped, so the next one continues.
  const taskRetentionCursor = { after: ["", ""] };
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
  // Task changes are announced once their transaction has committed: a
  // microtask runs after the synchronous transaction that recorded them.
  let taskChangesQueued = false;
  const queueTaskChanges = () => {
    if (taskChangesQueued) return;
    taskChangesQueued = true;
    queueMicrotask(announceTaskChanges);
  };
  function announceTaskChanges() {
    taskChangesQueued = false;
    if (!db?.open) return;
    if (db.inTransaction) { taskChangesQueued = true; setImmediate(announceTaskChanges); return; }
    const change = takeTaskChanges(db);
    if (change) options.onTasksChanged?.(change);
  }
  captureTaskChanges(db, queueTaskChanges);
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
    workers: deletionWorkers, lockGate: options.deletionWorkerGate, cutoverStatGate: options.deletionCutoverStatGate,
    cutoverCloseGate: options.deletionCutoverCloseGate, cutoverPromoteGate: options.deletionCutoverPromoteGate, copyGate: options.deletionCopyGate,
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
      if (activeMessageFinds || terminalAuditScan || runReconciliationPending || deletionsInFlight.size !== 1
        || maintenanceMustWait(db)) {
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
    onWorkerExit: (cutover) => {
      if (!closing && !db) {
        db = openDataConnection(storageFilename);
        reserveRecoveryHeadroom(db);
        captureTaskChanges(db, queueTaskChanges);
      }
      maintenance = false;
      maintenanceCapacity = undefined;
      maintenanceError = undefined;
      // A shadow cutover changes its thread's task on another connection.
      // Recovery may have kept or rolled back a failed one, so the reopened
      // store, not the worker's result, shows whether the thread is gone.
      if (cutover && !closing && !db.prepare("SELECT 1 FROM conversations WHERE id = ?").get(cutover.id)) {
        options.onTasksChanged?.({ taskIds: [cutover.taskId], truncated: false });
      }
      releaseLeaseIfIdle();
      if (cleanupReconciliationPending) scheduleCleanupReconciliation();
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
      try { advanceMigrations(db, migrationHooks); captureTaskChanges(db, queueTaskChanges); migrationError = null; }
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
        let resumeDelay = 0;
        if (result.sourceBusy) resumeDelay = Math.min(300_000, 1000 * 2 ** Math.min(busyCount, 9));
        else if (result.deferred) resumeDelay = 250;
        scheduleDeletionResume(resumeDelay);
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
  let nextPhysicalCheckpointAt = 0;
  function physicalUsageForAdmission(limit) {
    let usage = allocatedDatabaseUsage(storageFilename);
    if (usage.bytes !== null && usage.bytes >= limit && !db.inTransaction && storageFilename !== ":memory:"
      && Date.now() >= nextPhysicalCheckpointAt) {
      // A completed WAL transaction can still occupy disk until checkpointed.
      // Give reclaimable pages one short chance to clear; a pinned external
      // reader must not stall the event loop or reopen admission.
      // A pinned reader can make every checkpoint wait for its busy timeout.
      // Keep measuring allocation on every admission, but try reclamation at
      // most once per interval while the reader remains pinned.
      nextPhysicalCheckpointAt = Date.now() + 500;
      const previousTimeout = db.pragma("busy_timeout", { simple: true });
      try {
        db.pragma("busy_timeout = 25");
        db.pragma("wal_checkpoint(TRUNCATE)");
      } catch (error) {
        if (!["SQLITE_BUSY", "SQLITE_LOCKED"].includes(error.code)) {
          if (/^SQLITE_(?:FULL|IOERR|READONLY)(?:_|$)/.test(error.code ?? "")) {
            throw databaseError(507, "Allocated database storage cannot be reclaimed; close long-running readers and clean archived history");
          }
          throw error;
        }
      } finally { db.pragma(`busy_timeout = ${previousTimeout}`); }
      usage = allocatedDatabaseUsage(storageFilename);
    }
    return usage;
  }
  function requireOptionalPhysicalCapacity(allowPhysicalArchive = false) {
    // WAL pages can grow under an external reader even while a checkpoint
    // upsert keeps the logical retained count flat. Terminal outcomes and
    // recovery evidence use separate required paths and reserved headroom.
    const physicalThreshold = configuredRetainedLimitBytes() * RESOURCE_BUDGETS.physicalDatabaseMultiplier;
    const allocated = physicalUsageForAdmission(physicalThreshold);
    // An unknown allocation cannot grant optional capacity. Archiving one
    // existing row stays eligible so cleanup can recover measurable storage.
    if ((allocated.bytes === null && !allowPhysicalArchive)
      || (allocated.bytes !== null && allocated.bytes >= physicalThreshold
        && (!allowPhysicalArchive || allocated.bytes >= physicalThreshold + RESOURCE_BUDGETS.physicalArchiveHeadroomBytes))) {
      throw databaseError(507, "Allocated database storage is full; close long-running readers and clean archived history");
    }
  }
  function withinRetainedBudget(write, reserve = retainedReserveBytes, allowPhysicalArchive = false) {
    if (migrationPending(db)) throw databaseError(507, "Retained history is being migrated; retry when capacity is available");
    requireOptionalPhysicalCapacity(allowPhysicalArchive);
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

  function writeMessage(message) {
    db.prepare(`INSERT INTO messages (id, conversation_id, role, kind, body, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET role = excluded.role, kind = excluded.kind, body = excluded.body, payload = excluded.payload`)
      .run(message.id, message.conversationId, message.role, message.kind ?? "text", message.body ?? "", JSON.stringify(message.payload ?? null), message.createdAt);
    // Assistant checkpoints reuse one stable createdAt across the whole
    // stream, so the plain overwrite could regress updated_at after a newer
    // tool/user message advanced it; clamp to the newer timestamp instead.
    db.prepare("UPDATE conversations SET updated_at = MAX(updated_at, ?) WHERE id = ?").run(message.createdAt, message.conversationId);
    return hydratePayload(db.prepare(`SELECT search_order AS searchOrder, id, conversation_id AS conversationId, role, kind, body, payload, created_at AS createdAt
      FROM messages WHERE id = ?`).get(message.id));
  }

  // A journaled terminal outcome is recovery evidence. A migration pauses
  // optional history, so replay writes its final transcript inside the
  // recovery reserve, like a critical audit; retained-scan triggers count it
  // either side of each cursor. Only a real quota refusal omits it.
  function replayOutcomeTranscript(message) {
    try {
      if (!migrationPending(db)) return api.upsertMessage(message);
      return db.transaction(() => {
        reserveRecoveryHeadroom(db, undefined, true);
        const written = writeMessage(message);
        reserveRecoveryHeadroom(db);
        return written;
      })();
    } catch (error) {
      if (error.statusCode === 507 || error?.message?.includes("OUTRIGHT_RETAINED_LIMIT")) return null;
      throw error;
    }
  }

  // Effective thread visibility changed through a task. Announced only after
  // the change commits.
  function announceTaskArchive(change) {
    if (change?.conversationIds.length) options.onTaskArchiveChanged?.(change);
  }

  function configuredRetainedLimitBytes() {
    return Number(db.prepare("SELECT value FROM settings WHERE key = 'maxRetainedMiB'").get()?.value
      ?? DEFAULT_SETTINGS.maxRetainedMiB) * 1024 * 1024;
  }

  function writeAudit(action, details = {}, trim = true) {
    const serialized = serializePayload(details, 4 * 1024);
    const truncated = parseJson(serialized, null);
    // Keep the correlation key even when a large file list or error is
    // shortened. Retention needs it to protect an unfinished effect.
    const payload = truncated?.truncated && typeof details.operationId === "string"
      ? JSON.stringify({ operationId: details.operationId.slice(0, 128), truncated: true,
        originalBytes: truncated.originalBytes, preview: truncated.preview?.slice(0, 512) ?? "" })
      : serialized;
    db.prepare("INSERT INTO audit_log (action, target, details, created_at) VALUES (?, ?, ?, ?)")
      .run(action, String(details.target ?? "").slice(0, 512), payload, now());
    if (trim && !terminalAuditScan) {
      // A small legacy overflow should be reclaimed by the write that first
      // observes it. Four fixed pages keep an old protected prefix from
      // turning every audit into an unbounded synchronous cleanup.
      for (let page = 0; page < 4; page += 1) {
        if (trimAuditPage(db).complete) break;
      }
    }
  }

  function writeCriticalAudit(action, details = {}) {
    db.transaction(() => {
      reserveRecoveryHeadroom(db, undefined, true);
      writeAudit(action, details);
      reserveRecoveryHeadroom(db);
    }).immediate();
    // A reattached prior-run owner settles in this run; its reservation goes.
    if (terminalReservationsCache && TERMINAL_OUTCOMES.includes(action)) {
      terminalReservationsCache = terminalReservationsCache.filter((entry) => entry.target !== details.target);
    }
  }

  // Within a caller's transaction: only a queued run takes an account.
  function bindRunAccount(runId, account) {
    if (account.id !== defaultProviderAccountId(account.provider) && !db.prepare("SELECT 1 FROM provider_accounts WHERE id = ?").get(account.id)) {
      throw databaseError(409, `The ${account.label} account was removed before this run launched`, { code: "PROVIDER_ACCOUNT_UNAVAILABLE" });
    }
    const bound = db.prepare(`INSERT INTO run_accounts (run_id, account_id, account_label, account_identity, bound_at, home_path)
      SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM runs WHERE id = ? AND status = 'queued')
      ON CONFLICT(run_id) DO UPDATE SET account_id = excluded.account_id, account_label = excluded.account_label,
        account_identity = excluded.account_identity, bound_at = excluded.bound_at, home_path = excluded.home_path`)
      .run(runId, account.id, account.label, account.identity ?? null, now(), account.home ?? null, runId);
    if (!bound.changes) throw databaseError(409, "Only a queued run can be bound to an account", { code: "RUN_ACCOUNT_IMMUTABLE" });
  }

  function beginTerminalAuditScan() {
    // All SQLite work belongs to the tick. A retry timer must never throw
    // synchronously out of a process-level callback on a storage fault.
    terminalAuditScan = { cursor: 0, lastId: null, requests: new Map(), owners: new Map(), outcomes: null, written: 0 };
    terminalAuditCompletion = new Promise((resolve, reject) => {
      completeTerminalAudit = resolve;
      failTerminalAudit = reject;
    });
    // The runtime does not await startup recovery, but an offline caller can.
    // Attach a handler now so a storage failure never becomes an unhandled
    // rejection when no caller is waiting.
    void terminalAuditCompletion.catch(() => {});
    terminalAuditTick = scheduleTerminalAudit(advanceTerminalAuditScan);
  }

  function scheduleCleanupReconciliation(delay = 0) {
    if (closing || cleanupReconciliationTick) return;
    const resume = () => {
      cleanupReconciliationTick = undefined;
      cleanupReconciliationTickKind = undefined;
      if (closing || !db) return;
      try {
        api.reconcilePendingRetentionCleanup();
        cleanupReconciliationRetries = 0;
      } catch (error) {
        try { options.onCleanupReconciliationError?.(error); }
        catch { /* Keep the durable reconciliation owner alive. */ }
        // Leave admission closed after repeated storage failures. Restart or
        // an explicit retry can resume from the durable audit evidence.
        if (cleanupReconciliationRetries < 5) {
          const wait = Math.min(30_000, 1000 * 2 ** cleanupReconciliationRetries++);
          scheduleCleanupReconciliation(wait);
        }
      }
    };
    cleanupReconciliationTickKind = delay ? "timeout" : "immediate";
    cleanupReconciliationTick = delay ? setTimeout(resume, delay) : setImmediate(resume);
  }

  function readTerminalAuditPage(scan) {
    const previousCursor = scan.cursor;
    const rows = db.prepare(`SELECT id, action, substr(target, 1, 512) AS target,
      CASE WHEN octet_length(details) <= 4096 THEN details END AS details FROM audit_log
      WHERE id > ? AND id <= ? ORDER BY id LIMIT 256`).all(scan.cursor, scan.lastId);
    for (const row of rows) applyTerminalAuditRow(scan, row);
    if (rows.length && !db.prepare("SELECT complete FROM audit_evidence_state WHERE id = 1").get().complete) {
      backfillAuditEvidencePage(db, previousCursor, scan.cursor);
    }
    return rows.length;
  }

  function retryTerminalAuditScan(scan, error) {
    if (typeof error?.code !== "string" || !/^SQLITE_(?:BUSY|LOCKED|IOERR|FULL)(?:_|$)/.test(error.code)
      || terminalAuditRetries >= 5) return false;
    const delay = Math.min(30_000, terminalAuditRetryBaseMs * 2 ** Math.min(terminalAuditRetries++, 5));
    terminalAuditRetry = setTimeout(() => {
      terminalAuditRetry = undefined;
      if (!closing && terminalAuditScan === scan) {
        scan.cursor = 0;
        scan.lastId = null;
        scan.requests.clear();
        scan.owners.clear();
        scan.outcomes = null;
        scan.written = 0;
        scan.cleanupReconciled = false;
        scan.error = null;
        terminalAuditTick = scheduleTerminalAudit(advanceTerminalAuditScan);
      }
    }, delay);
    return true;
  }

  function advanceTerminalAuditScan() {
    terminalAuditTick = undefined;
    if (closing || !terminalAuditScan) return;
    const scan = terminalAuditScan;
    try {
      options.beforeTerminalAuditTick?.();
      if (scan.lastId === null) {
        scan.lastId = db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM audit_log").get().id;
        db.prepare("UPDATE audit_retention_cursor SET cursor = 0, sweep_upper = 0 WHERE id = 1").run();
      }
      if (!scan.outcomes) {
        if (readTerminalAuditPage(scan)) { terminalAuditTick = scheduleTerminalAudit(advanceTerminalAuditScan); return; }
        // The read cursor reached the frozen high-water mark. Triggers have
        // indexed every concurrent insert, including direct SQLite writers.
        db.prepare("UPDATE audit_evidence_state SET complete = 1 WHERE id = 1").run();
        scan.outcomes = [
          ...Array.from(scan.requests.values(), (request) => ({ action: request.action === "terminal.create.requested"
            ? "terminal.create.unknown" : "terminal.close.unknown",
          details: { target: request.target, operationId: request.operationId,
            reason: "runtime restarted before terminal outcome", ...request.details } })),
          ...Array.from(scan.owners.values()).filter((owner) => owner.created && !owner.unknownRecorded).map((owner) => ({ action: "terminal.unknown",
            details: { target: owner.target, reason: "runtime restarted before terminal exit was recorded" } })),
        ];
      }
      const batch = scan.outcomes.slice(scan.written, scan.written + 64);
      if (batch.length) {
        db.transaction(() => {
          reserveRecoveryHeadroom(db, undefined, true);
          for (const outcome of batch) writeAudit(outcome.action, outcome.details, false);
          reserveRecoveryHeadroom(db);
        }).immediate();
        scan.written += batch.length;
        terminalAuditTick = scheduleTerminalAudit(advanceTerminalAuditScan);
        return;
      }
      if (cleanupReconciliationPending && !scan.cleanupReconciled) {
        api.reconcilePendingRetentionCleanup();
        // Commit the scan transition only after the inherited requests have
        // received durable outcomes. A failed SQLite write restarts this scan.
        scan.cleanupReconciled = true;
      }
      // Earlier live audit writes did not trim while the cursor was reading
      // that history. Reclaim it in bounded slices before releasing terminal
      // admission; unresolved owner evidence remains protected by trimAudit.
      if (!trimAuditPage(db, 32, scan.lastId).complete) {
        terminalAuditTick = scheduleTerminalAudit(advanceTerminalAuditScan);
        return;
      }
      terminalReservationsCache = [...scan.owners.values()];
      terminalAuditScan = null;
      terminalAuditRetries = 0;
      completeTerminalAudit?.();
      try { options.onTerminalAuditReconciled?.(); }
      catch (error) { options.onTerminalAuditError?.(error); }
    } catch (error) {
      scan.error = error;
      try { options.onTerminalAuditError?.(error); } catch { /* Keep the scan owner alive. */ }
      // A transient read or write failure keeps the original waiter pending
      // across retries. Only an exhausted/fatal scan rejects it.
      if (!retryTerminalAuditScan(scan, error)) failTerminalAudit?.(error);
    }
  }

  const api = {
    filename,
    launchDirectory,
    get maintenanceActive() { return maintenance; },
    get terminalAuditScanPending() { return Boolean(terminalAuditScan); },
    get terminalAuditScanError() { return terminalAuditScan?.error?.message ?? null; },
    waitForTerminalAuditReconciliation() { return terminalAuditCompletion; },
    closeFailedStartup() {
      // The runtime constructor has not yielded to the event loop, so no
      // scheduled deletion worker or migration tick has run. Release both
      // SQLite handles synchronously before a successor acquires the lease.
      if (deletionWorkers.size || maintenance) throw new Error("Startup cleanup found active archive maintenance");
      closing = true;
      if (terminalAuditScan) failTerminalAudit?.(databaseError(503, "Terminal audit recovery stopped during startup cleanup"));
      if (migrationTick) clearImmediate(migrationTick);
      if (migrationRetry) clearTimeout(migrationRetry);
      if (terminalAuditTick) clearImmediate(terminalAuditTick);
      if (terminalAuditRetry) clearTimeout(terminalAuditRetry);
      if (cleanupReconciliationTickKind === "timeout") clearTimeout(cleanupReconciliationTick);
      else if (cleanupReconciliationTickKind === "immediate") clearImmediate(cleanupReconciliationTick);
      if (deletionTickKind === "timeout") clearTimeout(deletionTick);
      else if (deletionTickKind === "immediate") clearImmediate(deletionTick);
      const errors = [];
      try { db?.close(); } catch (error) { errors.push(error); }
      finally { db = undefined; }
      try { leaseDb?.close(); } catch (error) { errors.push(error); }
      finally { leaseDb = undefined; }
      if (errors.length) throw new AggregateError(errors, "Startup storage cleanup failed");
    },
    close: () => {
      if (closing) return deletionWorkers.size ? new Promise((resolve) => closeWaiters.add(resolve)) : Promise.resolve();
      closing = true;
      if (terminalAuditScan) failTerminalAudit?.(databaseError(503, "Terminal audit recovery stopped when the database closed"));
      for (const resolve of deletionIdleWaiters) resolve();
      deletionIdleWaiters.clear();
      if (migrationTick) clearImmediate(migrationTick);
      if (migrationRetry) clearTimeout(migrationRetry);
      if (terminalAuditTick) clearImmediate(terminalAuditTick);
      if (terminalAuditRetry) clearTimeout(terminalAuditRetry);
      if (cleanupReconciliationTickKind === "timeout") clearTimeout(cleanupReconciliationTick);
      else if (cleanupReconciliationTickKind === "immediate") clearImmediate(cleanupReconciliationTick);
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
      const maxPhysicalBytes = maxRetainedBytes * RESOURCE_BUDGETS.physicalDatabaseMultiplier
        + RESOURCE_BUDGETS.physicalRecoveryReserveBytes;
      const availablePhysicalForNewWorkBytes = disk.bytes === null ? 0
        : Math.max(0, maxPhysicalBytes - RESOURCE_BUDGETS.physicalRecoveryReserveBytes - disk.bytes);
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
        maxPhysicalBytes, reservedPhysicalBytes: RESOURCE_BUDGETS.physicalRecoveryReserveBytes,
        maxRunTranscriptItems: RESOURCE_BUDGETS.maxRunTranscriptItems, maxRunTranscriptBytes: RESOURCE_BUDGETS.maxRunTranscriptBytes,
        maxRunEventBytes: MAX_RUN_EVENT_RETAINED_BYTES,
      }, cpuUsage: null, memoryUsage: null, diskAllocatedBytes: disk.bytes,
      availablePhysicalForNewWorkBytes,
      diskUsageStatus: disk.status };
    },
    canLaunchRun() {
      if (runReconciliationPending) return false;
      // Keep enough ordinary retained space for a newly launched run to
      // record its first output. The separate reserve remains for recovery
      // and terminal transitions.
      const capacity = this.capacity();
      const physicalThreshold = capacity.limits.maxPhysicalBytes - capacity.limits.reservedPhysicalBytes;
      let physical;
      try {
        physical = capacity.availablePhysicalForNewWorkBytes < 64 * 1024
          ? physicalUsageForAdmission(physicalThreshold) : { bytes: capacity.diskAllocatedBytes };
      } catch (error) {
        // An unreclaimable WAL is a refusal to admit new work, not a failure
        // of the caller draining queued runs (including child close and timer
        // callbacks). Optional writes still report the 507 to their caller.
        if (error.statusCode === 507) return false;
        throw error;
      }
      // A durable deletion marker protects its own conversation, but does
      // not reserve every free agent slot. Only the short final cutover
      // pauses launches; a long unrelated run may keep an oversized delete
      // deferred without starving the queue.
      return !maintenance && capacity.diskUsageStatus !== "unknown" && capacity.availableForNewWorkBytes >= 64 * 1024
        && physical.bytes !== null && physical.bytes + 64 * 1024 <= physicalThreshold;
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
        WHERE ${archivedConversationSql(db)} AND deleting = 0 AND NOT EXISTS (SELECT 1 FROM runs WHERE conversation_id = conversations.id
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
      const cutoff = this.validateRetentionCutoff(before, limit);
      const ids = db.prepare(`SELECT id FROM conversations WHERE ${archivedConversationSql(db)} AND (deleting = 1 OR (pinned = 0 AND updated_at < ?))
          AND NOT EXISTS (SELECT 1 FROM runs WHERE conversation_id = conversations.id
            AND (status IN ('queued', 'launching', 'running') OR (status = 'interrupted' AND recovery_decision IS NULL)))
          ORDER BY updated_at, id LIMIT ?`).all(cutoff, limit).map((row) => row.id);
      return (async () => {
        const deleted = [];
        let deferred = 0;
        for (const id of ids) {
          try {
            const result = await deleteArchivedInBatches(db, id, deletionsInFlight, { ...deletionContext, automatic: true, cutoff }); // NOSONAR S9382: one archive deletion at a time bounds writer occupancy
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
        const tasksDeleted = await deleteThreadlessArchivedTasks(() => (closing || maintenance ? null : db), cutoff, limit, taskRetentionCursor);
        return { deleted: deleted.length, deferred, ids: deleted, tasksDeleted };
      })();
    },
    validateRetentionCutoff(before, limit = 100) {
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
      return cutoff;
    },
    listSpaces() {
      const spaces = db.prepare("SELECT id, name, position, created_at AS createdAt FROM spaces ORDER BY position, created_at").all();
      const memberships = Object.fromEntries(db.prepare("SELECT project_id, space_id FROM project_memberships").all().map((row) => [row.project_id, row.space_id]));
      return { spaces, memberships };
    },
    ensureDefaultSpaces(projects) {
      // The marker keeps its pre-spaces key so upgraded stores never reseed.
      if (db.prepare("SELECT 1 FROM settings WHERE key = '_defaultGroupsInitialized'").get()) return;
      const existing = this.listSpaces().spaces;
      if (existing.length && !existing.some((space) => ["Core systems", "Experiments"].includes(space.name))) return;
      // Keep both spaces, every discovered membership, and the completion
      // marker in one quota-checked transaction. A failed first scan can be
      // retried after cleanup without leaving a partial default hierarchy.
      withinRetainedBudget(() => {
        const spaces = this.listSpaces().spaces;
        const core = spaces.find((space) => space.name === "Core systems") ?? this.createSpace("Core systems");
        const experiments = spaces.find((space) => space.name === "Experiments") ?? this.createSpace("Experiments");
        const memberships = this.listSpaces().memberships;
        for (const project of projects) {
          if (memberships[project.id]) continue;
          this.setProjectSpace(project.id, /experiment|prototype|playground/i.test(`${project.name} ${project.path}`) ? experiments.id : core.id);
        }
        db.prepare("INSERT INTO settings (key, value) VALUES ('_defaultGroupsInitialized', 'true')").run();
      });
    },
    createSpace(name) {
      if (retainedBytes(db) >= this.getSettings().maxRetainedMiB * 1024 * 1024) {
        throw databaseError(507, "Retained history is full; archive conversations, then delete selected archived chats or clean up older history");
      }
      const id = randomUUID();
      const position = db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS position FROM spaces").get().position;
      withinRetainedBudget(() => db.prepare("INSERT INTO spaces (id, name, position, created_at) VALUES (?, ?, ?, ?)").run(id, name.trim(), position, now()));
      return db.prepare("SELECT id, name, position, created_at AS createdAt FROM spaces WHERE id = ?").get(id);
    },
    updateSpace(id, patch) {
      if (typeof patch.name === "string" && patch.name.trim()) withinRetainedBudget(() => db.prepare("UPDATE spaces SET name = ? WHERE id = ?").run(patch.name.trim(), id));
      if (Number.isInteger(patch.position)) db.prepare("UPDATE spaces SET position = ? WHERE id = ?").run(patch.position, id);
      return db.prepare("SELECT id, name, position, created_at AS createdAt FROM spaces WHERE id = ?").get(id);
    },
    deleteSpace(id) {
      return db.transaction(() => {
        if (db.prepare("SELECT 1 FROM tasks WHERE space_id = ? AND archived = 0 LIMIT 1").get(id)) {
          throw databaseError(409, "Archive or finish this space's tasks before deleting it", { code: "SPACE_HAS_TASKS" });
        }
        if (conversationTasksReady(db)
          && db.prepare("SELECT 1 FROM tasks JOIN conversations ON conversations.task_id = tasks.id WHERE tasks.space_id = ? LIMIT 1").get(id)) {
          throw databaseError(409, "This space still has archived task threads", { code: "SPACE_HAS_TASKS" });
        }
        // Archived space tasks without threads leave with their space.
        db.prepare("DELETE FROM tasks WHERE space_id = ?").run(id);
        return db.prepare("DELETE FROM spaces WHERE id = ?").run(id).changes > 0;
      }).immediate();
    },
    setProjectSpace(projectId, spaceId) {
      if (!spaceId) db.prepare("DELETE FROM project_memberships WHERE project_id = ?").run(projectId);
      else withinRetainedBudget(() => db.prepare("INSERT INTO project_memberships (project_id, space_id) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET space_id = excluded.space_id").run(projectId, spaceId));
    },
    listConversations(filters = {}) {
      const source = conversationSource(db);
      // Visible tabs filter the thread's own archived column first, so the
      // scope index skips the archive backlog before the task check.
      const tasks = conversationTasksReady(db);
      const where = [filters.archived ? (tasks ? "(c.archived = 1 OR t.archived = 1)" : "c.archived = 1")
        : (tasks ? "c.archived = 0 AND t.archived = 0" : "c.archived = 0"), "c.deleting = 0"];
      const values = [];
      if (filters.projectId) { where.push("c.project_id = ?"); values.push(filters.projectId); }
      if (filters.worktreeId) { where.push("c.worktree_id = ?"); values.push(filters.worktreeId); }
      if (filters.taskId && !tasks) return [];
      if (filters.taskId) { where.push("c.task_id = ?"); values.push(filters.taskId); }
      return db.prepare(`${source.sql} WHERE ${where.join(" AND ")} ORDER BY c.pinned DESC, c.tab_position, c.updated_at DESC`).all(...values);
    },
    getConversation(id) {
      return db.prepare(`${conversationSource(db).sql} WHERE c.id = ? AND c.deleting = 0`).get(id);
    },
    // Without a taskId the thread gets its own worktree task in the same
    // transaction, so existing clients keep creating chats unchanged.
    createConversation(input) {
      validateConversationExecution(input);
      if (retainedBytes(db) >= this.getSettings().maxRetainedMiB * 1024 * 1024) {
        throw databaseError(507, "Retained history is full; archive conversations, then delete selected archived chats or clean up older history");
      }
      const id = randomUUID();
      const timestamp = now();
      const title = input.title?.trim() || "New agent chat";
      const position = db.prepare("SELECT COALESCE(MAX(tab_position), -1) + 1 AS position FROM conversations WHERE project_id = ? AND worktree_id = ?").get(input.projectId, input.worktreeId).position;
      withinRetainedBudget(() => {
        let taskId;
        if (input.taskId === undefined || input.taskId === null) taskId = insertThreadTask(db, input, title);
        else {
          taskId = requireThreadTask(db, input.taskId, input);
          db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(timestamp, taskId);
        }
        db.prepare(`INSERT INTO conversations (id, project_id, worktree_id, worktree_path, title, provider, model, tab_position, created_at, updated_at, task_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, input.projectId, input.worktreeId, input.worktreePath, title, input.provider || "codex", input.model || "", position, timestamp, timestamp, taskId);
      });
      return this.getConversation(id);
    },
    updateConversation(id, patch) {
      const { current, archiveOnly } = validateConversationPatch(db, this, id, patch);
      if (archiveOnly && current?.archived) return this.getConversation(id);
      // A native session belongs to the provider that created it. Switching
      // providers starts a new session unless the same edit attaches one.
      const effective = patch.provider !== undefined && current && patch.provider !== current.provider && patch.providerSessionId === undefined
        ? { ...patch, providerSessionId: null } : patch;
      const fields = [];
      const values = [];
      for (const [key, column] of Object.entries({ title: "title", provider: "provider", model: "model", archived: "archived", pinned: "pinned", providerSessionId: "provider_session_id", tabPosition: "tab_position" })) {
        if (effective[key] === undefined) continue;
        fields.push(`${column} = ?`);
        values.push(typeof effective[key] === "boolean" ? Number(effective[key]) : effective[key]);
      }
      // A changed provider or session starts a new session epoch. A run
      // copies its native session to the chat only within the epoch it
      // launched in, so a late finish cannot undo this edit.
      if (current && ((effective.provider !== undefined && effective.provider !== current.provider)
        || (effective.providerSessionId !== undefined && (effective.providerSessionId || null) !== (current.providerSessionId || null)))) {
        fields.push("session_epoch = session_epoch + 1");
      }
      if (fields.length) {
        fields.push("updated_at = ?");
        values.push(now(), id);
        const update = () => {
          db.prepare(`UPDATE conversations SET ${fields.join(", ")} WHERE id = ?`).run(...values);
          return patch.archived === undefined ? null : syncTaskArchive(db, id, patch.archived);
        };
        // Archiving makes old history eligible for cleanup even after the
        // physical new-work gate closes. Use only half of the separate
        // recovery headroom so run and audit outcomes retain space.
        announceTaskArchive(withinRetainedBudget(update, retainedReserveBytes, archiveOnly));
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
        const timestamp = now();
        const current = db.prepare(`SELECT c.task_id AS taskId, c.project_id AS projectId, c.worktree_id AS worktreeId,
          c.worktree_path AS worktreePath, c.title, c.archived, t.archived AS taskArchived
          FROM conversations AS c JOIN tasks AS t ON t.id = c.task_id WHERE c.id = ? AND c.deleting = 0`).get(id);
        if (!current) throw databaseError(409, "Conversation is unavailable for moving");
        // The thread joins a task at its destination: the named one, or else
        // a new task, even in place. A thread hidden by its task stays
        // hidden: a new task is archived with it, and a named open task keeps
        // its siblings visible while the thread archives itself.
        const hidden = Boolean(current.archived || current.taskArchived);
        const named = destination.taskId !== undefined && destination.taskId !== null;
        const taskId = named ? requireThreadTask(db, destination.taskId, destination) : insertThreadTask(db, destination, current.title, hidden);
        const archived = named && hidden ? 1 : current.archived;
        const changed = db.prepare("UPDATE conversations SET project_id = ?, worktree_id = ?, worktree_path = ?, tab_position = ?, updated_at = ?, task_id = ?, archived = ? WHERE id = ? AND deleting = 0")
          .run(destination.projectId, destination.worktreeId, destination.worktreePath, position, timestamp, taskId, archived, id).changes;
        if (!changed) throw databaseError(409, "Conversation is unavailable for moving");
        if (taskId !== current.taskId) {
          db.prepare("UPDATE tasks SET updated_at = ? WHERE id IN (?, ?)").run(timestamp, taskId, current.taskId);
          // Like archiving its last visible thread, moving its last visible
          // thread away hides the old task instead of listing it empty.
          archiveTaskWithoutVisibleThreads(db, current.taskId, timestamp);
        }
      });
      return this.getConversation(id);
    },
    // Task contract for dependents. A task row carries its immutable scope,
    // title, objective, origin, userStatus and archived flag, plus a status
    // derived from its threads' runs on every read: running, waiting, idle,
    // or done when the user finished it. tasks.changed names the ids whose
    // row, threads or derived status changed. A task's lifecycle follows its
    // last visible thread whatever its origin: archiving or moving away that
    // thread hides the task, and retention deletes an archived task with its
    // last thread, or once threadless after the retention window. A move
    // without taskId always starts a new task at the destination, even in
    // place, and never restores a hidden thread.
    listTasks(filters = {}) {
      assertTasksReady(db);
      const limit = filters.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw databaseError(400, "Task page size must be 1 to 100");
      const after = decodePageCursor(filters.cursor, "Task cursor is invalid");
      const where = ["t.archived = ?"];
      const values = [filters.archived ? 1 : 0];
      for (const key of ["spaceId", "projectId", "worktreeId", "scopeKind", "status"]) {
        if (filters[key] !== undefined && filters[key] !== null && (typeof filters[key] !== "string" || !filters[key] || Buffer.byteLength(filters[key]) > TASK_SCOPE_ID_BYTES)) {
          throw databaseError(400, `Task ${key} filter is invalid`);
        }
      }
      // A space lists its own tasks and those of the projects filed in it.
      if (filters.spaceId) {
        where.push("(t.space_id = ? OR t.project_id IN (SELECT project_id FROM project_memberships WHERE space_id = ?))");
        values.push(filters.spaceId, filters.spaceId);
      }
      if (filters.projectId) { where.push("t.project_id = ?"); values.push(filters.projectId); }
      if (filters.worktreeId) { where.push("t.worktree_id = ?"); values.push(filters.worktreeId); }
      if (filters.scopeKind) {
        if (!["space", "project", "worktree"].includes(filters.scopeKind)) throw databaseError(400, "Task scope kind must be space, project, or worktree");
        where.push("t.scope_kind = ?");
        values.push(filters.scopeKind);
      }
      if (filters.status === "open") where.push("t.user_status = 'open'");
      else if (filters.status) {
        if (!["running", "waiting", "idle", "done"].includes(filters.status)) throw databaseError(400, "Task status must be running, waiting, idle, done, or open");
        // Running and waiting tasks are found from the unsettled runs alone.
        if (filters.status === "running" || filters.status === "waiting") where.push("u.level IS NOT NULL");
        where.push(`${TASK_STATUS_SQL} = ?`);
        values.push(filters.status);
      }
      if (after) { where.push("(t.updated_at < ? OR (t.updated_at = ? AND t.id < ?))"); values.push(after[0], after[0], after[1]); }
      const rows = db.prepare(`${taskSelectSql()} WHERE ${where.join(" AND ")} ORDER BY t.updated_at DESC, t.id DESC LIMIT ?`).all(...values, limit + 1);
      return boundedTaskPage(rows, limit);
    },
    getTask(id, { threads = false } = {}) {
      assertTasksReady(db);
      const task = hydrateTask(db.prepare(`${taskSelectSql(true)} WHERE t.id = ?`).get(id, id));
      if (!task || !threads) return task;
      // Thread summaries are projected short in SQLite and capped by bytes,
      // so legacy multi-MiB titles never reach the response in full. Threads
      // share the task's scope; complete rows stay on the conversation routes.
      const rows = db.prepare(`SELECT c.id, c.task_id AS taskId, substr(c.title, 1, ${TASK_TITLE_CHARACTERS}) AS title, substr(c.provider, 1, ${TASK_THREAD_FIELD_CHARACTERS}) AS provider,
          substr(c.model, 1, ${TASK_THREAD_FIELD_CHARACTERS}) AS model, ${conversationSource(db).archived} AS archived, c.pinned,
          c.tab_position AS tabPosition, c.created_at AS createdAt, c.updated_at AS updatedAt
        FROM conversations AS c JOIN tasks AS t ON t.id = c.task_id
        WHERE c.task_id = ? AND c.deleting = 0 ORDER BY c.created_at, c.rowid LIMIT ?`).all(id, TASK_THREAD_LIMIT);
      const listed = [];
      let threadBytes = 0;
      for (const row of rows) {
        const bytes = Buffer.byteLength(JSON.stringify(row)) + 1;
        if (threadBytes + bytes > TASK_THREAD_BYTES) break;
        listed.push(row);
        threadBytes += bytes;
      }
      return { ...task, threads: listed, threadsTruncated: task.threadCount > listed.length };
    },
    createTask(input) {
      assertTasksReady(db);
      const task = normalizeTaskInput(input);
      const id = withinRetainedBudget(() => {
        if (task.spaceId && !db.prepare("SELECT 1 FROM spaces WHERE id = ?").get(task.spaceId)) throw databaseError(404, "Space not found");
        return insertTask(db, task);
      });
      return this.getTask(id);
    },
    // A task's scope never changes after creation; threads move between tasks
    // instead. Archiving hides its threads and never deletes them.
    updateTask(id, patch) {
      assertTasksReady(db);
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw databaseError(400, "Task update must be a JSON object");
      const columns = { title: "title", objective: "objective", status: "user_status", archived: "archived" };
      for (const key of Object.keys(patch)) {
        if (!Object.hasOwn(columns, key)) throw databaseError(400, ["scopeKind", "spaceId", "projectId", "worktreeId", "worktreePath", "origin"].includes(key)
          ? "Task scope and origin cannot be changed" : `Unknown task field: ${key}`);
      }
      const values = {};
      if (patch.title !== undefined) values.title = boundedText(patch.title, "Task title", TASK_TITLE_CHARACTERS);
      if (patch.objective !== undefined) values.objective = taskObjective(patch.objective);
      if (patch.status !== undefined) {
        if (!["open", "done"].includes(patch.status)) throw databaseError(400, "Task status must be open or done");
        values.status = patch.status;
      }
      if (patch.archived !== undefined) {
        if (typeof patch.archived !== "boolean") throw databaseError(400, "Task archived state must be a boolean");
        values.archived = Number(patch.archived);
      }
      if (!db.prepare("SELECT 1 FROM tasks WHERE id = ?").get(id)) return null;
      const entries = Object.entries(values);
      if (!entries.length) return this.getTask(id);
      const archiveOnly = entries.length === 1 && values.archived === 1;
      announceTaskArchive(withinRetainedBudget(() => {
        if (values.archived === 1 && db.prepare(`SELECT 1 FROM conversations AS c JOIN runs AS r ON r.conversation_id = c.id
          WHERE c.task_id = ? AND r.status = 'interrupted' AND r.recovery_decision IS NULL LIMIT 1`).get(id)) {
          throw databaseError(409, "Resolve the interrupted run before archiving this task", { code: "RUN_RECOVERY_REQUIRED" });
        }
        const timestamp = now();
        const wasArchived = db.prepare("SELECT archived FROM tasks WHERE id = ?").get(id)?.archived;
        db.prepare(`UPDATE tasks SET ${entries.map(([key]) => `${columns[key]} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
          .run(...entries.map(([, value]) => value), timestamp, id);
        if (wasArchived === undefined || values.archived === undefined || values.archived === wasArchived) return null;
        // Hiding or showing threads through their task stamps them like a
        // direct archive or restore, so retention ages both the same way.
        db.prepare("UPDATE conversations SET updated_at = ? WHERE task_id = ? AND archived = 0 AND deleting = 0").run(timestamp, id);
        return taskArchiveChange(db, id, values.archived === 1);
      }, retainedReserveBytes, archiveOnly));
      return this.getTask(id);
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
      const upsert = () => withinRetainedBudget(() => writeMessage(message));
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
        // A retry is still new queued work. Keep the interrupted evidence
        // intact until physical usage can be measured and budgeted again.
        requireOptionalPhysicalCapacity();
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
        output_tokens AS outputTokens, recovery_class AS recoveryClass, recovery_decision AS recoveryDecision, transcript_omitted AS transcriptOmitted,
        ${RUN_ACCOUNT_FIELDS} FROM runs ${RUN_ACCOUNT_JOINS} WHERE id = ?`).get(id);
    },
    listRuns(conversationId, limit = 200) {
      const boundedLimit = Math.max(1, Math.min(500, Number(limit) || 200));
      return db.prepare(`SELECT id, conversation_id AS conversationId, worktree_path AS worktreePath, provider, model, reasoning_effort AS reasoningEffort, approval_policy AS approvalPolicy,
        prompt, status, pid, provider_session_id AS providerSessionId, created_at AS createdAt, started_at AS startedAt,
        finished_at AS finishedAt, exit_code AS exitCode, error, cost_usd AS costUsd, input_tokens AS inputTokens,
        output_tokens AS outputTokens, recovery_class AS recoveryClass, recovery_decision AS recoveryDecision, transcript_omitted AS transcriptOmitted,
        ${RUN_ACCOUNT_FIELDS} FROM runs ${RUN_ACCOUNT_JOINS}
        WHERE conversation_id = ? ORDER BY runs.created_at DESC, runs.rowid DESC LIMIT ?`).all(conversationId, boundedLimit);
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
    savePendingRunOutcome(runId, outcome) {
      saveRunOutcome(launchDirectory, runId, outcome);
    },
    removePendingRunOutcome(runId) {
      removeRunOutcome(launchDirectory, runId);
    },
    validateRecoveredRunOutcome(run, outcome) {
      const message = outcome?.transcriptMessage;
      if (!message) return;
      const existing = db.prepare(`SELECT conversation_id AS conversationId, role, kind, payload,
        created_at AS createdAt FROM messages WHERE id = ?`).get(message.id);
      if (message.conversationId === run.conversationId
        && (!existing || (existing.conversationId === run.conversationId
          && existing.role === "assistant" && existing.kind === "text"
          && parseJson(existing.payload, null)?.runId === run.id
          && existing.createdAt === message.createdAt))) return;
      const error = new Error(`Invalid run outcome record: ${run.id}`);
      error.code = "OUTRIGHT_INVALID_RUN_OUTCOME";
      throw error;
    },
    // Crash-consistent restart reconciliation: queued/running rows belong to a
    // dead runtime, so none of them can ever finish under this process. Mark
    // them "interrupted" with a best-effort process classification instead of
    // failing them outright, and leave the continuation decision to the
    // operator so uncertain side effects are never silently retried.
    // A caller-owned progress accumulator receives each batch's counts only
    // after that batch commits, so a later failed batch cannot erase rows an
    // earlier batch already reconciled.
    reconcileInterruptedRuns({ probeAlive = defaultProbeRun, yieldBetweenBatches = false, signal, progress } = {}) {
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
        const pending = db.prepare("SELECT id, conversation_id AS conversationId, status, pid FROM runs WHERE status IN ('queued', 'running', 'launching') ORDER BY rowid LIMIT 64").all();
        const batch = {};
        for (const run of pending) {
          // The owner may have observed provider close while SQLite refused
          // its terminal transaction. Its fsynced bounded result is stronger
          // evidence than a dead-process probe or a later Stop request.
          let outcome;
          let invalidOutcome = false;
          let outcomeReadUnavailable = false;
          try {
            outcome = readRunOutcome(launchDirectory, run.id);
            this.validateRecoveredRunOutcome(run, outcome);
          } catch (error) {
            // One corrupt sidecar cannot prevent other runs from recovering.
            // Keep both the sidecar and the interrupted row for inspection.
            if (error.code !== "OUTRIGHT_INVALID_RUN_OUTCOME") outcomeReadUnavailable = true;
            else invalidOutcome = true;
            outcome = null;
          }
          if (outcome) {
            let transcriptOmitted = Boolean(outcome.transcriptOmitted);
            if (outcome.transcriptMessage && !replayOutcomeTranscript(outcome.transcriptMessage)) transcriptOmitted = true;
            const result = db.prepare(`UPDATE runs SET status = ?, pid = NULL, finished_at = ?, exit_code = ?, error = ?,
              transcript_omitted = CASE WHEN transcript_omitted = 1 OR ? THEN 1 ELSE 0 END
              WHERE id = ? AND status IN ('queued', 'running', 'launching')`).run(
              outcome.status, outcome.finishedAt, outcome.exitCode, outcome.message || null, transcriptOmitted ? 1 : 0, run.id);
            if (result.changes) {
              writeCriticalAudit(`agent.run.${outcome.status}`, {
                target: run.id, exitCode: outcome.exitCode, error: outcome.message || undefined,
              });
              batch[outcome.status] = (batch[outcome.status] ?? 0) + 1;
            }
            continue;
          }
          let classification = "unknown";
          let pid = run.pid ?? null;
          // A queued row was never authorized to launch. A launching row
          // cannot authorize its wrapper until the running state commits.
          // Corrupt terminal evidence must remain available for inspection,
          // but it does not turn these durable pre-launch facts into a live
          // process tree that no recovery policy can ever resolve.
          if (outcomeReadUnavailable) {
            classification = `outcome-unreadable-${run.status}`;
            if (run.status === "launching") {
              const handshake = readLaunchHandshake(launchDirectory, run.id);
              if (handshake) pid = handshake.pid;
            }
          }
          else if (run.status === "queued") classification = "never-started";
          else if (run.status === "launching") {
            classification = "never-started";
            const handshake = readLaunchHandshake(launchDirectory, run.id);
            if (handshake) pid = handshake.pid;
          } else if (!invalidOutcome) {
            if (run.pid != null) {
              const handshake = readLaunchHandshake(launchDirectory, run.id);
              classification = handshake?.completed === true
                && handshake.authorized === true
                && handshake.pid === run.pid
                ? "exited"
                : normalizeProbeResult(probeAlive(run.pid, handshake, run));
            }
          }
          const result = db.prepare("UPDATE runs SET status = 'interrupted', pid = ?, finished_at = ?, recovery_class = ? WHERE id = ? AND status IN ('queued', 'running', 'launching')")
            .run(pid, finishedAt, classification, run.id);
          if (!result.changes) continue;
          if (invalidOutcome) writeCriticalAudit("agent.run.outcome.invalid", { target: run.id });
          if (outcomeReadUnavailable) writeCriticalAudit("agent.run.outcome.unreadable", { target: run.id });
          batch[classification] = (batch[classification] ?? 0) + 1;
        }
        return { selected: pending.length, batch };
      });
      const reconcileBatch = () => {
        const { selected, batch } = reconcile.immediate();
        for (const [classification, classified] of Object.entries(batch)) {
          counts[classification] = (counts[classification] ?? 0) + classified;
          if (progress) {
            progress.counts[classification] = (progress.counts[classification] ?? 0) + classified;
            progress.count += classified;
          }
        }
        return selected > 0;
      };
      const finish = () => {
        // Preserve unresolved live/unknown ownership evidence across repeated
        // restarts; sweep adopted and stale records without retaining every run
        // ID or directory entry in memory.
        sweepLaunchHandshakes(launchDirectory, db);
        const count = Object.values(counts).reduce((sum, classified) => sum + classified, 0);
        return { count, counts };
      };
      if (!yieldBetweenBatches) {
        while (reconcileBatch()) { /* Each committed batch is recoverable after interruption. */ }
        return finish();
      }
      runReconciliationPending = true;
      return (async () => {
        try {
          while (true) {
            if (signal?.aborted || closing) throw databaseError(503, "Run reconciliation was interrupted");
            if (!reconcileBatch()) break;
            await new Promise((resolve) => setImmediate(resolve)); // NOSONAR S9382: yields after each committed reconciliation batch
          }
          return finish();
        } finally { runReconciliationPending = false; }
      })();
    },
    retryUnreadableRunOutcome(id) {
      const run = this.getRun(id);
      if (run?.status !== "interrupted" || run.recoveryDecision
        || !run.recoveryClass?.startsWith("outcome-unreadable-")) return null;
      let outcome;
      let invalid = false;
      try {
        outcome = readRunOutcome(launchDirectory, id);
        this.validateRecoveredRunOutcome(run, outcome);
      } catch (error) {
        if (error.code === "OUTRIGHT_INVALID_RUN_OUTCOME") invalid = true;
        else throw databaseError(503, "Run outcome evidence is temporarily unreadable; retry after storage recovers");
      }
      if (invalid || !outcome) {
        const originalStatus = run.recoveryClass.slice("outcome-unreadable-".length);
        const recoveryClass = originalStatus === "running" ? "unknown" : "never-started";
        const classify = db.transaction(() => {
          const updated = db.prepare("UPDATE runs SET recovery_class = ? WHERE id = ? AND status = 'interrupted' AND recovery_class = ?")
            .run(recoveryClass, id, run.recoveryClass);
          if (invalid && updated.changes) writeCriticalAudit("agent.run.outcome.invalid", { target: id });
        });
        classify.immediate();
        return this.getRun(id);
      }
      const settle = db.transaction(() => {
        let transcriptOmitted = Boolean(outcome.transcriptOmitted);
        if (outcome.transcriptMessage && !replayOutcomeTranscript(outcome.transcriptMessage)) transcriptOmitted = true;
        const updated = db.prepare(`UPDATE runs SET status = ?, pid = NULL, finished_at = ?, exit_code = ?, error = ?,
          transcript_omitted = CASE WHEN transcript_omitted = 1 OR ? THEN 1 ELSE 0 END
          WHERE id = ? AND status = 'interrupted' AND recovery_class = ? AND recovery_decision IS NULL`)
          .run(outcome.status, outcome.finishedAt, outcome.exitCode, outcome.message || null,
            transcriptOmitted ? 1 : 0, id, run.recoveryClass);
        if (updated.changes) writeCriticalAudit(`agent.run.${outcome.status}`, {
          target: id, exitCode: outcome.exitCode, error: outcome.message || undefined,
        });
        return updated.changes;
      });
      if (settle.immediate()) {
        try { removeRunOutcome(launchDirectory, id); } catch { /* Retry at startup. */ }
      }
      return this.getRun(id);
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
      // The decision is durable before deleting its now-inapplicable sidecar.
      // A failed unlink is retried by the startup sweep.
      try { removeRunOutcome(launchDirectory, id); } catch { /* Retry at startup. */ }
      return this.getRun(id);
    },
    // `model` replaces a stored model only when the caller corrects one that
    // can no longer launch; the interrupted run keeps its original record.
    beginInterruptedRunRecovery(id, decision, { providerSessionId, model } = {}) {
      if (!["resume-session", "retry"].includes(decision)) return null;
      if (providerSessionId != null && !isProviderSessionId(providerSessionId)) {
        throw databaseError(400, "Provider session id is invalid", { code: "PROVIDER_SESSION_INVALID" });
      }
      if (model !== undefined && !isModelName(model)) throw databaseError(400, MODEL_NAME_REQUIREMENT, { code: "PROVIDER_CONFIGURATION_INVALID" });
      const recover = db.transaction(() => {
        const interrupted = this.getRun(id);
        if (!interrupted || interrupted.status !== "interrupted" || interrupted.recoveryDecision) return null;
        const result = db.prepare("UPDATE runs SET recovery_decision = ?, finished_at = ? WHERE id = ? AND status = 'interrupted' AND recovery_decision IS NULL")
          .run(decision, now(), id);
        if (!result.changes) return null;
        const conversation = this.getConversation(interrupted.conversationId);
        if (conversation?.provider === interrupted.provider) {
          // Either decision starts a new session epoch, so a late write from
          // the interrupted run cannot replace the session chosen here.
          if (decision === "retry") this.updateConversation(interrupted.conversationId, { providerSessionId: null });
          else if (providerSessionId && conversation.providerSessionId !== providerSessionId) this.updateConversation(interrupted.conversationId, { providerSessionId });
        }
        const run = this.createRun({
          conversationId: interrupted.conversationId,
          worktreePath: interrupted.worktreePath,
          provider: interrupted.provider,
          model: model ?? interrupted.model,
          reasoningEffort: interrupted.reasoningEffort,
          approvalPolicy: interrupted.approvalPolicy,
          prompt: interrupted.prompt,
          providerSessionId: decision === "resume-session" ? providerSessionId : null,
        });
        // The recovery continues on the interrupted run's account. The pin is
        // durable, so a restart before it launches cannot lose it. A run that
        // launched before accounts used the default login in an unrecorded
        // home; a run that never launched has no account to keep.
        const pin = interrupted.accountId ? [interrupted.accountId, interrupted.accountHome, 1]
          : interrupted.accountPinId ? [interrupted.accountPinId, interrupted.accountPinHome, interrupted.accountPinHomeKnown]
            : interrupted.startedAt ? [defaultProviderAccountId(interrupted.provider), null, 0] : null;
        if (pin) db.prepare("INSERT INTO run_account_pins (run_id, account_id, home_path, home_known) VALUES (?, ?, ?, ?)").run(run.id, ...pin);
        writeCriticalAudit(`agent.run.recovery.${decision}`, { target: run.id, recoveredFrom: id, conversationId: interrupted.conversationId, recoveryClass: interrupted.recoveryClass,
          ...(model !== undefined && model !== interrupted.model ? { modelCorrected: true } : {}) });
        return { interrupted: this.getRun(id), run: this.getRun(run.id), conversation: this.getConversation(interrupted.conversationId) };
      });
      const result = recover.immediate();
      if (result) {
        try { removeRunOutcome(launchDirectory, id); } catch { /* Retry at startup. */ }
      }
      return result;
    },
    // `account` binds the run's account (bindRunAccount) in the same
    // transaction as the patch, so the launch marker and the account record
    // commit together or not at all.
    updateRun(id, patch, { account = null } = {}) {
      const { criticalFields, criticalValues, optionalFields, optionalValues } = runPatchAssignments(patch);
      const criticalUpdate = () => { if (criticalFields.length) db.prepare(`UPDATE runs SET ${criticalFields.join(", ")} WHERE id = ?`).run(...criticalValues, id); };
      const optionalUpdate = () => { if (optionalFields.length) withinRetainedBudget(() => db.prepare(`UPDATE runs SET ${optionalFields.join(", ")} WHERE id = ?`).run(...optionalValues, id)); };
      // A mixed update commits its state even if optional usage telemetry is
      // refused. Usage alone reports the quota error to its caller.
      if (account || (criticalFields.length && optionalFields.length)) {
        db.transaction(() => {
          if (account) bindRunAccount(id, account);
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
    // Copies a run's native session to its chat only while the chat still
    // has the run's provider and the session epoch the run launched in.
    adoptConversationSession(conversationId, { provider, sessionEpoch, providerSessionId }) {
      if (!Number.isInteger(sessionEpoch) || !providerSessionId) return false;
      return withinRetainedBudget(() => db.prepare(`UPDATE conversations SET provider_session_id = ?, updated_at = ?
        WHERE id = ? AND provider = ? AND session_epoch = ? AND deleting = 0`).run(providerSessionId, now(), conversationId, provider, sessionEpoch).changes > 0);
    },
    finishRun(id, patch, transcriptMessage = null, { sessionEpoch } = {}) {
      const finish = db.transaction(() => {
        let message = null;
        if (transcriptMessage) {
          try { message = this.upsertMessage(transcriptMessage); }
          catch (error) { if (error.statusCode !== 507) throw error; }
        }
        // The terminal state and the evidence of its omitted final checkpoint
        // must survive the same commit, including a crash immediately after it.
        const run = this.updateRun(id, message || !transcriptMessage ? patch : { ...patch, transcriptOmitted: true });
        // The chat's resume token is optional metadata. It obeys the retained
        // budget in a savepoint, so a refusal leaves the terminal commit and
        // the run's own session evidence intact.
        let sessionMetadataRefused = false;
        if (patch.providerSessionId) {
          try {
            this.adoptConversationSession(run.conversationId, { provider: run.provider, sessionEpoch, providerSessionId: patch.providerSessionId });
          } catch (error) {
            if (error.statusCode !== 507) throw error;
            sessionMetadataRefused = true;
          }
        }
        writeCriticalAudit(`agent.run.${patch.status}`, { target: id, exitCode: patch.exitCode, error: patch.error || undefined });
        return { run, message, sessionMetadataRefused };
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
      // Reclaim an idle WAL before the atomic event/checkpoint transaction;
      // SQLite cannot truncate its own WAL from inside that transaction.
      try { physicalUsageForAdmission(configuredRetainedLimitBytes() * RESOURCE_BUDGETS.physicalDatabaseMultiplier); }
      catch (error) {
        if (error.statusCode !== 507) throw error;
        this.updateRun(runId, { transcriptOmitted: true });
        return { event: null, message: null };
      }
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
      // Repository setup and teardown commands are trusted per project too.
      const lifecycle = db.prepare("DELETE FROM trusted_lifecycle_configs WHERE project_id = ?").run(projectId);
      if (result.changes || lifecycle.changes) writeCriticalAudit("project.untrusted", { target: projectId });
    }).immediate(); },
    // Trust in a worktree lifecycle configuration binds the project's identity
    // and path to the exact bytes the user reviewed. A project keeps its most
    // recent trusted versions, so branches with different configs coexist.
    trustLifecycleConfig(projectId, projectPath, digest) {
      withinRetainedBudget(() => {
        db.prepare(`INSERT INTO trusted_lifecycle_configs (project_id, project_path, config_digest, trusted_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(project_id, config_digest) DO UPDATE SET project_path = excluded.project_path, trusted_at = excluded.trusted_at`)
          .run(projectId, projectPath, digest, now());
        db.prepare(`DELETE FROM trusted_lifecycle_configs WHERE project_id = ? AND config_digest NOT IN (
          SELECT config_digest FROM trusted_lifecycle_configs WHERE project_id = ? ORDER BY trusted_at DESC, config_digest LIMIT ?)`)
          .run(projectId, projectId, MAX_TRUSTED_LIFECYCLE_CONFIGS);
        writeAudit("worktree.lifecycle.trusted", { target: projectId, path: projectPath, digest });
      });
    },
    isLifecycleConfigTrusted(projectId, projectPath, digest) {
      const row = db.prepare("SELECT project_path FROM trusted_lifecycle_configs WHERE project_id = ? AND config_digest = ?").get(projectId, digest);
      return row?.project_path === projectPath;
    },
    listWorktreeLifecycle() {
      // Oldest first, so the service's retention gives way in the same order.
      return db.prepare("SELECT state FROM worktree_lifecycle ORDER BY updated_at, worktree_path DESC").all()
        .map((row) => parseJson(row.state, null)).filter(Boolean);
    },
    // Lifecycle state is the durable record of a setup or teardown outcome.
    // Like a critical audit it may spend the recovery reserve: a state the
    // user must act on cannot be dropped at the quota edge. Each state is
    // bounded by the lifecycle service, and only the newest settled states are kept.
    saveWorktreeLifecycle(state) {
      db.transaction(() => {
        reserveRecoveryHeadroom(db, undefined, true);
        db.prepare(`INSERT INTO worktree_lifecycle (worktree_path, project_id, state, updated_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(worktree_path) DO UPDATE SET project_id = excluded.project_id, state = excluded.state, updated_at = excluded.updated_at`)
          .run(state.worktreePath, state.projectId, JSON.stringify(state), state.updatedAt ?? now());
        // Retention never drops a state something still depends on.
        db.prepare(`DELETE FROM worktree_lifecycle WHERE NOT (${LIFECYCLE_STATE_KEPT}) AND worktree_path NOT IN (
          SELECT worktree_path FROM worktree_lifecycle ORDER BY updated_at DESC, worktree_path LIMIT ?)`).run(MAX_WORKTREE_LIFECYCLE_STATES);
        reserveRecoveryHeadroom(db);
      }).immediate();
    },
    deleteWorktreeLifecycle(worktreePath) {
      db.transaction(() => {
        reserveRecoveryHeadroom(db, undefined, true);
        db.prepare("DELETE FROM worktree_lifecycle WHERE worktree_path = ?").run(worktreePath);
        reserveRecoveryHeadroom(db);
      }).immediate();
    },
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
          await new Promise((resolve) => deletionIdleWaiters.add(resolve)); // NOSONAR S9382: the audit retry waits for the active deletion worker
        }
      }
    },
    async auditRetentionCleanupRequested(details) {
      while (true) {
        if (closing) throw databaseError(503, "Runtime closed before retention cleanup could start");
        if (maintenance || !db) {
          if (!deletionWorkers.size) throw databaseError(503, "Archive maintenance is running; retry shortly");
          await new Promise((resolve) => deletionIdleWaiters.add(resolve));
          continue;
        }
        if (cleanupReconciliationPending || !db.prepare("SELECT complete FROM audit_evidence_state WHERE id = 1").get()?.complete) {
          throw databaseError(503, "Retention cleanup recovery is still running; retry shortly");
        }
        try {
          // A cleanup request is a new effect, even if it finds nothing to
          // delete. Keep its audit out of the physical recovery reserve so
          // already admitted cleanups and terminal outcomes can still finish.
          requireOptionalPhysicalCapacity();
          db.transaction(() => {
            if (db.prepare(`SELECT 1 FROM (${pendingCleanupSql}) LIMIT ?`).all(MAX_PENDING_RETENTION_CLEANUPS).length
              >= MAX_PENDING_RETENTION_CLEANUPS) {
              throw databaseError(429, "Too many interrupted retention requests; retry after recovery");
            }
            writeCriticalAudit("retention.cleanup.requested", details);
          }).immediate();
          return;
        } catch (error) {
          if (!deletionWorkers.size || !["SQLITE_BUSY", "SQLITE_LOCKED"].includes(error.code)) throw error;
          await new Promise((resolve) => deletionIdleWaiters.add(resolve)); // NOSONAR S9382: the cleanup audit retry waits for the active deletion worker
        }
      }
    },
    reconcilePendingRetentionCleanup() {
      // This runtime owns the database lease. A request without an outcome
      // after restart may have partly deleted an archive, so report unknown.
      cleanupReconciliationPending = true;
      if (!db.prepare("SELECT complete FROM audit_evidence_state WHERE id = 1").get()?.complete) {
        if (!terminalAuditScan) beginTerminalAuditScan();
        return 0;
      }
      options.beforeCleanupReconciliation?.();
      // Direct SQLite writers can bypass API admission. Resolve at most one
      // page per event-loop turn and leave new cleanup requests closed until
      // the entire inherited backlog has a durable outcome.
      const { count, more } = db.transaction(() => {
        const pending = db.prepare(`${pendingCleanupSql} ORDER BY request.id LIMIT ?`)
          .all(MAX_PENDING_RETENTION_CLEANUPS);
        for (const row of pending) writeCriticalAudit("retention.cleanup.unknown", {
          operationId: row.operationId, reason: "runtime restarted before cleanup outcome",
        });
        // This second indexed lookup observes the page's outcomes and fences
        // a direct writer with the same SQLite write transaction.
        return { count: pending.length, more: Boolean(db.prepare(`${pendingCleanupSql} LIMIT 1`).get()) };
      }).immediate();
      if (more) scheduleCleanupReconciliation();
      else cleanupReconciliationPending = false;
      return count;
    },
    reconcileTerminalAudit() {
      if (terminalReservationsCache) return 0;
      if (terminalAuditScan?.error && !terminalAuditRetry) {
        terminalAuditScan = null;
        terminalAuditRetries = 0;
        beginTerminalAuditScan();
        return 0;
      }
      if (terminalAuditScan) return 0;
      // Reconstruct every inherited owner through the same indexed cursor,
      // including histories below the old 2,048-row threshold. Correlated
      // synchronous lookups could monopolize startup at that boundary.
      beginTerminalAuditScan();
      return 0;
    },
    terminalUnknownReservations() {
      if (terminalAuditScan) return [];
      if (terminalReservationsCache) return terminalReservationsCache.map((entry) => ({ ...entry }));
      // The lease owner cannot prove that a previous owner's orphaned PTY
      // tree died. Read one more than the largest permitted terminal quota,
      // so an old backlog cannot silently undercharge a larger configuration.
      // A verified exit/close is the only release signal.
      return db.prepare(`SELECT target, MAX(cwd) AS cwd,
          MAX(ownershipLabel) AS ownershipLabel, MAX(handshakePath) AS handshakePath,
          MAX(pid) AS pid, MAX(processIdentity) AS processIdentity,
          MAX(created) AS created FROM (
        SELECT entry.target AS target,
          CASE WHEN json_valid(entry.details) THEN json_extract(entry.details, '$.cwd') END AS cwd,
          CASE WHEN json_valid(entry.details) THEN json_extract(entry.details, '$.ownershipLabel') END AS ownershipLabel,
          CASE WHEN json_valid(entry.details) THEN json_extract(entry.details, '$.handshakePath') END AS handshakePath,
          CASE WHEN json_valid(entry.details) THEN json_extract(entry.details, '$.pid') END AS pid,
          CASE WHEN json_valid(entry.details) THEN json_extract(entry.details, '$.processIdentity') END AS processIdentity,
          CASE WHEN entry.action = 'terminal.created' THEN 1 ELSE 0 END AS created
        FROM audit_log AS entry
        WHERE entry.action IN ('terminal.create.requested', 'terminal.created', 'terminal.create.unknown')
          AND NOT EXISTS (SELECT 1 FROM audit_log AS outcome WHERE outcome.id > entry.id
            AND outcome.target = entry.target
            AND outcome.action IN ('terminal.create.failed', 'terminal.exited', 'terminal.closed', 'terminal.recovered'))
      ) GROUP BY target LIMIT 257`).all();
    },
    resolveTerminalUnknown(target, evidence) {
      if (typeof target !== "string" || !/^[0-9a-f-]{36}$/i.test(target)
        || typeof evidence !== "string" || !evidence.trim() || Buffer.byteLength(evidence) > 2048) {
        throw databaseError(400, "A terminal id and bounded verification evidence are required");
      }
      if (!this.terminalUnknownReservations().some((entry) => entry.target === target)) {
        throw databaseError(404, "Unresolved terminal reservation was not found");
      }
      writeCriticalAudit("terminal.recovered", { target, evidence: evidence.trim() });
      if (terminalReservationsCache) terminalReservationsCache = terminalReservationsCache.filter((entry) => entry.target !== target);
      return true;
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
    // Provider accounts store a CLI home directory reference, never a
    // credential. Each provider's default account is implicit.
    listProviderAccounts() { return db.prepare(`SELECT ${PROVIDER_ACCOUNT_FIELDS} FROM provider_accounts ORDER BY provider, created_at, id`).all(); },
    getProviderAccount(id) { return db.prepare(`SELECT ${PROVIDER_ACCOUNT_FIELDS} FROM provider_accounts WHERE id = ?`).get(id) ?? null; },
    createProviderAccount({ provider, label, homePath }) {
      const id = randomUUID();
      withinRetainedBudget(() => {
        if (db.prepare("SELECT COUNT(*) AS count FROM provider_accounts WHERE provider = ?").get(provider).count >= MAX_ACCOUNTS_PER_PROVIDER) {
          throw databaseError(409, `A provider can have at most ${MAX_ACCOUNTS_PER_PROVIDER} added accounts`, { code: "PROVIDER_ACCOUNT_LIMIT" });
        }
        if (db.prepare("SELECT 1 FROM provider_accounts WHERE provider = ? AND home_path = ?").get(provider, homePath)) {
          throw databaseError(409, "That directory is already an account for this provider", { code: "PROVIDER_ACCOUNT_DUPLICATE" });
        }
        if (db.prepare("SELECT 1 FROM provider_accounts WHERE provider = ? AND label = ? COLLATE NOCASE").get(provider, label)) {
          throw databaseError(409, "Another account for this provider has that name", { code: "PROVIDER_ACCOUNT_DUPLICATE" });
        }
        db.prepare("INSERT INTO provider_accounts (id, provider, label, home_path, created_at) VALUES (?, ?, ?, ?, ?)").run(id, provider, label, homePath, now());
        writeAudit("provider-account.added", { target: id, provider });
      });
      return this.getProviderAccount(id);
    },
    deleteProviderAccount(id) {
      return db.transaction(() => {
        const account = this.getProviderAccount(id);
        if (!account) return false;
        if (db.prepare("SELECT 1 FROM provider_account_selection WHERE provider = ? AND account_id = ?").get(account.provider, id)) {
          throw databaseError(409, "Switch to another account before removing the active one", { code: "PROVIDER_ACCOUNT_ACTIVE" });
        }
        db.prepare("DELETE FROM provider_limit_windows WHERE account_id = ?").run(id);
        db.prepare("DELETE FROM deleted_run_usage WHERE account_id = ?").run(id);
        db.prepare("DELETE FROM provider_accounts WHERE id = ?").run(id);
        writeCriticalAudit("provider-account.removed", { target: id, provider: account.provider });
        return true;
      }).immediate();
    },
    activeProviderAccountId(provider) {
      return db.prepare("SELECT account_id AS accountId FROM provider_account_selection WHERE provider = ?").get(provider)?.accountId ?? defaultProviderAccountId(provider);
    },
    // The account must still exist when the selection commits; a removal
    // that raced the eligibility check fails the switch.
    selectProviderAccount(provider, accountId) {
      return db.transaction(() => {
        if (accountId !== defaultProviderAccountId(provider)
          && !db.prepare("SELECT 1 FROM provider_accounts WHERE id = ? AND provider = ?").get(accountId, provider)) {
          throw databaseError(409, "The account was removed before the switch completed", { code: "PROVIDER_ACCOUNT_SWITCH_FAILED" });
        }
        const previous = this.activeProviderAccountId(provider);
        db.prepare(`INSERT INTO provider_account_selection (provider, account_id) VALUES (?, ?)
          ON CONFLICT(provider) DO UPDATE SET account_id = excluded.account_id`).run(provider, accountId);
        if (previous !== accountId) writeCriticalAudit("provider-account.switched", { target: accountId, provider, previous });
        return accountId;
      }).immediate();
    },
    // Recorded with the launch marker (updateRun's `account`), with the CLI
    // home the launch uses. A run whose admission was deferred is still
    // queued and may be bound again; once it leaves the queue its account
    // never changes. An added account removed since it was resolved fails
    // the launch here.
    bindRunAccount(runId, account) {
      return db.transaction(() => bindRunAccount(runId, account)).immediate();
    },
    // The account a session belongs to, so resuming it keeps that account:
    // the latest run that launched in it. A session created only by runs from
    // before accounts used the default login, whose home was not recorded
    // (`home` undefined). A run that never launched (a queued run or a
    // recovery that carries the session) does not own it. Null for a session
    // no run in this chat launched in (attached by hand); ownership is looked
    // up per chat.
    sessionAccount(conversationId, provider, sessionId) {
      if (!sessionId) return null;
      const row = db.prepare(`SELECT account.account_id AS accountId, account.home_path AS home FROM runs LEFT JOIN run_accounts AS account ON account.run_id = runs.id
        WHERE runs.conversation_id = ? AND runs.provider = ? AND runs.provider_session_id = ?
          AND (account.account_id IS NOT NULL OR runs.started_at IS NOT NULL)
        ORDER BY account.account_id IS NULL, runs.created_at DESC, runs.rowid DESC LIMIT 1`).get(conversationId, provider, sessionId);
      if (!row) return null;
      return row.accountId ? { accountId: row.accountId, home: row.home } : { accountId: defaultProviderAccountId(provider), home: undefined };
    },
    // The latest report of each window wins, per account and CLI home key
    // (a direct provider's null is stored as ''). A report is optional
    // telemetry and obeys the retained budget.
    // A removed account keeps no windows, even from a run still using it.
    recordProviderLimits({ accountId, provider, home = null }, runId, windows, observedAt = now()) {
      withinRetainedBudget(() => {
        if (accountId !== defaultProviderAccountId(provider) && !db.prepare("SELECT 1 FROM provider_accounts WHERE id = ?").get(accountId)) return;
        const upsert = db.prepare(`INSERT INTO provider_limit_windows (account_id, provider, window_name, utilization, status, resets_at, observed_at, run_id, home_path)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(account_id, home_path, window_name) DO UPDATE SET provider = excluded.provider,
          utilization = excluded.utilization, status = excluded.status, resets_at = excluded.resets_at, observed_at = excluded.observed_at,
          run_id = excluded.run_id`);
        const known = new Set(db.prepare("SELECT window_name AS name FROM provider_limit_windows WHERE account_id = ? AND home_path = ?").all(accountId, home ?? "").map((row) => row.name));
        for (const window of windows) {
          if (!known.has(window.window) && known.size >= MAX_LIMIT_WINDOWS_PER_HOME) continue;
          known.add(window.window);
          upsert.run(accountId, provider, window.window, window.utilization, window.status, window.resetsAt, observedAt, runId, home ?? "");
        }
      });
    },
    // Windows and usage belong to the login in one CLI home. A default
    // account whose home changed with the environment starts afresh, and
    // returning to the earlier home shows that home's windows again.
    listProviderLimits(accountId, home = null) {
      return db.prepare(`SELECT window_name AS window, utilization, status, resets_at AS resetsAt, observed_at AS observedAt, run_id AS runId
        FROM provider_limit_windows WHERE account_id = ? AND home_path = ? ORDER BY window_name`).all(accountId, home ?? "");
    },
    // What Outright measured for runs launched with an account since a time,
    // including runs whose chat was deleted since (deleted_run_usage).
    // Runs without reported cost or tokens are counted, so a sum is never
    // mistaken for a complete total; a sum nothing reported is null.
    // The oldest counted launch says when the window next loses a run.
    measuredAccountUsage(accountId, since, home = null) {
      return db.prepare(`SELECT COUNT(*) AS runs, SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens,
        COALESCE(SUM(input_tokens IS NULL AND output_tokens IS NULL), 0) AS runsWithoutTokens,
        COALESCE(SUM((input_tokens IS NULL) <> (output_tokens IS NULL)), 0) AS runsWithPartialTokens,
        SUM(cost_usd) AS costUsd, COALESCE(SUM(cost_usd IS NULL), 0) AS runsWithoutCost, MIN(bound_at) AS oldestBoundAt
        FROM (SELECT account.bound_at, runs.input_tokens, runs.output_tokens, runs.cost_usd FROM run_accounts AS account JOIN runs ON runs.id = account.run_id
            WHERE account.account_id = @accountId AND account.home_path IS @home AND account.bound_at >= @since
          UNION ALL SELECT bound_at, input_tokens, output_tokens, cost_usd FROM deleted_run_usage
            WHERE account_id = @accountId AND home_path IS @home AND bound_at >= @since)`).get({ accountId, home, since });
    },
    search(query, limit = 40) {
      if (typeof query !== "string" || !query.trim() || Buffer.byteLength(query) > SEARCH_QUERY_BYTES) {
        throw databaseError(400, `Search query must contain 1 to ${SEARCH_QUERY_BYTES} UTF-8 bytes`);
      }
      const boundedLimit = Math.max(1, Math.min(40, Number.isInteger(limit) ? limit : 40));
      const escapedQuery = query.trim().replace(/[\\%_]/g, (character) => `\\${character}`);
      const needle = `%${escapedQuery}%`;
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
      const byTitle = db.prepare(String.raw`WITH recent AS MATERIALIZED
        (SELECT source_rowid AS rowid FROM search_recent_titles
          ORDER BY updated_at DESC, source_rowid DESC LIMIT ${SEARCH_CANDIDATES})
        SELECT ${fields} FROM recent JOIN conversations AS c ON c.rowid = recent.rowid
        WHERE c.deleting = 0 AND ${safeIdentity}
          AND c.title LIKE ? ESCAPE '\'`).all(needle);
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
      const { heads, ordinals } = recentSearchOrdinals(db, scopes);
      const byMessage = ordinals.length ? db.prepare(String.raw`SELECT DISTINCT ${fields} FROM messages AS m
        JOIN conversations AS c ON c.id = m.conversation_id
        WHERE m.rowid IN (${ordinals.map(() => "?").join(",")})
          AND c.deleting = 0 AND ${safeIdentity} AND octet_length(m.body) <= ${SEARCH_MESSAGE_BYTES}
          AND m.body LIKE ? ESCAPE '\'`).all(...ordinals, needle) : [];
      const matched = [...new Map([...byTitle, ...byMessage].map((row) => [row.id, row])).values()];
      matched.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const conversations = boundedSearchResults(matched, boundedLimit);
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
        availableForNewWorkBytes: 0, availablePhysicalForNewWorkBytes: 0, diskAllocatedBytes: disk.bytes,
        diskUsageStatus: disk.status === "unknown" ? "unknown" : "partial" };
    };
    if (key === "canLaunchRun") return () => false;
    if (key === "audit") return () => false;
    if (key === "auditRequired") return async (...args) => {
      if (maintenanceError) throw databaseError(503, `Archive maintenance recovery failed: ${maintenanceError}`, { code: "ARCHIVE_MAINTENANCE_FAILED" });
      await new Promise((resolve) => deletionIdleWaiters.add(resolve));
      if (maintenanceError) throw databaseError(503, `Archive maintenance recovery failed: ${maintenanceError}`, { code: "ARCHIVE_MAINTENANCE_FAILED" });
      if (closing) throw databaseError(503, "Runtime closed during archive maintenance");
      return receiver.auditRequired(...args);
    };
    return () => { throw databaseError(503, maintenanceError
      ? `Archive maintenance recovery failed: ${maintenanceError}` : "Archive maintenance is running; retry shortly",
    { code: maintenanceError ? "ARCHIVE_MAINTENANCE_FAILED" : "ARCHIVE_MAINTENANCE_TRANSIENT" }); };
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

function openRuntimeStorage(filename, storageFilename, runtimeLease, migrationHooks) {
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
    migrate(db, migrationHooks.spaces);
    advanceMigrations(db, migrationHooks);
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
function deleteArchivedInBatches(db, id, inFlight, { automatic = false, cutoff, isClosing, filename, workers, lockGate, cutoverStatGate, cutoverCloseGate, cutoverPromoteGate, copyGate, copyStepGate, copyPhase, currentDb, canMaintain, onWorkerStart, onWorkerReady, onWorkerExit, onWorkerRecoveryFailure }) {
  if (inFlight.has(id)) throw databaseError(409, "Archived conversation deletion is in progress");
  inFlight.add(id);
  const run = async () => {
    try {
      markArchivedForDeletion(db, id, automatic, cutoff);
      while (true) {
        if (isClosing()) throw databaseError(503, "Runtime closed during archived conversation deletion; cleanup will resume on restart");
        db = currentDb();
        const result = await advanceArchiveDeletion(db, id,
          { filename, workers, lockGate, cutoverStatGate, cutoverCloseGate, cutoverPromoteGate, copyGate, copyStepGate, copyPhase, canMaintain, onWorkerStart, onWorkerReady, onWorkerExit, onWorkerRecoveryFailure, isClosing });
        if (result) return result;
        await new Promise((resolve) => setImmediate(resolve)); // NOSONAR S9382: yields between dependent archive deletion steps
      }
    } finally { inFlight.delete(id); }
  };
  return run();
}

// The offline archive phase closes the database, so it waits for agent runs
// and for worktree setup or teardown, whose steps save progress as they go.
function maintenanceMustWait(db) {
  return Boolean(db.prepare("SELECT 1 FROM runs WHERE status IN ('launching', 'running') LIMIT 1").get()
    || db.prepare(`SELECT 1 FROM worktree_lifecycle WHERE ${LIFECYCLE_STATE_RUNNING} LIMIT 1`).get());
}

async function advanceArchiveDeletion(db, id, { filename, workers, lockGate, cutoverStatGate, cutoverCloseGate, cutoverPromoteGate, copyGate, copyStepGate, copyPhase, canMaintain, onWorkerStart, onWorkerReady, onWorkerExit, onWorkerRecoveryFailure, isClosing }) {
  const step = db.transaction(() => deleteArchivedBatch(db, id, filename)).immediate();
  if (step.done) { onWorkerExit(); return { deleted: 1, id }; }
  if (!step.oversized) return null;
  // The durable marker lets an active run or another cleanup finish before
  // this exclusive offline phase starts.
  if (workers.size || !canMaintain() || maintenanceMustWait(db)) {
    return { deleted: 0, deferred: true, id };
  }
  // Only a committed cutover changes a task. Before the rebuild, task reads
  // are unavailable and, like the storage hook, nothing is announced.
  const taskId = conversationTasksReady(db) ? db.prepare("SELECT task_id FROM conversations WHERE id = ?").get(id)?.task_id : null;
  try {
    await deleteOversizedArchivedRow(filename, id, step.oversized, { workers, lockGate, cutoverStatGate, cutoverCloseGate, cutoverPromoteGate, copyGate, copyStepGate, copyPhase,
      onWorkerStart, onWorkerReady, onWorkerExit: () => onWorkerExit(taskId ? { id, taskId } : undefined), onWorkerRecoveryFailure });
  }
  catch (error) {
    if (isClosing()) throw databaseError(503, "Runtime closed during archived conversation deletion; cleanup will resume on restart");
    if (["ARCHIVE_SNAPSHOT_CHANGED", "ARCHIVE_DEFERRED", "ARCHIVE_SOURCE_BUSY"].includes(error.code)) {
      return { deleted: 0, deferred: true, sourceBusy: error.code === "ARCHIVE_SOURCE_BUSY", id };
    }
    throw error;
  }
  return { deleted: 1, id };
}

function markArchivedForDeletion(db, id, automatic, cutoff) {
  db.transaction(() => {
    const row = db.prepare(`SELECT ${archivedConversationSql(db)} AS archived, pinned, deleting, updated_at AS updatedAt
      FROM conversations WHERE id = ?`).get(id);
    if (!row) throw databaseError(404, "Conversation not found");
    if (!row.archived || (automatic && !row.deleting && (row.pinned || (cutoff && row.updatedAt >= cutoff)))
      || db.prepare(`SELECT 1 FROM runs WHERE conversation_id = ? AND (status IN ('queued', 'launching', 'running')
        OR (status = 'interrupted' AND recovery_decision IS NULL)) LIMIT 1`).get(id)) {
      throw databaseError(409, "Only archived conversations without active or unresolved recovery work can be deleted");
    }
    // A thread hidden by its task's archive is marked archived itself, so
    // every later batch and the shadow worker see one archived marker.
    db.prepare("UPDATE conversations SET archived = 1, deleting = 1 WHERE id = ?").run(id);
  }).immediate();
}

function validateConversationExecution(input) {
  if (input.provider != null && input.provider !== "" && !EXECUTION_ADAPTER_IDS.includes(input.provider)) throw databaseError(400, "Provider is not supported");
  // Launch applies the same rule, so a saved model is never refused at send.
  if (input.model != null && !isModelName(input.model)) throw databaseError(400, MODEL_NAME_REQUIREMENT, { code: "PROVIDER_CONFIGURATION_INVALID" });
}

function validateConversationPatch(db, api, id, patch) {
  const current = db.prepare("SELECT archived, deleting, provider, provider_session_id AS providerSessionId FROM conversations WHERE id = ?").get(id);
  if (current?.deleting) throw databaseError(409, "Archived conversation deletion is in progress");
  if (patch.provider !== undefined && !EXECUTION_ADAPTER_IDS.includes(patch.provider)) throw databaseError(400, "Provider is not supported");
  validateConversationExecution({ model: patch.model });
  if (patch.archived !== undefined && typeof patch.archived !== "boolean") {
    throw databaseError(400, "Conversation archived state must be a boolean");
  }
  // Launch applies the same rule, so an attached session stays resumable.
  if (patch.providerSessionId != null && patch.providerSessionId !== "" && !isProviderSessionId(patch.providerSessionId)) {
    throw databaseError(400, "Provider session id is invalid", { code: "PROVIDER_SESSION_INVALID" });
  }
  // A stored session that the adapter cannot resume would refuse every
  // later send.
  const adapter = findExecutionAdapter(patch.provider ?? current?.provider);
  if (patch.providerSessionId && adapter && !adapter.capabilities.resume) {
    throw databaseError(409, `${adapter.label} cannot resume a provider session`, { code: "PROVIDER_RESUME_UNSUPPORTED" });
  }
  if (patch.archived === true && api.findUnresolvedInterruptedRun(id)) {
    throw databaseError(409, "Resolve the interrupted run before archiving this conversation");
  }
  return { current, archiveOnly: patch.archived === true && Object.keys(patch).length === 1 };
}

function recentSearchOrdinals(db, scopes) {
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
  return { heads, ordinals };
}

function boundedSearchResults(matched, limit) {
  const conversations = [];
  let responseBytes = 64;
  for (const { updatedAt, ...row } of matched) {
    if (conversations.length === limit) break;
    const bytes = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (responseBytes + bytes > SEARCH_RESPONSE_BYTES) break;
    conversations.push(row);
    responseBytes += bytes;
  }
  return conversations;
}

function deleteArchivedRows(db, id, filename, query, table) {
  const rows = db.prepare(query).all(id);
  if (!rows.length) return null;
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

function auditArchivedDeletion(db, id) {
  reserveRecoveryHeadroom(db, undefined, true);
  db.prepare("INSERT INTO audit_log (action, target, details, created_at) VALUES (?, ?, ?, ?)")
    .run("retention.archived.deleted", id, "{}", now());
  // Keep a live archive delete independent of a legacy audit table's size.
  for (let page = 0; page < 4; page += 1) {
    if (trimAuditPage(db).complete) break;
  }
  reserveRecoveryHeadroom(db);
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
    const result = deleteArchivedRows(db, id, filename, query, table);
    if (result) return result;
  }
  const ready = conversationTasksReady(db);
  const taskId = ready ? db.prepare("SELECT task_id FROM conversations WHERE id = ? AND deleting = 1").get(id)?.task_id : null;
  const deleted = db.prepare("DELETE FROM conversations WHERE id = ? AND deleting = 1").run(id).changes;
  if (deleted) {
    // Before the rebuild, a backfilled task reuses its conversation's id.
    if (ready) deleteOrphanedTask(db, taskId);
    else db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    auditArchivedDeletion(db, id);
  }
  return { done: true };
}

function deleteOversizedArchivedRow(filename, conversationId, oversized, lifecycle) {
  const { workers, lockGate, cutoverStatGate, cutoverCloseGate, cutoverPromoteGate, copyGate, copyStepGate, copyPhase, onWorkerStart, onWorkerReady, onWorkerExit, onWorkerRecoveryFailure } = lifecycle;
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL("./archive-delete-worker.mjs", import.meta.url),
        { workerData: { filename, conversationId, ...oversized, lockGate, cutoverStatGate, cutoverCloseGate, cutoverPromoteGate, copyGate, copyStepGate, copyPhase } });
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

function migrate(db, onSpacesMigrationStep) {
  // The rename must precede table creation: creating an empty spaces table
  // first would make a legacy store look already migrated.
  migrateProjectGroupsToSpaces(db, onSpacesMigrationStep);
  const hadAudit = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'audit_log'").get());
  const hadRuns = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runs'").get());
  const hadMessages = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages'").get());
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS spaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS project_memberships (project_id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, scope_kind TEXT NOT NULL CHECK (scope_kind IN ('space', 'project', 'worktree')),
      space_id TEXT REFERENCES spaces(id), project_id TEXT, worktree_id TEXT, worktree_path TEXT,
      title TEXT NOT NULL, objective TEXT NOT NULL DEFAULT '', origin TEXT NOT NULL DEFAULT 'user' CHECK (origin IN ('user', 'outbot')),
      user_status TEXT NOT NULL DEFAULT 'open' CHECK (user_status IN ('open', 'done')),
      archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      CHECK ((scope_kind = 'space' AND space_id IS NOT NULL AND project_id IS NULL AND worktree_id IS NULL AND worktree_path IS NULL)
        OR (scope_kind = 'project' AND space_id IS NULL AND project_id IS NOT NULL AND worktree_id IS NULL AND worktree_path IS NULL)
        OR (scope_kind = 'worktree' AND space_id IS NULL AND project_id IS NOT NULL AND worktree_id IS NOT NULL AND worktree_path IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS tasks_recent ON tasks(archived, updated_at, id);
    CREATE INDEX IF NOT EXISTS tasks_space_scope ON tasks(space_id, archived, updated_at);
    CREATE INDEX IF NOT EXISTS tasks_project_scope ON tasks(project_id, worktree_id, archived, updated_at);
    CREATE INDEX IF NOT EXISTS tasks_status ON tasks(user_status, archived, updated_at);
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, worktree_id TEXT, worktree_path TEXT,
      title TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', provider_session_id TEXT, tab_position INTEGER NOT NULL DEFAULT 0,
      session_epoch INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0, deleting INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id)
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
    CREATE TABLE IF NOT EXISTS trusted_lifecycle_configs (project_id TEXT NOT NULL, project_path TEXT NOT NULL, config_digest TEXT NOT NULL,
      trusted_at TEXT NOT NULL, PRIMARY KEY (project_id, config_digest));
    CREATE TABLE IF NOT EXISTS worktree_lifecycle (worktree_path TEXT PRIMARY KEY, project_id TEXT NOT NULL, state TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, target TEXT, details TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit_retention_cursor (id INTEGER PRIMARY KEY CHECK (id = 1), cursor INTEGER NOT NULL DEFAULT 0,
      sweep_upper INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS prompt_templates (id TEXT PRIMARY KEY, title TEXT NOT NULL, prompt TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS provider_accounts (
      id TEXT PRIMARY KEY, provider TEXT NOT NULL, label TEXT NOT NULL, home_path TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(provider, home_path)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS provider_accounts_label ON provider_accounts(provider, label COLLATE NOCASE);
    CREATE TABLE IF NOT EXISTS provider_account_selection (provider TEXT PRIMARY KEY, account_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS provider_limit_windows (
      account_id TEXT NOT NULL, provider TEXT NOT NULL, window_name TEXT NOT NULL, utilization REAL, status TEXT, resets_at TEXT,
      observed_at TEXT NOT NULL, run_id TEXT, home_path TEXT NOT NULL DEFAULT '', PRIMARY KEY (account_id, home_path, window_name)
    );
    CREATE TABLE IF NOT EXISTS run_accounts (
      run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE, account_id TEXT NOT NULL, account_label TEXT NOT NULL,
      account_identity TEXT, bound_at TEXT NOT NULL, home_path TEXT
    );
    CREATE INDEX IF NOT EXISTS run_accounts_usage ON run_accounts(account_id, bound_at);
    CREATE TABLE IF NOT EXISTS run_account_pins (
      run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE, account_id TEXT NOT NULL, home_path TEXT,
      home_known INTEGER NOT NULL DEFAULT 1
    );
    -- A deleted run keeps counting in its account's measured usage until it
    -- leaves the longest period (7 days). Rows hold no content and are not
    -- charged to the retained budget, so deleting history is never refused
    -- for lack of space; at most a week of deleted launches is kept.
    CREATE TABLE IF NOT EXISTS deleted_run_usage (
      account_id TEXT NOT NULL, home_path TEXT, bound_at TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL
    );
    CREATE INDEX IF NOT EXISTS deleted_run_usage_window ON deleted_run_usage(account_id, bound_at);
    CREATE INDEX IF NOT EXISTS deleted_run_usage_expiry ON deleted_run_usage(bound_at);
    CREATE TRIGGER IF NOT EXISTS deleted_run_usage_keep BEFORE DELETE ON runs BEGIN
      DELETE FROM deleted_run_usage WHERE bound_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days');
      INSERT INTO deleted_run_usage SELECT account.account_id, account.home_path, account.bound_at, OLD.input_tokens, OLD.output_tokens, OLD.cost_usd
        FROM run_accounts AS account WHERE account.run_id = OLD.id AND account.bound_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days');
    END;
  `);
  db.prepare("INSERT OR IGNORE INTO audit_retention_cursor (id) VALUES (1)").run();
  prepareAuditEvidence(db, hadAudit);
  if (!db.pragma("table_info(audit_retention_cursor)").some((column) => column.name === "sweep_upper")) {
    db.exec("ALTER TABLE audit_retention_cursor ADD COLUMN sweep_upper INTEGER NOT NULL DEFAULT 0");
  }
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
  try { db.exec("ALTER TABLE conversations ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0"); } catch { /* Already migrated. */ }
  prepareVisibleConversationLookup(db);
  prepareRecentTitleLookup(db);
  prepareSearchMessageHeads(db);
  prepareTaskMigration(db);
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

// Project groups became spaces. Schema state, not user_version, gates the
// rename so it stays idempotent. One transaction moves the table, its
// membership column, and any unfinished retained-byte scan, so an interrupted
// upgrade leaves either the old or the new schema. SQLite carries rows, ids,
// the cascading foreign key and trigger bodies across ALTER TABLE RENAME.
function migrateProjectGroupsToSpaces(db, onStep) {
  const hasTable = (name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
  if (!hasTable("project_groups") || hasTable("spaces")) return;
  db.transaction(() => {
    // These triggers follow the renamed table under their old names; the
    // retained trigger install recreates them as retained_spaces_*. Leaving
    // them would count every space write twice.
    for (const action of ["insert", "update", "delete"]) db.exec(`DROP TRIGGER IF EXISTS retained_project_groups_${action}`);
    db.exec("ALTER TABLE project_groups RENAME TO spaces");
    onStep?.("table-renamed");
    if (db.pragma("table_info(project_memberships)").some((column) => column.name === "group_id")) {
      db.exec("ALTER TABLE project_memberships RENAME COLUMN group_id TO space_id");
    }
    if (hasTable("retained_scans")) db.prepare("UPDATE retained_scans SET table_name = 'spaces' WHERE table_name = 'project_groups'").run();
  }).immediate();
}

// Tasks became the durable unit of work. A store whose conversations predate
// task_id backfills one worktree task per conversation in bounded batches,
// then rebuilds the conversations table once. Schema state gates both steps.
function prepareTaskMigration(db) {
  if (conversationTasksReady(db)) {
    db.exec("CREATE INDEX IF NOT EXISTS conversations_task ON conversations(task_id)");
    return;
  }
  db.prepare("INSERT OR IGNORE INTO migration_progress (kind) VALUES ('tasks')").run();
}

// A migrated task reuses its conversation's id, so a resumed batch or the
// final catch-up insert can never duplicate a task. Titles are bounded
// copies; the conversation keeps its full title.
const TASK_BACKFILL_SQL = `INSERT OR IGNORE INTO tasks (id, scope_kind, project_id, worktree_id, worktree_path, title,
    objective, origin, user_status, archived, created_at, updated_at)
  SELECT id, 'worktree', project_id, worktree_id, worktree_path, substr(title, 1, ${TASK_TITLE_CHARACTERS}),
    '', 'user', 'open', CASE WHEN archived = 0 THEN 0 ELSE 1 END, created_at, updated_at FROM conversations`;

function advanceTaskMigration(db, onStep) {
  const job = migrationJob(db, "tasks");
  if (!job) return;
  const backfilled = db.transaction(() => {
    const rows = db.prepare("SELECT rowid AS scanRowId FROM conversations WHERE rowid > ? ORDER BY rowid LIMIT 64").all(job.cursor_number);
    if (rows.length) {
      withMigrationGrowth(db, () => db.prepare(`${TASK_BACKFILL_SQL} WHERE rowid > ? AND rowid <= ?`)
        .run(job.cursor_number, rows.at(-1).scanRowId));
      db.prepare("UPDATE migration_progress SET cursor_number = ? WHERE kind = 'tasks'").run(rows.at(-1).scanRowId);
    }
    onStep?.("tasks-backfilled");
    return rows.length < 64;
  }).immediate();
  if (backfilled) rebuildConversationsWithTasks(db, onStep);
}

// Backfilled tasks duplicate bounded metadata of history that is already
// retained. Like recovery evidence, they may cross the configured cap once,
// so an over-quota store still finishes upgrading.
function withMigrationGrowth(db, write) {
  db.prepare("UPDATE retained_usage SET legacy_ceiling = ? WHERE id = 1").run(Number.MAX_SAFE_INTEGER);
  write();
  reserveRecoveryHeadroom(db);
}

// SQLite's documented table rebuild: foreign keys stay off across the swap,
// so the ON DELETE CASCADE keys from messages and runs never fire. Every
// column present now is copied with its rowid, which the search lookups key
// on, and every index and trigger on the table is recreated from its SQL.
function rebuildConversationsWithTasks(db, onStep) {
  db.pragma("foreign_keys = OFF");
  try {
    if (db.pragma("foreign_keys", { simple: true }) !== 0) throw new Error("Foreign keys must be off to rebuild conversations");
    db.transaction(() => {
      if (conversationTasksReady(db)) {
        db.prepare("DELETE FROM migration_progress WHERE kind = 'tasks'").run();
        return;
      }
      const checked = ["conversations", "messages", "runs", "tasks"];
      const before = foreignKeyViolationCounts(db, checked);
      // Task writes are refused until the rebuild commits, so every task is a
      // backfill. Retention may have deleted its conversation since then.
      db.prepare(`DELETE FROM tasks WHERE scope_kind = 'worktree' AND origin = 'user'
        AND NOT EXISTS (SELECT 1 FROM conversations WHERE conversations.id = tasks.id)`).run();
      withMigrationGrowth(db, () => db.prepare(`${TASK_BACKFILL_SQL} WHERE NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.id = conversations.id)`).run());
      const columns = db.pragma("table_info(conversations)").map((column) => `"${column.name.replaceAll('"', '""')}"`).join(", ");
      const dependents = db.prepare(`SELECT sql FROM sqlite_master WHERE tbl_name = 'conversations'
        AND type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY type, name`).all();
      db.exec(rebuiltConversationsSql(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'conversations'").get().sql));
      db.exec(`INSERT INTO conversations_rebuild (rowid, ${columns}, task_id) SELECT rowid, ${columns}, id FROM conversations`);
      onStep?.("conversations-copied");
      db.exec("DROP TABLE conversations");
      // Triggers on message_order name conversations. Modern RENAME would
      // reject them while no table has that name; nothing references the
      // rebuild table, so the legacy rename rewrites nothing.
      db.pragma("legacy_alter_table = ON");
      try { db.exec("ALTER TABLE conversations_rebuild RENAME TO conversations"); }
      finally { db.pragma("legacy_alter_table = OFF"); }
      for (const { sql } of dependents) db.exec(sql);
      db.exec("CREATE INDEX conversations_task ON conversations(task_id)");
      const after = foreignKeyViolationCounts(db, checked);
      for (const [key, count] of after) {
        if (count > (before.get(key) ?? 0)) throw new Error(`Conversation rebuild would violate foreign key ${key}`);
      }
      db.prepare("DELETE FROM migration_progress WHERE kind = 'tasks'").run();
    }).immediate();
  } finally { db.pragma("foreign_keys = ON"); }
}

// A pre-existing orphan in an unrelated legacy row must not wedge the
// upgrade, but the rebuild itself may not add a single violation.
function foreignKeyViolationCounts(db, tables) {
  const counts = new Map();
  for (const table of tables) {
    for (const row of db.pragma(`foreign_key_check(${table})`)) {
      const key = `${row.table}->${row.parent}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

// Start from the stored definition so columns added by later releases keep
// their types, defaults and constraints. Only the worktree columns relax and
// the task reference is appended.
function rebuiltConversationsSql(sql) {
  let rebuilt = sql.replace(/^CREATE TABLE\s+(?:"conversations"|conversations)\s*\(/i, "CREATE TABLE conversations_rebuild (");
  for (const column of ["worktree_id", "worktree_path"]) {
    const pattern = new RegExp(`([(,]\\s*)${column}\\s+TEXT\\s+NOT\\s+NULL(\\s*[,)])`, "i");
    if (!pattern.test(rebuilt)) throw new Error(`Unexpected conversations schema for ${column}`);
    rebuilt = rebuilt.replace(pattern, `$1${column} TEXT$2`);
  }
  if (!rebuilt.startsWith("CREATE TABLE conversations_rebuild (") || !/\)\s*$/.test(rebuilt)) throw new Error("Unexpected conversations schema");
  return rebuilt.replace(/\)\s*$/, ", task_id TEXT NOT NULL REFERENCES tasks(id))");
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
  } else {
    // A table added by an upgrade during an unfinished scan needs its own
    // cursor. Its triggers count nothing before measurement completes.
    const insert = db.prepare("INSERT OR IGNORE INTO retained_scans (table_name) VALUES (?)");
    for (const [table] of RETAINED_COLUMNS) insert.run(table);
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
function advanceMigrations(db, hooks = {}) {
  if (!migrationPending(db)) return;
  advanceTaskMigration(db, hooks.tasks);
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

// Every committed change to a task row, its threads or its derived status is
// recorded by connection-local triggers, so storage paths cannot forget to
// announce one. The rows are rolled back with their transaction and read
// only after it commits. Installed once the conversations rebuild has given
// threads a task.
const TASK_RUN_LEVEL = (row) => `CASE WHEN ${row}.status IN ('queued', 'launching', 'running') THEN 2
  WHEN ${row}.status = 'interrupted' AND ${row}.recovery_decision IS NULL THEN 1 ELSE 0 END`;
const taskChangeCapture = new WeakSet();
function captureTaskChanges(db, onRecorded) {
  if (taskChangeCapture.has(db) || !conversationTasksReady(db)) return;
  db.function("outright_task_recorded", { deterministic: false }, () => { onRecorded(); return null; });
  const record = (taskId) => `INSERT OR IGNORE INTO task_changes (task_id) SELECT ${taskId} WHERE ${taskId} IS NOT NULL;
    SELECT outright_task_recorded();`;
  const runTask = (row) => record(`(SELECT task_id FROM conversations WHERE id = ${row}.conversation_id)`);
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS task_changes (task_id TEXT PRIMARY KEY) WITHOUT ROWID;
    CREATE TEMP TRIGGER IF NOT EXISTS task_change_insert AFTER INSERT ON tasks BEGIN ${record("NEW.id")} END;
    CREATE TEMP TRIGGER IF NOT EXISTS task_change_update AFTER UPDATE ON tasks BEGIN ${record("NEW.id")} END;
    CREATE TEMP TRIGGER IF NOT EXISTS task_change_delete AFTER DELETE ON tasks BEGIN ${record("OLD.id")} END;
    CREATE TEMP TRIGGER IF NOT EXISTS task_change_thread_insert AFTER INSERT ON conversations BEGIN ${record("NEW.task_id")} END;
    CREATE TEMP TRIGGER IF NOT EXISTS task_change_thread_update AFTER UPDATE OF task_id, title, archived, deleting ON conversations
      WHEN OLD.task_id IS NOT NEW.task_id OR OLD.title IS NOT NEW.title OR OLD.archived IS NOT NEW.archived OR OLD.deleting IS NOT NEW.deleting
      BEGIN ${record("OLD.task_id")} ${record("NEW.task_id")} END;
    CREATE TEMP TRIGGER IF NOT EXISTS task_change_thread_delete AFTER DELETE ON conversations BEGIN ${record("OLD.task_id")} END;
    CREATE TEMP TRIGGER IF NOT EXISTS task_change_run_insert AFTER INSERT ON runs WHEN ${TASK_RUN_LEVEL("NEW")} > 0 BEGIN ${runTask("NEW")} END;
    CREATE TEMP TRIGGER IF NOT EXISTS task_change_run_update AFTER UPDATE OF status, recovery_decision, conversation_id ON runs
      WHEN ${TASK_RUN_LEVEL("OLD")} != ${TASK_RUN_LEVEL("NEW")} OR (OLD.conversation_id IS NOT NEW.conversation_id AND ${TASK_RUN_LEVEL("NEW")} > 0)
      BEGIN ${runTask("OLD")} ${runTask("NEW")} END;`);
  taskChangeCapture.add(db);
}

// Returns at most 200 committed task ids and clears the record; a larger
// change reports truncated so consumers reload their task lists.
function takeTaskChanges(db) {
  if (!taskChangeCapture.has(db)) return null;
  const taskIds = db.prepare("SELECT task_id FROM task_changes LIMIT 201").pluck().all();
  if (!taskIds.length) return null;
  db.prepare("DELETE FROM task_changes").run();
  return { taskIds: taskIds.slice(0, 200), truncated: taskIds.length > 200 };
}

const tasksReady = new WeakSet();
function conversationTasksReady(db) {
  if (tasksReady.has(db)) return true;
  if (!db.pragma("table_info(conversations)").some((column) => column.name === "task_id")) return false;
  tasksReady.add(db);
  return true;
}

// An archived task hides every thread, so a thread reads as archived while
// either it or its task is archived. Before the task rebuild commits, the
// legacy table has no task to join and threads report a null taskId.
function conversationSource(db) {
  const tasks = conversationTasksReady(db);
  const archived = tasks ? "CASE WHEN c.archived = 1 OR t.archived = 1 THEN 1 ELSE 0 END" : "c.archived";
  return { archived, sql: `SELECT c.id, c.project_id AS projectId, c.worktree_id AS worktreeId, c.worktree_path AS worktreePath,
    c.title, c.provider, c.model, c.provider_session_id AS providerSessionId, c.session_epoch AS sessionEpoch, ${archived} AS archived, c.pinned,
    c.tab_position AS tabPosition, c.created_at AS createdAt, c.updated_at AS updatedAt, ${tasks ? "c.task_id" : "NULL"} AS taskId
    FROM conversations AS c${tasks ? " LEFT JOIN tasks AS t ON t.id = c.task_id" : ""}` };
}

// The same rule as conversationSource for unaliased deletion queries.
function archivedConversationSql(db) {
  return conversationTasksReady(db)
    ? "(conversations.archived = 1 OR EXISTS (SELECT 1 FROM tasks WHERE tasks.id = conversations.task_id AND tasks.archived = 1))"
    : "conversations.archived = 1";
}

// Derived on every read from run rows, so it is correct after a restart.
// recovery_scope indexes exactly the unsettled runs; joining back to runs
// reads their current status. Running work wins over a pending recovery
// choice, and a user's done overrides both. A later waiting cause (OUT-63
// awaiting_input) adds a level here without a schema change.
// CROSS JOIN fixes the loop order: the scan visits only recovery_scope's
// unsettled runs and reaches runs and conversations by primary key, so its
// cost never grows with settled run history. A detail read also keeps only
// the requested task's runs.
const TASK_STATUS_SQL = `CASE WHEN t.user_status = 'done' THEN 'done' WHEN u.level = 2 THEN 'running'
  WHEN u.level = 1 THEN 'waiting' ELSE 'idle' END`;
export function taskSelectSql(single = false) {
  return `WITH unsettled AS MATERIALIZED (SELECT c.task_id AS task_id,
    MAX(CASE WHEN r.status IN ('queued', 'launching', 'running') THEN 2 ELSE 1 END) AS level
  FROM recovery_scope AS s CROSS JOIN runs AS r ON r.id = s.run_id CROSS JOIN conversations AS c ON c.id = r.conversation_id
  WHERE (r.status IN ('queued', 'launching', 'running') OR (r.status = 'interrupted' AND r.recovery_decision IS NULL))${single ? " AND c.task_id = ?" : ""}
  GROUP BY c.task_id)
  SELECT t.id, t.scope_kind AS scopeKind, t.space_id AS spaceId, t.project_id AS projectId, t.worktree_id AS worktreeId,
    t.worktree_path AS worktreePath, t.title, t.objective, t.origin, t.user_status AS userStatus, ${TASK_STATUS_SQL} AS status,
    t.archived, (SELECT COUNT(*) FROM conversations WHERE task_id = t.id AND deleting = 0) AS threadCount,
    t.created_at AS createdAt, t.updated_at AS updatedAt
  FROM tasks AS t LEFT JOIN unsettled AS u ON u.task_id = t.id`;
}

function hydrateTask(row) { return row ? { ...row, archived: row.archived === 1 } : row; }

function assertTasksReady(db) {
  if (migrationJob(db, "tasks")) throw databaseError(503, "Tasks are being migrated; retry shortly");
  if (migrationJob(db, "recovery")) throw databaseError(503, "Recovery ownership is being indexed; retry shortly");
}

function boundedText(value, label, maxCharacters) {
  if (typeof value !== "string" || !value.trim() || value.length > maxCharacters * 2 || Array.from(value.trim()).length > maxCharacters) {
    throw databaseError(400, `${label} must be 1 to ${maxCharacters} characters`);
  }
  return value.trim();
}

function taskObjective(value) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || Buffer.byteLength(value) > TASK_OBJECTIVE_BYTES) {
    throw databaseError(400, `Task objective must be a string of at most ${TASK_OBJECTIVE_BYTES} bytes`);
  }
  return value;
}

// One shape check for the API and storage: each scope names exactly the ids
// its kind requires, mirroring the tasks CHECK constraint.
export function normalizeTaskInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw databaseError(400, "Task must be a JSON object");
  const scopes = { space: ["spaceId"], project: ["projectId"], worktree: ["projectId", "worktreeId", "worktreePath"] };
  // Own keys only, so a name inherited from Object.prototype is a 400 too.
  if (typeof input.scopeKind !== "string" || !Object.hasOwn(scopes, input.scopeKind)) {
    throw databaseError(400, "Task scope kind must be space, project, or worktree");
  }
  const required = scopes[input.scopeKind];
  for (const key of ["spaceId", "projectId", "worktreeId", "worktreePath"]) {
    const value = input[key];
    if (required.includes(key)) {
      if (typeof value !== "string" || !value || Buffer.byteLength(value) > TASK_SCOPE_ID_BYTES) throw databaseError(400, `A ${input.scopeKind} task requires ${key}`);
    } else if (value !== undefined && value !== null) throw databaseError(400, `A ${input.scopeKind} task cannot name ${key}`);
  }
  if (input.origin !== undefined && !["user", "outbot"].includes(input.origin)) throw databaseError(400, "Task origin must be user or outbot");
  return { scopeKind: input.scopeKind, spaceId: input.spaceId ?? null, projectId: input.projectId ?? null,
    worktreeId: input.worktreeId ?? null, worktreePath: input.worktreePath ?? null,
    title: boundedText(input.title, "Task title", TASK_TITLE_CHARACTERS), objective: taskObjective(input.objective),
    origin: input.origin ?? "user" };
}

function insertTask(db, task, timestamp = now()) {
  const id = randomUUID();
  db.prepare(`INSERT INTO tasks (id, scope_kind, space_id, project_id, worktree_id, worktree_path, title, objective, origin,
      user_status, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`)
    .run(id, task.scopeKind, task.spaceId ?? null, task.projectId ?? null, task.worktreeId ?? null, task.worktreePath ?? null,
      task.title, task.objective ?? "", task.origin ?? "user", task.archived ? 1 : 0, timestamp, timestamp);
  return id;
}

function insertThreadTask(db, target, title, archived = false) {
  return insertTask(db, { scopeKind: "worktree", projectId: target.projectId, worktreeId: target.worktreeId,
    worktreePath: target.worktreePath, title: Array.from(title?.trim() || "New agent chat").slice(0, TASK_TITLE_CHARACTERS).join(""), archived });
}

// New threads launch only in a worktree until OUT-57, and only into the
// exact worktree that the task is scoped to.
function requireThreadTask(db, taskId, target) {
  if (typeof taskId !== "string" || !taskId || taskId.length > 512) throw databaseError(400, "Task id is invalid");
  const task = db.prepare("SELECT scope_kind AS scopeKind, project_id AS projectId, worktree_id AS worktreeId, worktree_path AS worktreePath, archived FROM tasks WHERE id = ?").get(taskId);
  if (!task) throw databaseError(404, "Task not found");
  if (task.scopeKind !== "worktree") throw databaseError(409, "Only worktree tasks can get new threads", { code: "TASK_SCOPE_UNSUPPORTED" });
  if (task.archived) throw databaseError(409, "Archived tasks cannot get new threads", { code: "TASK_ARCHIVED" });
  if (["projectId", "worktreeId", "worktreePath"].some((key) => task[key] !== target[key])) {
    throw databaseError(409, "The thread's worktree does not match the task's scope", { code: "TASK_SCOPE_MISMATCH" });
  }
  return taskId;
}

// A thread archived or restored through the conversation flow keeps a
// single-thread task in step: restoring makes its task visible, and archiving
// the last visible thread archives the task.
// Restoring a thread that its task hid also unhides its siblings, so the
// change is returned for announcement.
function syncTaskArchive(db, conversationId, archived) {
  if (!conversationTasksReady(db)) return null;
  const taskId = db.prepare("SELECT task_id FROM conversations WHERE id = ?").get(conversationId)?.task_id;
  if (!taskId) return null;
  if (archived) {
    archiveTaskWithoutVisibleThreads(db, taskId, now());
    return null;
  }
  if (!db.prepare("UPDATE tasks SET archived = 0, updated_at = ? WHERE id = ? AND archived = 1").run(now(), taskId).changes) return null;
  return taskArchiveChange(db, taskId, false);
}

// The one "no visible thread" rule: a task whose threads are all archived,
// deleting or gone is hidden, never deleted.
function archiveTaskWithoutVisibleThreads(db, taskId, timestamp) {
  db.prepare(`UPDATE tasks SET archived = 1, updated_at = ? WHERE id = ? AND archived = 0
    AND NOT EXISTS (SELECT 1 FROM conversations WHERE task_id = tasks.id AND archived = 0 AND deleting = 0)`).run(timestamp, taskId);
}

// The threads whose visibility follows the task, bounded for one event.
function taskArchiveChange(db, taskId, archived) {
  const rows = db.prepare(`SELECT id FROM conversations WHERE task_id = ? AND archived = 0 AND deleting = 0
    ORDER BY tab_position, rowid LIMIT ?`).all(taskId, TASK_THREAD_LIMIT + 1);
  return { taskId, archived, conversationIds: rows.slice(0, TASK_THREAD_LIMIT).map((row) => row.id),
    conversationIdsTruncated: rows.length > TASK_THREAD_LIMIT };
}

// Retention removes an archived thread. A task left without threads goes
// with it when archived; an open one is hidden, never left listed empty.
function deleteOrphanedTask(db, taskId) {
  if (!taskId) return;
  db.prepare("DELETE FROM tasks WHERE id = ? AND archived = 1 AND NOT EXISTS (SELECT 1 FROM conversations WHERE task_id = ?)").run(taskId, taskId);
  archiveTaskWithoutVisibleThreads(db, taskId, now());
}

// An archived task left without threads (a moved-away source, a standalone
// task) ages for retention like an archived thread. Each short transaction
// reads at most one page of stale archived tasks, threadless or not, and a
// call reads at most one page's worth of rows per task it may delete, even
// across a wrap. The cursor continues
// from the previous call and wraps at the end, so tasks behind a large
// archive that keeps its threads are reached by later calls. The delete
// re-checks every condition, so a concurrent restore or a new thread keeps
// its task.
async function deleteThreadlessArchivedTasks(currentDb, cutoff, limit, cursor) {
  const pageSize = 64;
  let deleted = 0;
  let examined = 0;
  let wrapped = cursor.after[0] === "";
  while (deleted < limit && examined < limit * pageSize) {
    const db = currentDb();
    if (!db || !conversationTasksReady(db)) break;
    const size = Math.min(pageSize, limit * pageSize - examined);
    const page = db.transaction(() => {
      const rows = db.prepare(`SELECT id, updated_at AS updatedAt, NOT EXISTS (SELECT 1 FROM conversations WHERE task_id = tasks.id) AS threadless
        FROM tasks WHERE archived = 1 AND updated_at < ? AND (updated_at, id) > (?, ?)
        ORDER BY updated_at, id LIMIT ?`).all(cutoff, ...cursor.after, size);
      const remove = db.prepare(`DELETE FROM tasks WHERE id = ? AND archived = 1 AND updated_at < ?
        AND NOT EXISTS (SELECT 1 FROM conversations WHERE task_id = tasks.id)`);
      let count = 0;
      let scanned = 0;
      for (const row of rows) {
        if (deleted + count >= limit) break;
        scanned += 1;
        if (row.threadless) count += remove.run(row.id, cutoff).changes;
      }
      return { rows, count, scanned };
    }).immediate();
    deleted += page.count;
    examined += page.rows.length;
    if (page.scanned) cursor.after = [page.rows[page.scanned - 1].updatedAt, page.rows[page.scanned - 1].id];
    if (page.scanned === page.rows.length && page.rows.length < size) {
      cursor.after = ["", ""];
      if (wrapped) break;
      wrapped = true;
    }
    await new Promise((resolve) => setImmediate(resolve)); // NOSONAR S9382: yields between task retention pages
  }
  return deleted;
}

function decodePageCursor(cursor, message) {
  if (cursor === null || cursor === undefined) return null;
  if (typeof cursor !== "string" || cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw databaseError(400, message);
  try {
    const after = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Buffer.from(JSON.stringify(after)).toString("base64url") !== cursor || !Array.isArray(after) || after.length !== 2
      || after.some((part) => typeof part !== "string" || !part || part.length > 512)) throw new Error("invalid cursor");
    return after;
  } catch { throw databaseError(400, message); }
}

function boundedTaskPage(rows, limit) {
  const tasks = [];
  let serializedBytes = 4096;
  for (const row of rows) {
    if (tasks.length === limit) break;
    const task = hydrateTask(row);
    const bytes = Buffer.byteLength(JSON.stringify(task)) + 1;
    if (tasks.length && serializedBytes + bytes > TASK_RESPONSE_BYTES) break;
    tasks.push(task);
    serializedBytes += bytes;
  }
  const last = tasks.at(-1);
  return { tasks, nextCursor: rows.length > tasks.length ? Buffer.from(JSON.stringify([last.updatedAt, last.id])).toString("base64url") : null };
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
export function defaultProviderAccountId(provider) { return `${provider}:default`; }
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
function sweepLaunchEntry(launchDirectory, entry, keep, pendingOutcome) {
  if (/^[0-9a-f-]{36}\.outcome\.json\.[0-9a-f-]{36}\.tmp$/i.test(entry.name)) {
    // A crash before atomic rename leaves no trustworthy outcome.
    try { rmSync(path.join(launchDirectory, entry.name), { force: true }); } catch { /* Retry next startup. */ }
    return;
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.outcome\.json$/i.test(entry.name)) {
    const runId = entry.name.slice(0, -".outcome.json".length);
    if (!pendingOutcome.get(runId)) {
      try { removeRunOutcome(launchDirectory, runId); } catch { /* Retain the marker for the next sweep. */ }
    }
    return;
  }
  // Terminal markers belong to terminal recovery. Only a run UUID is in
  // this sweep's ownership namespace.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i.test(entry.name)) return;
  const runId = entry.name.slice(0, -".json".length);
  if (keep.get(runId)) return;
  try { rmSync(path.join(launchDirectory, entry.name), { force: true }); } catch { /* Already gone. */ }
}

function sweepLaunchHandshakes(launchDirectory, db) {
  let directory;
  try { directory = opendirSync(launchDirectory); }
  catch { return; }
  const keep = db.prepare(`SELECT 1 FROM runs WHERE id = ? AND status = 'interrupted'
    AND recovery_decision IS NULL AND (recovery_class IN ('alive', 'unknown')
      OR recovery_class LIKE 'outcome-unreadable-%')`);
  const pendingOutcome = db.prepare(`SELECT 1 FROM runs WHERE id = ? AND
    (status IN ('queued', 'running', 'launching') OR
      (status = 'interrupted' AND recovery_decision IS NULL))`);
  try {
    let entry;
    while ((entry = directory.readSync())) {
      sweepLaunchEntry(launchDirectory, entry, keep, pendingOutcome);
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
    if (key === "model" && !validate(value)) throw databaseError(400, MODEL_NAME_REQUIREMENT, { code: "PROVIDER_CONFIGURATION_INVALID" });
    if (!validate(value)) throw databaseError(400, `Invalid value for setting: ${key}`);
  }
}

function databaseError(statusCode, message, details) { const error = new Error(message); error.statusCode = statusCode; error.details = details; return error; }

export { DEFAULT_SETTINGS };
