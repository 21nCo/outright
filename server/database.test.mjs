import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOutrightDatabase, defaultProbeRun } from "./database.mjs";

test("persists settings, groups, conversations, messages, runs, and search", () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    assert.equal(database.updateSettings({ provider: "claude", maxConcurrentRuns: 5 }).provider, "claude");
    const group = database.createGroup("Client work");
    database.setProjectGroup("project-1", group.id);
    assert.equal(database.listGroups().memberships["project-1"], group.id);

    const conversation = database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Durable chat", provider: "codex" });
    const message = database.addMessage({ conversationId: conversation.id, role: "user", body: "Find the scanner boundary" });
    assert.equal(database.listMessages(conversation.id)[0].id, message.id);

    const run = database.createRun({ conversationId: conversation.id, provider: "codex", reasoningEffort: "high", approvalPolicy: "workspace-write", prompt: message.body });
    database.appendRunEvent(run.id, "run.started", { ok: true });
    database.updateRun(run.id, { status: "completed", inputTokens: 120, outputTokens: 45 });
    assert.equal(database.listRunEvents(run.id)[0].payload.ok, true);
    assert.equal(database.getRun(run.id).outputTokens, 45);
    assert.equal(database.getRun(run.id).reasoningEffort, "high");
    assert.equal(database.search("scanner").conversations[0].id, conversation.id);
    const moved = database.moveConversation(conversation.id, { projectId: "project-2", worktreeId: "tree-2", worktreePath: "/tmp/tree-2" });
    assert.equal(moved.worktreeId, "tree-2");
    assert.equal(database.listConversations({ projectId: "project-1" }).length, 0);
  } finally {
    database.close();
  }
});

test("reconciles queued and running work as interrupted after a runtime restart", () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    const conversation = database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Recovery", provider: "codex" });
    const queued = database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "queued" });
    const running = database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "running" });
    database.updateRun(running.id, { status: "running", pid: 4242 });
    const result = database.reconcileInterruptedRuns({ probeAlive: () => false });
    assert.equal(result.count, 2);
    assert.equal(result.counts["never-started"], 1);
    assert.equal(result.counts.exited, 1);
    assert.equal(database.getRun(queued.id).status, "interrupted");
    assert.equal(database.getRun(running.id).recoveryClass, "exited");
  } finally {
    database.close();
  }
});

test("classifies a provider process still alive after the restart", () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    const conversation = database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Recovery", provider: "codex" });
    const run = database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "running" });
    database.updateRun(run.id, { status: "running", pid: process.pid });
    const result = database.reconcileInterruptedRuns();
    assert.equal(result.counts.alive, 1);
    assert.equal(database.getRun(run.id).recoveryClass, "alive");
  } finally {
    database.close();
  }
});

test("a running row without a recorded pid reconciles as unknown", () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    const conversation = database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Recovery", provider: "codex" });
    const run = database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "running" });
    database.updateRun(run.id, { status: "running" });
    database.reconcileInterruptedRuns();
    assert.equal(database.getRun(run.id).recoveryClass, "unknown");
  } finally {
    database.close();
  }
});

// Regression: reconciliation used to probe only the detached leader PID. A
// leader that exits while provider descendants still hold the process group
// was classified "exited" and could bypass the recovery process guard.
test("classifies an exited leader with a live descendant as alive", { skip: process.platform === "win32" }, async () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  let pid;
  try {
    const descendant = "setInterval(() => {}, 1000);";
    const leader = `const {spawn} = require("node:child_process"); spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], {stdio: "ignore"}); process.exit(0);`;
    const child = spawn(process.execPath, ["-e", leader], { detached: true, stdio: "ignore" });
    pid = child.pid;
    await new Promise((resolve) => child.once("exit", resolve));
    await new Promise((resolve) => {
      const started = Date.now();
      (function probe() {
        try { process.kill(pid, 0); }
        catch { return resolve(); }
        if (Date.now() - started > 5000) return resolve();
        setTimeout(probe, 25);
      })();
    });
    assert.doesNotThrow(() => process.kill(-pid, 0), "the descendant must hold the leader's process group");
    const conversation = database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Recovery", provider: "codex" });
    const run = database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "orphaned" });
    database.updateRun(run.id, { status: "running", pid });
    const result = database.reconcileInterruptedRuns();
    assert.equal(result.counts.alive, 1);
    assert.equal(database.getRun(run.id).recoveryClass, "alive");
  } finally {
    if (pid) { try { process.kill(-pid, "SIGKILL"); } catch { /* Already gone. */ } }
    database.close();
  }
});

