import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { buildProviderCommand, consumeBoundedLines, createAgentManager, defaultGroupMembers, escalateTree, hardenWindowsLaunchDirectory, LAUNCH_AUTHORIZED_CONTROL, LAUNCH_WRAPPER_SOURCE, normalizeClaude, normalizeCodex, processGroupAlive, terminateTree } from "./agent-manager.mjs";
import { streamingTextAfterRuntimeEvent } from "../src/recovery-policy.js";

const conversation = { worktreePath: "/tmp/project", providerSessionId: null };
const fakeLaunchDirectory = mkdtempSync(path.join(os.tmpdir(), "outright-agent-test-"));
const WRAPPER_OWNERSHIP_TOKEN = "00000000-0000-4000-8000-000000000001";
const platformSupervisor = fileURLToPath(new URL(process.platform === "win32" ? "./bin/agent-supervisor.exe" : "./bin/agent-supervisor", import.meta.url));
const wrapperArgs = (handshakePath, ...providerArgs) => [
  "-e", LAUNCH_WRAPPER_SOURCE, handshakePath, WRAPPER_OWNERSHIP_TOKEN,
  process.platform === "darwin" ? `com.21n.outright.${WRAPPER_OWNERSHIP_TOKEN}` : "-",
  ...(["darwin", "win32"].includes(process.platform) ? [platformSupervisor] : []),
  ...(process.platform === "darwin" ? [`com.21n.outright.${WRAPPER_OWNERSHIP_TOKEN}`] : []),
  ...providerArgs,
];
test.after(() => rmSync(fakeLaunchDirectory, { recursive: true, force: true }));

function fakeChild({ autoAcknowledge = true } = {}) {
  const child = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.stdio = [child.stdin, child.stdout, child.stderr, new PassThrough()];
  const write = child.stdin.write.bind(child.stdin);
  child.stdin.write = (chunk, ...args) => {
    const written = write(chunk, ...args);
    if (autoAcknowledge && String(chunk).includes("go\n")) {
      queueMicrotask(() => child.stdio[3].write(`${LAUNCH_AUTHORIZED_CONTROL}\n`));
    }
    return written;
  };
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
    launchDirectory: fakeLaunchDirectory,
    messages,
    finishes,
    runs,
    getSettings: () => ({ maxConcurrentRuns: 8 }),
    getConversation: (id) => conversations.get(id),
    updateConversation: (id, patch) => conversations.set(id, { ...conversations.get(id), ...patch }),
    getRun: (id) => runs.get(id) ?? null,
    createRun: (run) => {
      const stored = { ...run, worktreePath: run.worktreePath ?? conversations.get(run.conversationId)?.worktreePath };
      runs.set(run.id, stored);
      return stored;
    },
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
    appendRunEventWithMessage: (runId, type, payload, transcriptMessage) => {
      const event = { id: messages.length + 1, runId, seq: 1, type, payload, createdAt: "" };
      const message = { ...transcriptMessage, payload: { ...transcriptMessage.payload, checkpointEventSeq: event.seq } };
      const index = messages.findIndex((item) => item.id === message.id);
      if (index >= 0) messages[index] = message;
      else messages.push(message);
      return { event, message };
    },
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

test("keeps recovered session ids run-local when the conversation switched providers", async () => {
  const database = fakeDatabase({ id: "conv-1", worktreePath: "/tmp/project", provider: "claude", providerSessionId: "claude-session" });
  const child = fakeChild();
  const manager = createAgentManager({ database, publish: () => {}, spawnProcess: () => child });
  const run = database.createRun(codexRun("run-1"));
  await manager.schedule({ conversation: database.getConversation("conv-1"), run });

  child.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "codex-session" }) + "\n");
  assert.equal(database.getRun(run.id).providerSessionId, "codex-session");
  assert.equal(database.getConversation("conv-1").providerSessionId, "claude-session");
  child.emit("close", 0, null);
});

test("handles asynchronous authorization-pipe errors without an uncaught stream error", async () => {
  const database = fakeDatabase({ id: "conv-1", worktreePath: "/tmp/project", provider: "codex" });
  const child = fakeChild();
  const manager = createAgentManager({ database, publish: () => {}, spawnProcess: () => child });
  const run = database.createRun(codexRun("run-1"));
  await manager.schedule({ conversation: database.getConversation("conv-1"), run });

  assert.doesNotThrow(() => child.stdin.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" })));
  child.emit("close", 1, null);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(database.getRun(run.id).status, "failed");
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

test("serializes runs across conversations that share a worktree", async () => {
  const database = fakeDatabase();
  database.updateConversation("conv-2", { id: "conv-2", worktreePath: "/tmp/project" });
  const children = [];
  const manager = createAgentManager({ database, publish: () => {}, spawnProcess: () => { const child = fakeChild(); children.push(child); return child; } });
  database.createRun(codexRun("run-1"));
  database.createRun({ ...codexRun("run-2"), conversationId: "conv-2" });

  await manager.schedule({ conversation: database.getConversation("conv-1"), run: database.getRun("run-1") });
  const second = manager.schedule({ conversation: database.getConversation("conv-2"), run: database.getRun("run-2") });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(manager.activeRuns(), ["run-1"]);
  assert.equal(children.length, 1, "the second worktree writer remains queued even with global capacity");

  children[0].emit("close", 0, null);
  await second;
  assert.deepEqual(manager.activeRuns(), ["run-2"]);
  assert.equal(children.length, 2);
  children[1].emit("close", 0, null);
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

test("keeps every streamed byte in exactly one durable-prefix or live-tail owner", async () => {
  const database = fakeDatabase();
  const operations = [];
  const originalUpsert = database.upsertMessage.bind(database);
  database.upsertMessage = (message) => {
    operations.push(`persist:${message.body}`);
    return originalUpsert(message);
  };
  const originalAtomicCheckpoint = database.appendRunEventWithMessage.bind(database);
  database.appendRunEventWithMessage = (runId, type, payload, message) => {
    operations.push(`persist:${message.body}`);
    return originalAtomicCheckpoint(runId, type, payload, message);
  };
  const child = fakeChild();
  const published = [];
  const manager = createAgentManager({ database, publish: (event) => {
    published.push(event);
    if (event.type === "run.event" && event.payload?.type === "assistant.delta") operations.push(`delta:${event.payload.payload.text}`);
  }, spawnProcess: () => child, checkpointMinBytes: 5, checkpointIntervalMs: 40 });
  database.createRun({ ...codexRun("run-1"), provider: "claude" });
  await manager.schedule({ conversation: { id: "conv-1", worktreePath: "/tmp/project" }, run: database.getRun("run-1") });
  published.length = 0;

  child.stdout.write(JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text: "A" } } }) + "\n");
  child.stdout.write(JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text: "bcde" } } }) + "\n");
  child.stdout.write(JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text: "f" } } }) + "\n");
  child.stdout.write(JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text: "g" } } }) + "\n");
  const timerDeadline = Date.now() + 1000;
  while (database.messages[0]?.body !== "Abcdefg" && Date.now() < timerDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(database.messages[0]?.body, "Abcdefg", "the timer advances the durable prefix");
  assert.deepEqual(operations.slice(0, 2), ["persist:A", "delta:A"], "a due checkpoint commits before its durable delta event");
  assert.equal(published.some((event) => event.type === "message.created"), false, "intermediate checkpoints do not duplicate live deltas in the UI");

  child.stdout.write(JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text: "h" } } }) + "\n");
  child.emit("close", 0, null);
  await new Promise((resolve) => setTimeout(resolve, 0));

  let durableBody = "";
  let streamingText = "";
  let expectedBody = "";
  const relevant = published.filter((event) => event.type === "message.created"
    || (event.type === "run.event" && ["assistant.delta", "assistant.message"].includes(event.payload?.type)));
  for (const event of relevant) {
    if (event.type === "run.event" && event.payload.type === "assistant.delta") {
      expectedBody += event.payload.payload.text ?? "";
    }
    if (event.type === "message.created") durableBody = event.payload.body;
    streamingText = streamingTextAfterRuntimeEvent(streamingText, event);
    assert.equal(`${durableBody}${streamingText}`, expectedBody, `assistant bytes are exact after ${event.type === "run.event" ? event.payload.type : event.type}`);
  }
  assert.equal(expectedBody, "Abcdefgh");
  assert.equal(database.messages[0].body, expectedBody, "the terminal checkpoint remains exact");
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
    assert.match(database.getRun("queued").error, /trust|identity|target changed/);
    assert.deepEqual(manager.activeRuns(), []);
  });
}

