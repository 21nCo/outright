import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertRuntimeRequest, createOutrightRuntime, defaultRecoveryProcessAlive, runtimeAllowedHosts } from "./outright-runtime.mjs";

function request(host, origin) {
  return { headers: { host, ...(origin ? { origin } : {}) } };
}

function requestStream(method, url, body) {
  const stream = new Readable({ read() {} });
  stream.method = method;
  stream.url = url;
  stream.headers = { host: "localhost:4173" };
  if (body != null) stream.push(JSON.stringify(body));
  stream.push(null);
  return stream;
}

function responseCapture() {
  return {
    statusCode: null,
    setHeader(key, value) { (this.headers ??= {})[key] = value; },
    end(payload) { this.body = payload ? JSON.parse(payload) : null; },
  };
}

function withRuntime(fn, options = {}) {
  return async () => {
    const dataDirectory = mkdtempSync(path.join(os.tmpdir(), "outright-test-"));
    process.env.OUTRIGHT_DATA_DIR = dataDirectory;
    const runtime = createOutrightRuntime({ configUrl: "file:///nonexistent-config.json", ...options });
    try {
      // The runtime wires its own database, manager, and event hub, so the
      // recovery endpoint is exercised exactly as in production.
      await fn(runtime);
    } finally {
      await runtime.shutdown();
      delete process.env.OUTRIGHT_DATA_DIR;
      rmSync(dataDirectory, { recursive: true, force: true });
    }
  };
}

test("reconciles runs at startup and resolves discard decisions through the API", withRuntime(async (runtime) => {
  const conversation = runtime.database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Recovery", provider: "codex" });
  const run = runtime.database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "half done" });
  runtime.database.reconcileInterruptedRuns({ probeAlive: () => false });
  assert.equal(runtime.database.getRun(run.id).status, "interrupted");

  const response = responseCapture();
  assert.equal(await runtime.handleRequest(requestStream("POST", `/api/runs/${run.id}/resume`, { policy: "discard" }), response), true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "failed");
  assert.equal(response.body.recoveryDecision, "discard");

  const repeat = responseCapture();
  await runtime.handleRequest(requestStream("POST", `/api/runs/${run.id}/resume`, { policy: "discard" }), repeat);
  assert.equal(repeat.statusCode, 409, "decisions are final");
}));

test("rejects a malformed recovery policy with 400", withRuntime(async (runtime) => {
  const conversation = runtime.database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Recovery", provider: "codex" });
  const run = runtime.database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "half done" });
  runtime.database.reconcileInterruptedRuns();
  const response = responseCapture();
  await runtime.handleRequest(requestStream("POST", `/api/runs/${run.id}/resume`, { policy: "guess" }), response);
  assert.equal(response.statusCode, 400);
}));

test("blocks direct run submission until the interrupted run has a recovery decision", withRuntime(async (runtime) => {
  const conversation = runtime.database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Recovery", provider: "codex" });
  const run = runtime.database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "half done" });
  runtime.database.reconcileInterruptedRuns();

  const blocked = responseCapture();
  await runtime.handleRequest(requestStream("POST", `/api/conversations/${conversation.id}/runs`, { prompt: "silently resume" }), blocked);
  assert.equal(blocked.statusCode, 409);
  assert.equal(blocked.body.code, "RUN_RECOVERY_REQUIRED");
  assert.equal(blocked.body.runId, run.id);

  const discarded = responseCapture();
  await runtime.handleRequest(requestStream("POST", `/api/runs/${run.id}/resume`, { policy: "discard" }), discarded);
  assert.equal(discarded.statusCode, 200);
  assert.equal(runtime.database.findUnresolvedInterruptedRun(conversation.id), undefined);
}));

test("does not resolve an alive recovered provider while it can still mutate the worktree", withRuntime(async (runtime) => {
  const conversation = runtime.database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Recovery", provider: "codex" });
  const run = runtime.database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "half done" });
  runtime.database.updateRun(run.id, { status: "running", pid: 4242 });
  runtime.database.reconcileInterruptedRuns({ probeAlive: () => true });

  const response = responseCapture();
  await runtime.handleRequest(requestStream("POST", `/api/runs/${run.id}/resume`, { policy: "discard" }), response);
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.code, "RECOVERY_PROCESS_ACTIVE");
  assert.equal(runtime.database.getRun(run.id).recoveryDecision, null);
}, { recoveryProcessAlive: () => true }));

