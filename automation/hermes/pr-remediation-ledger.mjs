#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const START = "<!-- outright-pr-remediation-state:v1";
const END = "-->";

export function ledgerPath(root, prNumber) {
  return resolve(root, ".outright", `pr-review-ledger-${Number(prNumber)}.md`);
}

export function createLedger({ prNumber, prUrl, head, skill }) {
  return {
    schemaVersion: 1,
    prNumber: Number(prNumber),
    prUrl,
    currentHead: head,
    skill,
    rounds: [],
    families: {}
  };
}

export function parseLedger(text) {
  const start = text.indexOf(START);
  const end = text.indexOf(END, start + START.length);
  if (start < 0 || end < 0) throw new Error("Ledger is missing the outright-pr-remediation-state:v1 block");
  return JSON.parse(text.slice(start + START.length, end).trim());
}

export function renderLedger(state) {
  const families = Object.entries(state.families ?? {});
  const rows = families.length
    ? families.map(([id, family]) => `| ${id} | ${family.state} | ${(family.failedRounds ?? []).join(", ") || "-"} | ${family.title ?? ""} |`).join("\n")
    : "| - | none | - | No defect families recorded |";
  return `${START}\n${JSON.stringify(state, null, 2)}\n${END}\n\n# PR review convergence ledger: #${state.prNumber}\n\nPR: ${state.prUrl}\n\n| Family ID | State | Failed rounds | Contract |\n| --- | --- | --- | --- |\n${rows}\n\nThis file is managed by \`automation/hermes/pr-remediation-ledger.mjs\`. Keep evidence and round summaries in the structured state block so later workers can enforce convergence resets.\n`;
}

export function readLedger(path) {
  return parseLedger(readFileSync(path, "utf8"));
}

export function writeLedger(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderLedger(state));
}

export function recordFailure(state, { familyId, title, round, head, evidence }) {
  const family = state.families[familyId] ?? {
    title,
    state: "open",
    failedRounds: [],
    attempts: []
  };
  if (!family.failedRounds.includes(Number(round))) family.failedRounds.push(Number(round));
  family.failedRounds.sort((a, b) => a - b);
  family.attempts.push({ round: Number(round), head, evidence });
  family.title = title || family.title;
  // A repeated failure invalidates prior proof even within the first round.
  delete family.assessment;
  delete family.resolution;
  if (family.failedRounds.length >= 2) {
    family.state = "architecture_reset_required";
  } else {
    family.state = "open";
  }
  state.families[familyId] = family;
  state.currentHead = head || state.currentHead;
  return state;
}

export function recordAssessment(state, { familyId, invariant, failingEvidence, coordinatedPlan, verificationCriteria }) {
  const family = state.families[familyId];
  if (!family) throw new Error(`Unknown defect family: ${familyId}`);
  const assessment = { invariant, failingEvidence, coordinatedPlan, verificationCriteria };
  for (const [field, value] of Object.entries(assessment)) {
    if (!String(value ?? "").trim()) throw new Error(`Architecture assessment requires ${field}`);
  }
  family.assessment = assessment;
  family.state = "architecture_assessed";
  return state;
}

export function evaluateLedger(state) {
  const resetRequired = Object.entries(state.families ?? {})
    .filter(([, family]) => family.state === "architecture_reset_required")
    .map(([id]) => id);
  const assessed = Object.entries(state.families ?? {})
    .filter(([, family]) => family.state === "architecture_assessed")
    .map(([id]) => id);
  return {
    ok: resetRequired.length === 0,
    mode: resetRequired.length ? "architecture_reset_required" : assessed.length ? "architecture_reset" : "routine",
    resetRequired,
    assessed
  };
}

function value(args, name) {
  const index = args.indexOf(name);
  if (index < 0 || index + 1 >= args.length) throw new Error(`Missing ${name}`);
  return args[index + 1];
}

function optionalValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
}

export function runCli(args, root = process.cwd()) {
  const [command] = args;
  const prNumber = value(args, "--pr");
  const path = ledgerPath(root, prNumber);
  if (command === "init") {
    if (existsSync(path)) return { path, state: readLedger(path), created: false };
    const state = createLedger({
      prNumber,
      prUrl: value(args, "--url"),
      head: value(args, "--head"),
      skill: {
        identity: value(args, "--skill"),
        digest: value(args, "--digest")
      }
    });
    writeLedger(path, state);
    return { path, state, created: true };
  }
  if (!existsSync(path)) throw new Error(`Missing persistent ledger: ${path}`);
  const state = readLedger(path);
  if (command === "check") return { path, state, gate: evaluateLedger(state) };
  if (command === "record-failure") {
    recordFailure(state, {
      familyId: value(args, "--family"),
      title: value(args, "--title"),
      round: value(args, "--round"),
      head: value(args, "--head"),
      evidence: value(args, "--evidence")
    });
    writeLedger(path, state);
    return { path, state, gate: evaluateLedger(state) };
  }
  if (command === "record-assessment") {
    recordAssessment(state, {
      familyId: value(args, "--family"),
      invariant: value(args, "--invariant"),
      failingEvidence: value(args, "--failing-evidence"),
      coordinatedPlan: value(args, "--plan"),
      verificationCriteria: value(args, "--verification")
    });
    writeLedger(path, state);
    return { path, state, gate: evaluateLedger(state) };
  }
  if (command === "resolve-family") {
    const familyId = value(args, "--family");
    const family = state.families[familyId];
    if (!family) throw new Error(`Unknown defect family: ${familyId}`);
    family.state = "resolved";
    family.resolution = {
      head: value(args, "--head"),
      evidence: value(args, "--evidence")
    };
    state.currentHead = family.resolution.head;
    writeLedger(path, state);
    return { path, state, gate: evaluateLedger(state) };
  }
  if (command === "record-round") {
    const round = Number(value(args, "--round"));
    const entry = {
      round,
      snapshotHead: value(args, "--snapshot-head"),
      pushedHead: optionalValue(args, "--pushed-head", null),
      status: value(args, "--status"),
      summary: value(args, "--summary")
    };
    state.rounds = (state.rounds ?? []).filter((item) => item.round !== round);
    state.rounds.push(entry);
    state.rounds.sort((a, b) => a.round - b.round);
    state.currentHead = entry.pushedHead || entry.snapshotHead;
    writeLedger(path, state);
    return { path, state, gate: evaluateLedger(state) };
  }
  throw new Error(`Unknown command: ${command}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = runCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.gate && !result.gate.ok) process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
