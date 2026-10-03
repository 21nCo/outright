import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSubprocessBudget } from "./subprocess-budget.mjs";
import { createGitService } from "./git-service.mjs";
import { scanProjects } from "./project-scanner.mjs";

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

test("failed and timed-out utility children release admission", async () => {
  const budget = createSubprocessBudget({ limit: 1 });
  await assert.rejects(budget.run("missing-outright-executable", []));
  assert.equal(budget.capacity().active, 0);
  await assert.rejects(budget.run(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], { timeout: 20 }));
  assert.equal(budget.capacity().active, 0);
  await budget.run(process.execPath, ["-e", "process.exit(0)"]);
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
