import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertRuntimeRequest, createOutrightRuntime, defaultRecoveryProcessAlive, defaultRecoveryProcessIdentity, defaultTerminateRecoveryProcess, runtimeAllowedHosts } from "./outright-runtime.mjs";
import { createOutrightDatabase } from "./database.mjs";

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

async function deadProcessId() {
  // A pid that is guaranteed exited (and, on POSIX, a fully dead detached
  // process group), so default probes classify it verifiably exited.
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore", detached: process.platform !== "win32" });
  const pid = child.pid;
  await new Promise((resolve) => child.once("exit", resolve));
  return pid;
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

// A full harness with a real discovered, trusted git worktree and a fake
// provider CLI on PATH, so successful submissions and replacement runs can be
// exercised end-to-end through the HTTP surface. POSIX-only: the fake provider
// CLI is a shell script, so callers must skip on win32.
function withWorktreeRuntime(fn, options = {}) {
  return async () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "outright-e2e-")));
    const repo = path.join(root, "repo");
    const bin = path.join(root, "bin");
    const dataDirectory = mkdtempSync(path.join(os.tmpdir(), "outright-test-"));
    const previousPath = process.env.PATH;
    const previousDataDir = process.env.OUTRIGHT_DATA_DIR;
    let runtime;
    try {
      for (const args of [["init", repo], ["-C", repo, "config", "user.email", "test@example.com"], ["-C", repo, "config", "user.name", "Test"], ["-C", repo, "commit", "--allow-empty", "-m", "init"]]) {
        const result = spawnSync("git", args, { encoding: "utf8" });
        if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
      }
      mkdirSync(bin, { recursive: true });
      writeFileSync(path.join(bin, "codex"), "#!/bin/sh\nexit 0\n");
      chmodSync(path.join(bin, "codex"), 0o755);
      const configFile = path.join(root, "outright.config.json");
      writeFileSync(configFile, JSON.stringify({ scanRoots: [root], maxDepth: 2, maxProjects: 8 }));
      process.env.OUTRIGHT_DATA_DIR = dataDirectory;
      process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
      runtime = createOutrightRuntime({ configUrl: pathToFileURL(configFile), ...options });
      const scan = await runtime.projects();
      const project = scan.projects.find((item) => item.path === repo);
      const worktree = project?.worktrees.find((item) => !item.isLinked);
      if (!project || !worktree) throw new Error("the temp repo was not discovered as a project worktree");
      runtime.database.trustProject(project.id, project.path);
      await fn(runtime, { project, worktree });
    } finally {
      process.env.PATH = previousPath;
      if (previousDataDir === undefined) delete process.env.OUTRIGHT_DATA_DIR; else process.env.OUTRIGHT_DATA_DIR = previousDataDir;
      await runtime?.shutdown();
      rmSync(dataDirectory, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
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

test("holds an exclusive runtime lease before startup reconciliation", async () => {
  const dataDirectory = mkdtempSync(path.join(os.tmpdir(), "outright-lease-"));
  const previousDataDir = process.env.OUTRIGHT_DATA_DIR;
  process.env.OUTRIGHT_DATA_DIR = dataDirectory;
  let first;
  let replacement;
  let unexpected;
  try {
    first = createOutrightRuntime({ configUrl: "file:///nonexistent-config.json" });
    const conversation = first.database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Lease", provider: "codex" });
    const queued = first.database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "still owned" });
    assert.throws(
      () => { unexpected = createOutrightRuntime({ configUrl: "file:///nonexistent-config.json" }); },
      (error) => error?.code === "OUTRIGHT_RUNTIME_LEASE_HELD",
    );
    assert.equal(first.database.getRun(queued.id).status, "queued", "the rejected runtime must not reconcile the live owner's queue");
    await first.shutdown();
    first = null;
    replacement = createOutrightRuntime({ configUrl: "file:///nonexistent-config.json" });
  } finally {
    await first?.shutdown();
    await replacement?.shutdown();
    await unexpected?.shutdown();
    if (previousDataDir === undefined) delete process.env.OUTRIGHT_DATA_DIR; else process.env.OUTRIGHT_DATA_DIR = previousDataDir;
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

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

test("terminates an alive recovered provider before recording the recovery decision", (() => {
  let treeVerdict = "alive";
  let terminatedPid = null;
  return withRuntime(async (runtime) => {
    const conversation = runtime.database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Recovery", provider: "codex" });
    const run = runtime.database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "half done" });
    runtime.database.updateRun(run.id, { status: "running", pid: 4242 });
    writeFileSync(path.join(runtime.database.launchDirectory, `${run.id}.json`), JSON.stringify({ pid: 4242, authorized: true, processIdentity: "test:owned" }));
    runtime.database.reconcileInterruptedRuns({ probeAlive: () => true });

    const response = responseCapture();
    await runtime.handleRequest(requestStream("POST", `/api/runs/${run.id}/resume`, { policy: "discard" }), response);
    assert.equal(response.statusCode, 200);
    assert.equal(terminatedPid, 4242);
    assert.equal(runtime.database.getRun(run.id).recoveryDecision, "discard");
  }, {
    recoveryProcessAlive: () => treeVerdict,
    recoveryProcessIdentity: () => "test:owned",
    terminateRecoveryProcess: async (pid) => { terminatedPid = pid; treeVerdict = "exited"; },
  });
})());

test("keeps recovery blocked when an alive provider cannot be terminated", withRuntime(async (runtime) => {
  const conversation = runtime.database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Recovery", provider: "codex" });
  const run = runtime.database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "half done" });
  runtime.database.updateRun(run.id, { status: "running", pid: 4242 });
  writeFileSync(path.join(runtime.database.launchDirectory, `${run.id}.json`), JSON.stringify({ pid: 4242, authorized: true, processIdentity: "test:owned" }));
  runtime.database.reconcileInterruptedRuns({ probeAlive: () => true });

  const response = responseCapture();
  await runtime.handleRequest(requestStream("POST", `/api/runs/${run.id}/resume`, { policy: "discard" }), response);
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.code, "RECOVERY_PROCESS_ACTIVE");
  assert.equal(runtime.database.getRun(run.id).recoveryDecision, null);
}, { recoveryProcessAlive: () => true, recoveryProcessIdentity: () => "test:owned", terminateRecoveryProcess: async () => {}, recoveryTerminationTimeoutMs: 0 }));

