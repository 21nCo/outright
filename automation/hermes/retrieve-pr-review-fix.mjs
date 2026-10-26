#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { evaluateLedger, ledgerPath, readLedger, writeLedger } from "./pr-remediation-ledger.mjs";
import { runPrConvergenceEvaluation } from "./pr-convergence-evaluator.mjs";
import { selectPinnedSkill } from "./skill-pin.mjs";
import { runRepairCheckpoint } from "/Users/serro/Documents/dev/n/agent/automation/linear-loop/repair-checkpoint.mjs";

const configPath = fileURLToPath(new URL("./workflow.json", import.meta.url));
const config = JSON.parse(readFileSync(configPath, "utf8"));
const worktreeConfigPath = resolve(process.cwd(), "automation/hermes/workflow.json");
const worktreeConfig = existsSync(worktreeConfigPath) ? JSON.parse(readFileSync(worktreeConfigPath, "utf8")) : null;
const taskId = process.env.HERMES_KANBAN_TASK || "manual";
const runId = process.env.HERMES_KANBAN_RUN || `${taskId}-${Date.now()}`;
const pr = JSON.parse(execFileSync(
  "gh",
  ["pr", "view", "--json", "number,url,headRefOid"],
  {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, GH_CONFIG_DIR: "/Users/serro/.config/gh-other" }
  }
));
const path = ledgerPath(process.cwd(), pr.number);
if (!existsSync(path)) {
  throw new Error(`Missing persistent PR remediation ledger: ${path}. Initialize it before retrieving the hosted skill.`);
}
const ledger = readLedger(path);
const pinned = selectPinnedSkill(ledger.skill, worktreeConfig?.skillplane, config.skillplane);
if (!pinned) {
  throw new Error(`Ledger skill pin is not in the assigned worktree or coordinator workflow config: ${ledger.skill?.identity} (${ledger.skill?.digest})`);
}
const expectedIdentity = `${pinned.workspaceSlug}/${pinned.skillSlug}@${pinned.semanticVersion}`;
const gate = evaluateLedger(ledger);
if (!gate.ok) {
  throw new Error(`ARCHITECTURE_RESET_REQUIRED: ${gate.resetRequired.join(", ")}. Record a complete architecture assessment in ${path} before another hosted mutation pass.`);
}
const convergence = await runPrConvergenceEvaluation({ number: pr.number });
const sharedConfig = JSON.parse(readFileSync("/Users/serro/Documents/dev/n/agent/automation/linear-loop/projects/outright.json", "utf8"));
const checkpoint = await runRepairCheckpoint({ config: sharedConfig, number: pr.number, evaluation: convergence,
  ledgerFile: path, read: readLedger, write: writeLedger });
if (!checkpoint.gate.ok) {
  throw new Error(`PR_REPAIR_${checkpoint.gate.mode.toUpperCase()}: ${checkpoint.gate.reason}. Checkpoint evidence: ${path}`);
}
if (!convergence.gate.ok) {
  throw new Error(`PR_CONVERGENCE_${convergence.gate.mode.toUpperCase()}: ${convergence.gate.reason}. Evaluator evidence: ${path}`);
}

const payload = {
  skill: {
    workspaceSlug: pinned.workspaceSlug,
    skillSlug: pinned.skillSlug
  },
  caller: {
    agentId: "outright-implementer",
    agentName: "Outright implementer",
    modelProvider: config.models.implementer.provider,
    modelName: config.models.implementer.id,
    modelVersion: "current",
    clientName: "Hermes Kanban",
    clientVersion: "current",
    runId,
    sessionId: process.env.HERMES_SESSION_ID || runId,
    conversationId: taskId
  },
  version: {
    selector: "semanticVersion",
    semanticVersion: pinned.semanticVersion
  }
};

const stdout = execFileSync(
  "composio",
  ["execute", "CUSTOM_SKILLPLANE_SKILL_RETRIEVE", "-d", JSON.stringify(payload)],
  { encoding: "utf8" }
);
const response = JSON.parse(stdout);

if (!response.successful) {
  throw new Error(response.error || "Skillplane retrieval failed");
}

const data = response.data;
const identity = `${data.skill.workspaceSlug}/${data.skill.slug}@${data.version.semanticVersion}`;
if (identity !== `${pinned.workspaceSlug}/${pinned.skillSlug}@${pinned.semanticVersion}`) {
  throw new Error(`Unexpected hosted skill identity: ${identity}`);
}
if (data.version.digest !== pinned.digest) {
  throw new Error(`Hosted skill digest drift: expected ${pinned.digest}, received ${data.version.digest}`);
}

process.stdout.write(`Hosted skill: ${identity}\nDigest: ${data.version.digest}\nLedger: ${path}\nConvergence mode: ${gate.mode}\nConvergence evaluator: ${convergence.gate.mode} (${convergence.gate.reason})\nFive-round repair checkpoint: ${checkpoint.gate.mode}${checkpoint.report ? ` (${checkpoint.report.trend}: ${checkpoint.report.evidence})` : ""}\nPR snapshot candidate: ${pr.headRefOid}\n\n${data.instructions}\n`);
