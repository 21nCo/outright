import assert from "node:assert/strict";
import test from "node:test";
import { createTerminalManager } from "./terminal-manager.mjs";
import { openTerminalHistory, probeWindowsHistoryAcl, windowsAclPrivate } from "./terminal-history.mjs";
import { reattachNonce, reattachProof } from "./terminal-reattach-proof.mjs";
import { cleanupTerminalSocket, readReattachRecord, reattachManagedTerminal, reattachToken, recordTerminalEmpty, recoverManagedTerminal, terminalOwnership,
  writeReattachRecord } from "./managed-terminal.mjs";
import { createSubprocessBudget } from "./subprocess-budget.mjs";
import { createOutrightDatabase } from "./database.mjs";
import { AUDIT_RETENTION_LIMIT, auditTrimSql, trimAudit, trimAuditPage } from "./audit-retention.mjs";
import { createOutrightRuntime } from "./outright-runtime.mjs";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { execFile, spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";

test("creates a PTY, accepts input, and retains reconnectable output", async () => {
  const events = [];
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-managed-pty-"));
  const database = createOutrightDatabase({ filename: path.join(directory, "runtime.db"), runtimeLease: true });
  const manager = createTerminalManager({ publish: (event) => events.push(event), database });
  try {
    const terminal = await manager.create({ cwd: process.cwd(), name: "Test terminal" });
    // Match the manager's configured shell and avoid matching echoed input.
    const shell = process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "/bin/sh");
    const command = /(?:^|[\\/])(?:powershell|pwsh)(?:\.exe)?$/i.test(shell)
      ? "Write-Output ('outright-' + 'terminal-ok')\r"
      : /(?:^|[\\/])cmd(?:\.exe)?$/i.test(shell)
        ? "echo outright-^terminal-ok\r"
        : "printf 'outright-%s\\n' 'terminal-ok'\r";
    manager.write(terminal.id, command);
    await waitFor(() => manager.get(terminal.id)?.buffer.includes("outright-terminal-ok"), 10_000, () => manager.get(terminal.id));
    assert.equal(manager.list()[0].status, "running");
    assert.ok(events.some((event) => event.type === "terminal.output"));
  } finally {
    await manager.shutdown();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("managed PTY failure reaches terminal event and durable audit", { timeout: 20_000 }, async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-managed-exit-"));
  const database = createOutrightDatabase({ filename: path.join(directory, "runtime.db"), runtimeLease: true });
  const events = [];
  const manager = createTerminalManager({ publish: (event) => events.push(event), database });
  try {
    const terminal = await manager.create({ cwd: directory });
    assert.equal(manager.write(terminal.id, "exit 7\r"), true);
    await waitFor(() => manager.get(terminal.id)?.status === "exited", 12_000,
      () => ({ terminal: manager.get(terminal.id), events }));
    assert.equal(manager.get(terminal.id).exitCode, 7);
    assert.deepEqual(events.filter((event) => event.type === "terminal.exit" && event.terminalId === terminal.id)
      .map((event) => event.payload.exitCode), [7]);
    assert.equal(database.listAudit(20).find((entry) => entry.action === "terminal.exited" && entry.target === terminal.id)?.details.exitCode, 7);
  } finally {
    await manager.shutdown();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Windows managed PTY preserves a full native exit code in event and audit", { skip: process.platform !== "win32", timeout: 20_000 }, async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-managed-full-exit-"));
  const database = createOutrightDatabase({ filename: path.join(directory, "runtime.db"), runtimeLease: true });
  const events = [];
  const manager = createTerminalManager({ publish: (event) => events.push(event), database });
  try {
    // The manager takes its shell from the configured environment, not the
    // create payload. Keep the override scoped to the launch itself.
    const previousShell = process.env.SHELL;
    process.env.SHELL = process.execPath;
    let terminal;
    try { terminal = await manager.create({ cwd: directory }); }
    finally {
      if (previousShell === undefined) delete process.env.SHELL;
      else process.env.SHELL = previousShell;
    }
    assert.equal(manager.write(terminal.id, "process.exit(300)\r"), true);
    await waitFor(() => manager.get(terminal.id)?.status === "exited", 12_000,
      () => ({ terminal: manager.get(terminal.id), events }));
    assert.equal(manager.get(terminal.id).exitCode, 300);
    assert.deepEqual(events.filter((event) => event.type === "terminal.exit" && event.terminalId === terminal.id)
      .map((event) => event.payload.exitCode), [300]);
    assert.equal(database.listAudit(20).find((entry) => entry.action === "terminal.exited" && entry.target === terminal.id)?.details.exitCode, 300);
  } finally {
    await manager.shutdown();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("enforces terminal limits, input bounds, and suppresses close-after-exit events", async () => {
  const events = [];
  const processes = [];
  const manager = createTerminalManager({
    publish: (event) => events.push(event),
    database: { audit() {}, auditAdmission() {}, auditCritical() {}, auditRequired: async () => {} },
    maxTerminals: 2,
    maxTerminalsPerCwd: 1,
    terminate: async (terminal) => { terminal.process.kill(); },
    spawnTerminal: () => {
      const callbacks = {};
      const process = {
        pid: processes.length + 1,
        onData(callback) { callbacks.data = callback; },
        onExit(callback) { callbacks.exit = callback; },
        write() {},
        resize() {},
        kill() { callbacks.exit?.({ exitCode: 0, signal: 15 }); },
      };
      processes.push(process);
      return process;
    },
  });
  const first = manager.create({ cwd: "/tmp/one", name: "One" });
  assert.throws(() => manager.create({ cwd: "/tmp/one", name: "Duplicate" }), (error) => error.statusCode === 429);
  manager.create({ cwd: "/tmp/two", name: "Two" });
  assert.throws(() => manager.create({ cwd: "/tmp/three", name: "Three" }), (error) => error.statusCode === 429);
  assert.equal(manager.write(first.id, "x".repeat(70_000)), false);
  assert.equal(await manager.close(first.id), true);
  assert.equal(events.some((event) => event.type === "terminal.exit" && event.terminalId === first.id), false);
  await manager.shutdown();
});

test("terminal buffer snapshot carries the output cursor for lossless activation", async () => {
  const events = [];
  let onData;
  const manager = createTerminalManager({
    publish: (event) => events.push(event), database: { audit() {}, auditAdmission() {}, auditCritical() {}, auditRequired: async () => {} },
    spawnTerminal: () => ({ pid: 1, onData(callback) { onData = callback; }, onExit() {}, kill() {} }), terminate: async () => {},
  });
  const { id } = manager.create({ cwd: process.cwd() });
  onData("before\n");
  const snapshot = manager.get(id);
  onData("after\n");
  assert.equal(snapshot.buffer, "before\n");
  assert.equal(snapshot.outputCursor, 1);
  assert.deepEqual(events.map(({ payload }) => payload.cursor), [1, 2]);
  assert.equal(manager.get(id).outputCursor, 2);
  await manager.shutdown();
});

test("a full audit budget refuses PTY creation and a natural exit is retained across restart", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-terminal-audit-"));
  const filename = path.join(directory, "runtime.db");
  let database = createOutrightDatabase({ filename });
  let spawns = 0;
  let onExit;
  const manager = createTerminalManager({ database, publish: () => {}, terminate: async () => {}, spawnTerminal: () => {
    spawns += 1;
    database.updateSettings({ maxRetainedMiB: 64 });
    return { pid: spawns, onData() {}, onExit(callback) { onExit = callback; }, kill() {} };
  } });
  try {
    const conversation = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "quota", provider: "codex" });
    database.addMessage({ conversationId: conversation.id, role: "assistant", body: "x".repeat(65 * 1024 * 1024) });
    database.updateSettings({ maxRetainedMiB: 64 });
    assert.throws(() => manager.create({ cwd: "/tmp/w" }), (error) => error.statusCode === 507);
    assert.equal(spawns, 0);
    database.updateSettings({ maxRetainedMiB: 128 });
    const terminal = manager.create({ cwd: "/tmp/w" });
    onExit({ exitCode: 7, signal: 0 });
    await waitFor(() => database.listAudit(10).some((entry) => entry.action === "terminal.exited" && entry.target === terminal.id));
    assert.equal(await manager.close(terminal.id), true);
    database.close();
    database = createOutrightDatabase({ filename });
    const actions = database.listAudit(10).filter((entry) => entry.target === terminal.id).map((entry) => entry.action);
    assert.ok(actions.includes("terminal.create.requested"));
    assert.ok(actions.includes("terminal.created"));
    assert.ok(actions.includes("terminal.exited"));
    assert.ok(actions.includes("terminal.close.requested"));
    assert.ok(actions.includes("terminal.closed"));
  } finally { await manager.shutdown(); database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("an in-flight or failed natural-exit audit keeps capacity charged through close and restart", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-terminal-exit-audit-"));
  const filename = path.join(directory, "runtime.db");
  let database = createOutrightDatabase({ filename, runtimeLease: true });
  let rejectExitAudit;
  let reportExit;
  const pending = new Promise((_, reject) => { rejectExitAudit = reject; });
  const audited = {
    auditAdmission: (...args) => database.auditAdmission(...args),
    auditCritical: (...args) => database.auditCritical(...args),
    auditRequired: (action, ...args) => action === "terminal.exited" ? pending : database.auditRequired(action, ...args),
  };
  const manager = createTerminalManager({ database: audited, publish: () => {}, maxTerminals: 1,
    spawnTerminal: () => ({ pid: 42, onData() {}, onExit(callback) { reportExit = callback; }, kill() {} }),
    terminate: async () => {} });
  try {
    const first = manager.create({ cwd: directory });
    reportExit({ exitCode: 0, signal: null });
    await waitFor(() => manager.get(first.id)?.status === "settling");
    assert.equal(manager.capacity().active, 1);
    assert.throws(() => manager.create({ cwd: directory }), (error) => error.statusCode === 429);
    rejectExitAudit(Object.assign(new Error("audit busy"), { code: "SQLITE_BUSY" }));
    await waitFor(() => manager.get(first.id)?.status === "unknown");
    assert.equal(manager.capacity().unknown, 1);
    assert.throws(() => manager.create({ cwd: directory }), (error) => error.statusCode === 429);
    assert.equal(database.listAudit(20).some((entry) => entry.action === "terminal.exited" && entry.target === first.id), false);
    assert.equal(await manager.close(first.id), true);
    const second = manager.create({ cwd: directory });
    assert.equal(manager.capacity().active, 1);
    await manager.shutdown();
    assert.equal(manager.get(second.id), null);
    await database.close();
    database = createOutrightDatabase({ filename, runtimeLease: true });
    database.reconcileTerminalAudit();
    assert.deepEqual(database.terminalUnknownReservations(), []);
    const writer = new Database(filename);
    try {
      const insert = writer.prepare("INSERT INTO audit_log (action, target, details, created_at) VALUES ('telemetry', '', '{}', '2026-01-01')");
      writer.transaction(() => { for (let index = 0; index < 10_050; index += 1) insert.run(); }).immediate();
    } finally { writer.close(); }
    database.audit("telemetry", { target: "trim" });
    assert.equal(database.listAudit(10_100).some((entry) => entry.action === "terminal.created" && entry.target === first.id), false);
  } finally {
    await database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a close that cannot record its outcome reports the pending operation", async () => {
  const actions = [];
  let killed = false;
  let auditUnavailable = true;
  const manager = createTerminalManager({ publish: () => {}, database: {
    auditAdmission: (action, details) => actions.push({ action, details }),
    auditCritical: (action, details) => {
      actions.push({ action, details });
    },
    auditRequired: async (action) => { if (action === "terminal.closed" && auditUnavailable) throw Object.assign(new Error("storage interrupted"), { code: "SQLITE_BUSY" }); },
  }, spawnTerminal: () => ({ pid: 42, onData() {}, onExit() {}, kill() { killed = true; } }), terminate: async (terminal) => { terminal.process.kill(); } });
  let assertionFailure;
  try {
    const terminal = manager.create({ cwd: "/tmp/w" });
    await assert.rejects(manager.close(terminal.id), (error) =>
      error.statusCode === 503 && error.details?.outcomeUnknown === true && Boolean(error.details.operationId));
    assert.equal(killed, true);
    assert.equal(manager.get(terminal.id)?.status, "unknown");
    assert.ok(actions.some((entry) => entry.action === "terminal.close.requested"));
    auditUnavailable = false;
    await manager.shutdown();
    assert.equal(manager.capacity().active, 0);
  } catch (error) { assertionFailure = error; throw error; }
  finally {
    auditUnavailable = false;
    try { await manager.shutdown(); }
    catch (cleanupError) { if (!assertionFailure) throw cleanupError; }
  }
});

test("failed close admission still terminates and records a durable terminal outcome", async () => {
  const actions = [];
  let terminated = 0;
  const manager = createTerminalManager({ publish: () => {}, database: {
    auditAdmission: () => {},
    auditCritical: (action) => {
      if (action === "terminal.close.requested") throw new Error("admission unavailable");
      actions.push(action);
    },
    auditRequired: async (action) => { actions.push(action); },
  }, spawnTerminal: () => ({ pid: 42, onData() {}, onExit() {}, kill() {} }),
  terminate: async () => { terminated += 1; } });
  const terminal = manager.create({ cwd: "/tmp/w" });
  assert.equal(await manager.close(terminal.id), true);
  assert.equal(terminated, 1);
  assert.ok(actions.includes("terminal.closed"));
  assert.equal(manager.capacity().active, 0);
});

test("shutdown retries a failed native termination before releasing capacity", async () => {
  let attempts = 0;
  const actions = [];
  const manager = createTerminalManager({ publish: () => {}, database: {
    auditAdmission: () => {}, auditCritical: (action) => actions.push(action),
    auditRequired: async (action) => { actions.push(action); },
  }, spawnTerminal: () => ({ pid: 42, onData() {}, onExit() {}, kill() {} }),
  terminate: async () => { if (++attempts === 1) throw new Error("owner still alive"); } });
  manager.create({ cwd: "/tmp/w" });
  await manager.shutdown();
  assert.equal(attempts, 2);
  assert.ok(actions.includes("terminal.closed"));
  assert.equal(manager.capacity().active, 0);
});

test("a rejected managed launch retains a retryable teardown owner through shutdown", async () => {
  let attempts = 0;
  const manager = createTerminalManager({ publish: () => {}, maxTerminals: 1,
    database: { launchDirectory: "/tmp", terminalUnknownReservations: () => [],
      auditAdmission() {}, auditCritical() {}, auditRequired: async () => {} },
    startManagedTerminal: async () => {
      const error = new Error("broker failed after native launch");
      error.terminationUnknown = true;
      error.terminalTeardown = { pid: 42, terminate: async () => { attempts += 1; } };
      throw error;
    },
  });
  await assert.rejects(manager.create({ cwd: "/tmp" }), (error) => error.statusCode === 503);
  assert.equal(manager.capacity().active, 1);
  await manager.shutdown();
  assert.equal(attempts, 1, "shutdown never retried the native teardown after ready rejected");
  assert.equal(manager.capacity().active, 0);
});

test("closing keeps the process slot until termination is verified; unknown termination keeps it charged", async () => {
  let finishTermination;
  let failTermination = false;
  let cleaningUp = false;
  const actions = [];
  const manager = createTerminalManager({ maxTerminals: 1, maxTerminalsPerCwd: 1,
    database: { auditAdmission: (action) => actions.push(action), auditCritical: (action) => actions.push(action), auditRequired: async () => {} },
    publish: () => {},
    spawnTerminal: () => ({ pid: 99999, onData() {}, onExit() {}, kill() {} }),
    terminate: () => cleaningUp ? Promise.resolve() : new Promise((resolve, reject) => { finishTermination = () => failTermination ? reject(new Error("still alive")) : resolve(); }),
  });
  let assertionFailure;
  try {
  const first = manager.create({ cwd: "/tmp/one" });
  const closing = manager.close(first.id);
  await Promise.resolve();
  assert.throws(() => manager.create({ cwd: "/tmp/two" }), (error) => error.statusCode === 429);
  assert.equal(actions.includes("terminal.closed"), false);
  finishTermination();
  assert.equal(await closing, true);
  const second = manager.create({ cwd: "/tmp/two" });
  failTermination = true;
  const failedClose = manager.close(second.id);
  await Promise.resolve();
  finishTermination();
  await assert.rejects(failedClose, (error) => error.statusCode === 503 && error.details.outcomeUnknown);
  assert.equal(manager.get(second.id).status, "unknown");
  assert.throws(() => manager.create({ cwd: "/tmp/three" }), (error) => error.statusCode === 429);
  assert.ok(actions.includes("terminal.close.unknown"));
  failTermination = false;
  const retry = manager.close(second.id);
  await Promise.resolve();
  finishTermination();
  assert.equal(await retry, true);
  assert.equal(manager.list().length, 0);
  await manager.shutdown();
  } catch (error) { assertionFailure = error; throw error; }
  finally {
    cleaningUp = true;
    failTermination = false;
    finishTermination?.();
    try { await manager.shutdown(); }
    catch (cleanupError) { if (!assertionFailure) throw cleanupError; }
  }
});

test("failed created audit releases capacity after verified cleanup and durable failure", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-terminal-create-cleanup-"));
  const filename = path.join(directory, "runtime.db");
  let database = createOutrightDatabase({ filename, runtimeLease: true });
  let terminated = false;
  const manager = createTerminalManager({ publish: () => {}, database: {
    auditAdmission: (...args) => database.auditAdmission(...args),
    auditCritical: (action, details) => {
      if (action === "terminal.created") throw new Error("audit unavailable");
      database.auditCritical(action, details);
    },
    terminalUnknownReservations: () => database.terminalUnknownReservations(),
  }, spawnTerminal: () => ({ pid: 42, onData() {}, onExit() {}, kill() {} }),
  terminate: async () => { terminated = true; } });
  try {
    assert.throws(() => manager.create({ cwd: "/tmp/w" }), (error) => error.statusCode === 503);
    await waitFor(() => terminated && manager.list().length === 0 && database.listAudit(10).some((entry) => entry.action === "terminal.create.failed"));
    assert.deepEqual(manager.list(), []);
    database.close();
    database = createOutrightDatabase({ filename, runtimeLease: true });
    database.reconcileTerminalAudit();
    assert.deepEqual(database.terminalUnknownReservations(), []);
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("verified empty terminal creation survives two failed audit writes and restart", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-terminal-empty-proof-"));
  const filename = path.join(directory, "runtime.db");
  let database = createOutrightDatabase({ filename, runtimeLease: true });
  let terminated = 0;
  const failedAudit = {
    launchDirectory: database.launchDirectory,
    auditAdmission: (...args) => database.auditAdmission(...args),
    auditCritical: (action, details) => {
      if (action === "terminal.created" || action === "terminal.create.failed") throw new Error("storage refused outcome");
      return database.auditCritical(action, details);
    },
    terminalUnknownReservations: () => database.terminalUnknownReservations(),
  };
  const manager = createTerminalManager({ publish: () => {}, database: failedAudit,
    startManagedTerminal: async () => ({ pid: 42, onData() {}, onExit() {},
      async terminate() { terminated += 1; } }), maxTerminals: 1, maxTerminalsPerCwd: 1 });
  try {
    await assert.rejects(manager.create({ cwd: directory }), (error) => error.statusCode === 503);
    assert.equal(terminated, 1);
    assert.equal(manager.capacity().active, 1, "the failed audit still charges capacity");
    assert.ok(database.terminalUnknownReservations().some((entry) => entry.created === 0));
    database.close();
    database = createOutrightDatabase({ filename, runtimeLease: true });
    database.reconcileTerminalAudit();
    await database.waitForTerminalAuditReconciliation();
    const restarted = createTerminalManager({ publish: () => {}, database,
      cleanupSocket: () => {}, maxTerminals: 1, maxTerminalsPerCwd: 1 });
    assert.equal(restarted.capacity().active, 1);
    assert.equal(await restarted.reconcileUnknown(), 1);
    assert.equal(restarted.capacity().active, 0);
    assert.deepEqual(database.terminalUnknownReservations(), []);
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("a verified failed create unlinks its broker socket before releasing capacity", { skip: process.platform === "win32" }, async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-terminal-failed-socket-"));
  const database = createOutrightDatabase({ filename: path.join(directory, "runtime.db"), runtimeLease: true });
  const broker = createServer();
  let address;
  const manager = createTerminalManager({ publish: () => {}, database, maxTerminals: 1, maxTerminalsPerCwd: 1,
    startManagedTerminal: async ({ ownership }) => {
      address = ownership.address;
      await new Promise((resolve, reject) => { broker.once("error", reject); broker.listen(address, resolve); });
      const error = new Error("launch acknowledgment failed");
      error.terminationVerified = true;
      throw error;
    } });
  try {
    await assert.rejects(manager.create({ cwd: directory }), /launch acknowledgment failed/);
    assert.equal(existsSync(address), false, "verified failed create left a reachable broker socket");
    assert.equal(manager.capacity().active, 0);
    assert.ok(database.listAudit(10).some((entry) => entry.action === "terminal.create.failed"));
  } finally {
    await new Promise((resolve) => broker.close(resolve));
    await manager.shutdown();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a partial verified-empty marker is repairable after interrupted storage", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-terminal-partial-proof-"));
  const id = randomUUID();
  try {
    writeFileSync(path.join(directory, `terminal-${id}.empty`), id.slice(0, 12), { mode: 0o600 });
    recordTerminalEmpty(id, directory);
    assert.equal(readFileSync(path.join(directory, `terminal-${id}.empty`), "utf8"), `${id}\n`);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("verified native teardown retries a failed marker and failed create audit in process", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-terminal-proof-retry-"));
  const database = createOutrightDatabase({ filename: path.join(directory, "runtime.db"), runtimeLease: true });
  let refuseOutcome = true;
  let terminations = 0;
  const manager = createTerminalManager({ publish: () => {}, database: {
    launchDirectory: path.join(directory, "missing-launch-directory"),
    auditAdmission: (...args) => database.auditAdmission(...args),
    auditCritical: (action, details) => {
      if (action === "terminal.create.failed" && refuseOutcome) throw new Error("audit unavailable");
      return database.auditCritical(action, details);
    },
    terminalUnknownReservations: () => database.terminalUnknownReservations(),
  }, startManagedTerminal: async () => {
    terminations += 1; // The injected adapter has already proved its tree empty.
    const error = new Error("launch acknowledgment failed");
    error.terminationVerified = true;
    error.terminalTeardown = { pid: 42, async terminate() { throw new Error("must not terminate twice"); } };
    throw error;
  }, maxTerminals: 1, maxTerminalsPerCwd: 1 });
  try {
    await assert.rejects(manager.create({ cwd: directory }), (error) => error.statusCode === 503);
    assert.equal(terminations, 1);
    assert.equal(manager.capacity().active, 1);
    refuseOutcome = false;
    // The missing private proof directory is still a recovery boundary.
    // Restore it before claiming that the verified owner can be released.
    mkdirSync(path.join(directory, "missing-launch-directory"), { mode: 0o700 });
    assert.equal(await manager.reconcileUnknown(), 1);
    assert.equal(manager.capacity().active, 0);
    assert.deepEqual(database.terminalUnknownReservations(), []);
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("terminal recovery removes a stale verified-empty marker after its audit has settled", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-terminal-stale-proof-"));
  const id = randomUUID();
  try {
    recordTerminalEmpty(id, directory);
    const manager = createTerminalManager({ publish: () => {},
      database: { launchDirectory: directory, terminalUnknownReservations: () => [] } });
    await waitFor(() => !existsSync(path.join(directory, `terminal-${id}.empty`)));
    assert.equal(existsSync(path.join(directory, `terminal-${id}.empty`)), false);
    await manager.shutdown();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("real PTY close reaps a foreground child that ignores hangup", { skip: process.platform === "win32" }, async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-foreground-pty-"));
  const database = createOutrightDatabase({ filename: path.join(directory, "runtime.db"), runtimeLease: true });
  const manager = createTerminalManager({ maxTerminals: 1, publish: () => {},
    database });
  let childPid;
  try {
    const terminal = await manager.create({ cwd: process.cwd() });
    manager.write(terminal.id, `node -e 'process.on("SIGHUP",()=>{}); process.on("SIGTERM",()=>{}); console.log("OUTRIGHT_CHILD:"+process.pid); setInterval(()=>{},1000)'\r`);
    await waitFor(() => {
      const match = manager.get(terminal.id)?.buffer.match(/OUTRIGHT_CHILD:(\d+)/);
      childPid = Number(match?.[1]);
      return Number.isSafeInteger(childPid) && childPid > 0;
    }, 10_000);
    const closing = manager.close(terminal.id);
    await assert.rejects(manager.create({ cwd: process.cwd() }), (error) => error.statusCode === 429);
    await closing;
    const state = spawnSync("ps", ["-o", "stat=", "-p", String(childPid)], { encoding: "utf8" }).stdout.trim();
    assert.ok(!state || state.startsWith("Z"), `child ${childPid} remained live: ${state}`);
  } finally {
    try { await manager.shutdown(); } catch {}
    if (childPid) try { process.kill(childPid, "SIGKILL"); } catch {}
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("detached PTY child keeps the slot until the native ownership boundary is empty", { skip: process.platform === "win32" }, async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-detached-pty-"));
  const database = createOutrightDatabase({ filename: path.join(directory, "runtime.db"), runtimeLease: true });
  const manager = createTerminalManager({ maxTerminals: 1, publish: () => {}, database });
  const pidFile = path.join(directory, "background.pid");
  let backgroundPid;
  let pausedOwner = false;
  try {
    const terminal = await manager.create({ cwd: directory });
    manager.write(terminal.id, `nohup sleep 30 >/dev/null 2>&1 & echo $! > ${pidFile}; read hold; exit\r`);
    await waitFor(() => existsSync(pidFile), 5000);
    backgroundPid = Number(readFileSync(pidFile, "utf8").trim());
    assert.ok(Number.isSafeInteger(backgroundPid) && backgroundPid > 0);
    const beforeClose = spawnSync("ps", ["-o", "stat=", "-p", String(backgroundPid)], { encoding: "utf8" }).stdout.trim();
    assert.ok(beforeClose && !beforeClose.startsWith("Z"), "fixture must prove a live owned child before testing capacity");
    if (process.platform === "linux") {
      process.kill(terminal.pid, "SIGSTOP");
      pausedOwner = true;
      manager.write(terminal.id, "\r");
    }
    assert.equal(manager.capacity().active, 1, "a reparented child still owns terminal capacity");
    assert.equal(database.listAudit(20).some((entry) => entry.action === "terminal.exited" && entry.target === terminal.id), false);
    const closing = manager.close(terminal.id);
    if (pausedOwner) { process.kill(terminal.pid, "SIGCONT"); pausedOwner = false; }
    await closing;
    await waitFor(() => {
      const state = spawnSync("ps", ["-o", "stat=", "-p", String(backgroundPid)], { encoding: "utf8" }).stdout.trim();
      return !state || state.startsWith("Z");
    }, 5000);
    assert.equal(manager.capacity().active, 0);
  } finally {
    if (pausedOwner) try { process.kill(manager.list()[0]?.pid, "SIGCONT"); } catch {}
    try { await manager.shutdown(); } catch {}
    if (backgroundPid) try { process.kill(backgroundPid, "SIGKILL"); } catch {}
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("concurrent managed terminal admission reserves capacity before launching brokers", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-terminal-burst-"));
  const database = createOutrightDatabase({ filename: path.join(directory, "runtime.db"), runtimeLease: true });
  const manager = createTerminalManager({ maxTerminals: 1, database, publish: () => {} });
  try {
    const results = await Promise.allSettled([manager.create({ cwd: directory }), manager.create({ cwd: directory })]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected" && result.reason.statusCode === 429).length, 1);
    assert.equal(manager.capacity().active, 1);
    assert.equal(database.listAudit(20).filter((entry) => entry.action === "terminal.created").length, 1);
  } finally { await manager.shutdown(); database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("oversized inherited environment is refused before PTY audit admission", async () => {
  let admitted = 0;
  const manager = createTerminalManager({ publish: () => {}, database: {
    launchDirectory: "/tmp", terminalUnknownReservations: () => [], auditAdmission: () => { admitted += 1; },
  } });
  process.env.OUT30_TERMINAL_EXTRA = "x".repeat(100 * 1024);
  try {
    await assert.rejects(manager.create({ cwd: "/tmp" }), (error) => error.statusCode === 413);
    assert.equal(admitted, 0);
    assert.equal(manager.capacity().active, 0);
  } finally { delete process.env.OUT30_TERMINAL_EXTRA; await manager.shutdown(); }
});

test("managed PTY keeps unknown capacity when native proof admission is refused, then retries", { skip: process.platform !== "darwin" }, async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-pty-helper-retry-"));
  const database = createOutrightDatabase({ filename: path.join(directory, "runtime.db"), runtimeLease: true });
  const subprocesses = createSubprocessBudget({ limit: 1, execute: execFile });
  const manager = createTerminalManager({ maxTerminals: 1, database, publish: () => {}, subprocesses });
  try {
    const terminal = await manager.create({ cwd: directory });
    const hold = subprocesses.run(process.execPath, ["-e", "setTimeout(() => {}, 450)"], { timeout: 1000 });
    await assert.rejects(manager.close(terminal.id), (error) => error.statusCode === 503 && error.details?.outcomeUnknown);
    assert.equal(manager.capacity().unknown, 1);
    assert.equal(database.listAudit(20).some((entry) => entry.action === "terminal.closed" && entry.target === terminal.id), false);
    await hold;
    assert.equal(await manager.close(terminal.id), true);
    assert.equal(manager.capacity().active, 0);
  } finally { await manager.shutdown(); database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("hard runtime exit leaves a detached child owned until restart can reconcile it", { skip: process.platform === "win32" }, async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-pty-crash-recovery-"));
  const filename = path.join(directory, "runtime.db");
  const pidFile = path.join(directory, "background.pid");
  const idFile = path.join(directory, "terminal.id");
  const source = `import {createOutrightDatabase} from ${JSON.stringify(new URL("./database.mjs", import.meta.url).href)};
    import {createTerminalManager} from ${JSON.stringify(new URL("./terminal-manager.mjs", import.meta.url).href)};
    import {existsSync,writeFileSync} from 'node:fs';
    const db=createOutrightDatabase({filename:${JSON.stringify(filename)},runtimeLease:true});
    const manager=createTerminalManager({database:db,publish:()=>{}});
    const terminal=await manager.create({cwd:${JSON.stringify(directory)}});
    writeFileSync(${JSON.stringify(idFile)},terminal.id);
    manager.write(terminal.id,${JSON.stringify(`nohup sleep 30 >/dev/null 2>&1 & echo $! > ${pidFile}; read hold; exit\r`)});
    for(let i=0;i<100&&!existsSync(${JSON.stringify(pidFile)});i++)await new Promise(r=>setTimeout(r,50));
    if(process.platform==='linux'&&existsSync(${JSON.stringify(pidFile)})){
      process.kill(terminal.pid,'SIGSTOP');
      manager.write(terminal.id,'\\r');
    }
    process.exit(existsSync(${JSON.stringify(pidFile)})?0:2);`;
  let backgroundPid;
  let runtime;
  let ownerPid;
  try {
    const crashed = spawnSync(process.execPath, ["--input-type=module", "-e", source], { timeout: 15_000, encoding: "utf8" });
    assert.equal(crashed.status, 0, crashed.stderr);
    backgroundPid = Number(readFileSync(pidFile, "utf8").trim());
    const terminalId = readFileSync(idFile, "utf8");
    runtime = createOutrightRuntime({ configUrl: "file:///nonexistent-config.json",
      databaseFactory: (options) => createOutrightDatabase({ ...options, filename }),
      terminalManagerFactory: (options) => createTerminalManager({ ...options, maxTerminals: 1 }) });
    if (process.platform === "linux") {
      assert.equal(existsSync(path.join(runtime.database.launchDirectory, `terminal-${terminalId}.json`)), true,
        "runtime startup must preserve the native terminal marker before owner proof");
      assert.equal(runtime.terminals.capacity().unknown, 1);
      process.kill(backgroundPid, 0);
      const marker = JSON.parse(readFileSync(path.join(runtime.database.launchDirectory, `terminal-${terminalId}.json`), "utf8"));
      ownerPid = marker.pid;
      process.kill(ownerPid, "SIGCONT");
    }
    await waitFor(async () => {
      await runtime.terminals.reconcileUnknown();
      return runtime.terminals.capacity().active === 0;
    }, 7000);
    assert.equal(runtime.terminals.capacity().active, 0);
    await waitFor(() => {
      const state = spawnSync("ps", ["-o", "stat=", "-p", String(backgroundPid)], { encoding: "utf8" }).stdout.trim();
      return !state || state.startsWith("Z");
    }, 5000);
    assert.equal(runtime.database.listAudit(20).some((entry) => entry.action === "terminal.recovered" && entry.target === terminalId), true);
  } finally {
    if (ownerPid) try { process.kill(ownerPid, "SIGCONT"); } catch {}
    if (backgroundPid) try { process.kill(backgroundPid, "SIGKILL"); } catch {}
    await runtime?.shutdown();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("closing an exited tab never signals a PID now owned by another process", { skip: process.platform === "win32" }, async () => {
  const unrelated = spawn("/bin/sleep", ["30"]);
  let reportExit;
  const actions = [];
  const manager = createTerminalManager({ publish: () => {}, database: {
    auditAdmission() {}, auditCritical(action) { actions.push(action); }, auditRequired: async (action) => { actions.push(action); },
  }, spawnTerminal: () => ({ pid: unrelated.pid, onData() {}, onExit(callback) { reportExit = callback; },
    terminate: async () => {}, kill() { throw new Error("stale PTY PID was signaled"); } }) });
  try {
    const terminal = manager.create({ cwd: "/tmp" });
    reportExit({ exitCode: 0, signal: 0 });
    await waitFor(() => manager.get(terminal.id)?.status === "exited", 5000);
    assert.equal(await manager.close(terminal.id), true);
    assert.equal(unrelated.exitCode, null);
    assert.equal(unrelated.signalCode, null);
    assert.ok(actions.includes("terminal.exited"));
  } finally { unrelated.kill("SIGKILL"); await manager.shutdown(); }
});

test("a larger configured terminal quota still charges every unresolved native owner", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-terminal-many-unknown-"));
  const database = createOutrightDatabase({ filename: path.join(directory, "runtime.db"), runtimeLease: true });
  try {
    for (let index = 0; index < 21; index += 1) {
      database.auditCritical("terminal.created", { target: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, cwd: directory });
    }
    const manager = createTerminalManager({ database, publish: () => {}, maxTerminals: 20,
      spawnTerminal: () => { throw new Error("unresolved owners must block spawn"); } });
    assert.equal(manager.capacity().unknown, 21);
    assert.throws(() => manager.create({ cwd: directory }), (error) => error.statusCode === 429);
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("Darwin recovery keeps a reservation until an exited launchd job is booted out", { skip: process.platform !== "darwin" }, async () => {
  const target = "379634b7-8989-47c5-9174-c09529b206a1";
  const owner = { target, created: 1, ownershipLabel: `com.21n.outright.terminal.${target}` };
  let state = "exited";
  let allowBootout = false;
  const commands = [];
  const subprocesses = { async run(_program, args) {
    commands.push(args[0]);
    if (args[0] === "--terminate") { if (allowBootout) state = "absent"; return { stdout: "" }; }
    return { stdout: state };
  } };
  assert.equal(await recoverManagedTerminal({ ...owner, subprocesses }), false,
    "an empty but registered launchd job still owns recovery capacity");
  assert.ok(commands.includes("--terminate"), "recovery never attempted launchd bootout");
  allowBootout = true;
  assert.equal(await recoverManagedTerminal({ ...owner, subprocesses }), true);
  assert.equal(state, "absent");
});

test("restart reconciles an empty native owner but keeps legacy unknown reservations for explicit recovery", { skip: process.platform === "win32" }, async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-terminal-owner-recovery-"));
  const filename = path.join(directory, "runtime.db");
  let database = createOutrightDatabase({ filename, runtimeLease: true });
  const nativeId = "379634b7-8989-47c5-9174-c09529b206a1";
  const legacyId = "7624abb7-5805-402b-87c4-843443634a4e";
  try {
    database.auditCritical("terminal.created", { target: nativeId, cwd: "/tmp", ownershipLabel: `com.21n.outright.terminal.${nativeId}`,
      handshakePath: path.join(database.launchDirectory, `terminal-${nativeId}.json`) });
    database.auditCritical("terminal.created", { target: legacyId, cwd: "/tmp" });
    database.close();
    database = createOutrightDatabase({ filename, runtimeLease: true });
    database.reconcileTerminalAudit();
    await database.waitForTerminalAuditReconciliation();
    const manager = createTerminalManager({ database, publish: () => {}, maxTerminals: 1 });
    assert.equal(manager.capacity().active, 2);
    assert.deepEqual(manager.list().map((entry) => entry.id).sort(), [legacyId, nativeId].sort());
    assert.equal(manager.get(legacyId)?.recoveryReservation, true);
    assert.equal(manager.get(legacyId)?.status, "unknown");
    assert.equal(manager.write(legacyId, "unsafe"), false);
    assert.equal(manager.resize(legacyId, 80, 24), false);
    assert.equal(await manager.reconcileUnknown(), 1);
    assert.equal(manager.capacity().active, 1);
    assert.deepEqual(manager.list().map((entry) => entry.id), [legacyId]);
    assert.deepEqual(database.terminalUnknownReservations().map((entry) => entry.target), [legacyId]);
    assert.equal(database.listAudit(10).some((entry) => entry.action === "terminal.recovered" && entry.target === nativeId), true);
    assert.throws(() => database.resolveTerminalUnknown(legacyId, ""), (error) => error.statusCode === 400);
    assert.equal(database.resolveTerminalUnknown(legacyId, "Operator inspected the old PTY tree and found no processes"), true);
    assert.deepEqual(database.terminalUnknownReservations(), []);
    database.close();
    database = createOutrightDatabase({ filename, runtimeLease: true });
    const reopened = createTerminalManager({ database, publish: () => {}, maxTerminals: 1 });
    assert.equal(reopened.capacity().active, 0);
    const writer = new Database(filename);
    try {
      const insert = writer.prepare("INSERT INTO audit_log (action, target, details, created_at) VALUES ('telemetry', '', '{}', '2026-01-01')");
      writer.transaction(() => { for (let index = 0; index < 10_050; index += 1) insert.run(); }).immediate();
    } finally { writer.close(); }
    database.audit("telemetry", { target: "trim" });
    const proof = new Database(filename, { readonly: true });
    try { assert.equal(proof.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'terminal.created'").get().count, 0); }
    finally { proof.close(); }
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("a per-worktree recovery reservation retries native proof after prompt refusal", async () => {
  const cwd = "/tmp/outright-reservation-retry";
  const target = "54d20348-0790-4ba8-b888-e05887e4844c";
  let reservations = [{ target, cwd, pid: 123 }];
  let probes = 0;
  const database = {
    launchDirectory: "/tmp",
    terminalUnknownReservations: () => reservations,
    resolveTerminalUnknown: (id) => { assert.equal(id, target); reservations = []; },
    auditAdmission() {}, auditCritical() {}, auditRequired: async () => {},
  };
  const manager = createTerminalManager({ database, publish: () => {}, maxTerminals: 3, maxTerminalsPerCwd: 1,
    recoverTerminal: async () => ++probes > 1,
    startManagedTerminal: async () => ({ pid: 456, onData() {}, onExit() {}, terminate: async () => {} }) });
  await assert.rejects(manager.create({ cwd }), (error) => error.statusCode === 429);
  await waitFor(() => probes === 1);
  assert.equal(manager.capacity().unknown, 1);
  await assert.rejects(manager.create({ cwd }), (error) => error.statusCode === 429);
  await waitFor(() => manager.capacity().unknown === 0);
  assert.equal(probes, 2, "a later admission did not retry a transient helper failure");
  const created = await manager.create({ cwd });
  assert.equal(created.status, "running");
  assert.equal(manager.capacity().unknown, 0);
  await manager.shutdown();
});

test("full global and worktree capacity refuse repeated concurrent creates while native proof is slow", async () => {
  for (const scope of ["global", "worktree"]) {
    const cwd = "/tmp/outright-slow-owner";
    const reservations = Array.from({ length: scope === "global" ? 12 : 4 }, (_, index) =>
      ({ target: `slow-owner-${index}`, cwd: scope === "global" ? `${cwd}-${index % 3}` : cwd }));
    let releaseProof;
    const proof = new Promise((resolve) => { releaseProof = resolve; });
    let probes = 0;
    let admissions = 0;
    const manager = createTerminalManager({ maxTerminals: 12, maxTerminalsPerCwd: 4,
      database: { launchDirectory: "/tmp", terminalUnknownReservations: () => reservations,
        auditAdmission: () => { admissions += 1; } }, publish: () => {},
      recoverTerminal: async () => { probes += 1; await proof; return true; },
      startManagedTerminal: async () => { throw new Error("full capacity reached spawn"); } });
    try {
      const requests = Array.from({ length: 8 }, () => manager.create({ cwd }));
      const prompt = await Promise.race([
        Promise.allSettled(requests).then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 150)),
      ]);
      assert.equal(prompt, true, `${scope} admission waited for native ownership proof`);
      for (const result of await Promise.allSettled(requests)) {
        assert.equal(result.status, "rejected");
        assert.equal(result.reason.statusCode, 429);
      }
      assert.equal(admissions, 0);
      assert.equal(manager.capacity().unknown, reservations.length);
      assert.ok(probes > 0 && probes <= 4, "recovery helpers exceeded the bounded parallel limit");
      await manager.shutdown();
      releaseProof();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(manager.capacity().unknown, reservations.length,
        "late native proof released capacity after shutdown");
    } finally { releaseProof(); await manager.shutdown(); }
  }
});

test("verified native owner releases capacity without a new create request", async () => {
  const cwd = "/tmp/outright-verified-owner";
  const reservations = [{ target: "verified-owner", cwd }];
  const events = [];
  const manager = createTerminalManager({ maxTerminals: 1, maxTerminalsPerCwd: 1,
    database: { launchDirectory: "/tmp", terminalUnknownReservations: () => reservations,
      resolveTerminalUnknown: () => { reservations.length = 0; },
      auditAdmission() {}, auditCritical() {}, auditRequired: async () => {} },
    publish: (event) => events.push(event), recoverTerminal: async () => true,
    startManagedTerminal: async () => ({ pid: 456, onData() {}, onExit() {}, terminate: async () => {} }) });
  try {
    await assert.rejects(manager.create({ cwd }), (error) => error.statusCode === 429);
    await waitFor(() => manager.capacity().unknown === 0);
    assert.ok(events.some((event) => event.type === "capacity.changed"));
    assert.equal((await manager.create({ cwd })).status, "running");
  } finally { await manager.shutdown(); }
});

test("socket cleanup failure retains unknown capacity until a later verified retry", async () => {
  const cwd = "/tmp/outright-socket-recovery";
  const reservations = [{ target: "00000000-0000-4000-8000-000000000004", cwd }];
  let unlinkFails = true;
  let nativeProofs = 0;
  const manager = createTerminalManager({ maxTerminals: 1, maxTerminalsPerCwd: 1,
    database: { launchDirectory: "/tmp", terminalUnknownReservations: () => reservations,
      resolveTerminalUnknown: () => { reservations.length = 0; },
      auditAdmission() {}, auditCritical() {}, auditRequired: async () => {} },
    publish: () => {}, recoverTerminal: async () => { nativeProofs += 1; return true; },
    cleanupSocket: () => { if (unlinkFails) throw Object.assign(new Error("socket locked"), { code: "EPERM" }); },
    startManagedTerminal: async () => ({ pid: 456, onData() {}, onExit() {}, terminate: async () => {} }) });
  try {
    assert.equal(await manager.reconcileUnknown(), 0);
    assert.equal(manager.capacity().unknown, 1);
    await assert.rejects(manager.create({ cwd }), (error) => error.statusCode === 429);
    await manager.reconcileUnknown();
    unlinkFails = false;
    assert.equal(await manager.reconcileUnknown(), 1);
    assert.equal(manager.capacity().unknown, 0);
    assert.ok(nativeProofs >= 2);
    assert.equal((await manager.create({ cwd })).status, "running");
  } finally { await manager.shutdown(); }
});

test("a real stale Unix socket remains charged until unlink succeeds", { skip: process.platform === "win32" }, async () => {
  const cwd = process.cwd();
  const target = randomUUID();
  const address = terminalOwnership(target, cwd).address;
  const socket = createServer();
  const reservations = [{ target, cwd }];
  let unlinkFails = true;
  let manager;
  try {
    await new Promise((resolve, reject) => {
      socket.once("error", reject);
      socket.listen(address, resolve);
    });
    manager = createTerminalManager({ maxTerminals: 1, maxTerminalsPerCwd: 1,
      database: { launchDirectory: cwd, terminalUnknownReservations: () => reservations,
        resolveTerminalUnknown: () => { reservations.length = 0; },
        auditAdmission() {}, auditCritical() {}, auditRequired: async () => {} },
      publish: () => {}, recoverTerminal: async () => true,
      cleanupSocket: (id) => {
        if (unlinkFails) throw Object.assign(new Error("socket unlink refused"), { code: "EPERM" });
        cleanupTerminalSocket(id);
      } });
    assert.equal(await manager.reconcileUnknown(), 0);
    assert.equal(manager.capacity().unknown, 1);
    assert.equal(existsSync(address), true);
    unlinkFails = false;
    assert.equal(await manager.reconcileUnknown(), 1);
    assert.equal(manager.capacity().unknown, 0);
    assert.equal(existsSync(address), false);
  } finally {
    await manager?.shutdown();
    await new Promise((resolve) => socket.close(resolve));
    cleanupTerminalSocket(target);
  }
});

test("partial recovery does not count a live terminal's audit reservation twice", async () => {
  const cwd = "/tmp/outright-partial-recovery";
  const unknown = { target: "54d20348-0790-4ba8-b888-e05887e4844d", cwd };
  let liveId;
  let unresolved = true;
  const database = {
    launchDirectory: "/tmp",
    terminalUnknownReservations: () => [
      ...(unresolved ? [unknown] : []),
      ...(liveId ? [{ target: liveId, cwd }] : []),
    ],
    resolveTerminalUnknown: (id) => { assert.equal(id, unknown.target); unresolved = false; },
    auditAdmission() {}, auditCritical() {}, auditRequired: async () => {},
  };
  const manager = createTerminalManager({ database, publish: () => {}, maxTerminals: 2, maxTerminalsPerCwd: 2,
    recoverTerminal: async () => true,
    startManagedTerminal: async () => ({ pid: 456, onData() {}, onExit() {}, terminate: async () => {} }) });
  try {
    liveId = (await manager.create({ cwd })).id;
    assert.equal(await manager.reconcileUnknown(), 1);
    assert.deepEqual(manager.capacity(), { active: 1, unknown: 0, limit: 2 });
    assert.equal(manager.list().length, 1);
    assert.equal(manager.get(liveId)?.status, "running");
    assert.equal((await manager.create({ cwd })).status, "running", "a duplicate audit row must not cause a false 429");
  } finally { await manager.shutdown(); }
});

test("legacy terminal audit history yields startup and resumes safely after interruption", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-terminal-audit-scan-"));
  const filename = path.join(directory, "runtime.db");
  let database = createOutrightDatabase({ filename, runtimeLease: true });
  try {
    await database.close();
    const writer = new Database(filename);
    try {
      const insert = writer.prepare("INSERT INTO audit_log (action, target, details, created_at) VALUES (?, ?, ?, ?)");
      writer.transaction(() => {
        for (let index = 0; index < 12_000; index += 1) insert.run("legacy.telemetry", "", "{}", "2026-09-01T00:00:00.000Z");
        insert.run("terminal.create.requested", "54d20348-0790-4ba8-b888-e05887e4844e",
          JSON.stringify({ operationId: "pending-create", cwd: directory }), "2026-09-01T00:00:00.000Z");
        insert.run("terminal.created", "54d20348-0790-4ba8-b888-e05887e4844f",
          JSON.stringify({ cwd: directory, pid: 333 }), "2026-09-01T00:00:00.000Z");
        insert.run("terminal.created", "54d20348-0790-4ba8-b888-e05887e48450",
          JSON.stringify({ cwd: directory, pid: 444 }), "2026-09-01T00:00:00.000Z");
        insert.run("terminal.closed", "54d20348-0790-4ba8-b888-e05887e48450",
          "{}", "2026-09-01T00:00:00.000Z");
      }).immediate();
    } finally { writer.close(); }
    database = createOutrightDatabase({ filename, runtimeLease: true });
    database.reconcileTerminalAudit();
    assert.equal(database.terminalAuditScanPending, true, "large legacy history was scanned before startup returned");
    const interruptedWait = database.waitForTerminalAuditReconciliation();
    await database.close();
    await assert.rejects(interruptedWait, /database closed/);
    database = createOutrightDatabase({ filename, runtimeLease: true });
    database.reconcileTerminalAudit();
    assert.equal(database.terminalAuditScanPending, true,
      "terminal audit recovery did not yield startup to its bounded cursor");
    const manager = createTerminalManager({ database, publish: () => {}, maxTerminals: 2, maxTerminalsPerCwd: 2,
      recoverTerminal: async () => false,
      startManagedTerminal: async () => { throw new Error("PTY launched before audit recovery"); } });
    try {
      assert.equal(manager.capacity().recoveryPending, true);
      await assert.rejects(manager.create({ cwd: directory }), (error) => error.statusCode === 503);
      await waitFor(() => !database.terminalAuditScanPending || database.terminalAuditScanError, 10_000,
        () => database.terminalAuditScanError);
      assert.equal(database.terminalAuditScanPending, false, "legacy scan did not finish");
      manager.reloadUnknownReservations();
      assert.equal(manager.capacity().unknown, 2);
      assert.deepEqual(database.terminalUnknownReservations().map((entry) => entry.target).sort(),
        ["54d20348-0790-4ba8-b888-e05887e4844e", "54d20348-0790-4ba8-b888-e05887e4844f"]);
      assert.ok(database.listAudit(10).some((entry) => entry.action === "terminal.create.unknown"));
      assert.ok(database.listAudit(10).some((entry) => entry.action === "terminal.unknown"));
      const readback = new Database(filename, { readonly: true });
      try {
        assert.ok(readback.prepare("SELECT COUNT(*) AS count FROM audit_log").get().count <= AUDIT_RETENTION_LIMIT,
          "legacy telemetry was not trimmed after ownership was reconstructed");
      } finally { readback.close(); }
    } finally { await manager.shutdown(); }
  } finally { await database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("failed legacy audit trimming can restart without releasing an unknown terminal", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-audit-retry-"));
  const filename = path.join(directory, "runtime.db");
  let database = createOutrightDatabase({ filename, runtimeLease: true });
  const terminalId = "54d20348-0790-4ba8-b888-e05887e48451";
  try {
    await database.close();
    const writer = new Database(filename);
    try {
      const insert = writer.prepare("INSERT INTO audit_log (action, target, details, created_at) VALUES (?, ?, '{}', '2026-09-01')");
      writer.transaction(() => {
        for (let index = 0; index < 12_000; index += 1) insert.run("legacy.telemetry", "");
        insert.run("terminal.created", terminalId);
      }).immediate();
      writer.exec("CREATE TRIGGER refuse_audit_trim BEFORE DELETE ON audit_log BEGIN SELECT RAISE(FAIL, 'audit trim blocked'); END");
    } finally { writer.close(); }
    database = createOutrightDatabase({ filename, runtimeLease: true });
    database.reconcileTerminalAudit();
    await assert.rejects(database.waitForTerminalAuditReconciliation(), /audit trim blocked/);
    assert.equal(database.terminalAuditScanPending, true);
    assert.deepEqual(database.terminalUnknownReservations(), [], "failed scan released unresolved ownership");
    const repair = new Database(filename);
    try { repair.exec("DROP TRIGGER refuse_audit_trim"); }
    finally { repair.close(); }
    database.reconcileTerminalAudit();
    await database.waitForTerminalAuditReconciliation();
    assert.deepEqual(database.terminalUnknownReservations().map((entry) => entry.target), [terminalId]);
  } finally { await database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("a transient audit read fault keeps its original waiter and terminal reservation through retry", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-audit-busy-"));
  const filename = path.join(directory, "runtime.db");
  const target = "54d20348-0790-4ba8-b888-e05887e48452";
  let database = createOutrightDatabase({ filename, runtimeLease: true });
  let writer;
  let failNextTick = true;
  try {
    await database.close();
    writer = new Database(filename);
    const insert = writer.prepare("INSERT INTO audit_log (action, target, details, created_at) VALUES (?, ?, '{}', '2026-09-01')");
    writer.transaction(() => {
      for (let index = 0; index < 2_100; index += 1) insert.run("legacy.telemetry", "");
      insert.run("terminal.created", target);
    }).immediate();
    writer.close();
    writer = null;
    database = createOutrightDatabase({ filename, runtimeLease: true,
      beforeTerminalAuditTick: () => {
        if (failNextTick) {
          failNextTick = false;
          throw Object.assign(new Error("injected audit read fault"), { code: "SQLITE_IOERR" });
        }
      },
      onTerminalAuditError: () => { throw new Error("observer failure must not escape scan tick"); } });
    database.reconcileTerminalAudit();
    const waiter = database.waitForTerminalAuditReconciliation();
    let settled = false;
    void waiter.then(() => { settled = true; }, () => { settled = true; });
    await waitFor(() => Boolean(database.terminalAuditScanError), 2_000);
    assert.equal(settled, false, "a retryable lock rejected its original recovery waiter");
    assert.equal(database.terminalAuditScanPending, true);
    await waiter;
    assert.equal(database.terminalAuditScanPending, false);
    assert.deepEqual(database.terminalUnknownReservations().map((entry) => entry.target), [target]);
  } finally {
    writer?.close();
    await database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("persistent audit faults stop after the bounded retry budget and allow an explicit recovery", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-audit-retry-limit-"));
  const filename = path.join(directory, "runtime.db");
  const target = "54d20348-0790-4ba8-b888-e05887e48455";
  let database = createOutrightDatabase({ filename, runtimeLease: true });
  try {
    await database.close();
    const writer = new Database(filename);
    try {
      const insert = writer.prepare("INSERT INTO audit_log (action, target, details, created_at) VALUES (?, ?, '{}', '2026-09-01')");
      writer.transaction(() => {
        for (let index = 0; index < 2_100; index += 1) insert.run("legacy.telemetry", "");
        insert.run("terminal.created", target);
      }).immediate();
    } finally { writer.close(); }
    let fault = true;
    let attempts = 0;
    database = createOutrightDatabase({ filename, runtimeLease: true, terminalAuditRetryBaseMs: 1,
      beforeTerminalAuditTick: () => {
        attempts += 1;
        if (fault) throw Object.assign(new Error("persistent audit fault"), { code: "SQLITE_IOERR" });
      } });
    database.reconcileTerminalAudit();
    await assert.rejects(database.waitForTerminalAuditReconciliation(), /persistent audit fault/);
    assert.equal(attempts, 6, "storage retries escaped their five-retry budget");
    assert.equal(database.terminalAuditScanPending, true);
    assert.deepEqual(database.terminalUnknownReservations(), [], "failure released a terminal reservation");
    fault = false;
    database.reconcileTerminalAudit();
    await database.waitForTerminalAuditReconciliation();
    assert.deepEqual(database.terminalUnknownReservations().map((entry) => entry.target), [target]);
  } finally { await database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("audit paging retains a late completion until its earlier owner is retired", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-audit-dependent-"));
  const filename = path.join(directory, "runtime.db");
  const target = "54d20348-0790-4ba8-b888-e05887e48454";
  const database = createOutrightDatabase({ filename });
  await database.close();
  const writer = new Database(filename);
  try {
    const insert = writer.prepare("INSERT INTO audit_log (action, target, details, created_at) VALUES (?, ?, '{}', '2026-09-01')");
    const created = insert.run("terminal.created", target).lastInsertRowid;
    writer.transaction(() => { for (let index = 0; index < 10_050; index += 1) insert.run("telemetry", ""); }).immediate();
    trimAuditPage(writer, 1);
    assert.equal(writer.prepare("SELECT cursor FROM audit_retention_cursor WHERE id = 1").get().cursor, created);
    const closed = insert.run("terminal.closed", target).lastInsertRowid;
    writer.transaction(() => { for (let index = 0; index < 10_050; index += 1) insert.run("telemetry", ""); }).immediate();
    trimAudit(writer, 32, created, closed);
    assert.deepEqual(writer.prepare("SELECT action FROM audit_log WHERE target = ? ORDER BY id").all(target)
      .map((row) => row.action), ["terminal.created", "terminal.closed"],
    "a completion was removed while the cursor had passed its retained owner");
    trimAudit(writer);
    trimAudit(writer);
    assert.deepEqual(writer.prepare("SELECT action FROM audit_log WHERE target = ?").all(target), [],
      "completed owner and outcome did not eventually retire together");
  } finally { writer.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("a retention page examines bounded candidates when old recovery rows precede a large telemetry history", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-audit-page-cost-"));
  const filename = path.join(directory, "runtime.db");
  const database = createOutrightDatabase({ filename });
  await database.close();
  const writer = new Database(filename);
  try {
    const insert = writer.prepare("INSERT INTO audit_log (action, target, details, created_at) VALUES (?, ?, ?, '2026-09-01')");
    writer.transaction(() => {
      for (let index = 0; index < 32; index += 1) {
        insert.run(index % 2 ? "terminal.created" : "retention.cleanup.requested",
          `owner-${index}`, JSON.stringify({ operationId: `operation-${index}` }));
      }
      for (let index = 0; index < 200_000; index += 1) insert.run("telemetry", "", "{}");
    }).immediate();
    const plan = writer.prepare(`EXPLAIN QUERY PLAN ${auditTrimSql}`).all(0, Number.MAX_SAFE_INTEGER, 32)
      .map((row) => row.detail).join(" ");
    assert.match(plan, /MATERIALIZE candidates/);
    assert.match(plan, /SEARCH audit_log USING INTEGER PRIMARY KEY/);
    const page = trimAuditPage(writer, 32);
    assert.deepEqual(page, { scanned: 32, deleted: 0, complete: false });
  } finally { writer.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("legacy audit evidence backfills in startup pages before retention can retire a late outcome", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-audit-backfill-"));
  const filename = path.join(directory, "runtime.db");
  let database = createOutrightDatabase({ filename });
  await database.close();
  const writer = new Database(filename);
  try {
    // Simulate an existing database whose audit rows predate the projection.
    writer.exec("DROP TRIGGER audit_evidence_insert; DROP TRIGGER audit_evidence_delete; DROP TRIGGER audit_evidence_update; DROP TABLE audit_evidence_state; DROP TABLE audit_evidence");
    const insert = writer.prepare("INSERT INTO audit_log (action, target, details, created_at) VALUES (?, '', ?, '2026-09-01')");
    insert.run("retention.cleanup.requested", '{"operationId":"legacy-pending"}');
    writer.transaction(() => { for (let index = 0; index < 12_000; index += 1) insert.run("telemetry", "{}"); }).immediate();
  } finally { writer.close(); }
  try {
    database = createOutrightDatabase({ filename, runtimeLease: true });
    const before = new Database(filename);
    try {
      assert.deepEqual(trimAuditPage(before), { scanned: 0, deleted: 0, complete: false },
        "retention ran while its legacy dependency index was incomplete");
    } finally { before.close(); }
    assert.equal(database.reconcileTerminalAudit(), 0);
    await database.waitForTerminalAuditReconciliation();
    const after = new Database(filename);
    try {
      assert.equal(after.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'retention.cleanup.requested'").get().count, 1);
      const insert = after.prepare("INSERT INTO audit_log (action, target, details, created_at) VALUES (?, '', ?, '2026-09-01')");
      const outcomeId = insert.run("retention.cleanup.finished", '{"operationId":"other-operation"}').lastInsertRowid;
      after.prepare("UPDATE audit_log SET details = ? WHERE id = ?")
        .run('{"operationId":"legacy-pending"}', outcomeId);
      after.transaction(() => { for (let index = 0; index < 10_050; index += 1) insert.run("telemetry", "{}"); }).immediate();
      for (let page = 0; page < 800; page += 1) trimAuditPage(after);
      assert.deepEqual(after.prepare("SELECT action FROM audit_log WHERE json_valid(details) AND json_extract(details, '$.operationId') = 'legacy-pending'").all(), [],
        "completed legacy request and late outcome did not retire after the protected sweep");
    } finally { after.close(); }
  } finally { await database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("a reattach stays with its unknown owner through live and archive retention, so the next restart records it again", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-audit-reattached-"));
  const filename = path.join(directory, "runtime.db");
  const id = randomUUID();
  let database = createOutrightDatabase({ filename, runtimeLease: true });
  database.auditCritical("terminal.created", { target: id, cwd: directory, ownershipLabel: `com.21n.outright.terminal.${id}`,
    handshakePath: path.join(directory, `terminal-${id}.json`), pid: 4321 });
  const unknowns = () => {
    const proof = new Database(filename, { readonly: true });
    try { return proof.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'terminal.unknown' AND target = ?").get(id).count; }
    finally { proof.close(); }
  };
  const restart = async () => {
    database.close();
    database = createOutrightDatabase({ filename, runtimeLease: true });
    database.reconcileTerminalAudit();
    await database.waitForTerminalAuditReconciliation();
  };
  try {
    await restart();
    assert.equal(unknowns(), 1);
    database.close();
    // A database from before terminal.reattached has projection triggers
    // that omit it; opening it again replaces them.
    const legacy = new Database(filename);
    try {
      for (const name of ["audit_evidence_insert", "audit_evidence_update"]) {
        const { sql } = legacy.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name);
        legacy.exec(`DROP TRIGGER ${name}; ${sql.replaceAll("'terminal.reattached', ", "")}`);
      }
    } finally { legacy.close(); }
    database = createOutrightDatabase({ filename, runtimeLease: true });
    database.auditCritical("terminal.reattached", { target: id, cwd: directory, ownershipLabel: `com.21n.outright.terminal.${id}` });
    const writer = new Database(filename);
    try {
      // The outcome rule finds owners through the projection.
      assert.ok(writer.prepare("SELECT 1 FROM audit_evidence WHERE target = ? AND action = 'terminal.reattached'").get(id),
        "the projection of an upgraded database omits the reattach");
      const insert = writer.prepare("INSERT INTO audit_log (action, target, details, created_at) VALUES ('telemetry', '', '{}', '2026-09-01')");
      writer.transaction(() => { for (let index = 0; index < AUDIT_RETENTION_LIMIT + 50; index += 1) insert.run(); }).immediate();
      // The archive worker trims a shadow copy with the same rule.
      const shadowFile = path.join(directory, "shadow.db");
      writer.exec(`VACUUM INTO '${shadowFile.replaceAll("'", "''")}'`);
      const shadow = new Database(shadowFile);
      try {
        for (let page = 0; page < 800 && !trimAuditPage(shadow).complete; page += 1);
        assert.deepEqual(shadow.prepare("SELECT action FROM audit_log WHERE target = ? ORDER BY id").all(id).map((row) => row.action),
          ["terminal.created", "terminal.unknown", "terminal.reattached"], "archive retention dropped the reattach");
      } finally { shadow.close(); }
      for (let page = 0; page < 800 && !trimAuditPage(writer).complete; page += 1);
      assert.deepEqual(writer.prepare("SELECT action FROM audit_log WHERE target = ? ORDER BY id").all(id).map((row) => row.action),
        ["terminal.created", "terminal.unknown", "terminal.reattached"], "live retention dropped the reattach");
      assert.ok(writer.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'telemetry'").get().count < AUDIT_RETENTION_LIMIT);
    } finally { writer.close(); }
    // The owner went live again, so the next restart finds it unknown anew.
    await restart();
    assert.equal(unknowns(), 2, "a restart after the reattach did not record the owner unknown");
    assert.ok(database.terminalUnknownReservations().some((entry) => entry.target === id));
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("legacy unknown terminal ownership consumes each worktree limit", async () => {
  const reservation = { target: "56b5370b-7ff3-470c-bb68-469b01c96915", cwd: null };
  let launched = false;
  const manager = createTerminalManager({ maxTerminals: 3, maxTerminalsPerCwd: 1, publish: () => {},
    database: { launchDirectory: "/tmp", terminalUnknownReservations: () => [reservation] },
    recoverTerminal: async () => false,
    startManagedTerminal: async () => { launched = true; throw new Error("unverified owner reached PTY spawn"); } });
  await assert.rejects(manager.create({ cwd: "/tmp/another-worktree" }), (error) => error.statusCode === 429);
  assert.equal(launched, false, "a pathless owner did not charge per-worktree admission");
});

test("offline terminal recovery requires the exclusive runtime lease and records one operator decision", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-terminal-operator-"));
  const filename = path.join(directory, "runtime.db");
  const target = "7989e1ba-29df-41a2-a795-73cfc2d4896c";
  const cli = fileURLToPath(new URL("../scripts/reconcile-terminal-capacity.mjs", import.meta.url));
  let database = createOutrightDatabase({ filename, runtimeLease: true });
  try {
    database.auditCritical("terminal.created", { target, cwd: directory });
    const command = [cli, "--database", filename, "--target", target, "--verified-empty", "--evidence", "Observed no owned process"];
    const denied = spawnSync(process.execPath, command, { encoding: "utf8", timeout: 5000 });
    assert.notEqual(denied.status, 0, "an active runtime must prevent offline capacity release");
    assert.equal(database.terminalUnknownReservations().length, 1);
    await database.close();
    const accepted = spawnSync(process.execPath, command, { encoding: "utf8", timeout: 5000 });
    assert.equal(accepted.status, 0, accepted.stderr);
    database = createOutrightDatabase({ filename, runtimeLease: true });
    assert.deepEqual(database.terminalUnknownReservations(), []);
    assert.equal(database.listAudit(10).find((entry) => entry.action === "terminal.recovered")?.details.evidence,
      "Operator verified native owner empty: Observed no owned process");
  } finally { await database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("offline terminal recovery waits for a large audit scan before listing or resolving", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-terminal-operator-legacy-"));
  const filename = path.join(directory, "runtime.db");
  const target = "7989e1ba-29df-41a2-a795-73cfc2d4896d";
  const cli = fileURLToPath(new URL("../scripts/reconcile-terminal-capacity.mjs", import.meta.url));
  let database = createOutrightDatabase({ filename, runtimeLease: true });
  try {
    await database.close();
    const writer = new Database(filename);
    try {
      const insert = writer.prepare("INSERT INTO audit_log (action, target, details, created_at) VALUES (?, ?, ?, ?)");
      writer.transaction(() => {
        for (let index = 0; index < 2_100; index += 1) insert.run("legacy.telemetry", "", "{}", "2026-09-01");
        insert.run("terminal.created", target, JSON.stringify({ cwd: directory }), "2026-09-01");
      }).immediate();
    } finally { writer.close(); }
    const listed = spawnSync(process.execPath, [cli, "--database", filename, "--list"],
      { encoding: "utf8", timeout: 10_000 });
    assert.equal(listed.status, 0, listed.stderr);
    assert.equal(JSON.parse(listed.stdout).find((entry) => entry.target === target)?.cwd, directory);
    const resolved = spawnSync(process.execPath, [cli, "--database", filename, "--target", target,
      "--verified-empty", "--evidence", "Observed no owned process"], { encoding: "utf8", timeout: 10_000 });
    assert.equal(resolved.status, 0, resolved.stderr);
    database = createOutrightDatabase({ filename, runtimeLease: true });
    assert.deepEqual(database.terminalUnknownReservations(), []);
  } finally { await database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("terminal audit scan exposes a bounded owner-index failure to offline waiters", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-terminal-audit-limit-"));
  const filename = path.join(directory, "runtime.db");
  let database = createOutrightDatabase({ filename, runtimeLease: true });
  try {
    await database.close();
    const writer = new Database(filename);
    try {
      const insert = writer.prepare("INSERT INTO audit_log (action, target, details, created_at) VALUES ('terminal.created', ?, '{}', '2026-09-01')");
      writer.transaction(() => {
        for (let index = 0; index <= AUDIT_RETENTION_LIMIT; index += 1) {
          insert.run(`00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
        }
      }).immediate();
    } finally { writer.close(); }
    database = createOutrightDatabase({ filename, runtimeLease: true });
    database.reconcileTerminalAudit();
    await assert.rejects(database.waitForTerminalAuditReconciliation(), /bounded owner index/);
    assert.match(database.terminalAuditScanError, /bounded owner index/);
  } finally { await database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("normal shutdown settles every PTY at a lowered quota and old outcomes trim after restart", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-terminal-shutdown-"));
  const filename = path.join(directory, "runtime.db");
  let database = createOutrightDatabase({ filename, runtimeLease: true });
  const killed = [];
  const manager = createTerminalManager({ database, publish: () => {}, terminate: async (terminal) => { terminal.process.kill(); }, spawnTerminal: () => ({
    pid: killed.length + 1, onData() {}, onExit() {}, kill() { killed.push(true); },
  }) });
  try {
    const first = manager.create({ cwd: "/tmp/one" });
    const second = manager.create({ cwd: "/tmp/two" });
    const conversation = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "quota", provider: "codex" });
    database.addMessage({ conversationId: conversation.id, role: "assistant", body: "x".repeat(65 * 1024 * 1024) });
    database.updateSettings({ maxRetainedMiB: 64 });
    await manager.shutdown();
    assert.equal(killed.length, 2);
    assert.deepEqual(manager.list(), []);
    database.close();
    database = createOutrightDatabase({ filename, runtimeLease: true });
    assert.equal(database.reconcileTerminalAudit(), 0);
    for (const id of [first.id, second.id]) {
      const actions = database.listAudit(20).filter((entry) => entry.target === id).map((entry) => entry.action);
      assert.ok(actions.includes("terminal.created"));
      assert.ok(actions.includes("terminal.closed"));
    }
    database.updateSettings({ maxRetainedMiB: 128 });
    const retainedBeforeTrim = database.capacity().retainedBytes;
    const auditBeforeTrim = auditRetainedBytes(filename);
    const writer = new Database(filename);
    try {
      const insert = writer.prepare("INSERT INTO audit_log (action, target, details, created_at) VALUES ('telemetry', '', '{}', '2026-01-01')");
      writer.transaction(() => { for (let index = 0; index < 10_050; index += 1) insert.run(); }).immediate();
    } finally { writer.close(); }
    database.audit("telemetry", { target: "trim" });
    const trimmer = new Database(filename);
    try {
      let completedSweeps = 0;
      for (let page = 0; page < 512 && completedSweeps < 2; page += 1) {
        if (trimAuditPage(trimmer).complete) completedSweeps += 1;
      }
      assert.equal(completedSweeps, 2, "bounded pages did not revisit completed terminal owners");
    } finally { trimmer.close(); }
    assert.equal(database.capacity().retainedBytes - retainedBeforeTrim,
      auditRetainedBytes(filename) - auditBeforeTrim, "audit trimming updates retained bytes exactly");
    const proof = new Database(filename, { readonly: true });
    try {
      assert.equal(proof.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'terminal.created'").get().count, 0);
      assert.ok(proof.prepare("SELECT COUNT(*) AS count FROM audit_log").get().count <= AUDIT_RETENTION_LIMIT + 1);
    } finally { proof.close(); }
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("restart settles crash and maintenance-interrupted PTY evidence before retention trims it", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-terminal-recovery-"));
  const filename = path.join(directory, "runtime.db");
  let database = createOutrightDatabase({ filename, runtimeLease: true });
  let unavailable = false;
  const killed = [];
  const manager = createTerminalManager({ database: {
    auditAdmission: (...args) => database.auditAdmission(...args),
    auditCritical: (...args) => {
      if (unavailable) throw Object.assign(new Error("Archive maintenance is running"), { statusCode: 503 });
      database.auditCritical(...args);
    },
  }, publish: () => {}, spawnTerminal: () => ({ pid: 42, onData() {}, onExit() {}, kill() { killed.push(true); } }), terminate: async (terminal) => { terminal.process.kill(); } });
  try {
    const interrupted = manager.create({ cwd: "/tmp/interrupted" });
    unavailable = true;
    await assert.rejects(manager.shutdown(), (error) => error instanceof AggregateError);
    assert.equal(killed.length, 1);
    database.close();
    database = createOutrightDatabase({ filename, runtimeLease: true });
    assert.equal(database.reconcileTerminalAudit(), 0);
    await database.waitForTerminalAuditReconciliation();
    assert.ok(database.terminalUnknownReservations().some((entry) => entry.target === interrupted.id));
    const reserved = createTerminalManager({ database, publish: () => {}, maxTerminals: 1,
      spawnTerminal: () => { throw new Error("unverified capacity must reject before spawning"); } });
    assert.throws(() => reserved.create({ cwd: "/tmp/other" }), (error) => error.statusCode === 429);
    assert.equal(database.reconcileTerminalAudit(), 0);
    assert.ok(database.listAudit(20).some((entry) => entry.action === "terminal.unknown" && entry.target === interrupted.id));

    // A process crash can also interrupt a create or close request before
    // the PTY outcome is known. Recovery must settle each correlation key.
    const interruptedCwd = "/tmp/crashed-create-worktree";
    database.auditCritical("terminal.create.requested", { target: "unborn", operationId: "create-crash",
      cwd: interruptedCwd, ownershipLabel: "com.21n.outright.terminal.unborn",
      handshakePath: "/tmp/terminal-unborn.json", pid: 5432, processIdentity: "owned-start" });
    database.auditCritical("terminal.close.requested", { target: interrupted.id, operationId: "close-crash" });
    database.close();
    database = createOutrightDatabase({ filename, runtimeLease: true });
    assert.equal(database.reconcileTerminalAudit(), 0);
    await database.waitForTerminalAuditReconciliation();
    const actions = database.listAudit(20).map((entry) => entry.action);
    assert.ok(actions.includes("terminal.create.unknown"));
    assert.ok(actions.includes("terminal.close.unknown"));

    for (let index = 0; index < 3; index += 1) {
      database.auditCritical("terminal.created", { target: `restart-${index}` });
      database.close();
      database = createOutrightDatabase({ filename, runtimeLease: true });
      assert.equal(database.reconcileTerminalAudit(), 0);
      await database.waitForTerminalAuditReconciliation();
    }

    const writer = new Database(filename);
    try {
      const insert = writer.prepare("INSERT INTO audit_log (action, target, details, created_at) VALUES ('telemetry', '', '{}', '2026-01-01')");
      writer.transaction(() => { for (let index = 0; index < 10_050; index += 1) insert.run(); }).immediate();
    } finally { writer.close(); }
    database.audit("telemetry", { target: "trim" });
    database.close();
    database = createOutrightDatabase({ filename, runtimeLease: true });
    assert.equal(database.reconcileTerminalAudit(), 0);
    await waitFor(() => !database.terminalAuditScanPending || database.terminalAuditScanError, 10_000,
      () => database.terminalAuditScanError);
    assert.equal(database.terminalAuditScanError, null);
    assert.equal(database.terminalAuditScanPending, false);
    const recoveredRequest = database.terminalUnknownReservations().find((entry) => entry.target === "unborn");
    assert.equal(recoveredRequest?.cwd, interruptedCwd, "audit trimming lost the crashed terminal's worktree");
    assert.equal(recoveredRequest?.ownershipLabel, "com.21n.outright.terminal.unborn");
    assert.equal(recoveredRequest?.handshakePath, "/tmp/terminal-unborn.json");
    assert.equal(recoveredRequest?.pid, 5432);
    assert.equal(recoveredRequest?.processIdentity, "owned-start");
    const proof = new Database(filename, { readonly: true });
    try {
      assert.equal(proof.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'terminal.created'").get().count, 4);
      assert.ok(proof.prepare("SELECT COUNT(*) AS count FROM audit_log").get().count <= AUDIT_RETENTION_LIMIT + 10);
    } finally { proof.close(); }
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

// A runtime directory for a reattach test, cleaned up in one fixed order:
// its managers shut down, its prior-run brokers end, then the database
// closes and the directory goes. Windows refuses to remove a live shell's
// working directory, and a failed hook skips every later one.
const runtimes = new WeakMap();
function reattachRuntime(t, prefix, currentDatabase) {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  const runtime = { directory, filename: path.join(directory, "runtime.db"), stops: [] };
  runtimes.set(t, runtime);
  t.after(async () => {
    for (const stop of runtime.stops.reverse()) await Promise.resolve().then(stop).catch(() => {});
    currentDatabase().close();
    rmSync(directory, { recursive: true, force: true });
  });
  return runtime;
}

// A terminal a previous Outright process launched with reattach on: a broker
// at the managed address, its private record and created audit. Its peer
// then closes as when that process crashed, while the broker stays alive.
async function priorRunTerminal(t, database, cwd, { recordToken, windowMs = 60_000, savedOutput = null,
  detachedCommand = "setTimeout(() => console.log('while-' + 'detached'), 300)" } = {}) {
  const id = randomUUID();
  if (savedOutput) {
    // That process's history, as its abrupt end left it.
    const history = openTerminalHistory({ directory: path.join(database.launchDirectory, "terminal-history") });
    assert.equal(history.begin({ id, name: "Terminal", cwd, createdAt: new Date().toISOString() }, savedOutput), true);
    history.finish(id);
    history.close();
  }
  const ownership = terminalOwnership(id, database.launchDirectory);
  const token = reattachToken();
  const brokerScript = fileURLToPath(new URL("./terminal-broker.mjs", import.meta.url));
  const broker = spawn(process.execPath, [brokerScript, ownership.address, ownership.token],
    { stdio: "ignore", detached: process.platform !== "win32", windowsHide: true });
  const exited = () => broker.exitCode !== null || broker.signalCode !== null;
  const kill = () => {
    if (exited()) return;
    if (process.platform === "win32") spawnSync("taskkill", ["/T", "/F", "/PID", String(broker.pid)], { windowsHide: true, stdio: "ignore", timeout: 5000 });
    else try { process.kill(-broker.pid, "SIGKILL"); } catch {}
  };
  if (runtimes.has(t)) runtimes.get(t).stops.push(kill);
  else t.after(kill);
  let socket;
  const deadline = Date.now() + 8000;
  while (!socket) {
    try {
      socket = await new Promise((resolve, reject) => {
        const candidate = net.createConnection(ownership.address);
        candidate.once("connect", () => resolve(candidate));
        candidate.once("error", reject);
      });
    } catch (error) {
      if (Date.now() > deadline || exited()) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  let frames = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => { frames += chunk; });
  const send = (message) => socket.write(`${JSON.stringify(message)}\n`);
  send({ type: "start", token: ownership.token, shell: process.execPath, cwd, env: process.env, cols: 100, rows: 30,
    session: { label: ownership.label, token, windowMs } });
  await waitFor(() => frames.includes('"type":"ready"'), 10_000, () => frames);
  const identity = JSON.parse(frames.slice(0, frames.indexOf("\n"))).identity;
  writeReattachRecord(id, database.launchDirectory, { identity, token: recordToken ?? token });
  database.auditCritical("terminal.created", { target: id, cwd, ownershipLabel: ownership.label,
    handshakePath: ownership.handshakePath, pid: broker.pid });
  // Only the shell's output counts; the ready frame's identity can hold any digits.
  const output = () => frames.slice(0, frames.lastIndexOf("\n")).split("\n")
    .filter((line) => line.startsWith('{"type":"data"')).map((line) => JSON.parse(line).data).join("");
  send({ type: "write", data: "globalThis.kept = 41\r" });
  await waitFor(() => output().includes("41"), 10_000, output);
  // The shell runs detachedCommand once the peer is gone. It acknowledges
  // the command first, so the broker has read it before the close: input
  // still unread when a peer closes can be lost, as in a crash.
  const peerGone = path.join(cwd, `${id}.detached`);
  send({ type: "write", data: `globalThis.armed = setInterval(() => { if (!require('node:fs').existsSync(${JSON.stringify(peerGone)})) return; `
    + `clearInterval(armed); ${detachedCommand}; }, 25); console.log('ar' + 'med')\r` });
  await waitFor(() => output().includes("armed"), 10_000, output);
  socket.destroy();
  await new Promise((resolve) => socket.once("close", resolve));
  writeFileSync(peerGone, "");
  return { id, token, identity, broker, exited, kill };
}

function restartDatabase(database, filename) {
  database.close();
  const reopened = createOutrightDatabase({ filename, runtimeLease: true });
  reopened.reconcileTerminalAudit();
  return reopened.waitForTerminalAuditReconciliation().then(() => reopened);
}

test("restart recovery reattaches a live prior-run shell with its buffered output, audit and capacity", { timeout: 60_000 }, async (t) => {
  const { directory, filename, stops } = reattachRuntime(t, "outright-terminal-reattach-", () => database);
  let database = createOutrightDatabase({ filename, runtimeLease: true });
  const prior = await priorRunTerminal(t, database, directory);
  database = await restartDatabase(database, filename);
  const events = [];
  const manager = createTerminalManager({ database, publish: (event) => events.push(event), maxTerminals: 1, reattachEnabled: () => true,
    runtimeInstanceId: "runtime-B",
    recoverTerminal: async () => { await waitFor(prior.exited, 6000).catch(() => {}); return prior.exited(); } });
  stops.push(() => manager.shutdown());
  // The detached shell holds its slot before and after it is reattached.
  assert.equal(manager.capacity().active, 1);
  assert.equal(manager.get(prior.id).recoveryReservation, true);
  await assert.rejects(manager.create({ cwd: directory }), (error) => error.statusCode === 429);
  assert.equal(await manager.reconcileUnknown(), 1);
  assert.equal(prior.exited(), false, "recovery ended a shell it could reattach");
  const live = manager.get(prior.id);
  assert.equal(live.status, "running");
  assert.equal(live.reattached, true);
  assert.equal(live.recoveryReservation, undefined);
  assert.deepEqual(manager.capacity(), { active: 1, unknown: 0, limit: 1 });
  // A page that connected during recovery learns which runtime verified it.
  const announced = events.filter((event) => event.type === "terminal.reattached");
  assert.equal(announced.length, 1);
  assert.equal(announced[0].terminalId, prior.id);
  assert.deepEqual({ ...announced[0].payload, pid: undefined, createdAt: undefined }, { ...manager.list().find((entry) => entry.id === prior.id),
    pid: undefined, createdAt: undefined, runtimeInstanceId: "runtime-B" });
  assert.equal(announced[0].payload.recoveryReservation, undefined);
  await assert.rejects(manager.create({ cwd: directory }), (error) => error.statusCode === 429);
  await waitFor(() => manager.get(prior.id).buffer.includes("while-detached"), 10_000, () => manager.get(prior.id).buffer);
  assert.equal(manager.write(prior.id, "kept + 1\r"), true);
  await waitFor(() => manager.get(prior.id).buffer.includes("42"), 10_000, () => manager.get(prior.id).buffer);
  const reattached = database.listAudit(50).filter((entry) => entry.action === "terminal.reattached");
  assert.deepEqual(reattached.map((entry) => entry.target), [prior.id]);
  assert.equal(JSON.stringify(database.listAudit(50)).includes(prior.token), false, "a reattach token reached the audit log");
  const rotated = readReattachRecord(prior.id, database.launchDirectory);
  assert.equal(rotated.identity, prior.identity);
  assert.notEqual(rotated.token, prior.token, "a successful reattach kept its spent token");
  assert.equal(await manager.close(prior.id), true);
  assert.equal(prior.exited(), true);
  assert.equal(readReattachRecord(prior.id, database.launchDirectory), null);
  // The settled prior-run owner never returns as a reservation.
  manager.reloadUnknownReservations();
  assert.deepEqual(manager.capacity(), { active: 0, unknown: 0, limit: 1 });
  assert.equal(database.terminalUnknownReservations().some((entry) => entry.target === prior.id), false);
});

test("a refused or expired reattach, or reattach switched off, ends the prior-run shell through native recovery", { timeout: 90_000 }, async (t) => {
  for (const scenario of [{ enabled: true, recordToken: reattachToken() }, { enabled: false },
    { enabled: true, windowMs: 300, expires: true }]) {
    const directory = mkdtempSync(path.join(os.tmpdir(), "outright-terminal-reattach-refused-"));
    const filename = path.join(directory, "runtime.db");
    let database = createOutrightDatabase({ filename, runtimeLease: true });
    try {
      const prior = await priorRunTerminal(t, database, directory, scenario);
      // The detach window ends the shell and its broker before any restart.
      if (scenario.expires) await waitFor(prior.exited, 10_000);
      database = await restartDatabase(database, filename);
      let proofs = 0;
      const events = [];
      const manager = createTerminalManager({ database, publish: (event) => events.push(event), reattachEnabled: () => scenario.enabled,
        runtimeInstanceId: "runtime-B",
        recoverTerminal: async () => {
          proofs += 1;
          assert.equal(prior.exited(), Boolean(scenario.expires), "the shell's end did not match the detach window");
          prior.kill();
          await waitFor(prior.exited, 6000);
          return true;
        } });
      try {
        assert.equal(await manager.reconcileUnknown(), 1);
        assert.equal(proofs, 1);
        assert.equal(manager.get(prior.id), null);
        assert.equal(manager.list().some((entry) => entry.reattached), false);
        assert.equal(events.some((event) => event.type === "terminal.reattached"), false);
        assert.equal(database.listAudit(50).some((entry) => entry.action === "terminal.reattached"), false);
        assert.equal(database.listAudit(50).some((entry) => entry.action === "terminal.recovered" && entry.target === prior.id), true);
        assert.equal(readReattachRecord(prior.id, database.launchDirectory), null);
        assert.equal(manager.capacity().active, 0);
      } finally { await manager.shutdown(); }
    } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
  }
});

test("a managed terminal keeps a private reattach record only while reattach is on", { timeout: 40_000 }, async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-terminal-reattach-record-"));
  const database = createOutrightDatabase({ filename: path.join(directory, "runtime.db"), runtimeLease: true });
  let enabled = true;
  const manager = createTerminalManager({ database, publish: () => {}, reattachEnabled: () => enabled });
  try {
    const terminal = await manager.create({ cwd: directory });
    const file = path.join(database.launchDirectory, `terminal-${terminal.id}.reattach`);
    const record = readReattachRecord(terminal.id, database.launchDirectory);
    assert.ok(record, "no reattach record was kept for a reattachable terminal");
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
    else {
      // Windows keeps it private through the launch directory's hardened ACL:
      // the directory and the record grant no principal beyond the owner set.
      const report = probeWindowsHistoryAcl(database.launchDirectory, (command, args, options) => spawnSync(command, args,
        { ...options, env: { ...options.env, OUTRIGHT_HISTORY_NAMES: `^terminal-${terminal.id}\\.reattach$` } }));
      assert.equal(windowsAclPrivate(report), true, `the reattach record is not private: ${JSON.stringify(report)}`);
    }
    assert.equal(JSON.stringify(database.listAudit(20)).includes(record.token), false);
    assert.equal(manager.get(terminal.id).reattached, undefined, "a new shell was labeled as reattached");
    assert.equal(await manager.close(terminal.id), true);
    assert.equal(existsSync(file), false);
    enabled = false;
    const plain = await manager.create({ cwd: directory });
    assert.equal(existsSync(path.join(database.launchDirectory, `terminal-${plain.id}.reattach`)), false);
  } finally {
    await manager.shutdown();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// Native recovery for a prior-run broker the test launched: it ends that
// broker, unless a call is told to fail as a transient proof failure would.
function brokerRecovery(prior, { failFirst = false } = {}) {
  const recovery = async () => {
    recovery.calls += 1;
    if (failFirst && recovery.calls === 1) return false;
    prior.kill();
    await waitFor(prior.exited, 6000).catch(() => {});
    return prior.exited();
  };
  recovery.calls = 0;
  return recovery;
}

test("a reattached shell's detached output reaches saved history once, after the output saved before the restart", { timeout: 120_000 }, async (t) => {
  const { directory, filename, stops } = reattachRuntime(t, "outright-terminal-reattach-history-", () => database);
  let database = createOutrightDatabase({ filename, runtimeLease: true });
  const saved = await priorRunTerminal(t, database, directory, { savedOutput: "saved-before-restart\r\n" });
  // Enough output while detached to overflow the 1 MiB ring on every PTY,
  // then a marker and a completion file, so the ring has dropped its oldest
  // output first. ConPTY renders rather than relays output; 8 MiB still
  // yields well over 1 MiB there.
  const done = path.join(directory, "overflow.done");
  const overflow = await priorRunTerminal(t, database, directory, { detachedCommand: "setTimeout(() => { "
    + "process.stdout.write('x'.repeat(8 * 1024 * 1024) + '\\r\\ntail-' + 'marker\\r\\n'); "
    + `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(done)}, '1'), 500); }, 300)` });
  await waitFor(() => existsSync(done), 60_000);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(saved.exited() || overflow.exited(), false, "a detached shell ended inside its window");
  database = await restartDatabase(database, filename);
  // Holding each adapter back lets its whole replay arrive before the manager
  // observes it, as when the event loop is busy, so registration delivers it.
  const manager = createTerminalManager({ database, publish: () => {}, reattachEnabled: () => true,
    recoverTerminal: async () => true, reattachTerminal: async (options) => {
      const adapter = await reattachManagedTerminal(options);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return adapter;
    } });
  stops.push(() => manager.shutdown());
  assert.equal(await manager.reconcileUnknown(), 2);
  const notice = /earlier terminal output characters were dropped while detached/g;
  const live = (id) => manager.get(id).buffer;
  await waitFor(() => live(saved.id).includes("while-detached") && live(overflow.id).includes("tail-marker"), 20_000);
  // A later restart restores exactly what this runtime saved.
  await manager.shutdown().catch(() => {});
  saved.kill();
  overflow.kill();
  const restored = openTerminalHistory({ directory: path.join(database.launchDirectory, "terminal-history") });
  try {
    const first = restored.read(saved.id);
    assert.equal(first.split("saved-before-restart").length, 2, first.slice(-2000));
    assert.equal(first.split("while-detached").length, 2, first.slice(-2000));
    assert.ok(first.indexOf("saved-before-restart") < first.indexOf("while-detached"));
    const second = restored.read(overflow.id);
    assert.equal(second.match(notice)?.length, 1, `the overflowed ring's notice was not saved once: ${second.length} ${JSON.stringify(second.slice(0, 600))}`);
    assert.equal(second.split("tail-marker").length, 2);
    assert.ok(second.search(notice) < second.indexOf("tail-marker"));
  } finally { restored.close(); }
});

test("a reattached terminal closed unexpectedly is still ended, audited and released by a later close", { timeout: 60_000 }, async (t) => {
  const { directory, filename, stops } = reattachRuntime(t, "outright-terminal-reattach-unexpected-", () => database);
  let database = createOutrightDatabase({ filename, runtimeLease: true });
  const prior = await priorRunTerminal(t, database, directory);
  database = await restartDatabase(database, filename);
  // The first native proof fails transiently; a later one must be asked for.
  const recoverTerminal = brokerRecovery(prior, { failFirst: true });
  let adapter;
  const manager = createTerminalManager({ database, publish: () => {}, maxTerminals: 1, reattachEnabled: () => true,
    recoverTerminal, reattachTerminal: async (options) => (adapter = await reattachManagedTerminal(options)) });
  stops.push(() => manager.shutdown());
  assert.equal(await manager.reconcileUnknown(), 1);
  assert.equal(manager.get(prior.id).reattached, true);
  // A frame the broker refuses drops this connection; the broker detaches again.
  adapter.write("x".repeat(70 * 1024));
  await waitFor(() => manager.get(prior.id).status === "unknown", 10_000);
  assert.equal(recoverTerminal.calls, 1);
  assert.equal(prior.exited(), false);
  assert.deepEqual(manager.capacity(), { active: 1, unknown: 1, limit: 1 });
  assert.equal(await manager.close(prior.id), true);
  assert.equal(recoverTerminal.calls, 2, "termination reused a stale unverified proof");
  assert.equal(prior.exited(), true);
  assert.equal(database.listAudit(50).some((entry) => entry.action === "terminal.closed" && entry.target === prior.id), true);
  manager.reloadUnknownReservations();
  assert.deepEqual(manager.capacity(), { active: 0, unknown: 0, limit: 1 });
});

test("shutdown joins a reattach in flight and hands its shell back to the broker for the next runtime", { timeout: 60_000 }, async (t) => {
  const { directory, filename, stops } = reattachRuntime(t, "outright-terminal-reattach-shutdown-", () => database);
  let database = createOutrightDatabase({ filename, runtimeLease: true });
  const prior = await priorRunTerminal(t, database, directory);
  // The shell prints while detached, before this runtime's reattach drains it.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  database = await restartDatabase(database, filename);
  const order = [];
  let deliver;
  let nextToken;
  // The broker accepts the reattach, but its adapter reaches this runtime
  // only after shutdown has begun.
  const stopping = createTerminalManager({ database, publish: () => {}, reattachEnabled: () => true,
    recoverTerminal: async () => { order.push("native-recovery"); return false; },
    reattachTerminal: async (options) => {
      nextToken = options.nextToken;
      const adapter = await reattachManagedTerminal(options);
      assert.ok(adapter, "the live broker refused its current token");
      const { terminate, release } = adapter;
      adapter.terminate = () => { order.push("terminate"); return terminate(); };
      adapter.release = () => { order.push("release"); return release(); };
      await new Promise((resolve) => { deliver = resolve; });
      order.push("adapter-delivered");
      return adapter;
    } });
  const reconcile = stopping.reconcileUnknown();
  await waitFor(() => deliver, 10_000);
  const shutdown = stopping.shutdown().then(() => order.push("shutdown-returned"));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(order, [], "shutdown returned before the reattach in flight settled");
  deliver();
  await shutdown;
  assert.equal(await reconcile, 0);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual(order, ["adapter-delivered", "release", "shutdown-returned"]);
  assert.equal(prior.exited(), false, "shutdown ended a shell the next runtime could reattach");
  assert.equal(readReattachRecord(prior.id, database.launchDirectory)?.token, nextToken, "the rotated token was not kept");
  assert.equal(database.listAudit(50).some((entry) => entry.action === "terminal.reattached" || entry.target === prior.id
    && entry.action === "terminal.recovered"), false);
  // The successor reattaches the same live shell with the rotated token, and
  // the output the stopping runtime was handed reaches it once, before new
  // output.
  database = await restartDatabase(database, filename);
  const successor = createTerminalManager({ database, publish: () => {}, reattachEnabled: () => true,
    recoverTerminal: brokerRecovery(prior) });
  stops.push(() => successor.shutdown());
  assert.equal(await successor.reconcileUnknown(), 1);
  assert.equal(successor.get(prior.id).reattached, true);
  assert.equal(successor.write(prior.id, "kept + 1\r"), true);
  await waitFor(() => successor.get(prior.id).buffer.includes("42"), 10_000, () => successor.get(prior.id).buffer);
  const live = successor.get(prior.id).buffer;
  assert.equal(live.split("while-detached").length, 2, `the handed-back output was not kept once: ${JSON.stringify(live)}`);
  assert.ok(live.indexOf("while-detached") < live.lastIndexOf("42"));
  await successor.shutdown();
  assert.equal(prior.exited(), true);
  // A further restart restores it once, in order, from saved history.
  const restored = openTerminalHistory({ directory: path.join(database.launchDirectory, "terminal-history") });
  try {
    const saved = restored.read(prior.id);
    assert.equal(saved.split("while-detached").length, 2, JSON.stringify(saved));
    assert.ok(saved.indexOf("while-detached") < saved.lastIndexOf("42"));
  } finally { restored.close(); }
});

test("shutdown before the reattach proof leaves the token and the detached output with the broker", { timeout: 60_000 }, async (t) => {
  const { directory, filename, stops } = reattachRuntime(t, "outright-terminal-reattach-withdrawn-", () => database);
  let database = createOutrightDatabase({ filename, runtimeLease: true });
  const prior = await priorRunTerminal(t, database, directory);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  database = await restartDatabase(database, filename);
  const order = [];
  let shutdown;
  // Shutdown begins once the broker has proven itself, just before this
  // runtime would spend the token.
  const stopping = createTerminalManager({ database, publish: () => {}, reattachEnabled: () => true,
    recoverTerminal: async () => { order.push("native-recovery"); return false; },
    reattachTerminal: async (options) => {
      const adapter = await reattachManagedTerminal({ ...options, proceed: () => {
        order.push("proceed");
        shutdown = stopping.shutdown();
        return options.proceed();
      } });
      order.push(adapter ? "reattached" : "withdrawn");
      return adapter;
    } });
  assert.equal(await stopping.reconcileUnknown(), 0);
  await shutdown;
  assert.deepEqual(order, ["proceed", "withdrawn"]);
  assert.equal(prior.exited(), false);
  assert.equal(readReattachRecord(prior.id, database.launchDirectory)?.token, prior.token, "the token was spent or removed");
  assert.equal(database.listAudit(50).some((entry) => entry.target === prior.id
    && (entry.action === "terminal.reattached" || entry.action === "terminal.recovered")), false);
  // The successor spends the original token and still receives the output
  // the shell printed while detached.
  database = await restartDatabase(database, filename);
  const successor = createTerminalManager({ database, publish: () => {}, reattachEnabled: () => true,
    recoverTerminal: brokerRecovery(prior) });
  stops.push(() => successor.shutdown());
  assert.equal(await successor.reconcileUnknown(), 1);
  assert.equal(successor.get(prior.id).reattached, true);
  await waitFor(() => successor.get(prior.id).buffer.includes("while-detached"), 10_000, () => successor.get(prior.id).buffer);
  assert.equal(successor.get(prior.id).buffer.split("while-detached").length, 2);
  assert.equal(await successor.close(prior.id), true);
  assert.equal(prior.exited(), true);
});

test("a reattach whose audit fails ends the shell and writes the output it was handed straight to history", { timeout: 60_000 }, async (t) => {
  const { directory, filename, stops } = reattachRuntime(t, "outright-terminal-reattach-unaudited-", () => database);
  let database = createOutrightDatabase({ filename, runtimeLease: true });
  const prior = await priorRunTerminal(t, database, directory, { savedOutput: "saved-before-restart\r\n" });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  database = await restartDatabase(database, filename);
  const { auditCritical } = database;
  database.auditCritical = (action, evidence) => {
    if (action === "terminal.reattached") throw new Error("audit storage unavailable");
    return auditCritical.call(database, action, evidence);
  };
  const historyDirectory = path.join(database.launchDirectory, "terminal-history");
  const newestSegment = () => {
    const segments = readdirSync(historyDirectory).map((name) => name.match(new RegExp(`^${prior.id}\\.(\\d+)\\.log$`)))
      .filter(Boolean).sort((a, b) => Number(b[1]) - Number(a[1]));
    return segments.length ? readFileSync(path.join(historyDirectory, segments[0][0]), "utf8") : "";
  };
  // While the shell ends it floods more output than any reattach buffer
  // holds. Each frame is on disk once delivered, so none is retained here.
  const flood = Array.from({ length: 6 }, (_, index) => `flood-${index}-${"x".repeat(200_000)}`);
  const unsaved = [];
  const manager = createTerminalManager({ database, publish: () => {}, reattachEnabled: () => true,
    recoverTerminal: brokerRecovery(prior),
    reattachTerminal: async (options) => {
      const adapter = await reattachManagedTerminal(options);
      if (!adapter) return adapter;
      let deliver;
      let replayed = "";
      const { onData, terminate } = adapter;
      adapter.onData = (callback) => {
        deliver = callback;
        onData((data) => { replayed += data; callback(data); });
      };
      adapter.terminate = async () => {
        // The broker's replay arrives first; the flood follows it. The
        // shell still ends if the replay never comes.
        try {
          await waitFor(() => replayed.includes("while-detached"), 10_000, () => replayed);
          flood.forEach((frame, index) => {
            deliver?.(frame);
            if (!newestSegment().includes(`flood-${index}-`)) unsaved.push(index);
          });
        } finally { await terminate(); }
      };
      return adapter;
    } });
  stops.push(() => manager.shutdown());
  assert.equal(await manager.reconcileUnknown(), 1);
  assert.deepEqual(unsaved, [], "output delivered during termination was held instead of written to history");
  assert.equal(prior.exited(), true);
  const audit = database.listAudit(50);
  assert.equal(audit.some((entry) => entry.action === "terminal.reattached"), false);
  assert.equal(audit.some((entry) => entry.action === "terminal.recovered" && entry.target === prior.id), true);
  const ended = manager.get(prior.id);
  assert.equal(ended.status, "ended");
  await manager.shutdown();
  const history = openTerminalHistory({ directory: historyDirectory });
  const saved = history.read(prior.id);
  history.close();
  const marks = ["saved-before-restart", "while-detached", ...flood.map((_, index) => `flood-${index}-`)];
  for (const mark of marks) assert.equal(saved.split(mark).length, 2, `${mark} was not saved exactly once`);
  assert.deepEqual(marks.map((mark) => saved.indexOf(mark)), marks.map((mark) => saved.indexOf(mark)).sort((a, b) => a - b));
});

// A broker endpoint that holds the token for a fresh id and, once proven,
// lets the test send what follows "reattached".
async function provenReattachEndpoint(afterProve) {
  const id = randomUUID();
  const identity = randomUUID();
  const token = reattachToken();
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-terminal-early-"));
  const ownership = terminalOwnership(id, directory);
  const sockets = new Set();
  const endpoint = net.createServer((socket) => {
    let pending = "";
    let challenge;
    sockets.add(socket);
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      pending += chunk;
      for (let end; (end = pending.indexOf("\n")) !== -1; pending = pending.slice(end + 1)) {
        const message = JSON.parse(pending.slice(0, end));
        const send = (frame) => socket.write(`${JSON.stringify(frame)}\n`);
        if (message.type === "reattach") {
          challenge = reattachNonce();
          send({ type: "challenge", nonce: challenge, proof: reattachProof(token, "broker", [message.nonce, challenge, ownership.label, identity]) });
        } else if (message.type === "prove") {
          send({ type: "reattached", identity, pid: process.pid });
          afterProve(socket, send);
        } else if (message.type === "release") {
          send({ type: "released" });
          socket.end();
        }
      }
    });
  });
  await new Promise((resolve) => endpoint.listen(ownership.address, resolve));
  return {
    reattach: () => reattachManagedTerminal({ id, identity, token, nextToken: reattachToken(), verifyEmpty: async () => true }),
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => endpoint.close(resolve));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

// Hands the client its reads in batches of at least minChars, as one Windows
// named-pipe read can, so a single read carries many complete frames.
function coalesceClientReads(minChars) {
  const createConnection = net.createConnection;
  net.createConnection = (...args) => {
    const socket = createConnection(...args);
    const emit = socket.emit;
    let held = "";
    let timer;
    const flush = () => {
      clearTimeout(timer);
      if (!held) return;
      const data = held;
      held = "";
      emit.call(socket, "data", data);
    };
    socket.emit = function (event, ...rest) {
      if (event !== "data") { flush(); return emit.call(this, event, ...rest); }
      held += rest[0];
      if (held.length >= minChars) flush();
      else { clearTimeout(timer); timer = setTimeout(flush, 20); }
      return true;
    };
    return socket;
  };
  return () => { net.createConnection = createConnection; };
}

test("replay that outgrows the reattach buffer before it is taken is announced once, by registration or by hand-back", { timeout: 60_000 }, async () => {
  // A broker that holds the token sends more replay than the client keeps
  // before anything consumes it, in frames of distinct letters. Coalesced
  // reads deliver several frames, over the per-frame limit, in one read.
  const frames = Array.from({ length: 21 }, (_, index) => String.fromCharCode(97 + index).repeat(64 * 1024));
  for (const reads of ["streamed", "coalesced"]) for (const consumer of ["registration", "hand-back"]) {
    const label = `${consumer}, ${reads} reads`;
    const endpoint = await provenReattachEndpoint((socket, send) => {
      for (const data of frames) send({ type: "data", data });
      if (consumer === "registration") socket.end();
    });
    const restore = reads === "coalesced" ? coalesceClientReads(512 * 1024) : () => {};
    try {
      const adapter = await endpoint.reattach();
      assert.ok(adapter, `${label}: the endpoint holding the token was refused`);
      let delivered;
      let exit;
      if (consumer === "registration") {
        // The close follows every frame, so all of them wait for onData.
        exit = await new Promise((resolve) => adapter.onExit(resolve));
        delivered = [];
        adapter.onData((data) => delivered.push(data));
      } else delivered = await adapter.release();
      assert.ok(delivered.length > 1, `${label}: ${delivered.length} replay frames were delivered (exit ${JSON.stringify(exit)})`);
      const notice = delivered[0].match(/^\u001b\[0m\[Outright: (\d+) earlier terminal output characters were dropped while reattaching\]\r\n$/);
      assert.ok(notice, `${label}: dropped replay was not announced: ${JSON.stringify(delivered[0].slice(0, 80))}`);
      const kept = delivered.slice(1).join("");
      const sent = frames.join("");
      assert.ok(kept.length <= 1_100_000, `${label}: ${kept.length} replay characters were held`);
      assert.equal(Number(notice[1]) + kept.length, sent.length, `${label}: the notice miscounted the dropped replay`);
      assert.ok(sent.endsWith(kept), `${label}: the newest replay was not what was kept`);
      // A second consumer is told nothing twice.
      assert.deepEqual(await adapter.release(), [], `${label}: the drop was announced twice`);
    } finally {
      restore();
      await endpoint.close();
    }
  }
});

test("a reattach frame over the read limit still ends the attempt, terminated or not, in any read size", { timeout: 60_000 }, async () => {
  for (const reads of ["streamed", "coalesced"]) for (const terminated of [true, false]) {
    const label = `${terminated ? "terminated" : "unterminated"} frame, ${reads} reads`;
    const endpoint = await provenReattachEndpoint((socket, send) => {
      send({ type: "data", data: "before-oversized" });
      socket.write(`${JSON.stringify({ type: "data", data: "x".repeat(300 * 1024) })}${terminated ? "\n" : ""}`);
      if (terminated) send({ type: "data", data: "after-oversized" });
    });
    const restore = reads === "coalesced" ? coalesceClientReads(512 * 1024) : () => {};
    try {
      const adapter = await endpoint.reattach();
      assert.ok(adapter, `${label}: the endpoint holding the token was refused`);
      // The client ends the attempt itself; the endpoint never closes.
      let timer;
      const ended = await Promise.race([new Promise((resolve) => adapter.onExit(() => resolve(true))),
        new Promise((resolve) => { timer = setTimeout(resolve, 10_000, false); })]).finally(() => clearTimeout(timer));
      const delivered = [];
      adapter.onData((data) => delivered.push(data));
      assert.equal(delivered.some((data) => data.startsWith("x") || data === "after-oversized"), false,
        `${label}: output at or after the oversized frame was delivered`);
      assert.ok(ended, `${label}: the client kept the attempt open past the oversized frame`);
    } finally {
      restore();
      await endpoint.close();
    }
  }
});

test("an endpoint that cannot prove the reattach token is refused before anything spendable or typed reaches it", { timeout: 60_000 }, async () => {
  for (const reply of ["echo", "forged"]) {
    const directory = mkdtempSync(path.join(os.tmpdir(), "outright-terminal-reattach-forged-"));
    const filename = path.join(directory, "runtime.db");
    let database = createOutrightDatabase({ filename, runtimeLease: true });
    const id = randomUUID();
    const ownership = terminalOwnership(id, database.launchDirectory);
    const record = { identity: randomUUID(), token: reattachToken() };
    writeReattachRecord(id, database.launchDirectory, record);
    database.auditCritical("terminal.created", { target: id, cwd: directory, ownershipLabel: ownership.label,
      handshakePath: ownership.handshakePath, pid: process.pid });
    // Another local user's endpoint at the managed address. It knows the
    // session's public identity, but not its token.
    let received = "";
    const endpoint = net.createServer((socket) => {
      socket.setEncoding("utf8");
      socket.on("error", () => {});
      socket.on("data", (chunk) => {
        received += chunk;
        const frames = reply === "echo" ? [{ type: "reattached", identity: record.identity, pid: process.pid }]
          : [{ type: "challenge", nonce: reattachToken(), proof: reattachProof(reattachToken(), "broker", ["", "", ownership.label, record.identity]) },
            { type: "reattached", identity: record.identity, pid: process.pid }];
        for (const frame of frames) socket.write(`${JSON.stringify(frame)}\n`);
      });
    });
    await new Promise((resolve) => endpoint.listen(ownership.address, resolve));
    try {
      database = await restartDatabase(database, filename);
      let proofs = 0;
      const manager = createTerminalManager({ database, publish: () => {}, reattachEnabled: () => true,
        recoverTerminal: async () => { proofs += 1; return true; } });
      try {
        assert.equal(await manager.reconcileUnknown(), 1);
        assert.equal(proofs, 1);
        assert.equal(manager.get(id), null);
        assert.equal(manager.list().some((entry) => entry.reattached), false);
        const audit = database.listAudit(50);
        assert.equal(audit.some((entry) => entry.action === "terminal.reattached"), false);
        assert.equal(audit.some((entry) => entry.action === "terminal.recovered" && entry.target === id), true);
        assert.equal(readReattachRecord(id, database.launchDirectory), null);
        const messages = received.trim().split("\n").map((line) => JSON.parse(line));
        assert.deepEqual(messages.map((message) => Object.keys(message).sort()), [["nonce", "type"]], received);
        assert.equal(received.includes(record.token), false, "the token reached an unproven endpoint");
      } finally { await manager.shutdown(); }
    } finally {
      await new Promise((resolve) => endpoint.close(resolve));
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("a reattach record whose token is not a string is unverifiable and takes the ended path without a crash", { timeout: 60_000 }, async () => {
  for (const malformed of [[reattachToken()], 12345, { token: reattachToken() }]) {
    const directory = mkdtempSync(path.join(os.tmpdir(), "outright-terminal-reattach-malformed-"));
    const filename = path.join(directory, "runtime.db");
    let database = createOutrightDatabase({ filename, runtimeLease: true });
    const id = randomUUID();
    const identity = randomUUID();
    const ownership = terminalOwnership(id, database.launchDirectory);
    // A private record Outright did not write, such as a corrupted one.
    writeFileSync(path.join(database.launchDirectory, `terminal-${id}.reattach`), `${JSON.stringify({ id, identity, token: malformed })}\n`, { mode: 0o600 });
    database.auditCritical("terminal.created", { target: id, cwd: directory, ownershipLabel: ownership.label,
      handshakePath: ownership.handshakePath, pid: process.pid });
    // An endpoint that answers every attempt with a challenge, so a token
    // that reached the proof would be used as an HMAC key.
    let received = "";
    const endpoint = net.createServer((socket) => {
      socket.setEncoding("utf8");
      socket.on("error", () => {});
      socket.on("data", (chunk) => {
        received += chunk;
        socket.write(`${JSON.stringify({ type: "challenge", nonce: reattachToken(), proof: reattachToken() })}\n`);
      });
    });
    await new Promise((resolve) => endpoint.listen(ownership.address, resolve));
    try {
      assert.equal(readReattachRecord(id, database.launchDirectory), null, `a ${typeof malformed} token was read as valid`);
      assert.equal(await reattachManagedTerminal({ id, identity, token: malformed, nextToken: reattachToken(), verifyEmpty: async () => true }), null);
      assert.equal(received, "", "a malformed token was offered to the endpoint");
      database = await restartDatabase(database, filename);
      let proofs = 0;
      const manager = createTerminalManager({ database, publish: () => {}, reattachEnabled: () => true,
        recoverTerminal: async () => { proofs += 1; return true; } });
      try {
        assert.equal(await manager.reconcileUnknown(), 1);
        assert.equal(proofs, 1);
        assert.equal(manager.get(id), null);
        const audit = database.listAudit(50);
        assert.equal(audit.some((entry) => entry.action === "terminal.reattached"), false);
        assert.equal(audit.some((entry) => entry.action === "terminal.recovered" && entry.target === id), true);
        assert.equal(manager.capacity().active, 0);
        assert.equal(received, "", "recovery offered a malformed token to the endpoint");
      } finally { await manager.shutdown(); }
    } finally {
      await new Promise((resolve) => endpoint.close(resolve));
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

async function waitFor(predicate, timeout = 3000, diagnostic = () => "") {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for PTY output: ${JSON.stringify(diagnostic())}`);
}

function auditRetainedBytes(filename) {
  const proof = new Database(filename, { readonly: true });
  try {
    return proof.prepare(`SELECT COALESCE(SUM(128 + LENGTH(CAST(action AS BLOB))
      + COALESCE(LENGTH(CAST(target AS BLOB)), 0)
      + COALESCE(LENGTH(CAST(details AS BLOB)), 0)
      + LENGTH(CAST(created_at AS BLOB))), 0) AS bytes FROM audit_log`).get().bytes;
  } finally { proof.close(); }
}