test("escalates recovery termination after the graceful signal while revalidating identity", (() => {
  let treeVerdict = "alive";
  const signals = [];
  return withRuntime(async (runtime) => {
    const conversation = runtime.database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Recovery", provider: "codex" });
    const run = runtime.database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "half done" });
    runtime.database.updateRun(run.id, { status: "running", pid: 4242 });
    writeFileSync(path.join(runtime.database.launchDirectory, `${run.id}.json`), JSON.stringify({ pid: 4242, authorized: true, processIdentity: "test:owned" }));
    runtime.database.reconcileInterruptedRuns({ probeAlive: () => true });

    const response = responseCapture();
    await runtime.handleRequest(requestStream("POST", `/api/runs/${run.id}/resume`, { policy: "discard" }), response);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(runtime.database.getRun(run.id).recoveryDecision, "discard");
  }, {
    recoveryProcessAlive: () => treeVerdict,
    recoveryProcessIdentity: () => "test:owned",
    terminateRecoveryProcess: async (_pid, signal) => {
      signals.push(signal);
      if (signal === "SIGKILL") treeVerdict = "exited";
    },
    recoveryTerminationGraceMs: 0,
    recoveryTerminationTimeoutMs: 250,
  });
})());

test("never escalates to a reused provider pid", (() => {
  const signals = [];
  return withRuntime(async (runtime) => {
    const conversation = runtime.database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Recovery", provider: "codex" });
    const run = runtime.database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "half done" });
    runtime.database.updateRun(run.id, { status: "running", pid: 4242 });
    writeFileSync(path.join(runtime.database.launchDirectory, `${run.id}.json`), JSON.stringify({
      pid: 4242,
      authorized: true,
      processIdentity: "test:wrapper",
      providerPid: 4343,
      providerProcessIdentity: "test:original-provider",
    }));
    runtime.database.reconcileInterruptedRuns({ probeAlive: () => true });

    const response = responseCapture();
    await runtime.handleRequest(requestStream("POST", `/api/runs/${run.id}/resume`, { policy: "discard" }), response);

    assert.equal(response.statusCode, 409);
    assert.equal(response.body.code, "RECOVERY_PROCESS_UNKNOWN");
    assert.deepEqual(signals, ["SIGTERM"], "the reused provider pid is never sent the escalation signal");
    assert.equal(runtime.database.getRun(run.id).recoveryDecision, null);
  }, {
    recoveryProcessAlive: () => "alive",
    recoveryProcessIdentity: (pid) => pid === 4242 ? "test:wrapper" : "test:reused-provider",
    terminateRecoveryProcess: async (_pid, signal) => { signals.push(signal); },
    recoveryTerminationGraceMs: 0,
    recoveryTerminationTimeoutMs: 250,
  });
})());

