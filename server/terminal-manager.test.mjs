import assert from "node:assert/strict";
import test from "node:test";
import { createTerminalManager } from "./terminal-manager.mjs";
import { createOutrightDatabase } from "./database.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

test("creates a PTY, accepts input, and retains reconnectable output", async () => {
  const events = [];
  const manager = createTerminalManager({ publish: (event) => events.push(event), database: { audit() {}, auditAdmission() {}, auditCritical() {}, auditRequired: async () => {} } });
  const terminal = manager.create({ cwd: process.cwd(), name: "Test terminal" });
  try {
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
    manager.shutdown();
  }
});

test("enforces terminal limits, input bounds, and suppresses close-after-exit events", () => {
  const events = [];
  const processes = [];
  const manager = createTerminalManager({
    publish: (event) => events.push(event),
    database: { audit() {}, auditAdmission() {}, auditCritical() {}, auditRequired: async () => {} },
    maxTerminals: 2,
    maxTerminalsPerCwd: 1,
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
  assert.equal(manager.close(first.id), true);
  assert.equal(events.some((event) => event.type === "terminal.exit" && event.terminalId === first.id), false);
  manager.shutdown();
});

test("terminal buffer snapshot carries the output cursor for lossless activation", () => {
  const events = [];
  let onData;
  const manager = createTerminalManager({
    publish: (event) => events.push(event), database: { audit() {}, auditAdmission() {}, auditCritical() {}, auditRequired: async () => {} },
    spawnTerminal: () => ({ pid: 1, onData(callback) { onData = callback; }, onExit() {}, kill() {} }),
  });
  const { id } = manager.create({ cwd: process.cwd() });
  onData("before\n");
  const snapshot = manager.get(id);
  onData("after\n");
  assert.equal(snapshot.buffer, "before\n");
  assert.equal(snapshot.outputCursor, 1);
  assert.deepEqual(events.map(({ payload }) => payload.cursor), [1, 2]);
  assert.equal(manager.get(id).outputCursor, 2);
  manager.shutdown();
});

test("a full audit budget refuses PTY creation and a natural exit is retained across restart", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-terminal-audit-"));
  const filename = path.join(directory, "runtime.db");
  let database = createOutrightDatabase({ filename });
  let spawns = 0;
  let onExit;
  const manager = createTerminalManager({ database, publish: () => {}, spawnTerminal: () => {
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
    assert.equal(manager.close(terminal.id), true);
    database.close();
    database = createOutrightDatabase({ filename });
    const actions = database.listAudit(10).filter((entry) => entry.target === terminal.id).map((entry) => entry.action);
    assert.ok(actions.includes("terminal.create.requested"));
    assert.ok(actions.includes("terminal.created"));
    assert.ok(actions.includes("terminal.exited"));
    assert.ok(actions.includes("terminal.close.requested"));
    assert.ok(actions.includes("terminal.closed"));
  } finally { manager.shutdown(); database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("a close that cannot record its outcome reports the pending operation", () => {
  const actions = [];
  let killed = false;
  const manager = createTerminalManager({ publish: () => {}, database: {
    auditAdmission: (action, details) => actions.push({ action, details }),
    auditCritical: (action, details) => {
      if (action === "terminal.closed") throw Object.assign(new Error("storage interrupted"), { code: "SQLITE_BUSY" });
      actions.push({ action, details });
    },
    auditRequired: async () => {},
  }, spawnTerminal: () => ({ pid: 42, onData() {}, onExit() {}, kill() { killed = true; } }) });
  const terminal = manager.create({ cwd: "/tmp/w" });
  assert.throws(() => manager.close(terminal.id), (error) =>
    error.statusCode === 503 && error.details?.outcomeUnknown === true && Boolean(error.details.operationId));
  assert.equal(killed, true);
  assert.equal(manager.get(terminal.id), null);
  assert.ok(actions.some((entry) => entry.action === "terminal.close.requested"));
});

test("normal shutdown settles every PTY at a lowered quota and old outcomes trim after restart", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-terminal-shutdown-"));
  const filename = path.join(directory, "runtime.db");
  let database = createOutrightDatabase({ filename, runtimeLease: true });
  const killed = [];
  const manager = createTerminalManager({ database, publish: () => {}, spawnTerminal: () => ({
    pid: killed.length + 1, onData() {}, onExit() {}, kill() { killed.push(true); },
  }) });
  try {
    const first = manager.create({ cwd: "/tmp/one" });
    const second = manager.create({ cwd: "/tmp/two" });
    const conversation = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "quota", provider: "codex" });
    database.addMessage({ conversationId: conversation.id, role: "assistant", body: "x".repeat(65 * 1024 * 1024) });
    database.updateSettings({ maxRetainedMiB: 64 });
    manager.shutdown();
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

test("restart settles crash and maintenance-interrupted PTY evidence before retention trims it", () => {
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
  }, publish: () => {}, spawnTerminal: () => ({ pid: 42, onData() {}, onExit() {}, kill() { killed.push(true); } }) });
  try {
    const interrupted = manager.create({ cwd: "/tmp/interrupted" });
    unavailable = true;
    assert.throws(() => manager.shutdown(), (error) => error instanceof AggregateError);
    assert.equal(killed.length, 1);
    database.close();
    database = createOutrightDatabase({ filename, runtimeLease: true });
    assert.equal(database.reconcileTerminalAudit(), 1);
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
      assert.equal(proof.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'terminal.created'").get().count, 0);
      assert.equal(proof.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action LIKE 'terminal.%.requested'").get().count, 0);
      assert.ok(proof.prepare("SELECT COUNT(*) AS count FROM audit_log").get().count <= 10_001);
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
