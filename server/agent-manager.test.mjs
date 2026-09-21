import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { buildProviderCommand, consumeBoundedLines, createAgentManager, LAUNCH_WRAPPER_SOURCE, normalizeClaude, normalizeCodex, processGroupAlive, terminateTree } from "./agent-manager.mjs";

const conversation = { worktreePath: "/tmp/project", providerSessionId: null };

function fakeChild() {
  const child = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.signals = [];
  child.kill = (signal) => { child.signals.push(signal); return true; };
  return child;
}

function fakeDatabase(initialConversation = { id: "conv-1", worktreePath: "/tmp/project" }) {
  const messages = [];
  const finishes = [];
  const runs = new Map();
  const conversations = new Map([[initialConversation.id, initialConversation]]);
  return {
    messages,
    finishes,
    runs,
    getSettings: () => ({ maxConcurrentRuns: 8 }),
    getConversation: (id) => conversations.get(id),
    updateConversation: (id, patch) => conversations.set(id, { ...conversations.get(id), ...patch }),
    getRun: (id) => runs.get(id) ?? null,
    createRun: (run) => { runs.set(run.id, run); return run; },
    updateRun: (id, patch) => { runs.set(id, { ...runs.get(id), ...patch }); return runs.get(id); },
    addMessage: (input) => { messages.push(input); return input; },
    upsertMessage: (input) => {
      const index = messages.findIndex((message) => message.id === input.id);
      if (index >= 0) messages[index] = { ...messages[index], ...input };
      else messages.push(input);
      return messages[index >= 0 ? index : messages.length - 1];
    },
    finishRun: (id, patch, transcriptMessage) => {
      const message = transcriptMessage ? (() => {
        const index = messages.findIndex((item) => item.id === transcriptMessage.id);
        if (index >= 0) messages[index] = { ...messages[index], ...transcriptMessage };
        else messages.push(transcriptMessage);
        return messages[index >= 0 ? index : messages.length - 1];
      })() : null;
      runs.set(id, { ...runs.get(id), ...patch });
      finishes.push({ id, patch, transcriptMessage });
      return { run: runs.get(id), message };
    },
    appendRunEvent: (runId, type, payload) => ({ id: messages.length + 1, runId, seq: 1, type, payload, createdAt: "" }),
    audit: () => {},
  };
}

function codexRun(id) {
  return { id, conversationId: "conv-1", provider: "codex", prompt: "prompt", approvalPolicy: "read-only" };
}

test("builds sandboxed provider commands with model and reasoning settings", () => {
  const codex = buildProviderCommand(conversation, { provider: "codex", model: "gpt-5.4", reasoningEffort: "high", approvalPolicy: "read-only", prompt: "Review" });
  assert.deepEqual(codex.args.slice(0, 6), ["exec", "--json", "-C", "/tmp/project", "--sandbox", "read-only"]);
  assert.ok(codex.args.includes("model_reasoning_effort=\"high\""));

  const claude = buildProviderCommand(conversation, { provider: "claude", model: "sonnet", reasoningEffort: "xhigh", approvalPolicy: "workspace-write", prompt: "Implement" });
  assert.ok(claude.args.includes("acceptEdits"));
  assert.deepEqual(claude.args.slice(claude.args.indexOf("--effort"), claude.args.indexOf("--effort") + 2), ["--effort", "xhigh"]);
});