test("queued runs cannot retarget even when both worktrees independently validate", async () => {
  const database = fakeDatabase({ id: "conv-1", projectId: "A", worktreeId: "A", worktreePath: "/tmp/A" });
  database.getSettings = () => ({ maxConcurrentRuns: 1 });
  const children = [];
  const manager = createAgentManager({
    database,
    publish: () => {},
    validateConversation: async () => () => {},
    spawnProcess: () => { const child = fakeChild(); children.push(child); return child; },
  });
  const first = database.createRun(codexRun("first"));
  const queued = database.createRun(codexRun("queued"));
  await manager.schedule({ conversation: database.getConversation("conv-1"), run: first });
  await manager.schedule({ conversation: database.getConversation("conv-1"), run: queued });

  database.updateConversation("conv-1", { projectId: "B", worktreeId: "B", worktreePath: "/tmp/B" });
  children[0].emit("close", 0, null);
  await turn();

  assert.equal(children.length, 1, "the queued run never spawns in the new valid target");
  assert.equal(database.getRun("queued").worktreePath, "/tmp/A");
  assert.equal(database.getRun("queued").status, "failed");
  assert.match(database.getRun("queued").error, /target changed/);
});

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
      // This injected process is deliberately not the Linux subreaper launch,
      // so retain the generic process-group liveness and escalation contract.
      launchCommand: (command) => ({ ...command, ownsDescendants: false }),
      spawnProcess: () => {
        const descendant = `process.on("SIGTERM", () => {}); process.send("ready"); setInterval(() => {}, 1000);`;
        const parent = `const fs = require("node:fs"); const {spawn} = require("node:child_process"); const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], {stdio:["ignore","ignore","ignore","ipc"]}); fs.writeSync(3, ${JSON.stringify(`${LAUNCH_AUTHORIZED_CONTROL}\n`)}); child.once("message", () => setTimeout(() => process.stdout.write("ready\\n"), 10)); setInterval(() => {}, 1000);`;
        child = spawn(process.execPath, ["-e", parent], { detached: true, stdio: ["ignore", "pipe", "pipe", "pipe"] });
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

test("schedule waits for the launch owner to acknowledge durable authorization", async () => {
  const database = fakeDatabase();
  const child = fakeChild({ autoAcknowledge: false });
  const manager = createAgentManager({ database, publish: () => {}, spawnProcess: () => child });
  const run = database.createRun(codexRun("run-1"));
  let settled = false;
  const scheduled = manager.schedule({ conversation: database.getConversation("conv-1"), run }).then((value) => {
    settled = true;
    return value;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "a one-way go write is not proof that the launch owner authorized the provider");
  assert.equal(database.getRun(run.id).status, "running");

  child.stdio[3].write(`${LAUNCH_AUTHORIZED_CONTROL}\n`);
  await scheduled;
  assert.equal(settled, true);
  child.emit("close", 0, null);
});

test("provider stdout cannot merge with or forge launch authorization", async () => {
  const database = fakeDatabase();
  const child = fakeChild({ autoAcknowledge: false });
  const published = [];
  const manager = createAgentManager({ database, publish: (event) => published.push(event), spawnProcess: () => child });
  const run = database.createRun(codexRun("run-1"));
  let settled = false;
  const scheduled = manager.schedule({ conversation: database.getConversation("conv-1"), run }).then(() => { settled = true; });

  child.stdout.write(`provider-prefix${LAUNCH_AUTHORIZED_CONTROL}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "provider data-plane output is never accepted as launch control");
  assert.equal(published.some((event) => event.payload?.payload?.text?.includes("provider-prefix")), true, "the merged line remains ordinary provider output");

  child.stdio[3].write(`${LAUNCH_AUTHORIZED_CONTROL}\n`);
  await scheduled;
  child.emit("close", 0, null);
});

test("shutdown is bounded when authorization acknowledgement never arrives", async () => {
  const database = fakeDatabase();
  const child = fakeChild({ autoAcknowledge: false });
  const writes = [];
  const originalWrite = child.stdin.write.bind(child.stdin);
  child.stdin.write = (chunk, ...args) => {
    writes.push(String(chunk));
    const written = originalWrite(chunk, ...args);
    if (String(chunk) === "stop\n") setImmediate(() => child.emit("close", null, "SIGTERM"));
    return written;
  };
  const manager = createAgentManager({
    database,
    publish: () => {},
    spawnProcess: () => child,
    launchCommand: (command) => ({ ...command, ownsDescendants: true }),
    terminationTimeoutMs: 250,
  });
  const run = database.createRun(codexRun("run-1"));
  const scheduled = manager.schedule({ conversation: database.getConversation("conv-1"), run });
  const deadline = Date.now() + 1000;
  while (!writes.includes("go\n") && Date.now() < deadline) await new Promise((resolve) => setImmediate(resolve));

  await Promise.all([scheduled, manager.shutdown()]);
  assert.equal(writes.includes("stop\n"), true, "teardown is requested without waiting for the missing acknowledgement");
  assert.equal(database.getRun(run.id).status, "stopped");
  assert.deepEqual(manager.activeRuns(), []);
});

test("shutdown between the authorization write and owner acknowledgement still completes", async () => {
  const database = fakeDatabase();
  const child = fakeChild({ autoAcknowledge: false });
  const writes = [];
  const originalWrite = child.stdin.write.bind(child.stdin);
  child.stdin.write = (chunk, ...args) => { writes.push(String(chunk)); return originalWrite(chunk, ...args); };
  child.kill = (signal) => {
    child.signals.push(signal);
    setImmediate(() => child.emit("close", null, signal));
    return true;
  };
  const manager = createAgentManager({ database, publish: () => {}, spawnProcess: () => child, terminationTimeoutMs: 1000 });
  const run = database.createRun(codexRun("run-1"));
  const scheduled = manager.schedule({ conversation: database.getConversation("conv-1"), run });

  const deadline = Date.now() + 1000;
  while (!writes.includes("go\n") && Date.now() < deadline) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes.includes("go\n"), true, "the launch reached the unacknowledged authorization boundary");

  await Promise.all([scheduled, manager.shutdown()]);
  assert.equal(database.getRun(run.id).status, "stopped");
  assert.deepEqual(manager.activeRuns(), []);
});

test("a failed running-state commit reaps the unauthorized wrapper before releasing the run", async () => {
  const database = fakeDatabase();
  const originalUpdate = database.updateRun.bind(database);
  database.updateRun = (id, patch) => {
    if (patch.status === "running") throw new Error("simulated launch persistence failure");
    return originalUpdate(id, patch);
  };
  const child = fakeChild();
  const writes = [];
  const originalWrite = child.stdin.write.bind(child.stdin);
  child.stdin.write = (chunk) => { writes.push(String(chunk)); return originalWrite(chunk); };
  child.kill = (signal) => {
    child.signals.push(signal);
    setImmediate(() => child.emit("close", null, signal));
    return true;
  };
  const manager = createAgentManager({ database, publish: () => {}, spawnProcess: () => child, terminationTimeoutMs: 1000 });
  const run = database.createRun(codexRun("run-1"));
  await manager.schedule({ conversation: database.getConversation("conv-1"), run });

  assert.equal(writes.includes("go\n"), false, "the provider is never authorized after the durable running commit fails");
  assert.deepEqual(child.signals, ["SIGKILL"], "the unauthorized wrapper is reaped before terminalization");
  assert.equal(database.getRun(run.id).status, "failed");
  assert.deepEqual(manager.activeRuns(), []);
});

test("shutdown racing the running-state commit never authorizes the provider", async () => {
  const database = fakeDatabase();
  const child = fakeChild();
  const writes = [];
  const originalWrite = child.stdin.write.bind(child.stdin);
  child.stdin.write = (chunk) => { writes.push(String(chunk)); return originalWrite(chunk); };
  child.kill = (signal) => {
    child.signals.push(signal);
    setImmediate(() => child.emit("close", null, signal));
    return true;
  };
  let manager;
  let shutdownPromise;
  const originalUpdate = database.updateRun.bind(database);
  database.updateRun = (id, patch) => {
    const updated = originalUpdate(id, patch);
    if (patch.status === "running" && !shutdownPromise) shutdownPromise = manager.shutdown();
    return updated;
  };
  manager = createAgentManager({ database, publish: () => {}, spawnProcess: () => child, terminationTimeoutMs: 1000 });
  const run = database.createRun(codexRun("run-1"));
  await manager.schedule({ conversation: database.getConversation("conv-1"), run });
  await shutdownPromise;

  assert.equal(writes.includes("go\n"), false, "shutdown cannot authorize a provider after cancellation");
  assert.equal(database.getRun(run.id).status, "stopped");
  assert.deepEqual(manager.activeRuns(), []);
});

test("shutdown retains ownership when a closed supervisor leaves a stale handshake", async () => {
  const database = fakeDatabase();
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-stale-handshake-"));
  const handshakePath = path.join(root, "run-1.json");
  const child = fakeChild();
  child.pid = 4242;
  const originalWrite = child.stdin.write.bind(child.stdin);
  child.stdin.write = (chunk) => {
    const written = originalWrite(chunk);
    if (String(chunk) === "stop\n") setImmediate(() => child.emit("close", null, "SIGTERM"));
    return written;
  };
  try {
    const manager = createAgentManager({
      database,
      publish: () => {},
      spawnProcess: () => child,
      launchDirectory: root,
      launchCommand: (command) => ({ ...command, handshakePath, ownsDescendants: true }),
      terminationTimeoutMs: 250,
    });
    const run = database.createRun(codexRun("run-1"));
    await manager.schedule({ conversation: database.getConversation("conv-1"), run });
    writeFileSync(handshakePath, JSON.stringify({ pid: child.pid, authorized: true, processIdentity: "test:owned" }));

    await assert.rejects(manager.shutdown(), /Agent process tree did not terminate/);

    assert.equal(existsSync(handshakePath), true, "an empty process group cannot erase ancestry-based supervisor ownership");
    assert.equal(database.getRun(run.id).status, "running");
    assert.deepEqual(manager.activeRuns(), [run.id], "the run slot remains owned until the supervisor proves its complete tree is gone");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("publishes durable assistant messages before the terminal run event", async () => {
  const database = fakeDatabase();
  const child = fakeChild();
  const published = [];
  const manager = createAgentManager({ database, publish: (event) => published.push(event), spawnProcess: () => child });
  const run = database.createRun(codexRun("run-1"));
  await manager.schedule({ conversation: database.getConversation("conv-1"), run });
  child.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Durable answer" } }) + "\n");
  child.emit("close", 0, null);
  await new Promise((resolve) => setTimeout(resolve, 0));

  const messageEvents = published.filter((event) => event.type === "message.created" && event.payload?.id === "run-1:1");
  assert.ok(messageEvents.length >= 1, "the persisted assistant message is published");
  const lastMessageIndex = published.findLastIndex((event) => event.type === "message.created" && event.payload?.id === "run-1:1");
  const terminalIndex = published.findIndex((event) => event.type === "run.event" && event.payload?.type === "run.completed");
  assert.ok(lastMessageIndex >= 0 && lastMessageIndex < terminalIndex, "the final durable message is visible before completion");
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
  const kills = [];
  const fake = { pid: 99, kill: (signal) => signals.push(signal) };
  terminateTree(fake, "SIGTERM", "linux", run, (pid, signal) => kills.push([pid, signal]));
  assert.deepEqual(calls, [["taskkill", "/PID", "4242", "/T", "/F"]], "POSIX never shells out to taskkill");
  assert.deepEqual(signals, []);
  assert.deepEqual(kills, [[-99, "SIGTERM"]], "POSIX signals only the injected owned group");
  const pidLess = { kill: (signal) => signals.push(signal) };
  terminateTree(pidLess, "SIGTERM", "linux", run);
  assert.deepEqual(signals, ["SIGTERM"], "a pid-less child falls back to child.kill");
});

test("windows launch ACLs remove inherited broad access before handshakes are written", () => {
  const calls = [];
  hardenWindowsLaunchDirectory("C:\\Users\\owner\\AppData\\Local\\Outright\\launches", (...args) => {
    calls.push(args);
    return { status: 0 };
  }, { USERDOMAIN: "WORKSTATION", USERNAME: "owner" });
  assert.deepEqual(calls, [[
    "icacls",
    [
      "C:\\Users\\owner\\AppData\\Local\\Outright\\launches",
      "/inheritance:r",
      "/grant:r",
      "WORKSTATION\\owner:(OI)(CI)F",
      "*S-1-5-18:(OI)(CI)F",
      "*S-1-5-32-544:(OI)(CI)F",
      "/remove:g",
      "*S-1-1-0",
      "*S-1-5-11",
      "*S-1-5-32-545",
      "/C",
      "/Q",
    ],
    { stdio: "ignore" },
  ]]);
  assert.throws(
    () => hardenWindowsLaunchDirectory("C:\\launches", () => ({ status: 5 }), { USERNAME: "owner" }),
    /Unable to secure/,
  );
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
  let detachedDescendantPid = null;
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
    const child = spawn(process.execPath, wrapperArgs(handshakePath, process.execPath, "-e", provider), { detached: process.platform !== "win32", stdio: ["pipe", "ignore", "ignore", "pipe"] });
    children.push(child);
    const deadline = Date.now() + 10_000;
    while (!existsSync(handshakePath) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    const record = JSON.parse(readFileSync(handshakePath, "utf8"));
    assert.equal(record.pid, child.pid, "the wrapper records its own pid durably before anything can execute");
    assert.equal(record.authorized, false);
    assert.equal(record.ownershipToken, WRAPPER_OWNERSHIP_TOKEN);
    if (process.platform === "darwin") {
      const command = spawnSync("/bin/ps", ["-o", "command=", "-p", String(child.pid)], { encoding: "utf8" });
      assert.equal(command.status, 0);
      assert.equal(command.stdout.trim(), `outright-agent-${WRAPPER_OWNERSHIP_TOKEN}`, "the live macOS wrapper proves possession of the handshake token");
    }
    if (["linux", "darwin", "win32"].includes(process.platform)) {
      assert.equal(record.processIdentity?.startsWith(`${process.platform}:`), true, "the handshake binds ownership to the wrapper's immutable start identity");
    }

    child.stdin.end();
    await withDeadline(new Promise((resolve) => child.once("exit", resolve)), "unauthorized wrapper exit", () => { try { child.kill("SIGKILL"); } catch {} });
    assert.equal(existsSync(marker), false, "an unauthorized wrapper must never start the provider");
    assert.equal(existsSync(handshakePath), false, "the wrapper removes its handshake record when it exits unauthorized");

    // Authorized: the same wrapper starts the provider and passes the exit code.
    const marker2 = path.join(root, "provider-ran-2");
    const handshakePath2 = path.join(launchDirectory, "launch-run-2.json");
    const provider2 = `require("node:fs").writeFileSync(${JSON.stringify(marker2)}, "ran"); setTimeout(() => {}, 250);`;
    const child2 = spawn(process.execPath, wrapperArgs(handshakePath2, process.execPath, "-e", provider2), { detached: process.platform !== "win32", stdio: ["pipe", "pipe", "ignore", "pipe"] });
    children.push(child2);
    const child2Exited = new Promise((resolve) => child2.once("exit", resolve));
    const deadline2 = Date.now() + 10_000;
    while (!existsSync(handshakePath2) && Date.now() < deadline2) await new Promise((resolve) => setTimeout(resolve, 10));
    const authorizationAcknowledged = once(child2.stdio[3], "data");
    child2.stdin.write("go\n");
    const [controlOutput] = await withDeadline(authorizationAcknowledged, "generic wrapper authorization acknowledgement");
    assert.equal(controlOutput.toString(), `${LAUNCH_AUTHORIZED_CONTROL}\n`, "the generic wrapper acknowledges only after it owns the authorized provider");
    let authorizedRecord;
    while (Date.now() < deadline2) {
      try {
        const candidate = JSON.parse(readFileSync(handshakePath2, "utf8"));
        if (candidate.authorized) { authorizedRecord = candidate; break; }
      } catch { /* Atomic replacement may briefly move the file. */ }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (["linux", "win32"].includes(process.platform)) {
      assert.equal(authorizedRecord?.providerProcessIdentity?.startsWith(`${process.platform}:`), true, "the authorized record binds the provider pid to its own boot-scoped start identity");
    } else {
      assert.equal(authorizedRecord?.providerProcessIdentity, undefined);
    }
    const code = await withDeadline(child2Exited, "authorized wrapper exit", () => { try { child2.kill("SIGKILL"); } catch {} });
    assert.equal(code, 0);
    assert.equal(existsSync(marker2), true, "the authorized wrapper starts the provider");
    assert.equal(existsSync(handshakePath2), false, "the handshake record is cleaned up after completion");

    if (process.platform === "darwin") {
      // A provider can exit after launching a background descendant. The
      // wrapper is the durable process-group identity on macOS, so it must
      // retain its handshake until that descendant is gone rather than making
      // restart recovery permanently unverifiable.
      const descendantMarker = path.join(root, "background-descendant");
      const handshakePath4 = path.join(launchDirectory, "launch-run-4.json");
      const descendantSource = `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`;
      const provider4 = [
        `const { spawn } = require("node:child_process");`,
        `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}], { detached: true, stdio: "ignore" });`,
        `require("node:fs").writeFileSync(${JSON.stringify(descendantMarker)}, String(child.pid));`,
        `child.unref();`,
      ].join("\n");
      const child4 = spawn(process.execPath, wrapperArgs(handshakePath4, process.execPath, "-e", provider4), {
        detached: true,
        stdio: ["pipe", "ignore", "ignore", "pipe"],
      });
      children.push(child4);
      const child4Exited = new Promise((resolve) => child4.once("exit", resolve));
      const deadline4 = Date.now() + 10_000;
      while (!existsSync(handshakePath4) && Date.now() < deadline4) await new Promise((resolve) => setTimeout(resolve, 10));
      child4.stdin.write("go\n");
      while (!existsSync(descendantMarker) && Date.now() < deadline4) await new Promise((resolve) => setTimeout(resolve, 10));
      const descendantPid = Number(readFileSync(descendantMarker, "utf8"));
      detachedDescendantPid = descendantPid;
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(child4.exitCode, null, "the wrapper retains the kernel coalition while a detached descendant is active");
      assert.equal(existsSync(handshakePath4), true, "the durable ownership record remains available for crash recovery");
      child4.stdin.write("stop\n");
      await withDeadline(child4Exited, "background descendant teardown", () => {
        try { process.kill(-child4.pid, "SIGKILL"); } catch {}
        try { process.kill(descendantPid, "SIGKILL"); } catch {}
      });
      assert.equal(existsSync(handshakePath4), false, "the wrapper removes ownership only after the process coalition is empty");
      assert.throws(() => process.kill(descendantPid, 0), { code: "ESRCH" }, "the coalition helper kills an immediately detached descendant before ownership is released");
      detachedDescendantPid = null;

      // A hard crash can kill both wrapper and supervisor before either runs
      // cleanup. The launchd label and resource coalition in the handshake
      // must still let the restarted runtime prove and terminate the escaped
      // descendant without relying on its former parent pid.
      const descendantMarker5 = path.join(root, "background-descendant-after-crash");
      const handshakePath5 = path.join(launchDirectory, "launch-run-5.json");
      const provider5 = [
        `const { spawn } = require("node:child_process");`,
        `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}], { detached: true, stdio: "ignore" });`,
        `require("node:fs").writeFileSync(${JSON.stringify(descendantMarker5)}, String(child.pid));`,
        `child.unref();`,
      ].join("\n");
      const child5 = spawn(process.execPath, wrapperArgs(handshakePath5, process.execPath, "-e", provider5), {
        detached: true,
        stdio: ["pipe", "ignore", "ignore", "pipe"],
      });
      children.push(child5);
      const child5Exited = new Promise((resolve) => child5.once("exit", resolve));
      const handshakeDeadline5 = Date.now() + 10_000;
      while (!existsSync(handshakePath5) && Date.now() < handshakeDeadline5) await new Promise((resolve) => setTimeout(resolve, 10));
      const acknowledged5 = once(child5.stdio[3], "data");
      child5.stdin.write("go\n");
      await withDeadline(acknowledged5, "crash-recovery authorization acknowledgement");
      const deadline5 = Date.now() + 10_000;
      while (!existsSync(descendantMarker5) && Date.now() < deadline5) await new Promise((resolve) => setTimeout(resolve, 10));
      const descendantPid5 = Number(readFileSync(descendantMarker5, "utf8"));
      detachedDescendantPid = descendantPid5;
      await new Promise((resolve) => setTimeout(resolve, 150));
      process.kill(-child5.pid, "SIGKILL");
      await withDeadline(child5Exited, "hard-killed wrapper exit");
      assert.equal(existsSync(handshakePath5), true, "a hard crash leaves the durable coalition identity for restart recovery");
      const label = `com.21n.outright.${WRAPPER_OWNERSHIP_TOKEN}`;
      const probe = spawnSync(platformSupervisor, ["--probe", label], { encoding: "utf8" });
      assert.equal(probe.stdout.trim(), "alive", "recovery finds the detached process through its kernel coalition");
      const terminated = spawnSync(platformSupervisor, ["--terminate", label], { encoding: "utf8" });
      assert.equal(terminated.status, 0, `coalition recovery failed: ${terminated.stderr}`);
      assert.throws(() => process.kill(descendantPid5, 0), { code: "ESRCH" }, "recovery empties the crashed job's coalition");
      detachedDescendantPid = null;
    }

    // Pipe writes may be coalesced. A stop command arriving in the same chunk
    // as authorization must still be consumed instead of being dropped by an
    // early return after "go".
    const handshakePath3 = path.join(launchDirectory, "launch-run-3.json");
    const provider3 = `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`;
    const child3 = spawn(process.execPath, wrapperArgs(handshakePath3, process.execPath, "-e", provider3), { detached: process.platform !== "win32", stdio: ["pipe", "ignore", "ignore", "pipe"] });
    children.push(child3);
    const deadline3 = Date.now() + 10_000;
    while (!existsSync(handshakePath3) && Date.now() < deadline3) await new Promise((resolve) => setTimeout(resolve, 10));
    child3.stdin.write("go\nstop\n");
    await withDeadline(new Promise((resolve) => child3.once("exit", resolve)), "coalesced authorization and stop", () => { try { child3.kill("SIGKILL"); } catch {} });
    assert.equal(existsSync(handshakePath3), false, "the coalesced stop command tears down the authorized provider");
  } finally {
    if (detachedDescendantPid) { try { process.kill(detachedDescendantPid, "SIGKILL"); } catch { /* Already gone. */ } }
    for (const child of children) { try { child.kill("SIGKILL"); } catch { /* Already gone. */ } }
    if (process.platform === "darwin") spawnSync("/bin/launchctl", ["bootout", `gui/${process.getuid()}/com.21n.outright.${WRAPPER_OWNERSHIP_TOKEN}`], { stdio: "ignore" });
    rmSync(root, { recursive: true, force: true });
  }
});

test("the generic wrapper never runs or acknowledges after its authorized handshake rewrite fails", { timeout: 15000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-wrapper-handshake-failure-"));
  const handshakePath = path.join(root, "launch.json");
  const marker = path.join(root, "provider-ran");
  const provider = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");`;
  const child = spawn(process.execPath, wrapperArgs(handshakePath, process.execPath, "-e", provider), { stdio: ["pipe", "ignore", "pipe", "pipe"] });
  try {
    const deadline = Date.now() + 10_000;
    while (!existsSync(handshakePath) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(JSON.parse(readFileSync(handshakePath, "utf8")).authorized, false);
    rmSync(handshakePath);
    mkdirSync(handshakePath);

    let acknowledgement = "";
    child.stdio[3].setEncoding("utf8");
    child.stdio[3].on("data", (chunk) => { acknowledgement += chunk; });
    child.stdin.end("go\n");
    const [code] = await once(child, "close");

    assert.equal(code, 127);
    assert.equal(acknowledgement, "", "authorization is never acknowledged without a durable authorized record");
    assert.equal(existsSync(marker), false, "the provider cannot execute after the ownership rewrite fails");
  } finally {
    try { child.kill("SIGKILL"); } catch { /* Already gone. */ }
    rmSync(root, { recursive: true, force: true });
  }
});

