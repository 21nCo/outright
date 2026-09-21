import assert from "node:assert/strict";
import test from "node:test";

import { hasActiveCard, selectNextIssue } from "./outright-linear-coordinator.mjs";

test("selects urgent work before unprioritized work and preserves issue order", () => {
  const selected = selectNextIssue([
    { identifier: "OUT-2", priority: 0, state: "Backlog" },
    { identifier: "OUT-9", priority: 1, state: { name: "Backlog" } },
    { identifier: "OUT-1", priority: 0, state: "Backlog" },
    { identifier: "OUT-3", priority: 1, state: "Done" }
  ]);

  assert.equal(selected.identifier, "OUT-9");
});

test("does not import another issue while any nonterminal card remains", () => {
  assert.equal(hasActiveCard([{ status: "done" }, { status: "archived" }]), false);
  assert.equal(hasActiveCard([{ status: "done" }, { status: "review" }]), true);
  assert.equal(hasActiveCard([{ status: "blocked" }]), true);
});
