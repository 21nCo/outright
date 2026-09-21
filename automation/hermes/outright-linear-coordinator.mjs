#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const configPath = fileURLToPath(new URL("./workflow.json", import.meta.url));
const config = JSON.parse(readFileSync(configPath, "utf8"));

function executeJson(command, args) {
  const stdout = execFileSync(command, args, {
    cwd: config.workdir,
    encoding: "utf8",
    env: {
      ...process.env,
      GH_CONFIG_DIR: "/Users/serro/.config/gh-other"
    }
  });
  return JSON.parse(stdout);
}

function composio(slug, data) {
  const result = executeJson("composio", ["execute", slug, "-d", JSON.stringify(data)]);
  if (!result.successful) {
    throw new Error(`${slug} failed: ${result.error ?? "unknown Composio error"}`);
  }
  return result.data ?? {};
}

function issueNumber(issue) {
  const match = String(issue.identifier ?? "").match(/-(\d+)$/);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

export function selectNextIssue(issues, backlogState = "Backlog", issueOrder = []) {
  const order = new Map(issueOrder.map((identifier, index) => [identifier, index]));
  return issues
    .filter((issue) => {
      const state = typeof issue.state === "string" ? issue.state : issue.state?.name;
      return state === backlogState;
    })
    .sort((left, right) => {
      const leftOrder = order.get(left.identifier) ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = order.get(right.identifier) ?? Number.MAX_SAFE_INTEGER;
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      const leftPriority = left.priority > 0 ? left.priority : 5;
      const rightPriority = right.priority > 0 ? right.priority : 5;
      return leftPriority - rightPriority || issueNumber(left) - issueNumber(right);
    })[0];
}

export function hasActiveCard(cards) {
  return cards.some((card) => !["done", "archived"].includes(card.status));
}

function extractCards(payload) {
  if (Array.isArray(payload)) return payload;
  return payload.tasks ?? payload.cards ?? payload.items ?? [];
}

function extractIssues(payload) {
  return payload.issues ?? payload.items ?? [];
}

function cardBody(issue) {
  const description = issue.description?.trim() || "No Linear description was provided.";
  return `# ${issue.identifier}: ${issue.title}

Linear issue ID: ${issue.id}
Linear team: ${config.linear.teamName} (${config.linear.teamId})

## Issue

${description}

## Required delivery loop

1. Read AGENTS.md and inspect the existing implementation before editing.
2. Implement the whole issue in the assigned worktree. Keep the change scoped to this issue.
   Treat OUT-31 accessibility and OUT-32 performance as cross-cutting acceptance criteria and do not regress them.
3. Run the relevant focused checks plus npm test, npm run build, and npm run test:sites.
4. Commit locally without pushing or opening a pull request, then call kanban_request_review with phase=local and reviewer=${config.profiles.reviewer}.
5. Address every local-review finding and repeat until the reviewer emits the LOCAL_GATE_PASSED transition.
6. After that transition, push the branch and open a pull request against main in ${config.repository}. Move ${issue.identifier} to In Review through Composio CLI and comment with the PR URL.
7. Wait for the current PR head's checks and automatic review agents to settle. Retrieve the pinned hosted Skillplane PR remediation skill through Composio and execute exactly one bounded review-fix pass.
8. Hand the current PR head back to ${config.profiles.reviewer} with phase=pr. If it requests another PR round, wait for the new head's review activity and invoke the hosted skill once again.

The local loop is capped at ${config.localReviewCycleLimit} review rounds and the PR loop at ${config.pullRequestReviewCycleLimit} hosted remediation rounds. A clean PR must wait at the human merge gate with Linear still In Review. Do not merge the PR without the user's explicit go.`;
}

function createCard(issue) {
  const branch = `linear/${issue.identifier.toLowerCase()}`;
  return executeJson("hermes", [
    "kanban",
    "create",
    `${issue.identifier}: ${issue.title}`,
    "--body",
    cardBody(issue),
    "--assignee",
    config.profiles.implementer,
    "--project",
    config.project,
    "--workspace",
    "worktree",
    "--branch",
    branch,
    "--priority",
    String(issue.priority || 0),
    "--idempotency-key",
    `linear:${issue.id}`,
    "--max-runtime",
    "4h",
    "--max-retries",
    "2",
    "--completion-contract",
    config.repository,
    "--json"
  ]);
}

function main() {
  const cards = extractCards(executeJson("hermes", ["kanban", "list", "--json"]));
  if (hasActiveCard(cards)) return;

  const issueData = composio("LINEAR_LIST_ISSUES_BY_TEAM_ID", {
    team_id: config.linear.teamId,
    first: 250,
    include_archived: false
  });
  const issue = selectNextIssue(
    extractIssues(issueData),
    config.linear.backlogState,
    config.linear.issueOrder
  );
  if (!issue) return;

  const fullIssueData = composio("LINEAR_GET_LINEAR_ISSUE", { issue_id: issue.id });
  const fullIssue = { ...issue, ...(fullIssueData.issue ?? {}) };
  const card = createCard(fullIssue);
  composio("LINEAR_UPDATE_ISSUE", {
    issueId: fullIssue.id,
    stateId: config.linear.inProgressStateId
  });
  composio("LINEAR_CREATE_LINEAR_COMMENT", {
    issueId: fullIssue.id,
    body: `Implementation started by the Outright Hermes workflow. Kanban card: ${card.id ?? card.task_id ?? "created"}.`
  });
  process.stdout.write(`Queued ${fullIssue.identifier}: ${fullIssue.title}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
