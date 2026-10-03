import assert from "node:assert/strict";
import test from "node:test";
import { createTerminalManager } from "./terminal-manager.mjs";
import { recoverManagedTerminal } from "./managed-terminal.mjs";
import { createSubprocessBudget } from "./subprocess-budget.mjs";
import { createOutrightDatabase } from "./database.mjs";
import { createOutrightRuntime } from "./outright-runtime.mjs";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFile, spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

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
  const terminal = manager.create({ cwd: "/tmp/w" });
  await assert.rejects(manager.close(terminal.id), (error) =>
    error.statusCode === 503 && error.details?.outcomeUnknown === true && Boolean(error.details.operationId));
  assert.equal(killed, true);
  assert.equal(manager.get(terminal.id)?.status, "unknown");
  assert.ok(actions.some((entry) => entry.action === "terminal.close.requested"));
  auditUnavailable = false;
  await manager.shutdown();
  assert.equal(manager.capacity().active, 0);
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
  const actions = [];
  const manager = createTerminalManager({ maxTerminals: 1, maxTerminalsPerCwd: 1,
    database: { auditAdmission: (action) => actions.push(action), auditCritical: (action) => actions.push(action), auditRequired: async () => {} },
    publish: () => {},
    spawnTerminal: () => ({ pid: 99999, onData() {}, onExit() {}, kill() {} }),
    terminate: () => new Promise((resolve, reject) => { finishTermination = () => failTermination ? reject(new Error("still alive")) : resolve(); }),
  });
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

test("a per-worktree recovery reservation retries native proof before rejecting a new terminal", async () => {
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
  assert.equal(probes, 1, "the first full-worktree admission did not retry native verification");
  assert.equal(manager.capacity().unknown, 1);
  const created = await manager.create({ cwd });
  assert.equal(probes, 2, "the next admission did not retry a transient helper failure");
  assert.equal(created.status, "running");
  assert.equal(manager.capacity().unknown, 0);
  await manager.shutdown();
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
    assert.equal(database.capacity().retainedBytes - retainedBeforeTrim,
      auditRetainedBytes(filename) - auditBeforeTrim, "audit trimming updates retained bytes exactly");
    const proof = new Database(filename, { readonly: true });
    try {
      assert.equal(proof.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'terminal.created'").get().count, 0);
      assert.ok(proof.prepare("SELECT COUNT(*) AS count FROM audit_log").get().count <= 10_001);
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
    assert.equal(database.reconcileTerminalAudit(), 1);
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
    assert.equal(database.reconcileTerminalAudit(), 2);
    const actions = database.listAudit(20).map((entry) => entry.action);
    assert.ok(actions.includes("terminal.create.unknown"));
    assert.ok(actions.includes("terminal.close.unknown"));

    for (let index = 0; index < 3; index += 1) {
      database.auditCritical("terminal.created", { target: `restart-${index}` });
      database.close();
      database = createOutrightDatabase({ filename, runtimeLease: true });
      assert.equal(database.reconcileTerminalAudit(), 1);
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
    const recoveredRequest = database.terminalUnknownReservations().find((entry) => entry.target === "unborn");
    assert.equal(recoveredRequest?.cwd, interruptedCwd, "audit trimming lost the crashed terminal's worktree");
    assert.equal(recoveredRequest?.ownershipLabel, "com.21n.outright.terminal.unborn");
    assert.equal(recoveredRequest?.handshakePath, "/tmp/terminal-unborn.json");
    assert.equal(recoveredRequest?.pid, 5432);
    assert.equal(recoveredRequest?.processIdentity, "owned-start");
    const proof = new Database(filename, { readonly: true });
    try {
      assert.equal(proof.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'terminal.created'").get().count, 4);
      assert.ok(proof.prepare("SELECT COUNT(*) AS count FROM audit_log").get().count <= 10_010);
    } finally { proof.close(); }
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
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
