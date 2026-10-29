import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOutrightDatabase } from "./database.mjs";
import { createGitService } from "./git-service.mjs";
import { createSubprocessBudget } from "./subprocess-budget.mjs";
import { lifecycleSummary } from "../src/lib/worktree-lifecycle.js";
import { LIFECYCLE_CONFIG_FILE, LIFECYCLE_LIMITS, createWorktreeLifecycle, parseLifecycleConfig, readLifecycleConfig, sanitizeOutput } from "./worktree-lifecycle.mjs";

// Disposable repositories must not be attached to a host Git Trace2 consumer.
process.env.GIT_TRACE2_EVENT = "0";

async function waitFor(condition, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (!await condition()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function git(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

// A node step: every command in these fixtures runs the current Node.
function node(script, ...args) {
  return [process.execPath, "-e", script, ...args];
}

function writeConfig(worktreePath, config) {
  writeFileSync(path.join(worktreePath, LIFECYCLE_CONFIG_FILE), JSON.stringify({ version: 1, ...config }));
}

function withLifecycle(fn) {
  return async () => {
    const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "outright-lifecycle-")));
    const repository = path.join(root, "project");
    mkdirSync(repository);
    git(repository, ["init"]);
    git(repository, ["config", "user.email", "outright@example.test"]);
    git(repository, ["config", "user.name", "Outright Test"]);
    git(repository, ["commit", "--allow-empty", "-m", "initial"]);
    const database = createOutrightDatabase({ filename: path.join(root, "outright.db") });
    const subprocesses = createSubprocessBudget({ limit: 4 });
    const events = [];
    const project = { id: "project", name: "project", path: repository };
    const target = { project, worktree: { id: "main" }, worktreePath: repository };
    const created = [];
    const create = (options = {}) => {
      const lifecycle = createWorktreeLifecycle({ database, subprocesses, publish: (event) => events.push(event),
        onPersistError: (error) => { throw error; }, ...options });
      created.push(lifecycle);
      return lifecycle;
    };
    try {
      await fn({ root, repository, database, subprocesses, events, project, target, create });
    } finally {
      await Promise.allSettled(created.map((lifecycle) => lifecycle.shutdown()));
      await database.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  };
}

async function settled(lifecycle, target, timeoutMs = 10_000) {
  let described;
  await waitFor(async () => {
    described = await lifecycle.describe(target);
    return described.running === null && described.state?.status !== "running";
  }, timeoutMs, "lifecycle run did not settle");
  return described;
}

test("repository configuration is strict, bounded and read only from a regular file", async () => {
  assert.deepEqual(parseLifecycleConfig(JSON.stringify({ version: 1, setup: [{ name: " Install ", command: ["npm", "ci"] }] })),
    { version: 1, setup: [{ name: "Install", command: ["npm", "ci"], timeoutSeconds: LIFECYCLE_LIMITS.defaultTimeoutSeconds }], teardown: [] });
  for (const [config, pattern] of [
    ["not json", /valid JSON/],
    [JSON.stringify([]), /JSON object/],
    [JSON.stringify({ version: 2 }), /version/],
    [JSON.stringify({ version: 1, scripts: {} }), /unknown field "scripts"/],
    [JSON.stringify({ version: 1, setup: [{ name: "x", command: "npm ci" }] }), /command must be an array/],
    [JSON.stringify({ version: 1, setup: [{ name: "x", command: [""] }] }), /starting with a program/],
    [JSON.stringify({ version: 1, setup: [{ name: "x", command: ["a\0b"] }] }), /command must be an array/],
    [JSON.stringify({ version: 1, setup: [{ name: "", command: ["true"] }] }), /name must be/],
    [JSON.stringify({ version: 1, setup: [{ name: "a\u001b[31m", command: ["true"] }] }), /name must be/],
    // A reviewed command must look like the one that runs (Trojan Source).
    [JSON.stringify({ version: 1, setup: [{ name: "Install", command: ["sh", "-c", "echo safe \u202e; rm -rf ~ \u202c"] }] }), /command\[2\] contains an invisible, reordering/],
    [JSON.stringify({ version: 1, setup: [{ name: "Install", command: ["np\u200bm", "ci"] }] }), /command\[0\] contains/],
    [JSON.stringify({ version: 1, setup: [{ name: "Install", command: ["npm\u00a0ci"] }] }), /command\[0\] contains/],
    [JSON.stringify({ version: 1, setup: [{ name: "Install", command: ["echo", "\u2066x\u2069"] }] }), /command\[1\] contains/],
    ['{"version":1,"setup":[{"name":"Install","command":["echo","\\ud800"]}]}', /command\[1\] contains/],
    [JSON.stringify({ version: 1, setup: [{ name: "Inst\u202eall", command: ["true"] }] }), /name must be/],
    [JSON.stringify({ version: 1, setup: [{ name: "Ins\ufefftall", command: ["true"] }] }), /name must be/],
    [JSON.stringify({ version: 1, setup: [{ name: "x", command: ["true"], timeoutSeconds: 0 }] }), /timeoutSeconds/],
    [JSON.stringify({ version: 1, setup: [{ name: "x", command: ["true"], shell: true }] }), /unknown field "shell"/],
    [JSON.stringify({ version: 1, teardown: Array.from({ length: LIFECYCLE_LIMITS.steps + 1 }, () => ({ name: "x", command: ["true"] })) }), /at most/],
  ]) assert.throws(() => parseLifecycleConfig(config), pattern, config);

  const root = mkdtempSync(path.join(os.tmpdir(), "outright-lifecycle-config-"));
  try {
    assert.equal(await readLifecycleConfig(root), null, "a worktree without the file has nothing to run");
    writeConfig(root, { setup: [{ name: "Install", command: ["npm", "ci"] }] });
    const first = await readLifecycleConfig(root);
    assert.match(first.digest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(first.error, undefined);
    writeConfig(root, { setup: [{ name: "Install", command: ["npm", "install"] }] });
    assert.notEqual((await readLifecycleConfig(root)).digest, first.digest, "the digest binds the exact bytes");
    writeFileSync(path.join(root, LIFECYCLE_CONFIG_FILE), "x".repeat(LIFECYCLE_LIMITS.configBytes + 1));
    assert.match((await readLifecycleConfig(root)).error, /larger than/);
    if (process.platform !== "win32") {
      rmSync(path.join(root, LIFECYCLE_CONFIG_FILE));
      const outside = path.join(root, "outside.json");
      writeFileSync(outside, JSON.stringify({ version: 1 }));
      symlinkSync(outside, path.join(root, LIFECYCLE_CONFIG_FILE));
      assert.match((await readLifecycleConfig(root)).error, /regular file/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
  // Tabs and line breaks are visible in the review, as are non-Latin scripts.
  assert.deepEqual(parseLifecycleConfig(JSON.stringify({ version: 1, setup: [{ name: "Préparer 日本", command: ["sh", "-c", "a\tb\nc"] }] })).setup[0].command,
    ["sh", "-c", "a\tb\nc"]);
  assert.equal(sanitizeOutput("\u001b[32mok\u001b[0m\r\nbar\rbaz\u0007\u001b]0;title\u0007"), "ok\nbar\nbaz");
});

test("no repository command runs until the user trusts its exact configuration", withLifecycle(async ({ repository, database, project, target, create }) => {
  const marker = path.join(repository, "setup-ran");
  writeConfig(repository, { setup: [{ name: "Mark", command: node("require('fs').writeFileSync(process.argv[1], 'x')", marker) }] });
  const lifecycle = create();
  // Creation starts setup automatically; untrusted configuration only waits.
  const waiting = await lifecycle.setup(target, { automatic: true });
  assert.equal(waiting.status, "needs-trust");
  await assert.rejects(lifecycle.setup(target), (error) => error.details?.code === "LIFECYCLE_TRUST_REQUIRED");
  assert.equal(existsSync(marker), false);

  const described = await lifecycle.describe(target);
  assert.equal(described.config.trusted, false);
  assert.equal(described.config.setup[0].name, "Mark");
  // A file changed after it was shown is not the configuration the user saw.
  await assert.rejects(lifecycle.trust(target, "sha256:" + "0".repeat(64)), (error) => error.details?.code === "LIFECYCLE_CONFIG_CHANGED");
  assert.equal((await lifecycle.trust(target, described.config.digest)).config.trusted, true);
  assert.equal((await lifecycle.setup(target)).status, "running");
  const finished = await settled(lifecycle, target);
  assert.equal(finished.state.status, "ready");
  assert.equal(existsSync(marker), true);

  // Trust is bound to the digest: an edited configuration waits again.
  rmSync(marker);
  writeConfig(repository, { setup: [{ name: "Mark again", command: node("require('fs').writeFileSync(process.argv[1], 'y')", marker) }] });
  await assert.rejects(lifecycle.setup(target), (error) => error.details?.code === "LIFECYCLE_TRUST_REQUIRED");
  assert.equal(existsSync(marker), false);
  // Revoking project trust revokes trusted lifecycle configurations too.
  const current = await lifecycle.describe(target);
  await lifecycle.trust(target, current.config.digest);
  database.untrustProject(project.id);
  assert.equal((await lifecycle.describe(target)).config.trusted, false);
}));

test("a failed step is reported truthfully and a retry resumes without repeating finished steps", withLifecycle(async ({ repository, database, project, target, create }) => {
  const counter = path.join(repository, "first-step-runs");
  const allow = path.join(repository, "allow-second");
  writeConfig(repository, { setup: [
    { name: "Count", command: node("require('fs').appendFileSync(process.argv[1], 'a')", counter) },
    { name: "Gate", command: node("if (!require('fs').existsSync(process.argv[1])) { console.error('database is not ready'); process.exit(3); } console.log('gate open');", allow) },
  ] });
  const lifecycle = create();
  database.trustLifecycleConfig(project.id, project.path, (await readLifecycleConfig(repository)).digest);
  await lifecycle.setup(target);
  const failed = await settled(lifecycle, target);
  assert.equal(failed.state.status, "failed");
  assert.equal(failed.state.stepIndex, 1);
  assert.match(failed.state.error, /"Gate" exited with status 3/);
  assert.match(failed.state.output, /database is not ready/);

  // The failed state, with its output, is durable.
  const restarted = create();
  const durable = await restarted.describe(target);
  assert.equal(durable.state.status, "failed");
  assert.match(durable.state.output, /database is not ready/);

  writeFileSync(allow, "");
  assert.equal((await restarted.setup(target)).stepIndex, 1, "retry resumes at the failed step");
  const ready = await settled(restarted, target);
  assert.equal(ready.state.status, "ready");
  assert.equal(readFileSync(counter, "utf8"), "a", "the finished first step did not run again");
  assert.match(ready.state.output, /Resuming at step 2[\s\S]*gate open/);
}));

test("cancelling setup ends the step's descendants and is never reported as ready", { timeout: 30_000 }, withLifecycle(async ({ repository, database, project, target, create, events }) => {
  const pidFile = path.join(repository, "descendant.pid");
  const script = `const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    require('fs').writeFileSync(process.argv[1], String(child.pid));
    child.unref(); console.log('waiting'); setInterval(() => {}, 1000);`;
  writeConfig(repository, { setup: [{ name: "Serve", command: node(script, pidFile) }, { name: "Never", command: node("process.exit(0)") }] });
  const lifecycle = create();
  database.trustLifecycleConfig(project.id, project.path, (await readLifecycleConfig(repository)).digest);
  await lifecycle.setup(target);
  await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").length > 0, 10_000, "descendant did not start");
  const descendant = Number(readFileSync(pidFile, "utf8"));
  // One operation per worktree: a second setup or a removal waits.
  await assert.rejects(lifecycle.setup(target), (error) => error.details?.code === "WORKTREE_LIFECYCLE_BUSY");
  assert.equal(lifecycle.busy(repository), true);
  lifecycle.cancel(target);
  const cancelled = await settled(lifecycle, target, 15_000);
  assert.equal(cancelled.state.status, "cancelled");
  assert.equal(cancelled.state.stepIndex, 0);
  assert.throws(() => process.kill(descendant, 0), { code: "ESRCH" }, "a cancelled step's descendant kept running");
  assert.ok(events.some((event) => event.type === "worktree.lifecycle" && event.payload.status === "running"));
  assert.ok(!events.some((event) => event.type === "worktree.lifecycle" && event.payload.status === "ready"));
  assert.throws(() => lifecycle.cancel(target), (error) => error.details?.code === "WORKTREE_LIFECYCLE_IDLE");
}));

test("retained output is plain text and bounded however much a step prints", withLifecycle(async ({ repository, database, project, target, create, events }) => {
  writeConfig(repository, { setup: [{ name: "Noisy", command: node("for (let i = 0; i < 4000; i++) process.stdout.write('\\u001b[32mline ' + i + ' ' + 'x'.repeat(40) + '\\u001b[0m\\r\\n'); console.log('done');") }] });
  const lifecycle = create();
  database.trustLifecycleConfig(project.id, project.path, (await readLifecycleConfig(repository)).digest);
  await lifecycle.setup(target);
  const finished = await settled(lifecycle, target);
  assert.equal(finished.state.status, "ready");
  assert.ok(finished.state.output.length <= LIFECYCLE_LIMITS.outputCharacters);
  assert.equal(finished.state.outputTruncated, true);
  assert.ok(finished.state.outputEnd > 4000 * 40, "the stream position counts everything printed");
  assert.match(finished.state.output, /line 3999 x+\ndone\n/);
  assert.doesNotMatch(finished.state.output, /[\u001b\r]/);
  const outputs = events.filter((event) => event.type === "worktree.lifecycle.output");
  assert.ok(outputs.length > 0);
  assert.ok(outputs.every((event) => event.payload.text.length <= LIFECYCLE_LIMITS.outputEventCharacters));
  // A successful setup's output is not stored with its durable state.
  assert.equal(database.listWorktreeLifecycle()[0].output, undefined);
}));

test("a failed teardown keeps the worktree; a retry or an explicit skip removes it", { timeout: 30_000 }, withLifecycle(async ({ root, repository, database, project, create }) => {
  const allow = path.join(root, "allow-teardown");
  const teardownRuns = path.join(root, "teardown-runs");
  writeConfig(repository, { teardown: [
    { name: "Record", command: node("require('fs').appendFileSync(process.argv[1], 'r')", teardownRuns) },
    { name: "Stop services", command: node("if (!require('fs').existsSync(process.argv[1])) process.exit(5)", allow) },
  ] });
  git(repository, ["add", LIFECYCLE_CONFIG_FILE]);
  git(repository, ["commit", "-m", "lifecycle"]);
  let worktrees = [{ id: "main", path: repository, isLinked: false, changedCount: 0 }];
  const service = createGitService({ database, getProjects: () => [{ ...project, worktrees }], getConfig: async () => ({ scanRoots: [root] }) });
  const lifecycle = create();
  database.trustLifecycleConfig(project.id, project.path, (await readLifecycleConfig(repository)).digest);
  const removeTarget = async (name, options = {}) => {
    const created = await service.createWorktree({ projectId: project.id, branch: name, name });
    worktrees = [...worktrees, { id: name, path: created.path, isLinked: true, changedCount: 0 }];
    const target = { project, worktree: { id: name }, worktreePath: created.path };
    const remove = (prepare) => service.removeWorktree({ projectId: project.id, worktreePath: created.path, confirmation: created.path, prepare });
    return { target, path: created.path, attempt: (extra = {}) => lifecycle.removeWorktree(target, { remove, ...options, ...extra }) };
  };

  const kept = await removeTarget("kept");
  await assert.rejects(kept.attempt(), (error) => error.details?.code === "WORKTREE_TEARDOWN_FAILED" && /status 5/.test(error.message));
  assert.equal(existsSync(kept.path), true, "a failed teardown removed the worktree");
  const failed = await lifecycle.describe(kept.target);
  assert.deepEqual([failed.state.phase, failed.state.status, failed.state.stepIndex], ["teardown", "failed", 1]);
  writeFileSync(allow, "");
  await kept.attempt();
  assert.equal(existsSync(kept.path), false);
  assert.equal(readFileSync(teardownRuns, "utf8"), "r", "the retry resumed at the failed teardown step");
  assert.equal(database.listWorktreeLifecycle().some((state) => state.worktreePath === kept.path), false);

  rmSync(allow);
  const skipped = await removeTarget("skipped");
  await assert.rejects(skipped.attempt(), (error) => error.details?.code === "WORKTREE_TEARDOWN_FAILED");
  await skipped.attempt({ skipTeardown: true });
  assert.equal(existsSync(skipped.path), false);
  assert.ok(database.listAudit(20).some((entry) => entry.action === "worktree.lifecycle.teardown.skipped"));
}));

test("a run going when the runtime stopped is interrupted, not ready, and holds its worktree until its processes are proven gone", withLifecycle(async ({ repository, database, project, target, create }) => {
  writeConfig(repository, { setup: [{ name: "Wait", command: node("setInterval(() => {}, 1000)") }] });
  const lifecycle = create();
  database.trustLifecycleConfig(project.id, project.path, (await readLifecycleConfig(repository)).digest);
  await lifecycle.setup(target);
  await lifecycle.shutdown();
  const stopped = (await lifecycle.describe(target)).state;
  assert.deepEqual([stopped.status, stopped.outcomeUnknown], ["interrupted", false], "a proven shutdown is not unconfirmed");
  await assert.rejects(lifecycle.setup(target), (error) => error.statusCode === 503);
  // A crash leaves the durable state running; the next runtime reports it,
  // and the step's processes are unconfirmed until recovery proves them gone.
  database.saveWorktreeLifecycle({ ...stopped, status: "running", output: undefined, checkpoints: {} });
  let unknownOwners = 1;
  const released = [];
  const recovering = { capacity: () => ({ active: unknownOwners, limit: 4, unknown: unknownOwners }), reconcileUnknown: async () => 0,
    run: async () => { throw new Error("no step may run"); } };
  const successor = create({ subprocesses: recovering, onRelease: (worktreePath) => released.push(worktreePath) });
  const recovered = (await successor.describe(target)).state;
  assert.deepEqual([recovered.status, recovered.outcomeUnknown, recovered.checkpoints.setup?.stepIndex], ["interrupted", true, 0]);
  assert.match(recovered.error, /Outright stopped during step 1/);
  assert.equal(successor.hold(repository), "WORKTREE_LIFECYCLE_UNCONFIRMED", "agent work may start beside the crashed step's tree");
  await assert.rejects(successor.setup(target), (error) => error.details?.code === "LIFECYCLE_OUTCOME_UNKNOWN", "a retry ran without acknowledgement");
  released.length = 0;
  // Recovery that leaves the tree unproven keeps the hold.
  assert.equal(await successor.reconcile(), 0);
  assert.equal(successor.hold(repository), "WORKTREE_LIFECYCLE_UNCONFIRMED");
  assert.deepEqual(released, []);
  unknownOwners = 0;
  await successor.reconcile();
  assert.equal(successor.hold(repository), null);
  assert.deepEqual(released, [repository], "waiting agent runs were not woken");
  assert.equal((await successor.describe(target)).state.outcomeUnknown, false);
  assert.ok(database.listAudit(20).some((entry) => entry.action === "worktree.lifecycle.unconfirmed.proven"));
}));

test("setup and teardown are refused beside agent work, before any command runs, and release wakes waiting runs", withLifecycle(async ({ root, repository, database, project, target, create }) => {
  const marker = path.join(root, "ran");
  writeConfig(repository, { setup: [{ name: "Mark", command: node("require('fs').appendFileSync(process.argv[1], 's')", marker) }],
    teardown: [{ name: "Mark", command: node("require('fs').appendFileSync(process.argv[1], 't')", marker) }] });
  database.trustLifecycleConfig(project.id, project.path, (await readLifecycleConfig(repository)).digest);
  let agentRunning = true;
  let interrupted = null;
  const asked = [];
  const released = [];
  const lifecycle = create({ agentWork: (paths) => { asked.push(paths); return agentRunning; }, interruptedRun: () => interrupted,
    onRelease: (worktreePath) => released.push(worktreePath) });
  // The scan may report a path that is not canonical.
  const alias = path.join(root, "alias");
  symlinkSync(repository, alias, "junction");
  const discovered = { ...target, worktree: { id: "main", path: alias } };
  await assert.rejects(lifecycle.setup(discovered), (error) => error.details?.code === "WORKTREE_AGENT_ACTIVE");
  assert.deepEqual(asked.at(-1).sort(), [repository, discovered.worktree.path].sort(), "both the canonical and discovered paths were checked");
  let removed = false;
  await assert.rejects(lifecycle.removeWorktree(target, { remove: async (prepare) => { await prepare(); removed = true; } }),
    (error) => error.details?.code === "WORKTREE_AGENT_ACTIVE");
  assert.equal(removed, false);
  agentRunning = false;
  // An interrupted run whose processes the user has not resolved.
  interrupted = { id: "run-interrupted" };
  await assert.rejects(lifecycle.setup(discovered), (error) => error.details?.code === "RUN_RECOVERY_REQUIRED" && error.details.runId === "run-interrupted");
  await assert.rejects(lifecycle.removeWorktree(target, { remove: async (prepare) => { await prepare(); removed = true; } }),
    (error) => error.details?.code === "RUN_RECOVERY_REQUIRED");
  assert.equal(removed, false);
  interrupted = null;
  assert.equal(existsSync(marker), false, "a refused phase ran a command");
  assert.equal((await lifecycle.describe(target)).state, null, "a refusal beside agent work recorded a state");

  await lifecycle.setup(discovered);
  // Agent launches consult the hold by either path.
  assert.equal(lifecycle.busy(discovered.worktree.path), true);
  assert.equal((await settled(lifecycle, target)).state.status, "ready");
  assert.equal(lifecycle.busy(repository), false);
  assert.deepEqual(released, [repository], "the end of the hold was not reported");
}));

test("a refused retry keeps the resume checkpoint and the unconfirmed-processes acknowledgement", withLifecycle(async ({ repository, database, project, target, create }) => {
  const config = { setup: [{ name: "Install", command: ["install"] }, { name: "Migrate", command: ["migrate"] }, { name: "Seed", command: ["seed"] }] };
  writeConfig(repository, config);
  const original = readFileSync(path.join(repository, LIFECYCLE_CONFIG_FILE));
  const { digest } = await readLifecycleConfig(repository);
  database.trustLifecycleConfig(project.id, project.path, digest);
  const ran = [];
  let failMigrate = true;
  // The step's processes could not be confirmed stopped.
  const subprocesses = { capacity: () => ({ active: 0, limit: 4, unknown: 0 }), run: async (file) => {
    ran.push(file);
    if (file === "migrate" && failMigrate) throw Object.assign(new Error("ownership unknown"), { code: "SUBPROCESS_OWNERSHIP_UNKNOWN", cause: Object.assign(new Error("exit"), { code: 2 }) });
    return { stdout: "", stderr: "" };
  } };
  const released = [];
  const lifecycle = create({ subprocesses, onRelease: (worktreePath) => released.push(worktreePath) });
  await lifecycle.setup(target);
  const failed = (await settled(lifecycle, target)).state;
  assert.deepEqual([failed.status, failed.stepIndex, failed.outcomeUnknown], ["failed", 1, true]);
  // The run ended, but its processes did not provably: agent work stays held.
  assert.equal(lifecycle.busy(repository), false);
  assert.equal(lifecycle.hold(repository), "WORKTREE_LIFECYCLE_UNCONFIRMED");

  // Trust revoked, then an invalid edit: both refusals keep the checkpoint.
  database.untrustProject(project.id);
  await assert.rejects(lifecycle.setup(target), (error) => error.details?.code === "LIFECYCLE_TRUST_REQUIRED");
  writeFileSync(path.join(repository, LIFECYCLE_CONFIG_FILE), "{ not json");
  await assert.rejects(lifecycle.setup(target), (error) => error.details?.code === "LIFECYCLE_CONFIG_INVALID");
  const refused = (await create({ subprocesses }).describe(target)).state;
  assert.equal(refused.status, "invalid");
  assert.deepEqual([refused.checkpoints, refused.outcomeUnknown], [{ setup: { configDigest: digest, stepIndex: 1 } }, true], "the durable refusal lost the checkpoint");

  writeFileSync(path.join(repository, LIFECYCLE_CONFIG_FILE), original);
  database.trustLifecycleConfig(project.id, project.path, digest);
  const restarted = create({ subprocesses });
  await assert.rejects(restarted.setup(target), (error) => error.details?.code === "LIFECYCLE_OUTCOME_UNKNOWN", "the acknowledgement was skipped");
  failMigrate = false;
  ran.length = 0;
  await assert.rejects(restarted.setup(target, { acknowledgeUnconfirmed: "an-earlier-run" }), (error) => error.details?.code === "LIFECYCLE_ACKNOWLEDGEMENT_STALE");
  assert.equal(refused.runId, failed.runId, "the refusal lost the attempt to acknowledge");
  assert.equal((await restarted.setup(target, { acknowledgeUnconfirmed: failed.runId })).stepIndex, 1);
  // Admission past unconfirmed processes is audited like an explicit acknowledgement.
  assert.ok(database.listAudit(20).some((entry) => entry.action === "worktree.lifecycle.unconfirmed.acknowledged"
    && entry.details?.action === "setup" && entry.details.operationId === failed.runId), "the acknowledged retry left no audit");
  assert.equal((await settled(restarted, target)).state.status, "ready");
  assert.deepEqual(ran, ["migrate", "seed"], "the finished first step ran again");
  assert.equal(restarted.hold(repository), null);
}));

test("an explicit acknowledgement releases agent work held by unconfirmed processes, and keeps the checkpoint", withLifecycle(async ({ repository, database, project, target, create }) => {
  writeConfig(repository, { setup: [{ name: "Install", command: ["install"] }, { name: "Serve", command: ["serve"] }] });
  database.trustLifecycleConfig(project.id, project.path, (await readLifecycleConfig(repository)).digest);
  // The unknown owner stays charged, so recovery cannot prove it gone.
  const subprocesses = { capacity: () => ({ active: 1, limit: 4, unknown: 1 }), reconcileUnknown: async () => 0, run: async (file) => {
    if (file === "serve") throw Object.assign(new Error("ownership unknown"), { code: "SUBPROCESS_OWNERSHIP_UNKNOWN", cause: new Error("lost") });
    return { stdout: "", stderr: "" };
  } };
  const released = [];
  const lifecycle = create({ subprocesses, onRelease: (worktreePath) => released.push(worktreePath) });
  await lifecycle.setup(target);
  await settled(lifecycle, target);
  released.length = 0;
  await lifecycle.reconcile();
  assert.equal(lifecycle.hold(repository), "WORKTREE_LIFECYCLE_UNCONFIRMED");
  // The hold is durable.
  assert.equal(create({ subprocesses }).hold(repository), "WORKTREE_LIFECYCLE_UNCONFIRMED");
  const { runId } = (await lifecycle.describe(target)).state;
  assert.throws(() => lifecycle.acknowledge(target), (error) => error.details?.code === "LIFECYCLE_OUTCOME_UNKNOWN");
  assert.throws(() => lifecycle.acknowledge(target, "an-earlier-run"), (error) => error.details?.code === "LIFECYCLE_ACKNOWLEDGEMENT_STALE");
  assert.equal(lifecycle.hold(repository), "WORKTREE_LIFECYCLE_UNCONFIRMED", "a stale acknowledgement released the hold");
  const acknowledged = lifecycle.acknowledge(target, runId);
  assert.deepEqual([acknowledged.outcomeUnknown, acknowledged.status, acknowledged.checkpoints.setup.stepIndex], [false, "failed", 1]);
  assert.equal(lifecycle.hold(repository), null);
  assert.deepEqual(released, [repository]);
  assert.ok(database.listAudit(20).some((entry) => entry.action === "worktree.lifecycle.unconfirmed.acknowledged"));
  assert.equal(create({ subprocesses }).hold(repository), null, "the acknowledgement was not durable");
}));

test("each phase keeps its own checkpoint: a teardown attempt never resets setup progress", withLifecycle(async ({ repository, database, project, target, create }) => {
  writeConfig(repository, { setup: [{ name: "Install", command: ["install"] }, { name: "Migrate", command: ["migrate"] }],
    teardown: [{ name: "Stop", command: ["stop"] }] });
  database.trustLifecycleConfig(project.id, project.path, (await readLifecycleConfig(repository)).digest);
  const ran = [];
  const failing = new Set(["migrate", "stop"]);
  const subprocesses = { capacity: () => ({ active: 0, limit: 4, unknown: 0 }), run: async (file) => {
    ran.push(file);
    if (failing.has(file)) throw Object.assign(new Error("exit"), { code: 1 });
    return { stdout: "", stderr: "" };
  } };
  const lifecycle = create({ subprocesses });
  await lifecycle.setup(target);
  assert.deepEqual([(await settled(lifecycle, target)).state.stepIndex, ran], [1, ["install", "migrate"]]);
  let removed = false;
  await assert.rejects(lifecycle.removeWorktree(target, { remove: async (prepare) => { await prepare(); removed = true; } }),
    (error) => error.details?.code === "WORKTREE_TEARDOWN_FAILED");
  assert.equal(removed, false);
  failing.clear();
  ran.length = 0;
  assert.equal((await create({ subprocesses }).describe(target)).state.checkpoints.setup.stepIndex, 1, "teardown erased the setup checkpoint");
  assert.equal((await lifecycle.setup(target)).stepIndex, 1);
  assert.equal((await settled(lifecycle, target)).state.status, "ready");
  assert.deepEqual(ran, ["migrate"], "setup did not resume at its failed step after a teardown attempt");
}));

test("a worktree created again at the same path starts setup at step 1, never at the old checkpoint", { timeout: 30_000 }, withLifecycle(async ({ root, repository, database, project, create }) => {
  const counter = path.join(root, "first-step-runs");
  const allow = path.join(root, "allow-second");
  writeConfig(repository, { setup: [
    { name: "Count", command: node("require('fs').appendFileSync(process.argv[1], 'a')", counter) },
    { name: "Gate", command: node("process.exit(require('fs').existsSync(process.argv[1]) ? 0 : 3)", allow) },
  ] });
  git(repository, ["add", LIFECYCLE_CONFIG_FILE]);
  git(repository, ["commit", "-m", "lifecycle"]);
  database.trustLifecycleConfig(project.id, project.path, (await readLifecycleConfig(repository)).digest);
  const worktreePath = path.join(root, "feature");
  git(repository, ["worktree", "add", "-b", "feature", worktreePath]);
  const target = { project, worktree: { id: "feature", path: worktreePath }, worktreePath };
  const lifecycle = create();
  await lifecycle.setup(target);
  assert.deepEqual([(await settled(lifecycle, target)).state.status, readFileSync(counter, "utf8")], ["failed", "a"]);

  // Removed outside Outright and created again at the same path.
  git(repository, ["worktree", "remove", "--force", worktreePath]);
  git(repository, ["worktree", "add", worktreePath, "feature"]);
  const restarted = create();
  assert.equal((await restarted.describe(target)).state, null, "the earlier worktree's failure was shown for the new one");
  writeFileSync(allow, "");
  assert.equal((await restarted.setup(target)).stepIndex, 0);
  assert.equal((await settled(restarted, target)).state.status, "ready");
  assert.equal(readFileSync(counter, "utf8"), "aa", "setup of the new worktree skipped its first step");

  // A worktree Outright just created never inherits a state at its path.
  rmSync(allow);
  await restarted.setup(target);
  await settled(restarted, target);
  assert.equal((await restarted.setup(target, { created: true })).stepIndex, 0);
}));

test("long steps use the lifecycle budget, report it truthfully when full, and leave utility capacity free", { timeout: 30_000 }, withLifecycle(async ({ root, repository, database, project, target, subprocesses, create }) => {
  const second = path.join(root, "second");
  mkdirSync(second);
  const gate = path.join(root, "gate");
  const config = { setup: [{ name: "Wait", command: node("const t = setInterval(() => { if (require('fs').existsSync(process.argv[1])) clearInterval(t); }, 20)", gate) }] };
  writeConfig(repository, config);
  writeConfig(second, config);
  database.trustLifecycleConfig(project.id, project.path, (await readLifecycleConfig(repository)).digest);
  const lifecycleBudget = createSubprocessBudget({ limit: 1 });
  const lifecycle = create({ subprocesses: lifecycleBudget });
  const other = { project, worktree: { id: "second", path: second }, worktreePath: second };
  await lifecycle.setup(target);
  await waitFor(() => lifecycleBudget.capacity().active === 1, 10_000, "the first step did not start");
  await lifecycle.setup(other);
  const full = (await settled(lifecycle, other)).state;
  assert.equal(full.status, "failed");
  assert.match(full.error, /Setup and teardown capacity is full \(1 of 1 steps running or unconfirmed\)/);
  // Git, scans and removal keep their own budget while setup runs.
  const { stdout } = await subprocesses.run("git", ["-C", repository, "rev-parse", "--is-inside-work-tree"]);
  assert.equal(stdout.toString().trim(), "true");
  writeFileSync(gate, "");
  assert.equal((await settled(lifecycle, target)).state.status, "ready");
}));

test("a step that runs past its timeout fails as timed out and keeps its output", { timeout: 30_000 }, withLifecycle(async ({ repository, database, project, target, create }) => {
  writeConfig(repository, { setup: [{ name: "Hang", timeoutSeconds: 1, command: node("console.log('starting'); setInterval(() => {}, 1000)") }] });
  database.trustLifecycleConfig(project.id, project.path, (await readLifecycleConfig(repository)).digest);
  const lifecycle = create();
  await lifecycle.setup(target);
  const timedOut = (await settled(lifecycle, target, 15_000)).state;
  assert.deepEqual([timedOut.status, timedOut.stepIndex], ["failed", 0]);
  assert.match(timedOut.error, /"Hang" timed out after 1 seconds/);
  assert.match(timedOut.output, /starting/);
}));

test("teardown refuses an untrusted or invalid configuration and resumes at removal after Git kept the worktree", { timeout: 30_000 }, withLifecycle(async ({ root, repository, database, project, create }) => {
  const teardownRuns = path.join(root, "teardown-runs");
  writeConfig(repository, { teardown: [{ name: "Record", command: node("const fs = require('fs'); fs.appendFileSync(process.argv[1], 'r'); fs.writeFileSync('leftover', '')", teardownRuns) }] });
  git(repository, ["add", LIFECYCLE_CONFIG_FILE]);
  git(repository, ["commit", "-m", "lifecycle"]);
  const worktreePath = path.join(root, "feature");
  git(repository, ["worktree", "add", "-b", "feature", worktreePath]);
  const worktrees = [{ id: "main", path: repository, isLinked: false, changedCount: 0 }, { id: "feature", path: worktreePath, isLinked: true, changedCount: 0 }];
  const service = createGitService({ database, getProjects: () => [{ ...project, worktrees }], getConfig: async () => ({ scanRoots: [root] }) });
  const target = { project, worktree: { id: "feature", path: worktreePath }, worktreePath };
  const remove = (prepare) => service.removeWorktree({ projectId: project.id, worktreePath, confirmation: worktreePath, prepare });
  const lifecycle = create();

  await assert.rejects(lifecycle.removeWorktree(target, { remove }), (error) => error.details?.code === "LIFECYCLE_TRUST_REQUIRED");
  const configFile = path.join(worktreePath, LIFECYCLE_CONFIG_FILE);
  const trusted = readFileSync(configFile);
  writeFileSync(configFile, "{ not json");
  await assert.rejects(lifecycle.removeWorktree(target, { remove }), (error) => error.details?.code === "LIFECYCLE_CONFIG_INVALID");
  assert.equal(existsSync(worktreePath), true);
  assert.equal(existsSync(teardownRuns), false, "an untrusted or invalid teardown ran");

  writeFileSync(configFile, trusted);
  database.trustLifecycleConfig(project.id, project.path, (await readLifecycleConfig(worktreePath)).digest);
  // Teardown leaves an untracked file, so Git refuses to remove the worktree.
  await assert.rejects(lifecycle.removeWorktree(target, { remove }));
  assert.equal(existsSync(worktreePath), true);
  const kept = (await lifecycle.describe(target)).state;
  assert.deepEqual([kept.phase, kept.status, kept.stepIndex], ["teardown", "failed", 1]);
  assert.match(kept.error, /Teardown finished, but the worktree could not be removed/);
  rmSync(path.join(worktreePath, "leftover"));
  await lifecycle.removeWorktree(target, { remove });
  assert.equal(existsSync(worktreePath), false);
  assert.equal(readFileSync(teardownRuns, "utf8"), "r", "the retry ran the finished teardown again");
}));

test("a teardown that finished before a crash is not run again: the next removal only removes", { timeout: 30_000 }, withLifecycle(async ({ root, repository, database, project, create }) => {
  const teardownRuns = path.join(root, "teardown-runs");
  writeConfig(repository, { teardown: [{ name: "Record", command: node("require('fs').appendFileSync(process.argv[1], 'r')", teardownRuns) }] });
  git(repository, ["add", LIFECYCLE_CONFIG_FILE]);
  git(repository, ["commit", "-m", "lifecycle"]);
  database.trustLifecycleConfig(project.id, project.path, (await readLifecycleConfig(repository)).digest);
  const worktreePath = path.join(root, "feature");
  git(repository, ["worktree", "add", "-b", "feature", worktreePath]);
  const worktrees = [{ id: "main", path: repository, isLinked: false, changedCount: 0 }, { id: "feature", path: worktreePath, isLinked: true, changedCount: 0 }];
  const service = createGitService({ database, getProjects: () => [{ ...project, worktrees }], getConfig: async () => ({ scanRoots: [root] }) });
  const target = { project, worktree: { id: "feature", path: worktreePath }, worktreePath };

  // The runtime stops after teardown commits its outcome, before Git runs.
  let durable;
  const crashed = create();
  await assert.rejects(crashed.removeWorktree(target, { remove: async (prepare) => {
    await prepare();
    durable = database.listWorktreeLifecycle().find((state) => state.worktreePath === worktreePath);
    throw new Error("runtime stopped");
  } }));
  assert.equal(durable.status, "complete");
  database.saveWorktreeLifecycle(durable);
  assert.equal(readFileSync(teardownRuns, "utf8"), "r");

  const restarted = create();
  await restarted.removeWorktree(target, { remove: (prepare) => service.removeWorktree({ projectId: project.id, worktreePath, confirmation: worktreePath, prepare }) });
  assert.equal(existsSync(worktreePath), false);
  assert.equal(readFileSync(teardownRuns, "utf8"), "r", "teardown ran again after a restart");
}));

test("every removal refuses beside unconfirmed processes until that attempt is acknowledged, whatever the configuration", { timeout: 30_000 }, withLifecycle(async ({ root, repository, database, project, create }) => {
  // Setup only: no teardown steps would run before removal.
  writeConfig(repository, { setup: [{ name: "Serve", command: ["serve"] }] });
  git(repository, ["add", LIFECYCLE_CONFIG_FILE]);
  git(repository, ["commit", "-m", "lifecycle"]);
  database.trustLifecycleConfig(project.id, project.path, (await readLifecycleConfig(repository)).digest);
  let worktrees = [{ id: "main", path: repository, isLinked: false, changedCount: 0 }];
  const service = createGitService({ database, getProjects: () => [{ ...project, worktrees }], getConfig: async () => ({ scanRoots: [root] }) });
  const subprocesses = { capacity: () => ({ active: 1, limit: 4, unknown: 1 }), reconcileUnknown: async () => 0,
    run: async () => { throw Object.assign(new Error("ownership unknown"), { code: "SUBPROCESS_OWNERSHIP_UNKNOWN", cause: new Error("lost") }); } };
  const lifecycle = create({ subprocesses });
  const unconfirmedWorktree = async (name, edit = () => {}) => {
    const created = await service.createWorktree({ projectId: project.id, branch: name, name });
    worktrees = [...worktrees, { id: name, path: created.path, isLinked: true, changedCount: 0 }];
    const target = { project, worktree: { id: name, path: created.path }, worktreePath: created.path };
    await lifecycle.setup(target);
    const { state } = await settled(lifecycle, target);
    assert.equal(state.outcomeUnknown, true);
    edit(created.path);
    const remove = (prepare) => service.removeWorktree({ projectId: project.id, worktreePath: created.path, confirmation: created.path, prepare });
    return { target, path: created.path, runId: state.runId, attempt: (options = {}) => lifecycle.removeWorktree(target, { remove, ...options }) };
  };

  for (const [name, edit] of [["setup-only", () => {}], ["missing", (worktreePath) => { git(worktreePath, ["rm", "-q", "--", LIFECYCLE_CONFIG_FILE]); git(worktreePath, ["commit", "-qm", "no lifecycle"]); }]]) {
    const worktree = await unconfirmedWorktree(name, edit);
    await assert.rejects(worktree.attempt(), (error) => error.details?.code === "LIFECYCLE_OUTCOME_UNKNOWN"
      && error.details.runId === worktree.runId && error.details.teardown === false, `${name}: removal went ahead beside unconfirmed processes`);
    await assert.rejects(worktree.attempt({ acknowledgeUnconfirmed: "an-earlier-run" }), (error) => error.details?.code === "LIFECYCLE_ACKNOWLEDGEMENT_STALE");
    assert.equal(existsSync(worktree.path), true, `${name}: a refused removal removed the worktree`);
    assert.equal(lifecycle.hold(worktree.path), "WORKTREE_LIFECYCLE_UNCONFIRMED", `${name}: a refused removal dropped the hold`);
    assert.ok(database.listWorktreeLifecycle().some((state) => state.worktreePath === worktree.path && state.outcomeUnknown), `${name}: the durable hold was lost`);
    await worktree.attempt({ acknowledgeUnconfirmed: worktree.runId });
    assert.equal(existsSync(worktree.path), false);
    assert.ok(database.listAudit(40).some((entry) => entry.action === "worktree.lifecycle.unconfirmed.acknowledged"
      && entry.details?.action === "removal" && entry.details.operationId === worktree.runId), `${name}: the acknowledged removal was not audited`);
  }
  // Skipping teardown is the same decision.
  const skipped = await unconfirmedWorktree("skipped");
  await assert.rejects(skipped.attempt({ skipTeardown: true }), (error) => error.details?.code === "LIFECYCLE_OUTCOME_UNKNOWN");
  assert.equal(existsSync(skipped.path), true);
  await skipped.attempt({ skipTeardown: true, acknowledgeUnconfirmed: skipped.runId });
  assert.equal(existsSync(skipped.path), false);
}));

test("a step starts only after earlier progress is saved, and an unsaved outcome is never ready", { timeout: 30_000 }, withLifecycle(async ({ repository, database, project, target, create }) => {
  writeConfig(repository, { setup: [{ name: "Install", command: ["install"] }, { name: "Migrate", command: ["migrate"] }] });
  database.trustLifecycleConfig(project.id, project.path, (await readLifecycleConfig(repository)).digest);
  const ran = [];
  const subprocesses = { capacity: () => ({ active: 0, limit: 4, unknown: 0 }), run: async (file) => { ran.push(file); return { stdout: "", stderr: "" }; } };
  // The save recording that step 1 finished fails once, as while the
  // database is briefly unavailable.
  const save = database.saveWorktreeLifecycle;
  let failed = false;
  database.saveWorktreeLifecycle = (state) => {
    if (!failed && state.status === "running" && ran.includes("install")) {
      failed = true;
      throw new Error("database unavailable");
    }
    return save.call(database, state);
  };
  const errors = [];
  const limits = { ...LIFECYCLE_LIMITS, persistRetryDelaysMs: [0, 0] };
  const lifecycle = create({ subprocesses, limits, onPersistError: (error) => errors.push(error) });
  try {
    await lifecycle.setup(target);
    const stopped = (await settled(lifecycle, target)).state;
    assert.deepEqual(ran, ["install"], "step 2 started before step 1's checkpoint was saved");
    assert.deepEqual([stopped.status, stopped.stepIndex, stopped.checkpoints.setup?.stepIndex], ["failed", 1, 1]);
    assert.match(stopped.error, /could not save progress before "Migrate"/);
    // The stop is durable: a successor runtime resumes at step 2.
    database.saveWorktreeLifecycle = save;
    ran.length = 0;
    const successor = create({ subprocesses, limits, onPersistError: (error) => errors.push(error) });
    assert.equal((await successor.setup(target)).stepIndex, 1);
    assert.equal((await settled(successor, target)).state.status, "ready");
    assert.deepEqual(ran, ["migrate"], "the finished first step ran again");

    // Every step finished, but the outcome cannot be saved: failed, not ready.
    database.saveWorktreeLifecycle = (state) => {
      if (state.status !== "running") throw new Error("database unavailable");
      return save.call(database, state);
    };
    ran.length = 0;
    await successor.setup(target);
    const unsaved = (await settled(successor, target)).state;
    assert.deepEqual(ran, ["install", "migrate"]);
    assert.deepEqual([unsaved.status, unsaved.unsaved, unsaved.checkpoints.setup?.stepIndex], ["failed", true, 2]);
    assert.match(unsaved.error, /setup finished, but Outright could not save that outcome/);
    assert.notEqual(database.listWorktreeLifecycle().find((state) => state.worktreePath === repository).status, "ready");
    // A retry records the outcome without running a step again.
    database.saveWorktreeLifecycle = save;
    ran.length = 0;
    await successor.setup(target);
    assert.equal((await settled(successor, target)).state.status, "ready");
    assert.deepEqual(ran, []);
    assert.equal(database.listWorktreeLifecycle().find((state) => state.worktreePath === repository).status, "ready");
  } finally { database.saveWorktreeLifecycle = save; }
}));

test("a timeout stays the reason when the timed-out step's processes cannot be confirmed stopped", withLifecycle(async ({ repository, database, project, target, create }) => {
  writeConfig(repository, { setup: [{ name: "Hang", command: ["hang"], timeoutSeconds: 1 }] });
  database.trustLifecycleConfig(project.id, project.path, (await readLifecycleConfig(repository)).digest);
  const timeout = Object.assign(new Error("Utility process timed out after 1000ms"), { killed: true, signal: "SIGTERM" });
  const unsettled = Object.assign(new Error("Utility owner did not settle after stop", { cause: timeout }), { code: "SUBPROCESS_OWNERSHIP_UNKNOWN" });
  const subprocesses = { capacity: () => ({ active: 1, limit: 4, unknown: 1 }), run: async () => {
    throw Object.assign(new Error("Utility descendant ownership is unknown", { cause: unsettled }), { code: "SUBPROCESS_OWNERSHIP_UNKNOWN" });
  } };
  const lifecycle = create({ subprocesses });
  await lifecycle.setup(target);
  const { state } = await settled(lifecycle, target);
  assert.deepEqual([state.status, state.outcomeUnknown], ["failed", true]);
  assert.match(state.error, /"Hang" timed out after 1 seconds\. Its processes could not be confirmed stopped/);
}));

test("archive maintenance, which closes the database, waits while setup or teardown is running", { timeout: 30_000 }, withLifecycle(async ({ repository, database, project }) => {
  const archived = database.createConversation({ projectId: project.id, worktreeId: "main", worktreePath: repository, title: "Archived", provider: "codex" });
  database.addMessage({ conversationId: archived.id, role: "assistant", body: `large ${"x".repeat(300 * 1024)}` });
  for (let index = 0; index < 300; index += 1) database.addMessage({ conversationId: archived.id, role: "assistant", body: `filler ${index}` });
  database.updateConversation(archived.id, { archived: true });
  const state = { worktreePath: repository, projectId: project.id, phase: "setup", status: "running", stepIndex: 0, steps: ["Install"], updatedAt: new Date().toISOString() };
  database.saveWorktreeLifecycle(state);
  const deferred = await database.deleteArchivedConversation(archived.id, archived.id);
  assert.equal(deferred.deferred, true, "maintenance went offline during a running step");
  assert.equal(database.maintenanceActive, false);
  database.saveWorktreeLifecycle({ ...state, status: "ready" });
  const deletion = await database.deleteArchivedConversation(archived.id, archived.id);
  assert.notEqual(deletion.deferred, true, "maintenance stayed deferred after the step finished");
}));

test("a running step's state survives retention however many newer states are saved, so maintenance waits and a crash is still held", { timeout: 30_000 }, withLifecycle(async ({ repository, database, project, target, create }) => {
  writeConfig(repository, { setup: [{ name: "Wait", command: node("setInterval(() => {}, 1000)") }] });
  const lifecycle = create();
  database.trustLifecycleConfig(project.id, project.path, (await readLifecycleConfig(repository)).digest);
  await lifecycle.setup(target);
  const running = database.listWorktreeLifecycle().find((state) => state.worktreePath === repository);
  assert.equal(running?.status, "running");
  // Other worktrees' states written during one long step, at the retention edge.
  const newer = Date.parse(running.updatedAt);
  for (let index = 1; index <= 512; index += 1) {
    database.saveWorktreeLifecycle({ worktreePath: `/elsewhere/${index}`, projectId: project.id, phase: "setup", status: "needs-trust",
      stepIndex: 0, steps: ["Install"], updatedAt: new Date(newer + index * 1000).toISOString() });
  }
  const kept = database.listWorktreeLifecycle();
  assert.equal(kept.length, 513);
  assert.equal(kept.find((state) => state.worktreePath === repository)?.status, "running", "retention deleted a live run's state");
  database.saveWorktreeLifecycle({ worktreePath: "/elsewhere/513", projectId: project.id, phase: "setup", status: "needs-trust",
    stepIndex: 0, steps: ["Install"], updatedAt: new Date(newer + 513 * 1000).toISOString() });
  assert.equal(database.listWorktreeLifecycle().some((state) => state.worktreePath === "/elsewhere/1"), false, "settled states are still bounded");

  const archived = database.createConversation({ projectId: project.id, worktreeId: "main", worktreePath: repository, title: "Archived", provider: "codex" });
  database.addMessage({ conversationId: archived.id, role: "assistant", body: `large ${"x".repeat(300 * 1024)}` });
  for (let index = 0; index < 300; index += 1) database.addMessage({ conversationId: archived.id, role: "assistant", body: `filler ${index}` });
  database.updateConversation(archived.id, { archived: true });
  assert.equal((await database.deleteArchivedConversation(archived.id, archived.id)).deferred, true, "maintenance went offline during a running step");

  // A runtime that starts after a crash still finds the step and holds the worktree.
  const recovering = { capacity: () => ({ active: 1, limit: 4, unknown: 1 }), reconcileUnknown: async () => 0,
    run: async () => { throw new Error("no step may run"); } };
  const successor = create({ subprocesses: recovering });
  const recovered = (await successor.describe(target)).state;
  assert.deepEqual([recovered?.status, recovered?.outcomeUnknown], ["interrupted", true]);
  assert.equal(successor.hold(repository), "WORKTREE_LIFECYCLE_UNCONFIRMED");
  // The unconfirmed state is pinned in turn.
  database.saveWorktreeLifecycle({ worktreePath: "/elsewhere/514", projectId: project.id, phase: "setup", status: "needs-trust",
    stepIndex: 0, steps: ["Install"], updatedAt: new Date(newer + 514 * 1000).toISOString() });
  assert.equal(database.listWorktreeLifecycle().find((state) => state.worktreePath === repository)?.outcomeUnknown, true);
}));

test("status surfaces see the newest state of the worktree now at each path: revisions grow, trust settles a review refusal, and an earlier worktree's state is not listed", withLifecycle(async ({ repository, database, project, target, create, events }) => {
  writeConfig(repository, { setup: [{ name: "Fail", command: node("process.exit(4)") }] });
  let instance = "first";
  const identify = async () => instance;
  const exits = { capacity: () => ({ active: 0, limit: 4, unknown: 0 }), run: async () => { throw Object.assign(new Error("exited"), { code: 4 }); } };
  const lifecycle = create({ identify, subprocesses: exits });
  const published = () => events.filter((event) => event.type === "worktree.lifecycle").map((event) => event.payload);
  // A refusal for review is listed, and trusting the file settles it,
  // keeping its run id, so no status surface still asks for review.
  const waiting = await lifecycle.setup(target, { automatic: true });
  assert.equal(waiting.status, "needs-trust");
  let listed = await lifecycle.list();
  assert.deepEqual(listed.states.map((state) => state.status), ["needs-trust"]);
  assert.ok(listed.revision >= waiting.revision);
  await lifecycle.trust(target, (await readLifecycleConfig(repository)).digest);
  const trusted = published().at(-1);
  assert.deepEqual([trusted.status, trusted.runId, trusted.revision > waiting.revision], ["trusted", waiting.runId, true]);
  listed = await lifecycle.list();
  assert.deepEqual(listed.states.map((state) => state.status), ["trusted"]);
  assert.ok(listed.revision >= trusted.revision);

  await lifecycle.setup(target);
  assert.equal((await settled(lifecycle, target)).state.status, "failed");
  const revisions = published().map((state) => state.revision);
  assert.deepEqual(revisions, [...revisions].sort((a, b) => a - b), "revisions did not grow with each state");
  assert.equal(new Set(revisions).size, revisions.length);
  assert.deepEqual((await lifecycle.list()).states.map((state) => state.status), ["failed"]);
  // A worktree created again at the path, outside Outright, has no setup
  // state yet: the list agrees with describe().
  instance = "second";
  assert.equal((await lifecycle.describe(target)).state, null);
  assert.deepEqual((await lifecycle.list()).states, []);

  // Unconfirmed processes belong to the path, whatever worktree is there.
  instance = "first";
  const failed = (await lifecycle.describe(target)).state;
  database.saveWorktreeLifecycle({ ...failed, status: "running", output: undefined });
  const successor = create({ identify, subprocesses: { capacity: () => ({ active: 1, limit: 4, unknown: 1 }), run: async () => { throw new Error("no step may run"); } } });
  instance = "second";
  const recovered = await successor.list();
  assert.deepEqual(recovered.states.map((state) => [state.status, state.outcomeUnknown]), [["interrupted", true]]);
  assert.ok(recovered.states[0].revision > Math.max(...revisions), "a restarted runtime's revisions went back");
  // A removal is published with its own, newer revision.
  instance = "first";
  rmSync(path.join(repository, LIFECYCLE_CONFIG_FILE));
  await lifecycle.setup(target);
  const removal = published().at(-1);
  assert.deepEqual([removal.removed, removal.revision > Math.max(...revisions)], [true, true]);
}));

// Steps that record where they ran, against configurations and worktree
// identities the test controls, so retention runs at its real bound fast.
function scriptedLifecycle(create, database, project, { fail = () => null, digest = "sha256:trusted", ...options } = {}) {
  const ran = [];
  const alive = new Map();
  const config = (worktreePath) => (worktreePath.startsWith("/other/")
    ? { digest: "sha256:unreviewed", version: 1, setup: [{ name: "Install", command: ["install"], timeoutSeconds: 1 }], teardown: [] }
    : { digest, version: 1, teardown: [{ name: "Down", command: ["down"], timeoutSeconds: 1 }],
      setup: ["one", "two", "three"].map((name) => ({ name, command: [name], timeoutSeconds: 1 })) });
  const subprocesses = { capacity: () => ({ active: 0, limit: 4, unknown: 0 }),
    run: async (command, _args, { cwd }) => {
      ran.push(`${cwd}:${command}`);
      const error = fail(cwd, command);
      if (error) throw error;
    } };
  let clock = Date.parse("2026-01-01T00:00:00Z");
  const now = () => new Date(clock += 1000).toISOString();
  const target = (worktreePath) => ({ project, worktree: { id: worktreePath, path: worktreePath }, worktreePath });
  const start = (extra = {}) => create({ subprocesses, readConfig: async (worktreePath) => config(worktreePath),
    identify: async (worktreePath) => (alive.has(worktreePath) ? alive.get(worktreePath) : `live:${worktreePath}`), now, ...options, ...extra });
  database.trustLifecycleConfig(project.id, project.path, digest);
  return { ran, alive, target, start };
}

test("retention never loses a checkpoint, an outcome to act on or a teardown awaiting removal while its worktree exists, and stays bounded", { timeout: 60_000 }, withLifecycle(async ({ database, project, create }) => {
  let failSecond = true;
  const { ran, target, start } = scriptedLifecycle(create, database, project, {
    fail: (cwd, command) => (cwd === "/w/a" && command === "two" && failSecond ? Object.assign(new Error("exited"), { code: 2 }) : null) });
  const lifecycle = start();
  const [a, b] = [target("/w/a"), target("/w/b")];
  await lifecycle.setup(a);
  assert.deepEqual([(await settled(lifecycle, a)).state.status, (await lifecycle.describe(a)).state.stepIndex], ["failed", 1]);
  // Teardown finishes, then Git keeps the worktree.
  await assert.rejects(lifecycle.removeWorktree(b, { remove: async (prepareRemoval) => { await prepareRemoval(); throw new Error("git kept it"); } }), /git kept it/);
  const awaiting = (await lifecycle.describe(b)).state;
  assert.deepEqual([awaiting.phase, awaiting.status, awaiting.checkpoints.teardown.stepIndex], ["teardown", "failed", 1]);
  // Settled states of other worktrees fill memory and the database to the bound.
  for (let index = 1; index <= LIFECYCLE_LIMITS.states; index += 1) await lifecycle.setup(target(`/other/${index}`), { automatic: true });
  for (const [worktree, status] of [[a, "failed"], [b, "failed"]]) assert.equal((await lifecycle.describe(worktree)).state?.status, status, "memory evicted a state its worktree depends on");
  const listed = (await lifecycle.list()).states.map((state) => state.worktreePath);
  assert.ok(listed.includes("/w/a") && listed.includes("/w/b"), "status surfaces lost a failure");
  const durable = database.listWorktreeLifecycle().map((state) => state.worktreePath);
  assert.ok(durable.includes("/w/a") && durable.includes("/w/b"), "the database pruned a state its worktree depends on");

  // After a restart at the bound, the next state evicts the oldest settled
  // state, never the newest, and each retry resumes at its checkpoint.
  await lifecycle.shutdown();
  const successor = start();
  await successor.setup(target("/other/next"), { automatic: true });
  const kept = (await successor.list()).states.map((state) => state.worktreePath);
  assert.ok(kept.includes(`/other/${LIFECYCLE_LIMITS.states}`) && kept.includes("/other/next"), "a restart evicted the newest states first");
  assert.equal(kept.includes("/other/1"), false, "the oldest settled state was not the one evicted");
  failSecond = false;
  assert.equal((await successor.setup(a)).stepIndex, 1, "the retry did not resume at the failed step");
  assert.equal((await settled(successor, a)).state.status, "ready");
  assert.deepEqual(ran.filter((entry) => entry.startsWith("/w/a:")), ["/w/a:one", "/w/a:two", "/w/a:two", "/w/a:three"]);
  let removed = false;
  await successor.removeWorktree(b, { remove: async (prepareRemoval) => { await prepareRemoval(); removed = true; } });
  assert.equal(removed, true);
  assert.deepEqual(ran.filter((entry) => entry.startsWith("/w/b:")), ["/w/b:down"], "a finished teardown ran again");
}));

test("kept states of worktrees that no longer exist are forgotten once they pass the bound, but unconfirmed processes stay held", { timeout: 30_000 }, withLifecycle(async ({ database, project, create }) => {
  const { alive, target, start } = scriptedLifecycle(create, database, project, {
    fail: (cwd) => (cwd === "/w/unconfirmed" ? Object.assign(new Error("not confirmed"), { code: "SUBPROCESS_OWNERSHIP_UNKNOWN" })
      : Object.assign(new Error("exited"), { code: 1 })) });
  const lifecycle = start({ limits: { ...LIFECYCLE_LIMITS, states: 4 } });
  const paths = ["/w/live", "/w/unconfirmed", "/w/gone/1", "/w/gone/2", "/w/gone/3", "/w/replaced"];
  for (const worktreePath of paths) {
    await lifecycle.setup(target(worktreePath));
    await settled(lifecycle, target(worktreePath));
    if (worktreePath === "/w/unconfirmed") alive.set(worktreePath, null);
  }
  // Six kept states over a bound of four: none are dropped while their worktrees exist.
  assert.deepEqual((await lifecycle.list()).states.map((state) => state.worktreePath).sort(), [...paths].sort());
  for (const worktreePath of paths.slice(2)) alive.set(worktreePath, worktreePath === "/w/replaced" ? "another" : null);
  await lifecycle.setup(target("/other/1"), { automatic: true });
  await waitFor(() => database.listWorktreeLifecycle().length === 3, 5000, "states of vanished worktrees were not forgotten");
  assert.deepEqual(database.listWorktreeLifecycle().map((state) => state.worktreePath).sort(), ["/other/1", "/w/live", "/w/unconfirmed"]);
  assert.equal(lifecycle.hold("/w/unconfirmed"), "WORKTREE_LIFECYCLE_UNCONFIRMED");
  assert.equal((await lifecycle.describe(target("/w/live"))).state.status, "failed");
}));

test("trusting a configuration from one worktree leaves a sibling's unrun setup visible, not ready", withLifecycle(async ({ database, project, create, events }) => {
  const { ran, target, start } = scriptedLifecycle(create, database, project, { digest: "sha256:reviewed" });
  database.untrustProject(project.id);
  const lifecycle = start();
  const [a, c] = [target("/w/a"), target("/w/c")];
  for (const worktree of [a, c]) assert.equal((await lifecycle.setup(worktree, { automatic: true })).status, "needs-trust");
  await lifecycle.trust(a, "sha256:reviewed");
  const sibling = events.filter((event) => event.type === "worktree.lifecycle" && event.payload.worktreePath === "/w/c").at(-1).payload;
  assert.equal(sibling.status, "trusted");
  const summary = lifecycleSummary(sibling);
  assert.deepEqual([summary.quiet, summary.tone, summary.short], [undefined, "trust", "Run setup"], "a sibling whose setup never ran looked ready");
  assert.deepEqual(ran, [], "trust ran nothing");
}));
