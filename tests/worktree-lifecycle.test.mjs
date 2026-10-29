import assert from "node:assert/strict";
import test from "node:test";
import { LIFECYCLE_OUTPUT_CHARACTERS, lifecycleFor, lifecycleOutputUpdate, lifecycleSummary, removalRequest, teardownProblem, upsertLifecycleState } from "../src/lib/worktree-lifecycle.js";
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

test("state events replace or remove a worktree's state by path, and lookup never crosses worktrees sharing an id", () => {
  // Scanner ids are path slugs: foo-bar and foo_bar can share one.
  const first = { worktreePath: "/real/foo-bar", discoveredPath: "/w/foo-bar", projectId: "p", worktreeId: "foo-bar", status: "running" };
  const other = { worktreePath: "/w/foo_bar", projectId: "p", worktreeId: "foo-bar", status: "failed" };
  const states = upsertLifecycleState(upsertLifecycleState([], first), other);
  const updated = upsertLifecycleState(states, { ...first, status: "ready" });
  assert.equal(lifecycleFor(updated, { id: "p" }, { id: "foo-bar", path: "/w/foo-bar" }).status, "ready");
  assert.equal(lifecycleFor(updated, { id: "p" }, { id: "foo-bar", path: "/w/foo_bar" }).status, "failed");
  assert.equal(lifecycleFor(updated, { id: "q" }, { id: "foo-bar", path: "/w/foo_bar" }), null);
  assert.equal(updated.length, 2);
  assert.equal(lifecycleFor(upsertLifecycleState(updated, { worktreePath: "/real/foo-bar", removed: true }), { id: "p" }, { path: "/w/foo-bar" }), null);
});

test("a teardown acknowledgement or skip is explicit, and applies only to the worktree whose problem was shown", () => {
  const base = { projectId: "p", worktreePath: "/w/a", confirmation: "/w/a" };
  const failure = (code, extra = {}) => Object.assign(new Error("Teardown did not finish"), { payload: { code, ...extra } });
  assert.equal(teardownProblem(failure("SOMETHING_ELSE"), "/w/a"), null);

  const failed = teardownProblem(failure("WORKTREE_TEARDOWN_FAILED"), "/w/a");
  assert.deepEqual([failed.choices, failed.choice], [["retry", "skip"], "retry"]);
  assert.deepEqual(removalRequest(base, failed), base, "a plain retry resumes teardown");
  assert.deepEqual(removalRequest(base, { ...failed, choice: "skip" }), { ...base, skipTeardown: true });
  assert.deepEqual(removalRequest(base, { ...failed, choice: "acknowledge" }), base, "acknowledgement is not offered here");

  // Unconfirmed processes: nothing is chosen until the user acknowledges or skips.
  for (const unknown of [failure("LIFECYCLE_OUTCOME_UNKNOWN"), failure("WORKTREE_TEARDOWN_FAILED", { lifecycle: { outcomeUnknown: true } })]) {
    const problem = teardownProblem(unknown, "/w/a");
    assert.deepEqual([problem.choices, problem.choice], [["acknowledge", "skip"], ""]);
    assert.deepEqual(removalRequest(base, problem), base);
    assert.deepEqual(removalRequest(base, { ...problem, choice: "acknowledge" }), { ...base, acknowledgeUnconfirmed: true });
  }
  const acknowledged = { ...teardownProblem(failure("LIFECYCLE_OUTCOME_UNKNOWN"), "/w/a"), choice: "acknowledge" };
  assert.deepEqual(removalRequest({ ...base, worktreePath: "/w/b", confirmation: "/w/b" }, acknowledged),
    { projectId: "p", worktreePath: "/w/b", confirmation: "/w/b" }, "a choice never carries over to another worktree");
  assert.deepEqual(teardownProblem(failure("WORKTREE_AGENT_ACTIVE"), "/w/a").choices, []);
});