// Regression (platform-injectable): on platforms without owned process trees
// (Windows), a gone leader cannot prove its descendants exited, so the
// persisted leader PID must classify conservatively as unknown, never exited.
test("classifies a gone leader as unknown on platforms without owned process trees", async () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  let pid;
  try {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore", detached: process.platform !== "win32" });
    pid = child.pid;
    await new Promise((resolve) => child.once("exit", resolve));
    assert.equal(defaultProbeRun(pid, "win32"), "unknown", "a gone leader is never verifiably exited on win32");
    if (process.platform !== "win32") assert.equal(defaultProbeRun(pid), "exited", "a fully dead detached group is exited on POSIX");

    const conversation = database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Recovery", provider: "codex" });
    const run = database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "orphaned" });
    database.updateRun(run.id, { status: "running", pid });
    const result = database.reconcileInterruptedRuns({ probeAlive: (candidate) => defaultProbeRun(candidate, "win32") });
    assert.equal(result.counts.unknown, 1);
    assert.equal(database.getRun(run.id).recoveryClass, "unknown");
  } finally {
    database.close();
  }
});

test("classifies a live leader as alive on platforms without owned process trees", () => {
  assert.equal(defaultProbeRun(process.pid, "win32"), "alive");
});

// Regression: reconciliation used to read pending rows before its transaction
// and update each row by identifier without rechecking status. A runtime that
// still owned the run could finish it between those operations, and the
// terminal state was then overwritten with "interrupted", forcing a bogus
// recovery decision on a completed run.
test("reconciliation never reopens a run that finished concurrently", () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    const conversation = database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Recovery", provider: "codex" });
    const run = database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "concurrently finished" });
    database.updateRun(run.id, { status: "running", pid: 4242 });
    const result = database.reconcileInterruptedRuns({
      probeAlive: () => {
        // The owning runtime finishes the run while the probe runs.
        database.updateRun(run.id, { status: "completed", finishedAt: "2026-09-21T00:00:00.000Z", exitCode: 0, pid: null });
        return "exited";
      },
    });
    assert.equal(result.count, 0, "a concurrently finished run is not reconciled");
    assert.equal(database.getRun(run.id).status, "completed");
    assert.equal(database.getRun(run.id).recoveryClass, null);
  } finally {
    database.close();
  }
});

// Regression: assistant checkpoints reuse one stable createdAt for the whole
// stream, so a plain overwrite regressed conversations.updated_at after a newer
// tool or user message advanced it, moving an active conversation down the
// sidebar and search ordering while it was still streaming.
test("message writes never move conversations.updated_at backwards", () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    // Future-offset timestamps keep every value above the conversation's real
    // creation time so MAX() comparisons are deterministic.
    const checkpointAt = new Date(Date.now() + 100_000).toISOString();
    const toolAt = new Date(Date.now() + 105_000).toISOString();
    const segmentAt = new Date(Date.now() + 110_000).toISOString();
    const conversation = database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Streaming", provider: "claude" });
    const base = { id: `${conversation.id}:1`, conversationId: conversation.id, role: "assistant", kind: "text", createdAt: checkpointAt, payload: null };
    database.upsertMessage({ ...base, body: "Partial" });
    assert.equal(database.getConversation(conversation.id).updatedAt, checkpointAt);

    // A newer tool message advances the conversation timestamp.
    database.addMessage({ id: `${conversation.id}:2`, conversationId: conversation.id, role: "assistant", kind: "tool", body: "Tool completed: run", createdAt: toolAt });
    assert.equal(database.getConversation(conversation.id).updatedAt, toolAt);

    // The next assistant checkpoint carries the older stable createdAt and
    // must not regress the newer timestamp.
    database.upsertMessage({ ...base, body: "Partial answer" });
    assert.equal(database.getConversation(conversation.id).updatedAt, toolAt, "the checkpoint must not regress updated_at");

    // A newer checkpoint still advances it.
    database.upsertMessage({ ...base, id: `${conversation.id}:3`, body: "New segment", createdAt: segmentAt });
    assert.equal(database.getConversation(conversation.id).updatedAt, segmentAt);
  } finally {
    database.close();
  }
});

