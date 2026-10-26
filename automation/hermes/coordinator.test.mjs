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

test("configured intake excludes the umbrella and unplanned issues", () => {
  assert.equal(selectNextIssue([
    { identifier: "OUT-36", state: "Backlog", priority: 1 },
    { identifier: "OUT-45", state: "Backlog", priority: 1 },
    { identifier: "OUT-37", state: "Done" },
  ], "Backlog", ["OUT-37"]), undefined);
});

test("skips blocked review work while allowing later independent work", () => {
  const issues = [
    { identifier: "DIFF-1", state: { name: "Backlog", type: "backlog" } },
    { identifier: "OUT-35", state: "Backlog" },
    { identifier: "OUT-19", state: "Backlog" },
  ];
  const options = { issueDependencies: { "OUT-35": ["DIFF-1"] } };
  assert.equal(selectNextIssue(issues, "Backlog", ["OUT-35", "OUT-19"], options).identifier, "OUT-19");
  issues[0].state = { name: "Released", type: "completed" };
  assert.equal(selectNextIssue(issues, "Backlog", ["OUT-35", "OUT-19"], options).identifier, "OUT-35");
});

test("missing, canceled and in-review prerequisites cannot release a dependent issue", () => {
  const candidate = { identifier: "OUT-37", state: "Backlog" };
  const options = { issueDependencies: { "OUT-37": ["OUT-29", "OUT-33"] } };
  for (const state of [undefined, "Canceled", "In Review", { name: "Canceled", type: "canceled" }]) {
    const issues = [candidate, { identifier: "OUT-33", state: "Done" }];
    if (state) issues.push({ identifier: "OUT-29", state });
    assert.equal(selectNextIssue(issues, "Backlog", ["OUT-37"], options), undefined);
  }
  assert.equal(selectNextIssue([
    candidate, { identifier: "OUT-29", state: "Done" }, { identifier: "OUT-33", state: "Done" },
  ], "Backlog", ["OUT-37"], options).identifier, "OUT-37");
});

test("supports configured completed state names when the API omits state type", () => {
  const selected = selectNextIssue([
    { identifier: "OUT-37", state: "Backlog" },
    { identifier: "OUT-29", state: { name: "Live" } },
  ], "Backlog", ["OUT-37"], {
    issueDependencies: { "OUT-37": ["OUT-29"] }, completedStates: ["Done", "Live", "Watch"],
  });
  assert.equal(selected.identifier, "OUT-37");
});