// Regression: an exited leader with a live descendant was classified exited
// at restart and could then bypass the recovery process guard entirely.
test("re-probes the process group of an exited-classified run before recovery", { skip: process.platform === "win32" }, withRuntime(async (runtime) => {
  const descendant = "setInterval(() => {}, 1000);";
  const leader = `const {spawn} = require("node:child_process"); spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], {stdio: "ignore"}); process.exit(0);`;
  const child = spawn(process.execPath, ["-e", leader], { detached: true, stdio: "ignore" });
  const pid = child.pid;
  child.once("exit", () => {});
  try {
    // Wait until the leader is gone while the descendant holds its group.
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
    const conversation = runtime.database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Recovery", provider: "codex" });
    const run = runtime.database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "half done" });
    runtime.database.updateRun(run.id, { status: "running", pid });
    // Stale restart classification: the leader had already exited by the time
    // the restart probe ran, but the descendant still holds the process group.
    runtime.database.reconcileInterruptedRuns({ probeAlive: () => false });
    assert.equal(runtime.database.getRun(run.id).recoveryClass, "exited");

    const response = responseCapture();
    await runtime.handleRequest(requestStream("POST", `/api/runs/${run.id}/resume`, { policy: "discard" }), response);
    assert.equal(response.statusCode, 409);
    assert.equal(response.body.code, "RECOVERY_PROCESS_ACTIVE");
    assert.equal(runtime.database.getRun(run.id).recoveryDecision, null);
  } finally {
    try { process.kill(-pid, "SIGKILL"); } catch { /* Already gone. */ }
  }
}));

// Regression (platform-injectable): on platforms without owned process trees
// (Windows), a gone leader with a possibly live descendant cannot be verified
// terminated. Every policy — including discard, whose recording would clear
// the submission gate and admit a new run while the original descendants may
// still mutate the worktree — stays blocked until the tree is verifiably
// terminated.
test("blocks replacement work when the process tree cannot be verified", withRuntime(async (runtime) => {
  const conversation = runtime.database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Recovery", provider: "codex" });
  const run = runtime.database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "half done" });
  runtime.database.updateRun(run.id, { status: "running", pid: 424242 });
  runtime.database.reconcileInterruptedRuns({ probeAlive: () => false });

  for (const policy of ["resume-session", "retry", "discard"]) {
    const blocked = responseCapture();
    await runtime.handleRequest(requestStream("POST", `/api/runs/${run.id}/resume`, { policy }), blocked);
    assert.equal(blocked.statusCode, 409);
    assert.equal(blocked.body.code, "RECOVERY_PROCESS_UNKNOWN");
    assert.equal(runtime.database.getRun(run.id).recoveryDecision, null);
    assert.equal(runtime.database.getRun(run.id).status, "interrupted");
    assert.deepEqual(runtime.database.listRuns(conversation.id).filter((candidate) => candidate.status === "queued"), [], "no replacement run may be scheduled");
  }
}, { recoveryProcessAlive: () => "unknown" }));

// Regression (end-to-end, platform-injectable): the round-5 bypass — a
// recorded discard clears the recovery gate, so a normal submission could
// start a second provider while the original, unverifiable process tree may
// still be mutating the same worktree. While the tree is unknown, discard
// must be rejected and new submissions must stay blocked; only once the tree
// is verifiably terminated may the discard clear the gate.
test("a discard on an unknown process tree cannot be followed by a newly scheduled run", (() => {
  let treeVerdict = "unknown";
  return withRuntime(async (runtime) => {
  const conversation = runtime.database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Recovery", provider: "codex" });
  const run = runtime.database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "half done" });
  runtime.database.updateRun(run.id, { status: "running", pid: 424242 });
  runtime.database.reconcileInterruptedRuns({ probeAlive: () => false });

  // Tree still unverifiable: discard is rejected outright.
  const discardBlocked = responseCapture();
  await runtime.handleRequest(requestStream("POST", `/api/runs/${run.id}/resume`, { policy: "discard" }), discardBlocked);
  assert.equal(discardBlocked.statusCode, 409);
  assert.equal(discardBlocked.body.code, "RECOVERY_PROCESS_UNKNOWN");

  // The bypass: even a successful-looking discard could not clear the gate,
  // but the rejected one must leave ordinary submissions blocked.
  const submission = responseCapture();
  await runtime.handleRequest(requestStream("POST", `/api/conversations/${conversation.id}/runs`, { prompt: "start fresh while the tree is unknown" }), submission);
  assert.equal(submission.statusCode, 409);
  assert.equal(submission.body.code, "RUN_RECOVERY_REQUIRED");
  assert.equal(submission.body.runId, run.id);
  assert.deepEqual(runtime.database.listRuns(conversation.id).filter((candidate) => candidate.status === "queued"), [], "no new run may be scheduled while the tree is unknown");

  // Once the tree verifiably terminated, discard succeeds and only then
  // does the submission gate open again.
  treeVerdict = "exited";
  const discarded = responseCapture();
  await runtime.handleRequest(requestStream("POST", `/api/runs/${run.id}/resume`, { policy: "discard" }), discarded);
  assert.equal(discarded.statusCode, 200);
  assert.equal(runtime.database.getRun(run.id).status, "failed");

  const reopened = responseCapture();
  await runtime.handleRequest(requestStream("POST", `/api/conversations/${conversation.id}/runs`, { prompt: "start fresh after verified termination" }), reopened);
  assert.notEqual(reopened.body?.code, "RUN_RECOVERY_REQUIRED", "the recovery gate must open only after the discard on a verified-exited tree");
  }, { recoveryProcessAlive: () => treeVerdict });
})());

