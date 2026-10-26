#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createSnapshot, git, releaseSnapshot } from "./review-runner.mjs";
import { runCodexJson } from "/Users/serro/Documents/dev/n/agent/automation/linear-loop/review-runner.mjs";
import { ledgerPath, readLedger, writeLedger } from "./pr-remediation-ledger.mjs";

const config = JSON.parse(readFileSync(fileURLToPath(new URL("./workflow.json", import.meta.url)), "utf8"));
const instructionsPath = fileURLToPath(new URL("./convergence-evaluator.md", import.meta.url));
const ghEnv = { ...process.env, GH_CONFIG_DIR: "/Users/serro/.config/gh-other" };

function ghJson(cwd, ...args) {
  return JSON.parse(execFileSync("gh", args, { cwd, env: ghEnv, encoding: "utf8", maxBuffer: 20_000_000 }));
}

export function validateSonarSnapshot(pullRequests, issueData, number, head) {
  const analysis = pullRequests?.pullRequests?.find((item) => item.key === String(number));
  if (!analysis || analysis.commit?.sha !== head || !analysis.analysisDate) {
    throw new Error(`SonarQube PR #${number} analysis does not match exact head ${head}`);
  }
  const issues = issueData?.issues;
  if (!Array.isArray(issues) || issueData.total !== issues.length || issueData.paging?.total !== issues.length) {
    throw new Error(`SonarQube PR #${number} issue inventory is incomplete`);
  }
  const expected = ["bugs", "vulnerabilities", "codeSmells"].reduce((sum, key) => sum + Number(analysis.status?.[key] ?? 0), 0);
  if (expected !== issues.length || issues.some((issue) => !issue.key || !issue.rule || !issue.component || !issue.message || issue.pullRequest !== String(number))) {
    throw new Error(`SonarQube PR #${number} issue details do not match its analysis count`);
  }
  return {
    projectKey: config.sonar.projectKey,
    analysisDate: analysis.analysisDate,
    commitSha: head,
    qualityGateStatus: analysis.status.qualityGateStatus,
    issues: issues.map((issue) => ({
      sourceId: `sonar/${issue.key}`,
      rule: issue.rule,
      severity: issue.severity,
      path: issue.component.slice(issue.component.indexOf(":") + 1),
      line: issue.line ?? null,
      message: issue.message,
      status: issue.status,
      type: issue.type
    }))
  };
}

function sonarSnapshot(cwd, number, head) {
  if (!config.sonar?.projectKey) return undefined;
  const api = (args) => JSON.parse(execFileSync("sonar", args, { cwd, encoding: "utf8", maxBuffer: 20_000_000 }));
  const project = encodeURIComponent(config.sonar.projectKey);
  const analyses = api(["api", "get", `/api/project_pull_requests/list?project=${project}`]);
  const issues = api(["api", "get", `/api/issues/search?componentKeys=${project}&pullRequest=${number}&issueStatuses=OPEN%2CCONFIRMED&ps=500&p=1`]);
  return validateSonarSnapshot(analyses, issues, number, head);
}

function connection(cwd, kind, number) {
  const [owner, repo] = config.repository.split("/");
  const fields = {
    reviewThreads: "nodes { id isResolved isOutdated path line comments(first:100) { nodes { id body author { login } } pageInfo { hasNextPage } } }",
    reviews: "nodes { id body state submittedAt author { login } }",
    comments: "nodes { id body createdAt author { login } }"
  };
  const query = `query($owner:String!,$repo:String!,$number:Int!,$after:String){repository(owner:$owner,name:$repo){pullRequest(number:$number){headRefOid ${kind}(first:100,after:$after){${fields[kind]} pageInfo{hasNextPage endCursor}}}}}`;
  const nodes = [];
  let after;
  for (let page = 0; page < 30; page++) {
    const args = ["api", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `repo=${repo}`, "-F", `number=${number}`];
    if (after) args.push("-f", `after=${after}`);
    const result = ghJson(cwd, ...args);
    if (result.errors?.length) throw new Error(`GitHub ${kind} GraphQL errors: ${JSON.stringify(result.errors).slice(0, 1000)}`);
    const pr = result.data?.repository?.pullRequest;
    if (!pr) throw new Error(`GitHub ${kind} snapshot failed for PR #${number}`);
    const data = pr[kind];
    if (!data?.nodes || !data.pageInfo) throw new Error(`GitHub ${kind} pagination is incomplete`);
    if (kind === "reviewThreads" && data.nodes.some((node) => node.comments?.pageInfo?.hasNextPage)) {
      throw new Error("A review thread has more than 100 comments; snapshot is incomplete");
    }
    nodes.push(...data.nodes);
    if (!data.pageInfo.hasNextPage) return { head: pr.headRefOid, nodes };
    after = data.pageInfo.endCursor;
    if (!after) throw new Error(`GitHub ${kind} pagination has no cursor`);
  }
  throw new Error(`GitHub ${kind} exceeded the bounded 3000-item snapshot`);
}

