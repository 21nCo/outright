import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { PassThrough, Readable } from "node:stream";
import { execFile, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { assertRuntimeRequest, createOutrightRuntime, defaultRecoveryProcessAlive, defaultRecoveryProcessIdentity, defaultTerminateRecoveryProcess, runtimeAllowedHosts } from "./outright-runtime.mjs";
import { createOutrightDatabase } from "./database.mjs";
import { AGENT_SUPERVISOR, createAgentManager, LAUNCH_AUTHORIZED_CONTROL } from "./agent-manager.mjs";
import { createTerminalManager } from "./terminal-manager.mjs";

const execFileAsync = promisify(execFile);

if (process.env.CI && process.platform !== "win32") {
  const group = spawnSync("/bin/ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8", timeout: 1000 });
  const pgid = group.status === 0 ? group.stdout.trim() : "unavailable";
  console.error(`POSIX runtime test module ready: test=${process.pid}/${pgid} parent=${process.ppid} supervisor=${AGENT_SUPERVISOR}`);
  process.on("exit", (code) => console.error(`POSIX runtime test process exited: test=${process.pid} code=${code}`));
  process.on("uncaughtExceptionMonitor", (error) => console.error(`POSIX runtime test uncaught exception: test=${process.pid} ${error.stack ?? error}`));
}

function request(host, origin) {
  return { headers: { host, ...(origin ? { origin } : {}) } };
}

function requestStream(method, url, body) {
  const stream = new Readable({ read() {} });
  stream.method = method;
  stream.url = url;
  stream.headers = { host: "localhost:4173" };
  if (body !== undefined) stream.push(JSON.stringify(body));
  stream.push(null);
  return stream;
}

test("retention POST bodies reject null and arrays without deleting archived history", withRuntime(async (runtime) => {
  const archived = runtime.database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "Keep", provider: "codex" });
  runtime.database.updateConversation(archived.id, { archived: true });
  for (const route of ["/api/retention/cleanup", "/api/retention/delete-archived"]) {
    for (const body of [null, [], "wrong shape"]) {
      const response = responseCapture();
      await runtime.handleRequest(requestStream("POST", route, body), response);
      assert.equal(response.statusCode, 400);
      assert.ok(runtime.database.getConversation(archived.id));
    }
  }
}));

test("malformed terminal requests refuse before discovery, audit admission, or native launch", withRuntime(async (runtime) => {
  for (const body of [null, [], "wrong shape", {}, { cwd: "/tmp", name: {} },
    { cwd: "/tmp", cols: "100" }, { cwd: "/tmp", rows: 1000 }]) {
    const response = responseCapture();
    await runtime.handleRequest(requestStream("POST", "/api/terminals", body), response);
    assert.equal(response.statusCode, 400);
  }
  assert.equal(runtime.database.listAudit(100).some((entry) => entry.action === "terminal.create.requested"), false);
}));

test("conversation detail identifies the exited run awaiting its terminal storage commit", withRuntime(async (runtime) => {
  const conversation = runtime.database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "Storage recovery", provider: "codex" });
  const pending = runtime.database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "finish" });
  const sibling = runtime.database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "wait" });
  runtime.agents.isOutcomePending = (runId) => runId === pending.id;
  const result = responseCapture();
  await runtime.handleRequest(requestStream("GET", `/api/conversations/${conversation.id}`), result);
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.runs.find((run) => run.id === pending.id).outcomePending, true);
  assert.equal(result.body.runs.find((run) => run.id === sibling.id).outcomePending, false);
}));

