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

test("retention removes only archived history with settled recovery and cascades its events", () => {
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
    const first = database.pruneHistory();
    assert.deepEqual(first.ids, [finished.id]);
    assert.equal(database.getRun(finishedRun.id), undefined);
    assert.ok(database.getConversation(visible.id));
    assert.ok(database.getRun(queuedRun.id));
    assert.ok(database.getRun(interruptedRun.id));
    database.updateRun(queuedRun.id, { status: "stopped" });
    database.resolveInterruptedRun(interruptedRun.id, "discard");
    assert.equal(database.pruneHistory().deleted, 2);
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("aggregate retained history denies new work until eligible history is cleaned", () => {
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
    assert.ok(database.capacity().retainedBytes <= 64 * 1024 * 1024);
    const admin = new Database(filename);
    try {
      assert.throws(() => admin.prepare("UPDATE conversations SET title = ? WHERE id = ?").run("x".repeat(2 * 1024 * 1024), current.id), /OUTRIGHT_RETAINED_LIMIT/);
    } finally { admin.close(); }
    database.updateConversation(old.id, { archived: true });
    assert.equal(database.pruneHistory().deleted, 0, "ordinary cleanup respects the saved age");
    assert.throws(() => database.submitRun(runInput(current.id), "still refused"), (error) => error.statusCode === 507);
    assert.throws(() => database.deleteArchivedConversation(old.id, "wrong id"), (error) => error.statusCode === 400);
    assert.equal(database.deleteArchivedConversation(old.id, old.id).deleted, 1);
    assert.ok(database.getRun(interrupted.id), "a sibling's recovery evidence survives selected cleanup");
    assert.equal(database.submitRun(runInput(current.id), "accepted").run.status, "queued");
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("selected cleanup rechecks archived and run state at deletion, including cancellation and recovery", () => {
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
    assert.deepEqual(database.listDeletableArchivedConversations(), []);
    for (const item of [visible, queued, active, interrupted]) {
      assert.throws(() => database.deleteArchivedConversation(item.id, item.id), (error) => error.statusCode === 409);
    }
    database.updateRun(queuedRun.id, { status: "stopped" });
    database.updateRun(activeRun.id, { status: "completed" });
    database.resolveInterruptedRun(interruptedRun.id, "discard");
    assert.equal(database.listDeletableArchivedConversations().length, 3);
    for (const item of [queued, active, interrupted]) assert.equal(database.deleteArchivedConversation(item.id, item.id).deleted, 1);
    assert.ok(database.getConversation(visible.id));
    assert.equal(database.getRun(queuedRun.id), undefined);
    assert.equal(database.getRun(activeRun.id), undefined);
    assert.equal(database.getRun(interruptedRun.id), undefined);
  } finally { database.close(); }
});

test("migration preserves recovery transitions for legacy data already over quota", () => {
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
    assert.equal(database.pruneHistory().deleted, 1);
    assert.equal(database.submitRun(runInput(live.id), "accepted").run.status, "queued");
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

test("legacy null event payloads migrate into the byte counter without blocking new events", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-event-budget-"));
  const filename = path.join(directory, "outright.db");
  let database = createOutrightDatabase({ filename });
  try {
    const conversation = chat(database);
    const run = database.createRun(runInput(conversation.id));
    database.close();
    const legacy = new Database(filename);
    legacy.prepare("INSERT INTO run_events (run_id, seq, type, payload, created_at) VALUES (?, 1, 'legacy', NULL, ?)").run(run.id, new Date().toISOString());
    legacy.close();
    database = createOutrightDatabase({ filename });
    assert.equal(database.appendRunEvent(run.id, "new", { healthy: true }).seq, 2);
    assert.equal(database.listRunEvents(run.id).length, 2);
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