test("keeps the selected sandbox policy when resuming Codex sessions", () => {
  const resumedConversation = { ...conversation, providerSessionId: "session-1" };
  const readOnly = buildProviderCommand(resumedConversation, { provider: "codex", reasoningEffort: "medium", approvalPolicy: "read-only", prompt: "Review" });
  assert.ok(readOnly.args.includes('sandbox_mode="read-only"'));
  assert.equal(readOnly.args.includes("--dangerously-bypass-approvals-and-sandbox"), false);

  const workspaceWrite = buildProviderCommand(resumedConversation, { provider: "codex", reasoningEffort: "medium", approvalPolicy: "workspace-write", prompt: "Implement" });
  assert.ok(workspaceWrite.args.includes('sandbox_mode="workspace-write"'));

  const fullAccess = buildProviderCommand(resumedConversation, { provider: "codex", reasoningEffort: "medium", approvalPolicy: "danger-full-access", prompt: "Run" });
  assert.ok(fullAccess.args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.equal(fullAccess.args.some((argument) => argument.startsWith("sandbox_mode=")), false);
});

test("normalizes Codex and Claude streaming records", () => {
  assert.deepEqual(normalizeCodex({ type: "thread.started", thread_id: "thread-1" })[0], { type: "session", payload: { sessionId: "thread-1" } });
  assert.deepEqual(normalizeCodex({ type: "item.completed", item: { type: "agent_message", text: "done" } })[0], { type: "assistant.message", payload: { text: "done" } });
  assert.deepEqual(normalizeClaude({ type: "stream_event", event: { delta: { type: "text_delta", text: "hello" } } })[0], { type: "assistant.delta", payload: { text: "hello" } });
  assert.equal(normalizeClaude({ type: "result", result: "finished", total_cost_usd: 0.01, usage: { input_tokens: 2, output_tokens: 3 } }).at(-1).payload.costUsd, 0.01);
});

test("discards oversized provider lines and resumes at the next record", async () => {
  const stream = new PassThrough();
  const lines = [];
  let overflows = 0;
  consumeBoundedLines(stream, { maxLineBytes: 12, onLine: (line) => lines.push(line), onOverflow: () => { overflows += 1; } });
  stream.write("first\nway-too-");
  stream.write("large-line\nvalid\nlast");
  stream.end();
  await new Promise((resolve) => stream.once("end", resolve));
  assert.deepEqual(lines, ["first", "valid", "last"]);
  assert.equal(overflows, 1);
});

test("serializes runs per conversation even with free global capacity", async () => {
  const database = fakeDatabase();
  const published = [];
  const children = [];
  const manager = createAgentManager({ database, publish: (event) => published.push(event), spawnProcess: () => { const child = fakeChild(); children.push(child); return child; } });

  database.createRun(codexRun("run-1"));
  database.createRun(codexRun("run-2"));
  await manager.schedule({ conversation: { id: "conv-1", worktreePath: "/tmp/project" }, run: database.getRun("run-1") });
  await manager.schedule({ conversation: { id: "conv-1", worktreePath: "/tmp/project" }, run: database.getRun("run-2") });
  assert.equal(manager.activeRuns().length, 1);
  assert.equal(children.length, 1);

  children[0].emit("close", 0, null);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(manager.activeRuns(), ["run-2"]);
  assert.equal(children.length, 2);
});

test("persists ordered transcript items instead of one accumulated answer", async () => {
  const database = fakeDatabase();
  const child = fakeChild();
  const manager = createAgentManager({ database, publish: () => {}, spawnProcess: () => child });
  database.createRun(codexRun("run-1"));
  await manager.schedule({ conversation: { id: "conv-1", worktreePath: "/tmp/project" }, run: database.getRun("run-1") });

  child.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "First update" } }) + "\n");
  child.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "ls -la" } }) + "\n");
  child.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Final answer" } }) + "\n");
  child.emit("close", 0, null);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(database.messages.map((message) => message.body), ["First update", "Tool completed: ls -la", "Final answer"]);
  assert.deepEqual(database.messages.map((message) => message.kind), ["text", "tool", "text"]);
});

test("persists partial transcript output before the provider exits", async () => {
  const database = fakeDatabase();
  const child = fakeChild();
  const manager = createAgentManager({ database, publish: () => {}, spawnProcess: () => child });
  database.createRun(codexRun("run-1"));
  await manager.schedule({ conversation: { id: "conv-1", worktreePath: "/tmp/project" }, run: database.getRun("run-1") });
  child.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Partial answer" } }) + "\n");
  // The run is still active, yet the completed segment is already durable.
  assert.deepEqual(database.messages.map((message) => message.body), ["Partial answer"]);
  assert.deepEqual(manager.activeRuns(), ["run-1"]);
});