test("the default recovery probe is conservative per platform", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore", detached: process.platform !== "win32" });
  const pid = child.pid;
  await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(defaultRecoveryProcessAlive(pid, "win32"), "unknown", "a gone leader is unverifiable on win32");
  assert.equal(defaultRecoveryProcessAlive(process.pid, "win32"), "alive");
  if (process.platform !== "win32") {
    assert.equal(defaultRecoveryProcessAlive(pid), "exited", "a fully dead detached group is exited on POSIX");
    const live = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore", detached: true });
    try {
      assert.equal(defaultRecoveryProcessAlive(live.pid), "alive");
      assert.equal(defaultRecoveryProcessAlive(live.pid, "win32"), "alive");
    } finally {
      try { process.kill(-live.pid, "SIGKILL"); } catch { /* Already gone. */ }
    }
  }
});

test("accepts loopback and same-origin runtime requests", () => {
  const allowedHosts = runtimeAllowedHosts({});
  assert.doesNotThrow(() => assertRuntimeRequest(request("127.0.0.1:4173", "http://127.0.0.1:4173"), allowedHosts));
  assert.doesNotThrow(() => assertRuntimeRequest(request("localhost:4173"), allowedHosts));
  assert.doesNotThrow(() => assertRuntimeRequest(request("[::1]:4173", "http://[::1]:4173"), allowedHosts));
  assert.doesNotThrow(() => assertRuntimeRequest(request("terminal.local:4173", "http://terminal.local:4173"), allowedHosts));
});

test("rejects hostile Host headers before trusting a matching Origin", () => {
  const allowedHosts = runtimeAllowedHosts({});
  assert.throws(
    () => assertRuntimeRequest(request("attacker.example", "http://attacker.example"), allowedHosts),
    (error) => error.statusCode === 403 && /host is not allowed/i.test(error.message),
  );
  assert.throws(
    () => assertRuntimeRequest(request("127.0.0.1:4173", "http://attacker.example"), allowedHosts),
    (error) => error.statusCode === 403 && /cross-origin/i.test(error.message),
  );
});

test("allows an explicitly configured runtime hostname", () => {
  const allowedHosts = runtimeAllowedHosts({ OUTRIGHT_ALLOWED_HOSTS: "outright.internal" });
  assert.doesNotThrow(() => assertRuntimeRequest(request("outright.internal:4173", "http://outright.internal:4173"), allowedHosts));
});

test("rejects non-loopback sockets even with an allowed Host header", () => {
  const allowedHosts = runtimeAllowedHosts({});
  assert.throws(
    () => assertRuntimeRequest({ headers: { host: "localhost:4173" }, socket: { remoteAddress: "192.168.1.20" } }, allowedHosts),
    (error) => error.statusCode === 403 && /loopback/i.test(error.message),
  );
  assert.doesNotThrow(() => assertRuntimeRequest({ headers: { host: "localhost:4173" }, socket: { remoteAddress: "127.0.0.1" } }, allowedHosts));
  assert.doesNotThrow(() => assertRuntimeRequest({ headers: { host: "localhost:4173" }, socket: { remoteAddress: "::1" } }, allowedHosts));
  assert.doesNotThrow(() => assertRuntimeRequest({ headers: { host: "localhost:4173" }, socket: { remoteAddress: "::ffff:127.0.0.1" } }, allowedHosts));
});
