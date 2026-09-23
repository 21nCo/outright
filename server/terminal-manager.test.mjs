import assert from "node:assert/strict";
import test from "node:test";
import { createTerminalManager } from "./terminal-manager.mjs";

test("creates a PTY, accepts input, and retains reconnectable output", async () => {
  const events = [];
  const manager = createTerminalManager({ publish: (event) => events.push(event), database: { audit() {} } });
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
    database: { audit() {} },
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
    publish: (event) => events.push(event), database: { audit() {} },
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

async function waitFor(predicate, timeout = 3000, diagnostic = () => "") {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for PTY output: ${JSON.stringify(diagnostic())}`);
}