test("checkpoints Claude delta-only output durably without duplicating it", async () => {
  const database = fakeDatabase();
  const child = fakeChild();
  const manager = createAgentManager({ database, publish: () => {}, spawnProcess: () => child });
  database.createRun({ ...codexRun("run-1"), provider: "claude" });
  await manager.schedule({ conversation: { id: "conv-1", worktreePath: "/tmp/project" }, run: database.getRun("run-1") });

  child.stdout.write(JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text: "Partial" } } }) + "\n");
  // The first delta of a segment flushes immediately, so a crash right after a
  // stream starts still leaves a durable, inspectable checkpoint.
  assert.equal(database.messages.length, 1);
  assert.equal(database.messages[0].body, "Partial");
  assert.equal(database.messages[0].id, "run-1:1");

  // Small follow-up deltas coalesce instead of rewriting the transcript, and
  // a byte-bounded batch flushes one updated checkpoint under the same id.
  child.stdout.write(JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text: " answer" } } }) + "\n");
  child.stdout.write(JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text: ` ${"x".repeat(8192)}` } } }) + "\n");

  assert.equal(database.messages.length, 1);
  assert.equal(database.messages[0].id, "run-1:1");
  assert.equal(database.messages[0].body, `Partial answer ${"x".repeat(8192)}`);
  assert.deepEqual(manager.activeRuns(), ["run-1"]);
});

test("bounds checkpoint writes and write amplification for high-delta streams", async () => {
  const database = fakeDatabase();
  const upserts = [];
  const originalUpsert = database.upsertMessage.bind(database);
  database.upsertMessage = (input) => { upserts.push(input); return originalUpsert(input); };
  const child = fakeChild();
  const manager = createAgentManager({ database, publish: () => {}, spawnProcess: () => child, checkpointMinBytes: 4096, checkpointIntervalMs: 500 });
  database.createRun({ ...codexRun("run-1"), provider: "claude" });
  await manager.schedule({ conversation: { id: "conv-1", worktreePath: "/tmp/project" }, run: database.getRun("run-1") });

  const deltas = 10_000;
  const chunk = "x".repeat(100);
  for (let index = 0; index < deltas; index += 1) {
    child.stdout.write(JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text: chunk } } }) + "\n");
  }
  child.emit("close", 0, null);
  await new Promise((resolve) => setTimeout(resolve, 0));

  const totalBytes = deltas * 100;
  const writtenBytes = upserts.reduce((sum, message) => sum + Buffer.byteLength(message.body), 0);
  // One write per ~4 KiB of new stream bytes (plus the first flush), never
  // one per delta; cumulative rewritten bytes stay bounded, not quadratic
  // per token.
  assert.ok(upserts.length <= 400, `expected at most 400 checkpoint writes, got ${upserts.length}`);
  assert.ok(writtenBytes <= 192 * 1024 * 1024, `expected bounded cumulative writes, got ${writtenBytes}`);
  // Exact-once final content: the terminal commit lands on the same message id.
  assert.equal(database.messages.length, 1);
  assert.equal(database.messages[0].id, "run-1:1");
  assert.equal(Buffer.byteLength(database.messages[0].body), totalBytes);
  assert.equal(database.getRun("run-1").status, "completed");
});