function responseCapture() {
  return {
    statusCode: null,
    setHeader(key, value) { (this.headers ??= {})[key] = value; },
    end(payload) { this.raw = payload ?? ""; this.body = payload ? JSON.parse(payload) : null; },
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
    const { seed, ...runtimeOptions } = options;
    await seed?.(dataDirectory);
    const runtime = createOutrightRuntime({ configUrl: "file:///nonexistent-config.json", ...runtimeOptions });
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

test("runtime startup settles an orphan PTY before serving requests", withRuntime(async (runtime) => {
  const audit = runtime.database.listAudit(20);
  assert.ok(audit.some((entry) => entry.action === "terminal.unknown" && entry.target === "orphan-terminal"));
  assert.equal(runtime.database.reconcileTerminalAudit(), 0);
}, { seed(dataDirectory) {
  const database = createOutrightDatabase({ filename: path.join(dataDirectory, "outright.db") });
  try { database.auditCritical("terminal.created", { target: "orphan-terminal" }); }
  finally { database.close(); }
} }));

test("runtime startup preserves terminal ownership evidence across run reconciliation", withRuntime(async (runtime) => {
  const target = "379634b7-8989-47c5-9174-c09529b206a1";
  const marker = path.join(runtime.database.launchDirectory, `terminal-${target}.json`);
  assert.equal(existsSync(marker), true, "run-handshake sweeping must not erase the terminal owner's marker");
  assert.equal(runtime.database.terminalUnknownReservations().some((entry) => entry.target === target), true);
  assert.equal(runtime.database.listAudit(20).some((entry) => entry.action === "terminal.recovered" && entry.target === target), false);
  if (process.platform === "linux") {
    // The marker has no matching live process identity. Native recovery must
    // keep the reservation and audit pending instead of trusting a dead PID.
    assert.equal(await runtime.terminals.reconcileUnknown(), 0);
    assert.equal(runtime.terminals.capacity().active, 1);
    assert.equal(runtime.database.listAudit(20).some((entry) => entry.action === "terminal.recovered" && entry.target === target), false);
  }
}, { seed(dataDirectory) {
  const database = createOutrightDatabase({ filename: path.join(dataDirectory, "outright.db") });
  try {
    const target = "379634b7-8989-47c5-9174-c09529b206a1";
    database.auditCritical("terminal.created", { target, cwd: "/tmp",
      ownershipLabel: `com.21n.outright.terminal.${target}` });
    writeFileSync(path.join(database.launchDirectory, `terminal-${target}.json`),
      JSON.stringify({ pid: 4242, processIdentity: "linux:owned-terminal" }));
  } finally { database.close(); }
} }));

test("shutdown during archive cutover preserves a rejected queued cancellation and releases the runtime lease", async () => {
  const dataDirectory = mkdtempSync(path.join(os.tmpdir(), "outright-cutover-shutdown-"));
  const previousDataDir = process.env.OUTRIGHT_DATA_DIR;
  const filename = path.join(dataDirectory, "outright.db");
  const gate = new Int32Array(new SharedArrayBuffer(4));
  let runtime;
  let successor;
  try {
    process.env.OUTRIGHT_DATA_DIR = dataDirectory;
    runtime = createOutrightRuntime({ configUrl: "file:///nonexistent-config.json", deletionWorkerGate: gate.buffer });
    const survivor = runtime.database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "Pending work", provider: "codex" });
    const run = runtime.database.createRun({ conversationId: survivor.id, provider: "codex", approvalPolicy: "read-only", prompt: "keep this queued" });
    // Keep the manager's actual queue occupied without starting a provider.
    runtime.database.canLaunchRun = () => false;
    await runtime.agents.schedule({ conversation: survivor, run });
    const archived = runtime.database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "Old archive", provider: "codex" });
    const message = runtime.database.addMessage({ conversationId: archived.id, role: "assistant", body: "small" });
    const legacy = new Database(filename);
    legacy.prepare("UPDATE messages SET body = ? WHERE id = ?").run("x".repeat(4 * 1024 * 1024), message.id);
    legacy.close();
    runtime.database.updateConversation(archived.id, { archived: true });
    const deletion = runtime.database.deleteArchivedConversation(archived.id, archived.id);
    const deadline = Date.now() + 5000;
    while (Atomics.load(gate, 0) !== 1) {
      assert.ok(Date.now() < deadline, "archive worker did not reach cutover");
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await assert.rejects(runtime.agents.stop(run.id), (error) => error.statusCode === 503);
    await runtime.shutdown();
    await assert.rejects(deletion, (error) => error.statusCode === 503);
    const retained = new Database(filename, { readonly: true });
    try {
      assert.equal(retained.prepare("SELECT status FROM runs WHERE id = ?").get(run.id).status, "queued");
      assert.equal(retained.prepare("SELECT body FROM messages WHERE id = ?").get(message.id).body.length, 4 * 1024 * 1024);
    } finally { retained.close(); }
    successor = createOutrightRuntime({ configUrl: "file:///nonexistent-config.json" });
    const recovered = successor.database.getRun(run.id);
    assert.equal(recovered.status, "interrupted");
    assert.equal(recovered.recoveryClass, "never-started");
    const response = responseCapture();
    await successor.handleRequest(requestStream("GET", "/api/capacity"), response);
    assert.equal(response.statusCode, 200);
  } finally {
    Atomics.store(gate, 0, 2);
    Atomics.notify(gate, 0);
    await successor?.shutdown();
    await runtime?.shutdown();
    if (previousDataDir === undefined) delete process.env.OUTRIGHT_DATA_DIR;
    else process.env.OUTRIGHT_DATA_DIR = previousDataDir;
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test("a failed agent shutdown retains the runtime lease until recovery can finish", async () => {
  const dataDirectory = mkdtempSync(path.join(os.tmpdir(), "outright-shutdown-lease-"));
  const previousDataDir = process.env.OUTRIGHT_DATA_DIR;
  let runtime;
  let successor;
  let storageAvailable = false;
  let assertionFailure;
  try {
    process.env.OUTRIGHT_DATA_DIR = dataDirectory;
    runtime = createOutrightRuntime({ configUrl: "file:///nonexistent-config.json" });
    const originalShutdown = runtime.agents.shutdown;
    runtime.agents.shutdown = () => storageAvailable
      ? originalShutdown()
      : Promise.reject(Object.assign(new Error("outcome journal unavailable"), { code: "ENOSPC" }));
    await assert.rejects(runtime.shutdown(), /Runtime shutdown retains recovery ownership/);
    assert.throws(() => createOutrightRuntime({ configUrl: "file:///nonexistent-config.json" }),
      (error) => error.code === "OUTRIGHT_RUNTIME_LEASE_HELD");
    storageAvailable = true;
    await runtime.shutdown();
    successor = createOutrightRuntime({ configUrl: "file:///nonexistent-config.json" });
  } catch (error) {
    assertionFailure = error;
    throw error;
  } finally {
    storageAvailable = true;
    const cleanup = await Promise.allSettled([successor?.shutdown(), runtime?.shutdown()]);
    if (previousDataDir === undefined) delete process.env.OUTRIGHT_DATA_DIR;
    else process.env.OUTRIGHT_DATA_DIR = previousDataDir;
    let cleanupError = cleanup.find((result) => result.status === "rejected")?.reason;
    try { rmSync(dataDirectory, { recursive: true, force: true }); }
    catch (error) { cleanupError ??= error; }
    if (cleanupError && !assertionFailure) throw cleanupError;
  }
});

for (const terminalFailure of [false, true]) test(`a storage-faulted exited run ${terminalFailure ? "reports terminal disposal failure" : "releases the runtime lease"} after durable recovery`, async () => {
  const dataDirectory = mkdtempSync(path.join(os.tmpdir(), "outright-shutdown-recover-"));
  const previousDataDir = process.env.OUTRIGHT_DATA_DIR;
  let runtime;
  let successor;
  let child;
  let durableFinish;
  let durableJournal;
  try {
    process.env.OUTRIGHT_DATA_DIR = dataDirectory;
    runtime = createOutrightRuntime({ configUrl: "file:///nonexistent-config.json",
      terminalManagerFactory: (options) => {
        const manager = createTerminalManager(options);
        if (terminalFailure) {
          const dispose = manager.shutdown.bind(manager);
          manager.shutdown = async () => { await dispose(); throw new Error("terminal disposal failed"); };
        }
        return manager;
      },
      agentManagerFactory: (options) => createAgentManager({ ...options,
        validateConversation: async () => () => {},
        launchCommand: () => ({ executable: process.execPath, args: [], display: "fixture" }),
        spawnProcess: () => {
          child = new PassThrough();
          child.stdin = new PassThrough();
          child.stdout = new PassThrough();
          child.stderr = new PassThrough();
          child.stdio = [child.stdin, child.stdout, child.stderr, new PassThrough()];
          const write = child.stdin.write.bind(child.stdin);
          child.stdin.write = (chunk, ...args) => {
            const result = write(chunk, ...args);
            if (String(chunk).includes("go\n")) queueMicrotask(() => child.stdio[3].write(`${LAUNCH_AUTHORIZED_CONTROL}\n`));
            return result;
          };
          child.kill = () => true;
          return child;
        },
      }) });
    const conversation = runtime.database.createConversation({ projectId: "p", worktreeId: "w",
      worktreePath: dataDirectory, title: "Recovery", provider: "codex" });
    const run = runtime.database.createRun({ conversationId: conversation.id, provider: "codex",
      approvalPolicy: "read-only", prompt: "finish" });
    await runtime.agents.schedule({ conversation, run });
    durableFinish = runtime.database.finishRun;
    durableJournal = runtime.database.savePendingRunOutcome;
    runtime.database.finishRun = () => { throw Object.assign(new Error("SQLite full"), { code: "ENOSPC" }); };
    runtime.database.savePendingRunOutcome = () => { throw Object.assign(new Error("journal full"), { code: "ENOSPC" }); };
    child.emit("close", 0, null);
    await assert.rejects(runtime.shutdown(), (error) => error.code === "OUTRIGHT_SHUTDOWN_RECOVERY_PENDING");
    assert.throws(() => createOutrightRuntime({ configUrl: "file:///nonexistent-config.json" }),
      (error) => error.code === "OUTRIGHT_RUNTIME_LEASE_HELD");
    runtime.database.finishRun = durableFinish;
    runtime.database.savePendingRunOutcome = durableJournal;
    runtime.agents.resumeQueued();
    const completed = Promise.race([runtime.whenShutdownComplete(), new Promise((_, reject) => setTimeout(() => reject(new Error("lease did not release after recovery")), 3000))]);
    if (terminalFailure) {
      await assert.rejects(completed, /Runtime shutdown did not finish cleanly/);
      await assert.rejects(runtime.shutdown(), /Runtime shutdown did not finish cleanly/);
    } else await completed;
    successor = createOutrightRuntime({ configUrl: "file:///nonexistent-config.json" });
    assert.equal(successor.database.getRun(run.id).status, "completed");
    assert.equal(successor.database.listAudit(100).filter((entry) => entry.action === "agent.run.completed" && entry.target === run.id).length, 1);
  } finally {
    // An assertion failure must not hide behind the deliberately faulted
    // shutdown. Restore the writable methods before final cleanup.
    if (runtime && durableFinish) runtime.database.finishRun = durableFinish;
    if (runtime && durableJournal) runtime.database.savePendingRunOutcome = durableJournal;
    runtime?.agents.resumeQueued();
    try { await successor?.shutdown(); } catch { /* The assertion above owns the failure. */ }
    try { await runtime?.shutdown(); } catch { /* The assertion above owns the failure. */ }
    if (previousDataDir === undefined) delete process.env.OUTRIGHT_DATA_DIR;
    else process.env.OUTRIGHT_DATA_DIR = previousDataDir;
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test("run detail pages a migrated oversized replay tail without returning pruned output", (() => {
  let runId;
  return withRuntime(async (runtime) => {
    const deadline = Date.now() + 5_000;
    while (runtime.database.capacity().migrationStatus === "migrating" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(runtime.database.capacity().migrationStatus, "ready", "Legacy replay migration did not finish");
    const first = responseCapture();
    await runtime.handleRequest(requestStream("GET", `/api/runs/${runId}?after=0`), first);
    assert.equal(first.statusCode, 200);
    assert.ok(first.body.events[0].seq > 1);
    assert.equal(first.body.events.at(-1).seq, 40);
    assert.ok(Buffer.byteLength(first.raw) <= 8 * 1024 * 1024);
    const cursor = first.body.events[5].seq;
    const later = responseCapture();
    await runtime.handleRequest(requestStream("GET", `/api/runs/${runId}?after=${cursor}`), later);
    assert.equal(later.statusCode, 200);
    assert.deepEqual(later.body.events.map((event) => event.seq), first.body.events.slice(6).map((event) => event.seq));
  }, { seed(dataDirectory) {
    const filename = path.join(dataDirectory, "outright.db");
    const database = createOutrightDatabase({ filename });
    const chat = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "Legacy replay", provider: "codex" });
    runId = database.createRun({ conversationId: chat.id, provider: "codex", approvalPolicy: "read-only", prompt: "work" }).id;
    database.close();
    const legacy = new Database(filename);
    legacy.pragma("user_version = 0");
    const insert = legacy.prepare("INSERT INTO run_events (run_id, seq, type, payload, created_at) VALUES (?, ?, 'legacy', ?, ?)");
    const payload = JSON.stringify({ text: "x".repeat(256 * 1024) });
    legacy.transaction(() => {
      for (let seq = 1; seq <= 40; seq++) insert.run(runId, seq, payload, new Date().toISOString());
    })();
    legacy.close();
  } });
})());

test("retention HTTP rejects invalid and future cutoffs without deleting fresh archived history", withRuntime(async (runtime) => {
  const chat = runtime.database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "Fresh archive", provider: "codex" });
  runtime.database.updateConversation(chat.id, { archived: true });
  const beforeAudit = runtime.database.listAudit(500).length;
  for (const before of ["nonsense", "9999-01-01T00:00:00.000Z", new Date(Date.now() + 60_000).toISOString(),
    new Date(Date.now() + 86_400_000).toISOString().replace("Z", "+00:00")]) {
    const response = responseCapture();
    await runtime.handleRequest(requestStream("POST", "/api/retention/cleanup", { before }), response);
    assert.equal(response.statusCode, 400);
    assert.ok(runtime.database.getConversation(chat.id));
  }
  for (let index = 0; index < 20; index += 1) {
    const response = responseCapture();
    await runtime.handleRequest(requestStream("POST", "/api/retention/cleanup", { before: "invalid" }), response);
    assert.equal(response.statusCode, 400);
  }
  assert.equal(runtime.database.listAudit(500).length, beforeAudit, "malformed cleanup accumulated pending audit rows");
  const oldInstant = new Date(Date.now() - 95 * 86_400_000);
  const offsetCutoff = `${new Date(oldInstant.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 19)}+05:30`;
  for (const before of ["Jan 1 2000", offsetCutoff]) {
    const response = responseCapture();
    await runtime.handleRequest(requestStream("POST", "/api/retention/cleanup", { before }), response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.deleted, 0);
    assert.ok(runtime.database.getConversation(chat.id));
  }
  const normal = responseCapture();
  await runtime.handleRequest(requestStream("POST", "/api/retention/cleanup", {}), normal);
  assert.equal(normal.statusCode, 200);
  assert.equal(normal.body.deleted, 0);
  assert.ok(runtime.database.getConversation(chat.id));
}));

test("accepted cleanup failure records a correlated unknown outcome before returning an error", withRuntime(async (runtime) => {
  const original = runtime.database.pruneHistory;
  runtime.database.pruneHistory = async () => { throw Object.assign(new Error("cleanup interrupted"), { statusCode: 503 }); };
  try {
    const response = responseCapture();
    await runtime.handleRequest(requestStream("POST", "/api/retention/cleanup", {}), response);
    assert.equal(response.statusCode, 503);
    const entries = runtime.database.listAudit(10);
    const request = entries.find((entry) => entry.action === "retention.cleanup.requested");
    const outcome = entries.find((entry) => entry.action === "retention.cleanup.unknown");
    assert.ok(request);
    assert.equal(outcome?.details.operationId, request.details.operationId);
    assert.ok(outcome.id > request.id);
  } finally { runtime.database.pruneHistory = original; }
}));

test("runtime startup classifies an interrupted cleanup request before serving work", withRuntime(async (runtime) => {
  const entries = runtime.database.listAudit(20);
  const request = entries.find((entry) => entry.action === "retention.cleanup.requested");
  const outcome = entries.find((entry) => entry.action === "retention.cleanup.unknown");
  assert.ok(request);
  assert.equal(outcome?.details.operationId, request.details.operationId);
}, { async seed(dataDirectory) {
  const database = createOutrightDatabase({ filename: path.join(dataDirectory, "outright.db") });
  await database.auditRetentionCleanupRequested({ operationId: "interrupted-cleanup", before: "2020-01-01T00:00:00.000Z" });
  database.close();
} }));

test("retention HTTP normalizes timezone cutoffs and keeps unfinished archived runs", withRuntime(async (runtime) => {
  const database = runtime.database;
  const rows = Object.fromEntries(database.listConversations({ archived: true }).map((item) => [item.title, item]));
  const requestCleanup = async (before) => {
    const response = responseCapture();
    await runtime.handleRequest(requestStream("POST", "/api/retention/cleanup", { before }), response);
    assert.equal(response.statusCode, 200);
    return response.body;
  };
  assert.equal((await requestCleanup("Jan 1 2000")).deleted, 0);
  assert.ok(database.getConversation(rows.fresh.id));
  const cutoff = new Date(Date.now() - 95 * 86_400_000);
  const offsetCutoff = `${new Date(cutoff.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 19)}+05:30`;
  assert.equal((await requestCleanup(offsetCutoff)).deleted, 1);
  assert.equal(database.getConversation(rows.settled.id), undefined);
  for (const name of ["fresh", "queued", "active", "interrupted"]) assert.ok(database.getConversation(rows[name].id));
  const runs = Object.fromEntries(["queued", "active", "interrupted"].map((name) => [name, database.listRuns(rows[name].id)[0]]));
  database.updateRun(runs.queued.id, { status: "stopped" });
  database.updateRun(runs.active.id, { status: "completed" });
  database.resolveInterruptedRun(runs.interrupted.id, "discard");
  assert.equal((await requestCleanup(offsetCutoff)).deleted, 3);
  assert.ok(database.getConversation(rows.fresh.id));
}, { seed(dataDirectory) {
  const filename = path.join(dataDirectory, "outright.db");
  const database = createOutrightDatabase({ filename });
  try {
    const rows = Object.fromEntries(["fresh", "settled", "queued", "active", "interrupted"].map((title) => [title,
      database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title, provider: "codex" })]));
    for (const item of Object.values(rows)) database.updateConversation(item.id, { archived: true });
    for (const name of ["queued", "active", "interrupted"]) {
      const run = database.createRun({ conversationId: rows[name].id, provider: "codex", approvalPolicy: "read-only", prompt: name });
      if (name !== "queued") database.updateRun(run.id, { status: name === "active" ? "running" : "interrupted" });
    }
  } finally { database.close(); }
  const admin = new Database(filename);
  try {
    const old = new Date(Date.now() - 100 * 86_400_000).toISOString();
    for (const title of ["settled", "queued", "active", "interrupted"]) {
      admin.prepare("UPDATE conversations SET updated_at = ? WHERE title = ?").run(old, title);
    }
  } finally { admin.close(); }
} }));

test("explicit archived deletion at the HTTP boundary restores admission without exposing protected siblings", withRuntime(async (runtime) => {
  const database = runtime.database;
  database.updateSettings({ maxRetainedMiB: 64 });
  const archived = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "Recent archive", provider: "codex" });
  const live = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "Live", provider: "codex" });
  const protectedChat = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "Recoverable", provider: "codex" });
  database.updateConversation(protectedChat.id, { archived: true });
  const recovery = database.createRun({ conversationId: protectedChat.id, provider: "codex", approvalPolicy: "read-only", prompt: "recover" });
  database.updateRun(recovery.id, { status: "interrupted" });
  const filler = database.addMessage({ conversationId: archived.id, role: "assistant", body: "x".repeat(62 * 1024 * 1024) });
  const remaining = 63 * 1024 * 1024 - database.capacity().retainedBytes;
  database.upsertMessage({ ...filler, body: `${filler.body}${"x".repeat(remaining - 8)}` });
  database.updateConversation(archived.id, { archived: true });
  const ordinary = responseCapture();
  await runtime.handleRequest(requestStream("POST", "/api/retention/cleanup", {}), ordinary);
  assert.equal(ordinary.body.deleted, 0);
  assert.throws(() => database.submitRun({ conversationId: live.id, provider: "codex", approvalPolicy: "read-only", prompt: "work" }, "work"), (error) => error.statusCode === 507);
  const listing = responseCapture();
  await runtime.handleRequest(requestStream("GET", "/api/retention/archived"), listing);
  assert.deepEqual(listing.body.conversations.map((item) => item.id), [archived.id]);
  assert.equal(listing.body.conversations[0].worktreePath, "/tmp/w");
  for (const body of [{ id: archived.id }, { id: live.id, confirmation: live.id }, { id: protectedChat.id, confirmation: protectedChat.id }]) {
    const denied = responseCapture();
    await runtime.handleRequest(requestStream("POST", "/api/retention/delete-archived", body), denied);
    assert.equal(denied.statusCode, body.confirmation ? 409 : 400);
  }
  const deleted = responseCapture();
  await runtime.handleRequest(requestStream("POST", "/api/retention/delete-archived", { id: archived.id, confirmation: archived.id }), deleted);
  assert.equal(deleted.statusCode, 200);
  assert.equal(deleted.body.deleted, 1);
  assert.ok(deleted.body.capacity.availableForNewWorkBytes > 1024);
  assert.equal(database.submitRun({ conversationId: live.id, provider: "codex", approvalPolicy: "read-only", prompt: "work" }, "work").run.status, "queued");
  assert.ok(database.getRun(recovery.id));
}));

