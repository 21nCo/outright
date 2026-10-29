import assert from "node:assert/strict";
import test from "node:test";
import { LIFECYCLE_OUTPUT_CHARACTERS, lifecycleFor, lifecycleOutputUpdate, lifecycleSummary, mergeLifecycleSnapshot, removalRequest, teardownProblem, upsertLifecycleState } from "../src/lib/worktree-lifecycle.js";
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
  // Unconfirmed processes hold agent work, and the summary says so.
  const unconfirmed = lifecycleSummary({ phase: "setup", status: "interrupted", steps, stepIndex: 1, outcomeUnknown: true });
  assert.equal(unconfirmed.tone, "attention");
  assert.match(unconfirmed.label, /^Setup interrupted at step 2 of 3, Migrate; its processes are not confirmed stopped, so agent runs here wait$/);
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

test("an older event or snapshot never replaces a newer state or removal", () => {
  const project = { id: "p" };
  const worktree = { path: "/w/a" };
  const state = (status, revision) => ({ worktreePath: "/w/a", projectId: "p", phase: "setup", status, steps: ["Install"], stepIndex: 0, revision });
  // Events out of order: the older running state does not replace the failure.
  let states = upsertLifecycleState(upsertLifecycleState([], state("failed", 5)), state("running", 4));
  assert.equal(lifecycleFor(states, project, worktree).status, "failed");
  // A snapshot read before the failure keeps it; one read after replaces it.
  assert.equal(lifecycleFor(mergeLifecycleSnapshot(states, [state("running", 3)], 4), project, worktree).status, "failed");
  assert.equal(lifecycleFor(mergeLifecycleSnapshot(states, [state("ready", 6)], 6), project, worktree).status, "ready");
  // A snapshot read after the failure that no longer lists it was evicted or forgotten.
  assert.equal(lifecycleFor(mergeLifecycleSnapshot(states, [], 5), project, worktree), null);
  // A removal after the snapshot was read hides the snapshot's state, and an
  // older state event cannot bring it back.
  states = upsertLifecycleState(states, { worktreePath: "/w/a", removed: true, revision: 7 });
  assert.equal(lifecycleFor(mergeLifecycleSnapshot(states, [state("running", 3)], 6), project, worktree), null);
  assert.equal(lifecycleFor(upsertLifecycleState(states, state("running", 6)), project, worktree), null);
  assert.equal(lifecycleFor(upsertLifecycleState(states, state("running", 8)), project, worktree).status, "running");
  // A trusted refusal no longer asks for review.
  assert.equal(lifecycleSummary(state("trusted", 9)).quiet, true);
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

  // Unconfirmed processes: nothing is chosen until the user acknowledges or
  // skips, and either names the attempt that was shown.
  for (const unknown of [failure("LIFECYCLE_OUTCOME_UNKNOWN", { runId: "run-1" }), failure("LIFECYCLE_ACKNOWLEDGEMENT_STALE", { runId: "run-1" }),
    failure("WORKTREE_TEARDOWN_FAILED", { lifecycle: { outcomeUnknown: true, runId: "run-1" } }),
    failure("LIFECYCLE_TRUST_REQUIRED", { lifecycle: { outcomeUnknown: true, runId: "run-1" } })]) {
    const problem = teardownProblem(unknown, "/w/a");
    assert.deepEqual([problem.choices, problem.choice], [["acknowledge", "skip"], ""]);
    assert.deepEqual(removalRequest(base, problem), base);
    assert.deepEqual(removalRequest(base, { ...problem, choice: "acknowledge" }), { ...base, acknowledgeUnconfirmed: "run-1" });
    // Skipping teardown beside unconfirmed processes acknowledges them too.
    assert.deepEqual(removalRequest(base, { ...problem, choice: "skip" }), { ...base, skipTeardown: true, acknowledgeUnconfirmed: "run-1" });
  }
  // Without teardown steps, acknowledging only removes; a later attempt is a
  // new problem with nothing chosen.
  const removalOnly = teardownProblem(failure("LIFECYCLE_OUTCOME_UNKNOWN", { runId: "run-1", teardown: false }), "/w/a");
  assert.deepEqual([removalOnly.choices, removalOnly.choice, removalOnly.teardown], [["acknowledge"], "", false]);
  const later = teardownProblem(failure("LIFECYCLE_ACKNOWLEDGEMENT_STALE", { runId: "run-2", teardown: false }), "/w/a");
  assert.deepEqual([later.choice, removalRequest(base, { ...later, choice: "acknowledge" }).acknowledgeUnconfirmed], ["", "run-2"]);
  // An unconfirmed problem that names no attempt cannot be acknowledged.
  assert.deepEqual(teardownProblem(failure("LIFECYCLE_OUTCOME_UNKNOWN"), "/w/a").choices, []);
  const acknowledged = { ...teardownProblem(failure("LIFECYCLE_OUTCOME_UNKNOWN", { runId: "run-1" }), "/w/a"), choice: "acknowledge" };
  assert.deepEqual(removalRequest({ ...base, worktreePath: "/w/b", confirmation: "/w/b" }, acknowledged),
    { projectId: "p", worktreePath: "/w/b", confirmation: "/w/b" }, "a choice never carries over to another worktree");
  assert.deepEqual(teardownProblem(failure("WORKTREE_AGENT_ACTIVE"), "/w/a").choices, []);
});