// A private handshake still is not enough after PID/PGID reuse: recovery must
// compare its immutable process-start identity before sending any signal.
test("never signals a reused process group whose durable identity no longer matches", { skip: process.platform === "win32" }, withRuntime(async (runtime) => {
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
    writeFileSync(path.join(runtime.database.launchDirectory, `${run.id}.json`), JSON.stringify({ pid, authorized: true, processIdentity: "linux:original-owner" }));
    // Stale restart classification: the leader had already exited by the time
    // the restart probe ran, but the descendant still holds the process group.
    runtime.database.reconcileInterruptedRuns({ probeAlive: () => false });
    assert.equal(runtime.database.getRun(run.id).recoveryClass, "exited");

    const response = responseCapture();
    await runtime.handleRequest(requestStream("POST", `/api/runs/${run.id}/resume`, { policy: "discard" }), response);
    assert.equal(response.statusCode, 409);
    assert.equal(response.body.code, "RECOVERY_PROCESS_UNKNOWN");
    assert.equal(runtime.database.getRun(run.id).recoveryDecision, null);
    assert.doesNotThrow(() => process.kill(-pid, 0), "the mismatched process group is never signaled");
  } finally {
    try { process.kill(-pid, "SIGKILL"); } catch { /* Already gone. */ }
  }
}, { recoveryProcessIdentity: () => "linux:reused-owner" }));

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
  assert.equal(runtime.database.findUnresolvedInterruptedRun(conversation.id), undefined, "no unresolved interrupted run remains after the verified discard");

  // The gate actually reopening for a real submission (202 plus a scheduled
  // replacement run on a discovered, trusted worktree) is proven end-to-end by
  // the "opens the recovery gate" test on the real-worktree harness below.
  }, { recoveryProcessAlive: () => treeVerdict });
})());

// Regression: recovery used to validate only the selected interrupted run, so a
// conversation holding an older started run plus a newer queued run could
// schedule the queued run's replacement work while the older run's process
// tree was still live or unverifiable and mutating the same worktree.
test("blocks recovery of a newer run while an older interrupted run is unresolved", (() => {
  let treeVerdict = "unknown";
  return withRuntime(async (runtime) => {
    const conversation = runtime.database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Recovery", provider: "codex" });
    const older = runtime.database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "started before the crash" });
    const newer = runtime.database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "still queued at the crash" });
    runtime.database.updateRun(older.id, { status: "running", pid: 424242 });
    runtime.database.reconcileInterruptedRuns({ probeAlive: () => true });
    assert.equal(runtime.database.getRun(older.id).recoveryClass, "alive");
    assert.equal(runtime.database.getRun(newer.id).recoveryClass, "never-started");

    // The UI selects the newest interrupted run first. While the older run's
    // tree cannot be verified, every policy for the newer run stays blocked.
    const blocked = responseCapture();
    await runtime.handleRequest(requestStream("POST", `/api/runs/${newer.id}/resume`, { policy: "discard" }), blocked);
    assert.equal(blocked.statusCode, 409);
    assert.equal(blocked.body.code, "RECOVERY_PROCESS_UNKNOWN");
    assert.equal(runtime.database.getRun(newer.id).recoveryDecision, null);
    assert.equal(runtime.database.getRun(older.id).recoveryDecision, null);
    assert.deepEqual(runtime.database.listRuns(conversation.id).filter((candidate) => candidate.status === "queued"), [], "no replacement run may be scheduled");

    // Only once the older tree is verifiably exited may the newer run be
    // resolved — and the older run itself still awaits its own decision.
    treeVerdict = "exited";
    const newerDiscard = responseCapture();
    await runtime.handleRequest(requestStream("POST", `/api/runs/${newer.id}/resume`, { policy: "discard" }), newerDiscard);
    assert.equal(newerDiscard.statusCode, 200);
    const gate = runtime.database.findUnresolvedInterruptedRun(conversation.id);
    assert.equal(gate.id, older.id, "the submission gate stays on the older run until it is resolved too");

    const olderDiscard = responseCapture();
    await runtime.handleRequest(requestStream("POST", `/api/runs/${older.id}/resume`, { policy: "discard" }), olderDiscard);
    assert.equal(olderDiscard.statusCode, 200);
    assert.equal(runtime.database.findUnresolvedInterruptedRun(conversation.id), undefined);
  }, { recoveryProcessAlive: () => treeVerdict });
})());

