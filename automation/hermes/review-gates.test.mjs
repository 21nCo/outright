import assert from "node:assert/strict";
import test from "node:test";

import { validateReview } from "./local-parallel-review.mjs";
import { checkStatusRollup, evaluateProgress, progressRootCauses, validateEvaluation, validateSonarSnapshot } from "./pr-convergence-evaluator.mjs";
import { selectPinnedSkill } from "./skill-pin.mjs";

const evaluation = (head, ids, failedChecks = []) => ({
  schemaVersion: 1,
  head,
  completeSnapshot: true,
  families: ids.map((familyId) => ({ familyId, severity: "blocking", sourceIds: ["thread-1"], evidence: "reproduction" })),
  failedChecks,
  verificationGaps: [],
  architectureResetFamilies: []
});

test("both local reviewers must return a complete report for the exact head", () => {
  const report = { schemaVersion: 1, reviewer: "glm-5.3", head: "abc", findings: [] };
  assert.equal(validateReview(report, "glm-5.3", "abc"), report);
  assert.throws(() => validateReview(report, "gpt-6-sol", "abc"), /wrong-head review/);
  assert.throws(() => validateReview({ ...report, findings: [{ familyId: "focus" }] }, "glm-5.3", "abc"), /lacks severity/);
});

test("PR checks distinguish pending from failed", () => {
  assert.deepEqual(checkStatusRollup([
    { __typename: "CheckRun", name: "linux", status: "COMPLETED", conclusion: "FAILURE" },
    { __typename: "CheckRun", name: "mac", status: "IN_PROGRESS" },
    { __typename: "StatusContext", context: "review", state: "SUCCESS" }
  ]), { pending: ["mac"], failed: ["linux"] });
});

test("SonarQube issues must match the exact PR head and analysis count", () => {
  const analyses = { pullRequests: [{ key: "3", commit: { sha: "head" }, analysisDate: "2026-09-23T17:00:56Z", status: { qualityGateStatus: "OK", bugs: 0, vulnerabilities: 0, codeSmells: 1 } }] };
  const issues = { total: 1, paging: { total: 1 }, issues: [{ key: "issue-1", rule: "javascript:S6819", component: "21nCo_outright:src/App.jsx", line: 12, message: "Use a semantic element", status: "OPEN", pullRequest: "3" }] };
  assert.deepEqual(validateSonarSnapshot(analyses, issues, 3, "head").issues[0], {
    sourceId: "sonar/issue-1", rule: "javascript:S6819", severity: undefined, path: "src/App.jsx", line: 12,
    message: "Use a semantic element", status: "OPEN", type: undefined
  });
  assert.throws(() => validateSonarSnapshot(analyses, issues, 3, "other"), /does not match exact head/);
  assert.throws(() => validateSonarSnapshot(analyses, { ...issues, total: 2 }, 3, "head"), /inventory is incomplete/);
  assert.throws(() => validateSonarSnapshot({ pullRequests: [{ ...analyses.pullRequests[0], status: { codeSmells: 2 } }] }, issues, 3, "head"), /do not match its analysis count/);
});

test("evaluator refuses wrong-head and incomplete model output", () => {
  assert.throws(() => validateEvaluation(evaluation("old", []), "new", []), /wrong-head/);
  assert.throws(() => validateEvaluation({ ...evaluation("new", []), completeSnapshot: false }, "new", []), /incomplete/);
});

test("two successive pushed heads without fewer root causes stop routine PR fixes", () => {
  const ledger = { rounds: [{ round: 1 }, { round: 2 }], families: {} };
  const prior = [evaluation("a", ["focus", "dialog"]), evaluation("b", ["focus", "dialog"])];
  const gate = evaluateProgress(prior, evaluation("c", ["focus", "dialog", "keyboard"]), ledger, 10);
  assert.equal(gate.mode, "stalled");
  assert.equal(gate.ok, false);
  assert.equal(evaluateProgress(prior, evaluation("c", ["focus"]), ledger, 10).mode, "continue");
});

test("flat counts may continue when a stable root cause was resolved and one new finding surfaced", () => {
  const prior = [evaluation("a", ["old-a", "old-b"]), evaluation("b", ["fixed-by-next", "still-open"])];
  const ledger = { rounds: [{ round: 1 }, { round: 2 }], families: {} };
  const gate = evaluateProgress(prior, evaluation("c", ["still-open", "newly-found"]), ledger, 20);
  assert.equal(gate.mode, "continue");
  assert.match(gate.reason, /Resolved 1 prior/);
  assert.equal(evaluateProgress(prior, evaluation("c", ["fixed-by-next", "still-open"]), ledger, 20).mode, "stalled");
  assert.equal(evaluateProgress(prior, evaluation("c", ["still-open", "newly-found", "third"]), ledger, 20).mode, "stalled");
});

