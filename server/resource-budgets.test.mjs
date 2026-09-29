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
  const database = createOutrightDatabase({ filename: ":memory:" });
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
    const before = new Date(Date.now() + 60_000).toISOString();
    const first = database.pruneHistory({ before });
    assert.deepEqual(first.ids, [finished.id]);
    assert.equal(database.getRun(finishedRun.id), undefined);
    assert.ok(database.getConversation(visible.id));
    assert.ok(database.getRun(queuedRun.id));
    assert.ok(database.getRun(interruptedRun.id));
    database.updateRun(queuedRun.id, { status: "stopped" });
    database.resolveInterruptedRun(interruptedRun.id, "discard");
    assert.equal(database.pruneHistory({ before }).deleted, 2);
  } finally { database.close(); }
});

test("aggregate retained history denies new work until eligible history is cleaned", () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    database.updateSettings({ maxRetainedMiB: 64 });
    const old = chat(database, "old");
    const current = chat(database, "current");
    database.addMessage({ conversationId: old.id, role: "assistant", body: "x".repeat(64 * 1024 * 1024) });
    assert.ok(database.capacity().retainedBytes >= 64 * 1024 * 1024);
    assert.throws(() => database.submitRun(runInput(current.id), "refused"), (error) => error.statusCode === 507);
    assert.throws(() => database.createGroup("too much"), (error) => error.statusCode === 507);
    assert.throws(() => database.saveTemplate({ title: "too much", prompt: "work" }), (error) => error.statusCode === 507);
    assert.equal(database.messageCount(current.id), 0);
    database.updateConversation(old.id, { archived: true });
    database.pruneHistory({ before: new Date(Date.now() + 60_000).toISOString() });
    assert.equal(database.submitRun(runInput(current.id), "accepted").run.status, "queued");
  } finally { database.close(); }
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