// Regression: the discard branch did not check the conditional update result,
// so the loser of a concurrent decision race returned HTTP 200 with a null
// body and published a bogus resolution event.
test("concurrent discard requests resolve exactly one decision", withRuntime(async (runtime) => {
  const conversation = runtime.database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Recovery", provider: "codex" });
  const run = runtime.database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "half done" });
  runtime.database.updateRun(run.id, { status: "running", pid: 424242 });
  runtime.database.reconcileInterruptedRuns({ probeAlive: () => false });

  // Two discard decisions race: both pass the initial state check before
  // either records its decision (the probe await interleaves them).
  const first = responseCapture();
  const second = responseCapture();
  await Promise.all([
    runtime.handleRequest(requestStream("POST", `/api/runs/${run.id}/resume`, { policy: "discard" }), first),
    runtime.handleRequest(requestStream("POST", `/api/runs/${run.id}/resume`, { policy: "discard" }), second),
  ]);
  const statuses = [first.statusCode, second.statusCode].sort();
  assert.deepEqual(statuses, [200, 409], "exactly one request records the decision; the loser gets a conflict, never a null success");
  const winner = first.statusCode === 200 ? first : second;
  const loser = first.statusCode === 200 ? second : first;
  assert.equal(winner.body.recoveryDecision, "discard");
  assert.notEqual(loser.body, null, "the losing response must carry an error body");
  const discards = runtime.database.listAudit(100).filter((entry) => entry.action === "agent.run.recovery.discard");
  assert.equal(discards.length, 1, "one discard audit entry per run decision");
}, { recoveryProcessAlive: () => "exited" }));