// Regression (round 6 / PR convergence): the launch crash window between
// persisting 'running' state and recording the provider pid used to leave a
// no-pid interrupted run that blocked every recovery policy indefinitely. The
// crash-safe launch handshake splits this into a durable 'launching' phase
// whose rows provably never authorized the provider.
test("reconciles a launching row without a handshake record as never-started", () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    const conversation = database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Recovery", provider: "codex" });
    const run = database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "crashed while launching" });
    database.updateRun(run.id, { status: "launching", startedAt: "2026-09-21T00:00:00.000Z" });
    const result = database.reconcileInterruptedRuns();
    assert.equal(result.counts["never-started"], 1);
    const recovered = database.getRun(run.id);
    assert.equal(recovered.status, "interrupted");
    assert.equal(recovered.recoveryClass, "never-started");
    assert.equal(recovered.pid, null, "no handshake record means no process identity was ever recorded");
  } finally {
    database.close();
  }
});

test("reconciles a launching row by adopting the wrapper handshake pid as never-started", async () => {
  const database = createOutrightDatabase({ filename: ":memory:", launchDirectory: mkdtempSync(path.join(os.tmpdir(), "outright-launches-")) });
  let pid;
  try {
    const conversation = database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Recovery", provider: "codex" });
    const run = database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "crashed before authorization" });
    database.updateRun(run.id, { status: "launching", startedAt: "2026-09-21T00:00:00.000Z" });
    // The wrapper durably recorded its identity, but the runtime died before
    // committing 'running' — so the provider was never authorized to run.
    const exited = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore", detached: process.platform !== "win32" });
    pid = exited.pid;
    await new Promise((resolve) => exited.once("exit", resolve));
    mkdirSync(database.launchDirectory, { recursive: true });
    writeFileSync(path.join(database.launchDirectory, `${run.id}.json`), JSON.stringify({ pid, authorized: false, createdAt: "2026-09-21T00:00:00.000Z" }));

    const result = database.reconcileInterruptedRuns();
    assert.equal(result.counts["never-started"], 1);
    const recovered = database.getRun(run.id);
    assert.equal(recovered.status, "interrupted");
    assert.equal(recovered.recoveryClass, "never-started", "a launching row was provably never authorized, so it is never gated as an unverifiable tree");
    assert.equal(recovered.pid, pid, "the handshake pid is adopted so process ownership is not lost");
  } finally {
    database.close();
  }
});

test("records a recovery decision exactly once", () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    const conversation = database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Recovery", provider: "codex" });
    const run = database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "discarded" });
    database.reconcileInterruptedRuns();
    const discarded = database.resolveInterruptedRun(run.id, "discard");
    assert.equal(discarded.status, "failed");
    assert.match(discarded.error, /Discarded/);
    assert.equal(discarded.recoveryDecision, "discard");
    assert.equal(database.resolveInterruptedRun(run.id, "discard"), null, "the decision is final");
    assert.equal(database.resolveInterruptedRun(run.id, "resume-session"), null);
  } finally {
    database.close();
  }
});

test("recovery retry durably clears the provider session before the replacement run starts", () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    const conversation = database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Recovery", provider: "codex" });
    database.updateConversation(conversation.id, { providerSessionId: "session-old" });
    const interrupted = database.createRun({ conversationId: conversation.id, provider: "codex", model: "gpt", reasoningEffort: "high", approvalPolicy: "read-only", prompt: "retry me" });
    database.updateRun(interrupted.id, { status: "running", providerSessionId: "session-old", pid: 4242 });
    database.reconcileInterruptedRuns({ probeAlive: () => false });

    const recovery = database.beginInterruptedRunRecovery(interrupted.id, "retry");
    assert.equal(recovery.interrupted.recoveryDecision, "retry");
    assert.equal(recovery.conversation.providerSessionId, null);
    assert.equal(database.getConversation(conversation.id).providerSessionId, null);
    assert.equal(recovery.run.status, "queued");
    assert.equal(recovery.run.prompt, "retry me");
    assert.equal(database.beginInterruptedRunRecovery(interrupted.id, "retry"), null, "recovery is idempotent");
  } finally {
    database.close();
  }
});

