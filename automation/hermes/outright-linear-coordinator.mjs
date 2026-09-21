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

export function selectNextIssue(issues, backlogState = "Backlog") {
  return issues
    .filter((issue) => {
      const state = typeof issue.state === "string" ? issue.state : issue.state?.name;
      return state === backlogState;
    })
    .sort((left, right) => {
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
3. Run the relevant focused checks plus npm test, npm run build, and npm run test:sites.
4. Commit, push the task branch, and open a pull request against main in ${config.repository}.
5. Use only Composio CLI for Linear access. Move ${issue.identifier} to In Review and comment with the PR URL.
6. Call kanban_request_review with a concrete implementation and validation summary, reviewer=${config.profiles.reviewer}, and metadata containing the Linear ID, branch, PR URL, changed files, and checks.
7. If review requests changes, address every finding on the same branch, rerun validation, push, and request review again.

The reviewer may repeat the loop up to ${config.reviewCycleLimit} times. Do not merge the PR.`;
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
    "--model",
    config.models.implementer,
    "--provider",
    config.models.provider,
    "--completion-contract",
    config.repository,
    "--goal",
    "--goal-max-turns",
    "30",
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
  const issue = selectNextIssue(extractIssues(issueData), config.linear.backlogState);
  if (!issue) return;

  const card = createCard(issue);
  composio("LINEAR_UPDATE_ISSUE", {
    issueId: issue.id,
    stateId: config.linear.inProgressStateId
  });
  composio("LINEAR_CREATE_LINEAR_COMMENT", {
    issueId: issue.id,
    body: `Implementation started by the Outright Hermes workflow. Kanban card: ${card.id ?? card.task_id ?? "created"}.`
  });
  process.stdout.write(`Queued ${issue.identifier}: ${issue.title}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