test("oversized archived HTTP deletion defers without blocking live output or capacity reads", withRuntime(async (runtime) => {
  const database = runtime.database;
  const active = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "Active", provider: "codex" });
  const running = database.createRun({ conversationId: active.id, provider: "codex", approvalPolicy: "read-only", prompt: "work" });
  database.updateRun(running.id, { status: "running" });
  const archived = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "Old", provider: "codex" });
  const message = database.addMessage({ conversationId: archived.id, role: "assistant", body: "short" });
  const legacy = new Database(database.filename);
  legacy.prepare("UPDATE messages SET body = ? WHERE id = ?").run("x".repeat(8 * 1024 * 1024), message.id);
  legacy.close();
  const oldRun = database.createRun({ conversationId: archived.id, provider: "codex", approvalPolicy: "read-only", prompt: "retained history" });
  database.updateRun(oldRun.id, { status: "completed" });
  database.updateConversation(archived.id, { archived: true });
  const deleteResponse = responseCapture();
  await runtime.handleRequest(requestStream("POST", "/api/retention/delete-archived", { id: archived.id, confirmation: archived.id }), deleteResponse);
  assert.equal(deleteResponse.statusCode, 202);
  assert.equal(deleteResponse.body.deleted, 0);
  assert.equal(deleteResponse.body.deferred, true);
  assert.equal(deleteResponse.body.capacity.cleanupPending, true);
  const hiddenRun = responseCapture();
  await runtime.handleRequest(requestStream("GET", `/api/runs/${oldRun.id}`), hiddenRun);
  assert.equal(hiddenRun.statusCode, 404, "a marked archive cannot expose a partial run history");
  assert.equal(database.canLaunchRun(), true, "deferred cleanup must leave unrelated run slots available");
  database.appendRunEvent(running.id, "progress", { text: "still writable" });
  const capacityResponse = responseCapture();
  await runtime.handleRequest(requestStream("GET", "/api/capacity"), capacityResponse);
  assert.equal(capacityResponse.statusCode, 200);
  database.updateRun(running.id, { status: "completed" });
  const deadline = Date.now() + 5_000;
  while (database.capacity().cleanupPending || database.maintenanceActive) {
    assert.ok(Date.now() < deadline, "marked HTTP deletion did not resume");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(database.listAudit().some((entry) => entry.action === "retention.archived.deleted" && entry.target === archived.id));
  assert.equal(database.canLaunchRun(), true);
}));

test("HTTP bootstrap stays available during shadow copy and preserves a concurrent write", async () => {
  const configDirectory = mkdtempSync(path.join(os.tmpdir(), "outright-shadow-http-config-"));
  const configFile = path.join(configDirectory, "outright.config.json");
  writeFileSync(configFile, JSON.stringify({ scanRoots: [], maxDepth: 1, maxProjects: 1 }));
  const copyGate = new Int32Array(new SharedArrayBuffer(4));
  const copyPhase = new Int32Array(new SharedArrayBuffer(4));
  try { await withRuntime(async (runtime) => {
    const database = runtime.database;
    const archived = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "Old", provider: "codex" });
    const message = database.addMessage({ conversationId: archived.id, role: "assistant", body: "short" });
    const legacy = new Database(database.filename);
    legacy.prepare("UPDATE messages SET body = ? WHERE id = ?").run("x".repeat(96 * 1024 * 1024), message.id);
    legacy.close();
    database.updateConversation(archived.id, { archived: true });
    const deletion = responseCapture();
    const request = runtime.handleRequest(requestStream("POST", "/api/retention/delete-archived",
      { id: archived.id, confirmation: archived.id }), deletion);
    try {
      const copyingDeadline = Date.now() + 10_000;
      while (Atomics.load(copyPhase, 0) === 0 || statSync(`${database.filename}.archive-next`, { throwIfNoEntry: false })?.size === 0) {
        assert.ok(Date.now() < copyingDeadline, "shadow copy never wrote candidate bytes");
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      assert.equal(Atomics.load(copyPhase, 0), 1, "HTTP probe did not start while VACUUM INTO was running");
      const inCopyBootstrap = responseCapture();
      const inCopyRequest = runtime.handleRequest(requestStream("GET", "/api/bootstrap"), inCopyBootstrap);
      const inCopySurvivor = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "During copy", provider: "codex" });
      await inCopyRequest;
      assert.equal(inCopyBootstrap.statusCode, 200, `in-copy bootstrap was unavailable: ${inCopyBootstrap.raw}`);
      assert.ok(database.getConversation(inCopySurvivor.id), "in-copy write was unavailable");
      const deadline = Date.now() + 5_000;
      while (Atomics.load(copyGate, 0) !== 1) {
        assert.ok(Date.now() < deadline, "HTTP cleanup did not enter shadow copy");
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      const bootstrap = responseCapture();
      await runtime.handleRequest(requestStream("GET", "/api/bootstrap"), bootstrap);
      assert.equal(bootstrap.statusCode, 200, `shadow copy blocked an unrelated bootstrap: ${bootstrap.raw}`);
      assert.equal(bootstrap.body.capacity.cleanupPending, true);
      assert.equal(database.maintenanceActive, false);
      const survivor = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "New", provider: "codex" });
      Atomics.store(copyGate, 0, 2);
      Atomics.notify(copyGate, 0);
      await request;
      assert.equal(deletion.statusCode, 202, "a stale shadow should defer after a concurrent HTTP-visible write");
      assert.ok(database.getConversation(survivor.id));
      const completed = Date.now() + 8_000;
      while (database.capacity().cleanupPending || database.maintenanceActive) {
        assert.ok(Date.now() < completed, "deferred HTTP cleanup did not resume");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(database.listAudit().some((entry) => entry.action === "retention.archived.deleted" && entry.target === archived.id));
    } finally {
      Atomics.store(copyGate, 0, 2);
      Atomics.notify(copyGate, 0);
    }
  }, { deletionCopyGate: copyGate.buffer, deletionCopyPhase: copyPhase.buffer, configUrl: pathToFileURL(configFile) })(); }
  finally { rmSync(configDirectory, { recursive: true, force: true }); }
});

test("oversized archive writer returns retryable HTTP writes while capacity remains readable", (() => {
  const lockGate = new Int32Array(new SharedArrayBuffer(4));
  return withRuntime(async (runtime) => {
    const database = runtime.database;
    const archived = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "Old", provider: "codex" });
    const message = database.addMessage({ conversationId: archived.id, role: "assistant", body: "small" });
    const legacy = new Database(database.filename);
    legacy.prepare("UPDATE messages SET body = ? WHERE id = ?").run("x".repeat(4 * 1024 * 1024), message.id);
    legacy.close();
    database.updateConversation(archived.id, { archived: true });
    const deletionResponse = responseCapture();
    const deletion = runtime.handleRequest(requestStream("POST", "/api/retention/delete-archived",
      { id: archived.id, confirmation: archived.id }), deletionResponse);
    const cleanupResponse = responseCapture();
    try {
      const deadline = Date.now() + 5000;
      while (Atomics.load(lockGate, 0) !== 1) {
        assert.ok(Date.now() < deadline, "archive writer did not acquire its lock");
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      const capacity = responseCapture();
      await runtime.handleRequest(requestStream("GET", "/api/capacity"), capacity);
      assert.equal(capacity.statusCode, 200);
      assert.equal(capacity.body.cleanupPending, true);
      const denied = responseCapture();
      await runtime.handleRequest(requestStream("POST", "/api/groups", { name: "Retry after cleanup" }), denied);
      assert.equal(denied.statusCode, 503);
      assert.match(denied.body.error, /retry shortly/);
      await runtime.handleRequest(requestStream("POST", "/api/retention/cleanup", {}), cleanupResponse);
      assert.equal(cleanupResponse.statusCode, 503, "offline maintenance must reject another cleanup before auditing it");
    } finally {
      Atomics.store(lockGate, 0, 2);
      Atomics.notify(lockGate, 0);
    }
    await deletion;
    assert.equal(deletionResponse.statusCode, 200);
    const retryCleanup = responseCapture();
    await runtime.handleRequest(requestStream("POST", "/api/retention/cleanup", {}), retryCleanup);
    assert.equal(retryCleanup.statusCode, 200);
    assert.ok(database.listAudit().some((entry) => entry.action === "retention.cleaned"),
      "successful cleanup response lost its required audit while the worker held SQLite");
    const reopened = new Database(database.filename);
    try {
      assert.equal(reopened.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'retention.cleaned'").get().count, 1,
        "cleanup response did not leave one durable completion audit");
    } finally { reopened.close(); }
    const retry = responseCapture();
    await runtime.handleRequest(requestStream("POST", "/api/groups", { name: "Retry after cleanup" }), retry);
    assert.equal(retry.statusCode, 201);
    assert.equal(database.getConversation(archived.id), undefined);
  }, { deletionWorkerGate: lockGate.buffer });
})());

test("archived HTTP cursor reaches an older selection and rejects malformed pages", withRuntime(async (runtime) => {
  const database = runtime.database;
  const firstCreated = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "First", provider: "codex" });
  database.updateConversation(firstCreated.id, { archived: true });
  for (let index = 0; index < 3; index++) {
    const row = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: `Newer ${index}`, provider: "codex" });
    database.updateConversation(row.id, { archived: true });
  }
  const oldestSelectable = database.listDeletableArchivedConversations().conversations.at(-1);
  const first = responseCapture();
  await runtime.handleRequest(requestStream("GET", "/api/retention/archived?limit=2"), first);
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.conversations.length, 2);
  assert.equal(first.body.conversations.some((row) => row.id === oldestSelectable.id), false);
  const second = responseCapture();
  await runtime.handleRequest(requestStream("GET", `/api/retention/archived?limit=2&cursor=${first.body.nextCursor}`), second);
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.conversations.some((row) => row.id === oldestSelectable.id), true);
  assert.equal(second.body.nextCursor, null);
  const deleted = responseCapture();
  await runtime.handleRequest(requestStream("POST", "/api/retention/delete-archived", { id: oldestSelectable.id, confirmation: oldestSelectable.id }), deleted);
  assert.equal(deleted.statusCode, 200);
  assert.ok(database.getConversation(first.body.conversations[0].id));
  for (const query of ["limit=101", "limit=0", "cursor=%21", "cursor="]) {
    const invalid = responseCapture();
    await runtime.handleRequest(requestStream("GET", `/api/retention/archived?${query}`), invalid);
    assert.equal(invalid.statusCode, 400);
  }
}));

test("archived HTTP pages bound serialized metadata while cursors reach long-title chats", withRuntime(async (runtime) => {
  const title = '"\n📦'.repeat(32 * 1024);
  const worktreePath = `/tmp/${"x".repeat(128 * 1024)}`;
  const ids = [];
  for (let index = 0; index < 3; index += 1) {
    const row = runtime.database.createConversation({ projectId: "p", worktreeId: "w", worktreePath,
      title: `${index}${title}`, provider: "codex" });
    runtime.database.updateConversation(row.id, { archived: true });
    ids.push(row.id);
  }
  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    assert.ok(++pages <= ids.length + 1, "archived pagination did not terminate");
    const response = responseCapture();
    const query = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : "?limit=2";
    await runtime.handleRequest(requestStream("GET", `/api/retention/archived${query}`), response);
    assert.equal(response.statusCode, 200);
    assert.ok(Buffer.byteLength(response.raw) < 16 * 1024, "archived response copied full legacy metadata");
    assert.ok(response.body.conversations.every((row) => row.title.endsWith("…") && row.worktreePath.endsWith("…")));
    seen.push(...response.body.conversations.map((row) => row.id));
    cursor = response.body.nextCursor;
  } while (cursor);
  assert.deepEqual(new Set(seen), new Set(ids), "paging skipped an eligible oversized chat");
}));

test("concurrent HTTP submissions admit only the configured queue budget", { skip: process.platform === "win32" }, withWorktreeRuntime(async (runtime, { project, worktree }) => {
  runtime.database.updateSettings({ maxQueuedRuns: 3 });
  runtime.agents.providerAvailable = async () => true;
  // Hold scheduling so admission, rather than a provider's completion speed,
  // decides the burst outcome at the HTTP boundary.
  runtime.agents.schedule = async ({ run }) => ({ id: run.id, status: run.status });
  const conversation = runtime.database.createConversation({ projectId: project.id, worktreeId: worktree.id,
    worktreePath: worktree.path, title: "Burst", provider: "codex" });
  const replies = Array.from({ length: 20 }, () => responseCapture());
  await Promise.all(replies.map((reply, index) => runtime.handleRequest(
    requestStream("POST", `/api/conversations/${conversation.id}/runs`, { prompt: `burst ${index}` }), reply)));
  assert.equal(replies.filter((reply) => reply.statusCode === 202).length, 3);
  assert.equal(replies.filter((reply) => reply.statusCode === 429).length, 17);
  assert.equal(runtime.database.capacity().queued, 3);
  assert.equal(runtime.database.messageCount(conversation.id), 3, "rejected submissions leave no message");
}));