test("flushes a stalled sub-threshold delta tail after the checkpoint interval", async () => {
  const database = fakeDatabase();
  const child = fakeChild();
  const manager = createAgentManager({ database, publish: () => {}, spawnProcess: () => child, checkpointMinBytes: 4096, checkpointIntervalMs: 50 });
  database.createRun({ ...codexRun("run-1"), provider: "claude" });
  await manager.schedule({ conversation: { id: "conv-1", worktreePath: "/tmp/project" }, run: database.getRun("run-1") });

  child.stdout.write(JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text: "first" } } }) + "\n");
  assert.equal(database.messages.length, 1);
  assert.equal(database.messages[0].body, "first");

  // A sub-threshold tail with no further deltas must still become durable
  // within the checkpoint interval via the coalescing timer, not only when
  // the next delta happens to arrive.
  child.stdout.write(JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text: " second" } } }) + "\n");
  assert.equal(database.messages[0].body, "first", "the tail coalesces in memory first");
  // Poll with a deadline instead of a fixed sleep so CPU contention cannot
  // flake the 50 ms coalescing-timer assertion.
  const deadline = Date.now() + 1000;
  while (database.messages[0].body !== "first second" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(database.messages.length, 1);
  assert.equal(database.messages[0].body, "first second");
  assert.equal(database.messages[0].id, "run-1:1");
  assert.deepEqual(manager.activeRuns(), ["run-1"]);
  child.emit("close", 0, null);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(database.getRun("run-1").status, "completed");
});

test("stops checkpoint rewrites after the transcript cap is durably flushed", async () => {
  const database = fakeDatabase();
  const upserts = [];
  const originalUpsert = database.upsertMessage.bind(database);
  database.upsertMessage = (input) => { upserts.push(input); return originalUpsert(input); };
  const child = fakeChild();
  const manager = createAgentManager({ database, publish: () => {}, spawnProcess: () => child, checkpointMinBytes: 4096, checkpointIntervalMs: 500 });
  database.createRun({ ...codexRun("run-1"), provider: "claude" });
  await manager.schedule({ conversation: { id: "conv-1", worktreePath: "/tmp/project" }, run: database.getRun("run-1") });

  // Stream well past the 1 MiB transcript cap: discarded deltas after the cap
  // must not keep rewriting the capped body.
  const chunk = "x".repeat(100);
  const totalDeltas = 20_000; // 2,000,000 stream bytes vs a 1 MiB cap
  let cappedAtIndex = -1;
  let streamBytes = 0;
  for (let index = 0; index < totalDeltas; index += 1) {
    child.stdout.write(JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text: chunk } } }) + "\n");
    streamBytes += chunk.length;
    if (cappedAtIndex < 0 && streamBytes > 1024 * 1024) cappedAtIndex = upserts.length;
  }
  child.emit("close", 0, null);
  await new Promise((resolve) => setTimeout(resolve, 0));

  const postCapUpserts = upserts.length - cappedAtIndex;
  const writtenBytes = upserts.reduce((sum, message) => sum + Buffer.byteLength(message.body), 0);
  assert.ok(postCapUpserts <= 1, `expected at most one post-cap checkpoint write, got ${postCapUpserts}`);
  assert.ok(writtenBytes <= 192 * 1024 * 1024, `expected bounded cumulative writes, got ${writtenBytes}`);
  // Exact-once final content: the capped body plus the truncation marker.
  assert.equal(database.messages.length, 1);
  assert.equal(database.messages[0].id, "run-1:1");
  assert.ok(database.messages[0].body.endsWith("[Output truncated by Outright at 1 MiB]"));
  assert.ok(Buffer.byteLength(database.messages[0].body) <= 1024 * 1024 + Buffer.byteLength("\n\n[Output truncated by Outright at 1 MiB]"));
  assert.equal(database.getRun("run-1").status, "completed");
});

test("commits the final transcript checkpoint with terminal run state", async () => {
  const database = fakeDatabase();
  const child = fakeChild();
  const manager = createAgentManager({ database, publish: () => {}, spawnProcess: () => child });
  database.createRun({ ...codexRun("run-1"), provider: "claude" });
  await manager.schedule({ conversation: { id: "conv-1", worktreePath: "/tmp/project" }, run: database.getRun("run-1") });
  child.stdout.write(JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text: "Final segment" } } }) + "\n");
  child.emit("close", 0, null);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(database.finishes.length, 1);
  assert.equal(database.finishes[0].transcriptMessage.body, "Final segment");
  assert.equal(database.getRun("run-1").status, "completed");
  assert.deepEqual(database.messages.map((message) => message.body), ["Final segment"]);
});

