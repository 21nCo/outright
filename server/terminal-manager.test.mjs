import assert from "node:assert/strict";
import test from "node:test";
import { createTerminalManager } from "./terminal-manager.mjs";
import { createSubprocessBudget } from "./subprocess-budget.mjs";
import { createOutrightDatabase } from "./database.mjs";
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
    const shell = process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "/bin/zsh");
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

test("a close that cannot record its outcome reports the pending operation", async () => {
  const actions = [];
  let killed = false;
  const manager = createTerminalManager({ publish: () => {}, database: {
    auditAdmission: (action, details) => actions.push({ action, details }),
    auditCritical: (action, details) => {
      actions.push({ action, details });
    },
    auditRequired: async (action) => { if (action === "terminal.closed") throw Object.assign(new Error("storage interrupted"), { code: "SQLITE_BUSY" }); },
  }, spawnTerminal: () => ({ pid: 42, onData() {}, onExit() {}, kill() { killed = true; } }), terminate: async (terminal) => { terminal.process.kill(); } });
  const terminal = manager.create({ cwd: "/tmp/w" });
  await assert.rejects(manager.close(terminal.id), (error) =>
    error.statusCode === 503 && error.details?.outcomeUnknown === true && Boolean(error.details.operationId));
  assert.equal(killed, true);
  assert.equal(manager.get(terminal.id)?.status, "unknown");
  assert.ok(actions.some((entry) => entry.action === "terminal.close.requested"));
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
  try {
    const terminal = await manager.create({ cwd: directory });
    manager.write(terminal.id, `nohup sleep 30 >/dev/null 2>&1 & echo $! > ${pidFile}; exit\r`);
    await waitFor(() => existsSync(pidFile), 5000);
    backgroundPid = Number(readFileSync(pidFile, "utf8").trim());
    assert.ok(Number.isSafeInteger(backgroundPid) && backgroundPid > 0);
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(manager.capacity().active, 1, "a reparented child still owns terminal capacity");
    assert.equal(database.listAudit(20).some((entry) => entry.action === "terminal.exited" && entry.target === terminal.id), false);
    await manager.close(terminal.id);
    await waitFor(() => {
      const state = spawnSync("ps", ["-o", "stat=", "-p", String(backgroundPid)], { encoding: "utf8" }).stdout.trim();
      return !state || state.startsWith("Z");
    }, 5000);
    assert.equal(manager.capacity().active, 0);
  } finally {
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
  } finally { delete process.env.OUT30_TERMINAL_EXTRA; }
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
  const source = `import {createOutrightDatabase} from ${JSON.stringify(new URL("./database.mjs", import.meta.url).href)};
    import {createTerminalManager} from ${JSON.stringify(new URL("./terminal-manager.mjs", import.meta.url).href)};
    import {existsSync} from 'node:fs';
    const db=createOutrightDatabase({filename:${JSON.stringify(filename)},runtimeLease:true});
    const manager=createTerminalManager({database:db,publish:()=>{}});
    const terminal=await manager.create({cwd:${JSON.stringify(directory)}});
    manager.write(terminal.id,${JSON.stringify(`nohup sleep 30 >/dev/null 2>&1 & echo $! > ${pidFile}; exit\r`)});
    for(let i=0;i<100&&!existsSync(${JSON.stringify(pidFile)});i++)await new Promise(r=>setTimeout(r,50));
    process.exit(existsSync(${JSON.stringify(pidFile)})?0:2);`;
  let backgroundPid;
  let database;
  try {
    const crashed = spawnSync(process.execPath, ["--input-type=module", "-e", source], { timeout: 15_000, encoding: "utf8" });
    assert.equal(crashed.status, 0, crashed.stderr);
    backgroundPid = Number(readFileSync(pidFile, "utf8").trim());
    database = createOutrightDatabase({ filename, runtimeLease: true });
    assert.equal(database.reconcileTerminalAudit(), 1);
    const manager = createTerminalManager({ database, publish: () => {}, maxTerminals: 1 });
    assert.equal(manager.capacity().unknown, 1);
    assert.equal(await manager.reconcileUnknown(), 1);
    assert.equal(manager.capacity().active, 0);
    await waitFor(() => {
      const state = spawnSync("ps", ["-o", "stat=", "-p", String(backgroundPid)], { encoding: "utf8" }).stdout.trim();
      return !state || state.startsWith("Z");
    }, 5000);
    assert.equal(database.listAudit(20).some((entry) => entry.action === "terminal.recovered"), true);
  } finally {
    if (backgroundPid) try { process.kill(backgroundPid, "SIGKILL"); } catch {}
    database?.close();
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
    assert.equal(await manager.reconcileUnknown(), 1);
    assert.equal(manager.capacity().active, 1);
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
    database.auditCritical("terminal.create.requested", { target: "unborn", operationId: "create-crash" });
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
    if (predicate()) return;
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
