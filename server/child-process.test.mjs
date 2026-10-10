import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile, execFileSync, spawn, spawnExecution, spawnSync } from "./child-process.mjs";
import { LAUNCH_WRAPPER_SOURCE } from "./agent-manager.mjs";
import { DIRECT_PROVIDER_VARIABLES } from "./execution-adapters/index.mjs";

const serverDirectory = path.dirname(fileURLToPath(import.meta.url));
const direct = { OUTRIGHT_ANTHROPIC_API_KEY: "direct-key", OUTRIGHT_ANTHROPIC_BASE_URL: "https://direct.example", outright_anthropic_api_key: "direct-lower" };
const kept = { OUTRIGHT_SCOPE_KEPT: "kept", ANTHROPIC_API_KEY: "harness-own-key" };
const names = [...Object.keys(direct), ...Object.keys(kept)];
const printer = ["-e", `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(names)}.map((name) => [name, process.env[name] ?? null]))))`];
const scopedOutput = JSON.stringify({ ...Object.fromEntries(Object.keys(direct).map((name) => [name, null])), ...kept });

function serverModules(directory = serverDirectory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "bin" ? [] : serverModules(file);
    return /\.(mjs|cjs|js)$/.test(entry.name) && !/\.test\.(mjs|cjs|js)$/.test(entry.name) ? [file] : [];
  });
}

function withRuntimeEnvironment(variables, callback) {
  const saved = Object.fromEntries(Object.keys(variables).map((name) => [name, process.env[name]]));
  Object.assign(process.env, variables);
  const restore = () => { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } };
  try {
    const result = callback();
    return result instanceof Promise ? result.finally(restore) : (restore(), result);
  } catch (error) { restore(); throw error; }
}

function collect(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", reject);
    child.on("close", () => resolve(stdout));
  });
}

// Shared invariant: a direct-provider credential reaches only its own run.
// Every server process launch goes through server/child-process.mjs; the only
// other modules allowed to start processes are listed here with the reason.
const REVIEWED_PROCESS_MODULES = new Map([
  // The scoped primitives themselves, plus spawnExecution for adapter runs.
  ["child-process.mjs", () => {}],
  // The PTY broker runs in a process started through the scoped spawn, and a
  // terminal's environment drops every OUTRIGHT_* variable before it reaches
  // the broker. Every declared direct variable is OUTRIGHT_*.
  ["terminal-broker.mjs", (source) => {
    assert.match(source, /from "node-pty"/);
    assert.ok(DIRECT_PROVIDER_VARIABLES.every((name) => name.startsWith("OUTRIGHT_")));
    assert.match(readFileSync(path.join(serverDirectory, "terminal-manager.mjs"), "utf8"), /const blocked = \/\^\(OUTRIGHT_\|/);
  }],
  // The launch wrapper is a separate process holding its run's scoped
  // environment. Its own helpers must start by absolute path without it.
  ["agent-manager.mjs", (source) => {
    const occurrences = (text) => text.match(/child_process/g)?.length ?? 0;
    assert.equal(occurrences(source), occurrences(LAUNCH_WRAPPER_SOURCE), "agent-manager starts processes only inside the launch wrapper");
    const helpers = [...LAUNCH_WRAPPER_SOURCE.matchAll(/execFileSync\(([^,]+),[^\n]*\)/g)];
    assert.ok(helpers.length >= 4);
    for (const [call, executable] of helpers) {
      assert.match(executable, /^("\/|powershell$)/, `wrapper helper by absolute path: ${call}`);
      assert.match(call, /env: utilityEnvironment/, `wrapper helper without the run's credential: ${call}`);
    }
    assert.match(LAUNCH_WRAPPER_SOURCE, new RegExp(`directProviderVariables = new Set\\(${JSON.stringify(DIRECT_PROVIDER_VARIABLES).replace(/[[\]]/g, "\\$&")}\\)`));
    assert.match(LAUNCH_WRAPPER_SOURCE, /const powershell = path\.win32\.join\(process\.env\.SystemRoot \|\| "C:\\\\Windows", "System32"/);
  }],
]);

test("no server module starts a process outside the credential-scoped primitives", () => {
  const offenders = [];
  for (const file of serverModules()) {
    const source = readFileSync(file, "utf8");
    const relative = path.relative(serverDirectory, file);
    if (/child_process|node-pty|process\.binding\(|\bspawn_sync\b/.test(source)) {
      const review = REVIEWED_PROCESS_MODULES.get(relative);
      if (review) review(source);
      else offenders.push(relative);
    }
    if (/\bspawnExecution\b/.test(source) && !["child-process.mjs", "agent-manager.mjs"].includes(relative)) offenders.push(`${relative} (spawnExecution)`);
  }
  assert.deepEqual(offenders, [], "start these processes through server/child-process.mjs");
  const manager = readFileSync(path.join(serverDirectory, "agent-manager.mjs"), "utf8");
  assert.deepEqual(manager.match(/\bspawnExecution\b/g), ["spawnExecution", "spawnExecution"], "only the adapter run launch is unscoped");
  assert.match(manager, /spawnProcess = spawnExecution,/);
  assert.match(manager, /env: buildExecutionEnvironment\(run\.provider, /);
});

test("every scoped primitive removes direct credentials from inherited and explicit environments", async () => {
  await withRuntimeEnvironment({ ...direct, ...kept }, async () => {
    const results = {
      spawn: await collect(spawn(process.execPath, printer)),
      spawnExplicit: await collect(spawn(process.execPath, printer, { env: { ...process.env } })),
      spawnSync: String(spawnSync(process.execPath, printer).stdout),
      execFile: await new Promise((resolve, reject) => execFile(process.execPath, printer, (error, stdout) => error ? reject(error) : resolve(stdout))),
      execFileExplicit: await new Promise((resolve, reject) => execFile(process.execPath, printer, { env: { ...process.env } }, (error, stdout) => error ? reject(error) : resolve(stdout))),
      execFileAsync: (await promisify(execFile)(process.execPath, printer, { encoding: "utf8" })).stdout,
      execFileSync: String(execFileSync(process.execPath, printer)),
    };
    for (const [primitive, output] of Object.entries(results)) assert.equal(output, scopedOutput, primitive);
    // The adapter run launch receives exactly the environment it was given.
    const execution = JSON.parse(await collect(spawnExecution(process.execPath, printer, { env: { ...process.env } })));
    assert.equal(execution.OUTRIGHT_ANTHROPIC_API_KEY, "direct-key");
  });
});