test("capacity-reclaim deletion routes recheck queued work against actual audited headroom", async () => {
  for (const kind of ["group", "membership", "template", "trust"]) {
    await withRuntime(async (runtime) => {
      const database = runtime.database;
      database.updateSettings({ maxRetainedMiB: 64 });
      const conversation = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: kind, provider: "codex" });
      const queued = database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "waiting" });
      let url;
      let body;
      let method = "DELETE";
      if (kind === "group") url = `/api/groups/${database.createGroup("Spare group").id}`;
      else if (kind === "membership") {
        const group = database.createGroup("Membership group");
        database.setProjectGroup("spare-project", group.id);
        url = "/api/project-memberships";
        method = "PUT";
        body = { projectId: "spare-project", groupId: null };
      }
      else if (kind === "template") url = `/api/templates/${database.saveTemplate({ title: "Spare", prompt: "safe" }).id}`;
      else {
        database.trustProject("spare-project", "/tmp/spare");
        url = "/api/trust";
        body = { projectId: "spare-project" };
      }
      const filler = database.addMessage({ conversationId: conversation.id, role: "assistant", body: "x".repeat(62 * 1024 * 1024) });
      const desiredAvailable = 64 * 1024 - 50;
      const increase = database.capacity().availableForNewWorkBytes - desiredAvailable;
      assert.ok(increase > 0);
      database.upsertMessage({ ...filler, body: `${filler.body}${"x".repeat(increase)}` });
      assert.equal(database.canLaunchRun(), false);
      let wakeups = 0;
      runtime.agents.resumeQueued = () => { wakeups += 1; };
      const response = responseCapture();
      await runtime.handleRequest(requestStream(method, url, body), response);
      assert.ok([200, 204].includes(response.statusCode), `${kind} deletion succeeded`);
      // Revoking trust now commits its own audit row. That row can cost more
      // bytes than the removed trust record at this exact boundary.
      assert.equal(database.canLaunchRun(), kind !== "trust", `${kind} deletion reported incorrect launch room`);
      assert.equal(wakeups, 1, `${kind} deletion woke deferred work`);
      assert.equal(database.getRun(queued.id).status, "queued");
    })();
  }
});

test("capacity-restoring edits wake deferred runs at the launch boundary", withRuntime(async (runtime) => {
  const database = runtime.database;
  database.updateSettings({ maxRetainedMiB: 64 });
  const conversation = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w",
    title: "Conversation ".repeat(150), provider: "codex" });
  const queued = database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "waiting" });
  const group = database.createGroup("Group ".repeat(350));
  const template = database.saveTemplate({ title: "Spare", prompt: "Template ".repeat(300) });
  const filler = database.addMessage({ conversationId: conversation.id, role: "assistant", body: "x".repeat(62 * 1024 * 1024) });
  let fillerBody = filler.body;
  let wakeups = 0;
  runtime.agents.resumeQueued = () => { wakeups += 1; };
  for (const [url, method, body] of [
    ["/api/templates", "POST", { id: template.id, title: template.title, prompt: "short" }],
    [`/api/groups/${group.id}`, "PATCH", { name: "Short group" }],
    [`/api/conversations/${conversation.id}`, "PATCH", { title: "Short conversation" }],
  ]) {
    const increase = database.capacity().availableForNewWorkBytes - (64 * 1024 - 50);
    assert.ok(increase > 0);
    fillerBody += "x".repeat(increase);
    database.upsertMessage({ ...filler, body: fillerBody });
    assert.equal(database.canLaunchRun(), false);
    const response = responseCapture();
    await runtime.handleRequest(requestStream(method, url, body), response);
    assert.ok([200, 201].includes(response.statusCode), `${url} edit succeeded: ${response.raw}`);
    assert.equal(database.canLaunchRun(), true, `${url} edit restored launch room`);
    assert.equal(wakeups, 1 + ["/api/templates", `/api/groups/${group.id}`, `/api/conversations/${conversation.id}`].indexOf(url));
    assert.equal(database.getRun(queued.id).status, "queued");
  }
}));

test("moving a conversation to a shorter worktree path wakes deferred work", { skip: process.platform === "win32" }, withWorktreeRuntime(async (runtime, { project, worktree }) => {
  const database = runtime.database;
  database.updateSettings({ maxRetainedMiB: 64 });
  const conversation = database.createConversation({ projectId: project.id, worktreeId: "old", worktreePath: `/tmp/${"old".repeat(1400)}`,
    title: "Movable", provider: "codex" });
  const queued = database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "waiting" });
  const filler = database.addMessage({ conversationId: conversation.id, role: "assistant", body: "x".repeat(62 * 1024 * 1024) });
  const increase = database.capacity().availableForNewWorkBytes - (64 * 1024 - 50);
  assert.ok(increase > 0);
  database.upsertMessage({ ...filler, body: `${filler.body}${"x".repeat(increase)}` });
  assert.equal(database.canLaunchRun(), false);
  let wakeups = 0;
  runtime.agents.resumeQueued = () => { wakeups += 1; };
  const response = responseCapture();
  await runtime.handleRequest(requestStream("POST", `/api/conversations/${conversation.id}/move`,
    { projectId: project.id, worktreeId: worktree.id, worktreePath: worktree.path }), response);
  assert.equal(response.statusCode, 200, response.raw);
  assert.equal(database.canLaunchRun(), true);
  assert.equal(wakeups, 1);
  assert.equal(database.getRun(queued.id).status, "queued");
}));

test("bootstrap and retention remain reachable when default groups cannot fit the retained budget", async () => {
  const configDirectory = mkdtempSync(path.join(os.tmpdir(), "outright-budget-config-"));
  const configFile = path.join(configDirectory, "outright.config.json");
  writeFileSync(configFile, JSON.stringify({ scanRoots: [], maxDepth: 1, maxProjects: 1 }));
  try {
    await withRuntime(async (runtime) => {
  const database = runtime.database;
  database.updateSettings({ maxRetainedMiB: 64 });
  const archived = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "Reclaimable", provider: "codex" });
  const filler = database.addMessage({ conversationId: archived.id, role: "assistant", body: "x".repeat(62 * 1024 * 1024) });
  const remaining = 63 * 1024 * 1024 - database.capacity().retainedBytes;
  database.upsertMessage({ ...filler, body: `${filler.body}${"x".repeat(remaining - 300)}` });
  database.updateConversation(archived.id, { archived: true });
  const firstGroup = database.createGroup("Core systems");
  assert.throws(() => database.createGroup("Experiments"), (error) => error.statusCode === 507);
  database.deleteGroup(firstGroup.id);
  const bootstrap = responseCapture();
  await runtime.handleRequest(requestStream("GET", "/api/bootstrap"), bootstrap);
  assert.equal(bootstrap.statusCode, 200);
  assert.deepEqual(bootstrap.body.projectGroups.groups, [], "failed setup leaves no partial default group");
  assert.equal(bootstrap.body.capacity.availableForNewWorkBytes < 64 * 1024, true);
  const listing = responseCapture();
  await runtime.handleRequest(requestStream("GET", "/api/retention/archived"), listing);
  assert.deepEqual(listing.body.conversations.map((row) => row.id), [archived.id]);
  const deleted = responseCapture();
  await runtime.handleRequest(requestStream("POST", "/api/retention/delete-archived", { id: archived.id, confirmation: archived.id }), deleted);
  assert.equal(deleted.statusCode, 200);
  assert.equal(database.canLaunchRun(), true);
  const rescan = responseCapture();
  await runtime.handleRequest(requestStream("POST", "/api/projects"), rescan);
  assert.equal(rescan.statusCode, 200);
  assert.deepEqual(database.listGroups().groups.map((group) => group.name), ["Core systems", "Experiments"]);
    }, { configUrl: pathToFileURL(configFile) })();
  } finally { rmSync(configDirectory, { recursive: true, force: true }); }
});

