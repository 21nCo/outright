import Database from "better-sqlite3";
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { foldFindText } from "../src/lib/find-text.js";
import { RESOURCE_BUDGETS } from "./resource-budgets.mjs";

const DEFAULT_SETTINGS = {
  provider: "codex",
  model: "",
  reasoningEffort: "medium",
  approvalPolicy: "workspace-write",
  editor: "zed",
  maxConcurrentRuns: 3,
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
const FIND_CHUNK_BYTES = 64 * 1024;
const RETAINED_COLUMNS = [
  ["settings", "key, value"],
  ["project_groups", "id, name, created_at"],
  ["project_memberships", "project_id, group_id"],
  ["conversations", "id, project_id, worktree_id, worktree_path, title, provider, model, provider_session_id, created_at, updated_at"],
  ["messages", "id, conversation_id, role, kind, body, payload, created_at"],
  ["runs", "id, conversation_id, worktree_path, provider, model, reasoning_effort, approval_policy, prompt, status, provider_session_id, created_at, started_at, finished_at, error, recovery_class, recovery_decision"],
  ["run_events", "run_id, type, payload, created_at"],
  ["run_event_usage", "run_id"],
  ["trusted_projects", "project_id, project_path, trusted_at"],
  ["audit_log", "action, target, details, created_at"],
  ["prompt_templates", "id, title, prompt, created_at"],
];

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

export function createOutrightDatabase(options = {}) {
  const dataDirectory = path.resolve(options.dataDirectory
    ?? process.env.OUTRIGHT_DATA_DIR
    ?? path.join(os.homedir(), ".outright"));
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const filename = options.filename ?? path.join(dataDirectory, "outright.db");
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
  const db = new Database(filename);
  let activeMessageFinds = 0;
  let closing = false;
  try {
    // A runtime keeps SQLite in exclusive locking mode for its whole lifetime.
    // The kernel releases this lease if the process crashes, so a second
    // runtime cannot reconcile or schedule rows owned by the first and there
    // is no stale lock file to recover. Administrative/test database handles
    // opt out by default.
    if (options.runtimeLease) {
      db.pragma("busy_timeout = 250");
      db.pragma("locking_mode = EXCLUSIVE");
      db.exec("BEGIN EXCLUSIVE; COMMIT;");
    }
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    migrate(db);
  } catch (error) {
    db.close();
    if (options.runtimeLease && ["SQLITE_BUSY", "SQLITE_LOCKED"].includes(error?.code)) {
      const leaseError = new Error("Another Outright runtime already owns this database");
      leaseError.code = "OUTRIGHT_RUNTIME_LEASE_HELD";
      leaseError.cause = error;
      throw leaseError;
    }
    throw error;
  }

  // Optional retained-data writes use the shared SQLite byte counter. The
  // database trigger below is the final guard for every tracked table. Keep a
  // reserve for run state, recovery decisions and omission markers.
  const retainedReserveBytes = 1024 * 1024;
  function withinRetainedBudget(write, reserve = retainedReserveBytes) {
    try { return db.transaction(() => {
      const result = write();
      const limit = Math.max(0, Number(db.prepare("SELECT value FROM settings WHERE key = 'maxRetainedMiB'").get()?.value ?? DEFAULT_SETTINGS.maxRetainedMiB) * 1024 * 1024 - reserve);
      if (retainedBytes(db) > limit) throw databaseError(507, "Retained history is full; archive conversations, then delete selected archived chats or clean up older history");
      return result;
    }).immediate(); }
    catch (error) {
      if (error?.message?.includes("OUTRIGHT_RETAINED_LIMIT")) throw databaseError(507, "Retained history is full; archive conversations, then delete selected archived chats or clean up older history");
      throw error;
    }
  }

  return {
    filename,
    launchDirectory,
    close: () => { closing = true; db.close(); },
    getSettings() {
      const rows = db.prepare("SELECT key, value FROM settings").all();
      return rows.reduce((settings, row) => {
        settings[row.key] = parseJson(row.value, row.value);
        return settings;
      }, { ...DEFAULT_SETTINGS });
    },
    updateSettings(patch) {
      validateSettingsPatch(patch);
      const statement = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
      const update = db.transaction((entries) => {
        for (const [key, value] of entries) statement.run(key, JSON.stringify(value));
      });
      if (patch.maxRetainedMiB !== undefined) withinRetainedBudget(() => update.immediate(Object.entries(patch)));
      else update.immediate(Object.entries(patch));
      return this.getSettings();
    },
    capacity() {
      const settings = this.getSettings();
      const queued = db.prepare("SELECT COUNT(*) AS count FROM runs WHERE status = 'queued'").get().count;
      const active = db.prepare("SELECT COUNT(*) AS count FROM runs WHERE status IN ('launching', 'running')").get().count;
      const recoverable = db.prepare("SELECT COUNT(*) AS count FROM runs WHERE status = 'interrupted' AND recovery_decision IS NULL").get().count;
      const bytes = retainedBytes(db);
      const maxRetainedBytes = settings.maxRetainedMiB * 1024 * 1024;
      return { queued, active, recoverable, retainedBytes: bytes,
        availableForNewWorkBytes: Math.max(0, maxRetainedBytes - retainedReserveBytes - bytes), limits: {
        maxQueuedRuns: settings.maxQueuedRuns, maxConcurrentRuns: settings.maxConcurrentRuns,
        maxRetainedBytes, reservedRetainedBytes: retainedReserveBytes, retentionDays: settings.retentionDays,
        maxRunTranscriptItems: RESOURCE_BUDGETS.maxRunTranscriptItems, maxRunTranscriptBytes: RESOURCE_BUDGETS.maxRunTranscriptBytes,
        maxRunEventBytes: MAX_RUN_EVENT_RETAINED_BYTES,
      }, cpuUsage: null, memoryUsage: null, diskAllocatedBytes: null };
    },
    canLaunchRun() {
      // Keep enough ordinary retained space for a newly launched run to
      // record its first output. The separate reserve remains for recovery
      // and terminal transitions.
      return this.capacity().availableForNewWorkBytes >= 64 * 1024;
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
      const rows = db.prepare(`SELECT id, title, worktree_path AS worktreePath, updated_at AS updatedAt FROM conversations
        WHERE archived = 1 AND NOT EXISTS (SELECT 1 FROM runs WHERE conversation_id = conversations.id
          AND (status IN ('queued', 'launching', 'running') OR (status = 'interrupted' AND recovery_decision IS NULL)))
        AND (? IS NULL OR updated_at < ? OR (updated_at = ? AND id < ?))
        ORDER BY updated_at DESC, id DESC LIMIT ?`).all(after?.[0] ?? null, after?.[0] ?? null, after?.[0] ?? null, after?.[1] ?? null, limit + 1);
      const conversations = rows.slice(0, limit);
      const last = conversations.at(-1);
      return { conversations, nextCursor: rows.length > limit ? Buffer.from(JSON.stringify([last.updatedAt, last.id])).toString("base64url") : null };
    },
    deleteArchivedConversation(id, confirmation) {
      if (typeof id !== "string" || !id || id.length > 200 || confirmation !== id) {
        throw databaseError(400, "Confirm the exact archived conversation id before deleting it");
      }
      const remove = db.transaction(() => {
        const deleted = db.prepare(`DELETE FROM conversations WHERE id = ? AND archived = 1
          AND NOT EXISTS (SELECT 1 FROM runs WHERE conversation_id = conversations.id
            AND (status IN ('queued', 'launching', 'running') OR (status = 'interrupted' AND recovery_decision IS NULL)))`).run(id).changes;
        if (!deleted) {
          if (!db.prepare("SELECT 1 FROM conversations WHERE id = ?").get(id)) throw databaseError(404, "Conversation not found");
          throw databaseError(409, "Only archived conversations without active or unresolved recovery work can be deleted");
        }
        if (retainedBytes(db) <= this.getSettings().maxRetainedMiB * 1024 * 1024) {
          db.prepare("UPDATE retained_usage SET legacy_ceiling = 0 WHERE id = 1").run();
        }
        return { deleted: 1, id };
      });
      return remove.immediate();
    },
    // Only archived conversations without pending or recoverable work may be
    // removed. This is one transaction so a failed deletion cannot leave
    // messages, run events, or recovery ownership half-pruned.
    pruneHistory({ before, limit = 100 } = {}) {
      const maximum = Date.now() - this.getSettings().retentionDays * 86_400_000;
      const requested = before ?? new Date(maximum).toISOString();
      const cutoffTime = typeof requested === "string" ? Date.parse(requested) : NaN;
      if (!Number.isFinite(cutoffTime) || cutoffTime > maximum) {
        throw databaseError(400, "Retention cutoff must be a valid date within the saved retention window");
      }
      // SQLite compares updated_at as ISO text, so bind the parsed instant in
      // the same format rather than a caller's locale or timezone spelling.
      const cutoff = new Date(cutoffTime).toISOString();
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw databaseError(400, "Retention limit must be 1 to 1000");
      const prune = db.transaction(() => {
        const ids = db.prepare(`SELECT id FROM conversations WHERE archived = 1 AND updated_at < ?
          AND NOT EXISTS (SELECT 1 FROM runs WHERE conversation_id = conversations.id
            AND (status IN ('queued', 'launching', 'running') OR (status = 'interrupted' AND recovery_decision IS NULL)))
          ORDER BY updated_at, id LIMIT ?`).all(cutoff, limit).map((row) => row.id);
        const remove = db.prepare("DELETE FROM conversations WHERE id = ?");
        for (const id of ids) remove.run(id);
        if (retainedBytes(db) <= this.getSettings().maxRetainedMiB * 1024 * 1024) {
          db.prepare("UPDATE retained_usage SET legacy_ceiling = 0 WHERE id = 1").run();
        }
        return { deleted: ids.length, ids };
      });
      return prune.immediate();
    },
    listGroups() {
      const groups = db.prepare("SELECT id, name, position, created_at AS createdAt FROM project_groups ORDER BY position, created_at").all();
      const memberships = Object.fromEntries(db.prepare("SELECT project_id, group_id FROM project_memberships").all().map((row) => [row.project_id, row.group_id]));
      return { groups, memberships };
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
      const where = ["archived = ?"];
      const values = [filters.archived ? 1 : 0];
      if (filters.projectId) { where.push("project_id = ?"); values.push(filters.projectId); }
      if (filters.worktreeId) { where.push("worktree_id = ?"); values.push(filters.worktreeId); }
      return db.prepare(`SELECT ${conversationColumns()} FROM conversations WHERE ${where.join(" AND ")} ORDER BY pinned DESC, tab_position, updated_at DESC`).all(...values);
    },
    getConversation(id) {
      return db.prepare(`SELECT ${conversationColumns()} FROM conversations WHERE id = ?`).get(id);
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
        if (["title", "model", "provider"].some((key) => patch[key] !== undefined)) withinRetainedBudget(update);
        else update();
      }
      return this.getConversation(id);
    },
    moveConversation(id, destination) {
      const unresolved = this.listUnresolvedInterruptedRuns(id);
      if (unresolved.some((run) => !run.worktreePath || run.worktreePath !== destination.worktreePath)) {
        throw databaseError(409, "Resolve the interrupted run before moving this conversation away from its recovery worktree");
      }
      const position = db.prepare("SELECT COALESCE(MAX(tab_position), -1) + 1 AS position FROM conversations WHERE project_id = ? AND worktree_id = ?").get(destination.projectId, destination.worktreeId).position;
      db.prepare("UPDATE conversations SET project_id = ?, worktree_id = ?, worktree_path = ?, tab_position = ?, updated_at = ? WHERE id = ?")
        .run(destination.projectId, destination.worktreeId, destination.worktreePath, position, now(), id);
      return this.getConversation(id);
    },
    listMessages(conversationId) {
      return db.prepare(`SELECT search_order AS searchOrder, id, conversation_id AS conversationId, role, kind, body, payload, created_at AS createdAt
        FROM messages WHERE conversation_id = ? ORDER BY search_order`).all(conversationId).map(hydratePayload);
    },
    messageCount(conversationId) {
      return db.prepare("SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?").get(conversationId).count;
    },
    listMessagePage(conversationId, options = {}) {
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
          FROM messages INDEXED BY messages_search_order WHERE conversation_id = ? AND search_order < ? ORDER BY search_order DESC LIMIT ?`).all(conversationId, cursor.rowid, limit);
      } else if (options.afterId) {
        const cursor = db.prepare("SELECT search_order AS rowid FROM messages WHERE conversation_id = ? AND id = ?").get(conversationId, options.afterId);
        if (!cursor) throw databaseError(400, "Message cursor was not found");
        candidates = db.prepare(`SELECT ${candidateColumns}
          FROM messages INDEXED BY messages_search_order WHERE conversation_id = ? AND search_order > ? ORDER BY search_order ASC LIMIT ?`).all(conversationId, cursor.rowid, limit);
      } else {
        candidates = db.prepare(`SELECT ${candidateColumns}
          FROM messages INDEXED BY messages_search_order WHERE conversation_id = ? ORDER BY search_order DESC LIMIT ?`).all(conversationId, limit);
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
          FROM messages INDEXED BY messages_search_order WHERE conversation_id = ? AND search_order BETWEEN ? AND ? ORDER BY search_order`)
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
      const olderCount = oldestRowId ? db.prepare("SELECT COUNT(*) AS count FROM messages INDEXED BY messages_search_order WHERE conversation_id = ? AND search_order < ?").get(conversationId, oldestRowId).count : options.afterId ? total : 0;
      const hasMore = olderCount > 0;
      const newerCount = Math.max(0, total - olderCount - messages.length);
      return {
        messages,
        page: { hasMore, olderCount, hasLater: newerCount > 0, newerCount, total, beforeId: messages[0]?.id ?? null, limit },
      };
    },
    async findMessagePage(conversationId, query, afterId, direction = 1, signal,
      { originId = afterId, wrapped = false, byteOffset = 0, contextOffset = 0, leftContextOffset = 0, leftContextCased = null } = {}) {
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
        const batch = db.prepare(`SELECT ${columns} FROM messages INDEXED BY messages_search_order WHERE conversation_id = ? AND search_order ${comparison} ? ORDER BY search_order ${order} LIMIT 8`);
        const wrappedBatch = origin && db.prepare(`SELECT ${columns} FROM messages INDEXED BY messages_search_order WHERE conversation_id = ? AND search_order ${comparison} ? AND search_order ${forward ? "<=" : ">="} ? ORDER BY search_order ${order} LIMIT 8`);
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
        if (result?.partial) return result;
        if (!result) return { matchId: null, messages: [], messagePage: null };
        const match = result.match;
        // Select by stored byte lengths before hydrating message bodies. A
        // 200-row Find window can otherwise serialize hundreds of MiB even
        // though the search scan itself has an 8 MiB work limit.
        const sizes = `SELECT search_order AS rowid, id, COALESCE(LENGTH(CAST(body AS BLOB)), 0) + COALESCE(LENGTH(CAST(payload AS BLOB)), 0) + 512 AS bytes
          FROM messages INDEXED BY messages_search_order WHERE conversation_id = ? AND search_order`;
        const olderCandidates = db.prepare(`${sizes} <= ? ORDER BY search_order DESC LIMIT 100`).all(conversationId, match.rowid);
        const newerCandidates = db.prepare(`${sizes} > ? ORDER BY search_order ASC LIMIT 100`).all(conversationId, match.rowid);
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
          FROM messages INDEXED BY messages_search_order WHERE conversation_id = ? AND search_order BETWEEN ? AND ? ORDER BY search_order`)
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
        const olderCount = db.prepare("SELECT COUNT(*) AS count FROM messages INDEXED BY messages_search_order WHERE conversation_id = ? AND search_order < ?").get(conversationId, messages[0].searchOrder).count;
        const newerCount = db.prepare("SELECT COUNT(*) AS count FROM messages INDEXED BY messages_search_order WHERE conversation_id = ? AND search_order > ?").get(conversationId, messages.at(-1).searchOrder).count;
        return { matchId: match.id, messages, messagePage: {
          hasMore: olderCount > 0, olderCount, hasLater: newerCount > 0, newerCount,
          total: olderCount + messages.length + newerCount, beforeId: messages[0].id, limit: 200,
        } };
      } finally { activeMessageFinds -= 1; }
    },
    getMessageBodyChunk(conversationId, messageId, offset) {
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
    addMessage(input) {
      const message = { id: input.id ?? randomUUID(), createdAt: input.createdAt ?? now(), ...input };
      return withinRetainedBudget(() => {
        const inserted = db.prepare("INSERT INTO messages (id, conversation_id, role, kind, body, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(message.id, message.conversationId, message.role, message.kind ?? "text", message.body ?? "", JSON.stringify(message.payload ?? null), message.createdAt);
      // Clamp instead of overwrite: a message must never move the
      // conversation's updated_at backwards in sidebar and search ordering.
      db.prepare("UPDATE conversations SET updated_at = MAX(updated_at, ?) WHERE id = ?").run(message.createdAt, message.conversationId);
        return { ...message, searchOrder: Number(inserted.lastInsertRowid) };
      }, message.payload?.truncated ? 0 : retainedReserveBytes);
    },
    upsertMessage(input) {
      const message = { id: input.id ?? randomUUID(), createdAt: input.createdAt ?? now(), ...input };
      return withinRetainedBudget(() => {
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
    },
    createRun(input) {
      const insert = db.transaction(() => {
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
        output_tokens AS outputTokens, recovery_class AS recoveryClass, recovery_decision AS recoveryDecision FROM runs WHERE id = ?`).get(id);
    },
    listRuns(conversationId, limit = 200) {
      const boundedLimit = Math.max(1, Math.min(500, Number(limit) || 200));
      return db.prepare(`SELECT id, conversation_id AS conversationId, worktree_path AS worktreePath, provider, model, reasoning_effort AS reasoningEffort, approval_policy AS approvalPolicy,
        prompt, status, pid, provider_session_id AS providerSessionId, created_at AS createdAt, started_at AS startedAt,
        finished_at AS finishedAt, exit_code AS exitCode, error, cost_usd AS costUsd, input_tokens AS inputTokens,
        output_tokens AS outputTokens, recovery_class AS recoveryClass, recovery_decision AS recoveryDecision FROM runs WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(conversationId, boundedLimit);
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
      return db.prepare(`SELECT runs.id, runs.conversation_id AS conversationId, runs.worktree_path AS worktreePath, runs.provider, runs.model,
        runs.reasoning_effort AS reasoningEffort, runs.approval_policy AS approvalPolicy, runs.prompt, runs.status, runs.pid,
        runs.provider_session_id AS providerSessionId, runs.created_at AS createdAt, runs.started_at AS startedAt,
        runs.finished_at AS finishedAt, runs.exit_code AS exitCode, runs.error, runs.cost_usd AS costUsd,
        runs.input_tokens AS inputTokens, runs.output_tokens AS outputTokens, runs.recovery_class AS recoveryClass,
        runs.recovery_decision AS recoveryDecision
        FROM runs
        WHERE (runs.worktree_path = ? OR runs.worktree_path IS NULL) AND runs.status = 'interrupted' AND runs.recovery_decision IS NULL
        ORDER BY CASE WHEN runs.worktree_path IS NULL THEN 0 ELSE 1 END, runs.created_at, runs.rowid`).all(worktreePath);
    },
    findUnresolvedInterruptedRunForWorktree(worktreePath) {
      return db.prepare(`SELECT runs.id, runs.conversation_id AS conversationId, runs.worktree_path AS worktreePath, runs.provider, runs.model,
        runs.reasoning_effort AS reasoningEffort, runs.approval_policy AS approvalPolicy, runs.prompt, runs.status, runs.pid,
        runs.provider_session_id AS providerSessionId, runs.created_at AS createdAt, runs.started_at AS startedAt,
        runs.finished_at AS finishedAt, runs.exit_code AS exitCode, runs.error, runs.cost_usd AS costUsd,
        runs.input_tokens AS inputTokens, runs.output_tokens AS outputTokens, runs.recovery_class AS recoveryClass,
        runs.recovery_decision AS recoveryDecision
        FROM runs
        WHERE (runs.worktree_path = ? OR runs.worktree_path IS NULL) AND runs.status = 'interrupted' AND runs.recovery_decision IS NULL
        ORDER BY CASE WHEN runs.worktree_path IS NULL THEN 0 ELSE 1 END, runs.created_at, runs.rowid LIMIT 1`).get(worktreePath);
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
      const adopted = [];
      const keepHandshakeIds = new Set();
      const reconcile = db.transaction(() => {
        const pending = db.prepare("SELECT id, status, pid FROM runs WHERE status IN ('queued', 'running', 'launching')").all();
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
              // The identity is now durably adopted into the row; the record
              // itself must not linger.
              adopted.push(run.id);
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
          // A row whose tree may still be live (alive/unknown) may still own
          // a wrapper that removes its own record on exit; keep those. An
          // 'exited' tree is proven gone, so a hard-killed wrapper can no
          // longer unlink its record — keeping it would leak one stale file
          // per hard-killed run.
          if (run.status === "running" && (classification === "alive" || classification === "unknown")) keepHandshakeIds.add(run.id);
        }
      });
      reconcile.immediate();
      // Handshake hygiene: adopted records are deleted, and records belonging
      // to runs that are not pending (terminal, resolved, or unknown ids) are
      // swept so a hard-killed runtime cannot leak one file per crash.
      for (const runId of adopted) removeLaunchHandshake(launchDirectory, runId);
      sweepLaunchHandshakes(launchDirectory, keepHandshakeIds);
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
        return { interrupted: this.getRun(id), run, conversation: this.getConversation(interrupted.conversationId) };
      });
      return recover.immediate();
    },
    updateRun(id, patch) {
      const fields = [];
      const values = [];
      for (const [key, column] of Object.entries({ status: "status", pid: "pid", providerSessionId: "provider_session_id", startedAt: "started_at", finishedAt: "finished_at", exitCode: "exit_code", error: "error", costUsd: "cost_usd", inputTokens: "input_tokens", outputTokens: "output_tokens", recoveryClass: "recovery_class", recoveryDecision: "recovery_decision" })) {
        if (patch[key] === undefined) continue;
        fields.push(`${column} = ?`); values.push(patch[key]);
      }
      if (fields.length) db.prepare(`UPDATE runs SET ${fields.join(", ")} WHERE id = ?`).run(...values, id);
      return this.getRun(id);
    },
    finishRun(id, patch, transcriptMessage = null) {
      const finish = db.transaction(() => {
        let message = null;
        if (transcriptMessage) {
          try { message = this.upsertMessage(transcriptMessage); }
          catch (error) { if (error.statusCode !== 507) throw error; }
        }
        const run = this.updateRun(id, patch);
        return { run, message };
      });
      return finish.immediate();
    },
    appendRunEvent(runId, type, payload) {
      const commit = db.transaction(() => {
        const seq = db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM run_events WHERE run_id = ?").get(runId).seq;
        const createdAt = now();
        const serialized = serializePayload(payload);
        const result = db.prepare("INSERT INTO run_events (run_id, seq, type, payload, created_at) VALUES (?, ?, ?, ?, ?)").run(runId, seq, type, serialized, createdAt);
        db.prepare(`INSERT INTO run_event_usage (run_id, bytes) VALUES (?, ?)
          ON CONFLICT(run_id) DO UPDATE SET bytes = bytes + excluded.bytes`).run(runId, Buffer.byteLength(serialized) + 128);
        // Replay is a bounded tail. Durable transcript checkpoints and run
        // rows remain separate, so pruning does not erase recovery evidence.
        let bytes = db.prepare("SELECT bytes FROM run_event_usage WHERE run_id = ?").get(runId).bytes;
        const old = db.prepare("SELECT id, seq, COALESCE(LENGTH(CAST(payload AS BLOB)), 0) + 128 AS bytes FROM run_events WHERE run_id = ? ORDER BY seq LIMIT 1");
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
      catch (error) { if (error.statusCode !== 507) throw error; return null; }
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
        return { event, message };
      });
      return commit.immediate();
    },
    listRunEvents(runId, after = 0) {
      const cursor = Number.isSafeInteger(Number(after)) && Number(after) >= 0 ? Number(after) : 0;
      return db.prepare("SELECT id, run_id AS runId, seq, type, payload, created_at AS createdAt FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT 2000")
        .all(runId, cursor).map(hydratePayload);
    },
    trustProject(projectId, projectPath) {
      withinRetainedBudget(() => db.prepare("INSERT INTO trusted_projects (project_id, project_path, trusted_at) VALUES (?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET project_path = excluded.project_path, trusted_at = excluded.trusted_at")
        .run(projectId, projectPath, now()));
    },
    untrustProject(projectId) { db.prepare("DELETE FROM trusted_projects WHERE project_id = ?").run(projectId); },
    isProjectTrusted(projectId, projectPath) {
      const row = db.prepare("SELECT project_path FROM trusted_projects WHERE project_id = ?").get(projectId);
      return row?.project_path === projectPath;
    },
    listTrustedProjects() { return db.prepare("SELECT project_id AS projectId, project_path AS projectPath, trusted_at AS trustedAt FROM trusted_projects ORDER BY trusted_at DESC").all(); },
    audit(action, details = {}) {
      try { withinRetainedBudget(() => {
        db.prepare("INSERT INTO audit_log (action, target, details, created_at) VALUES (?, ?, ?, ?)").run(action, String(details.target ?? "").slice(0, 512), serializePayload(details, 4 * 1024), now());
        db.prepare(`DELETE FROM audit_log WHERE id <= (SELECT id FROM audit_log ORDER BY id DESC LIMIT 1 OFFSET 9999)
        AND target NOT IN (SELECT id FROM runs WHERE status IN ('queued', 'launching', 'running')
          OR (status = 'interrupted' AND recovery_decision IS NULL))`).run();
      }); } catch (error) { if (error.statusCode !== 507) throw error; }
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
      const needle = `%${query}%`;
      const conversations = db.prepare(`SELECT ${conversationColumns()} FROM conversations WHERE title LIKE ? OR id IN (SELECT conversation_id FROM messages WHERE body LIKE ?) ORDER BY updated_at DESC LIMIT ?`).all(needle, needle, limit);
      const messages = db.prepare("SELECT id, conversation_id AS conversationId, role, kind, body, created_at AS createdAt FROM messages WHERE body LIKE ? ORDER BY created_at DESC LIMIT ?").all(needle, limit);
      return { conversations, messages };
    },
  };
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS project_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS project_memberships (project_id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES project_groups(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, worktree_id TEXT NOT NULL, worktree_path TEXT NOT NULL,
      title TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', provider_session_id TEXT, tab_position INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
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
      recovery_class TEXT, recovery_decision TEXT
    );
    CREATE INDEX IF NOT EXISTS runs_conversation ON runs(conversation_id, created_at);
    CREATE TABLE IF NOT EXISTS run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT, created_at TEXT NOT NULL, UNIQUE(run_id, seq)
    );
    CREATE TABLE IF NOT EXISTS run_event_usage (run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE, bytes INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS trusted_projects (project_id TEXT PRIMARY KEY, project_path TEXT NOT NULL, trusted_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, target TEXT, details TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS prompt_templates (id TEXT PRIMARY KEY, title TEXT NOT NULL, prompt TEXT NOT NULL, created_at TEXT NOT NULL);
  `);
  db.exec(`INSERT OR IGNORE INTO run_event_usage (run_id, bytes)
    SELECT run_id, SUM(COALESCE(LENGTH(CAST(payload AS BLOB)), 0) + 128) FROM run_events GROUP BY run_id`);
  if (!db.pragma("table_info(messages)").some((column) => column.name === "search_order")) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("ALTER TABLE messages ADD COLUMN search_order INTEGER");
      db.exec("UPDATE messages SET search_order = rowid");
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  db.exec(`CREATE TRIGGER IF NOT EXISTS messages_search_order_insert AFTER INSERT ON messages
    BEGIN UPDATE messages SET search_order = NEW.rowid WHERE rowid = NEW.rowid; END`);
  db.exec("CREATE INDEX IF NOT EXISTS messages_search_order ON messages(conversation_id, search_order)");
  try { db.exec("ALTER TABLE conversations ADD COLUMN tab_position INTEGER NOT NULL DEFAULT 0"); } catch { /* Already migrated. */ }
  try { db.exec("ALTER TABLE runs ADD COLUMN reasoning_effort TEXT NOT NULL DEFAULT 'medium'"); } catch { /* Already migrated. */ }
  try { db.exec("ALTER TABLE runs ADD COLUMN pid INTEGER"); } catch { /* Already migrated. */ }
  try { db.exec("ALTER TABLE runs ADD COLUMN recovery_class TEXT"); } catch { /* Already migrated. */ }
  try { db.exec("ALTER TABLE runs ADD COLUMN recovery_decision TEXT"); } catch { /* Already migrated. */ }
  try { db.exec("ALTER TABLE runs ADD COLUMN worktree_path TEXT"); } catch { /* Already migrated. */ }
  // Terminal legacy rows no longer own execution and can use the
  // conversation's current target for history display. A pending or
  // interrupted legacy row may have started before its conversation moved;
  // leave that target unknown so it gates every worktree until recovery is
  // resolved instead of guessing a path that could release the real checkout.
  db.exec(`UPDATE runs SET worktree_path = (SELECT worktree_path FROM conversations WHERE conversations.id = runs.conversation_id)
    WHERE worktree_path IS NULL AND status IN ('completed', 'failed', 'stopped')`);
  db.exec("CREATE INDEX IF NOT EXISTS runs_worktree_recovery ON runs(worktree_path, status, recovery_decision, created_at)");
  // Rebuild once at startup for legacy databases, then maintain in the same
  // SQLite transaction as every write and cascade. Admission stays O(1) as
  // transcript history grows over long sessions.
  db.exec("CREATE TABLE IF NOT EXISTS retained_usage (id INTEGER PRIMARY KEY CHECK(id = 1), bytes INTEGER NOT NULL, legacy_ceiling INTEGER NOT NULL DEFAULT 0)");
  if (!db.pragma("table_info(retained_usage)").some((column) => column.name === "legacy_ceiling")) {
    db.exec("ALTER TABLE retained_usage ADD COLUMN legacy_ceiling INTEGER NOT NULL DEFAULT 0");
  }
  db.exec("INSERT OR IGNORE INTO retained_usage (id, bytes) VALUES (1, 0)");
  for (const [table, fields] of RETAINED_COLUMNS) {
    const size = (alias) => `128 + ${fields.split(", ").map((field) => `COALESCE(LENGTH(CAST(${alias}.${field} AS BLOB)), 0)`).join(" + ")}`;
    db.exec(`CREATE TRIGGER IF NOT EXISTS retained_${table}_insert AFTER INSERT ON ${table}
      BEGIN UPDATE retained_usage SET bytes = bytes + (${size("NEW")}) WHERE id = 1; END`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS retained_${table}_update AFTER UPDATE ON ${table}
      BEGIN UPDATE retained_usage SET bytes = bytes + (${size("NEW")}) - (${size("OLD")}) WHERE id = 1; END`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS retained_${table}_delete AFTER DELETE ON ${table}
      BEGIN UPDATE retained_usage SET bytes = bytes - (${size("OLD")}) WHERE id = 1; END`);
  }
  // A pre-budget database may already exceed the saved limit. Preserve its
  // active recovery rows with at most one MiB of transition headroom; optional
  // writes still use the ordinary configured limit and cleanup clears this
  // migration allowance once retained usage falls below quota.
  db.exec("DROP TRIGGER IF EXISTS retained_hard_limit");
  const measured = calculateRetainedBytes(db);
  const configured = Number(db.prepare("SELECT value FROM settings WHERE key = 'maxRetainedMiB'").get()?.value ?? DEFAULT_SETTINGS.maxRetainedMiB) * 1024 * 1024;
  const priorCeiling = db.prepare("SELECT legacy_ceiling FROM retained_usage WHERE id = 1").get().legacy_ceiling;
  db.prepare("UPDATE retained_usage SET bytes = ?, legacy_ceiling = ? WHERE id = 1")
    .run(measured, measured > configured ? (measured > priorCeiling ? measured + 1024 * 1024 : priorCeiling) : 0);
  db.exec(`CREATE TRIGGER retained_hard_limit BEFORE UPDATE ON retained_usage
    WHEN NEW.bytes > MAX(COALESCE((SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'maxRetainedMiB'), ${DEFAULT_SETTINGS.maxRetainedMiB}) * 1048576, OLD.legacy_ceiling)
    BEGIN SELECT RAISE(ABORT, 'OUTRIGHT_RETAINED_LIMIT'); END`);
}