// Regression: checkpoints used to trim the assembled body before persisting,
// so a crash after a checkpoint recovered altered text — leading indentation
// and partial trailing whitespace were irreversibly lost.
test("persists streamed assistant edge whitespace exactly at checkpoints", async () => {
  const database = fakeDatabase();
  const child = fakeChild();
  const manager = createAgentManager({ database, publish: () => {}, spawnProcess: () => child });
  database.createRun({ ...codexRun("run-1"), provider: "claude" });
  await manager.schedule({ conversation: { id: "conv-1", worktreePath: "/tmp/project" }, run: database.getRun("run-1") });

  child.stdout.write(JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text: "  indented start\n" } } }) + "\n");
  // The first delta of a segment flushes immediately, so this checkpoint is
  // exactly what a restart would recover.
  assert.equal(database.messages.length, 1);
  assert.equal(database.messages[0].body, "  indented start\n", "the checkpoint must preserve leading indentation and the trailing newline");

  child.stdout.write(JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text: "tail " } } }) + "\n");
  child.emit("close", 0, null);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(database.getRun("run-1").status, "completed");
  assert.equal(database.messages[0].body, "  indented start\ntail ", "the final commit must preserve the partial trailing space");
});

// Regression (PR remediation round 2): after the trim removal, a body of pure
// whitespace (stray "\n\n" deltas between tool calls) was persisted and
// recovered as an empty-looking transcript bubble. Only entirely-whitespace
// bodies are suppressed; text-bearing content is stored byte-for-byte.
test("suppresses a whitespace-only assistant body without trimming text", async () => {
  const database = fakeDatabase();
  const child = fakeChild();
  const manager = createAgentManager({ database, publish: () => {}, spawnProcess: () => child });
  database.createRun({ ...codexRun("run-1"), provider: "claude" });
  await manager.schedule({ conversation: { id: "conv-1", worktreePath: "/tmp/project" }, run: database.getRun("run-1") });

  child.stdout.write(JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text: "\n\n" } } }) + "\n");
  child.emit("close", 0, null);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(database.messages, [], "an entirely-whitespace body is not persisted as a transcript message");
  assert.equal(database.getRun("run-1").status, "completed");
});

test("records the provider pid while running and clears it at finish", async () => {
  const database = fakeDatabase();
  const child = fakeChild();
  child.pid = 4321;
  const manager = createAgentManager({ database, publish: () => {}, spawnProcess: () => child });
  database.createRun(codexRun("run-1"));
  await manager.schedule({ conversation: { id: "conv-1", worktreePath: "/tmp/project" }, run: database.getRun("run-1") });
  assert.equal(database.getRun("run-1").pid, 4321);
  child.emit("close", 0, null);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(database.getRun("run-1").pid, null);
});

test("stop signals the process tree and resolves after termination", async () => {
  const database = fakeDatabase();
  const child = fakeChild();
  const manager = createAgentManager({ database, publish: () => {}, spawnProcess: () => child });
  database.createRun(codexRun("run-1"));
  await manager.schedule({ conversation: { id: "conv-1", worktreePath: "/tmp/project" }, run: database.getRun("run-1") });

  const stopping = manager.stop("run-1");
  assert.deepEqual(child.signals, ["SIGTERM"]);
  child.emit("close", 137, "SIGTERM");
  assert.equal(await stopping, true);
  assert.equal(database.getRun("run-1").status, "stopped");
});

const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