// Regression: construction-time reconciliation is the restart entrypoint. The
// runtime must mark pre-existing pending runs interrupted when it is created,
// without a manual reconcile call.
test("startup reconciliation marks pre-existing pending runs interrupted at construction", async () => {
  const dataDirectory = mkdtempSync(path.join(os.tmpdir(), "outright-test-"));
  const previousDataDir = process.env.OUTRIGHT_DATA_DIR;
  process.env.OUTRIGHT_DATA_DIR = dataDirectory;
  let runtime;
  try {
    const seeded = createOutrightDatabase();
    const conversation = seeded.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Recovery", provider: "codex" });
    const run = seeded.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "half done" });
    const pid = await deadProcessId();
    seeded.updateRun(run.id, { status: "running", pid });
    seeded.close();

    runtime = createOutrightRuntime({ configUrl: "file:///nonexistent-config.json" });
    const recovered = runtime.database.getRun(run.id);
    assert.equal(recovered.status, "interrupted", "construction must reconcile pending rows from the previous runtime");
    assert.equal(recovered.recoveryClass, process.platform === "win32" ? "unknown" : "exited");
  } finally {
    await runtime?.shutdown();
    if (previousDataDir === undefined) delete process.env.OUTRIGHT_DATA_DIR; else process.env.OUTRIGHT_DATA_DIR = previousDataDir;
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

// End-to-end on a real discovered, trusted worktree: after a verified discard,
// the recovery gate must actually reopen — a normal submission is accepted and
// schedules a replacement run.
test("opens the recovery gate and schedules a replacement run after a verified discard", { skip: process.platform === "win32" }, withWorktreeRuntime(async (runtime, { project, worktree }) => {
  const conversation = runtime.database.createConversation({ projectId: project.id, worktreeId: worktree.id, worktreePath: worktree.path, title: "Recovery", provider: "codex" });
  const interrupted = runtime.database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "half done" });
  const pid = await deadProcessId();
  runtime.database.updateRun(interrupted.id, { status: "running", pid });
  runtime.database.reconcileInterruptedRuns({ probeAlive: () => false });

  const blocked = responseCapture();
  await runtime.handleRequest(requestStream("POST", `/api/conversations/${conversation.id}/runs`, { prompt: "silently resume" }), blocked);
  assert.equal(blocked.statusCode, 409);
  assert.equal(blocked.body.code, "RUN_RECOVERY_REQUIRED");

  const discarded = responseCapture();
  await runtime.handleRequest(requestStream("POST", `/api/runs/${interrupted.id}/resume`, { policy: "discard" }), discarded);
  assert.equal(discarded.statusCode, 200);

  const reopened = responseCapture();
  await runtime.handleRequest(requestStream("POST", `/api/conversations/${conversation.id}/runs`, { prompt: "start fresh after verified termination" }), reopened);
  assert.equal(reopened.statusCode, 202, `the gate must reopen: ${JSON.stringify(reopened.body)}`);
  assert.ok(reopened.body?.id, "the submission returns the scheduled replacement run");
  assert.notEqual(reopened.body.id, interrupted.id);
  assert.equal(runtime.database.findUnresolvedInterruptedRun(conversation.id), undefined);
  const runs = runtime.database.listRuns(conversation.id);
  assert.equal(runs.length, 2, "the replacement run is durably scheduled");
  const replacement = runs.find((candidate) => candidate.id === reopened.body.id);
  assert.ok(replacement, "the replacement run is persisted");
}, { recoveryProcessAlive: () => "exited" }));

// Regression: a verified-exited probe used to clear the interrupted run's pid
// before policy validation. A later validation failure (unavailable provider,
// no resumable session) then left the run with no process identity, so every
// later attempt was rejected RECOVERY_PROCESS_UNKNOWN and the conversation was
// permanently gated. The pid must survive until a decision actually commits.
test("a failed validation after a verified-exited probe leaves recovery retryable", { skip: process.platform === "win32" }, withWorktreeRuntime(async (runtime, { project, worktree }) => {
  const conversation = runtime.database.createConversation({ projectId: project.id, worktreeId: worktree.id, worktreePath: worktree.path, title: "Recovery", provider: "codex" });
  const interrupted = runtime.database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "half done" });
  const pid = await deadProcessId();
  runtime.database.updateRun(interrupted.id, { status: "running", pid });
  runtime.database.reconcileInterruptedRuns({ probeAlive: () => false });

  // resume-session with no recorded session fails validation after the probe.
  const failed = responseCapture();
  await runtime.handleRequest(requestStream("POST", `/api/runs/${interrupted.id}/resume`, { policy: "resume-session" }), failed);
  assert.equal(failed.statusCode, 409);
  assert.equal(failed.body.code, "NO_PROVIDER_SESSION");
  assert.equal(runtime.database.getRun(interrupted.id).pid, pid, "the verified pid is retained after the failed validation");
  assert.equal(runtime.database.getRun(interrupted.id).recoveryDecision, null);

  // The run is still retryable: a discard now succeeds instead of being
  // permanently rejected as an unverifiable tree.
  const discarded = responseCapture();
  await runtime.handleRequest(requestStream("POST", `/api/runs/${interrupted.id}/resume`, { policy: "discard" }), discarded);
  assert.equal(discarded.statusCode, 200);
  assert.equal(runtime.database.findUnresolvedInterruptedRun(conversation.id), undefined);
}, { recoveryProcessAlive: () => "exited" }));