function conversationColumns() {
  return `id, project_id AS projectId, worktree_id AS worktreeId, worktree_path AS worktreePath, title, provider, model,
    provider_session_id AS providerSessionId, archived, pinned, tab_position AS tabPosition, created_at AS createdAt, updated_at AS updatedAt`;
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
function calculateRetainedBytes(db) {
  return RETAINED_COLUMNS.reduce((total, [table, fields]) => total + db.prepare(`SELECT COALESCE(SUM(128 + ${fields.split(", ").map((field) => `COALESCE(LENGTH(CAST(${field} AS BLOB)), 0)`).join(" + ")}), 0) AS bytes FROM ${table}`).get().bytes, 0);
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
function removeLaunchHandshake(launchDirectory, runId) {
  try { unlinkSync(path.join(launchDirectory, `${runId}.json`)); } catch { /* Already gone. */ }
}
// Deletes handshake records that no longer belong to a pending run, so a
// runtime hard-killed after authorization cannot leak one stale file per
// crash. Records for rows that were actually running are kept: their wrapper
// may still be alive and removes its own record when it exits.
function sweepLaunchHandshakes(launchDirectory, keepRunIds) {
  let entries;
  try { entries = readdirSync(launchDirectory); }
  catch { return; }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const runId = entry.slice(0, -".json".length);
    if (keepRunIds.has(runId)) continue;
    try { rmSync(path.join(launchDirectory, entry), { force: true }); } catch { /* Already gone. */ }
  }
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