function seedLegacyUnknownTargetDatabase(filename) {
  const legacy = new Database(filename);
  legacy.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, worktree_id TEXT NOT NULL, worktree_path TEXT NOT NULL,
      title TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', provider_session_id TEXT, tab_position INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      provider TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', reasoning_effort TEXT NOT NULL DEFAULT 'medium', approval_policy TEXT NOT NULL, prompt TEXT NOT NULL,
      status TEXT NOT NULL, pid INTEGER, provider_session_id TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
      exit_code INTEGER, error TEXT, cost_usd REAL, input_tokens INTEGER, output_tokens INTEGER,
      recovery_class TEXT, recovery_decision TEXT
    );
    INSERT INTO conversations VALUES ('legacy-conversation', 'project-1', 'tree-1', '/tmp/current-target', 'Legacy recovery', 'codex', '', NULL, 0, 0, 0, '2026-09-21T00:00:00.000Z', '2026-09-21T00:00:00.000Z');
    INSERT INTO runs VALUES ('legacy-interrupted', 'legacy-conversation', 'codex', '', 'medium', 'read-only', 'half done', 'interrupted', NULL, NULL, '2026-09-21T00:00:00.000Z', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'never-started', NULL);
  `);
  legacy.close();
}

function seedLegacyRunningUnknownTargetDatabase(filename, { secondRun = false } = {}) {
  seedLegacyUnknownTargetDatabase(filename);
  const legacy = new Database(filename);
  legacy.prepare("UPDATE runs SET status = 'running', started_at = ?, recovery_class = NULL WHERE id = 'legacy-interrupted'")
    .run("2026-09-21T00:01:00.000Z");
  if (secondRun) {
    legacy.exec(`
      INSERT INTO conversations VALUES ('other-legacy-conversation', 'removed-project', 'removed-tree', '/tmp/removed-target', 'Other legacy recovery', 'codex', '', NULL, 0, 0, 0, '2026-09-21T00:02:00.000Z', '2026-09-21T00:02:00.000Z');
      INSERT INTO runs VALUES ('other-legacy-interrupted', 'other-legacy-conversation', 'codex', '', 'medium', 'read-only', 'other half done', 'running', NULL, NULL, '2026-09-21T00:02:00.000Z', '2026-09-21T00:03:00.000Z', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
    `);
  }
  legacy.close();
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
    const previousGitTrace = process.env.GIT_TRACE2_EVENT;
    let runtime;
    try {
      // Disposable repositories must not be attached to a host Git Trace2
      // consumer that may create .git/ai entries while teardown removes them.
      process.env.GIT_TRACE2_EVENT = "0";
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
      await fn(runtime, { project, worktree, bin });
    } finally {
      process.env.PATH = previousPath;
      if (previousDataDir === undefined) delete process.env.OUTRIGHT_DATA_DIR; else process.env.OUTRIGHT_DATA_DIR = previousDataDir;
      await runtime?.shutdown();
      if (previousGitTrace === undefined) delete process.env.GIT_TRACE2_EVENT; else process.env.GIT_TRACE2_EVENT = previousGitTrace;
      rmSync(dataDirectory, { recursive: true, force: true });
      // Retain bounded cleanup retries for filesystem races outside Git.
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  };
}

const worktreeRefreshBehavior = { blockScan: false };
test("worktree create and remove report committed effects when the following scan has no utility capacity", { skip: process.platform === "win32" },
  withWorktreeRuntime(async (runtime, { project }) => {
    const create = responseCapture();
    await runtime.handleRequest(requestStream("POST", "/api/worktrees", {
      projectId: project.id, branch: "capacity-test", name: "capacity-test",
    }), create);
    assert.equal(create.statusCode, 201);
    assert.equal(create.body.refreshDeferred, true);
    assert.ok(existsSync(create.body.path));

    worktreeRefreshBehavior.blockScan = false;
    await runtime.projects(true);
    const remove = responseCapture();
    await runtime.handleRequest(requestStream("DELETE", "/api/worktrees", {
      projectId: project.id, worktreePath: create.body.path, confirmation: create.body.path,
    }), remove);
    assert.equal(remove.statusCode, 200);
    assert.equal(remove.body.removed, true);
    assert.equal(remove.body.refreshDeferred, true);
    assert.equal(existsSync(create.body.path), false);
    const actions = runtime.database.listAudit(20).map((entry) => entry.action);
    assert.ok(actions.includes("git.worktree.created"));
    assert.ok(actions.includes("git.worktree.removed"));
  }, { subprocesses: { capacity: () => ({ active: 0, limit: 8 }), run: async (file, args, options) => {
      if (worktreeRefreshBehavior.blockScan && args[2] === "rev-parse") throw Object.assign(new Error("capacity"), { code: "SUBPROCESS_CAPACITY", statusCode: 429 });
      const result = await execFileAsync(file, args, options);
      if (args[2] === "worktree" && ["add", "remove"].includes(args[3])) worktreeRefreshBehavior.blockScan = true;
      return result;
    } } }));

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

test("archived conversations reject new runs before any message or agent scheduling", withRuntime(async (runtime) => {
  const conversation = runtime.database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Archived", provider: "codex" });
  runtime.database.updateConversation(conversation.id, { archived: true });
  const rejected = responseCapture();
  await runtime.handleRequest(requestStream("POST", `/api/conversations/${conversation.id}/runs`, { prompt: "must not run" }), rejected);
  assert.equal(rejected.statusCode, 409);
  assert.equal(rejected.body.code, "CONVERSATION_ARCHIVED");
  assert.deepEqual(runtime.database.listMessages(conversation.id), []);
  assert.deepEqual(runtime.database.listRuns(conversation.id), []);
}));

test("conversation find rejects malformed queries and foreign cursors", withRuntime(async (runtime) => {
  const chat = runtime.database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Find", provider: "codex" });
  const other = runtime.database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Other", provider: "codex" });
  const foreign = runtime.database.addMessage({ conversationId: other.id, role: "user", body: "needle" });
  const own = runtime.database.addMessage({ conversationId: chat.id, role: "user", body: "own" });
  for (const suffix of ["", "?q=%20", `?q=${"a".repeat(201)}`, "?q=needle&direction=sideways", `?q=needle&after=${foreign.id}`, `?q=needle&after=${foreign.id}&origin=none`, `?q=needle&origin=${foreign.id}`, "?q=needle&wrapped=1", "?q=needle&origin=none&wrapped=1",
    "?q=needle&byteOffset=1", `?q=needle&after=${own.id}&byteOffset=1`,
    `?q=needle&after=${own.id}&origin=none&byteOffset=0`, `?q=needle&after=${own.id}&origin=none&byteOffset=99999999999999999999`,
    "?q=needle&contextOffset=1", `?q=needle&after=${own.id}&contextOffset=1`,
    `?q=needle&after=${own.id}&origin=none&contextOffset=0`, `?q=needle&after=${own.id}&origin=none&contextOffset=99999999999999999999`,
    "?q=needle&leftContextOffset=1", `?q=needle&after=${own.id}&leftContextOffset=1`,
    `?q=needle&after=${own.id}&origin=none&leftContextOffset=0`,
    `?q=needle&after=${own.id}&origin=none&leftContextOffset=99999999999999999999`,
    `?q=needle&after=${own.id}&origin=none&leftContextCased=1`]) {
    const response = responseCapture();
    await runtime.handleRequest(requestStream("GET", `/api/conversations/${chat.id}/messages/find${suffix}`), response);
    assert.equal(response.statusCode, 400, suffix);
  }
  const missing = responseCapture();
  await runtime.handleRequest(requestStream("GET", "/api/conversations/missing/messages/find?q=needle"), missing);
  assert.equal(missing.statusCode, 404);
}));

test("conversation Find HTTP carries a bounded Unicode context cursor", withRuntime(async (runtime) => {
  const chat = runtime.database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Unicode context", provider: "codex" });
  const row = runtime.database.addMessage({ conversationId: chat.id, role: "assistant",
    body: `${"a".repeat(65534)}Σ${"\u0301".repeat(4_300_000)}A` });
  let cursor = null;
  let contextOffset = 0;
  let byteOffset = 0;
  let result;
  for (let request = 0; request < 5; request += 1) {
    const params = new URLSearchParams({ q: "σ" });
    if (cursor) {
      params.set("after", cursor);
      params.set("origin", "none");
    }
    if (contextOffset) params.set("contextOffset", String(contextOffset));
    if (byteOffset) params.set("byteOffset", String(byteOffset));
    const response = responseCapture();
    await runtime.handleRequest(requestStream("GET", `/api/conversations/${chat.id}/messages/find?${params}`), response);
    assert.equal(response.statusCode, 200);
    result = response.body;
    if (!result.partial) break;
    assert.equal(result.nextAfterId, row.id);
    cursor = result.nextAfterId;
    contextOffset = result.nextContextOffset ?? 0;
    byteOffset = result.nextByteOffset ?? 0;
  }
  assert.equal(result.matchId, row.id);
}));

test("conversation forward pages and count endpoint remain scoped to one conversation", withRuntime(async (runtime) => {
  const chat = runtime.database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Forward", provider: "codex" });
  const other = runtime.database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Other", provider: "codex" });
  const ids = Array.from({ length: 5 }, (_, index) => runtime.database.addMessage({ conversationId: chat.id, role: "user", body: `row ${index}` }).id);
  const foreign = runtime.database.addMessage({ conversationId: other.id, role: "user", body: "foreign" });
  const count = responseCapture();
  await runtime.handleRequest(requestStream("GET", `/api/conversations/${chat.id}/messages/count`), count);
  assert.equal(count.statusCode, 200);
  assert.deepEqual(count.body, { total: 5 });
  const page = responseCapture();
  await runtime.handleRequest(requestStream("GET", `/api/conversations/${chat.id}/messages?after=${ids[1]}&limit=2`), page);
  assert.equal(page.statusCode, 200);
  assert.deepEqual(page.body.messages.map((message) => message.id), ids.slice(2, 4));
  assert.equal(page.body.messagePage.newerCount, 1);
  for (const suffix of [`?after=${foreign.id}`, `?before=${ids[0]}&after=${ids[1]}`]) {
    const invalid = responseCapture();
    await runtime.handleRequest(requestStream("GET", `/api/conversations/${chat.id}/messages${suffix}`), invalid);
    assert.equal(invalid.statusCode, 400);
  }
  const missing = responseCapture();
  await runtime.handleRequest(requestStream("GET", "/api/conversations/missing/messages/count"), missing);
  assert.equal(missing.statusCode, 404);
}));

test("ordinary conversation HTTP pages bound serialized bytes in both directions", withRuntime(async (runtime) => {
  const chat = runtime.database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "Large pages", provider: "codex" });
  const ids = Array.from({ length: 12 }, () => runtime.database.addMessage({ conversationId: chat.id,
    role: "assistant", body: "x".repeat(1024 * 1024), payload: { detail: "y".repeat(1024 * 1024) } }).id);
  for (const [suffix, expected] of [
    ["", ids.slice(9, 12)],
    [`/messages?before=${ids[9]}&limit=5`, ids.slice(6, 9)],
    [`/messages?after=${ids[1]}&limit=5`, ids.slice(2, 5)],
  ]) {
    const response = responseCapture();
    await runtime.handleRequest(requestStream("GET", `/api/conversations/${chat.id}${suffix}`), response);
    assert.equal(response.statusCode, 200);
    assert.ok(Buffer.byteLength(response.raw) <= 8 * 1024 * 1024 + 2048, `${suffix || "detail"} exceeded its HTTP byte budget`);
    assert.equal(response.body.messagePage.total, ids.length);
    assert.equal(response.body.messagePage.olderCount + response.body.messages.length + response.body.messagePage.newerCount, ids.length);
    assert.deepEqual(response.body.messages.map((message) => message.id), expected, `${suffix || "detail"} returned the wrong contiguous window`);
    assert.equal(response.body.messages.every((message) => message.findExcerpt && message.payloadOmitted), true);
  }
}));

test("full Find body sections stay bounded and scoped to the selected conversation", withRuntime(async (runtime) => {
  const chat = runtime.database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "Large", provider: "codex" });
  const other = runtime.database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "Other", provider: "codex" });
  const message = runtime.database.addMessage({ conversationId: chat.id, role: "assistant", body: `${"x".repeat(70000)}needle${"y".repeat(70000)}` });
  const path = `/api/conversations/${chat.id}/messages/${message.id}/body`;
  const first = responseCapture();
  await runtime.handleRequest(requestStream("GET", path), first);
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.body.length, 65536);
  assert.equal(first.body.nextOffset, 65536);
  assert.equal(first.body.hasMore, true);
  const second = responseCapture();
  await runtime.handleRequest(requestStream("GET", `${path}?offset=${first.body.nextOffset}`), second);
  assert.equal(second.statusCode, 200);
  assert.ok(second.body.body.includes("needle"));
  const mixed = runtime.database.addMessage({ conversationId: chat.id, role: "assistant", body: `${"x".repeat(65534)}🙂\0tail` });
  const mixedPath = `/api/conversations/${chat.id}/messages/${mixed.id}/body`;
  const mixedFirst = responseCapture();
  await runtime.handleRequest(requestStream("GET", mixedPath), mixedFirst);
  const mixedNext = responseCapture();
  await runtime.handleRequest(requestStream("GET", `${mixedPath}?offset=${mixedFirst.body.nextOffset}`), mixedNext);
  assert.equal(mixedFirst.statusCode, 200);
  assert.equal(mixedNext.statusCode, 200);
  assert.equal(mixedFirst.body.body + mixedNext.body.body, `${"x".repeat(65534)}🙂\0tail`);
  assert.ok(Buffer.byteLength(JSON.stringify(mixedFirst.body)) < 65536 + 1024);
  for (const invalid of [`/api/conversations/${other.id}/messages/${message.id}/body`, `${path}?offset=-1`, `${path}?offset=1.5`, `${path}?offset=999999`, `/api/conversations/${chat.id}/messages/%ZZ/body`]) {
    const reply = responseCapture();
    await runtime.handleRequest(requestStream("GET", invalid), reply);
    assert.equal(reply.statusCode, invalid.includes(other.id) ? 404 : 400);
  }
}));

async function waitForValidation(entered, pending) {
  let timer;
  try {
    await Promise.race([
      entered,
      // API errors resolve as HTTP error responses; only unexpected runtime
      // faults reject the promise, which still needs to fail this rendezvous.
      pending.then(() => { throw new Error("Run request settled before worktree validation"); }, (error) => { throw new Error("Run request rejected unexpectedly before worktree validation", { cause: error }); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Worktree validation was not reached within 5 seconds")), 5000); }),
    ]);
  } finally { clearTimeout(timer); }
}

test("archiving during asynchronous worktree validation rejects a run without durable side effects", { skip: process.platform === "win32", timeout: 20000 }, withWorktreeRuntime(async (runtime, { project, worktree }) => {
  const conversation = runtime.database.createConversation({ projectId: project.id, worktreeId: worktree.id, worktreePath: worktree.path, title: "Interleaved archive", provider: "codex" });
  const original = runtime.git.requireWorktree;
  let release;
  let entered;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  runtime.git.requireWorktree = async (...args) => { entered(); await gate; return original(...args); };
  const result = responseCapture();
  const pending = runtime.handleRequest(requestStream("POST", `/api/conversations/${conversation.id}/runs`, { prompt: "must not persist" }), result);
  try {
    await waitForValidation(waiting, pending);
    runtime.database.updateConversation(conversation.id, { archived: true });
  } finally { release(); }
  await pending;
  assert.equal(result.statusCode, 409);
  assert.equal(result.body.code, "CONVERSATION_ARCHIVED");
  assert.deepEqual(runtime.database.listMessages(conversation.id), []);
  assert.deepEqual(runtime.database.listRuns(conversation.id), []);
}));

for (const operation of ["send", "recovery"]) {
  test(`revoking trust during provider discovery rejects ${operation} before a durable commit`, { skip: process.platform === "win32", timeout: 20000 }, (() => {
    let releaseProbe;
    let enteredProbe;
    const waiting = new Promise((resolve) => { enteredProbe = resolve; });
    const gate = new Promise((resolve) => { releaseProbe = resolve; });
    return withWorktreeRuntime(async (runtime, { project, worktree }) => {
      runtime.agents.providerAvailable = async () => { enteredProbe(); await gate; return true; };
      const conversation = runtime.database.createConversation({ projectId: project.id, worktreeId: worktree.id, worktreePath: worktree.path, title: "Trust fence", provider: "codex" });
      let interrupted;
      if (operation === "recovery") {
        interrupted = runtime.database.createRun({ conversationId: conversation.id, worktreePath: worktree.path, provider: "codex", approvalPolicy: "read-only", prompt: "unfinished" });
        runtime.database.reconcileInterruptedRuns({ probeAlive: () => false });
      }
      const response = responseCapture();
      const endpoint = operation === "send" ? `/api/conversations/${conversation.id}/runs` : `/api/runs/${interrupted.id}/resume`;
      const body = operation === "send" ? { prompt: "must not persist" } : { policy: "retry" };
      const pending = runtime.handleRequest(requestStream("POST", endpoint, body), response);
      try {
        await waitForValidation(waiting, pending);
        runtime.database.untrustProject(project.id);
      } finally { releaseProbe(); }
      await pending;
      assert.equal(response.statusCode, 403);
      assert.equal(response.body.code, "PROJECT_TRUST_REQUIRED");
      assert.deepEqual(runtime.database.listMessages(conversation.id), []);
      assert.equal(runtime.database.listRuns(conversation.id).length, operation === "send" ? 0 : 1);
      if (interrupted) assert.equal(runtime.database.getRun(interrupted.id).recoveryDecision, null);
    });
  })());
}

for (const operation of ["send", "recovery"]) {
  test(`provider removal denies ${operation} before durable side effects`, { skip: process.platform === "win32", timeout: 20000 }, withWorktreeRuntime(async (runtime, { project, worktree }) => {
    runtime.agents.providerAvailable = async () => false;
    const conversation = runtime.database.createConversation({ projectId: project.id, worktreeId: worktree.id, worktreePath: worktree.path, title: "Removed provider", provider: "codex" });
    let interrupted;
    if (operation === "recovery") {
      interrupted = runtime.database.createRun({ conversationId: conversation.id, worktreePath: worktree.path, provider: "codex", approvalPolicy: "read-only", prompt: "unfinished" });
      runtime.database.reconcileInterruptedRuns({ probeAlive: () => false });
    }
    const result = responseCapture();
    await runtime.handleRequest(requestStream("POST", operation === "send" ? `/api/conversations/${conversation.id}/runs` : `/api/runs/${interrupted.id}/resume`, operation === "send" ? { prompt: "must not persist" } : { policy: "retry" }), result);
    assert.equal(result.statusCode, 409);
    assert.match(result.body.error, /CLI is not available/);
    assert.deepEqual(runtime.database.listMessages(conversation.id), []);
    assert.equal(runtime.database.listRuns(conversation.id).length, operation === "send" ? 0 : 1);
    if (interrupted) assert.equal(runtime.database.getRun(interrupted.id).recoveryDecision, null);
  }));
}

for (const operation of ["send", "recovery"]) {
  test(`slow executable provider probe stays asynchronous and bounded for ${operation}`, { skip: process.platform === "win32", timeout: 20000 }, withWorktreeRuntime(async (runtime, { project, worktree, bin }) => {
    // Exercise the real execFile --version path through each HTTP endpoint.
    // Runtime construction starts an independent display probe. Finish it
    // before replacing the fixture, so authorization cannot reuse that old
    // in-flight result instead of testing the slow executable below.
    assert.equal(await runtime.agents.providerAvailable("codex"), true);
    const probeMarker = path.join(bin, "slow-probe-ran");
    writeFileSync(path.join(bin, "codex"), `#!/bin/sh\nif [ "$1" = "--version" ]; then sleep 0.4; echo ran > '${probeMarker}'; echo 'codex test'; fi\n`);
    const conversation = runtime.database.createConversation({ projectId: project.id, worktreeId: worktree.id, worktreePath: worktree.path, title: "Probe latency", provider: "codex" });
    let interrupted;
    if (operation === "recovery") {
      interrupted = runtime.database.createRun({ conversationId: conversation.id, worktreePath: worktree.path, provider: "codex", approvalPolicy: "read-only", prompt: "unfinished" });
      runtime.database.reconcileInterruptedRuns({ probeAlive: () => false });
    }
    const response = responseCapture();
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 20);
    const started = performance.now();
    try {
      await runtime.handleRequest(requestStream("POST", operation === "send" ? `/api/conversations/${conversation.id}/runs` : `/api/runs/${interrupted.id}/resume`, operation === "send" ? { prompt: "measure probe" } : { policy: "retry" }), response);
    } finally { clearInterval(timer); }
    const elapsed = performance.now() - started;
    assert.ok(existsSync(probeMarker), `${operation} did not run the replacement executable`);
    assert.equal(readFileSync(probeMarker, "utf8").trim(), "ran", `${operation} did not complete the replacement executable`);
    assert.ok(elapsed >= 200 && elapsed < 2500, `${operation} took ${elapsed.toFixed(1)} ms with a 400 ms executable probe`);
    assert.ok(ticks >= 5, `${operation} blocked the event loop during its executable probe`);
    assert.equal(response.statusCode, 202);
  }));
}