export function checkStatusRollup(checks = []) {
  const pending = [];
  const failed = [];
  for (const check of checks) {
    const name = check.name ?? check.context ?? "unnamed check";
    if (check.__typename === "CheckRun") {
      if (check.status !== "COMPLETED") pending.push(name);
      else if (!["SUCCESS", "SKIPPED", "NEUTRAL"].includes(check.conclusion)) failed.push(name);
    } else if (check.__typename === "StatusContext") {
      if (check.state === "PENDING") pending.push(name);
      else if (check.state !== "SUCCESS") failed.push(name);
    }
  }
  return { pending, failed };
}

function failedCheckEvidence(cwd, checks) {
  return checks.filter((check) => check.__typename === "CheckRun" && check.status === "COMPLETED" && !["SUCCESS", "SKIPPED", "NEUTRAL"].includes(check.conclusion)).map((check) => {
    const job = String(check.detailsUrl ?? "").match(/\/job\/(\d+)/)?.[1];
    if (!job) return { name: check.name, gap: "No GitHub Actions job URL" };
    try {
      const log = execFileSync("gh", ["run", "view", "--job", job, "--repo", config.repository, "--log-failed"], {
        cwd, env: ghEnv, encoding: "utf8", maxBuffer: 40_000_000
      });
      const lines = log.split("\n");
      const selected = new Set();
      for (let i = 0; i < lines.length; i++) {
        if (/not ok |FAIL:|##\[error\]|ERR_TEST_FAILURE|Error:|failureType|# fail /.test(lines[i])) {
          for (let j = Math.max(0, i - 3); j <= Math.min(lines.length - 1, i + 10); j++) selected.add(j);
        }
      }
      const excerpt = [...selected].sort((a, b) => a - b).map((i) => lines[i]).join("\n").slice(0, 30_000);
      return { name: check.name, excerpt: excerpt || lines.slice(-70).join("\n").slice(-30_000) };
    } catch (error) {
      return { name: check.name, gap: `Could not read failed job ${job}: ${error.message}` };
    }
  });
}

export function progressRootCauses(evaluation, externalFamilyIds = []) {
  const external = new Set(externalFamilyIds);
  const progressFamilies = evaluation.families.filter((family) => family.severity !== "minor" && !external.has(family.familyId));
  const representedChecks = new Set(progressFamilies.flatMap((family) => family.sourceIds ?? []).filter((id) => id.startsWith("ci/")));
  return new Set([
    ...progressFamilies.map((family) => family.familyId),
    ...evaluation.failedChecks.map((check) => `ci/${check}`).filter((id) => !representedChecks.has(id))
  ]);
}

