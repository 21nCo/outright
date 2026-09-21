#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const configPath = fileURLToPath(new URL("./workflow.json", import.meta.url));
const config = JSON.parse(readFileSync(configPath, "utf8"));
const pinned = config.skillplane;
const taskId = process.env.HERMES_KANBAN_TASK || "manual";
const runId = process.env.HERMES_KANBAN_RUN || `${taskId}-${Date.now()}`;

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

process.stdout.write(`Hosted skill: ${identity}\nDigest: ${data.version.digest}\n\n${data.instructions}\n`);
