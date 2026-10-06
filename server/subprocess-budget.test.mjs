import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSubprocessBudget, runOwned } from "./subprocess-budget.mjs";
import { createGitService } from "./git-service.mjs";
import { scanProjects } from "./project-scanner.mjs";
import { AGENT_SUPERVISOR } from "./agent-manager.mjs";

function cleanupDescendant(root, pidFile) {
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, "utf8"));
    if (Number.isSafeInteger(pid) && pid > 0) try { process.kill(pid, "SIGKILL"); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  rmSync(root, { recursive: true, force: true });
}

test("Git and scanner share admission, reject bursts before spawn, and recover after child close", async () => {
  const root = await realpath(mkdtempSync(path.join(os.tmpdir(), "outright-process-budget-")));
  const budget = createSubprocessBudget({ limit: 1 });
  execFileSync("git", ["init", root]);
  const service = createGitService({ database: {}, getProjects: () => [{ worktrees: [{ path: root }] }], getConfig: async () => ({ scanRoots: [root] }), subprocesses: budget });
  const holdFile = path.join(root, "hold");
  writeFileSync(holdFile, "hold");
  try {
    // A long child reserves the only utility slot. Both public read paths
    // must reject instead of launching another child or returning a partial scan.
    const hold = budget.run(process.execPath, ["-e", "const fs=require('node:fs'); setInterval(() => { if (!fs.existsSync(process.argv.at(-1))) process.exit(0); }, 10)", holdFile], { timeout: 10_000 });
    assert.equal(budget.capacity().active, 1);
    await assert.rejects(service.status(root), (error) => error.statusCode === 429 && error.code === "SUBPROCESS_CAPACITY");
    await assert.rejects(scanProjects({ scanRoots: [root], maxDepth: 1, maxProjects: 1, excludeDirectories: new Set() }, budget),
      (error) => error.statusCode === 429 && error.code === "SUBPROCESS_CAPACITY");
    rmSync(holdFile);
    await hold;
    assert.equal(budget.capacity().active, 0);
    const scan = await scanProjects({ scanRoots: [root], maxDepth: 1, maxProjects: 1, excludeDirectories: new Set() }, budget);
    assert.equal(scan.projects.length, 1);
  } finally { rmSync(holdFile, { force: true }); rmSync(root, { recursive: true, force: true }); }
});

test("malformed utility caps fail closed before admitting work", () => {
  for (const limit of [NaN, Infinity, -1, 0.5, "8"]) {
    assert.throws(() => createSubprocessBudget({ limit }), RangeError);
  }
  assert.equal(createSubprocessBudget({ limit: 0 }).capacity().limit, 0);
});

