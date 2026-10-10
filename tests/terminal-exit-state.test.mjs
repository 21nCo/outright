import assert from "node:assert/strict";
import test from "node:test";
import { pruneExitedIds } from "../src/lib/terminal-exit-state.js";
import { createTerminalCommandFence } from "../src/lib/terminal-command-fence.js";

test("audit failure fences terminal commands before a later runtime event or React commit", () => {
  const fence = createTerminalCommandFence();
  const input = { type: "terminal.input", terminalId: "one", data: "x" };
  const resize = { type: "terminal.resize", terminalId: "one", cols: 80, rows: 24 };
  assert.equal(fence.allows(input), true);
  assert.equal(fence.observe({ type: "terminal.audit-failed", terminalId: "one" }), true);
  fence.observe({ type: "capacity.changed", payload: {} });
  assert.equal(fence.allows(input), false);
  assert.equal(fence.allows(resize), false);
  assert.deepEqual([...fence.snapshot()], ["one"]);
  assert.equal(fence.allows({ ...input, terminalId: "other" }), true);
  for (let index = 0; index < 300; index += 1) fence.observe({ type: "terminal.audit-failed", terminalId: `old-${index}` });
  assert.equal(fence.snapshot().size, 256, "long sessions must not retain unbounded old terminal IDs");
});

test("exited identities are pruned across repeated closes without dropping a pending exit", () => {
  const exited = new Set(["pending-exit"]);
  for (let index = 0; index < 50; index += 1) exited.add(`closed-${index}`);
  exited.add("still-open");
  pruneExitedIds(exited, [{ id: "active" }, { id: "still-open" }], { id: "pending-exit", exit: { exitCode: 7 } });
  assert.deepEqual([...exited].sort(), ["pending-exit", "still-open"], "Stale exited terminal identities accumulated or a pending exit was lost");

  for (let index = 50; index < 100; index += 1) {
    exited.add(`closed-${index}`);
    pruneExitedIds(exited, [{ id: "active" }, { id: "still-open" }], { id: "pending-exit", exit: { exitCode: 7 } });
    assert.equal(exited.size, 2, `Closed terminal ${index} retained its exit identity`);
  }
  pruneExitedIds(exited, [{ id: "active" }], null);
  assert.equal(exited.size, 0, "Closed or finished pending terminals retained their exit identities");
});
