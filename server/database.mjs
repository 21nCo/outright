import Database from "better-sqlite3";
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_SETTINGS = {
  provider: "codex",
  model: "",
  reasoningEffort: "medium",
  approvalPolicy: "workspace-write",
  editor: "zed",
  maxConcurrentRuns: 3,
  notifications: true,
  theme: "system",
};

const MAX_RUN_EVENT_PAYLOAD_BYTES = 256 * 1024;

const SETTING_RULES = {
  provider: (value) => typeof value === "string" && ["codex", "claude"].includes(value),
  model: (value) => typeof value === "string" && value.length <= 200,
  reasoningEffort: (value) => ["low", "medium", "high", "xhigh"].includes(value),
  approvalPolicy: (value) => ["read-only", "workspace-write", "danger-full-access"].includes(value),
  editor: (value) => ["zed", "code", "cursor", "finder"].includes(value),
  maxConcurrentRuns: (value) => Number.isInteger(value) && value >= 1 && value <= 8,
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

  return {
    filename,
    launchDirectory,
    close: () => db.close(),
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
      update.immediate(Object.entries(patch));
      return this.getSettings();
    },
    listGroups() {
      const groups = db.prepare("SELECT id, name, position, created_at AS createdAt FROM project_groups ORDER BY position, created_at").all();
      const memberships = Object.fromEntries(db.prepare("SELECT project_id, group_id FROM project_memberships").all().map((row) => [row.project_id, row.group_id]));
      return { groups, memberships };
    },
    createGroup(name) {
      const id = randomUUID();
      const position = db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS position FROM project_groups").get().position;
      db.prepare("INSERT INTO project_groups (id, name, position, created_at) VALUES (?, ?, ?, ?)").run(id, name.trim(), position, now());
      return db.prepare("SELECT id, name, position, created_at AS createdAt FROM project_groups WHERE id = ?").get(id);
    },
    updateGroup(id, patch) {
      if (typeof patch.name === "string" && patch.name.trim()) db.prepare("UPDATE project_groups SET name = ? WHERE id = ?").run(patch.name.trim(), id);
      if (Number.isInteger(patch.position)) db.prepare("UPDATE project_groups SET position = ? WHERE id = ?").run(patch.position, id);
      return db.prepare("SELECT id, name, position, created_at AS createdAt FROM project_groups WHERE id = ?").get(id);
    },
    deleteGroup(id) {
      return db.prepare("DELETE FROM project_groups WHERE id = ?").run(id).changes > 0;
    },
    setProjectGroup(projectId, groupId) {
      if (!groupId) db.prepare("DELETE FROM project_memberships WHERE project_id = ?").run(projectId);
      else db.prepare("INSERT INTO project_memberships (project_id, group_id) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET group_id = excluded.group_id").run(projectId, groupId);
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
      const id = randomUUID();
      const timestamp = now();
      const position = db.prepare("SELECT COALESCE(MAX(tab_position), -1) + 1 AS position FROM conversations WHERE project_id = ? AND worktree_id = ?").get(input.projectId, input.worktreeId).position;
      db.prepare(`INSERT INTO conversations (id, project_id, worktree_id, worktree_path, title, provider, model, tab_position, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, input.projectId, input.worktreeId, input.worktreePath, input.title?.trim() || "New agent chat", input.provider || "codex", input.model || "", position, timestamp, timestamp);
      return this.getConversation(id);
    },
    updateConversation(id, patch) {
      if (patch.archived !== undefined && typeof patch.archived !== "boolean") {
        throw databaseError(400, "Conversation archived state must be a boolean");
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
        db.prepare(`UPDATE conversations SET ${fields.join(", ")} WHERE id = ?`).run(...values);
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
      return db.prepare(`SELECT id, conversation_id AS conversationId, role, kind, body, payload, created_at AS createdAt
        FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid`).all(conversationId).map(hydratePayload);
    },
    listMessagePage(conversationId, options = {}) {
      const limit = Math.max(1, Math.min(500, Number(options.limit) || 200));
      let rows;
      if (options.beforeId) {
        const cursor = db.prepare("SELECT rowid FROM messages WHERE conversation_id = ? AND id = ?").get(conversationId, options.beforeId);
        if (!cursor) throw databaseError(400, "Message cursor was not found");
        rows = db.prepare(`SELECT rowid AS messageRowId, id, conversation_id AS conversationId, role, kind, body, payload, created_at AS createdAt
          FROM messages WHERE conversation_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT ?`).all(conversationId, cursor.rowid, limit);
      } else {
        rows = db.prepare(`SELECT rowid AS messageRowId, id, conversation_id AS conversationId, role, kind, body, payload, created_at AS createdAt
          FROM messages WHERE conversation_id = ? ORDER BY rowid DESC LIMIT ?`).all(conversationId, limit);
      }
      rows.reverse();
      const oldestRowId = rows[0]?.messageRowId;
      const olderCount = oldestRowId ? db.prepare("SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ? AND rowid < ?").get(conversationId, oldestRowId).count : 0;
      const hasMore = olderCount > 0;
      const total = db.prepare("SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?").get(conversationId).count;
      return {
        messages: rows.map(({ messageRowId: _messageRowId, ...row }) => hydratePayload(row)),
        page: { hasMore, olderCount, total, beforeId: rows[0]?.id ?? null, limit },
      };
    },
    addMessage(input) {
      const message = { id: input.id ?? randomUUID(), createdAt: input.createdAt ?? now(), ...input };
      db.prepare("INSERT INTO messages (id, conversation_id, role, kind, body, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(message.id, message.conversationId, message.role, message.kind ?? "text", message.body ?? "", JSON.stringify(message.payload ?? null), message.createdAt);
      // Clamp instead of overwrite: a message must never move the
      // conversation's updated_at backwards in sidebar and search ordering.
      db.prepare("UPDATE conversations SET updated_at = MAX(updated_at, ?) WHERE id = ?").run(message.createdAt, message.conversationId);
      return message;
    },
    upsertMessage(input) {
      const message = { id: input.id ?? randomUUID(), createdAt: input.createdAt ?? now(), ...input };
      db.prepare(`INSERT INTO messages (id, conversation_id, role, kind, body, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET role = excluded.role, kind = excluded.kind, body = excluded.body, payload = excluded.payload`)
        .run(message.id, message.conversationId, message.role, message.kind ?? "text", message.body ?? "", JSON.stringify(message.payload ?? null), message.createdAt);
      // Assistant checkpoints reuse one stable createdAt across the whole
      // stream, so the plain overwrite could regress updated_at after a newer
      // tool/user message advanced it; clamp to the newer timestamp instead.
      db.prepare("UPDATE conversations SET updated_at = MAX(updated_at, ?) WHERE id = ?").run(message.createdAt, message.conversationId);
      return hydratePayload(db.prepare(`SELECT id, conversation_id AS conversationId, role, kind, body, payload, created_at AS createdAt
        FROM messages WHERE id = ?`).get(message.id));
    },
    createRun(input) {
      const run = { id: randomUUID(), status: "queued", createdAt: now(), ...input };
      const worktreePath = run.worktreePath ?? this.getConversation(run.conversationId)?.worktreePath;
      if (!worktreePath) throw databaseError(400, "Run worktree path is required");
      db.prepare(`INSERT INTO runs (id, conversation_id, worktree_path, provider, model, reasoning_effort, approval_policy, prompt, status, provider_session_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(run.id, run.conversationId, worktreePath, run.provider, run.model ?? "", run.reasoningEffort ?? "medium", run.approvalPolicy, run.prompt, run.status, run.providerSessionId ?? null, run.createdAt);
      return this.getRun(run.id);
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
          else if (run.pid != null) classification = normalizeProbeResult(probeAlive(run.pid));
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
    // while the replacement run carries the work forward.
    resolveInterruptedRun(id, decision) {
      const run = this.getRun(id);
      if (!run || !["discard", "resume-session", "retry"].includes(decision)) return null;
      if (run.status !== "interrupted" || run.recoveryDecision) return null;
      const status = decision === "discard" ? "failed" : "interrupted";
      const error = decision === "discard" ? "Discarded after restart recovery review" : null;
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
        const message = transcriptMessage ? this.upsertMessage(transcriptMessage) : null;
        const run = this.updateRun(id, patch);
        return { run, message };
      });
      return finish.immediate();
    },
    appendRunEvent(runId, type, payload) {
      const seq = db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM run_events WHERE run_id = ?").get(runId).seq;
      const createdAt = now();
      const serialized = serializePayload(payload);
      const result = db.prepare("INSERT INTO run_events (run_id, seq, type, payload, created_at) VALUES (?, ?, ?, ?, ?)").run(runId, seq, type, serialized, createdAt);
      db.prepare("DELETE FROM run_events WHERE run_id = ? AND seq <= ?").run(runId, seq - 2_000);
      return { id: Number(result.lastInsertRowid), runId, seq, type, payload: parseJson(serialized, null), createdAt };
    },
    listRunEvents(runId, after = 0) {
      const cursor = Number.isSafeInteger(Number(after)) && Number(after) >= 0 ? Number(after) : 0;
      return db.prepare("SELECT id, run_id AS runId, seq, type, payload, created_at AS createdAt FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT 2000")
        .all(runId, cursor).map(hydratePayload);
    },
    trustProject(projectId, projectPath) {
      db.prepare("INSERT INTO trusted_projects (project_id, project_path, trusted_at) VALUES (?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET project_path = excluded.project_path, trusted_at = excluded.trusted_at")
        .run(projectId, projectPath, now());
    },
    untrustProject(projectId) { db.prepare("DELETE FROM trusted_projects WHERE project_id = ?").run(projectId); },
    isProjectTrusted(projectId, projectPath) {
      const row = db.prepare("SELECT project_path FROM trusted_projects WHERE project_id = ?").get(projectId);
      return row?.project_path === projectPath;
    },
    listTrustedProjects() { return db.prepare("SELECT project_id AS projectId, project_path AS projectPath, trusted_at AS trustedAt FROM trusted_projects ORDER BY trusted_at DESC").all(); },
    audit(action, details = {}) {
      db.prepare("INSERT INTO audit_log (action, target, details, created_at) VALUES (?, ?, ?, ?)").run(action, details.target ?? "", JSON.stringify(details), now());
    },
    listAudit(limit = 100) {
      return db.prepare("SELECT id, action, target, details, created_at AS createdAt FROM audit_log ORDER BY id DESC LIMIT ?").all(limit).map(hydrateDetails);
    },
    listTemplates() { return db.prepare("SELECT id, title, prompt, created_at AS createdAt FROM prompt_templates ORDER BY title").all(); },
    saveTemplate(input) {
      const id = input.id ?? randomUUID();
      db.prepare("INSERT INTO prompt_templates (id, title, prompt, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, prompt = excluded.prompt")
        .run(id, input.title.trim(), input.prompt.trim(), now());
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
      role TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'text', body TEXT NOT NULL DEFAULT '', payload TEXT, created_at TEXT NOT NULL
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
    CREATE TABLE IF NOT EXISTS trusted_projects (project_id TEXT PRIMARY KEY, project_path TEXT NOT NULL, trusted_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, target TEXT, details TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS prompt_templates (id TEXT PRIMARY KEY, title TEXT NOT NULL, prompt TEXT NOT NULL, created_at TEXT NOT NULL);
  `);
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
}

function conversationColumns() {
  return `id, project_id AS projectId, worktree_id AS worktreeId, worktree_path AS worktreePath, title, provider, model,
    provider_session_id AS providerSessionId, archived, pinned, tab_position AS tabPosition, created_at AS createdAt, updated_at AS updatedAt`;
}

function hydratePayload(row) { return { ...row, payload: parseJson(row.payload, null) }; }
function hydrateDetails(row) { return { ...row, details: parseJson(row.details, {}) }; }
function parseJson(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }
function now() { return new Date().toISOString(); }
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
