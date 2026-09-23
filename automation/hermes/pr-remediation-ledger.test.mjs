import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createLedger,
  evaluateLedger,
  ledgerPath,
  parseLedger,
  recordAssessment,
  recordFailure,
  renderLedger,
  runCli
} from "./pr-remediation-ledger.mjs";

const skill = { identity: "21n/pr-refetch-fix@1.3.0", digest: "sha256:test" };

test("round-trips the machine-readable state through the persistent Markdown ledger", () => {
  const state = createLedger({ prNumber: 2, prUrl: "https://github.com/21nCo/outright/pull/2", head: "abc", skill });
  assert.deepEqual(parseLedger(renderLedger(state)), state);
});

test("requires architecture reset after the same family fails two rounds", () => {
  const state = createLedger({ prNumber: 2, prUrl: "url", head: "abc", skill });
  recordFailure(state, { familyId: "tree-reaping", title: "Reap the complete tree", round: 2, head: "a", evidence: "zombie" });
  assert.equal(evaluateLedger(state).mode, "routine");
  recordFailure(state, { familyId: "tree-reaping", title: "Reap the complete tree", round: 3, head: "b", evidence: "same zombie" });
  assert.deepEqual(evaluateLedger(state), {
    ok: false,
    mode: "architecture_reset_required",
    resetRequired: ["tree-reaping"],
    assessed: []
  });
});

test("a complete architecture assessment opens the reset implementation gate", () => {
  const state = createLedger({ prNumber: 2, prUrl: "url", head: "abc", skill });
  recordFailure(state, { familyId: "tree-reaping", title: "Reap", round: 2, head: "a", evidence: "one" });
  recordFailure(state, { familyId: "tree-reaping", title: "Reap", round: 3, head: "b", evidence: "two" });
  recordAssessment(state, {
    familyId: "tree-reaping",
    invariant: "No provider process-group members remain after stop",
    failingEvidence: "Old head leaves a zombie under non-reaping PID 1",
    coordinatedPlan: "Use an outside-group child subreaper guardian",
    verificationCriteria: "Old head fails and new head leaves zero /proc members"
  });
  assert.deepEqual(evaluateLedger(state), {
    ok: true,
    mode: "architecture_reset",
    resetRequired: [],
    assessed: ["tree-reaping"]
  });
});

test("a recurrence reopens a resolved family and invalidates its prior assessment", () => {
  const state = createLedger({ prNumber: 2, prUrl: "url", head: "abc", skill });
  recordFailure(state, { familyId: "focus", title: "Focus", round: 1, head: "a", evidence: "lost focus" });
  state.families.focus.state = "resolved";
  state.families.focus.resolution = { head: "b", evidence: "old repair" };
  state.families.focus.assessment = { invariant: "old contract" };
  recordFailure(state, { familyId: "focus", title: "Focus", round: 2, head: "b", evidence: "lost again" });
  assert.equal(state.families.focus.state, "architecture_reset_required");
  assert.equal(state.families.focus.resolution, undefined);
  assert.equal(state.families.focus.assessment, undefined);
  assert.deepEqual(evaluateLedger(state).resetRequired, ["focus"]);
});

test("same-round failure reopens a one-round resolved family without stale proof", () => {
  const state = createLedger({ prNumber: 2, prUrl: "url", head: "abc", skill });
  const failure = { familyId: "focus", title: "Focus", round: 1, head: "a", evidence: "lost focus" };
  recordFailure(state, failure);
  state.families.focus.state = "resolved";
  state.families.focus.resolution = { head: "b", evidence: "old repair" };
  state.families.focus.assessment = { invariant: "old contract" };
  recordFailure(state, { ...failure, head: "b", evidence: "lost again" });
  assert.equal(state.families.focus.state, "open");
  assert.equal(state.families.focus.resolution, undefined);
  assert.equal(state.families.focus.assessment, undefined);
  assert.deepEqual(state.families.focus.failedRounds, [1]);
});

test("CLI initialization creates the required reusable ledger artifact", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-ledger-"));
  try {
    const result = runCli([
      "init", "--pr", "2", "--url", "https://github.com/21nCo/outright/pull/2",
      "--head", "abc", "--skill", skill.identity, "--digest", skill.digest
    ], root);
    assert.equal(result.created, true);
    assert.deepEqual(parseLedger(readFileSync(ledgerPath(root, 2), "utf8")), result.state);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
