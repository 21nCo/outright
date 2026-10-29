import assert from "node:assert/strict";
import test from "node:test";
import { LIFECYCLE_OUTPUT_CHARACTERS, lifecycleFor, lifecycleOutputUpdate, lifecycleSummary, upsertLifecycleState } from "../src/lib/worktree-lifecycle.js";
import { LIFECYCLE_LIMITS } from "../server/worktree-lifecycle.mjs";

const steps = ["Install", "Migrate", "Seed"];

test("the client keeps the server's retained output bound", () => {
  assert.equal(LIFECYCLE_OUTPUT_CHARACTERS, LIFECYCLE_LIMITS.outputCharacters);
});

test("summaries say which step a run is on and never call an unfinished worktree ready", () => {
  assert.equal(lifecycleSummary(null), null);
  assert.deepEqual(lifecycleSummary({ phase: "setup", status: "running", steps, stepIndex: 1 }),
    { tone: "running", short: "Setup 2/3", label: "Setting up: step 2 of 3, Migrate" });
  assert.equal(lifecycleSummary({ phase: "setup", status: "failed", steps, stepIndex: 2 }).label, "Setup failed at step 3 of 3, Seed");
  assert.equal(lifecycleSummary({ phase: "teardown", status: "failed", steps: ["Stop"], stepIndex: 1 }).label,
    "Teardown finished, but the worktree was not removed");
  for (const status of ["needs-trust", "invalid", "failed", "cancelled", "interrupted", "running"]) {
    const summary = lifecycleSummary({ phase: "setup", status, steps, stepIndex: 0 });
    assert.notEqual(summary.tone, "ready", status);
    assert.equal(summary.quiet, undefined, `${status} must stay visible`);
  }
  assert.equal(lifecycleSummary({ phase: "setup", status: "ready", steps, stepIndex: 3 }).quiet, true);
});

test("streamed output appends once, in order, and asks for a reload across a gap or a new run", () => {
  const state = { worktreePath: "/w", runId: "run-1", output: "abc", outputEnd: 3 };
  assert.equal(lifecycleOutputUpdate(state, { worktreePath: "/other", runId: "run-1", start: 3, text: "d" }), null);
  assert.equal(lifecycleOutputUpdate(state, { worktreePath: "/w", runId: "run-1", start: 0, text: "abc" }), null, "already loaded");
  assert.deepEqual(lifecycleOutputUpdate(state, { worktreePath: "/w", runId: "run-1", start: 1, text: "bcde" }),
    { ...state, output: "abcde", outputEnd: 5, outputTruncated: false }, "overlap appends only the new part");
  assert.equal(lifecycleOutputUpdate(state, { worktreePath: "/w", runId: "run-1", start: 9, text: "z" }), "reload");
  assert.equal(lifecycleOutputUpdate(state, { worktreePath: "/w", runId: "run-2", start: 0, text: "z" }), "reload");
  const long = lifecycleOutputUpdate(state, { worktreePath: "/w", runId: "run-1", start: 3, text: "x".repeat(LIFECYCLE_OUTPUT_CHARACTERS) });
  assert.equal(long.output.length, LIFECYCLE_OUTPUT_CHARACTERS);
  assert.equal(long.outputTruncated, true);
});

test("state events replace or remove a worktree's state by path and look up by project and worktree", () => {
  const first = { worktreePath: "/a", projectId: "p", worktreeId: "a", status: "running" };
  const other = { worktreePath: "/b", projectId: "p", worktreeId: "b", status: "failed" };
  const states = upsertLifecycleState(upsertLifecycleState([], first), other);
  const updated = upsertLifecycleState(states, { ...first, status: "ready" });
  assert.equal(lifecycleFor(updated, { id: "p" }, { id: "a" }).status, "ready");
  assert.equal(updated.length, 2);
  assert.equal(lifecycleFor(upsertLifecycleState(updated, { worktreePath: "/a", removed: true }), { id: "p" }, { id: "a" }), null);
});