export function evaluateProgress(previous, current, ledger, limit, externalFamilyIds = []) {
  const families = new Set(current.families.map((family) => family.familyId));
  for (const check of current.failedChecks) families.add(`ci/${check}`);
  const count = families.size;
  const progressCount = progressRootCauses(current, externalFamilyIds).size;
  const historical = previous.filter((item) => item.head !== current.head);
  const last = historical.at(-1);
  const beforeLast = historical.at(-2);
  if (current.verificationGaps.length) return { ok: false, mode: "incomplete", count, reason: current.verificationGaps.join("; ") };
  if ((ledger.rounds ?? []).length >= limit) return { ok: false, mode: "round_limit", count, reason: `Reached ${limit} hosted remediation rounds` };
  const unassessed = current.architectureResetFamilies.filter((id) => ledger.families?.[id]?.state !== "architecture_assessed");
  if (unassessed.length) return { ok: false, mode: "architecture_reset_required", count, reason: unassessed.join(", ") };
  if (count === 0) return { ok: false, mode: "clean_candidate", count, reason: "No current actionable family or failed check; route to independent reviewer" };
  const priorCount = (item) => progressRootCauses(item, externalFamilyIds).size;
  if (last && beforeLast && progressCount >= priorCount(last) && priorCount(last) >= priorCount(beforeLast)) {
    const lastRoots = progressRootCauses(last, externalFamilyIds);
    const currentRoots = progressRootCauses(current, externalFamilyIds);
    const resolved = [...lastRoots].filter((id) => !currentRoots.has(id));
    if (resolved.length && progressCount <= lastRoots.size) {
      return { ok: true, mode: "continue", count, progressCount, reason: `Resolved ${resolved.length} prior root-cause families; ${[...currentRoots].filter((id) => !lastRoots.has(id)).length} newly surfaced` };
    }
    const nextRound = Math.max(0, ...(ledger.rounds ?? []).map((entry) => Number(entry.round))) + 1;
    const assessedReset = current.architectureResetFamilies.length > 0 && current.architectureResetFamilies.every((id) => {
      const family = ledger.families?.[id];
      const assessment = family?.assessment;
      return family?.state === "architecture_assessed" && assessment?.head === current.head && assessment?.round === nextRound &&
        [assessment.invariant, assessment.failingEvidence, assessment.coordinatedPlan, assessment.verificationCriteria].every((value) => String(value ?? "").trim());
    });
    if (assessedReset) return { ok: true, mode: "assessed_reset", count, progressCount, reason: `Current-head architecture assessment permits bounded round ${nextRound}` };
    const recovery = (ledger.recoveryAuthorizations ?? []).find((entry) =>
      entry.head === current.head && entry.round === nextRound && !entry.completedAt &&
      entry.authorizedBy && entry.reason && entry.scope && entry.verificationCriteria
    );
    if (recovery) return { ok: true, mode: "controlled_recovery", count, progressCount, reason: `Authorized round ${nextRound} for exact head ${current.head}: ${recovery.scope}` };
    return { ok: false, mode: "stalled", count, progressCount, reason: "No reduction in blocking/major code root causes across two pushed heads" };
  }
  return { ok: true, mode: "continue", count, progressCount, reason: last ? `${priorCount(last)} prior progress causes; ${progressCount} current` : "First complete PR snapshot" };
}

export function validateEvaluation(result, head, failedChecks, allowedSourceIds) {
  if (!result || result.schemaVersion !== 1 || result.head !== head || result.completeSnapshot !== true || !Array.isArray(result.families) || !Array.isArray(result.verificationGaps) || !Array.isArray(result.architectureResetFamilies)) {
    throw new Error("Convergence evaluator returned an invalid, incomplete, or wrong-head result");
  }
  const ids = new Set();
  for (const family of result.families) {
    if (typeof family.familyId !== "string" || !family.familyId.trim() || typeof family.evidence !== "string" || !family.evidence.trim() || !Array.isArray(family.sourceIds) || family.sourceIds.length === 0 || ids.has(family.familyId)) {
      throw new Error("Convergence evaluator returned a malformed or duplicate family");
    }
    if (allowedSourceIds && family.sourceIds.some((id) => !allowedSourceIds.has(id))) {
      throw new Error(`Convergence evaluator cited an absent source for ${family.familyId}`);
    }
    ids.add(family.familyId);
  }
  return { ...result, failedChecks };
}