for (const change of ["move", "revoke", "mismatch"]) {
  test(`queued runs revalidate execution authorization after ${change}`, async () => {
    const database = fakeDatabase({ id: "conv-1", projectId: "A", worktreeId: "A", worktreePath: "/tmp/A" });
    let trusted = true;
    const children = [];
    const manager = createAgentManager({
      database, publish: () => {},
      validateConversation: async (target) => {
        if (target.projectId !== "A" || target.worktreePath !== "/tmp/A") throw new Error("Invalid worktree identity");
        return () => { if (!trusted) throw new Error("Project trust is required"); };
      },
      spawnProcess: () => { const child = fakeChild(); children.push(child); return child; },
    });
    for (const id of ["first", "queued"]) {
      const run = database.createRun(codexRun(id));
      await manager.schedule({ conversation: database.getConversation("conv-1"), run });
    }
    if (change === "revoke") trusted = false;
    else database.updateConversation("conv-1", change === "move" ? { projectId: "B", worktreeId: "B", worktreePath: "/tmp/B" } : { worktreePath: "/tmp/B" });
    children[0].emit("close", 0, null);
    await turn();
    assert.equal(children.length, 1, "the queued run must not spawn");
    assert.equal(database.getRun("queued").status, "failed");
    assert.match(database.getRun("queued").error, /trust|identity/);
    assert.deepEqual(manager.activeRuns(), []);
  });
}

test("validation reserves capacity and cancellation prevents a late spawn", async () => {
  const database = fakeDatabase();
  database.getSettings = () => ({ maxConcurrentRuns: 1 });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let spawns = 0;
  const manager = createAgentManager({ database, publish: () => {}, validateConversation: () => gate, spawnProcess: () => { spawns++; return fakeChild(); } });
  const run = database.createRun(codexRun("pending"));
  const scheduling = manager.schedule({ conversation: database.getConversation("conv-1"), run });
  assert.deepEqual(manager.activeRuns(), ["pending"]);
  const stopping = manager.stop(run.id);
  release();
  await Promise.all([scheduling, stopping]);
  assert.equal(spawns, 0);
  assert.equal(database.getRun(run.id).status, "stopped");
});

test("a target moved during asynchronous validation never spawns", async () => {
  const database = fakeDatabase();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let spawns = 0;
  const manager = createAgentManager({ database, publish: () => {}, validateConversation: () => gate, spawnProcess: () => { spawns++; return fakeChild(); } });
  const run = database.createRun(codexRun("pending"));
  const scheduling = manager.schedule({ conversation: database.getConversation("conv-1"), run });
  database.updateConversation("conv-1", { worktreePath: "/tmp/changed" });
  release();
  await scheduling;
  assert.equal(spawns, 0);
  assert.equal(database.getRun(run.id).status, "failed");
  assert.match(database.getRun(run.id).error, /target changed/);
});

for (const action of ["stop", "shutdown"]) {
  test(`${action} waits for a descendant that ignores SIGTERM`, { skip: process.platform === "win32", timeout: 10000 }, async (t) => {
    const database = fakeDatabase();
    let child;
    const manager = createAgentManager({
      database, publish: () => {}, terminationGraceMs: 150, terminationTimeoutMs: 5000,
      spawnProcess: () => {
        const descendant = `process.on("SIGTERM", () => {}); process.send("ready"); setInterval(() => {}, 1000);`;
        const parent = `const {spawn} = require("node:child_process"); const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], {stdio:["ignore","ignore","ignore","ipc"]}); child.once("message", () => process.stdout.write("ready\\n")); setInterval(() => {}, 1000);`;
        child = spawn(process.execPath, ["-e", parent], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
        return child;
      },
    });
    t.after(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} });
    const run = database.createRun(codexRun("tree"));
    await manager.schedule({ conversation: database.getConversation("conv-1"), run });
    await once(child.stdout, "data");
    let resolved = false;
    const stopping = (action === "stop" ? manager.stop(run.id) : manager.shutdown()).then(() => { resolved = true; });
    await once(child, "close");
    assert.equal(resolved, false, "provider close is not process-tree completion");
    assert.equal(database.getRun(run.id).status, "running");
    assert.doesNotThrow(() => process.kill(-child.pid, 0));
    await stopping;
    assert.equal(database.getRun(run.id).status, "stopped");
    assert.throws(() => process.kill(-child.pid, 0), { code: "ESRCH" });
    assert.deepEqual(manager.activeRuns(), []);
  });
}

