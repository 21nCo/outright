import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOutrightDatabase } from "./database.mjs";

function chat(database, title = "Budget test") {
  return database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title, provider: "codex" });
}

function runInput(conversationId) {
  return { conversationId, provider: "codex", approvalPolicy: "read-only", prompt: "work" };
}

function ageArchived(filename, ids) {
  const admin = new Database(filename);
  const old = new Date(Date.now() - 100 * 86_400_000).toISOString();
  for (const id of ids) admin.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(old, id);
  admin.close();
}

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
    legacy.exec("DROP TRIGGER messages_search_order_insert; DROP INDEX messages_search_order; ALTER TABLE messages DROP COLUMN search_order");
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
    assert.equal(database.getConversation(archived.id).worktreePath, "/tmp/w");
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
    while (database.getConversation(interrupted.id)) {
      assert.ok(Date.now() < deadline, "interrupted deletion did not resume");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(database.listAudit().some((entry) => entry.action === "retention.archived.deleted" && entry.target === interrupted.id));
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("oversized legacy archive cleanup defers while active runs write, then resumes", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-oversized-retention-"));
  const filename = path.join(directory, "outright.db");
  const database = createOutrightDatabase({ filename, runtimeLease: true });
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
      assert.ok(database.getConversation(archived.id), "deferred row was removed before the active run finished");
      assert.equal(database.getRun(running.id).status, "running");
    }
    database.updateRun(running.id, { status: "completed" });
    const deadline = Date.now() + 8_000;
    for (const archived of archives) {
      while (database.getConversation(archived.id)) {
        assert.ok(Date.now() < deadline, "deferred giant archive cleanup did not resume");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(database.listAudit().some((entry) => entry.action === "retention.archived.deleted" && entry.target === archived.id));
    }
    const probe = new Database(filename);
    assert.ok(probe.prepare("SELECT bytes FROM retained_usage WHERE id = 1").get().bytes < 1024 * 1024);
    probe.close();
    assert.equal(database.canLaunchRun(), true, "cleanup did not reopen run admission");
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("oversized cleanup keeps the runtime reader responsive and fails competing writes promptly", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-archive-writer-"));
  const filename = path.join(directory, "outright.db");
  const lockGate = new Int32Array(new SharedArrayBuffer(4));
  const database = createOutrightDatabase({ filename, runtimeLease: true, deletionWorkerGate: lockGate.buffer });
  try {
    for (const mode of ["explicit", "automatic"]) {
      Atomics.store(lockGate, 0, 0);
      const archived = chat(database, mode);
      const message = database.addMessage({ conversationId: archived.id, role: "assistant", body: "small" });
      const legacy = new Database(filename);
      legacy.prepare("UPDATE messages SET body = ? WHERE id = ?").run("x".repeat(4 * 1024 * 1024), message.id);
      legacy.close();
      database.updateConversation(archived.id, { archived: true });
      if (mode === "automatic") ageArchived(filename, [archived.id]);
      const deletion = mode === "explicit" ? database.deleteArchivedConversation(archived.id, archived.id) : database.pruneHistory();
      const deadline = Date.now() + 5000;
      while (Atomics.load(lockGate, 0) !== 1) {
        assert.ok(Date.now() < deadline, "cleanup did not acquire the oversized writer lock");
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      assert.equal(database.capacity().cleanupPending, true);
      assert.throws(() => chat(database, `competing ${mode}`),
        (error) => error.code === "SQLITE_BUSY");
      assert.doesNotThrow(() => database.audit("terminal.exited", { target: mode }),
        "optional terminal audit must not crash its event callback");
      Atomics.store(lockGate, 0, 2);
      Atomics.notify(lockGate, 0);
      assert.equal((await deletion).deleted, 1);
      assert.equal(database.getConversation(archived.id), undefined);
      assert.ok(database.listAudit().some((entry) => entry.action === "retention.archived.deleted" && entry.target === archived.id));
    }
  } finally {
    Atomics.store(lockGate, 0, 2);
    Atomics.notify(lockGate, 0);
    database.close();
    rmSync(directory, { recursive: true, force: true });
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
    while (database.getConversation(earlier.id) || database.getConversation(later.id)) {
      assert.ok(Date.now() < deadline, `archive behind deletion cursor was stranded: earlier=${Boolean(database.getConversation(earlier.id))}, later=${Boolean(database.getConversation(later.id))}, pending=${database.capacity().cleanupPending}`);
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
    while (database.getConversation(interrupted.id)) {
      assert.ok(Date.now() < resumed, "durable cleanup marker did not resume after restart");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(database.listAudit().some((entry) => entry.action === "retention.archived.deleted" && entry.target === archived.id));
    assert.ok(database.listAudit().some((entry) => entry.action === "retention.archived.deleted" && entry.target === interrupted.id));
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("closing during an oversized archive delete keeps its lease until the worker exits and resumes cleanup", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-oversized-restart-"));
  const filename = path.join(directory, "outright.db");
  let database = createOutrightDatabase({ filename, runtimeLease: true });
  try {
    const archived = chat(database);
    const message = database.addMessage({ conversationId: archived.id, role: "assistant", body: "small" });
    const legacy = new Database(filename);
    legacy.prepare("UPDATE messages SET body = ? WHERE id = ?").run("x".repeat(16 * 1024 * 1024), message.id);
    legacy.close();
    database.updateConversation(archived.id, { archived: true });
    const deletion = database.deleteArchivedConversation(archived.id, archived.id);
    await new Promise((resolve) => setImmediate(resolve));
    database.close();
    database = null;
    await assert.rejects(deletion, (error) => error.statusCode === 503);
    const deadline = Date.now() + 5_000;
    while (!database) {
      assert.ok(Date.now() < deadline, "oversized deletion worker kept the runtime lease after exit");
      try { database = createOutrightDatabase({ filename, runtimeLease: true }); }
      catch (error) {
        assert.equal(error.code, "OUTRIGHT_RUNTIME_LEASE_HELD");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    while (database.getConversation(archived.id)) {
      assert.ok(Date.now() < deadline, "oversized archived cleanup did not resume");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(database.listAudit().some((entry) => entry.action === "retention.archived.deleted" && entry.target === archived.id));
  } finally { database?.close(); rmSync(directory, { recursive: true, force: true }); }
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