test("the default recovery probe is conservative per platform", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore", detached: process.platform !== "win32" });
  const pid = child.pid;
  await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(defaultRecoveryProcessAlive(pid, "win32"), "unknown", "a gone leader is unverifiable on win32");
  assert.equal(defaultRecoveryProcessAlive(process.pid, "win32"), "alive");
  if (process.platform !== "win32") {
    assert.equal(defaultRecoveryProcessAlive(1234, "linux", () => [{ pid: 1234, state: "Z" }], () => {}), "exited", "a zombie-only group cannot mutate the worktree");
    assert.equal(defaultRecoveryProcessAlive(1234, "linux", () => [{ pid: 1234, state: "Z" }, { pid: 1235, state: "S" }], () => {}), "alive", "any non-zombie group member keeps recovery blocked");
    assert.equal(defaultRecoveryProcessAlive(pid), "exited", "a fully dead detached group is exited on POSIX");
    const live = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore", detached: true });
    try {
      assert.equal(defaultRecoveryProcessAlive(live.pid), "alive");
      assert.equal(defaultRecoveryProcessAlive(live.pid, "win32"), "alive");
      if (["linux", "darwin"].includes(process.platform)) {
        assert.equal(defaultRecoveryProcessIdentity(live.pid)?.startsWith(`${process.platform}:`), true, "the current process start identity is readable on supported POSIX platforms");
      }
    } finally {
      try { process.kill(-live.pid, "SIGKILL"); } catch { /* Already gone. */ }
    }
  }
});

test("recovery identities are boot-scoped and Windows taskkill supplies a whole-tree proof", () => {
  const linuxFields = Array.from({ length: 20 }, (_, index) => index + 1);
  linuxFields[19] = 424242;
  const linuxStat = `123 (node) ${linuxFields.join(" ")}`;
  const linuxIdentity = defaultRecoveryProcessIdentity(123, "linux", (filename) => filename.endsWith("boot_id") ? "boot-uuid\n" : linuxStat);
  assert.equal(linuxIdentity, "linux:boot-uuid:424242");

  const powershellCalls = [];
  const run = (executable, args, options) => {
    powershellCalls.push([executable, args, options]);
    return { status: 0, stdout: "638940000000000000:638940001234567890\r\n" };
  };
  assert.equal(defaultRecoveryProcessIdentity(456, "win32", () => "", run), "win32:638940000000000000:638940001234567890");
  assert.equal(powershellCalls[0][0], "powershell.exe");
  assert.match(powershellCalls[0][1].at(-1), /Get-Process -Id 456/);

  const taskkillCalls = [];
  const terminated = defaultTerminateRecoveryProcess(456, "SIGTERM", null, "win32", (executable, args, options) => {
    taskkillCalls.push([executable, args, options]);
    return { status: 0 };
  });
  assert.equal(terminated, true);
  assert.deepEqual(taskkillCalls, [["taskkill", ["/PID", "456", "/T", "/F"], { stdio: "ignore" }]]);

  const kills = [];
  assert.equal(defaultTerminateRecoveryProcess(456, "SIGKILL", { providerPid: 789, providerProcessIdentity: "linux:boot:1" }, "linux", null, (pid, signal) => kills.push([pid, signal])), false);
  assert.deepEqual(kills, [[789, "SIGKILL"]], "Linux escalation preserves the supervisor and targets only the revalidated provider");
});

test("macOS recovery termination stops a provider that ignores SIGTERM", {
  skip: process.platform !== "darwin",
}, async () => {
  const child = spawn(process.execPath, ["-e", [
    "process.on('SIGTERM', () => {});",
    "process.stdout.write('ready\\n');",
    "setInterval(() => {}, 1000);",
  ].join("\n")], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });

  try {
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.stdout.once("data", resolve);
    });
    const identity = defaultRecoveryProcessIdentity(child.pid, "darwin");
    assert.match(identity, /^darwin:/);

    defaultTerminateRecoveryProcess(child.pid, "SIGTERM", null, "darwin");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(defaultRecoveryProcessAlive(child.pid, "darwin"), "alive");

    defaultTerminateRecoveryProcess(child.pid, "SIGKILL", null, "darwin");
    await new Promise((resolve) => child.once("close", resolve));
    assert.equal(defaultRecoveryProcessAlive(child.pid, "darwin"), "exited");
  } finally {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already gone. */ }
  }
});