export async function runPrConvergenceEvaluation({ cwd = process.cwd(), number } = {}) {
  if (!Number.isInteger(number) || number <= 0) throw new Error("A positive PR number is required");
  const path = ledgerPath(cwd, number);
  if (!existsSync(path)) throw new Error(`Missing persistent PR ledger: ${path}`);
  const ledger = readLedger(path);
  const pr = ghJson(cwd, "pr", "view", String(number), "--repo", config.repository, "--json", "number,url,headRefOid,statusCheckRollup");
  const head = pr.headRefOid;
  if (git(cwd, "rev-parse", "HEAD") !== head || ledger.currentHead !== head) {
    throw new Error(`PR, local, and ledger heads must match before convergence evaluation: PR ${head}, ledger ${ledger.currentHead}`);
  }
  const status = checkStatusRollup(pr.statusCheckRollup);
  if (status.pending.length) throw new Error(`PR_SETTLE_GATE: visible checks pending: ${status.pending.join(", ")}`);
  const parts = ["reviewThreads", "reviews", "comments"].map((kind) => connection(cwd, kind, number));
  if (parts.some((part) => part.head !== head)) throw new Error("PR head changed during the review snapshot");
  const snapshot = { pr: { number, url: pr.url, head }, checks: pr.statusCheckRollup, failedCheckEvidence: failedCheckEvidence(cwd, pr.statusCheckRollup), reviewThreads: parts[0].nodes, reviews: parts[1].nodes, comments: parts[2].nodes, sonar: sonarSnapshot(cwd, number, head) };
  if (snapshot.failedCheckEvidence.some((item) => item.gap)) throw new Error(`Incomplete failed-check evidence: ${JSON.stringify(snapshot.failedCheckEvidence.filter((item) => item.gap))}`);
  const allowedSourceIds = new Set([
    ...snapshot.reviewThreads.flatMap((thread) => [thread.id, ...(thread.comments?.nodes ?? []).map((comment) => comment.id)]),
    ...snapshot.reviews.map((review) => review.id),
    ...snapshot.comments.map((comment) => comment.id),
    ...status.failed.map((name) => `ci/${name}`),
    ...(snapshot.sonar?.issues ?? []).map((issue) => issue.sourceId)
  ]);
  const evaluatorHarness = { harness: "codex", model: "gpt-6-sol", reasoningEffort: "high" };
  const digest = createHash("sha256").update(JSON.stringify(snapshot)).update(JSON.stringify(evaluatorHarness)).digest("hex");
  const previous = ledger.convergenceEvaluations ?? [];
  const cached = previous.find((entry) => entry.head === head && entry.snapshotDigest === digest);
  if (cached) {
    const gate = evaluateProgress(previous.filter((entry) => entry !== cached), cached, ledger, config.pullRequestReviewCycleLimit, config.convergenceExternalValidationFamilies);
    if (JSON.stringify(cached.gate) !== JSON.stringify(gate)) {
      cached.gate = gate;
      writeLedger(path, ledger);
    }
    return { ...cached, gate, cached: true, ledgerPath: path };
  }
  const reviewSnapshot = createSnapshot(cwd, head);
  try {
    const prompt = `Read AGENTS.md and ${instructionsPath}. Evaluate PR #${number} at exact head ${head}. The GitHub snapshot below was captured with full pagination and failed CI job excerpts; the SonarQube issue list is authenticated, complete, and bound to the same commit SHA. Do not refetch or mutate either service. Classify actionable unresolved review concerns, review bodies, issue comments, SonarQube issues, and CI failures by stable root-cause family. Each sourceIds value must be an exact thread, comment, or review ID from the snapshot, sonar/<issue key>, or ci/<failed check name>. Compare with the prior ledger; call for architecture reset when a shared invariant requires a coordinated repair. Do not classify a resolved thread as still open merely because it appears in history. Put tests needed for a fix in that family's evidence, not in verificationGaps. verificationGaps is ONLY for missing or partial input evidence that prevents you from classifying a current source.\n\nPrior ledger:\n${JSON.stringify({ rounds: ledger.rounds, families: ledger.families, convergenceEvaluations: previous.map(({ head, families, failedChecks }) => ({ head, families, failedChecks })) })}\n\nCurrent complete GitHub and SonarQube snapshot:\n${JSON.stringify(snapshot)}\n\nReturn ONLY JSON: {"schemaVersion":1,"head":"${head}","completeSnapshot":true,"families":[{"familyId":"stable-root-cause-id","severity":"blocking|major|minor","sourceIds":["exact source ID"],"evidence":"specific current-head behavior and verification needed for repair"}],"verificationGaps":[],"architectureResetFamilies":[],"summary":"brief assessment"}. Use an empty families array only if all current findings are non-actionable.`,
      raw = await runCodexJson({ prompt, cwd: reviewSnapshot.cwd, githubConfigDir: ghEnv.GH_CONFIG_DIR, timeoutMs: 1_200_000 });
    const evaluation = validateEvaluation(raw, head, status.failed, allowedSourceIds);
    if (git(cwd, "rev-parse", "HEAD") !== head) throw new Error("PR head changed while the convergence evaluator ran");
    const currentPr = ghJson(cwd, "pr", "view", String(number), "--repo", config.repository, "--json", "headRefOid");
    if (currentPr.headRefOid !== head) throw new Error("Remote PR head changed while the convergence evaluator ran");
    if (!evaluation.verificationGaps.length) {
      for (const id of evaluation.architectureResetFamilies) {
        ledger.families[id] ??= { title: id, state: "architecture_reset_required", failedRounds: [], attempts: [] };
      }
    }
    const gate = evaluateProgress(previous, evaluation, ledger, config.pullRequestReviewCycleLimit, config.convergenceExternalValidationFamilies);
    const entry = { ...evaluation, sonarSnapshot: snapshot.sonar, snapshotDigest: digest, evaluatorHarness, evaluatedAt: new Date().toISOString(), gate };
    ledger.convergenceEvaluations = previous.filter((item) => item.head !== head).concat(entry);
    writeLedger(path, ledger);
    return { ...entry, cached: false, ledgerPath: path };
  } finally {
    releaseSnapshot(reviewSnapshot);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--pr");
  const number = Number(process.argv[index + 1]);
  runPrConvergenceEvaluation({ number }).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.gate.ok) process.exitCode = 2;
  }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