test("a recovery retry explicitly starts a fresh provider session", async () => {
  const database = fakeDatabase({ id: "conv-1", worktreePath: "/tmp/project", providerSessionId: "session-9" });
  const spawnedArgs = [];
  const child = fakeChild();
  const manager = createAgentManager({
    database, publish: () => {},
    // Inspect the provider command directly; the default launch command wraps
    // it in the crash-safe launch wrapper.
    launchCommand: (command) => ({ ...command }),
    spawnProcess: (executable, args) => { spawnedArgs.push(args); return child; },
  });
  const run = database.createRun(codexRun("run-1"));
  await manager.schedule({ conversation: database.getConversation("conv-1"), run, forceFreshSession: true });
  assert.deepEqual(spawnedArgs[0].slice(0, 2), ["exec", "--json"]);
  assert.equal(spawnedArgs[0].includes("resume"), false);
  child.emit("close", 0, null);
});

test("a termination timeout retains ownership and does not drain queued work", async () => {
  const database = fakeDatabase();
  const child = fakeChild();
  let spawns = 0;
  const manager = createAgentManager({ database, publish: () => {}, terminationGraceMs: 0, terminationTimeoutMs: 40, spawnProcess: () => { spawns++; return child; } });
  for (const id of ["running", "queued"]) await manager.schedule({ conversation: database.getConversation("conv-1"), run: database.createRun(codexRun(id)) });
  await assert.rejects(manager.stop("running"), /did not terminate/);
  assert.equal(database.getRun("running").status, "running");
  assert.deepEqual(manager.activeRuns(), ["running"]);
  assert.equal(spawns, 1);
  await manager.stop("queued");
  child.emit("close", 137, "SIGKILL");
  assert.equal(await manager.stop("running"), true);
  assert.deepEqual(manager.activeRuns(), []);
});

// The crash-safe launch handshake: the run row reaches 'launching' before any
// spawn and 'running' with a durable pid before the provider is authorized,
// so every crash window reconciles to a provable state.
test("launch phases are durable before the provider is authorized", async () => {
  const database = fakeDatabase();
  // A single ordered event log proves the sequencing itself: a regression
  // that authorizes before the durable 'running' commit (the core crash-window
  // invariant) reorders entries here, which separate after-the-fact arrays
  // could never detect.
  const events = [];
  const originalUpdate = database.updateRun.bind(database);
  database.updateRun = (id, patch) => {
    if (patch.status) events.push(`update:${patch.status}`);
    return originalUpdate(id, patch);
  };
  const child = fakeChild();
  child.stdin = new PassThrough();
  const originalWrite = child.stdin.write.bind(child.stdin);
  child.stdin.write = (chunk) => { events.push(`authorize:${String(chunk).trim()}`); return originalWrite(chunk); };
  const manager = createAgentManager({ database, publish: () => {}, spawnProcess: () => { events.push("spawn"); return child; } });
  await manager.schedule({ conversation: { id: "conv-1", worktreePath: "/tmp/project" }, run: database.createRun(codexRun("run-1")) });

  assert.deepEqual(events, [
    "update:launching", // durable "possibly started" marker, before the spawn
    "spawn",             // spawnProcess is called with the marker committed
    "update:running",    // durable pid + running commit, before authorization
    "authorize:go",      // only now may the provider start side effects
  ], "the launch handshake must commit each phase before the next step");
  child.emit("close", 0, null);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(database.getRun("run-1").status, "completed");
});

