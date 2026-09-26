import assert from "node:assert/strict";
import test from "node:test";
import { pruneExitedIds } from "../src/lib/terminal-exit-state.js";

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
