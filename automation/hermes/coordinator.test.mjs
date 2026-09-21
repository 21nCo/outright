import assert from "node:assert/strict";
import test from "node:test";

import { hasActiveCard, selectNextIssue } from "./outright-linear-coordinator.mjs";

test("falls back to Linear priority when no explicit sequence is provided", () => {
  const selected = selectNextIssue([
    { identifier: "OUT-2", priority: 0, state: "Backlog" },
    { identifier: "OUT-9", priority: 1, state: { name: "Backlog" } },
    { identifier: "OUT-1", priority: 0, state: "Backlog" },
    { identifier: "OUT-3", priority: 1, state: "Done" }
  ]);

  assert.equal(selected.identifier, "OUT-9");
});

test("uses the configured implementation sequence before Linear priority", () => {
  const selected = selectNextIssue(
    [
      { identifier: "OUT-3", priority: 1, state: "Backlog" },
      { identifier: "OUT-31", priority: 0, state: "Backlog" },
      { identifier: "OUT-29", priority: 0, state: "Done" }
    ],
    "Backlog",
    ["OUT-29", "OUT-31", "OUT-3"]
  );

  assert.equal(selected.identifier, "OUT-31");
});

test("does not import another issue while any nonterminal card remains", () => {
  assert.equal(hasActiveCard([{ status: "done" }, { status: "archived" }]), false);
  assert.equal(hasActiveCard([{ status: "done" }, { status: "review" }]), true);
  assert.equal(hasActiveCard([{ status: "blocked" }]), true);
});