test("validation rendezvous fails promptly when an HTTP error settles before the gate", { skip: process.platform === "win32", timeout: 20000 }, withWorktreeRuntime(async (runtime, { project, worktree }) => {
  const conversation = runtime.database.createConversation({ projectId: project.id, worktreeId: worktree.id, worktreePath: worktree.path, title: "Early rejection", provider: "codex" });
  const original = runtime.git.requireWorktree;
  let release;
  let entered;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  runtime.git.requireWorktree = async (...args) => { entered(); await gate; return original(...args); };
  const result = responseCapture();
  const pending = runtime.handleRequest(requestStream("POST", `/api/conversations/${conversation.id}/runs`, { prompt: "" }), result);
  try {
    await assert.rejects(waitForValidation(waiting, pending), /Run request settled before worktree validation/);
  } finally { release(); }
  await pending;
  assert.equal(result.statusCode, 400);
  assert.deepEqual(runtime.database.listMessages(conversation.id), []);
  assert.deepEqual(runtime.database.listRuns(conversation.id), []);
}));

test("archived interrupted chat cannot consume retry or resume decision", { skip: process.platform === "win32" }, withWorktreeRuntime(async (runtime, { project, worktree }) => {
  const conversation = runtime.database.createConversation({ projectId: project.id, worktreeId: worktree.id, worktreePath: worktree.path, title: "Archived recovery", provider: "codex" });
  // Legacy rows can predate the archive guard; simulate one without bypassing
  // the public recovery endpoint under test.
  runtime.database.updateConversation(conversation.id, { archived: true });
  const run = runtime.database.createRun({ conversationId: conversation.id, worktreePath: worktree.path, provider: "codex", approvalPolicy: "read-only", prompt: "unfinished" });
  runtime.database.reconcileInterruptedRuns({ probeAlive: () => false });
  for (const policy of ["retry", "resume-session"]) {
    const result = responseCapture();
    await runtime.handleRequest(requestStream("POST", `/api/runs/${run.id}/resume`, { policy }), result);
    assert.equal(result.statusCode, 409);
    assert.equal(result.body.code, "CONVERSATION_ARCHIVED");
    assert.equal(runtime.database.getRun(run.id).recoveryDecision, null);
    assert.equal(runtime.database.listRuns(conversation.id).length, 1);
  }
}));

test("archived replacement recovery cannot probe or signal a live sibling", (() => {
  let probes = 0;
  const signals = [];
  return withRuntime(async (runtime) => {
    const target = "/tmp/archived-shared-tree";
    const sibling = runtime.database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: target, title: "Live sibling", provider: "codex" });
    const archived = runtime.database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: target, title: "Archived owner", provider: "codex" });
    // Legacy interrupted rows may predate the archive guard.
    runtime.database.updateConversation(archived.id, { archived: true });
    const liveRun = runtime.database.createRun({ conversationId: sibling.id, worktreePath: target, provider: "codex", approvalPolicy: "read-only", prompt: "still running" });
    runtime.database.updateRun(liveRun.id, { status: "running", pid: 4242 });
    writeFileSync(path.join(runtime.database.launchDirectory, `${liveRun.id}.json`), JSON.stringify({ pid: 4242, authorized: true, processIdentity: "test:owned" }));
    const pending = runtime.database.createRun({ conversationId: archived.id, worktreePath: target, provider: "codex", approvalPolicy: "read-only", prompt: "never started" });
    runtime.database.reconcileInterruptedRuns({ probeAlive: () => true });
    const before = runtime.database.getRun(liveRun.id);

    for (const policy of ["retry", "resume-session"]) {
      const result = responseCapture();
      await runtime.handleRequest(requestStream("POST", `/api/runs/${pending.id}/resume`, { policy }), result);
      assert.equal(result.statusCode, 409);
      assert.equal(result.body.code, "CONVERSATION_ARCHIVED");
      assert.deepEqual(runtime.database.getRun(liveRun.id), before, "sibling recovery state stays untouched");
      assert.equal(runtime.database.getRun(pending.id).recoveryDecision, null);
      assert.equal(runtime.database.listRuns(archived.id).length, 1);
      assert.deepEqual(runtime.database.listMessages(archived.id), []);
    }
    assert.equal(probes, 0, "rejected replacement must not inspect live siblings");
    assert.deepEqual(signals, [], "rejected replacement must not signal providers");

    const discard = responseCapture();
    await runtime.handleRequest(requestStream("POST", `/api/runs/${pending.id}/resume`, { policy: "discard" }), discard);
    assert.equal(discard.statusCode, 200, "archived discard still cleans the worktree-wide live process");
    assert.equal(runtime.database.getRun(pending.id).recoveryDecision, "discard");
    assert.equal(runtime.database.getRun(liveRun.id).recoveryClass, "exited");
    assert.deepEqual(signals, ["SIGTERM"]);
  }, {
    recoveryProcessAlive: () => { probes += 1; return "alive"; },
    recoveryProcessIdentity: () => "test:owned",
    terminateRecoveryProcess: async (_pid, signal) => { signals.push(signal); return true; },
    recoveryTerminationTimeoutMs: 0,
  });
})());