test("upserts partial transcript checkpoints and commits the final checkpoint with run state", () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    const conversation = database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Recovery", provider: "claude" });
    const run = database.createRun({ conversationId: conversation.id, provider: "claude", approvalPolicy: "read-only", prompt: "stream" });
    const base = { id: `${run.id}:1`, conversationId: conversation.id, role: "assistant", kind: "text", createdAt: "2026-09-21T00:00:00.000Z", payload: { runId: run.id, provider: "claude" } };
    database.upsertMessage({ ...base, body: "Partial" });
    database.upsertMessage({ ...base, body: "Partial answer" });
    assert.deepEqual(database.listMessages(conversation.id).map((message) => message.body), ["Partial answer"]);

    database.finishRun(run.id, { status: "completed", finishedAt: "2026-09-21T00:00:01.000Z", exitCode: 0, pid: null }, { ...base, body: "Partial answer complete" });
    assert.equal(database.getRun(run.id).status, "completed");
    assert.deepEqual(database.listMessages(conversation.id).map((message) => message.body), ["Partial answer complete"]);
  } finally {
    database.close();
  }
});

test("tracks trust and audit records", () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    database.trustProject("project-1", "/tmp/project-1");
    assert.equal(database.isProjectTrusted("project-1", "/tmp/project-1"), true);
    assert.equal(database.isProjectTrusted("project-1", "/tmp/moved"), false);
    database.audit("git.stage", { target: "/tmp/project-1", files: ["README.md"] });
    assert.deepEqual(database.listAudit(1)[0].details.files, ["README.md"]);
  } finally {
    database.close();
  }
});

test("rejects unknown and unsafe settings without partially applying the patch", () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    assert.throws(() => database.updateSettings({ maxConcurrentRuns: 0 }), /Invalid value for setting: maxConcurrentRuns/);
    assert.throws(() => database.updateSettings({ provider: "unknown" }), /Invalid value for setting: provider/);
    assert.throws(() => database.updateSettings({ provider: "claude", unexpected: true }), /Unknown setting: unexpected/);
    assert.equal(database.getSettings().provider, "codex");
    assert.equal(database.getSettings().maxConcurrentRuns, 3);
  } finally {
    database.close();
  }
});

test("pages messages newest-first at the boundary while returning each page chronologically", () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    const conversation = database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "History", provider: "codex" });
    for (let index = 1; index <= 5; index += 1) {
      database.addMessage({ id: `message-${index}`, conversationId: conversation.id, role: index % 2 ? "user" : "assistant", body: `Message ${index}` });
    }

    const latest = database.listMessagePage(conversation.id, { limit: 2 });
    assert.deepEqual(latest.messages.map((message) => message.id), ["message-4", "message-5"]);
    assert.deepEqual(latest.page, { hasMore: true, olderCount: 3, total: 5, beforeId: "message-4", limit: 2 });

    const middle = database.listMessagePage(conversation.id, { beforeId: latest.page.beforeId, limit: 2 });
    assert.deepEqual(middle.messages.map((message) => message.id), ["message-2", "message-3"]);
    assert.equal(middle.page.hasMore, true);
    assert.equal(middle.page.olderCount, 1);

    const oldest = database.listMessagePage(conversation.id, { beforeId: middle.page.beforeId, limit: 2 });
    assert.deepEqual(oldest.messages.map((message) => message.id), ["message-1"]);
    assert.equal(oldest.page.hasMore, false);
    assert.equal(oldest.page.olderCount, 0);
    assert.throws(() => database.listMessagePage(conversation.id, { beforeId: "missing" }), /Message cursor was not found/);
  } finally {
    database.close();
  }
});

test("bounds retained and returned run event history", () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    const conversation = database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Events", provider: "codex" });
    const run = database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "Observe" });
    for (let index = 1; index <= 2_005; index += 1) database.appendRunEvent(run.id, "provider.event", { index });
    const events = database.listRunEvents(run.id);
    assert.equal(events.length, 2_000);
    assert.equal(events[0].seq, 6);
    assert.equal(events.at(-1).seq, 2_005);
  } finally {
    database.close();
  }
});

test("bounds oversized run event payloads before storage and publication", () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    const conversation = database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Events", provider: "codex" });
    const run = database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "Observe" });
    const event = database.appendRunEvent(run.id, "provider.event", { text: "x".repeat(400 * 1024) });
    assert.equal(event.payload.truncated, true);
    assert.ok(event.payload.originalBytes > 400 * 1024);
    assert.ok(Buffer.byteLength(JSON.stringify(event.payload)) <= 256 * 1024);
    assert.deepEqual(database.listRunEvents(run.id)[0].payload, event.payload);
  } finally {
    database.close();
  }
});
