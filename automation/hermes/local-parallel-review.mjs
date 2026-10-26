#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertCleanHead, createSnapshot, git, releaseSnapshot } from "./review-runner.mjs";
import { runReviewerJson } from "/Users/serro/Documents/dev/n/agent/automation/linear-loop/review-runner.mjs";
import { reviewerIdentity } from "/Users/serro/Documents/dev/n/agent/automation/linear-loop/local-parallel-review.mjs";

const config = JSON.parse(readFileSync(fileURLToPath(new URL("./workflow.json", import.meta.url)), "utf8"));
const instructionsPath = fileURLToPath(new URL("./local-review-agent.md", import.meta.url));

export function validateReview(result, reviewer, head) {
  if (!result || result.schemaVersion !== 1 || result.reviewer !== reviewer || result.head !== head || !Array.isArray(result.findings)) {
    throw new Error(`${reviewer} returned an invalid or wrong-head review`);
  }
  for (const finding of result.findings) {
    for (const field of ["familyId", "severity", "file", "evidence", "requiredBehavior"]) {
      if (typeof finding[field] !== "string" || !finding[field].trim()) throw new Error(`${reviewer} finding lacks ${field}`);
    }
  }
  return result;
}

export async function runLocalParallelReview({ repo = process.cwd(), taskId = process.env.HERMES_KANBAN_TASK } = {}) {
  if (!taskId) throw new Error("Local review requires HERMES_KANBAN_TASK");
  const head = git(repo, "rev-parse", "HEAD");
  assertCleanHead(repo, head);
  const base = git(repo, "merge-base", "origin/main", head);
  const artifact = join(homedir(), ".hermes", "outright", "local-reviews", taskId, `${head}-${base}.json`);
  const reviewers = [
    { name: "gpt-6-sol", harness: "codex", model: "gpt-6-sol", reasoningEffort: "high" },
    { name: "glm-5.3", harness: "hermes", profile: config.profiles.localGlmReviewer },
    { name: "opus-5.5", harness: "droid", model: "claude-opus-5-5", reasoningEffort: "high" }
  ];
  const reviewerIdentities = reviewers.map(reviewerIdentity);
  if (existsSync(artifact)) {
    const cached = JSON.parse(readFileSync(artifact, "utf8"));
    if (cached.head === head && cached.base === base && cached.reviews?.length === reviewers.length &&
        JSON.stringify(cached.reviewerIdentities) === JSON.stringify(reviewerIdentities)) return { ...cached, artifact, cached: true };
  }
  const task = JSON.parse(execFileSync("hermes", ["kanban", "--board", config.board, "show", taskId, "--json"], { encoding: "utf8" })).task;
  if (!task?.body) throw new Error(`Cannot read issue context for ${taskId}`);
  const snapshots = [];
  try {
    for (const reviewer of reviewers) snapshots.push(createSnapshot(repo, head));
  } catch (error) {
    for (const snapshot of snapshots) releaseSnapshot(snapshot);
    throw error;
  }
  try {
    const outcomes = await Promise.allSettled(reviewers.map(async (reviewer, index) => {
      const prompt = `Review Outright issue ${task.title} at exact commit ${head} against base ${base}. Read AGENTS.md and ${instructionsPath}. This is an independent local review before PR creation. Do not edit anything. Inspect the full diff and relevant surrounding code.\n\nIssue and acceptance context:\n${task.body}\n\nReturn ONLY JSON: {"schemaVersion":1,"reviewer":"${reviewer.name}","head":"${head}","findings":[{"familyId":"stable-root-cause-id","severity":"blocking|major|minor","file":"path:line","evidence":"reproduction or causal proof","requiredBehavior":"fix contract"}],"verificationGaps":["..."]}. An empty findings array is valid when justified.`,
        result = await runReviewerJson(reviewer, { prompt, cwd: snapshots[index].cwd, githubConfigDir: "/Users/serro/.config/gh-other" });
      assertCleanHead(snapshots[index].cwd, head);
      return validateReview(result, reviewer.name, head);
    }));
    const failed = outcomes.filter((outcome) => outcome.status === "rejected");
    if (failed.length) throw new AggregateError(failed.map((outcome) => outcome.reason), "All local reviewers must complete before the gate can decide");
    const reviews = outcomes.map((outcome) => outcome.value);
    assertCleanHead(repo, head);
    const result = { schemaVersion: 1, taskId, head, base, reviewerIdentities, reviews, completedAt: new Date().toISOString() };
    mkdirSync(join(homedir(), ".hermes", "outright", "local-reviews", taskId), { recursive: true });
    writeFileSync(artifact, JSON.stringify(result, null, 2), { mode: 0o600 });
    return { ...result, artifact, cached: false };
  } finally {
    const cleanupErrors = [];
    for (const snapshot of snapshots) {
      try { releaseSnapshot(snapshot); } catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Review snapshots were preserved because cleanup could not prove them clean");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runLocalParallelReview().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
