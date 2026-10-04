import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import test from "node:test";
import Database from "better-sqlite3";
import fs from "node:fs";
import { appendFileSync, existsSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOutrightDatabase, recoverArchiveBeforeStartup } from "./database.mjs";
import { retainedTranscriptMessageBytes } from "./resource-budgets.mjs";

function chat(database, title = "Budget test") {
  return database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title, provider: "codex" });
}

function archivePresentOrMaintaining(database, filename, id) {
  // Public reads hide a marked archive while cleanup still needs to finish.
  // Follow the durable row itself when asserting physical completion.
  if (database.maintenanceActive) return true;
  try {
    const probe = new Database(filename, { readonly: true, fileMustExist: true });
    try { return Boolean(probe.prepare("SELECT 1 FROM conversations WHERE id = ?").get(id)); }
    finally { probe.close(); }
  }
  catch (error) {
    if (database.capacity().migrationStatus === "maintenance") return true;
    throw error;
  }
}

function retainedReadback(db) {
  // Recount actual stored values after cutover, independently of the live
  // trigger counter. The 128-byte row allowance is part of the quota policy.
  const retained = {
    settings: "key value",
    project_groups: "id name created_at",
    project_memberships: "project_id group_id",
    conversations: "id project_id worktree_id worktree_path title provider model provider_session_id created_at updated_at",
    messages: "id conversation_id role kind body payload created_at",
    runs: "id conversation_id worktree_path provider model reasoning_effort approval_policy prompt status pid provider_session_id created_at started_at finished_at exit_code error cost_usd input_tokens output_tokens recovery_class recovery_decision transcript_omitted",
    run_events: "run_id type payload created_at",
    run_event_usage: "run_id",
    trusted_projects: "project_id project_path trusted_at",
    audit_log: "action target details created_at",
    prompt_templates: "id title prompt created_at",
  };
  let total = 0;
  for (const [table, fields] of Object.entries(retained)) {
    for (const row of db.prepare(`SELECT ${fields.split(" ").join(", ")} FROM ${table}`).all()) {
      total += 128 + Object.values(row).reduce((bytes, value) => bytes + (value == null ? 0
        : Buffer.isBuffer(value) ? value.byteLength : Buffer.byteLength(String(value))), 0);
    }
  }
  return total;
}

function runInput(conversationId) {
  return { conversationId, provider: "codex", approvalPolicy: "read-only", prompt: "work" };
}

function expandLegacyMessage(filename, messageId, mebibytes = 4) {
  const writer = new Database(filename);
  try { writer.prepare("UPDATE messages SET body = ? WHERE id = ?").run("x".repeat(mebibytes * 1024 * 1024), messageId); }
  finally { writer.close(); }
}

function ageArchived(filename, ids) {
  const admin = new Database(filename);
  const old = new Date(Date.now() - 100 * 86_400_000).toISOString();
  for (const id of ids) admin.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(old, id);
  admin.close();
}

test("missing SQLite pathname refuses optional retained rows and new queue work", { skip: process.platform === "win32" }, () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-unknown-disk-"));
  const filename = path.join(directory, "outright.db");
  const database = createOutrightDatabase({ filename });
  try {
    const conversation = chat(database, "active");
    const run = database.createRun(runInput(conversation.id));
    database.updateRun(run.id, { status: "interrupted" });
    unlinkSync(filename);
    assert.equal(database.capacity().diskUsageStatus, "unknown");
    assert.equal(database.capacity().diskAllocatedBytes, null);
    assert.equal(database.canLaunchRun(), false);
    const refused = (error) => error.statusCode === 507;
    assert.throws(() => chat(database, "refused"), refused);
    assert.throws(() => database.createRun(runInput(conversation.id)), refused);
    assert.throws(() => database.submitRun(runInput(conversation.id), "refused"), refused);
    assert.throws(() => database.beginInterruptedRunRecovery(run.id, "retry"), refused);
    assert.equal(database.getRun(run.id).recoveryDecision, null, "failed retry consumed the recovery decision");
    assert.throws(() => database.addMessage({ conversationId: conversation.id, role: "assistant", body: "refused" }), refused);
    assert.equal(database.appendRunEvent(run.id, "output", { text: "refused" }), null);
    assert.throws(() => database.saveTemplate({ title: "refused", prompt: "refused" }), refused);
    assert.throws(() => database.auditAdmission("git.commit.requested", { target: "refused" }), refused);
    assert.equal(database.audit("optional", { target: "refused" }), false);
    assert.equal(database.listRuns(conversation.id).length, 1, "refused submission left a queued run");
    assert.equal(database.listMessages(conversation.id).length, 0);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a pinned SQLite reader cannot turn repeated checkpoints into unbounded physical admission", { timeout: 60_000 }, async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-physical-wal-"));
  const filename = path.join(directory, "outright.db");
  const database = createOutrightDatabase({ filename });
  let reader;
  try {
    database.updateSettings({ maxRetainedMiB: 64 });
    const conversation = chat(database, "pinned physical WAL");
    const body = "w".repeat(1024 * 1024 - 8);
    const message = database.addMessage({ conversationId: conversation.id, role: "assistant", body: `${body}00000000` });
    reader = new Database(filename, { readonly: true });
    reader.exec("BEGIN");
    assert.equal(reader.prepare("SELECT length(body) AS bytes FROM messages WHERE id = ?").get(message.id).bytes, 1024 * 1024);
    let refused = false;
    for (let index = 1; index <= 300; index += 1) {
      try {
        database.upsertMessage({ ...message, body: String.fromCharCode(65 + index % 26).repeat(1024 * 1024) });
      } catch (error) {
        assert.equal(error.statusCode, 507);
        refused = true;
        break;
      }
    }
    assert.equal(refused, true, `repeated same-size checkpoints exceeded the physical threshold without refusal: ${JSON.stringify(database.capacity())}`);
    const capacity = database.capacity();
    assert.ok(capacity.retainedBytes < 3 * 1024 * 1024, "logical retained usage unexpectedly grew with WAL pages");
    assert.equal(capacity.availablePhysicalForNewWorkBytes, 0);
    assert.equal(database.canLaunchRun(), false, "a new run was admitted while WAL allocation exhausted its physical budget");
    assert.ok(capacity.diskAllocatedBytes >= capacity.limits.maxPhysicalBytes - capacity.limits.reservedPhysicalBytes);
    database.auditCritical("storage.physical.limit", { target: conversation.id });
    assert.ok(database.listAudit().some((entry) => entry.action === "storage.physical.limit"),
      "physical refusal consumed the recovery audit reserve");
    assert.throws(() => database.updateConversation(conversation.id, { archived: true, title: "extra metadata" }),
      (error) => error.statusCode === 507, "an archive request smuggled an optional metadata write through recovery headroom");
    const archived = database.updateConversation(conversation.id, { archived: true });
    assert.equal(archived.archived, 1, "physical new-work refusal also blocked archive recovery");
    assert.ok(database.listDeletableArchivedConversations().conversations.some((entry) => entry.id === conversation.id),
      "the only reclaimable conversation was not eligible for cleanup");
    reader.exec("COMMIT");
    reader.close();
    reader = null;
    const checkpoint = new Database(filename);
    try { checkpoint.pragma("wal_checkpoint(TRUNCATE)"); }
    finally { checkpoint.close(); }
    assert.equal((await database.deleteArchivedConversation(conversation.id, conversation.id)).deleted, 1,
      "archive cleanup did not reclaim the physical-budgeted conversation");
    assert.ok(database.capacity().availablePhysicalForNewWorkBytes > 64 * 1024);
    assert.equal(database.canLaunchRun(), true, "verified WAL reclamation did not reopen run admission");
  } finally { reader?.close(); database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("checkpoint storage failures omit optional output and preserve the durable run", async () => {
  for (const code of ["SQLITE_FULL", "SQLITE_IOERR_WRITE", "SQLITE_READONLY_CANTLOCK"]) {
    const directory = mkdtempSync(path.join(os.tmpdir(), "outright-checkpoint-refusal-"));
    const filename = path.join(realpathSync(directory), "outright.db");
    const database = createOutrightDatabase({ filename });
    database.updateSettings({ maxRetainedMiB: 64 });
    const conversation = chat(database);
    const run = database.createRun(runInput(conversation.id));
    const originalStat = fs.lstatSync;
    const originalPragma = Database.prototype.pragma;
    let checkpoints = 0;
    try {
      fs.lstatSync = (part, ...args) => {
        const info = originalStat(part, ...args);
        if (part !== filename) return info;
        return new Proxy(info, { get(target, key) {
          return key === "blocks" ? 1024 * 1024 : Reflect.get(target, key, target);
        } });
      };
      Database.prototype.pragma = function (command, ...args) {
        if (command === "wal_checkpoint(TRUNCATE)") {
          checkpoints += 1;
          throw Object.assign(new Error("injected checkpoint failure"), { code });
        }
        return originalPragma.call(this, command, ...args);
      };
      assert.ok(database.capacity().diskAllocatedBytes >= database.capacity().limits.maxPhysicalBytes,
        `the fixture must reach physical checkpoint admission: ${JSON.stringify(database.capacity())}`);
      const result = database.appendRunEventWithMessage(run.id, "assistant.delta", { text: "partial" }, {
        id: `${run.id}:1`, conversationId: conversation.id, role: "assistant", kind: "text",
        body: "partial", payload: { runId: run.id },
      });
      assert.deepEqual(result, { event: null, message: null }, `${code} escaped as a raw SQLite error`);
      assert.equal(checkpoints, 1);
      assert.equal(database.getRun(run.id).transcriptOmitted, 1);
      assert.equal(database.listRunEvents(run.id).length, 0);
      assert.throws(() => database.addMessage({ conversationId: conversation.id, role: "assistant", body: "later" }),
        (error) => error.statusCode === 507);
      assert.equal(checkpoints, 1, "a burst at the threshold must not synchronously retry checkpointing");
    } finally {
      fs.lstatSync = originalStat;
      Database.prototype.pragma = originalPragma;
      await database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("transcript estimates charge the durable SQLite row for inserts, checkpoints and omission", () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    const conversation = chat(database, "transcript parity");
    const fixedAt = "2026-09-21T00:00:00.000Z";
    const charge = (message, write, exact = true) => {
      const before = database.capacity().retainedBytes;
      const stored = write(message);
      const delta = database.capacity().retainedBytes - before;
      const estimated = retainedTranscriptMessageBytes(message);
      if (exact) assert.equal(delta, estimated, "SQLite trigger and transcript estimate diverged");
      else assert.ok(estimated >= delta, "transcript estimate undercharged a durable row");
      return stored;
    };
    const tool = { id: "tool-σ", conversationId: conversation.id, role: "assistant", kind: "tool",
      body: "résumé 🧪", payload: { runId: "run-1", command: "echo σ" }, createdAt: fixedAt };
    charge(tool, (message) => database.addMessage(message));
    const replacement = { ...tool, body: "revised 🧪 output", payload: { runId: "run-1", exitCode: 0 } };
    const before = database.capacity().retainedBytes;
    database.upsertMessage(replacement);
    assert.equal(database.capacity().retainedBytes - before,
      retainedTranscriptMessageBytes(replacement) - retainedTranscriptMessageBytes(tool), "upsert charged a different row delta");
    const checkpoint = { ...tool, id: "checkpoint", kind: "text", body: "assistant Δ",
      payload: { runId: "run-1", checkpointEventSeq: Number.MAX_SAFE_INTEGER } };
    charge(checkpoint, (message) => database.addMessage(message));
    charge({ ...checkpoint, id: "terminal", body: "final ✓" }, (message) => database.addMessage(message));
    charge({ ...tool, id: "omission", kind: "text", body: "Further output omitted", payload: { runId: "run-1", truncated: true } },
      (message) => database.addMessage(message), false);
    const withoutTimestamp = { ...tool, id: "default-time", body: "default", createdAt: undefined };
    delete withoutTimestamp.createdAt;
    charge(withoutTimestamp, (message) => database.addMessage(message));
  } finally { database.close(); }
});

test("UTF-8 transcript estimate matches an independent persisted SQLite row", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-transcript-readback-"));
  const filename = path.join(realpathSync(directory), "outright.db");
  const database = createOutrightDatabase({ filename });
  try {
    const conversation = chat(database);
    const message = { id: "escaped-🧪", conversationId: conversation.id, role: "assistant", kind: "tool",
      body: "quote \" and newline\nΔ 😀", payload: { command: "printf 'é\\n'", note: "🧪\"" },
      createdAt: "2026-09-21T00:00:00.000Z" };
    database.addMessage(message);
    const reader = new Database(filename, { readonly: true });
    try {
      const stored = reader.prepare(`SELECT 128 + octet_length(id) + octet_length(conversation_id)
        + octet_length(role) + octet_length(kind) + octet_length(body)
        + octet_length(payload) + octet_length(created_at) AS bytes
        FROM messages WHERE id = ?`).get(message.id);
      assert.equal(retainedTranscriptMessageBytes(message), stored.bytes);
    } finally { reader.close(); }
  } finally { await database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("an empty store admits its first write even when a migration tick is exhausted", () => {
  const originalNow = performance.now;
  let tick = 0;
  let database;
  try {
    performance.now = () => { tick += 10; return tick; };
    database = createOutrightDatabase({ filename: ":memory:" });
    assert.equal(database.capacity().retainedUsageStatus, "measured");
    assert.ok(chat(database).id);
    assert.ok(database.capacity().retainedBytes > 0);
  } finally {
    database?.close();
    performance.now = originalNow;
  }
});

test("burst admission is bounded and a refused run leaves no user message", () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    database.updateSettings({ maxQueuedRuns: 3 });
    const conversation = chat(database);
    const accepted = Array.from({ length: 3 }, () => database.submitRun(runInput(conversation.id), "work"));
    assert.equal(database.capacity().queued, 3);
    assert.throws(() => database.submitRun(runInput(conversation.id), "refused"), (error) => error.statusCode === 429);
    assert.equal(database.messageCount(conversation.id), 3);
    database.updateRun(accepted[0].run.id, { status: "stopped" });
    database.submitRun(runInput(conversation.id), "next");
    assert.equal(database.capacity().queued, 3);
    assert.equal(database.messageCount(conversation.id), 4);
  } finally { database.close(); }
});

test("legacy partial default setup resumes memberships once and preserves later user edits", () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    const core = database.createGroup("Core systems");
    database.setProjectGroup("already-set", core.id);
    database.ensureDefaultGroups([
      { id: "already-set", name: "Existing", path: "/work/existing" },
      { id: "new-core", name: "Application", path: "/work/application" },
      { id: "new-experiment", name: "Prototype", path: "/work/prototype" },
    ]);
    const { groups, memberships } = database.listGroups();
    assert.deepEqual(groups.map((group) => group.name), ["Core systems", "Experiments"]);
    assert.equal(memberships["already-set"], core.id);
    assert.equal(memberships["new-core"], core.id);
    assert.equal(memberships["new-experiment"], groups[1].id);
    database.deleteGroup(groups[1].id);
    database.ensureDefaultGroups([{ id: "new-experiment", name: "Prototype", path: "/work/prototype" }]);
    assert.deepEqual(database.listGroups().groups.map((group) => group.name), ["Core systems"], "later user deletion is not undone by scanning");
  } finally { database.close(); }
});

test("a full queue cannot consume an interrupted run's retry decision", () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    database.updateSettings({ maxQueuedRuns: 1 });
    const conversation = chat(database);
    const interrupted = database.createRun(runInput(conversation.id));
    database.updateRun(interrupted.id, { status: "interrupted" });
    database.createRun(runInput(conversation.id));
    assert.throws(() => database.beginInterruptedRunRecovery(interrupted.id, "retry"), (error) => error.statusCode === 429);
    assert.equal(database.getRun(interrupted.id).recoveryDecision, null);
    assert.equal(database.capacity().queued, 1);
  } finally { database.close(); }
});