test("legacy runs without a trustworthy target reject replacement work but allow discard", async () => {
  const dataDirectory = mkdtempSync(path.join(os.tmpdir(), "outright-legacy-runtime-"));
  const previousDataDir = process.env.OUTRIGHT_DATA_DIR;
  let runtime;
  try {
    seedLegacyUnknownTargetDatabase(path.join(dataDirectory, "outright.db"));
    process.env.OUTRIGHT_DATA_DIR = dataDirectory;
    runtime = createOutrightRuntime({ configUrl: "file:///nonexistent-config.json" });
    assert.equal(runtime.database.getRun("legacy-interrupted").worktreePath, null);

    const retry = responseCapture();
    await runtime.handleRequest(requestStream("POST", "/api/runs/legacy-interrupted/resume", { policy: "retry" }), retry);
    assert.equal(retry.statusCode, 409);
    assert.equal(retry.body.code, "RECOVERY_TARGET_UNKNOWN");
    assert.equal(runtime.database.getRun("legacy-interrupted").recoveryDecision, null);

    const discard = responseCapture();
    await runtime.handleRequest(requestStream("POST", "/api/runs/legacy-interrupted/resume", { policy: "discard" }), discard);
    assert.equal(discard.statusCode, 200);
    assert.equal(discard.body.recoveryDecision, "discard");
  } finally {
    await runtime?.shutdown();
    if (previousDataDir === undefined) delete process.env.OUTRIGHT_DATA_DIR; else process.env.OUTRIGHT_DATA_DIR = previousDataDir;
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test("legacy running rows without process ownership require explicit bounded cleanup", async () => {
  const dataDirectory = mkdtempSync(path.join(os.tmpdir(), "outright-legacy-running-runtime-"));
  const previousDataDir = process.env.OUTRIGHT_DATA_DIR;
  let runtime;
  try {
    seedLegacyRunningUnknownTargetDatabase(path.join(dataDirectory, "outright.db"), { secondRun: true });
    process.env.OUTRIGHT_DATA_DIR = dataDirectory;
    runtime = createOutrightRuntime({ configUrl: "file:///nonexistent-config.json" });
    const legacy = runtime.database.getRun("legacy-interrupted");
    assert.equal(legacy.status, "interrupted");
    assert.equal(legacy.recoveryClass, "unknown");
    assert.equal(legacy.pid, null);
    assert.equal(legacy.worktreePath, null);

    const ordinaryDiscard = responseCapture();
    await runtime.handleRequest(requestStream("POST", "/api/runs/legacy-interrupted/resume", { policy: "discard" }), ordinaryDiscard);
    assert.equal(ordinaryDiscard.statusCode, 409);
    assert.equal(ordinaryDiscard.body.code, "RECOVERY_PROCESS_UNKNOWN");

    const unconfirmed = responseCapture();
    await runtime.handleRequest(requestStream("POST", "/api/runs/legacy-interrupted/resume", { policy: "discard-unverifiable" }), unconfirmed);
    assert.equal(unconfirmed.statusCode, 400);
    assert.equal(unconfirmed.body.code, "RECOVERY_CONFIRMATION_REQUIRED");

    const cleanup = responseCapture();
    await runtime.handleRequest(requestStream("POST", "/api/runs/legacy-interrupted/resume", { policy: "discard-unverifiable", confirmation: "legacy-interrupted" }), cleanup);
    assert.equal(cleanup.statusCode, 200);
    assert.equal(cleanup.body.status, "failed");
    assert.equal(cleanup.body.recoveryDecision, "discard-unverifiable");
    assert.equal(runtime.database.listRuns("legacy-conversation").length, 1, "manual cleanup never schedules replacement work");
    assert.equal(runtime.database.getRun("other-legacy-interrupted").recoveryDecision, null, "cleanup resolves only the confirmed legacy row");
    assert.equal(runtime.database.findUnresolvedInterruptedRunForWorktree("/tmp/any-visible-worktree").id, "other-legacy-interrupted", "another unknown legacy row keeps the global gate closed");
  } finally {
    await runtime?.shutdown();
    if (previousDataDir === undefined) delete process.env.OUTRIGHT_DATA_DIR; else process.env.OUTRIGHT_DATA_DIR = previousDataDir;
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

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

test("failed startup releases its lease and preserves queued work through recovery and manager failures", async () => {
  for (const stage of ["launch directory", "retention reconciliation", "terminal manager"]) {
    const dataDirectory = mkdtempSync(path.join(os.tmpdir(), "outright-startup-lease-"));
    const previousDataDir = process.env.OUTRIGHT_DATA_DIR;
    process.env.OUTRIGHT_DATA_DIR = dataDirectory;
    let replacement;
    try {
      const seed = createOutrightDatabase();
      const conversation = seed.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Recoverable", provider: "codex" });
      const queued = seed.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "keep queued" });
      await seed.close();

      const failure = new Error(`${stage} failed`);
      const options = stage === "launch directory" ? { hardenLaunchDirectory: () => { throw failure; } }
        : stage === "retention reconciliation" ? { databaseFactory: (settings) => {
          const database = createOutrightDatabase(settings);
          database.reconcilePendingRetentionCleanup = () => { throw failure; };
          return database;
        } } : { terminalManagerFactory: () => { throw failure; } };
      assert.throws(() => createOutrightRuntime({ configUrl: "file:///nonexistent-config.json", ...options }), (error) => error === failure);
      replacement = createOutrightRuntime({ configUrl: "file:///nonexistent-config.json" });
      assert.equal(replacement.database.getRun(queued.id).status, "interrupted", `${stage} lost recoverable run state`);
      assert.equal(replacement.database.getRun(queued.id).prompt, "keep queued");
      assert.equal(replacement.database.getConversation(conversation.id)?.id, conversation.id);
    } finally {
      await replacement?.shutdown();
      if (previousDataDir === undefined) delete process.env.OUTRIGHT_DATA_DIR; else process.env.OUTRIGHT_DATA_DIR = previousDataDir;
      rmSync(dataDirectory, { recursive: true, force: true });
    }
  }
});

test("failed startup reports both construction and synchronous cleanup failures", async () => {
  const dataDirectory = mkdtempSync(path.join(os.tmpdir(), "outright-startup-errors-"));
  const previousDataDir = process.env.OUTRIGHT_DATA_DIR;
  process.env.OUTRIGHT_DATA_DIR = dataDirectory;
  const startupFailure = new Error("launch directory denied");
  const cleanupFailure = new Error("cleanup report failed");
  let replacement;
  try {
    assert.throws(() => createOutrightRuntime({ configUrl: "file:///nonexistent-config.json",
      hardenLaunchDirectory: () => { throw startupFailure; },
      databaseFactory: (options) => {
        const database = createOutrightDatabase(options);
        const close = database.closeFailedStartup.bind(database);
        database.closeFailedStartup = () => { close(); throw cleanupFailure; };
        return database;
      },
    }), (error) => error instanceof AggregateError
      && error.errors[0] === startupFailure && error.errors[1] === cleanupFailure);
    replacement = createOutrightRuntime({ configUrl: "file:///nonexistent-config.json" });
    assert.ok(replacement.database.capacity(), "the failed constructor retained its SQLite lease");
  } finally {
    await replacement?.shutdown();
    if (previousDataDir === undefined) delete process.env.OUTRIGHT_DATA_DIR;
    else process.env.OUTRIGHT_DATA_DIR = previousDataDir;
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test("large terminal audit recovery refreshes runtime capacity after startup", async () => {
  const dataDirectory = mkdtempSync(path.join(os.tmpdir(), "outright-runtime-audit-scan-"));
  const previousDataDir = process.env.OUTRIGHT_DATA_DIR;
  process.env.OUTRIGHT_DATA_DIR = dataDirectory;
  let runtime;
  try {
    const seed = createOutrightDatabase();
    await seed.close();
    const writer = new Database(path.join(dataDirectory, "outright.db"));
    const target = "54d20348-0790-4ba8-b888-e05887e48451";
    try {
      const insert = writer.prepare("INSERT INTO audit_log (action, target, details, created_at) VALUES (?, ?, ?, ?)");
      writer.transaction(() => {
        for (let index = 0; index < 3_000; index += 1) insert.run("legacy.telemetry", "", "{}", "2026-09-01T00:00:00.000Z");
        insert.run("terminal.created", target, JSON.stringify({ cwd: dataDirectory, pid: 333 }), "2026-09-01T00:00:00.000Z");
      }).immediate();
    } finally { writer.close(); }
    runtime = createOutrightRuntime({ configUrl: "file:///nonexistent-config.json",
      terminalManagerFactory: (options) => createTerminalManager({ ...options, recoverTerminal: async () => false }) });
    assert.equal(runtime.terminals.capacity().recoveryPending, true);
    const deadline = Date.now() + 10_000;
    while (runtime.terminals.capacity().recoveryPending && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(runtime.terminals.capacity().unknown, 1,
      "completed audit scan did not refresh the live terminal manager's reservations");
    assert.equal(runtime.terminals.get(target)?.status, "unknown");
  } finally {
    await runtime?.shutdown();
    if (previousDataDir === undefined) delete process.env.OUTRIGHT_DATA_DIR;
    else process.env.OUTRIGHT_DATA_DIR = previousDataDir;
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test("shutdown fences a stuck native recovery and releases the lease for a successor", async () => {
  const dataDirectory = mkdtempSync(path.join(os.tmpdir(), "outright-runtime-audit-shutdown-"));
  const previousDataDir = process.env.OUTRIGHT_DATA_DIR;
  process.env.OUTRIGHT_DATA_DIR = dataDirectory;
  let runtime;
  let successor;
  let finishRecovery;
  try {
    const target = "54d20348-0790-4ba8-b888-e05887e48452";
    const seed = createOutrightDatabase();
    seed.auditCritical("terminal.created", { target, cwd: dataDirectory, pid: 333 });
    await seed.close();
    let markRecoveryStarted;
    const recoveryStarted = new Promise((resolve) => { markRecoveryStarted = resolve; });
    const recoveryResult = new Promise((resolve) => { finishRecovery = resolve; });
    runtime = createOutrightRuntime({ configUrl: "file:///nonexistent-config.json",
      terminalManagerFactory: (options) => createTerminalManager({ ...options, recoverTerminal: () => {
        markRecoveryStarted();
        return recoveryResult;
      } }) });
    await recoveryStarted;
    await Promise.race([runtime.shutdown(), new Promise((_, reject) => setTimeout(() => reject(new Error("shutdown waited for native proof")), 250))]);
    successor = createOutrightRuntime({ configUrl: "file:///nonexistent-config.json",
      terminalManagerFactory: (options) => createTerminalManager({ ...options, recoverTerminal: async () => false }) });
    assert.equal(successor.terminals.capacity().unknown, 1);
    finishRecovery(true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(successor.terminals.capacity().unknown, 1,
      "the closed runtime released a reservation after its lease moved to a successor");
    const writer = new Database(path.join(dataDirectory, "outright.db"), { readonly: true });
    try {
      assert.equal(writer.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'terminal.recovered' AND target = ?").get(target).count, 0);
    } finally { writer.close(); }
  } finally {
    finishRecovery?.(false);
    await successor?.shutdown();
    await runtime?.shutdown();
    if (previousDataDir === undefined) delete process.env.OUTRIGHT_DATA_DIR;
    else process.env.OUTRIGHT_DATA_DIR = previousDataDir;
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

test("never signals a live numeric pid whose durable wrapper identity mismatches", (() => {
  let signals = 0;
  return withRuntime(async (runtime) => {
    const conversation = runtime.database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Recovery", provider: "codex" });
    const run = runtime.database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "half done" });
    runtime.database.updateRun(run.id, { status: "running", pid: 4242 });
    writeFileSync(path.join(runtime.database.launchDirectory, `${run.id}.json`), JSON.stringify({
      pid: 4242,
      authorized: true,
      processIdentity: "test:original-wrapper",
    }));
    runtime.database.reconcileInterruptedRuns({ probeAlive: () => true });

    const response = responseCapture();
    await runtime.handleRequest(requestStream("POST", `/api/runs/${run.id}/resume`, { policy: "discard" }), response);
    assert.equal(response.statusCode, 409);
    assert.equal(response.body.code, "RECOVERY_PROCESS_UNKNOWN");
    assert.equal(signals, 0, "identity is verified before the first termination signal");
    assert.equal(runtime.database.getRun(run.id).recoveryDecision, null);
  }, {
    recoveryProcessAlive: () => "alive",
    recoveryProcessIdentity: () => "test:reused-wrapper",
    terminateRecoveryProcess: async () => { signals += 1; },
  });
})());

// A restart-time exited verdict is a durable fact. Re-probing that numeric PID
// later would let an unrelated process reuse turn the row back into a gate or,
// worse, become a signal target.
test("does not re-probe or signal a run durably classified exited", (() => {
  let probes = 0;
  let signals = 0;
  return withRuntime(async (runtime) => {
    const conversation = runtime.database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Recovery", provider: "codex" });
    const run = runtime.database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "half done" });
    runtime.database.updateRun(run.id, { status: "running", pid: 424242 });
    runtime.database.reconcileInterruptedRuns({ probeAlive: () => false });
    assert.equal(runtime.database.getRun(run.id).recoveryClass, "exited");

    const response = responseCapture();
    await runtime.handleRequest(requestStream("POST", `/api/runs/${run.id}/resume`, { policy: "discard" }), response);
    assert.equal(response.statusCode, 200);
    assert.equal(runtime.database.getRun(run.id).recoveryDecision, "discard");
    assert.equal(probes, 0, "a reused numeric PID cannot overwrite the durable exited proof");
    assert.equal(signals, 0, "a reused numeric PID is never signaled");
  }, {
    recoveryProcessAlive: () => { probes += 1; return "alive"; },
    terminateRecoveryProcess: async () => { signals += 1; },
  });
})());

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
  runtime.database.updateRun(run.id, { recoveryClass: "unknown" });

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
  runtime.database.updateRun(run.id, { recoveryClass: "unknown" });

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

test("an interrupted run gates every conversation targeting the same worktree", withRuntime(async (runtime) => {
  const first = runtime.database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/shared-tree", title: "First", provider: "codex" });
  const sibling = runtime.database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/shared-tree", title: "Sibling", provider: "codex" });
  const other = runtime.database.createConversation({ projectId: "project-1", worktreeId: "tree-2", worktreePath: "/tmp/other-tree", title: "Other", provider: "codex" });
  const interrupted = runtime.database.createRun({ conversationId: first.id, provider: "codex", approvalPolicy: "read-only", prompt: "half done" });
  runtime.database.updateRun(interrupted.id, { status: "interrupted", recoveryClass: "unknown" });

  const loadedSibling = responseCapture();
  await runtime.handleRequest(requestStream("GET", `/api/conversations/${sibling.id}`), loadedSibling);
  assert.equal(loadedSibling.statusCode, 200);
  assert.equal(loadedSibling.body.worktreeInterruptedRun.id, interrupted.id, "sibling chats receive the worktree-wide recovery gate before submission");
  assert.deepEqual(loadedSibling.body.recoveryConversation, {
    id: first.id,
    title: "First",
    projectId: "project-1",
    worktreeId: "tree-1",
    worktreePath: "/tmp/shared-tree",
    archived: false,
    provider: "codex",
    providerSessionId: null,
  }, "the UI can route to the visible chat that owns recovery");

  const blocked = responseCapture();
  await runtime.handleRequest(requestStream("POST", `/api/conversations/${sibling.id}/runs`, { prompt: "start from another chat" }), blocked);
  assert.equal(blocked.statusCode, 409);
  assert.equal(blocked.body.code, "RUN_RECOVERY_REQUIRED");
  assert.equal(blocked.body.runId, interrupted.id);

  const unrelated = responseCapture();
  await runtime.handleRequest(requestStream("POST", `/api/conversations/${other.id}/runs`, { prompt: "different checkout" }), unrelated);
  assert.notEqual(unrelated.body.code, "RUN_RECOVERY_REQUIRED", "a different worktree is not recovery-gated by this run");
}));

test("unresolved recovery cannot be moved or archived away from its original worktree gate", withRuntime(async (runtime) => {
  const owner = runtime.database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/original-tree", title: "Owner", provider: "codex" });
  const originalSibling = runtime.database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/original-tree", title: "Original sibling", provider: "codex" });
  const destination = runtime.database.createConversation({ projectId: "project-2", worktreeId: "tree-2", worktreePath: "/tmp/destination-tree", title: "Destination", provider: "codex" });
  const interrupted = runtime.database.createRun({ conversationId: owner.id, provider: "codex", approvalPolicy: "read-only", prompt: "half done" });
  runtime.database.updateRun(interrupted.id, { status: "interrupted", recoveryClass: "never-started" });

  const moved = responseCapture();
  await runtime.handleRequest(requestStream("POST", `/api/conversations/${owner.id}/move`, { projectId: "project-2", worktreeId: "tree-2", worktreePath: "/tmp/destination-tree" }), moved);
  assert.equal(moved.statusCode, 409);
  assert.match(moved.body.error, /before moving/);
  assert.equal(runtime.database.getConversation(owner.id).worktreePath, "/tmp/original-tree");
  assert.equal(runtime.database.getRun(interrupted.id).worktreePath, "/tmp/original-tree");

  const archived = responseCapture();
  await runtime.handleRequest(requestStream("PATCH", `/api/conversations/${owner.id}`, { archived: true }), archived);
  assert.equal(archived.statusCode, 409);
  assert.match(archived.body.error, /before archiving/);
  assert.equal(runtime.database.getConversation(owner.id).archived, 0);

  const originalBlocked = responseCapture();
  await runtime.handleRequest(requestStream("POST", `/api/conversations/${originalSibling.id}/runs`, { prompt: "must stay blocked" }), originalBlocked);
  assert.equal(originalBlocked.statusCode, 409);
  assert.equal(originalBlocked.body.runId, interrupted.id);

  const destinationSubmission = responseCapture();
  await runtime.handleRequest(requestStream("POST", `/api/conversations/${destination.id}/runs`, { prompt: "independent destination" }), destinationSubmission);
  assert.notEqual(destinationSubmission.body.code, "RUN_RECOVERY_REQUIRED", "the unresolved run never transfers its gate to the destination");
}));

test("archived legacy recovery owners can be surfaced and unarchived from a sibling chat", withRuntime(async (runtime) => {
  const owner = runtime.database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/archived-recovery", title: "Archived owner", provider: "codex" });
  runtime.database.updateConversation(owner.id, { archived: true });
  const sibling = runtime.database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/archived-recovery", title: "Visible sibling", provider: "codex" });
  const interrupted = runtime.database.createRun({ conversationId: owner.id, provider: "codex", approvalPolicy: "read-only", prompt: "half done" });
  runtime.database.updateRun(interrupted.id, { status: "interrupted", recoveryClass: "never-started" });

  const loadedSibling = responseCapture();
  await runtime.handleRequest(requestStream("GET", `/api/conversations/${sibling.id}`), loadedSibling);
  assert.equal(loadedSibling.statusCode, 200);
  assert.equal(loadedSibling.body.worktreeInterruptedRun.id, interrupted.id);
  assert.equal(loadedSibling.body.recoveryConversation.id, owner.id);
  assert.equal(loadedSibling.body.recoveryConversation.archived, true);

  const unarchived = responseCapture();
  await runtime.handleRequest(requestStream("PATCH", `/api/conversations/${owner.id}`, { archived: false }), unarchived);
  assert.equal(unarchived.statusCode, 200);
  assert.equal(unarchived.body.archived, 0);
  assert.equal(runtime.database.listConversations({ projectId: "project-1", worktreeId: "tree-1" }).some((item) => item.id === owner.id), true);
}));

test("recovery verifies unresolved runs from sibling conversations on the worktree", withRuntime(async (runtime) => {
  const first = runtime.database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/shared-tree", title: "First", provider: "codex" });
  const sibling = runtime.database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/shared-tree", title: "Sibling", provider: "codex" });
  const uncertain = runtime.database.createRun({ conversationId: first.id, provider: "codex", approvalPolicy: "read-only", prompt: "possibly active" });
  runtime.database.updateRun(uncertain.id, { status: "interrupted", recoveryClass: "unknown" });
  const selected = runtime.database.createRun({ conversationId: sibling.id, provider: "codex", approvalPolicy: "read-only", prompt: "never started" });
  runtime.database.updateRun(selected.id, { status: "interrupted", recoveryClass: "never-started" });

  const response = responseCapture();
  await runtime.handleRequest(requestStream("POST", `/api/runs/${selected.id}/resume`, { policy: "discard" }), response);
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.code, "RECOVERY_PROCESS_UNKNOWN");
  assert.equal(response.body.runId, uncertain.id);
  assert.equal(runtime.database.getRun(selected.id).recoveryDecision, null, "the selected decision stays pending while sibling ownership is uncertain");
}));

test("persists verified exit proofs for every sibling before resolving the selected run", (() => {
  const live = new Set([424201, 424202]);
  let probes = 0;
  return withRuntime(async (runtime) => {
    const first = runtime.database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/shared-owned-tree", title: "First", provider: "codex" });
    const sibling = runtime.database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/shared-owned-tree", title: "Sibling", provider: "codex" });
    const older = runtime.database.createRun({ conversationId: first.id, provider: "codex", approvalPolicy: "read-only", prompt: "older active run" });
    const selected = runtime.database.createRun({ conversationId: sibling.id, provider: "codex", approvalPolicy: "read-only", prompt: "selected active run" });
    for (const [run, pid] of [[older, 424201], [selected, 424202]]) {
      runtime.database.updateRun(run.id, { status: "running", pid });
      writeFileSync(path.join(runtime.database.launchDirectory, `${run.id}.json`), JSON.stringify({ pid, authorized: true, processIdentity: `test:${pid}` }));
    }
    runtime.database.reconcileInterruptedRuns({ probeAlive: () => true });

    const selectedDiscard = responseCapture();
    await runtime.handleRequest(requestStream("POST", `/api/runs/${selected.id}/resume`, { policy: "discard" }), selectedDiscard);
    assert.equal(selectedDiscard.statusCode, 200);
    assert.equal(runtime.database.getRun(older.id).recoveryClass, "exited", "the sibling's termination proof is durable before its own decision");
    assert.equal(runtime.database.getRun(selected.id).recoveryClass, "exited");
    const probesAfterFirstDecision = probes;

    const olderDiscard = responseCapture();
    await runtime.handleRequest(requestStream("POST", `/api/runs/${older.id}/resume`, { policy: "discard" }), olderDiscard);
    assert.equal(olderDiscard.statusCode, 200);
    assert.equal(probes, probesAfterFirstDecision, "the later decision does not need a vanished platform ownership object");
  }, {
    recoveryProcessAlive: (pid) => { probes += 1; return live.has(pid) ? "alive" : "unknown"; },
    recoveryProcessIdentity: (pid) => `test:${pid}`,
    terminateRecoveryProcess: async (pid) => { live.delete(pid); return true; },
  });
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
      if (process.platform === "linux") {
        assert.equal(defaultRecoveryProcessIdentity(live.pid)?.startsWith("linux:"), true, "the current process start identity is readable on Linux");
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

  // Darwin ownership is covered with injected sysctl and ps results because a
  // live generic wrapper token is required; tokenless live processes fail closed.
  const ownershipToken = "00000000-0000-4000-8000-000000000001";
  const darwinRun = (executable) => executable === "/usr/sbin/sysctl"
    ? { status: 0, stdout: "{ sec = 123, usec = 456 }\n" }
    : { status: 0, stdout: `outright-agent-${ownershipToken}\n` };
  assert.equal(
    defaultRecoveryProcessIdentity(123, "darwin", () => "", darwinRun, ownershipToken),
    `darwin:{ sec = 123, usec = 456 }:${ownershipToken}`,
  );
  assert.equal(defaultRecoveryProcessIdentity(123, "darwin", () => "", darwinRun), null, "tokenless legacy Darwin handshakes fail closed");
  assert.equal(
    defaultRecoveryProcessIdentity(123, "darwin", () => "", (executable) => executable === "/usr/sbin/sysctl"
      ? { status: 0, stdout: "{ sec = 123, usec = 456 }\n" }
      : { status: 0, stdout: "outright-agent-another-owner\n" }, ownershipToken),
    null,
    "a recycled pid with a different ownership title is rejected",
  );
  if (process.platform !== "win32") {
    const platformOwnershipId = `com.21n.outright.${ownershipToken}`;
    const launchdRun = (executable) => executable === "/usr/sbin/sysctl"
      ? { status: 0, stdout: "{ sec = 123, usec = 456 }\n" }
      : executable === AGENT_SUPERVISOR
        ? { status: 0, stdout: "alive\n" }
        : { status: 0, stdout: "active count = 1\nruns = 1\n" };
    const launchdHandshake = { ownershipToken, platformOwnershipId };
    assert.equal(defaultRecoveryProcessAlive(123, "darwin", () => null, () => {}, launchdHandshake, launchdRun), "alive", "the launchd job remains the ownership proof after its wrapper exits");
    assert.equal(
      defaultRecoveryProcessIdentity(123, "darwin", () => "", launchdRun, ownershipToken, platformOwnershipId),
      `darwin:{ sec = 123, usec = 456 }:${ownershipToken}`,
    );
    const bootouts = [];
    assert.equal(defaultTerminateRecoveryProcess(123, "SIGTERM", launchdHandshake, "darwin", (executable, args) => {
      bootouts.push([executable, args]);
      return { status: 0 };
    }), true, "the coalition helper proves that every member was terminated");
    assert.deepEqual(bootouts, [[AGENT_SUPERVISOR, ["--terminate", platformOwnershipId]]]);

    const wrapperIdentity = `darwin:{ sec = 123, usec = 456 }:${ownershipToken}`;
    const supervisorIdentity = "darwin-process:{ sec = 123, usec = 456 }:Mon Sep 22 01:02:03 2026";
    const missingJobHandshake = {
      ...launchdHandshake,
      processIdentity: wrapperIdentity,
      providerPid: 456,
      providerProcessIdentity: supervisorIdentity,
    };
    const missingJobRun = (executable, args = []) => {
      if (executable === AGENT_SUPERVISOR) return { status: 3, stdout: "absent\n" };
      if (executable === "/usr/sbin/sysctl") return { status: 0, stdout: "{ sec = 123, usec = 456 }\n" };
      if (executable === "/bin/launchctl") return { status: 3, stdout: "" };
      if (args.includes("lstart=")) return { status: 0, stdout: "Mon Sep 22 01:02:03 2026\n" };
      return { status: 0, stdout: `outright-agent-${ownershipToken}\n` };
    };
    assert.equal(
      defaultRecoveryProcessAlive(123, "darwin", () => null, () => {}, missingJobHandshake, missingJobRun),
      "unknown",
      "an authorized live wrapper with no launchd job is an unresolved launch, never an exited tree",
    );
    const deadWrapperRun = (executable) => executable === AGENT_SUPERVISOR
      ? { status: 3, stdout: "absent\n" }
      : executable === "/usr/sbin/sysctl"
        ? { status: 0, stdout: "{ sec = 123, usec = 456 }\n" }
        : { status: 3, stdout: "" };
    assert.equal(
      defaultRecoveryProcessAlive(123, "darwin", () => null, () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); }, missingJobHandshake, deadWrapperRun),
      "exited",
      "an absent job and absent wrapper together prove the unique launch owner exited",
    );
    const liveSupervisorRun = (executable, args = []) => {
      if (executable === AGENT_SUPERVISOR) return { status: 3, stdout: "absent\n" };
      if (executable === "/usr/sbin/sysctl") return { status: 0, stdout: "{ sec = 123, usec = 456 }\n" };
      if (args.includes("lstart=")) return { status: 0, stdout: "Mon Sep 22 01:02:03 2026\n" };
      return { status: 3, stdout: "" };
    };
    assert.equal(
      defaultRecoveryProcessAlive(123, "darwin", () => null, () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); }, missingJobHandshake, liveSupervisorRun),
      "unknown",
      "an identity-matched gated supervisor can still submit after its wrapper exits",
    );
    const failedSupervisorProbe = (executable) => executable === AGENT_SUPERVISOR
      ? { status: 3, stdout: "absent\n" }
      : { status: 1, stdout: "" };
    assert.equal(
      defaultRecoveryProcessAlive(123, "darwin", () => null, (pid) => {
        if (pid === 456) return;
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      }, missingJobHandshake, failedSupervisorProbe),
      "unknown",
      "a failed supervisor identity probe is uncertainty, not proof of exit",
    );
    assert.equal(
      defaultRecoveryProcessAlive(123, "darwin", () => null, (pid) => {
        if (pid === -123) return;
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      }, missingJobHandshake, deadWrapperRun),
      "unknown",
      "an in-flight launchctl child keeps the wrapper-owned process group unresolved",
    );
    let launchdProbe = 0;
    assert.equal(
      defaultRecoveryProcessAlive(123, "darwin", () => null, () => {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      }, missingJobHandshake, (executable) => executable === AGENT_SUPERVISOR
        ? { status: 0, stdout: ++launchdProbe === 1 ? "absent\n" : "alive\n" }
        : { status: 3, stdout: "" }),
      "alive",
      "recovery rechecks launchd after submit exits instead of accepting a stale absent sample",
    );
    assert.equal(
      defaultRecoveryProcessAlive(123, "darwin", () => null, () => {}, missingJobHandshake, (executable) => executable === AGENT_SUPERVISOR
        ? { status: 3, stdout: "exited\n" }
        : { status: 1, stdout: "" }),
      "exited",
      "an existing job with an empty coalition is a direct kernel exit proof",
    );
  }

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