// Shared harness for the launch-crash regressions: seeds a run in the exact
// crashed state, closes the seeding database, and constructs a fresh runtime
// whose construction-time reconciliation is the restart under test.
async function withLaunchCrash({ status, handshake }, fn) {
  const dataDirectory = mkdtempSync(path.join(os.tmpdir(), "outright-test-"));
  const previousDataDir = process.env.OUTRIGHT_DATA_DIR;
  process.env.OUTRIGHT_DATA_DIR = dataDirectory;
  let runtime;
  try {
    const seeded = createOutrightDatabase();
    const conversation = seeded.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Recovery", provider: "codex" });
    const run = seeded.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "crashed mid-launch" });
    seeded.updateRun(run.id, { status, startedAt: new Date().toISOString() });
    let pid = null;
    if (handshake) {
      // The wrapper's durable self-recorded identity, written before the crash.
      pid = await deadProcessId();
      mkdirSync(seeded.launchDirectory, { recursive: true, mode: 0o700 });
      writeFileSync(path.join(seeded.launchDirectory, `${run.id}.json`), JSON.stringify({ pid, authorized: false, createdAt: new Date().toISOString() }));
    }
    seeded.close();
    runtime = createOutrightRuntime({ configUrl: "file:///nonexistent-config.json" });
    await fn({ runtime, conversation, run, pid });
  } finally {
    await runtime?.shutdown();
    if (previousDataDir === undefined) delete process.env.OUTRIGHT_DATA_DIR; else process.env.OUTRIGHT_DATA_DIR = previousDataDir;
    rmSync(dataDirectory, { recursive: true, force: true });
  }
}

// Regression (PR convergence round 2): a hard crash between the durable
// 'launching' marker and the pid/running commit used to restart as an unknown
// interrupted run with no pid — which blocked every recovery policy
// indefinitely and stranded a possibly spawned provider. The crash-safe
// launch handshake closes the window: crashing before durable process
// identity restarts as a provably never-started run with an explicit safe
// continuation.
test("a crash before durable launch identity restarts resolvable, not permanently gated", () => withLaunchCrash({ status: "launching" }, async ({ runtime, conversation, run }) => {
  const recovered = runtime.database.getRun(run.id);
  assert.equal(recovered.status, "interrupted");
  assert.equal(recovered.recoveryClass, "never-started", "the launch was provably never authorized, so it must not gate as an unverifiable tree");

  // Submissions stay gated until an explicit decision exists...
  const blocked = responseCapture();
  await runtime.handleRequest(requestStream("POST", `/api/conversations/${conversation.id}/runs`, { prompt: "continue" }), blocked);
  assert.equal(blocked.statusCode, 409);
  assert.equal(blocked.body.code, "RUN_RECOVERY_REQUIRED");

  // ...and the operator has an explicit safe continuation: a discard that
  // would previously have been rejected RECOVERY_PROCESS_UNKNOWN now
  // records the decision and clears the gate. (Retry's execution path is
  // proven on the real-worktree harness below.)
  const discarded = responseCapture();
  await runtime.handleRequest(requestStream("POST", `/api/runs/${run.id}/resume`, { policy: "discard" }), discarded);
  assert.equal(discarded.statusCode, 200, `discard must succeed: ${JSON.stringify(discarded.body)}`);
  assert.equal(runtime.database.getRun(run.id).status, "failed");
  assert.equal(runtime.database.findUnresolvedInterruptedRun(conversation.id), undefined, "the conversation is no longer gated");
}));

// The second half of the launch crash window: the wrapper recorded its
// process identity durably, but the runtime died before committing
// 'running'. Ownership must be restored from the handshake record and the
// run must remain resolvable — the wrapper exits on its own (never
// authorized) without ever starting the provider.
test("a crash after launch identity but before authorization keeps the pid and stays resolvable", () => withLaunchCrash({ status: "launching", handshake: true }, async ({ runtime, conversation, run, pid }) => {
  const recovered = runtime.database.getRun(run.id);
  assert.equal(recovered.status, "interrupted");
  assert.equal(recovered.recoveryClass, "never-started", "authorization is only issued after the running commit, so this launch provably never started the provider");
  assert.equal(recovered.pid, pid, "process ownership is restored from the handshake record");

  const discarded = responseCapture();
  await runtime.handleRequest(requestStream("POST", `/api/runs/${run.id}/resume`, { policy: "discard" }), discarded);
  assert.equal(discarded.statusCode, 200, `the run must remain resolvable by an explicit decision: ${JSON.stringify(discarded.body)}`);
  assert.equal(runtime.database.findUnresolvedInterruptedRun(conversation.id), undefined);
}));