test("retention removes only archived history with settled recovery and cascades its events", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-retention-"));
  const filename = path.join(directory, "outright.db");
  const database = createOutrightDatabase({ filename });
  try {
    const visible = chat(database, "visible");
    const queued = chat(database, "queued");
    const interrupted = chat(database, "interrupted");
    const finished = chat(database, "finished");
    const queuedRun = database.createRun(runInput(queued.id));
    const interruptedRun = database.createRun(runInput(interrupted.id));
    const finishedRun = database.createRun(runInput(finished.id));
    for (const conversation of [queued, interrupted, finished]) database.updateConversation(conversation.id, { archived: true });
    database.updateRun(interruptedRun.id, { status: "interrupted" });
    database.updateRun(finishedRun.id, { status: "completed" });
    database.appendRunEvent(finishedRun.id, "done", { value: "retained until cleanup" });
    ageArchived(filename, [queued.id, interrupted.id, finished.id]);
    const first = await database.pruneHistory();
    assert.deepEqual(first.ids, [finished.id]);
    assert.equal(database.getRun(finishedRun.id), undefined);
    assert.ok(database.getConversation(visible.id));
    assert.ok(database.getRun(queuedRun.id));
    assert.ok(database.getRun(interruptedRun.id));
    database.updateRun(queuedRun.id, { status: "stopped" });
    database.resolveInterruptedRun(interruptedRun.id, "discard");
    assert.equal((await database.pruneHistory()).deleted, 2);
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("automatic retention preserves pinned archives while confirmed deletion remains available", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-pinned-retention-"));
  const filename = path.join(directory, "outright.db");
  const database = createOutrightDatabase({ filename });
  try {
    const pinned = chat(database, "pinned archive");
    const ordinary = chat(database, "ordinary archive");
    for (const item of [pinned, ordinary]) database.updateConversation(item.id, { archived: true });
    database.updateConversation(pinned.id, { pinned: true });
    ageArchived(filename, [pinned.id, ordinary.id]);
    assert.deepEqual((await database.pruneHistory()).ids, [ordinary.id]);
    assert.ok(database.getConversation(pinned.id));
    assert.equal((await database.deleteArchivedConversation(pinned.id, pinned.id)).deleted, 1);
    assert.equal(database.getConversation(pinned.id), undefined);
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("retained counter is measured on upgrade and trusted on populated restart", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-retained-restart-"));
  const filename = path.join(directory, "outright.db");
  let database = createOutrightDatabase({ filename });
  try {
    const conversation = chat(database);
    database.addMessage({ conversationId: conversation.id, role: "assistant", body: "retained output" });
    const measured = database.capacity().retainedBytes;
    database.close();
    const legacy = new Database(filename);
    legacy.pragma("user_version = 1");
    legacy.prepare("UPDATE retained_usage SET bytes = 1 WHERE id = 1").run();
    legacy.close();
    database = createOutrightDatabase({ filename });
    const deadline = Date.now() + 5_000;
    while (database.capacity().migrationStatus === "migrating") {
      assert.ok(Date.now() < deadline, "legacy counter did not finish bounded measurement");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(database.capacity().retainedBytes, measured, "legacy counter is reconciled once");
    database.close();
    const admin = new Database(filename);
    assert.equal(admin.pragma("user_version", { simple: true }), 4);
    admin.prepare("UPDATE retained_usage SET bytes = bytes + 17 WHERE id = 1").run();
    admin.close();
    database = createOutrightDatabase({ filename });
    assert.equal(database.capacity().retainedBytes, measured + 17, "versioned startup does not rescan populated history");
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("large legacy backfills resume after interruption without admitting new work or losing recovery", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-bounded-upgrade-"));
  const filename = path.join(directory, "outright.db");
  let database = createOutrightDatabase({ filename });
  try {
    const conversation = chat(database);
    const run = database.createRun(runInput(conversation.id));
    database.close();
    const legacy = new Database(filename);
    legacy.exec("DROP TRIGGER messages_search_order_insert; DROP TRIGGER messages_search_order_update; DROP TRIGGER messages_search_order_delete; DROP INDEX IF EXISTS messages_search_order; ALTER TABLE messages DROP COLUMN search_order");
    const insertMessage = legacy.prepare("INSERT INTO messages (id, conversation_id, role, kind, body, created_at) VALUES (?, ?, 'assistant', 'text', ?, ?)");
    const insertEvent = legacy.prepare("INSERT INTO run_events (run_id, seq, type, payload, created_at) VALUES (?, ?, 'tool.output', ?, ?)");
    legacy.transaction(() => {
      for (let index = 1; index <= 600; index += 1) insertMessage.run(`legacy-${index}`, conversation.id, `message ${index} ` + "m".repeat(4096), "2026-01-01T00:00:00.000Z");
      for (let seq = 1; seq <= 500; seq += 1) insertEvent.run(run.id, seq, JSON.stringify({ text: "e".repeat(20 * 1024) }), "2026-01-01T00:00:00.000Z");
      legacy.pragma("user_version = 0");
      legacy.prepare("UPDATE retained_usage SET bytes = 1, measured = 0 WHERE id = 1").run();
    })();
    legacy.close();

    database = createOutrightDatabase({ filename });
    assert.equal(database.capacity().retainedUsageStatus, "measuring", "startup exposes unknown usage before a full scan");
    assert.equal(database.capacity().migrationStatus, "migrating");
    assert.equal(database.capacity().retainedBytes, null);
    assert.equal(database.capacity().availableForNewWorkBytes, 0);
    assert.throws(() => database.createRun(runInput(conversation.id)), (error) => error.statusCode === 507);
    assert.throws(() => database.listMessagePage(conversation.id), (error) => error.statusCode === 503);
    assert.equal(database.appendRunEvent(run.id, "new", { text: "deferred" }), null);
    database.updateRun(run.id, { status: "failed", error: "Recovered while history was measured" });
    assert.equal(database.getRun(run.id).status, "failed");
    database.close();

    const interrupted = new Database(filename);
    assert.ok(interrupted.prepare("SELECT cursor FROM retained_scans WHERE table_name = 'messages'").get().cursor > 0);
    assert.ok(interrupted.prepare("SELECT cursor_number FROM migration_progress WHERE kind = 'messages'").get().cursor_number > 0);
    interrupted.close();
    let migrationCompletions = 0;
    database = createOutrightDatabase({ filename, onMigrationComplete: () => { migrationCompletions += 1; } });
    const deadline = Date.now() + 10_000;
    while (database.capacity().retainedUsageStatus !== "measured" || database.listRunEvents(run.id).length === 0) {
      if (Date.now() >= deadline) {
        const probe = new Database(filename);
        const state = { jobs: probe.prepare("SELECT * FROM migration_progress").all(), scans: probe.prepare("SELECT * FROM retained_scans").all(), capacity: database.capacity() };
        probe.close();
        assert.fail(`bounded migration did not finish: ${JSON.stringify(state)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(database.messageCount(conversation.id), 600);
    assert.equal(database.capacity().migrationStatus, "ready");
    assert.equal(database.listMessagePage(conversation.id, { limit: 2 }).messages.at(-1).id, "legacy-600");
    const events = database.listRunEvents(run.id);
    assert.equal(events.at(-1).seq, 500);
    assert.ok(events[0].seq > 1 && events.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event.payload)) + 128, 0) <= 8 * 1024 * 1024);
    assert.equal(database.appendRunEvent(run.id, "new", { text: "resumed" }).seq, 501);
    assert.equal(database.getRun(run.id).status, "failed");
    assert.equal(migrationCompletions, 1, "queued work gets one completion wakeup");
    const measured = database.capacity().retainedBytes;
    const sizeProbe = new Database(filename);
    const payloadBytes = sizeProbe.prepare("SELECT COALESCE(SUM(octet_length(payload)), 0) AS bytes FROM run_events").get().bytes;
    const bodyBytes = sizeProbe.prepare("SELECT COALESCE(SUM(octet_length(body)), 0) AS bytes FROM messages").get().bytes;
    sizeProbe.close();
    assert.ok(measured >= payloadBytes + bodyBytes && measured < payloadBytes + bodyBytes + 1024 * 1024,
      "completed counter matches retained payloads without recounting interrupted batches");
    database.close();
    database = createOutrightDatabase({ filename });
    assert.equal(database.capacity().retainedBytes, measured, "completed accounting persists across restart");
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("a large legacy message store opens without building an index before capacity and sibling reads", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-message-order-upgrade-"));
  const filename = path.join(directory, "outright.db");
  let database = createOutrightDatabase({ filename });
  try {
    const target = chat(database);
    const sibling = chat(database);
    database.close();
    const legacy = new Database(filename);
    legacy.exec("DROP TRIGGER messages_search_order_insert; DROP TRIGGER messages_search_order_update; DROP TRIGGER messages_search_order_delete; DROP TABLE message_order");
    const insert = legacy.prepare("INSERT INTO messages (id, conversation_id, role, body, created_at) VALUES (?, ?, 'assistant', ?, '2026-01-01')");
    legacy.transaction(() => {
      for (let index = 0; index < 20_000; index += 1) {
        insert.run(`old-${index}`, target.id, index === 19_999 ? "last needle" : "legacy text");
      }
    })();
    legacy.close();

    database = createOutrightDatabase({ filename });
    assert.equal(database.capacity().migrationStatus, "migrating");
    assert.equal(database.getConversation(sibling.id).id, sibling.id, "sibling reads remain available during backfill");
    assert.throws(() => database.listMessagePage(target.id), (error) => error.statusCode === 503);
    const probe = new Database(filename);
    assert.ok(probe.prepare("SELECT COUNT(*) AS count FROM message_order").get().count <= 64,
      "startup inserts only one bounded page into the ordered lookup");
    assert.equal(probe.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'messages_search_order'").get(), undefined);
    probe.close();
    const progressDeadline = Date.now() + 5_000;
    for (;;) {
      const progress = new Database(filename, { readonly: true });
      const cursor = progress.prepare("SELECT cursor_number FROM migration_progress WHERE kind = 'messages'").get()?.cursor_number ?? 0;
      progress.close();
      if (cursor > 0) break;
      assert.ok(Date.now() < progressDeadline, "legacy backfill did not persist its first bounded page");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    database.close();
    const interrupted = new Database(filename);
    assert.ok(interrupted.prepare("SELECT cursor_number FROM migration_progress WHERE kind = 'messages'").get().cursor_number > 0);
    interrupted.close();

    database = createOutrightDatabase({ filename });
    const deadline = Date.now() + 20_000;
    while (database.capacity().migrationStatus !== "ready") {
      assert.ok(Date.now() < deadline, "large message backfill did not finish after restart");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const orderProbe = new Database(filename);
    const orderCount = orderProbe.prepare("SELECT COUNT(*) AS count FROM message_order").get().count;
    orderProbe.close();
    assert.equal(orderCount, 20_000, "every legacy message gained an ordered identity");
    assert.equal(database.listMessagePage(target.id, { limit: 1 }).messages[0]?.id, "old-19999", `ordered lookup has ${orderCount} of ${database.messageCount(target.id)} messages`);
    let found = await database.findMessagePage(target.id, "last needle", null);
    let requests = 0;
    while (found.partial) {
      assert.ok(++requests <= 50, "bounded Find never reached the final legacy message");
      found = await database.findMessagePage(target.id, "last needle", found.nextAfterId, 1,
        undefined, { originId: found.originId, wrapped: found.wrapped });
    }
    assert.equal(found.matchId, "old-19999");
    assert.equal(database.getConversation(sibling.id).id, sibling.id);
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("legacy event migration survives deletion of its current archived run", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-event-cleanup-upgrade-"));
  const filename = path.join(directory, "outright.db");
  let database = createOutrightDatabase({ filename });
  try {
    const conversation = chat(database);
    const run = database.createRun(runInput(conversation.id));
    database.updateRun(run.id, { status: "completed" });
    database.updateConversation(conversation.id, { archived: true });
    database.close();
    const legacy = new Database(filename);
    const insert = legacy.prepare("INSERT INTO run_events (run_id, seq, type, payload, created_at) VALUES (?, ?, 'tool.output', ?, ?)");
    legacy.transaction(() => {
      for (let seq = 1; seq <= 400; seq += 1) insert.run(run.id, seq, JSON.stringify({ text: "x".repeat(1024) }), "2026-01-01T00:00:00.000Z");
      legacy.pragma("user_version = 0");
    })();
    legacy.close();
    database = createOutrightDatabase({ filename });
    assert.equal(database.capacity().retainedUsageStatus, "measuring");
    assert.equal((await database.deleteArchivedConversation(conversation.id, conversation.id)).deleted, 1);
    const deadline = Date.now() + 10_000;
    while (true) {
      const probe = new Database(filename);
      const pending = Boolean(probe.prepare("SELECT 1 FROM migration_progress LIMIT 1").get());
      probe.close();
      if (database.capacity().retainedUsageStatus === "measured" && !pending) break;
      assert.ok(Date.now() < deadline, "cleanup left migration pending");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(database.getRun(run.id), undefined);
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("measured bytes do not reopen admission before legacy event cursors finish", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-event-admission-upgrade-"));
  const filename = path.join(directory, "outright.db");
  let database = createOutrightDatabase({ filename });
  try {
    const conversation = chat(database);
    database.close();
    const legacy = new Database(filename);
    legacy.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 200)
      INSERT INTO runs (id, conversation_id, worktree_path, provider, approval_policy, prompt, status, created_at)
      SELECT printf('legacy-%04d', n), ?, '/tmp/w', 'codex', 'read-only', 'work', 'completed', '2026-01-01T00:00:00.000Z' FROM seq`).run(conversation.id);
    legacy.exec(`INSERT INTO run_events (run_id, seq, type, payload, created_at)
      SELECT id, 1, 'legacy', '{}', '2026-01-01T00:00:00.000Z' FROM runs WHERE id LIKE 'legacy-%'`);
    legacy.pragma("user_version = 0");
    legacy.close();
    database = createOutrightDatabase({ filename });
    const deadline = Date.now() + 10_000;
    while (database.capacity().retainedUsageStatus !== "measured") {
      assert.ok(Date.now() < deadline, "retained scan did not complete");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(database.capacity().migrationStatus, "migrating", "event cursors outlast the byte scan");
    assert.equal(database.capacity().availableForNewWorkBytes, 0);
    assert.throws(() => database.createRun(runInput(conversation.id)), (error) => error.statusCode === 507);
    while (database.capacity().migrationStatus !== "ready") {
      assert.ok(Date.now() < deadline, "event migration did not complete");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(database.createRun(runInput(conversation.id)).status, "queued");
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("retention compares parsed cutoff instants and protects unsettled run transitions", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-retention-cutoff-"));
  const filename = path.join(directory, "outright.db");
  const database = createOutrightDatabase({ filename });
  try {
    const fresh = chat(database, "fresh");
    const settled = chat(database, "settled");
    const queued = chat(database, "queued");
    const active = chat(database, "active");
    const interrupted = chat(database, "interrupted");
    for (const item of [fresh, settled, queued, active, interrupted]) database.updateConversation(item.id, { archived: true });
    const queuedRun = database.createRun(runInput(queued.id));
    const activeRun = database.createRun(runInput(active.id));
    database.updateRun(activeRun.id, { status: "running" });
    const interruptedRun = database.createRun(runInput(interrupted.id));
    database.updateRun(interruptedRun.id, { status: "interrupted" });
    ageArchived(filename, [settled.id, queued.id, active.id, interrupted.id]);

    assert.deepEqual((await database.pruneHistory({ before: "Jan 1 2000" })).ids, [], "locale date cannot compare lexically after fresh ISO rows");
    for (const before of ["nonsense", "9999-01-01", new Date(Date.now() + 86_400_000).toISOString()]) {
      assert.throws(() => database.pruneHistory({ before }), (error) => error.statusCode === 400);
    }
    const cutoff = new Date(Date.now() - 95 * 86_400_000);
    const offsetCutoff = `${new Date(cutoff.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 19)}+05:30`;
    assert.deepEqual((await database.pruneHistory({ before: offsetCutoff })).ids, [settled.id]);
    for (const item of [fresh, queued, active, interrupted]) assert.ok(database.getConversation(item.id));

    database.updateRun(queuedRun.id, { status: "stopped" });
    database.updateRun(activeRun.id, { status: "completed" });
    database.resolveInterruptedRun(interruptedRun.id, "discard");
    assert.deepEqual(new Set((await database.pruneHistory({ before: offsetCutoff })).ids), new Set([queued.id, active.id, interrupted.id]));
    assert.ok(database.getConversation(fresh.id));
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("aggregate retained history denies new work until eligible history is cleaned", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-aggregate-"));
  const filename = path.join(directory, "outright.db");
  const database = createOutrightDatabase({ filename });
  try {
    database.updateSettings({ maxRetainedMiB: 64 });
    const old = chat(database, "old");
    const current = chat(database, "current");
    const admitted = database.createRun(runInput(current.id));
    const interrupted = database.createRun(runInput(current.id));
    database.updateRun(interrupted.id, { status: "interrupted" });
    const template = database.saveTemplate({ title: "saved", prompt: "original" });
    database.addMessage({ conversationId: old.id, role: "assistant", body: "x".repeat(62 * 1024 * 1024) });
    assert.throws(() => database.addMessage({ conversationId: old.id, role: "assistant", body: "y".repeat(2 * 1024 * 1024) }), (error) => error.statusCode === 507);
    assert.ok(database.capacity().retainedBytes < 64 * 1024 * 1024);
    // Fill the remaining ordinary budget without consuming the recovery reserve.
    const room = 63 * 1024 * 1024 - database.capacity().retainedBytes - 512;
    const filler = database.addMessage({ conversationId: old.id, role: "assistant", body: "z".repeat(room) });
    const remaining = 63 * 1024 * 1024 - database.capacity().retainedBytes;
    database.upsertMessage({ ...filler, body: `${filler.body}${"z".repeat(remaining - 8)}` });
    assert.ok(database.capacity().availableForNewWorkBytes < 64);
    assert.equal(database.canLaunchRun(), false, "previously queued work waits when a sibling spends its output budget");
    assert.equal(database.capacity().limits.reservedRetainedBytes, 1024 * 1024);
    assert.throws(() => database.submitRun(runInput(current.id), "refused"), (error) => error.statusCode === 507);
    assert.equal(database.appendRunEvent(admitted.id, "tool.output", { text: "not retained" }), null);
    assert.throws(() => database.beginInterruptedRunRecovery(interrupted.id, "retry"), (error) => error.statusCode === 507);
    assert.equal(database.getRun(interrupted.id).recoveryDecision, null);
    assert.throws(() => database.updateConversation(current.id, { title: "large".repeat(100) }), (error) => error.statusCode === 507);
    assert.equal(database.getConversation(current.id).title, "current");
    assert.throws(() => database.saveTemplate({ id: template.id, title: "saved", prompt: "x".repeat(1024) }), (error) => error.statusCode === 507);
    assert.equal(database.listTemplates()[0].prompt, "original");
    assert.throws(() => database.createGroup("too much"), (error) => error.statusCode === 507);
    assert.throws(() => database.saveTemplate({ title: "too much", prompt: "work" }), (error) => error.statusCode === 507);
    assert.equal(database.messageCount(current.id), 0);
    const finished = database.finishRun(admitted.id, { status: "completed", finishedAt: new Date().toISOString() },
      { id: `${admitted.id}:final`, conversationId: current.id, role: "assistant", kind: "text", body: "final".repeat(1024) });
    assert.equal(finished.run.status, "completed");
    assert.equal(finished.message, null, "terminal state commits when the aggregate budget omits its last output");
    assert.equal(finished.run.transcriptOmitted, 1, "terminal refusal leaves durable omission evidence");
    assert.ok(database.capacity().retainedBytes <= 64 * 1024 * 1024);
    const admin = new Database(filename);
    try {
      assert.throws(() => admin.prepare("UPDATE conversations SET title = ? WHERE id = ?").run("x".repeat(2 * 1024 * 1024), current.id), /OUTRIGHT_RETAINED_LIMIT/);
    } finally { admin.close(); }
    database.updateConversation(old.id, { archived: true });
    assert.equal((await database.pruneHistory()).deleted, 0, "ordinary cleanup respects the saved age");
    assert.throws(() => database.submitRun(runInput(current.id), "still refused"), (error) => error.statusCode === 507);
    assert.throws(() => database.deleteArchivedConversation(old.id, "wrong id"), (error) => error.statusCode === 400);
    assert.equal((await database.deleteArchivedConversation(old.id, old.id)).deleted, 1);
    assert.equal(database.canLaunchRun(), true, "selected cleanup reopens the launch gate");
    assert.ok(database.getRun(interrupted.id), "a sibling's recovery evidence survives selected cleanup");
    assert.equal(database.submitRun(runInput(current.id), "accepted").run.status, "queued");
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("quota refusal commits transcript omission with delta, timed checkpoint and tool writes", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-atomic-omission-"));
  const filename = path.join(directory, "outright.db");
  let database = createOutrightDatabase({ filename });
  try {
    database.updateSettings({ maxRetainedMiB: 64 });
    const sibling = chat(database, "quota filler");
    const conversation = chat(database, "active run");
    const runs = [0, 1, 2].map(() => database.createRun(runInput(conversation.id)));
    const checkpoint = { id: `${runs[1].id}:1`, conversationId: conversation.id, role: "assistant", kind: "text",
      body: "small prefix", payload: { runId: runs[1].id } };
    database.upsertMessage(checkpoint);
    const filler = database.addMessage({ conversationId: sibling.id, role: "assistant", body: "x".repeat(62 * 1024 * 1024) });
    const room = 63 * 1024 * 1024 - database.capacity().retainedBytes - 16 * 1024;
    database.upsertMessage({ ...filler, body: `${filler.body}${"x".repeat(room)}` });
    const rejected = { conversationId: conversation.id, role: "assistant", kind: "text",
      body: "y".repeat(1024 * 1024), payload: { runId: runs[0].id } };
    const delta = database.appendRunEventWithMessage(runs[0].id, "assistant.delta", { text: "partial" },
      { ...rejected, id: `${runs[0].id}:1` });
    assert.ok(delta.event, "the small replay event should fit before the checkpoint is refused");
    assert.equal(delta.message, null);
    assert.equal(database.upsertMessage({ ...checkpoint, body: rejected.body }, { omissionRunId: runs[1].id }), null);
    assert.equal(database.addMessage({ ...rejected, id: `${runs[2].id}:1`, payload: { runId: runs[2].id } },
      { omissionRunId: runs[2].id }), null);
    await database.close();
    database = createOutrightDatabase({ filename });
    for (const run of runs) assert.equal(database.getRun(run.id).transcriptOmitted, 1,
      "a crash after any refused write must recover the omission marker");
    assert.equal(database.listRunEvents(runs[0].id)[0].type, "assistant.delta");
    assert.deepEqual(database.listMessages(conversation.id).map((message) => message.body), ["small prefix"]);
    for (const run of runs) database.finishRun(run.id, { status: "stopped", finishedAt: new Date().toISOString(), pid: null });
    assert.deepEqual(runs.map((run) => database.getRun(run.id).transcriptOmitted), [1, 1, 1]);
  } finally { await database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("selected cleanup rechecks archived and run state at deletion, including cancellation and recovery", async () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    const visible = chat(database, "visible");
    const queued = chat(database, "queued");
    const active = chat(database, "active");
    const interrupted = chat(database, "interrupted");
    for (const item of [queued, active, interrupted]) database.updateConversation(item.id, { archived: true });
    const queuedRun = database.createRun(runInput(queued.id));
    const activeRun = database.createRun(runInput(active.id));
    database.updateRun(activeRun.id, { status: "running" });
    const interruptedRun = database.createRun(runInput(interrupted.id));
    database.updateRun(interruptedRun.id, { status: "interrupted" });
    assert.deepEqual(database.listDeletableArchivedConversations().conversations, []);
    for (const item of [visible, queued, active, interrupted]) {
      await assert.rejects(database.deleteArchivedConversation(item.id, item.id), (error) => error.statusCode === 409);
    }
    database.updateRun(queuedRun.id, { status: "stopped" });
    database.updateRun(activeRun.id, { status: "completed" });
    database.resolveInterruptedRun(interruptedRun.id, "discard");
    assert.equal(database.listDeletableArchivedConversations().conversations.length, 3);
    for (const item of [queued, active, interrupted]) assert.equal((await database.deleteArchivedConversation(item.id, item.id)).deleted, 1);
    assert.ok(database.getConversation(visible.id));
    assert.equal(database.getRun(queuedRun.id), undefined);
    assert.equal(database.getRun(activeRun.id), undefined);
    assert.equal(database.getRun(interruptedRun.id), undefined);
  } finally { database.close(); }
});

test("archived selection pages past 100 without deleting newer chats or exposing active evidence", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-archived-pages-"));
  const filename = path.join(directory, "outright.db");
  const database = createOutrightDatabase({ filename });
  try {
    const oldest = chat(database, "oldest selected");
    database.updateConversation(oldest.id, { archived: true });
    const protectedChat = chat(database, "running protected");
    database.updateConversation(protectedChat.id, { archived: true });
    const active = database.createRun(runInput(protectedChat.id));
    database.updateRun(active.id, { status: "running" });
    for (let index = 0; index < 101; index++) database.updateConversation(chat(database, `newer ${index}`).id, { archived: true });
    ageArchived(filename, [oldest.id]);
    const first = database.listDeletableArchivedConversations();
    assert.equal(first.conversations.length, 100);
    assert.ok(first.nextCursor);
    assert.equal(first.conversations.some((item) => item.id === oldest.id), false);
    const second = database.listDeletableArchivedConversations({ cursor: first.nextCursor });
    assert.equal(second.conversations.some((item) => item.id === oldest.id), true);
    assert.equal(second.conversations.some((item) => item.id === protectedChat.id), false);
    assert.equal(second.nextCursor, null);
    assert.equal((await database.deleteArchivedConversation(oldest.id, oldest.id)).deleted, 1);
    assert.ok(database.getConversation(first.conversations[0].id), "newer history is retained");
    assert.ok(database.getRun(active.id), "active evidence is retained");
    for (const cursor of ["", "!", "a".repeat(2049), Buffer.from(JSON.stringify(["date"])).toString("base64url")]) {
      assert.throws(() => database.listDeletableArchivedConversations({ cursor }), (error) => error.statusCode === 400);
    }
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("migration preserves recovery transitions for legacy data already over quota", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-legacy-quota-"));
  const filename = path.join(directory, "outright.db");
  let database = createOutrightDatabase({ filename });
  try {
    database.updateSettings({ maxRetainedMiB: 64 });
    const old = chat(database, "old");
    const live = chat(database, "live");
    const run = database.createRun(runInput(live.id));
    database.close();
    const legacy = new Database(filename);
    legacy.exec("DROP TRIGGER retained_hard_limit");
    legacy.prepare("INSERT INTO messages (id, conversation_id, role, kind, body, payload, created_at) VALUES (?, ?, 'assistant', 'text', ?, 'null', ?)")
      .run("legacy-output", old.id, "x".repeat(65 * 1024 * 1024), new Date().toISOString());
    legacy.prepare("UPDATE conversations SET archived = 1, updated_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 100 * 86_400_000).toISOString(), old.id);
    legacy.close();
    database = createOutrightDatabase({ filename });
    assert.ok(database.capacity().retainedBytes > 64 * 1024 * 1024);
    database.updateRun(run.id, { status: "interrupted", recoveryClass: "unknown" });
    assert.equal(database.getRun(run.id).status, "interrupted");
    assert.throws(() => database.submitRun(runInput(live.id), "blocked"), (error) => error.statusCode === 507);
    assert.equal((await database.pruneHistory()).deleted, 1);
    assert.equal(database.submitRun(runInput(live.id), "accepted").run.status, "queued");
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("startup reconciles a legacy backlog larger than fixed recovery headroom", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-legacy-burst-"));
  const filename = path.join(directory, "outright.db");
  let database = createOutrightDatabase({ filename });
  try {
    database.updateSettings({ maxRetainedMiB: 64 });
    const conversation = chat(database);
    database.close();
    const legacy = new Database(filename);
    legacy.exec("DROP TRIGGER retained_hard_limit");
    legacy.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 30000)
      INSERT INTO runs (id, conversation_id, worktree_path, provider, approval_policy, prompt, status, created_at)
      SELECT 'legacy-' || n, ?, '/tmp/w', 'codex', 'read-only', 'work', 'queued', '2026-01-01T00:00:00.000Z' FROM seq`).run(conversation.id);
    legacy.prepare("INSERT INTO messages (id, conversation_id, role, kind, body, payload, created_at) VALUES ('legacy-output', ?, 'assistant', 'text', ?, 'null', '2026-01-01T00:00:00.000Z')")
      .run(conversation.id, "x".repeat(68 * 1024 * 1024));
    legacy.close();
    database = createOutrightDatabase({ filename });
    assert.ok(database.capacity().retainedBytes > 64 * 1024 * 1024);
    assert.equal(database.reconcileInterruptedRuns({ probeAlive: () => false }).count, 30000);
    assert.equal(database.capacity().queued, 0);
    assert.equal(database.capacity().recoverable, 30000);
    database.close();
    database = createOutrightDatabase({ filename });
    assert.equal(database.reconcileInterruptedRuns({ probeAlive: () => false }).count, 0);
    assert.equal(database.capacity().recoverable, 30000);
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("near-cap legacy backlog reserves recovery space through interrupted restarts and cleanup", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-near-cap-recovery-"));
  const filename = path.join(directory, "outright.db");
  let database = createOutrightDatabase({ filename });
  try {
    database.updateSettings({ maxRetainedMiB: 64 });
    const archived = chat(database, "old archive");
    const live = chat(database, "live");
    database.updateConversation(archived.id, { archived: true });
    database.close();
    const legacy = new Database(filename);
    legacy.exec("DROP TRIGGER retained_hard_limit");
    legacy.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 9000)
      INSERT INTO runs (id, conversation_id, worktree_path, provider, approval_policy, prompt, status, pid, created_at)
      SELECT 'legacy-' || n, ?, '/tmp/w', 'codex', 'read-only', 'work',
        CASE n % 3 WHEN 0 THEN 'running' WHEN 1 THEN 'queued' ELSE 'launching' END,
        CASE WHEN n % 3 = 0 THEN 12345 ELSE NULL END,
        '2026-01-01T00:00:00.000Z' FROM seq`).run(live.id);
    legacy.prepare("INSERT INTO messages (id, conversation_id, role, kind, body, payload, created_at) VALUES ('legacy-output', ?, 'assistant', 'text', 'x', 'null', '2026-01-01T00:00:00.000Z')")
      .run(archived.id);
    const target = 64 * 1024 * 1024 - 199_989;
    const current = legacy.prepare("SELECT bytes FROM retained_usage WHERE id = 1").get().bytes;
    assert.ok(current < target);
    legacy.prepare("UPDATE messages SET body = ? WHERE id = 'legacy-output'").run("x".repeat(1 + target - current));
    legacy.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 100 * 86_400_000).toISOString(), archived.id);
    legacy.close();

    database = createOutrightDatabase({ filename });
    assert.ok(database.capacity().retainedBytes < 64 * 1024 * 1024);
    assert.equal(database.capacity().availableForNewWorkBytes, 0);
    assert.throws(() => database.addMessage({ conversationId: live.id, role: "user", body: "refused" }),
      (error) => error.statusCode === 507);
    let probes = 0;
    assert.throws(() => database.reconcileInterruptedRuns({ probeAlive: () => {
      if (++probes === 200) throw new Error("probe interrupted");
      return false;
    } }), /probe interrupted/);
    assert.equal(database.capacity().recoverable, 500, "one bounded batch survived the interruption");
    database.close();
    database = createOutrightDatabase({ filename });
    assert.equal(database.reconcileInterruptedRuns({ probeAlive: () => false }).count, 8500);
    assert.equal(database.capacity().queued, 0);
    assert.equal(database.capacity().active, 0);
    assert.equal(database.capacity().recoverable, 9000);
    assert.equal(database.resolveInterruptedRun("legacy-1", "discard").status, "failed");
    assert.equal(database.resolveInterruptedRun("legacy-2", "retry").recoveryDecision, "retry");
    assert.equal((await database.pruneHistory()).deleted, 1);
    assert.equal(database.resolveInterruptedRun("legacy-3", "discard-unverifiable").status, "failed");
    database.close();
    database = createOutrightDatabase({ filename });
    assert.equal(database.reconcileInterruptedRuns({ probeAlive: () => false }).count, 0);
    assert.equal(database.capacity().recoverable, 8997);
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("startup recovery commits bounded batches before an interrupted probe", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-reconcile-batches-"));
  const filename = path.join(directory, "outright.db");
  const database = createOutrightDatabase({ filename });
  try {
    const conversation = chat(database);
    const admin = new Database(filename);
    admin.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 501)
      INSERT INTO runs (id, conversation_id, worktree_path, provider, approval_policy, prompt, status, pid, created_at)
      SELECT 'pending-' || n, ?, '/tmp/w', 'codex', 'read-only', 'work', 'running', 12345, '2026-01-01T00:00:00.000Z' FROM seq`).run(conversation.id);
    admin.close();
    let probed = 0;
    assert.throws(() => database.reconcileInterruptedRuns({ probeAlive: () => {
      if (++probed === 501) throw new Error("probe interrupted");
      return false;
    } }), /probe interrupted/);
    assert.equal(database.capacity().recoverable, 500);
    assert.equal(database.capacity().active, 1);
    assert.equal(database.reconcileInterruptedRuns({ probeAlive: () => false }).count, 1);
    assert.equal(database.capacity().recoverable, 501);
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("lowering the retained cap preserves cleanup and refuses new retained work", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-lower-cap-"));
  const filename = path.join(directory, "outright.db");
  const database = createOutrightDatabase({ filename });
  try {
    const archived = chat(database, "large archive");
    const live = chat(database, "live");
    database.addMessage({ conversationId: archived.id, role: "assistant", body: "x".repeat(65 * 1024 * 1024) });
    database.updateConversation(archived.id, { archived: true });
    assert.equal(database.updateSettings({ maxRetainedMiB: 64 }).maxRetainedMiB, 64);
    assert.equal(database.capacity().availableForNewWorkBytes, 0);
    assert.throws(() => database.submitRun(runInput(live.id), "blocked"), (error) => error.statusCode === 507);
    assert.equal((await database.deleteArchivedConversation(archived.id, archived.id)).deleted, 1);
    assert.equal(database.submitRun(runInput(live.id), "ready").run.status, "queued");
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("truncated output cannot spend terminal transition reserve at the quota edge", () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    database.updateSettings({ maxRetainedMiB: 64 });
    const conversation = chat(database);
    const runs = ["completed", "failed", "stopped"].map(() => database.createRun(runInput(conversation.id)));
    database.addMessage({ conversationId: conversation.id, role: "assistant", body: "x".repeat(62 * 1024 * 1024) });
    const room = 64 * 1024 * 1024 - database.capacity().retainedBytes;
    assert.ok(room > 1024 * 1024);
    assert.throws(() => database.addMessage({ conversationId: conversation.id, role: "assistant",
      body: "x".repeat(room - 1024), payload: { truncated: true } }), (error) => error.statusCode === 507);
    for (const [index, status] of ["completed", "failed", "stopped"].entries()) {
      const result = database.finishRun(runs[index].id, { status, finishedAt: new Date().toISOString(), error: status === "failed" ? "provider exited" : null });
      assert.equal(result.run.status, status);
    }
  } finally { database.close(); }
});

test("optional metadata cannot exhaust terminal and restart recovery space", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-metadata-reserve-"));
  const filename = path.join(directory, "outright.db");
  let database = createOutrightDatabase({ filename });
  try {
    database.updateSettings({ maxRetainedMiB: 64 });
    const conversations = Array.from({ length: 300 }, (_, index) => chat(database, `chat ${index}`));
    const [completed, failed, stopped, cancelled, interrupted] = Array.from({ length: 5 }, () => database.createRun(runInput(conversations[0].id)));
    database.updateRun(interrupted.id, { status: "running", pid: 424242 });
    const filler = database.addMessage({ conversationId: conversations[0].id, role: "assistant", body: "x".repeat(62 * 1024 * 1024) });
    const room = 63 * 1024 * 1024 - database.capacity().retainedBytes;
    assert.ok(room > 0);
    database.upsertMessage({ ...filler, body: `${filler.body}${"x".repeat(room - 1)}` });
    const atEdge = database.capacity().retainedBytes;
    assert.ok(database.capacity().availableForNewWorkBytes <= 1);

    for (const conversation of conversations.slice(0, 256)) {
      assert.throws(() => database.updateConversation(conversation.id, { providerSessionId: "s".repeat(4096) }),
        (error) => error.statusCode === 507);
      assert.equal(database.getConversation(conversation.id).providerSessionId, null);
    }
    assert.throws(() => database.moveConversation(conversations[0].id,
      { projectId: "p", worktreeId: "w2", worktreePath: `/tmp/${"w".repeat(4096)}` }), (error) => error.statusCode === 507);
    assert.throws(() => database.updateSettings({ model: "m".repeat(200) }), (error) => error.statusCode === 507);
    assert.throws(() => database.updateRun(completed.id, { inputTokens: 123456789012345 }), (error) => error.statusCode === 507);
    assert.equal(database.capacity().retainedBytes, atEdge);
    const mixed = database.updateRun(completed.id, { status: "running", inputTokens: 123456789012345 });
    assert.equal(mixed.status, "running");
    assert.equal(mixed.inputTokens, null, "optional usage is dropped without losing the required state transition");
    assert.equal(database.getSettings().model, "");

    for (const [run, status] of [[completed, "completed"], [failed, "failed"], [stopped, "stopped"]]) {
      assert.equal(database.finishRun(run.id, { status, finishedAt: new Date().toISOString(), error: status === "failed" ? "x".repeat(64 * 1024) : null }).run.status, status);
    }
    assert.equal(database.updateRun(cancelled.id, { status: "stopped", finishedAt: new Date().toISOString() }).status, "stopped");
    database.close();
    database = createOutrightDatabase({ filename });
    assert.equal(database.reconcileInterruptedRuns({ probeAlive: () => false }).count, 1);
    assert.equal(database.getRun(interrupted.id).status, "interrupted");
    assert.equal(database.resolveInterruptedRun(interrupted.id, "discard").status, "failed");
    assert.deepEqual([completed, failed, stopped, cancelled].map((run) => database.getRun(run.id).status),
      ["completed", "failed", "stopped", "stopped"]);
    assert.ok(database.capacity().retainedBytes <= 64 * 1024 * 1024);
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("omission metadata survives terminal outcomes and restart at the retained quota edge", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-omission-"));
  const filename = path.join(directory, "outright.db");
  let database = createOutrightDatabase({ filename });
  try {
    database.updateSettings({ maxRetainedMiB: 64 });
    const conversation = chat(database);
    const runs = ["completed", "failed", "stopped"].map(() => database.createRun(runInput(conversation.id)));
    database.addMessage({ conversationId: conversation.id, role: "assistant", body: "x".repeat(62 * 1024 * 1024) });
    for (const [index, status] of ["completed", "failed", "stopped"].entries()) {
      const run = runs[index];
      const result = database.finishRun(run.id, { status, finishedAt: new Date().toISOString() },
        { id: `${run.id}:final`, conversationId: conversation.id, role: "assistant", body: "y".repeat(2 * 1024 * 1024) });
      assert.equal(result.message, null);
      assert.equal(result.run.transcriptOmitted, 1);
    }
    database.close();
    database = createOutrightDatabase({ filename });
    assert.deepEqual(runs.map((run) => database.getRun(run.id).transcriptOmitted), [1, 1, 1]);
    assert.deepEqual(database.listRuns(conversation.id).map((run) => run.transcriptOmitted), [1, 1, 1]);
    database.updateRun(runs[0].id, { transcriptOmitted: false });
    assert.equal(database.getRun(runs[0].id).transcriptOmitted, 1, "later updates cannot clear omission evidence");
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("sustained event output retains a byte-bounded replay tail with monotonic cursors", () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    const conversation = chat(database);
    const run = database.createRun(runInput(conversation.id));
    for (let index = 0; index < 100; index += 1) database.appendRunEvent(run.id, "tool.completed", { text: "x".repeat(128 * 1024), index });
    const events = database.listRunEvents(run.id);
    assert.ok(events.length < 100);
    assert.equal(events.at(-1).seq, 100);
    assert.ok(events[0].seq > 1);
    assert.ok(events.every((event, index) => index === 0 || event.seq === events[index - 1].seq + 1));
    assert.ok(events.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event.payload)) + 128, 0) <= 8 * 1024 * 1024);
  } finally { database.close(); }
});

test("legacy null event payloads migrate into the byte counter without blocking new events", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-event-budget-"));
  const filename = path.join(directory, "outright.db");
  let database = createOutrightDatabase({ filename });
  try {
    const conversation = chat(database);
    const run = database.createRun(runInput(conversation.id));
    database.close();
    const legacy = new Database(filename);
    legacy.pragma("user_version = 0");
    legacy.prepare("INSERT INTO run_events (run_id, seq, type, payload, created_at) VALUES (?, 1, 'legacy', NULL, ?)").run(run.id, new Date().toISOString());
    legacy.close();
    database = createOutrightDatabase({ filename });
    const deadline = Date.now() + 10_000;
    while (database.capacity().migrationStatus !== "ready") {
      assert.ok(Date.now() < deadline, "legacy null event migration did not finish");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(database.appendRunEvent(run.id, "new", { healthy: true }).seq, 2);
    assert.equal(database.listRunEvents(run.id).length, 2);
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("legacy oversized replay tails are pruned on reopen with monotonic run-detail cursors", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-legacy-events-"));
  const filename = path.join(directory, "outright.db");
  let database = createOutrightDatabase({ filename });
  try {
    const conversation = chat(database);
    const run = database.createRun(runInput(conversation.id));
    const giant = database.createRun(runInput(conversation.id));
    database.close();
    const legacy = new Database(filename);
    legacy.pragma("user_version = 0");
    const insert = legacy.prepare("INSERT INTO run_events (run_id, seq, type, payload, created_at) VALUES (?, ?, 'legacy', ?, ?)");
    const payload = JSON.stringify({ text: "x".repeat(256 * 1024) });
    legacy.transaction(() => {
      for (let seq = 1; seq <= 40; seq++) insert.run(run.id, seq, payload, new Date().toISOString());
      insert.run(giant.id, 73, JSON.stringify({ text: "z".repeat(9 * 1024 * 1024) }), new Date().toISOString());
    })();
    legacy.close();
    database = createOutrightDatabase({ filename });
    const deadline = Date.now() + 10_000;
    while (database.capacity().migrationStatus !== "ready") {
      assert.ok(Date.now() < deadline, "legacy replay migration did not finish");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const events = database.listRunEvents(run.id);
    assert.equal(events.at(-1).seq, 40);
    assert.ok(events[0].seq > 1, "pre-upgrade head was removed");
    assert.ok(events.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event.payload)) + 128, 0) <= 8 * 1024 * 1024);
    assert.deepEqual(database.listRunEvents(run.id, events[5].seq).map((event) => event.seq), events.slice(6).map((event) => event.seq));
    assert.equal(database.appendRunEvent(run.id, "new", { value: 41 }).seq, 41);
    assert.deepEqual(database.listRunEvents(giant.id), [], "one oversized legacy event cannot escape the tail cap");
    assert.equal(database.appendRunEvent(giant.id, "new", { value: 74 }).seq, 74);
    assert.deepEqual(database.listRunEvents(giant.id, 73).map((event) => event.seq), [74]);
    database.close();
    database = createOutrightDatabase({ filename });
    assert.equal(database.listRunEvents(run.id).at(-1).seq, 41);
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("audit history bounds both an entry and the requested page", () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    database.audit("large", { text: "x".repeat(128 * 1024) });
    assert.equal(database.listAudit(1)[0].details.truncated, true);
    for (let index = 0; index < 501; index += 1) database.audit("small", { index });
    assert.equal(database.listAudit(100000).length, 500);
  } finally { database.close(); }
});

test("quota refusal cannot silently authorize trust, while terminal run and recovery audits survive restart", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-audit-quota-"));
  const filename = path.join(directory, "outright.db");
  let database = createOutrightDatabase({ filename });
  try {
    const conversation = chat(database);
    const finished = database.createRun(runInput(conversation.id));
    const interrupted = database.createRun(runInput(conversation.id));
    const retry = database.createRun(runInput(conversation.id));
    database.trustProject("existing", "/tmp/existing");
    database.addMessage({ conversationId: conversation.id, role: "assistant", body: "x".repeat(65 * 1024 * 1024) });
    database.updateSettings({ maxRetainedMiB: 64 });
    assert.equal(database.audit("optional.telemetry", { target: "quota" }), false);
    assert.throws(() => database.auditAdmission("git.commit.requested", { target: "/tmp/project" }), (error) => error.statusCode === 507);
    assert.throws(() => database.trustProject("refused", "/tmp/refused"), (error) => error.statusCode === 507);
    assert.equal(database.isProjectTrusted("refused", "/tmp/refused"), false);
    database.untrustProject("existing");
    database.finishRun(finished.id, { status: "completed", finishedAt: new Date().toISOString() });
    database.updateRun(interrupted.id, { status: "interrupted", recoveryClass: "exited" });
    database.updateRun(retry.id, { status: "interrupted", recoveryClass: "exited" });
    assert.equal(database.resolveInterruptedRun(interrupted.id, "discard").status, "failed");
    assert.throws(() => database.beginInterruptedRunRecovery(retry.id, "retry"), (error) => error.statusCode === 507);
    assert.equal(database.getRun(retry.id).recoveryDecision, null, "quota refusal consumed a retry decision");
    assert.equal(database.resolveInterruptedRun(interrupted.id, "discard"), null);
    database.close();
    database = createOutrightDatabase({ filename });
    const entries = database.listAudit(30);
    const actions = entries.map((entry) => entry.action);
    assert.ok(actions.includes("agent.run.completed"));
    assert.ok(actions.includes("agent.run.recovery.discard"));
    assert.equal(entries.filter((entry) => entry.action === "agent.run.recovery.discard" && entry.target === interrupted.id).length, 1);
    assert.ok(!actions.includes("agent.run.recovery.retry"));
    assert.ok(actions.includes("project.untrusted"));
    assert.ok(!entries.some((entry) => entry.action === "project.trusted" && entry.target === "refused"));
    assert.ok(!actions.includes("git.commit.requested"));
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("audit retention protects an unfinished external effect while trimming completed history", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-pending-audit-"));
  const filename = path.join(directory, "outright.db");
  let database = createOutrightDatabase({ filename });
  try {
    const writer = new Database(filename);
    try {
      const insert = writer.prepare("INSERT INTO audit_log (action, target, details, created_at) VALUES (?, ?, ?, ?)");
      writer.transaction(() => {
        insert.run("git.commit.requested", "/tmp/pending", JSON.stringify({ operationId: "pending" }), "2026-01-01");
        insert.run("git.commit.requested", "/tmp/completed", JSON.stringify({ operationId: "completed" }), "2026-01-01");
        insert.run("git.commit", "/tmp/completed", JSON.stringify({ operationId: "completed" }), "2026-01-01");
        insert.run("terminal.created", "active-terminal", "{}", "2026-01-01");
        insert.run("terminal.created", "closed-terminal", "{}", "2026-01-01");
        insert.run("terminal.closed", "closed-terminal", "{}", "2026-01-01");
        for (let index = 0; index < 10_050; index += 1) insert.run("telemetry", "", "{}", "2026-01-01");
      }).immediate();
    } finally { writer.close(); }
    database.audit("telemetry", { target: "last" });
    database.close();
    database = createOutrightDatabase({ filename });
    const proof = new Database(filename, { readonly: true });
    try {
      assert.equal(proof.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE target = '/tmp/pending'").get().count, 1);
      assert.equal(proof.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE target = '/tmp/completed'").get().count, 0);
      assert.equal(proof.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE target = 'active-terminal'").get().count, 1);
      assert.equal(proof.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE target = 'closed-terminal'").get().count, 0);
      assert.ok(proof.prepare("SELECT COUNT(*) AS count FROM audit_log").get().count <= 10_002);
    } finally { proof.close(); }
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("cleanup request admission is bounded and restart records interrupted outcomes", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-cleanup-audit-"));
  const filename = path.join(directory, "outright.db");
  let database = createOutrightDatabase({ filename, runtimeLease: true });
  try {
    for (let index = 0; index < 16; index += 1) {
      await database.auditRetentionCleanupRequested({ operationId: `cleanup-${index}`, before: "2020-01-01T00:00:00.000Z" });
    }
    await assert.rejects(database.auditRetentionCleanupRequested({ operationId: "overflow" }), (error) => error.statusCode === 429);
    database.close();
    database = createOutrightDatabase({ filename, runtimeLease: true });
    assert.equal(database.reconcilePendingRetentionCleanup(), 16);
    assert.equal(database.reconcilePendingRetentionCleanup(), 0);
    const entries = database.listAudit(100);
    assert.equal(entries.filter((entry) => entry.action === "retention.cleanup.unknown").length, 16);
    await database.auditRetentionCleanupRequested({ operationId: "retry", before: "2020-01-01T00:00:00.000Z" });
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("shadow cleanup preserves unresolved audit and live terminal evidence beyond the trim threshold", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-shadow-audit-"));
  const filename = path.join(directory, "outright.db");
  let database = createOutrightDatabase({ filename, runtimeLease: true });
  try {
    const sibling = chat(database, "survivor");
    const queued = database.createRun(runInput(sibling.id));
    const recoveringChat = chat(database, "recoverable");
    const recovering = database.createRun(runInput(recoveringChat.id));
    database.updateRun(recovering.id, { status: "interrupted" });
    const archived = chat(database, "oversized archive");
    const message = database.addMessage({ conversationId: archived.id, role: "assistant", body: "small" });
    const writer = new Database(filename);
    try {
      writer.prepare("UPDATE messages SET body = ? WHERE id = ?").run("x".repeat(4 * 1024 * 1024), message.id);
      const insert = writer.prepare("INSERT INTO audit_log (action, target, details, created_at) VALUES (?, ?, ?, ?)");
      writer.transaction(() => {
        for (const [action, target, details] of [
          ["git.commit.requested", "/tmp/pending", { operationId: "git-pending" }],
          ["terminal.created", "active-terminal", {}],
          ["retention.cleanup.requested", "", { operationId: "cleanup-pending" }],
          ["git.stage.requested", "/tmp/settled", { operationId: "settled" }],
          ["git.stage", "/tmp/settled", { operationId: "settled" }],
        ]) insert.run(action, target, JSON.stringify(details), "2026-01-01");
        for (let index = 0; index < 10_050; index += 1) insert.run("telemetry", "", "{}", "2026-01-01");
        insert.run("git.commit.requested", "/tmp/recent", JSON.stringify({ operationId: "recent" }), "2026-01-01");
        insert.run("git.commit", "/tmp/recent", JSON.stringify({ operationId: "recent" }), "2026-01-01");
      }).immediate();
    } finally { writer.close(); }
    database.updateConversation(archived.id, { archived: true });
    ageArchived(filename, [archived.id]);
    assert.equal((await database.pruneHistory()).deleted, 1);
    await database.close();
    database = createOutrightDatabase({ filename, runtimeLease: true });
    const proof = new Database(filename, { readonly: true });
    try {
      for (const target of ["/tmp/pending", "active-terminal"]) {
        assert.equal(proof.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE target = ?").get(target).count, 1);
      }
      assert.equal(proof.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'retention.cleanup.requested'").get().count, 1);
      assert.equal(proof.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE target = '/tmp/settled'").get().count, 0);
      assert.equal(proof.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE target = '/tmp/recent'").get().count, 2);
      assert.ok(proof.prepare("SELECT COUNT(*) AS count FROM audit_log").get().count <= 10_005);
      assert.equal(database.getRun(queued.id).status, "queued");
      assert.equal(database.getRun(recovering.id).status, "interrupted");
      assert.equal(database.capacity().retainedBytes, retainedReadback(proof));
    } finally { proof.close(); }
  } finally { await database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("oversized audit details retain the operation id needed to match an outcome", () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    database.auditAdmission("git.stage.requested", { target: "/tmp/project", operationId: "large-stage",
      files: ["x".repeat(16 * 1024)] });
    const entry = database.listAudit(1)[0];
    assert.equal(entry.details.operationId, "large-stage");
    assert.equal(entry.details.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(entry.details)) <= 4 * 1024);
  } finally { database.close(); }
});

test("legacy pinned schema and migration audit survive cleanup and restart", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-legacy-retention-"));
  const filename = path.join(directory, "outright.db");
  let database = createOutrightDatabase({ filename });
  try {
    const archived = chat(database, "legacy archive");
    for (let index = 0; index < 200; index += 1) database.addMessage({ conversationId: archived.id, role: "assistant", body: `legacy ${index}` });
    database.updateConversation(archived.id, { archived: true });
    database.close();
    const legacy = new Database(filename);
    legacy.exec("ALTER TABLE conversations DROP COLUMN pinned");
    legacy.pragma("user_version = 0");
    legacy.close();
    database = createOutrightDatabase({ filename });
    assert.equal(database.capacity().migrationStatus, "migrating");
    database.audit("runtime.runs.reconciled", { target: "runtime", count: 1 });
    assert.equal(database.listAudit().find((entry) => entry.action === "runtime.runs.reconciled")?.target, "runtime");
    assert.equal(database.listConversations({ archived: true }).find((item) => item.id === archived.id)?.pinned, 0);
    assert.equal((await database.deleteArchivedConversation(archived.id, archived.id)).deleted, 1);
    assert.ok(database.listAudit().some((entry) => entry.action === "retention.archived.deleted" && entry.target === archived.id));
    database.close();
    database = createOutrightDatabase({ filename });
    assert.equal(database.getConversation(archived.id), undefined);
    assert.ok(database.listAudit().some((entry) => entry.action === "retention.archived.deleted" && entry.target === archived.id));
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("large archived cleanup yields to active work and resumes after interruption", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-batched-retention-"));
  const filename = path.join(directory, "outright.db");
  let database = createOutrightDatabase({ filename });
  try {
    const archived = chat(database, "large archive");
    const active = chat(database, "active work");
    const running = database.createRun(runInput(active.id));
    database.updateRun(running.id, { status: "running" });
    for (let index = 0; index < 400; index += 1) {
      database.addMessage({ conversationId: archived.id, role: "assistant", body: "x".repeat(16 * 1024) });
    }
    database.updateConversation(archived.id, { archived: true });
    const deletion = database.deleteArchivedConversation(archived.id, archived.id);
    await new Promise((resolve) => setImmediate(resolve));
    const probe = new Database(filename);
    assert.equal(probe.prepare("SELECT deleting FROM conversations WHERE id = ?").get(archived.id)?.deleting, 1);
    assert.ok(probe.prepare("SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?").get(archived.id).count > 0);
    probe.close();
    assert.equal(database.getRun(running.id).status, "running", "active work remains queryable during cleanup");
    assert.throws(() => database.createRun(runInput(archived.id)), (error) => error.statusCode === 409);
    assert.throws(() => database.moveConversation(archived.id,
      { projectId: "other", worktreeId: "other", worktreePath: "/tmp/other" }),
    (error) => error.statusCode === 409, "a marked archive must not move before deletion resumes");
    assert.equal(database.getConversation(archived.id), undefined, "a partially deleted archive is hidden");
    await deletion;
    assert.equal(database.getConversation(archived.id), undefined);
    assert.equal(database.getRun(running.id).status, "running");
    const interrupted = chat(database, "interrupted cleanup");
    for (let index = 0; index < 80; index += 1) database.addMessage({ conversationId: interrupted.id, role: "assistant", body: "partial" });
    database.updateConversation(interrupted.id, { archived: true });
    const interruptedDeletion = database.deleteArchivedConversation(interrupted.id, interrupted.id);
    database.close();
    await assert.rejects(interruptedDeletion, (error) => error.statusCode === 503);
    database = createOutrightDatabase({ filename });
    const deadline = Date.now() + 5_000;
    while (archivePresentOrMaintaining(database, filename, interrupted.id)) {
      assert.ok(Date.now() < deadline, "interrupted deletion did not resume");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(database.listAudit().some((entry) => entry.action === "retention.archived.deleted" && entry.target === interrupted.id));
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("partly deleted archives stay hidden across restart until durable cleanup finishes", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-hidden-deletion-"));
  const filename = path.join(directory, "outright.db");
  let database = createOutrightDatabase({ filename });
  try {
    const archived = chat(database, "hidden-deletion-title");
    const sibling = chat(database, "visible sibling");
    database.addMessage({ conversationId: sibling.id, role: "assistant", body: "sibling evidence" });
    let first;
    for (let index = 0; index < 130; index += 1) {
      const message = database.addMessage({ conversationId: archived.id, role: "assistant", body: "hidden-deletion-body" });
      first ??= message;
    }
    database.updateConversation(archived.id, { archived: true });
    const blocker = new Database(filename);
    blocker.exec(`CREATE TRIGGER stop_after_first_batch BEFORE DELETE ON messages
      WHEN (SELECT COUNT(*) FROM messages WHERE conversation_id = OLD.conversation_id) <= 66
      BEGIN SELECT RAISE(FAIL, 'hold partial archive'); END`);
    blocker.close();
    await assert.rejects(database.deleteArchivedConversation(archived.id, archived.id), /hold partial archive/);
    const physical = new Database(filename, { readonly: true });
    try {
      assert.equal(physical.prepare("SELECT deleting FROM conversations WHERE id = ?").get(archived.id).deleting, 1);
      assert.equal(physical.prepare("SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?").get(archived.id).count, 66);
    } finally { physical.close(); }
    await database.close();
    database = createOutrightDatabase({ filename });
    assert.equal(database.getConversation(archived.id), undefined);
    assert.equal(database.listConversations({ archived: true }).some((item) => item.id === archived.id), false);
    assert.equal(database.search("hidden-deletion").conversations.length, 0);
    for (const read of [
      () => database.listMessages(archived.id),
      () => database.messageCount(archived.id),
      () => database.listMessagePage(archived.id),
      () => database.getMessageBodyChunk(archived.id, first.id, 0),
    ]) assert.throws(read, (error) => error.statusCode === 404);
    await assert.rejects(database.findMessagePage(archived.id, "hidden-deletion", null), (error) => error.statusCode === 404);
    assert.equal(database.getConversation(sibling.id)?.id, sibling.id);
    assert.deepEqual(database.search("sibling evidence").conversations.map((item) => item.id), [sibling.id]);
    const unblock = new Database(filename);
    unblock.exec("DROP TRIGGER stop_after_first_batch");
    unblock.close();
    const deadline = Date.now() + 5000;
    while (archivePresentOrMaintaining(database, filename, archived.id)) {
      assert.ok(Date.now() < deadline, "restart did not finish hidden archive cleanup");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(database.listAudit().some((entry) => entry.action === "retention.archived.deleted" && entry.target === archived.id));
  } finally { await database?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("oversized legacy archive cleanup defers while active runs write, then resumes", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-oversized-retention-"));
  const filename = path.join(directory, "outright.db");
  let shadowCopies = 0;
  const database = createOutrightDatabase({ filename, runtimeLease: true, onDeletionWorkerStart: () => { shadowCopies += 1; } });
  try {
    const active = chat(database, "active");
    const running = database.createRun(runInput(active.id));
    database.updateRun(running.id, { status: "running" });
    const archives = [];
    for (const mode of ["explicit", "automatic"]) {
      const archived = chat(database, mode);
      const message = database.addMessage({ conversationId: archived.id, role: "assistant", body: "small" });
      const run = database.createRun(runInput(archived.id));
      database.updateRun(run.id, { status: "completed" });
      database.appendRunEvent(run.id, "done", { value: "small" });
      const legacy = new Database(filename);
      const huge = "x".repeat(4 * 1024 * 1024);
      legacy.prepare("UPDATE messages SET body = ? WHERE id = ?").run(huge, message.id);
      legacy.prepare("UPDATE run_events SET payload = ? WHERE run_id = ?").run(huge, run.id);
      legacy.prepare("UPDATE runs SET prompt = ? WHERE id = ?").run(huge, run.id);
      legacy.close();
      database.updateConversation(archived.id, { archived: true });
      archives.push(archived);
    }
    ageArchived(filename, archives.map((item) => item.id));
    for (const [index, archived] of archives.entries()) {
      const result = await (index === 0
        ? database.deleteArchivedConversation(archived.id, archived.id)
        : database.pruneHistory());
      assert.equal(result.deleted, 0, "giant row deleted while an active run still owned the writer budget");
      assert.ok(result.deferred, "cleanup did not report the durable deferred marker");
      assert.equal(database.capacity().cleanupPending, true);
      assert.equal(database.canLaunchRun(), true, "an unrelated run cannot wait for a marked giant archive delete");
      database.appendRunEvent(running.id, "progress", { during: archived.title });
      assert.ok(archivePresentOrMaintaining(database, filename, archived.id), "deferred row was removed before the active run finished");
      assert.equal(database.getRun(running.id).status, "running");
    }
    database.updateRun(running.id, { status: "completed" });
    const deadline = Date.now() + 8_000;
    for (const archived of archives) {
      while (archivePresentOrMaintaining(database, filename, archived.id)) {
        assert.ok(Date.now() < deadline, "deferred giant archive cleanup did not resume");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(database.listAudit().some((entry) => entry.action === "retention.archived.deleted" && entry.target === archived.id));
    }
    const probe = new Database(filename);
    assert.ok(probe.prepare("SELECT bytes FROM retained_usage WHERE id = 1").get().bytes < 1024 * 1024);
    probe.close();
    assert.equal(shadowCopies, archives.length, `expected ${archives.length} shadow copies for sibling giant rows; observed ${shadowCopies}`);
    assert.equal(database.canLaunchRun(), true, "cleanup did not reopen run admission");
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("oversized cleanup fences the live database and reclaims a shadow before resuming writes", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-archive-writer-"));
  const filename = path.join(directory, "outright.db");
  const lockGate = new Int32Array(new SharedArrayBuffer(4));
  const database = createOutrightDatabase({ filename, runtimeLease: true, deletionWorkerGate: lockGate.buffer });
  try {
    const survivor = chat(database, "retained sibling");
    const survivorBody = "evidence-\u03c3-".repeat(400);
    const retainedMessage = database.addMessage({ conversationId: survivor.id, role: "assistant", body: survivorBody });
    const queued = database.createRun(runInput(survivor.id));
    for (const mode of ["explicit", "automatic"]) {
      Atomics.store(lockGate, 0, 0);
      const archived = chat(database, mode);
      const message = database.addMessage({ conversationId: archived.id, role: "assistant", body: "small" });
      expandLegacyMessage(filename, message.id);
      const oldPhysicalBytes = statSync(filename).size;
      database.updateConversation(archived.id, { archived: true });
      if (mode === "automatic") ageArchived(filename, [archived.id]);
      const deletion = mode === "explicit" ? database.deleteArchivedConversation(archived.id, archived.id) : database.pruneHistory();
      const deadline = Date.now() + 5000;
      while (Atomics.load(lockGate, 0) !== 1) {
        assert.ok(Date.now() < deadline, "cleanup did not reach shadow maintenance");
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      assert.equal(database.capacity().cleanupPending, true);
      assert.equal(database.capacity().migrationStatus, "maintenance");
      assert.equal(database.capacity().diskUsageStatus, "partial");
      assert.throws(() => chat(database, `competing ${mode}`),
        (error) => error.statusCode === 503 && /maintenance/.test(error.message));
      assert.equal(database.maintenanceActive, true, "the rejection escaped the short cutover fence");
      assert.equal(database.canLaunchRun(), false);
      assert.doesNotThrow(() => database.audit("terminal.exited", { target: mode }),
        "optional terminal audit must not crash its event callback");
      Atomics.store(lockGate, 0, 2);
      Atomics.notify(lockGate, 0);
      assert.equal((await deletion).deleted, 1);
      assert.equal(database.getConversation(archived.id), undefined);
      assert.notEqual(database.capacity().diskUsageStatus, "partial");
      assert.ok(statSync(filename).size < oldPhysicalBytes, "shadow cutover did not reclaim legacy overflow pages");
      const proof = new Database(filename, { readonly: true });
      try {
        assert.equal(proof.prepare("SELECT body FROM messages WHERE id = ?").get(retainedMessage.id).body, survivorBody);
        assert.equal(proof.prepare("SELECT status FROM runs WHERE id = ?").get(queued.id).status, "queued");
        assert.equal(proof.prepare("SELECT bytes FROM retained_usage WHERE id = 1").get().bytes,
          retainedReadback(proof), "shadow cutover lost exact retained-byte accounting");
      } finally { proof.close(); }
      assert.ok(database.listAudit().some((entry) => entry.action === "retention.archived.deleted" && entry.target === archived.id));
    }
  } finally {
    Atomics.store(lockGate, 0, 2);
    Atomics.notify(lockGate, 0);
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("archive cutover defers while legacy terminal ownership is being reconstructed", { timeout: 20_000 }, async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-audit-cutover-"));
  const filename = path.join(directory, "outright.db");
  const copyGate = new Int32Array(new SharedArrayBuffer(4));
  const database = createOutrightDatabase({ filename, runtimeLease: true, deletionCopyGate: copyGate.buffer });
  const terminalId = "54d20348-0790-4ba8-b888-e05887e48453";
  let resumeScan;
  try {
    const archived = chat(database, "archive with pending terminal audit");
    const message = database.addMessage({ conversationId: archived.id, role: "assistant", body: "small" });
    expandLegacyMessage(filename, message.id);
    database.updateConversation(archived.id, { archived: true });
    const writer = new Database(filename);
    try {
      const insert = writer.prepare("INSERT INTO audit_log (action, target, details, created_at) VALUES (?, ?, ?, ?)");
      writer.transaction(() => {
        for (let index = 0; index < 2_100; index += 1) insert.run("legacy.telemetry", "", "{}", "2026-09-01");
        insert.run("terminal.created", terminalId,
          JSON.stringify({ cwd: directory, pid: 333 }), "2026-09-01");
      }).immediate();
    } finally { writer.close(); }
    const deletion = database.deleteArchivedConversation(archived.id, archived.id);
    const copyDeadline = Date.now() + 5_000;
    while (Atomics.load(copyGate, 0) !== 1) {
      assert.ok(Date.now() < copyDeadline, "archive copy did not reach its controlled cutover gate");
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const originalSetImmediate = globalThis.setImmediate;
    globalThis.setImmediate = (callback, ...args) => {
      if (callback.name === "advanceTerminalAuditScan") {
        resumeScan = () => originalSetImmediate(callback, ...args);
        return originalSetImmediate(() => {});
      }
      return originalSetImmediate(callback, ...args);
    };
    try { database.reconcileTerminalAudit(); }
    finally { globalThis.setImmediate = originalSetImmediate; }
    assert.equal(database.terminalAuditScanPending, true);
    assert.equal(typeof resumeScan, "function");
    Atomics.store(copyGate, 0, 2);
    Atomics.notify(copyGate, 0);
    const deferred = await deletion;
    assert.equal(deferred.deferred, true, "cutover closed SQLite during the pending ownership scan");
    assert.equal(database.maintenanceActive, false);
    assert.equal(database.terminalAuditScanPending, true);
    const source = new Database(filename, { readonly: true });
    try { assert.equal(source.prepare("SELECT COUNT(*) AS count FROM conversations WHERE id = ?").get(archived.id).count, 1); }
    finally { source.close(); }
    resumeScan();
    await database.waitForTerminalAuditReconciliation();
    const deadline = Date.now() + 8_000;
    while (true) {
      let remaining = 1;
      try {
        const probe = new Database(filename, { readonly: true, fileMustExist: true });
        try { remaining = probe.prepare("SELECT COUNT(*) AS count FROM conversations WHERE id = ?").get(archived.id).count; }
        finally { probe.close(); }
      } catch (error) {
        if (!["SQLITE_BUSY", "SQLITE_CANTOPEN", "ENOENT", "EBUSY"].includes(error.code)) throw error;
      }
      if (!remaining) break;
      assert.ok(Date.now() < deadline, "deferred archive did not resume after ownership recovery");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(database.terminalUnknownReservations().some((entry) => entry.target === terminalId),
      "resumed archive lost the unresolved native terminal reservation");
  } finally {
    Atomics.store(copyGate, 0, 2);
    Atomics.notify(copyGate, 0);
    if (resumeScan && database.terminalAuditScanPending) resumeScan();
    await database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a committed source write at archive cutover discards the stale shadow and survives restart", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-archive-late-write-"));
  const filename = path.join(directory, "outright.db");
  const lockGate = new Int32Array(new SharedArrayBuffer(4));
  let database = createOutrightDatabase({ filename, runtimeLease: true, deletionWorkerGate: lockGate.buffer });
  try {
    const sibling = chat(database, "retained sibling");
    const retained = database.addMessage({ conversationId: sibling.id, role: "assistant", body: "before cutover" });
    const queued = database.createRun(runInput(sibling.id));
    const archived = chat(database, "legacy overflow");
    const large = database.addMessage({ conversationId: archived.id, role: "assistant", body: "small" });
    expandLegacyMessage(filename, large.id);
    database.updateConversation(archived.id, { archived: true });
    const deletion = database.deleteArchivedConversation(archived.id, archived.id);
    const deadline = Date.now() + 5000;
    while (Atomics.load(lockGate, 0) !== 1) {
      assert.ok(Date.now() < deadline, "shadow did not reach the cutover gate");
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const writer = new Database(filename);
    try {
      writer.transaction(() => {
        writer.prepare("UPDATE messages SET body = ? WHERE id = ?").run("committed at cutover", retained.id);
        writer.prepare("UPDATE runs SET prompt = ? WHERE id = ?").run("queued evidence at cutover", queued.id);
        writer.prepare("INSERT INTO audit_log (action, target, details, created_at) VALUES (?, ?, ?, ?)")
          .run("cutover.probe", sibling.id, "{}", new Date().toISOString());
        writer.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
          .run("cutover.probe", "committed");
      }).immediate();
    } finally { writer.close(); }
    Atomics.store(lockGate, 0, 2);
    Atomics.notify(lockGate, 0);
    assert.equal((await deletion).deferred, true, "a stale shadow replaced a committed source transaction");
    await database.close();
    database = null;
    const proof = new Database(filename, { readonly: true });
    try {
      assert.equal(proof.prepare("SELECT body FROM messages WHERE id = ?").get(retained.id).body, "committed at cutover");
      assert.equal(proof.prepare("SELECT prompt FROM runs WHERE id = ?").get(queued.id).prompt, "queued evidence at cutover");
      assert.equal(proof.prepare("SELECT value FROM settings WHERE key = ?").get("cutover.probe").value, "committed");
      assert.equal(proof.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = ?").get("cutover.probe").count, 1);
      assert.equal(proof.prepare("SELECT bytes FROM retained_usage WHERE id = 1").get().bytes, retainedReadback(proof));
    } finally { proof.close(); }
    database = createOutrightDatabase({ filename, runtimeLease: true });
    const completed = Date.now() + 8000;
    while (archivePresentOrMaintaining(database, filename, archived.id)) {
      assert.ok(Date.now() < completed, "deferred deletion did not resume after restart");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(database.listMessages(sibling.id)[0].body, "committed at cutover");
    assert.equal(database.getRun(queued.id).prompt, "queued evidence at cutover");
    assert.equal(database.listAudit().filter((entry) => entry.action === "retention.archived.deleted" && entry.target === archived.id).length, 1);
  } finally {
    Atomics.store(lockGate, 0, 2);
    Atomics.notify(lockGate, 0);
    await database?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a direct schema commit after source close defers stale shadow promotion", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-archive-close-gap-"));
  const filename = path.join(directory, "outright.db");
  const gate = new Int32Array(new SharedArrayBuffer(4));
  let database = createOutrightDatabase({ filename, runtimeLease: true, deletionCutoverCloseGate: gate.buffer });
  try {
    const sibling = chat(database, "recoverable sibling");
    database.addMessage({ conversationId: sibling.id, role: "assistant", body: "before close" });
    const queued = database.createRun(runInput(sibling.id));
    const archived = chat(database, "large archive");
    const large = database.addMessage({ conversationId: archived.id, role: "assistant", body: "small" });
    expandLegacyMessage(filename, large.id);
    database.updateConversation(archived.id, { archived: true });
    const deletion = database.deleteArchivedConversation(archived.id, archived.id);
    const deadline = Date.now() + 5000;
    while (Atomics.load(gate, 0) !== 1) {
      assert.ok(Date.now() < deadline, "worker did not release the fenced source");
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const writer = new Database(filename);
    try {
      writer.exec("CREATE TABLE close_gap_schema (value TEXT)");
      writer.pragma("user_version = 42");
    } finally { writer.close(); }
    Atomics.store(gate, 0, 2);
    Atomics.notify(gate, 0);
    assert.equal((await deletion).deferred, true, "post-close source commits must reject a stale candidate");
    await database.close();
    database = null;
    const proof = new Database(filename, { readonly: true });
    try {
      assert.ok(proof.prepare("SELECT 1 FROM sqlite_master WHERE name = 'close_gap_schema'").get());
      assert.equal(proof.pragma("user_version", { simple: true }), 42);
      assert.equal(proof.prepare("SELECT body FROM messages WHERE conversation_id = ?").get(sibling.id).body, "before close");
      assert.equal(proof.prepare("SELECT prompt FROM runs WHERE id = ?").get(queued.id).prompt, "work");
      assert.equal(proof.prepare("SELECT bytes FROM retained_usage WHERE id = 1").get().bytes, retainedReadback(proof));
    } finally { proof.close(); }
    database = createOutrightDatabase({ filename, runtimeLease: true });
    assert.equal(database.getRun(queued.id).status, "queued");
  } finally {
    Atomics.store(gate, 0, 2);
    Atomics.notify(gate, 0);
    await database?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a direct writer after the source closes cannot commit through shadow promotion", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-archive-final-fence-"));
  const filename = path.join(directory, "outright.db");
  const gate = new Int32Array(new SharedArrayBuffer(4));
  let database = createOutrightDatabase({ filename, runtimeLease: true, deletionCutoverStatGate: gate.buffer });
  try {
    const sibling = chat(database, "retained sibling");
    const retained = database.addMessage({ conversationId: sibling.id, role: "assistant", body: "original evidence" });
    const queued = database.createRun(runInput(sibling.id));
    const archived = chat(database, "large archive");
    const large = database.addMessage({ conversationId: archived.id, role: "assistant", body: "small" });
    expandLegacyMessage(filename, large.id);
    database.updateConversation(archived.id, { archived: true });
    const deletion = database.deleteArchivedConversation(archived.id, archived.id);
    const deadline = Date.now() + 5000;
    while (Atomics.load(gate, 0) !== 1) {
      assert.ok(Date.now() < deadline, "cutover did not reach the final source comparison");
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const writer = new Database(filename);
    writer.pragma("busy_timeout = 0");
    for (const statement of [
      () => writer.exec("CREATE TABLE cutover_late_schema (value TEXT)"),
      () => writer.pragma("user_version = 42"),
      () => writer.exec("DROP TRIGGER archive_cutover_update_messages"),
      () => writer.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("cutover.late", '"dark"'),
      () => writer.prepare("INSERT INTO audit_log (action, target, details, created_at) VALUES (?, ?, ?, ?)")
        .run("cutover.late", sibling.id, "{}", new Date().toISOString()),
      () => writer.exec("DELETE FROM archive_cutover_guard"),
    ]) {
      assert.throws(statement, (error) => error.code === "SQLITE_BUSY" || /Archive cutover is in progress/.test(error.message));
    }
    let committed = false;
    try {
      writer.transaction(() => {
        writer.prepare("UPDATE messages SET body = ? WHERE id = ?").run("late committed evidence", retained.id);
        writer.prepare("UPDATE runs SET prompt = ? WHERE id = ?").run("late queued evidence", queued.id);
      }).immediate();
      committed = true;
    } catch (error) {
      assert.ok(["SQLITE_BUSY", "SQLITE_LOCKED", "SQLITE_CONSTRAINT_TRIGGER"].includes(error.code),
        `unexpected direct writer failure: ${error.message}`);
    } finally { writer.close(); }
    Atomics.store(gate, 0, 2);
    Atomics.notify(gate, 0);
    const result = await deletion;
    if (committed) assert.equal(result.deferred, true, "a committed post-comparison source write was replaced");
    else assert.equal(result.deleted, 1, "a fenced source should still promote its compacted shadow");
    await database.close();
    database = null;
    const proof = new Database(filename, { readonly: true });
    try {
      assert.equal(proof.prepare("SELECT body FROM messages WHERE id = ?").get(retained.id).body,
        committed ? "late committed evidence" : "original evidence");
      assert.equal(proof.prepare("SELECT prompt FROM runs WHERE id = ?").get(queued.id).prompt,
        committed ? "late queued evidence" : "work");
      assert.equal(proof.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'cutover.late'").get().count, 0);
      assert.equal(proof.prepare("SELECT 1 FROM sqlite_master WHERE name = 'archive_cutover_guard'").get(), undefined,
        "the promoted database must not retain the source fence");
      assert.equal(proof.prepare("SELECT bytes FROM retained_usage WHERE id = 1").get().bytes, retainedReadback(proof));
    } finally { proof.close(); }
    database = createOutrightDatabase({ filename, runtimeLease: true });
    assert.equal(database.getRun(queued.id).status, "queued");
  } finally {
    Atomics.store(gate, 0, 2);
    Atomics.notify(gate, 0);
    await database?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("shadow copy serves unrelated work and retries after a concurrent source write", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-archive-live-copy-"));
  const filename = path.join(directory, "outright.db");
  const copyGate = new Int32Array(new SharedArrayBuffer(4));
  const database = createOutrightDatabase({ filename, runtimeLease: true, deletionCopyGate: copyGate.buffer });
  try {
    const archived = chat(database, "large old archive");
    const message = database.addMessage({ conversationId: archived.id, role: "assistant", body: "small" });
    expandLegacyMessage(filename, message.id, 8);
    database.updateConversation(archived.id, { archived: true });
    const deletion = database.deleteArchivedConversation(archived.id, archived.id);
    const deadline = Date.now() + 5000;
    while (Atomics.load(copyGate, 0) !== 1) {
      assert.ok(Date.now() < deadline, "shadow copy did not reach the live-source gate");
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.equal(database.maintenanceActive, false, "copy unexpectedly fenced the live database");
    assert.equal(database.canLaunchRun(), true, "copy unexpectedly consumed an agent slot");
    const sibling = chat(database, "created during copy");
    const queued = database.createRun(runInput(sibling.id));
    assert.equal(database.getRun(queued.id).status, "queued");
    assert.equal(database.capacity().cleanupPending, true);
    Atomics.store(copyGate, 0, 2);
    Atomics.notify(copyGate, 0);
    const first = await deletion;
    assert.equal(first.deferred, true, "a stale shadow should defer after concurrent source changes");
    assert.ok(database.getConversation(sibling.id));
    const completed = Date.now() + 8000;
    while (archivePresentOrMaintaining(database, filename, archived.id)) {
      assert.ok(Date.now() < completed, "deferred shadow did not resume after source became idle");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(database.getRun(queued.id).status, "queued");
    assert.ok(database.listAudit().some((entry) => entry.action === "retention.archived.deleted" && entry.target === archived.id));
  } finally {
    Atomics.store(copyGate, 0, 2);
    Atomics.notify(copyGate, 0);
    await database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an in-flight archive copy does not pin sustained sibling writes in the WAL", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-archive-wal-budget-"));
  const filename = path.join(directory, "outright.db");
  const copyStepGate = new Int32Array(new SharedArrayBuffer(4));
  let database = createOutrightDatabase({ filename, runtimeLease: true, deletionCopyStepGate: copyStepGate.buffer });
  try {
    const sibling = chat(database, "retained during copy");
    const stable = database.addMessage({ conversationId: sibling.id, role: "assistant", body: "a".repeat(4096) });
    const queued = database.createRun(runInput(sibling.id));
    const archived = chat(database, "legacy overflow");
    const oversized = database.addMessage({ conversationId: archived.id, role: "assistant", body: "small" });
    expandLegacyMessage(filename, oversized.id, 8);
    database.updateConversation(archived.id, { archived: true });
    const deletion = database.deleteArchivedConversation(archived.id, archived.id);
    const deadline = Date.now() + 5000;
    while (Atomics.load(copyStepGate, 0) !== 1) {
      assert.ok(Date.now() < deadline, "online copy did not reach a bounded source-read step");
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const writer = new Database(filename);
    let peakWalBytes = 0;
    try {
      const update = writer.prepare("UPDATE messages SET body = ? WHERE id = ?");
      for (let index = 0; index < 2000; index += 1) {
        update.run(`${String(index).padStart(4, "0")}${"a".repeat(4092)}`, stable.id);
        if (index % 100 === 0) peakWalBytes = Math.max(peakWalBytes, statSync(`${filename}-wal`).size);
      }
      peakWalBytes = Math.max(peakWalBytes, statSync(`${filename}-wal`).size);
    } finally { writer.close(); }
    assert.ok(peakWalBytes < 8 * 1024 * 1024, `copy pinned a growing source WAL: ${peakWalBytes} bytes`);
    Atomics.store(copyStepGate, 0, 2);
    Atomics.notify(copyStepGate, 0);
    assert.equal((await deletion).deferred, true, "the changed source must not be replaced by an older copy");
    const completeBy = Date.now() + 8000;
    while (archivePresentOrMaintaining(database, filename, archived.id)) {
      assert.ok(Date.now() < completeBy, "deferred archive did not clean up after sustained writes stopped");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(database.getRun(queued.id).status, "queued");
    assert.equal(database.listMessages(sibling.id)[0].body.slice(0, 4), "1999");
    await database.close();
    database = createOutrightDatabase({ filename, runtimeLease: true });
    assert.equal(database.getRun(queued.id).status, "queued");
    assert.equal(database.listMessages(sibling.id)[0].body.slice(0, 4), "1999");
    assert.equal(database.capacity().cleanupPending, false);
  } finally {
    Atomics.store(copyStepGate, 0, 2);
    Atomics.notify(copyStepGate, 0);
    await database?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("automatic shadow cleanup defers for a late run without consuming storage retries", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-archive-late-run-"));
  const filename = path.join(directory, "outright.db");
  const copyGate = new Int32Array(new SharedArrayBuffer(4));
  let storageFailures = 0;
  const database = createOutrightDatabase({ filename, runtimeLease: true, deletionCopyGate: copyGate.buffer,
    onDeletionError: () => { storageFailures += 1; } });
  try {
    const archived = chat(database, "large old archive");
    const message = database.addMessage({ conversationId: archived.id, role: "assistant", body: "small" });
    expandLegacyMessage(filename, message.id, 8);
    database.updateConversation(archived.id, { archived: true });
    ageArchived(filename, [archived.id]);
    const deletion = database.pruneHistory();
    const deadline = Date.now() + 5000;
    while (Atomics.load(copyGate, 0) !== 1) {
      assert.ok(Date.now() < deadline, "shadow worker did not reach the conflict gate");
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const sibling = chat(database, "admitted sibling");
    const running = database.createRun(runInput(sibling.id));
    database.updateRun(running.id, { status: "running" });
    Atomics.store(copyGate, 0, 2);
    Atomics.notify(copyGate, 0);
    assert.equal((await deletion).deferred, 1);
    assert.equal(storageFailures, 0, "a late run was charged to the storage failure budget");
    assert.equal(database.capacity().cleanupPaused, 0);
    assert.ok(archivePresentOrMaintaining(database, filename, archived.id));
    database.updateRun(running.id, { status: "completed" });
    const completed = Date.now() + 8000;
    while (archivePresentOrMaintaining(database, filename, archived.id)) {
      assert.ok(Date.now() < completed, "archive did not drain once the run settled");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(database.listAudit().filter((entry) => entry.action === "retention.archived.deleted" && entry.target === archived.id).length, 1);
    assert.equal(database.getRun(running.id).status, "completed");
    assert.equal(storageFailures, 0);
  } finally {
    Atomics.store(copyGate, 0, 2);
    Atomics.notify(copyGate, 0);
    await database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejected shadow replacement preserves queued and recoverable evidence through restart", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-shadow-replacement-"));
  const filename = path.join(directory, "outright.db");
  const lockGate = new Int32Array(new SharedArrayBuffer(4));
  let database = createOutrightDatabase({ filename, runtimeLease: true, deletionWorkerGate: lockGate.buffer });
  try {
    const survivor = chat(database, "surviving evidence");
    const retained = database.addMessage({ conversationId: survivor.id, role: "assistant", body: "original survivor" });
    const queued = database.createRun(runInput(survivor.id));
    const recoveryChat = chat(database, "recoverable evidence");
    const interrupted = database.createRun(runInput(recoveryChat.id));
    database.updateRun(interrupted.id, { status: "interrupted" });
    const archived = chat(database, "oversized deletion");
    const large = database.addMessage({ conversationId: archived.id, role: "assistant", body: "small" });
    expandLegacyMessage(filename, large.id);
    database.updateConversation(archived.id, { archived: true });
    const deletion = database.deleteArchivedConversation(archived.id, archived.id);
    const deadline = Date.now() + 5000;
    while (Atomics.load(lockGate, 0) !== 1) {
      assert.ok(Date.now() < deadline, "candidate did not reach its prepared cutover gate");
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    // SQLite DML is now fenced on a prepared candidate. Change its bytes
    // outside SQLite to verify the digest still rejects a replaced shadow.
    appendFileSync(`${filename}.archive-next`, "unvalidated tail");
    Atomics.store(lockGate, 0, 2);
    Atomics.notify(lockGate, 0);
    await assert.rejects(deletion, /candidate changed/);
    await database.close();
    database = null;
    const proof = new Database(filename, { readonly: true });
    try {
      assert.equal(proof.prepare("SELECT body FROM messages WHERE id = ?").get(retained.id).body, "original survivor");
      assert.equal(proof.prepare("SELECT status FROM runs WHERE id = ?").get(queued.id).status, "queued");
      assert.equal(proof.prepare("SELECT status FROM runs WHERE id = ?").get(interrupted.id).status, "interrupted");
      assert.equal(proof.prepare("SELECT bytes FROM retained_usage WHERE id = 1").get().bytes, retainedReadback(proof));
      assert.equal(proof.prepare("SELECT deleting FROM conversations WHERE id = ?").get(archived.id).deleting, 1);
    } finally { proof.close(); }
    database = createOutrightDatabase({ filename, runtimeLease: true });
    const completed = Date.now() + 8000;
    while (archivePresentOrMaintaining(database, filename, archived.id)) {
      assert.ok(Date.now() < completed, "durable cleanup marker did not resume after replacement rejection");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(database.listAudit().filter((entry) => entry.action === "retention.archived.deleted" && entry.target === archived.id).length, 1);
    assert.equal(database.getRun(queued.id).status, "queued");
    assert.equal(database.getRun(interrupted.id).status, "interrupted");
  } finally {
    Atomics.store(lockGate, 0, 2);
    Atomics.notify(lockGate, 0);
    await database?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("physical directory aliases share one runtime lease", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-lease-alias-"));
  const actual = path.join(root, "actual");
  const alias = path.join(root, "alias");
  let owner;
  let replacement;
  try {
    owner = createOutrightDatabase({ filename: path.join(actual, "outright.db"), runtimeLease: true });
    symlinkSync(actual, alias, process.platform === "win32" ? "junction" : "dir");
    const queued = owner.createRun(runInput(chat(owner, "lease owner").id));
    assert.throws(() => createOutrightDatabase({ filename: path.join(alias, "outright.db"), runtimeLease: true }),
      (error) => error.code === "OUTRIGHT_RUNTIME_LEASE_HELD");
    assert.equal(owner.getRun(queued.id).status, "queued");
    await owner.close();
    owner = null;
    replacement = createOutrightDatabase({ filename: path.join(alias, "outright.db"), runtimeLease: true });
    assert.equal(replacement.getRun(queued.id).status, "queued");
  } finally {
    await owner?.close();
    await replacement?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("automatic deletion wraps to an archive marked behind its in-flight cursor", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-archive-cursor-"));
  const filename = path.join(directory, "outright.db");
  let database = createOutrightDatabase({ filename });
  try {
    const earlier = chat(database, "earlier archive");
    database.addMessage({ conversationId: earlier.id, role: "assistant", body: "earlier" });
    database.updateConversation(earlier.id, { archived: true });
    const later = chat(database, "later archive");
    const message = database.addMessage({ conversationId: later.id, role: "assistant", body: "later" });
    database.updateConversation(later.id, { archived: true });
    database.close();
    const legacy = new Database(filename);
    legacy.prepare("UPDATE messages SET body = ? WHERE id = ?").run("x".repeat(4 * 1024 * 1024), message.id);
    legacy.prepare("UPDATE conversations SET deleting = 1 WHERE id = ?").run(later.id);
    legacy.close();
    let markedEarlier = false;
    database = createOutrightDatabase({ filename, onDeletionWorkerExit: () => {
      if (markedEarlier) return;
      const marker = new Database(filename);
      try { marker.prepare("UPDATE conversations SET deleting = 1 WHERE id = ?").run(earlier.id); }
      finally { marker.close(); }
      markedEarlier = true;
    } });
    const deadline = Date.now() + 8_000;
    while (archivePresentOrMaintaining(database, filename, earlier.id) || archivePresentOrMaintaining(database, filename, later.id)) {
      assert.ok(Date.now() < deadline, `archive behind deletion cursor was stranded: pending=${database.capacity().cleanupPending}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(markedEarlier, true);
    for (const id of [earlier.id, later.id]) {
      assert.equal(database.listAudit().filter((entry) => entry.action === "retention.archived.deleted" && entry.target === id).length, 1);
    }
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("automatic deletion visits a later eligible marker while an earlier giant row is deferred", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-archive-deferred-cursor-"));
  const filename = path.join(directory, "outright.db");
  let database = createOutrightDatabase({ filename, runtimeLease: true });
  try {
    const active = chat(database, "active sibling");
    const running = database.createRun(runInput(active.id));
    database.updateRun(running.id, { status: "running" });
    const giant = chat(database, "earlier giant archive");
    const oversized = database.addMessage({ conversationId: giant.id, role: "assistant", body: "small" });
    database.updateConversation(giant.id, { archived: true });
    const small = chat(database, "later small archive");
    database.addMessage({ conversationId: small.id, role: "assistant", body: "later" });
    database.updateConversation(small.id, { archived: true });
    await database.close();
    const legacy = new Database(filename);
    legacy.prepare("UPDATE messages SET body = ? WHERE id = ?").run("x".repeat(4 * 1024 * 1024), oversized.id);
    legacy.prepare("UPDATE conversations SET deleting = 1 WHERE id IN (?, ?)").run(giant.id, small.id);
    legacy.close();
    database = createOutrightDatabase({ filename, runtimeLease: true });
    const deadline = Date.now() + 5000;
    while (archivePresentOrMaintaining(database, filename, small.id)) {
      assert.ok(Date.now() < deadline, "later eligible marker was stranded behind a deferred giant row");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(archivePresentOrMaintaining(database, filename, giant.id), true);
    assert.equal(database.getRun(running.id).status, "running");
    database.updateRun(running.id, { status: "completed" });
    const finishBy = Date.now() + 8000;
    while (archivePresentOrMaintaining(database, filename, giant.id)) {
      assert.ok(Date.now() < finishBy, "deferred giant marker did not resume after the active run settled");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    for (const id of [giant.id, small.id]) {
      assert.equal(database.listAudit().filter((item) => item.action === "retention.archived.deleted" && item.target === id).length, 1);
    }
  } finally { await database?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("a legacy run error uses the worker and a required cleanup audit waits for its lock", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-run-error-cleanup-"));
  const filename = path.join(directory, "outright.db");
  const lockGate = new Int32Array(new SharedArrayBuffer(4));
  const database = createOutrightDatabase({ filename, runtimeLease: true, deletionWorkerGate: lockGate.buffer });
  try {
    const archived = chat(database, "legacy run error");
    const run = database.createRun(runInput(archived.id));
    database.updateRun(run.id, { status: "completed" });
    const legacy = new Database(filename);
    legacy.prepare("UPDATE runs SET error = ? WHERE id = ?").run("e".repeat(4 * 1024 * 1024), run.id);
    legacy.close();
    database.updateConversation(archived.id, { archived: true });
    const deletion = database.deleteArchivedConversation(archived.id, archived.id);
    const deadline = Date.now() + 5000;
    while (Atomics.load(lockGate, 0) !== 1) {
      assert.ok(Date.now() < deadline, "large error was deleted on the runtime connection instead of the worker");
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    let audited = false;
    const audit = database.auditRequired("retention.cleaned", { target: archived.id, deleted: 1 })
      .then(() => { audited = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(audited, false, "cleanup audit committed through an occupied SQLite writer");
    Atomics.store(lockGate, 0, 2);
    Atomics.notify(lockGate, 0);
    await deletion;
    await audit;
    assert.ok(database.listAudit().some((entry) => entry.action === "retention.cleaned" && entry.target === archived.id));
    assert.equal(database.getConversation(archived.id), undefined);
    assert.ok(database.capacity().retainedBytes < 1024 * 1024, "large error remained charged after deletion");
  } finally {
    Atomics.store(lockGate, 0, 2);
    Atomics.notify(lockGate, 0);
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("failed archive recovery rejects required audit waiters and preserves source for restart", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-audit-recovery-"));
  const filename = path.join(directory, "outright.db");
  const lockGate = new Int32Array(new SharedArrayBuffer(4));
  let database = createOutrightDatabase({ filename, runtimeLease: true, deletionWorkerGate: lockGate.buffer });
  try {
    const archived = chat(database, "audit recovery");
    const message = database.addMessage({ conversationId: archived.id, role: "assistant", body: "small" });
    expandLegacyMessage(filename, message.id);
    database.updateConversation(archived.id, { archived: true });
    const deletion = database.deleteArchivedConversation(archived.id, archived.id);
    const deadline = Date.now() + 5000;
    while (Atomics.load(lockGate, 0) !== 1) {
      assert.ok(Date.now() < deadline, "archive cutover did not reach failure gate");
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const audit = database.auditRequired("retention.cleaned", { target: archived.id })
      .then(() => null, (error) => error);
    // Corrupt only the disposable maintenance marker to force both cutover
    // and its recovery worker to fail. The source must remain protected.
    writeFileSync(`${filename}.archive-state`, "broken marker");
    Atomics.store(lockGate, 0, 2);
    Atomics.notify(lockGate, 0);
    await assert.rejects(deletion, /recovery failed/);
    const auditResult = await Promise.race([audit, new Promise((_, reject) => setTimeout(() => reject(new Error("audit waiter hung")), 1000))]);
    assert.ok(auditResult?.statusCode === 503 && /recovery failed/.test(auditResult.message));
    assert.equal(await database.close(), undefined);
    database = null;
    assert.ok(existsSync(filename), "failed recovery removed the original evidence");
    // Restore the marker format; startup recovery discards the uncommitted
    // candidate and resumes the durable deletion marker.
    writeFileSync(`${filename}.archive-state`, JSON.stringify({ version: 1, source: realpathSync(filename) }));
    await recoverArchiveBeforeStartup({ filename });
    const reopened = createOutrightDatabase({ filename, runtimeLease: true });
    try { assert.ok(archivePresentOrMaintaining(reopened, filename, archived.id)); }
    finally { await reopened.close(); }
  } finally {
    Atomics.store(lockGate, 0, 2);
    Atomics.notify(lockGate, 0);
    await database?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("persistent cleanup failure pauses retries and automatic cleanup clears paused state", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-cleanup-retry-"));
  const filename = path.join(directory, "outright.db");
  let failures = 0;
  let database = createOutrightDatabase({ filename, onDeletionError: () => { failures += 1; } });
  try {
    const archived = chat(database, "blocked cleanup");
    database.addMessage({ conversationId: archived.id, role: "assistant", body: "history" });
    database.updateConversation(archived.id, { archived: true });
    const legacy = new Database(filename);
    legacy.exec("CREATE TRIGGER refuse_archive_delete BEFORE DELETE ON messages BEGIN SELECT RAISE(FAIL, 'blocked by fixture'); END");
    legacy.close();
    await assert.rejects(database.deleteArchivedConversation(archived.id, archived.id), /blocked by fixture/);
    const deadline = Date.now() + 30_000;
    while (failures < 5) {
      assert.ok(Date.now() < deadline, `cleanup did not reach its retry budget (${failures})`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 1300));
    assert.equal(failures, 5, "failing cleanup kept retrying every second");
    assert.equal(database.capacity().cleanupPaused, 1);
    const probe = new Database(filename);
    assert.equal(probe.prepare("SELECT deleting FROM conversations WHERE id = ?").get(archived.id)?.deleting, 1);
    probe.exec("DROP TRIGGER refuse_archive_delete");
    probe.close();
    assert.deepEqual((await database.pruneHistory()).ids, [archived.id]);
    assert.equal(database.capacity().cleanupPaused, 0, "successful automatic cleanup retained a stale paused marker");
    const interrupted = chat(database, "restart after failed cleanup");
    database.addMessage({ conversationId: interrupted.id, role: "assistant", body: "history" });
    database.updateConversation(interrupted.id, { archived: true });
    const blocked = new Database(filename);
    blocked.exec("CREATE TRIGGER refuse_archive_delete BEFORE DELETE ON messages BEGIN SELECT RAISE(FAIL, 'blocked by fixture'); END");
    blocked.close();
    await assert.rejects(database.deleteArchivedConversation(interrupted.id, interrupted.id), /blocked by fixture/);
    database.close();
    const recovered = new Database(filename);
    recovered.exec("DROP TRIGGER refuse_archive_delete");
    recovered.close();
    database = createOutrightDatabase({ filename });
    assert.equal(database.capacity().cleanupPaused, 0);
    assert.equal(database.getConversation(archived.id), undefined);
    const resumed = Date.now() + 5000;
    while (archivePresentOrMaintaining(database, filename, interrupted.id)) {
      assert.ok(Date.now() < resumed, "durable cleanup marker did not resume after restart");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(database.listAudit().some((entry) => entry.action === "retention.archived.deleted" && entry.target === archived.id));
    assert.ok(database.listAudit().some((entry) => entry.action === "retention.archived.deleted" && entry.target === interrupted.id));
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("a full page of paused archive markers leaves the scheduler idle and drains after restart", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-paused-page-"));
  const filename = path.join(directory, "outright.db");
  let database = createOutrightDatabase({ filename });
  const ids = [];
  try {
    for (let index = 0; index < 64; index += 1) {
      const archived = chat(database, `paused ${index}`);
      database.updateConversation(archived.id, { archived: true });
      ids.push(archived.id);
    }
    await database.close();
    const legacy = new Database(filename);
    legacy.prepare("UPDATE conversations SET deleting = 1 WHERE archived = 1").run();
    legacy.exec("CREATE TRIGGER refuse_archive_delete BEFORE DELETE ON conversations BEGIN SELECT RAISE(FAIL, 'blocked by fixture'); END");
    legacy.close();
    database = createOutrightDatabase({ filename, deletionRetryBaseMs: 1 });
    const deadline = Date.now() + 10_000;
    while (database.capacity().cleanupPaused < ids.length) {
      assert.ok(Date.now() < deadline, `cleanup paused ${database.capacity().cleanupPaused} of ${ids.length} failed markers`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    let immediateCount = 0;
    const hook = createHook({ init(_id, type) { if (type === "Immediate") immediateCount += 1; } });
    hook.enable();
    try { await new Promise((resolve) => setTimeout(resolve, 100)); }
    finally { hook.disable(); }
    assert.ok(immediateCount < 50, `paused cleanup kept scheduling itself (${immediateCount} immediates in 100ms)`);
    assert.equal(database.capacity().cleanupPending, true);
    const repair = new Database(filename);
    repair.exec("DROP TRIGGER refuse_archive_delete");
    repair.close();
    assert.equal((await database.deleteArchivedConversation(ids[0], ids[0])).deleted, 1);
    await database.close();
    database = createOutrightDatabase({ filename });
    const drainDeadline = Date.now() + 8000;
    while (database.capacity().cleanupPending) {
      assert.ok(Date.now() < drainDeadline, "paused markers did not drain after restart");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    for (const id of ids) {
      assert.equal(database.getConversation(id), undefined);
      assert.equal(database.listAudit().filter((entry) => entry.action === "retention.archived.deleted" && entry.target === id).length, 1);
    }
  } finally {
    await database?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("closing during an oversized archive delete keeps its lease until the worker exits and resumes cleanup", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-oversized-restart-"));
  const filename = path.join(directory, "outright.db");
  const lockGate = new Int32Array(new SharedArrayBuffer(4));
  let database = createOutrightDatabase({ filename, runtimeLease: true, deletionWorkerGate: lockGate.buffer });
  try {
    const archived = chat(database);
    const message = database.addMessage({ conversationId: archived.id, role: "assistant", body: "small" });
    expandLegacyMessage(filename, message.id, 16);
    database.updateConversation(archived.id, { archived: true });
    const deletion = database.deleteArchivedConversation(archived.id, archived.id);
    const gateDeadline = Date.now() + 5_000;
    while (Atomics.load(lockGate, 0) !== 1) {
      assert.ok(Date.now() < gateDeadline, "shadow maintenance did not reach the interruption gate");
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.throws(() => createOutrightDatabase({ filename, runtimeLease: true }),
      (error) => error.code === "OUTRIGHT_RUNTIME_LEASE_HELD");
    const closed = database.close();
    database = null;
    await closed;
    await assert.rejects(deletion, (error) => error.statusCode === 503);
    assert.equal(existsSync(`${filename}.archive-state`), false, "shutdown left an unrecoverable shadow marker");
    const retained = new Database(filename);
    assert.equal(retained.prepare("SELECT COUNT(*) AS count FROM messages WHERE id = ?").get(message.id).count, 1);
    retained.close();
    const deadline = Date.now() + 5_000;
    while (!database) {
      assert.ok(Date.now() < deadline, "oversized deletion worker kept the runtime lease after exit");
      try { database = createOutrightDatabase({ filename, runtimeLease: true }); }
      catch (error) {
        assert.equal(error.code, "OUTRIGHT_RUNTIME_LEASE_HELD");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    while (archivePresentOrMaintaining(database, filename, archived.id)) {
      assert.ok(Date.now() < deadline, "oversized archived cleanup did not resume");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(database.listAudit().some((entry) => entry.action === "retention.archived.deleted" && entry.target === archived.id));
  } finally {
    Atomics.store(lockGate, 0, 2);
    Atomics.notify(lockGate, 0);
    await database?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a partially created recovery lookup restarts its bounded backfill before ownership queries", async () => {
  for (const boundary of ["table", "index", "trigger"]) {
    const directory = mkdtempSync(path.join(os.tmpdir(), `outright-recovery-${boundary}-`));
    const filename = path.join(directory, "outright.db");
    let database = createOutrightDatabase({ filename });
    try {
      const conversation = chat(database);
      database.close();
      const legacy = new Database(filename);
      legacy.exec(`DROP TRIGGER runs_recovery_insert; DROP TRIGGER runs_recovery_update;
        DROP TRIGGER runs_recovery_delete; DROP TABLE recovery_scope; DROP INDEX runs_worktree_recovery`);
      legacy.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 128)
        INSERT INTO runs (id, conversation_id, worktree_path, provider, approval_policy, prompt, status, created_at)
        SELECT printf('settled-%04d', n), ?, '/tmp/w', 'codex', 'read-only', 'old', 'completed', '2026-01-01T00:00:00.000Z' FROM seq`)
        .run(conversation.id);
      legacy.prepare(`INSERT INTO runs (id, conversation_id, worktree_path, provider, approval_policy, prompt, status, created_at)
        VALUES ('unresolved', ?, '/tmp/w', 'codex', 'read-only', 'old', 'interrupted', '2026-01-01T00:00:00.000Z')`).run(conversation.id);
      legacy.exec("CREATE TABLE recovery_scope (run_id TEXT PRIMARY KEY, worktree_path TEXT)");
      if (boundary !== "table") legacy.exec("CREATE INDEX recovery_scope_path ON recovery_scope(worktree_path, run_id)");
      if (boundary === "trigger") legacy.exec(`CREATE TRIGGER runs_recovery_delete AFTER DELETE ON runs BEGIN
        DELETE FROM recovery_scope WHERE run_id = OLD.id; END`);
      legacy.pragma("user_version = 1");
      legacy.close();

      database = createOutrightDatabase({ filename });
      assert.throws(() => database.findUnresolvedInterruptedRunForWorktree("/tmp/w"),
        (error) => error.statusCode === 503, `${boundary} must keep recovery gated during backfill`);
      const deadline = Date.now() + 5_000;
      while (database.capacity().migrationStatus !== "ready") {
        assert.ok(Date.now() < deadline, `${boundary} recovery backfill timed out`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(database.findUnresolvedInterruptedRunForWorktree("/tmp/w")?.id, "unresolved");
    } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
  }
});

test("legacy run ownership and retained bytes advance without a whole-table startup pass", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-legacy-ownership-"));
  const filename = path.join(directory, "outright.db");
  let database = createOutrightDatabase({ filename });
  try {
    const conversation = chat(database);
    database.close();
    const legacy = new Database(filename);
    legacy.exec(`DROP TRIGGER runs_recovery_insert; DROP TRIGGER runs_recovery_update;
      DROP TRIGGER runs_recovery_delete; DROP TABLE recovery_scope; DROP INDEX runs_worktree_recovery`);
    legacy.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 2000)
      INSERT INTO runs (id, conversation_id, worktree_path, provider, approval_policy, prompt, status, created_at)
      SELECT printf('legacy-%04d', n), ?, '/tmp/w', 'codex', 'read-only', 'old prompt', 'completed', '2026-01-01T00:00:00.000Z' FROM seq`)
      .run(conversation.id);
    legacy.prepare("UPDATE runs SET prompt = ? WHERE id = 'legacy-2000'").run("x".repeat(8 * 1024 * 1024));
    legacy.prepare("UPDATE retained_usage SET bytes = 0, measured = 0 WHERE id = 1").run();
    legacy.pragma("user_version = 1");
    legacy.close();

    database = createOutrightDatabase({ filename });
    const probe = new Database(filename);
    const cursor = probe.prepare("SELECT cursor_number FROM migration_progress WHERE kind = 'recovery'").get()?.cursor_number;
    assert.ok(cursor > 0 && cursor < 2000, "startup did not defer the legacy ownership pass");
    assert.equal(probe.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'runs_worktree_recovery'").get(), undefined,
      "startup rebuilt a full legacy runs index");
    probe.close();
    assert.equal(database.capacity().migrationStatus, "migrating");
    assert.throws(() => database.createRun(runInput(conversation.id)), (error) => error.statusCode === 507);
    const deadline = Date.now() + 10_000;
    while (database.capacity().migrationStatus !== "ready") {
      assert.ok(Date.now() < deadline, "legacy ownership migration did not converge");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(database.getRun("legacy-2000").worktreePath, conversation.worktreePath);
    assert.ok(database.capacity().retainedBytes > 8 * 1024 * 1024);
    database.close();
    database = createOutrightDatabase({ filename });
    assert.equal(database.capacity().migrationStatus, "ready", "completed upgrade rescanned on restart");
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});