// Regression (platform-injectable): on Windows there is no owned process
// group, so stopping a run must tear down the wrapper's whole tree via the
// tree-aware taskkill mechanism instead of signaling only the leader.
test("windows termination tears down the provider tree with taskkill", () => {
  const calls = [];
  const run = (executable, args) => { calls.push([executable, ...args]); return { status: 0 }; };
  const child = { pid: 4242 };
  terminateTree(child, "SIGTERM", "win32", run);
  assert.deepEqual(calls, [["taskkill", "/PID", "4242", "/T", "/F"]], "the whole wrapper tree is terminated, not just the leader");

  // POSIX still signals the owned process group; a pid-less child falls back
  // to child.kill so injected fakes keep working.
  const signals = [];
  const fake = { pid: 99, kill: (signal) => signals.push(signal) };
  terminateTree(fake, "SIGTERM", "linux", run);
  assert.deepEqual(calls, [["taskkill", "/PID", "4242", "/T", "/F"]], "POSIX never shells out to taskkill");
  assert.deepEqual(signals, []);
  const pidLess = { kill: (signal) => signals.push(signal) };
  terminateTree(pidLess, "SIGTERM", "linux", run);
  assert.deepEqual(signals, ["SIGTERM"], "a pid-less child falls back to child.kill");
});

// The real launch wrapper must durably record its own pid and only start the
// provider after the runtime's authorization byte.
test("the launch wrapper records durable identity before authorization and cleans up on exit", { timeout: 20000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-launch-"));
  const launchDirectory = path.join(root, "launches");
  const marker = path.join(root, "provider-ran");
  const runId = "launch-run";
  const handshakePath = path.join(launchDirectory, `${runId}.json`);
  const provider = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");`;
  const children = [];
  // Fail fast with cleanup instead of hanging until the suite timeout leaks
  // processes and temp directories.
  const withDeadline = async (promise, label, kill = () => {}) => {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), 5000); }),
      ]);
    } finally { clearTimeout(timer); kill(); }
  };
  try {
    // Spawn the wrapper exactly as the runtime does, but never authorize:
    // closing stdin must exit it without running the provider.
    const child = spawn(process.execPath, ["-e", LAUNCH_WRAPPER_SOURCE, handshakePath, process.execPath, "-e", provider], { stdio: ["pipe", "ignore", "ignore"] });
    children.push(child);
    const deadline = Date.now() + 10_000;
    while (!existsSync(handshakePath) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    const record = JSON.parse(readFileSync(handshakePath, "utf8"));
    assert.equal(record.pid, child.pid, "the wrapper records its own pid durably before anything can execute");
    assert.equal(record.authorized, false);

    child.stdin.end();
    await withDeadline(new Promise((resolve) => child.once("exit", resolve)), "unauthorized wrapper exit", () => { try { child.kill("SIGKILL"); } catch {} });
    assert.equal(existsSync(marker), false, "an unauthorized wrapper must never start the provider");
    assert.equal(existsSync(handshakePath), false, "the wrapper removes its handshake record when it exits unauthorized");

    // Authorized: the same wrapper starts the provider and passes the exit code.
    const marker2 = path.join(root, "provider-ran-2");
    const handshakePath2 = path.join(launchDirectory, "launch-run-2.json");
    const provider2 = `require("node:fs").writeFileSync(${JSON.stringify(marker2)}, "ran");`;
    const child2 = spawn(process.execPath, ["-e", LAUNCH_WRAPPER_SOURCE, handshakePath2, process.execPath, "-e", provider2], { stdio: ["pipe", "ignore", "ignore"] });
    children.push(child2);
    const deadline2 = Date.now() + 10_000;
    while (!existsSync(handshakePath2) && Date.now() < deadline2) await new Promise((resolve) => setTimeout(resolve, 10));
    child2.stdin.write("go\n");
    const code = await withDeadline(new Promise((resolve) => child2.once("exit", resolve)), "authorized wrapper exit", () => { try { child2.kill("SIGKILL"); } catch {} });
    assert.equal(code, 0);
    assert.equal(existsSync(marker2), true, "the authorized wrapper starts the provider");
    assert.equal(existsSync(handshakePath2), false, "the handshake record is cleaned up after completion");
  } finally {
    for (const child of children) { try { child.kill("SIGKILL"); } catch { /* Already gone. */ } }
    rmSync(root, { recursive: true, force: true });
  }
});
