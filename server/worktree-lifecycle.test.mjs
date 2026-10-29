import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOutrightDatabase } from "./database.mjs";
import { createGitService } from "./git-service.mjs";
import { createSubprocessBudget } from "./subprocess-budget.mjs";
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
    const create = () => {
      const lifecycle = createWorktreeLifecycle({ database, subprocesses, publish: (event) => events.push(event),
        onPersistError: (error) => { throw error; } });
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

test("a run going when the runtime stopped is interrupted, not ready, after restart", withLifecycle(async ({ repository, database, project, target, create }) => {
  writeConfig(repository, { setup: [{ name: "Wait", command: node("setInterval(() => {}, 1000)") }] });
  const lifecycle = create();
  database.trustLifecycleConfig(project.id, project.path, (await readLifecycleConfig(repository)).digest);
  await lifecycle.setup(target);
  await lifecycle.shutdown();
  assert.equal((await lifecycle.describe(target)).state.status, "interrupted");
  await assert.rejects(lifecycle.setup(target), (error) => error.statusCode === 503);
  // A crash leaves the durable state running; the next runtime reports it.
  database.saveWorktreeLifecycle({ ...(await lifecycle.describe(target)).state, status: "running", output: undefined });
  const successor = create();
  const recovered = await successor.describe(target);
  assert.equal(recovered.state.status, "interrupted");
  assert.match(recovered.state.error, /Outright stopped during step 1/);
}));