// Escalation may target the provider alone only after the wrapper's durable
// provider identity revalidates. Missing or stale identity falls back to the
// still-owned group instead of risking a recycled unrelated PID.
test("escalation targets only a provider whose durable identity still matches", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-escalate-"));
  try {
    const handshakePath = path.join(root, "run-1.json");
    const kills = [];
    const kill = (pid, signal) => kills.push([pid, signal]);
    const child = { pid: 4242, kill: (signal) => kills.push(["child", signal]) };

    writeFileSync(handshakePath, JSON.stringify({ pid: 4242, authorized: true, providerPid: 777, providerProcessIdentity: "linux:boot:123" }));
    assert.equal(escalateTree(child, handshakePath, "linux", null, kill, () => "linux:boot:123"), "provider");
    assert.deepEqual(kills, [[777, "SIGKILL"]], "the provider pid is killed, never the group or the wrapper");

    kills.length = 0;
    assert.equal(escalateTree(child, handshakePath, "darwin", null, kill, () => "darwin:boot:recycled"), "group");
    assert.deepEqual(kills, [[-4242, "SIGKILL"]], "a mismatched Darwin provider identity never signals the recycled pid");

    kills.length = 0;
    writeFileSync(handshakePath, JSON.stringify({ pid: 4242, authorized: true, providerPid: 777 }));
    assert.equal(escalateTree(child, handshakePath, "darwin", null, kill, () => "darwin:boot:any"), "group");
    assert.deepEqual(kills, [[-4242, "SIGKILL"]], "Darwin fails closed when no immutable provider identity was persisted");

    kills.length = 0;
    writeFileSync(handshakePath, JSON.stringify({ pid: 4242, authorized: false }));
    assert.equal(escalateTree(child, handshakePath, "linux", null, kill), "group");
    assert.deepEqual(kills, [[-4242, "SIGKILL"]], "without a provider pid the owned group is killed");

    // A malformed or tampered record must never reach kill: a negative pid
    // would translate to kill(-1, "SIGKILL") and terminate every process the
    // runtime user owns.
    kills.length = 0;
    writeFileSync(handshakePath, JSON.stringify({ pid: 4242, authorized: true, providerPid: -1 }));
    assert.equal(escalateTree(child, handshakePath, "linux", null, kill), "group");
    assert.deepEqual(kills, [[-4242, "SIGKILL"]], "an unsafe provider pid falls back to the owned group, never kill(-1)");

    for (const providerPid of [0, Number.MAX_SAFE_INTEGER + 1]) {
      kills.length = 0;
      writeFileSync(handshakePath, JSON.stringify({ pid: 4242, authorized: true, providerPid }));
      assert.equal(escalateTree(child, handshakePath, "linux", null, kill), "group");
      assert.deepEqual(kills, [[-4242, "SIGKILL"]], `provider pid ${providerPid} is never signaled directly`);
    }

    kills.length = 0;
    writeFileSync(handshakePath, JSON.stringify({ pid: 9999, authorized: true, providerPid: 777 }));
    assert.equal(escalateTree(child, handshakePath, "linux", null, kill), "group");
    assert.deepEqual(kills, [[-4242, "SIGKILL"]], "a record for another supervisor cannot authorize a provider kill");

    kills.length = 0;
    assert.equal(escalateTree(child, path.join(root, "missing.json"), "linux", null, kill), "group");
    assert.deepEqual(kills, [[-4242, "SIGKILL"]], "a missing handshake record falls back to the group");

    kills.length = 0;
    const calls = [];
    assert.equal(escalateTree(child, handshakePath, "win32", (executable, args) => { calls.push([executable, ...args]); return { status: 0 }; }, kill), "group");
    assert.deepEqual(calls, [["taskkill", "/PID", "4242", "/T", "/F"]], "windows escalation tears down the whole tree");
    assert.deepEqual(kills, [], "windows never signals POSIX pids directly");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A zombie cannot execute side effects: on /proc platforms a group whose every
// member is a killed-but-unreaped zombie must not count as alive, or
// stop/shutdown never complete on hosts whose PID 1 does not reap orphans.
test("a zombie-only process group is not alive", { skip: process.platform === "win32" }, async () => {
  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { detached: true, stdio: "ignore" });
  try {
    assert.doesNotThrow(() => process.kill(-holder.pid, 0), "the probe group must exist for a meaningful verdict");
    assert.equal(processGroupAlive({ pid: holder.pid }, "linux", () => [{ pid: 1, state: "Z" }]), false, "an all-zombie group is not alive");
    assert.equal(processGroupAlive({ pid: holder.pid }, "linux", () => [{ pid: 1, state: "Z" }, { pid: 2, state: "R" }]), true, "a group with any live member stays alive");
    assert.equal(processGroupAlive({ pid: holder.pid }, "linux", () => null), true, "unavailable member enumeration keeps the conservative verdict");
    assert.equal(processGroupAlive({ pid: holder.pid }), true, "the default verdict for a live group is alive");
    if (process.platform === "linux") {
      const members = defaultGroupMembers(holder.pid);
      assert.ok(Array.isArray(members) && members.some((member) => member.state !== "Z"), "default enumeration finds the live holder");
    }
  } finally {
    try { process.kill(-holder.pid, "SIGKILL"); } catch { /* Already gone. */ }
  }
});

// The real launch wrapper must durably record the provider pid once
// authorized, and stopping a SIGTERM-ignoring provider must complete with the
// whole owned group gone while the wrapper — not a group-wide SIGKILL —
// performs the teardown and reaping. The faithful non-reaping-host regression
// (descendants included) is the container test below.
test("wrapper teardown kills the provider and the wrapper reaps it", { skip: process.platform === "win32", timeout: 20000 }, async (t) => {
  const database = fakeDatabase();
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-escalate-live-"));
  const handshakePath = path.join(root, "escalate.json");
  const provider = `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`;
  let child;
  const manager = createAgentManager({
    database, publish: () => {}, terminationGraceMs: 150, terminationTimeoutMs: 8000,
    // The launch directory must match the wrapper's handshake path so
    // escalation reads the provider pid the wrapper durably recorded; a
    // mismatched path would silently fall back to the group-wide kill.
    launchDirectory: root,
    spawnProcess: () => {
      child = spawn(process.execPath, wrapperArgs(handshakePath, process.execPath, "-e", provider), { detached: true, stdio: ["pipe", "pipe", "pipe", "pipe"] });
      return child;
    },
  });
  t.after(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already gone. */ } });
  try {
    const run = database.createRun(codexRun("escalate"));
    await manager.schedule({ conversation: database.getConversation("conv-1"), run });

    const deadline = Date.now() + 10_000;
    let providerPid = null;
    while (Date.now() < deadline) {
      try { providerPid = JSON.parse(readFileSync(handshakePath, "utf8")).providerPid; } catch { /* Not written yet. */ }
      if (providerPid) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(providerPid, "the wrapper durably records the provider pid after authorization");

    const stopping = manager.stop(run.id);
    // Poll both pids: the provider must be observed fully gone (reaped by the
    // wrapper) no later than the wrapper itself. A group-wide SIGKILL would
    // kill both at once; the faithful non-reaping-host regression is the
    // container test below.
    const gone = Date.now() + 10_000;
    let providerGoneAt = null;
    let wrapperGoneAt = null;
    while (Date.now() < gone && wrapperGoneAt == null) {
      if (providerGoneAt == null) { try { process.kill(providerPid, 0); } catch { providerGoneAt = Date.now(); } }
      try { process.kill(child.pid, 0); } catch { wrapperGoneAt = Date.now(); }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.ok(providerGoneAt != null, "the provider is killed by escalation");
    assert.ok(wrapperGoneAt != null, "the wrapper exits after reaping the provider");
    assert.ok(providerGoneAt <= wrapperGoneAt, "the wrapper reaps the provider before exiting");

    assert.equal(await stopping, true, "stop completes instead of timing out on the tree");
    assert.equal(database.getRun(run.id).status, "stopped");
    assert.throws(() => process.kill(-child.pid, 0), { code: "ESRCH" }, "the whole owned process group is gone");
    assert.deepEqual(manager.activeRuns(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The production/container path: on a host whose PID 1 does not reap orphaned
// grandchildren, stopping (or shutting down) a run whose provider spawned a
// SIGTERM-ignoring descendant must leave NO member in the wrapper's process
// group — not even a killed-but-unreaped zombie, which would otherwise
// accumulate one process-table entry per stop until PID exhaustion.
// Reproduced faithfully in node:22-bookworm with `sh` as PID 1 (no reaping):
// the container compiles and runs the checked-in Linux subreaper supervisor,
// the stop is issued only after the descendant has installed its signal
// handler (ready marker), and the assertion scans /proc directly instead of
// trusting the implementation's own liveness verdict.
test("stop and shutdown leave no provider-tree members on a non-reaping PID 1", { skip: process.platform === "win32", timeout: 180000 }, async (t) => {
  const docker = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8", timeout: 20000 });
  if (docker.status !== 0) return t.skip(`docker unavailable: ${(docker.stderr || "").trim()}`);
  const descendant = "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(process.env.READY, String(process.pid)); setInterval(() => {}, 1000);";
  const script = `
import { pathToFileURL } from "node:url";
const { spawn, spawnSync } = await import("node:child_process");
const { existsSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, renameSync, writeFileSync } = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");
const manager = await import(pathToFileURL("/app/server/agent-manager.mjs"));
const root = mkdtempSync(path.join(os.tmpdir(), "reap-"));
const handshakeFor = (id) => path.join(root, \`\${id}.json\`);
// The descendant only counts as ready once it has installed its SIGTERM
// handler and said so: stopping earlier could race past the leak entirely.
// It arrives through the environment because the provider below evaluates
// inside its own process, where driver-scope variables do not exist.
const runs = new Map();
const database = {
  getSettings: () => ({ maxConcurrentRuns: 8 }),
  getConversation: (id) => ({ id, worktreePath: "/tmp" }),
  updateConversation: () => {},
  getRun: (id) => runs.get(id) ?? null,
  createRun: (run) => { runs.set(run.id, run); return run; },
  updateRun: (id, patch) => { runs.set(id, { ...runs.get(id), ...patch }); return runs.get(id); },
  addMessage: (input) => input,
  upsertMessage: (input) => input,
  finishRun: (id, patch) => { runs.set(id, { ...runs.get(id), ...patch }); return { run: runs.get(id) }; },
  appendRunEvent: () => ({}),
  audit: () => {},
};
const children = new Map();
const agent = manager.createAgentManager({
  database,
  publish: () => {},
  terminationGraceMs: 300,
  terminationTimeoutMs: 8000,
  launchDirectory: root,
  // The container has no codex/claude CLI: supervise a real Node provider that
  // cannot service SIGCHLD while it spins, so descendants-first signaling
  // alone would strand its killed child as a zombie after the provider dies.
  launchCommand: (_command, run, directory) => {
    const handshakePath = path.join(directory, \`\${run.id}.json\`);
    const provider = [
      "const { spawn } = require('node:child_process');",
      "process.on('SIGTERM', () => {});",
      \`spawn(process.execPath, ['-e', process.env.DESCENDANT], { detached: true, stdio: 'ignore', env: { ...process.env, READY: process.env.READY + '.\${run.id}.' + process.pid } });\`,
      "while (true) {}",
    ].join(" ");
    return manager.defaultLaunchCommand({ executable: process.execPath, args: ["-e", provider], display: "test provider" }, run, directory);
  },
  spawnProcess: (executable, args) => {
    const child = spawn(executable, args, { detached: true, stdio: ["pipe", "pipe", "pipe", "pipe"] });
    children.set(path.basename(args[0], ".json"), child);
    return child;
  },
});
// Enumerates the raw OS members of a process group from /proc: zombies
// included, so the assertion cannot be satisfied by a zombie-filtered
// implementation verdict.
const groupMembers = (pgid) => {
  const members = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\\d+$/.test(entry)) continue;
    let stat;
    try { stat = readFileSync(\`/proc/\${entry}/stat\`, "utf8"); } catch { continue; }
    const close = stat.lastIndexOf(")");
    if (close < 0) continue;
    const fields = stat.slice(close + 2).split(" ");
    if (Number(fields[2]) === pgid) members.push({ pid: Number(entry), ppid: Number(fields[1]), state: fields[0] });
  }
  return members;
};
const processInfo = (pid) => {
  try {
    const stat = readFileSync(\`/proc/\${pid}/stat\`, "utf8");
    const close = stat.lastIndexOf(")");
    const fields = stat.slice(close + 2).split(" ");
    return { pid, ppid: Number(fields[1]), state: fields[0] };
  } catch { return null; }
};
const waitForExit = (child, label) => Promise.race([
  new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal }))),
  new Promise((_, reject) => setTimeout(() => reject(new Error(label + " timed out")), 10000)),
]);

// The authorization record must commit before provider code can execute. Make
// the rewrite fail after the initial unauthorized record and prove the child
// blocked behind the private authorization pipe never reaches its marker.
const failedRoot = path.join(root, "failed-authorization");
const failedHandshake = path.join(failedRoot, "run.json");
const failedMarker = path.join(root, "provider-must-not-run");
const failed = spawn("/tmp/agent-supervisor", [failedHandshake, process.execPath, "-e", \`require('node:fs').writeFileSync(\${JSON.stringify(failedMarker)}, 'ran')\`], { detached: true, stdio: ["pipe", "pipe", "pipe", "pipe"] });
while (!existsSync(failedHandshake)) await new Promise((resolve) => setTimeout(resolve, 10));
const nativeIdentitySafe = /^linux:[0-9a-f-]+:[1-9]\\d*$/.test(JSON.parse(readFileSync(failedHandshake, "utf8")).processIdentity || "");
renameSync(failedRoot, failedRoot + "-moved");
writeFileSync(failedRoot, "blocks directory recreation");
failed.stdin.write("go\\n");
const failedExit = await waitForExit(failed, "failed authorization");
const authorizationSafe = failedExit.code === 75 && !existsSync(failedMarker) && groupMembers(failed.pid).length === 0;

// The native command parser, like the JS fallback, must consume both commands
// when a pipe write delivers go and stop in one chunk.
const coalescedHandshake = path.join(root, "coalesced.json");
const coalesced = spawn("/tmp/agent-supervisor", [coalescedHandshake, process.execPath, "-e", "process.on('SIGTERM', () => {}); while (true) {}"], { detached: true, stdio: ["pipe", "pipe", "pipe", "pipe"] });
while (!existsSync(coalescedHandshake)) await new Promise((resolve) => setTimeout(resolve, 10));
coalesced.stdin.write("go\\nstop\\n");
await waitForExit(coalesced, "coalesced native commands");
const coalescedSafe = groupMembers(coalesced.pid).length === 0;

// Provider stdin is data-plane input, not the supervisor control channel. A
// provider that reads fd 0 must see EOF from /dev/null and cannot consume a
// later stop command intended for the supervisor.
const stdinHandshake = path.join(root, "stdin.json");
const stdinMarker = path.join(root, "stdin-marker");
const stdinProvider = \`const fs = require('node:fs'); fs.writeFileSync(\${JSON.stringify(stdinMarker)}, fs.readFileSync(0, 'utf8'));\`;
const stdinChild = spawn("/tmp/agent-supervisor", [stdinHandshake, process.execPath, "-e", stdinProvider], { detached: true, stdio: ["pipe", "pipe", "pipe", "pipe"] });
while (!existsSync(stdinHandshake)) await new Promise((resolve) => setTimeout(resolve, 10));
stdinChild.stdin.write("go\\n");
const stdinExit = await waitForExit(stdinChild, "provider stdin isolation");
const stdinSafe = stdinExit.code === 0 && readFileSync(stdinMarker, "utf8") === "" && groupMembers(stdinChild.pid).length === 0;

// fd 3 is launch-owner control, not provider data. The provider must observe
// it closed while the manager still receives the supervisor's acknowledgement.
const controlHandshake = path.join(root, "control.json");
const controlMarker = path.join(root, "control-marker");
const controlProvider = \`const fs = require('node:fs'); let target = 'closed'; try { target = fs.readlinkSync('/proc/self/fd/3'); } catch {} fs.writeFileSync(\${JSON.stringify(controlMarker)}, target);\`;
const controlChild = spawn("/tmp/agent-supervisor", [controlHandshake, process.execPath, "-e", controlProvider], { detached: true, stdio: ["pipe", "pipe", "pipe", "pipe"] });
while (!existsSync(controlHandshake)) await new Promise((resolve) => setTimeout(resolve, 10));
const ownerControlTarget = readlinkSync(\`/proc/\${controlChild.pid}/fd/3\`);
const controlAck = Promise.race([
  new Promise((resolve) => controlChild.stdio[3].once("data", (chunk) => resolve(chunk.toString()))),
  new Promise((resolve) => setTimeout(() => resolve("timeout"), 10000)),
]);
controlChild.stdin.write("go\\n");
const [controlOutput, controlExit] = await Promise.all([controlAck, waitForExit(controlChild, "provider control isolation")]);
const controlMarkerValue = readFileSync(controlMarker, "utf8");
const controlFdSafe = controlExit.code === 0
  && controlOutput === manager.LAUNCH_AUTHORIZED_CONTROL + "\\n"
  && controlMarkerValue !== ownerControlTarget
  && groupMembers(controlChild.pid).length === 0;

// Linux clone children created without a SIGCHLD exit signal require __WALL
// for waitpid/waitid. The supervisor must reap an adopted clone child before
// it releases ownership, rather than hanging forever on its zombie.
const cloneSourcePath = path.join(root, "clone-provider.c");
const cloneProvider = path.join(root, "clone-provider");
writeFileSync(cloneSourcePath, [
  "#define _GNU_SOURCE",
  "#include <sched.h>",
  "#include <stdlib.h>",
  "#include <unistd.h>",
  "static int clone_child(void *unused) { (void)unused; usleep(200000); return 0; }",
  "int main(void) {",
  "  const size_t size = 1024 * 1024;",
  "  char *stack = malloc(size);",
  "  if (!stack) return 2;",
  "  if (clone(clone_child, stack + size, 0, NULL) < 0) return 3;",
  "  return 0;",
  "}",
].join("\\n"));
const cloneBuild = spawnSync("cc", [cloneSourcePath, "-O2", "-o", cloneProvider], { encoding: "utf8" });
if (cloneBuild.status !== 0) throw new Error("clone helper failed to compile: " + cloneBuild.stderr);
const cloneHandshake = path.join(root, "clone.json");
const cloned = spawn("/tmp/agent-supervisor", [cloneHandshake, cloneProvider], { detached: true, stdio: ["pipe", "pipe", "pipe", "pipe"] });
while (!existsSync(cloneHandshake)) await new Promise((resolve) => setTimeout(resolve, 10));
cloned.stdin.write("go\\n");
cloned.stdin.end();
const cloneExit = await waitForExit(cloned, "clone child reaping");
const cloneSafe = cloneExit.code === 0 && !existsSync(cloneHandshake) && groupMembers(cloned.pid).length === 0;

// After a runtime crash closes the control pipe, an operator must still be
// able to terminate the authorized supervisor with SIGTERM. It must retain
// subreaper ownership until an escaped descendant is gone and reaped.
const signalHandshake = path.join(root, "signal.json");
const signalReady = path.join(root, "signal-ready");
const signalProvider = [
  "const { spawn } = require('node:child_process');",
  "process.on('SIGTERM', () => {});",
  \`spawn(process.execPath, ['-e', process.env.DESCENDANT], { detached: true, stdio: 'ignore', env: { ...process.env, READY: \${JSON.stringify(signalReady)} } });\`,
  "while (true) {}",
].join(" ");
const signaled = spawn("/tmp/agent-supervisor", [signalHandshake, process.execPath, "-e", signalProvider], { detached: true, stdio: ["pipe", "pipe", "pipe", "pipe"] });
while (!existsSync(signalHandshake)) await new Promise((resolve) => setTimeout(resolve, 10));
signaled.stdin.write("go\\n");
while (!existsSync(signalReady)) await new Promise((resolve) => setTimeout(resolve, 10));
const signalDescendantPid = Number(readFileSync(signalReady, "utf8"));
signaled.stdin.end();
process.kill(-signaled.pid, "SIGTERM");
await waitForExit(signaled, "post-disconnect supervisor signal");
const signalSafe = !existsSync(signalHandshake) && groupMembers(signaled.pid).length === 0 && processInfo(signalDescendantPid) == null;

// A privileged provider may drop a descendant to another uid. Ownership is
// still ancestry-based: the supervisor must not omit that process from its
// zero-descendant proof merely because its credentials changed.
const foreignHandshake = path.join(root, "foreign-uid.json");
const foreignReady = \`/tmp/outright-foreign-ready-\${process.pid}\`;
const foreignDescendant = \`process.setuid(65534); process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(\${JSON.stringify(foreignReady)}, String(process.pid)); setInterval(() => {}, 1000);\`;
const foreignProvider = [
  "const { spawn } = require('node:child_process');",
  "process.on('SIGTERM', () => {});",
  \`spawn(process.execPath, ['-e', \${JSON.stringify(foreignDescendant)}], { detached: true, stdio: 'ignore' });\`,
  "while (true) {}",
].join(" ");
const foreign = spawn("/tmp/agent-supervisor", [foreignHandshake, process.execPath, "-e", foreignProvider], { detached: true, stdio: ["pipe", "pipe", "pipe", "pipe"] });
while (!existsSync(foreignHandshake)) await new Promise((resolve) => setTimeout(resolve, 10));
foreign.stdin.write("go\\n");
const foreignReadyDeadline = Date.now() + 10000;
while (!existsSync(foreignReady)) {
  if (Date.now() >= foreignReadyDeadline) throw new Error("foreign-uid descendant never signaled readiness (setuid(65534) requires a root container): " + foreignReady);
  await new Promise((resolve) => setTimeout(resolve, 10));
}
const foreignDescendantPid = Number(readFileSync(foreignReady, "utf8"));
foreign.stdin.write("stop\\n");
await waitForExit(foreign, "foreign-uid descendant cleanup");
const foreignUidSafe = !existsSync(foreignHandshake) && groupMembers(foreign.pid).length === 0 && processInfo(foreignDescendantPid) == null;

const waitForReady = async (runId) => {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    let providerPid = null;
    try { providerPid = JSON.parse(readFileSync(handshakeFor(runId), "utf8")).providerPid; } catch {}
    const ready = \`\${process.env.READY}.\${runId}.\${providerPid}\`;
    if (providerPid && existsSync(ready)) return { child: children.get(runId), descendantPid: Number(readFileSync(ready, "utf8")) };
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the provider/descendant pair never became signal-ready");
};
const schedule = async (runId) => {
  const run = database.createRun({ id: runId, conversationId: "conv-1", provider: "codex", prompt: "p", approvalPolicy: "read-only" });
  await agent.schedule({ conversation: database.getConversation("conv-1"), run });
  return waitForReady(runId);
};
const outcome = {};
try {
  const first = await schedule("stop-run");
  await agent.stop("stop-run");
  outcome.membersAfterStop = groupMembers(first.child.pid);
  outcome.descendantAfterStop = processInfo(first.descendantPid);
} catch (error) { outcome.stopError = String(error && error.message); }
try {
  const second = await schedule("shutdown-run");
  await agent.shutdown();
  outcome.membersAfterShutdown = groupMembers(second.child.pid);
  outcome.descendantAfterShutdown = processInfo(second.descendantPid);
} catch (error) { outcome.shutdownError = String(error && error.message); }
const clean = nativeIdentitySafe && authorizationSafe && coalescedSafe && stdinSafe && controlFdSafe && cloneSafe && signalSafe && foreignUidSafe && !outcome.stopError && !outcome.shutdownError
  && outcome.membersAfterStop.length === 0 && outcome.membersAfterShutdown.length === 0
  && outcome.descendantAfterStop == null && outcome.descendantAfterShutdown == null;
console.log("RESULT " + JSON.stringify({ nativeIdentitySafe, authorizationSafe, coalescedSafe, stdinSafe, controlFdSafe, controlOutput, controlExit, controlMarkerValue, ownerControlTarget, cloneSafe, signalSafe, foreignUidSafe, ...outcome, clean }));
process.exit(clean ? 0 : 1);
`;
  const repo = fileURLToPath(new URL("..", import.meta.url));
  const result = spawnSync("docker", [
    "run", "--rm", "-i",
    "-e", `DESCENDANT=${descendant}`,
    "-e", "READY=/tmp/descendant-ready",
    "-e", "OUTRIGHT_AGENT_SUPERVISOR_PATH=/tmp/agent-supervisor",
    "-v", `${repo}:/app:ro`,
    "node:22-bookworm",
    // `sh` as PID 1: it does not reap orphaned grandchildren, which is the
    // production condition this regression must survive.
    "sh", "-c", "OUTRIGHT_AGENT_SUPERVISOR_OUTPUT=/tmp/agent-supervisor node /app/scripts/build-agent-supervisor.mjs && node --input-type=module -",
  ], { input: script, encoding: "utf8", timeout: 150000, maxBuffer: 16 * 1024 * 1024 });
  const line = (result.stdout || "").split("\n").find((entry) => entry.startsWith("RESULT ")) ?? "";
  // `docker info` can succeed while `docker run` still cannot reach the
  // daemon; treat that connectivity failure as an unavailable environment
  // (skip), not a failing regression.
  if (!line) {
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    if (/cannot connect|docker daemon|error during connect|no such image/i.test(output)) return t.skip(`docker run could not reach the daemon: ${output.trim().slice(0, 300)}`);
    assert.fail(`container run produced no result: exit=${result.status} stdout=${(result.stdout || "").slice(-2000)} stderr=${(result.stderr || "").slice(-2000)}`);
  }
  const payload = JSON.parse(line.slice("RESULT ".length));
  assert.equal(payload.authorizationSafe, true, "a failed authorized-handshake write must not release provider execution");
  assert.equal(payload.coalescedSafe, true, "coalesced native go/stop commands must tear down the provider");
  assert.equal(payload.stdinSafe, true, "provider stdin must be isolated from the supervisor control pipe");
  assert.equal(payload.controlFdSafe, true, `provider code must not inherit or forge the launch-owner control channel: ${JSON.stringify(payload)}`);
  assert.equal(payload.cloneSafe, true, "clone children without SIGCHLD must be reaped before ownership is released");
  assert.equal(payload.signalSafe, true, "SIGTERM after a runtime disconnect must reap the complete provider tree");
  assert.equal(payload.foreignUidSafe, true, "credential changes must not remove descendants from the ownership proof");
  assert.equal(payload.stopError, undefined, `stop did not resolve: ${payload.stopError}`);
  assert.equal(payload.shutdownError, undefined, `shutdown did not resolve: ${payload.shutdownError}`);
  assert.deepEqual(payload.membersAfterStop, [], `the process group still has members after stop: ${JSON.stringify(payload.membersAfterStop)}`);
  assert.deepEqual(payload.membersAfterShutdown, [], `the process group still has members after shutdown: ${JSON.stringify(payload.membersAfterShutdown)}`);
  assert.equal(payload.descendantAfterStop, null, `a detached descendant survived stop: ${JSON.stringify(payload.descendantAfterStop)}`);
  assert.equal(payload.descendantAfterShutdown, null, `a detached descendant survived shutdown: ${JSON.stringify(payload.descendantAfterShutdown)}`);
  assert.equal(payload.clean, true);
});