test("conversation recovery metadata exposes the true oldest interrupted run beyond the bounded run history", withRuntime(async (runtime) => {
  const conversation = runtime.database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Recovery", provider: "codex" });
  const oldest = runtime.database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "oldest", createdAt: "2026-09-21T00:00:00.000Z" });
  runtime.database.updateRun(oldest.id, { status: "interrupted", recoveryClass: "never-started" });
  for (let index = 0; index < 205; index++) {
    runtime.database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: `newer-${index}`, status: "failed", createdAt: `2026-09-22T${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00.000Z` });
  }

  const response = responseCapture();
  await runtime.handleRequest(requestStream("GET", `/api/conversations/${conversation.id}`), response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.runs.length, 200, "run history stays bounded");
  assert.equal(response.body.runs.some((run) => run.id === oldest.id), false, "the oldest run is outside the bounded history");
  assert.equal(response.body.oldestInterruptedRun.id, oldest.id, "dedicated recovery metadata remains complete");
}));

// End-to-end on a real discovered, trusted worktree: replacement execution
// must respect conversation order. Resuming or retrying a newer never-started
// run while an older interrupted run is still unresolved must be rejected; a
// verified discard of the older run then reopens the ordered path.
test("a newer run's replacement cannot execute before the older interrupted run is resolved", { skip: process.platform === "win32" }, withWorktreeRuntime(async (runtime, { project, worktree }) => {
  const conversation = runtime.database.createConversation({ projectId: project.id, worktreeId: worktree.id, worktreePath: worktree.path, title: "Recovery", provider: "codex" });
  const older = runtime.database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "started before the crash" });
  await new Promise((resolve) => setTimeout(resolve, 5)); // distinct created_at ordering
  const newer = runtime.database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "still queued at the crash" });
  const pid = await deadProcessId();
  runtime.database.updateRun(older.id, { status: "running", pid });
  runtime.database.reconcileInterruptedRuns({ probeAlive: () => false });
  assert.equal(runtime.database.getRun(older.id).recoveryClass, "exited");
  assert.equal(runtime.database.getRun(newer.id).recoveryClass, "never-started");

  // The newer run's replacement must not execute while the older run is
  // unresolved, or a later recovery of the older run could overwrite it.
  for (const policy of ["resume-session", "retry"]) {
    const blocked = responseCapture();
    await runtime.handleRequest(requestStream("POST", `/api/runs/${newer.id}/resume`, { policy }), blocked);
    assert.equal(blocked.statusCode, 409);
    assert.equal(blocked.body.code, "RECOVERY_ORDER_REQUIRED", `policy ${policy} must respect execution order`);
    assert.equal(blocked.body.runId, older.id);
    assert.deepEqual(runtime.database.listRuns(conversation.id).filter((candidate) => ["queued", "launching", "running"].includes(candidate.status)), [], "no replacement work may be scheduled");
  }

  // Resolving the older run first reopens the ordered path.
  const discardOlder = responseCapture();
  await runtime.handleRequest(requestStream("POST", `/api/runs/${older.id}/resume`, { policy: "discard" }), discardOlder);
  assert.equal(discardOlder.statusCode, 200);

  const retryNewer = responseCapture();
  await runtime.handleRequest(requestStream("POST", `/api/runs/${newer.id}/resume`, { policy: "retry" }), retryNewer);
  assert.equal(retryNewer.statusCode, 202, `the newer run retries once the older run is resolved: ${JSON.stringify(retryNewer.body)}`);
  assert.notEqual(retryNewer.body.id, newer.id);
  const replacement = runtime.database.getRun(retryNewer.body.id);
  assert.ok(replacement, "the replacement run is durably scheduled");
  assert.equal(runtime.database.findUnresolvedInterruptedRun(conversation.id), undefined);
}, { recoveryProcessAlive: () => "exited" }));

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