test("progress excludes external acceptance and minor findings, and counts a represented failed CI check once", () => {
  const current = evaluation("c", ["ui-behavior-ci", "manual-assistive-tech-validation", "sonar-style"], ["ubuntu"]);
  current.families[0].sourceIds.push("ci/ubuntu");
  current.families[2].severity = "minor";
  assert.deepEqual([...progressRootCauses(current, ["manual-assistive-tech-validation"])], ["ui-behavior-ci"]);
  current.families[0].sourceIds = ["thread-1"];
  current.families[2].sourceIds = ["ci/ubuntu"];
  assert.deepEqual([...progressRootCauses(current, ["manual-assistive-tech-validation"])], ["ui-behavior-ci", "ci/ubuntu"]);
  assert.equal(evaluateProgress([], current, { rounds: [], families: {} }, 15, ["manual-assistive-tech-validation"]).mode, "continue");
  assert.notEqual(evaluateProgress([], current, { rounds: [], families: {} }, 15, ["manual-assistive-tech-validation"]).mode, "clean_candidate");
});

test("one authorized exact-head recovery opens only its next stalled round", () => {
  const prior = [evaluation("a", ["ui"]), evaluation("b", ["ui"])];
  const current = evaluation("c", ["ui"]);
  const decision = { head: "c", round: 3, authorizedBy: "user", reason: "stalled", scope: "bounded UI repair", verificationCriteria: "three OS CI" };
  const ledger = { rounds: [{ round: 1 }, { round: 2 }], families: {}, recoveryAuthorizations: [decision] };
  assert.equal(evaluateProgress(prior, current, ledger, 15).mode, "controlled_recovery");
  assert.equal(evaluateProgress(prior, { ...current, head: "other" }, ledger, 15).mode, "stalled");
  assert.equal(evaluateProgress(prior, current, { ...ledger, rounds: [...ledger.rounds, { round: 3 }] }, 15).mode, "stalled");
  assert.equal(evaluateProgress(prior, current, { ...ledger, recoveryAuthorizations: [{ ...decision, completedAt: "now" }] }, 15).mode, "stalled");
  assert.equal(evaluateProgress(prior, current, { ...ledger, rounds: Array(15).fill({ round: 1 }) }, 15).mode, "round_limit");
  assert.equal(evaluateProgress(prior, { ...current, verificationGaps: ["missing"] }, ledger, 15).mode, "incomplete");
});

test("a fresh architecture assessment permits one stalled repair round without an operator exception", () => {
  const prior = [evaluation("a", ["ui"]), evaluation("b", ["ui"])];
  const current = { ...evaluation("c", ["ui"]), architectureResetFamilies: ["ui"] };
  const assessment = { head: "c", round: 3, invariant: "owned UI phase", failingEvidence: "old head failed", coordinatedPlan: "repair owner", verificationCriteria: "three OS CI" };
  const ledger = { rounds: [{ round: 1 }, { round: 2 }], families: { ui: { state: "architecture_assessed", assessment } } };
  assert.equal(evaluateProgress(prior, current, ledger, 15).mode, "assessed_reset");
  assert.equal(evaluateProgress(prior, current, { ...ledger, families: { ui: { state: "architecture_assessed", assessment: { ...assessment, head: "old" } } } }, 15).mode, "stalled");
  assert.equal(evaluateProgress(prior, current, { ...ledger, rounds: [...ledger.rounds, { round: 3 }] }, 15).mode, "stalled");
  assert.equal(evaluateProgress(prior, current, { ...ledger, rounds: Array(15).fill({ round: 1 }) }, 15).mode, "round_limit");
  assert.equal(evaluateProgress(prior, { ...current, verificationGaps: ["missing review"] }, ledger, 15).mode, "incomplete");
});

test("clean, incomplete, architecture reset, and limit states fail closed", () => {
  const ledger = { rounds: [], families: {} };
  assert.equal(evaluateProgress([], evaluation("a", []), ledger, 10).mode, "clean_candidate");
  assert.equal(evaluateProgress([], { ...evaluation("a", ["focus"]), verificationGaps: ["threads not fetched"] }, ledger, 10).mode, "incomplete");
  assert.equal(evaluateProgress([], { ...evaluation("a", ["focus"]), architectureResetFamilies: ["focus"] }, ledger, 10).mode, "architecture_reset_required");
  assert.equal(evaluateProgress([], { ...evaluation("a", ["focus"]), architectureResetFamilies: ["focus"] }, {
    ...ledger, families: { focus: { state: "architecture_assessed" } }
  }, 10).mode, "continue");
  assert.equal(evaluateProgress([], evaluation("a", ["focus"]), { ...ledger, rounds: Array(10).fill({}) }, 10).mode, "round_limit");
});

test("an existing PR retains its ledger and worktree Skillplane pin", () => {
  const oldPin = { workspaceSlug: "21n", skillSlug: "pr-refetch-fix", semanticVersion: "1.2.0", digest: "sha256:old" };
  const newPin = { ...oldPin, semanticVersion: "1.3.0", digest: "sha256:new" };
  assert.equal(selectPinnedSkill({ identity: "21n/pr-refetch-fix@1.2.0", digest: "sha256:old" }, oldPin, newPin), oldPin);
  assert.equal(selectPinnedSkill({ identity: "21n/pr-refetch-fix@1.3.0", digest: "sha256:new" }, oldPin, newPin), newPin);
  assert.equal(selectPinnedSkill({ identity: "21n/pr-refetch-fix@1.2.0", digest: "sha256:other" }, oldPin, newPin), undefined);
});