test("project discovery propagates an unknown native utility owner", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-scan-unknown-owner-"));
  try {
    mkdirSync(path.join(root, ".git"));
    const unavailable = Object.assign(new Error("owner proof missing"), { code: "SUBPROCESS_OWNERSHIP_UNKNOWN" });
    await assert.rejects(scanProjects({ scanRoots: [root], maxDepth: 0, maxProjects: 1, excludeDirectories: new Set() },
      { run: () => Promise.reject(unavailable) }), (error) => error === unavailable);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("explicit null encoding preserves binary stdout and stderr", async () => {
  const budget = createSubprocessBudget({ limit: 1 });
  const { stdout, stderr } = await budget.run(process.execPath, ["-e",
    "process.stdout.write(Buffer.from([0,255,10]));process.stderr.write(Buffer.from([255,0]))"],
  { encoding: null, timeout: 5000 });
  assert.deepEqual(stdout, Buffer.from([0, 255, 10]));
  assert.deepEqual(stderr, Buffer.from([255, 0]));
});

test("an in-flight utility reservation survives runtime reconstruction", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-utility-restart-"));
  let complete;
  try {
    const budget = createSubprocessBudget({ limit: 1, unknownDirectory: root,
      execute(_file, _args, _options, onClose) { complete = onClose; } });
    const command = budget.run("git", ["status"]);
    assert.equal(budget.capacity().active, 1);
    const reopened = createSubprocessBudget({ limit: 1, unknownDirectory: root });
    assert.equal(reopened.capacity().unknown, 1);
    await assert.rejects(reopened.run("git", ["status"]), (error) => error.code === "SUBPROCESS_CAPACITY");
    complete(null, "done", "", true);
    assert.deepEqual(await command, { stdout: "done", stderr: "" });
    assert.equal(createSubprocessBudget({ limit: 1, unknownDirectory: root }).capacity().unknown, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a failed native owner retains an unknown permit across budget restart", { timeout: 15_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-utility-fault-"));
  const pidFile = path.join(root, "descendant.pid");
  const unknownDirectory = path.join(root, "unknown");
  let supervisor;
  let owner;
  const budget = createSubprocessBudget({ limit: 1, unknownDirectory,
    execute(file, args, options, onClose) {
      supervisor = runOwned(file, args, options, onClose);
      return supervisor;
    } });
  const script = `const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
      { detached: true, stdio: 'ignore' });
    fs.writeFileSync(process.argv[1], String(child.pid));
    child.unref(); setTimeout(() => process.exit(0), 800);`;
  try {
    const command = budget.run(process.execPath, ["-e", script, pidFile], { timeout: 8000 });
    command.catch(() => {});
    const deadline = Date.now() + 5000;
    while (!existsSync(pidFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(existsSync(pidFile), "fault fixture did not start its detached child");
    supervisor.kill("SIGKILL");
    await assert.rejects(command, (error) => { owner = error.owner; return error.code === "SUBPROCESS_OWNERSHIP_UNKNOWN"; });
    assert.equal(budget.capacity().active, 1);
    assert.equal(budget.capacity().unknown, 1);
    const restarted = createSubprocessBudget({ limit: 1, unknownDirectory });
    assert.equal(restarted.capacity().unknown, 1);
    await assert.rejects(restarted.run("git", ["--version"]), (error) => error.code === "SUBPROCESS_CAPACITY");
  } finally {
    if (process.platform === "darwin" && owner?.label) {
      try { execFileSync(AGENT_SUPERVISOR, ["--terminate", owner.label], { timeout: 5000 }); }
      catch { /* A missing job is already empty; the detached PID is checked below. */ }
    }
    cleanupDescendant(root, pidFile);
  }
});

test("failed and timed-out utility children release admission", async () => {
  const budget = createSubprocessBudget({ limit: 1 });
  await assert.rejects(budget.run("missing-outright-executable", []));
  assert.equal(budget.capacity().active, 0);
  await assert.rejects(budget.run(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], { timeout: 20 }));
  assert.equal(budget.capacity().active, 0);
  await budget.run(process.execPath, ["-e", "process.exit(0)"]);
});

test("timed-out utility commands keep the permit until a detached descendant is gone", { timeout: 15_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-utility-tree-"));
  const pidFile = path.join(root, "descendant.pid");
  const budget = createSubprocessBudget({ limit: 1 });
  const script = `const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
      { detached: true, stdio: 'ignore' });
    fs.writeFileSync(process.argv[1], String(child.pid));
    child.unref(); setInterval(() => {}, 1000);`;
  try {
    await assert.rejects(budget.run(process.execPath, ["-e", script, pidFile], { timeout: 3000 }),
      (error) => error.killed === true);
    assert.equal(budget.capacity().active, 0, "native tree owner retained the capacity permit after closing");
    assert.ok(existsSync(pidFile), "descendant did not launch before the utility deadline");
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(pid > 0, "detached descendant was not launched");
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" },
      "capacity was released while a detached descendant still ran");
  } finally { cleanupDescendant(root, pidFile); }
});

test("aborting a utility command retains its permit through native descendant cleanup", { timeout: 15_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-utility-abort-"));
  const pidFile = path.join(root, "descendant.pid");
  const controller = new AbortController();
  const budget = createSubprocessBudget({ limit: 1 });
  const script = `const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
      { detached: true, stdio: 'ignore' });
    fs.writeFileSync(process.argv[1], String(child.pid));
    child.unref(); setInterval(() => {}, 1000);`;
  try {
    const command = budget.run(process.execPath, ["-e", script, pidFile], { signal: controller.signal });
    command.catch(() => {});
    const deadline = Date.now() + 5000;
    while (!existsSync(pidFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(existsSync(pidFile), "descendant was not launched before cancellation");
    controller.abort();
    await assert.rejects(command, (error) => error.name === "AbortError" && error.code === "ABORT_ERR");
    assert.equal(budget.capacity().active, 0);
    assert.throws(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0), { code: "ESRCH" },
      "permit was released while a cancelled descendant still ran");
  } finally { cleanupDescendant(root, pidFile); }
});

test("a utility leader exiting does not release its detached descendant's permit", { timeout: 15_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-utility-leader-"));
  const pidFile = path.join(root, "descendant.pid");
  const budget = createSubprocessBudget({ limit: 1 });
  const script = `const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
      { detached: true, stdio: 'ignore' });
    fs.writeFileSync(process.argv[1], String(child.pid));
    child.unref();`;
  try {
    const command = budget.run(process.execPath, ["-e", script, pidFile], { timeout: 8000 });
    command.catch(() => {});
    const deadline = Date.now() + 5000;
    while (!existsSync(pidFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(existsSync(pidFile), "leader did not launch before the ownership probe");
    const pid = Number(readFileSync(pidFile, "utf8"));
    // Native supervisors may reap the descendant immediately after the
    // leader exits. Observe the invariant, rather than requiring a delay.
    if (budget.capacity().active === 0) {
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" },
        "permit was released while the descendant remained live");
    }
    await command;
    assert.equal(budget.capacity().active, 0);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally { cleanupDescendant(root, pidFile); }
});

test("one large worktree scan stays within its own budget and returns every changed count", async () => {
  const previousGitConfig = process.env.GIT_CONFIG_GLOBAL;
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), "outright-scan-burst-")));
  const isolatedGitConfig = path.join(directory, "empty.gitconfig");
  writeFileSync(isolatedGitConfig, "");
  process.env.GIT_CONFIG_GLOBAL = isolatedGitConfig;
  const repository = path.join(directory, "repo");
  mkdirSync(repository);
  const git = (...args) => execFileSync("git", ["-C", repository, ...args], { stdio: "ignore" });
  try {
    git("init");
    git("config", "user.name", "Outright Test");
    git("config", "user.email", "outright@example.invalid");
    writeFileSync(path.join(repository, "seed.txt"), "seed");
    git("add", "seed.txt");
    git("commit", "-m", "seed");
    for (let index = 0; index < 12; index += 1) git("worktree", "add", "-b", `branch-${index}`, path.join(directory, `wt-${index}`));
    writeFileSync(path.join(repository, "dirty.txt"), "dirty");
    for (let index = 0; index < 12; index += 1) writeFileSync(path.join(directory, `wt-${index}`, "dirty.txt"), "dirty");
    const budget = createSubprocessBudget({ limit: 8 });
    const scan = await scanProjects({ scanRoots: [repository], maxDepth: 0, maxProjects: 1, excludeDirectories: new Set() }, budget);
    assert.equal(scan.projects[0].worktrees.length, 13);
    assert.ok(scan.projects[0].worktrees.every((worktree) => worktree.changedCount === 1));
    assert.equal(budget.capacity().active, 0);
  } finally {
    if (previousGitConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previousGitConfig;
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
