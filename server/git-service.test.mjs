import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createGitService } from "./git-service.mjs";

const execFileAsync = promisify(execFile);

test("reviews, stages, commits, creates, and safely removes discovered worktrees", async () => {
  const scanRoot = await mkdtemp(path.join(os.tmpdir(), "outright-git-test-"));
  const rawRepository = path.join(scanRoot, "project");
  const audit = [];
  try {
    await git(scanRoot, ["init", "project"]);
    const canonicalScanRoot = await realpath(scanRoot);
    const repository = await realpath(rawRepository);
    let projects = [{ id: "project", name: "project", path: repository, worktrees: [{ id: "main", path: repository, isLinked: false, changedCount: 0 }] }];
    await git(repository, ["config", "user.email", "outright@example.test"]);
    await git(repository, ["config", "user.name", "Outright Test"]);
    await writeFile(path.join(repository, "README.md"), "first\n");
    await git(repository, ["add", "README.md"]);
    await git(repository, ["commit", "-m", "initial"]);

    let interruptedRun = null;
    const service = createGitService({ database: { audit: (action, details) => audit.push({ action, details }), getSettings: () => ({ editor: "zed" }), findUnresolvedInterruptedRunForWorktree: () => interruptedRun }, getProjects: () => projects, getConfig: async () => ({ scanRoots: [canonicalScanRoot] }) });
    await writeFile(path.join(repository, "README.md"), "first\nsecond\n");
    assert.equal((await service.status(repository)).unstagedCount, 1);
    assert.match((await service.diff(repository, "README.md")).diff, /\+second/);
    assert.equal((await service.stage(repository, ["README.md"])).stagedCount, 1);
    assert.equal((await service.unstage(repository, ["README.md"])).unstagedCount, 1);
    await service.stage(repository, ["README.md"]);
    assert.match((await service.commit(repository, "update docs")).output, /update docs/);

    const created = await service.createWorktree({ projectId: "project", branch: "feature/runtime", name: "project-runtime" });
    projects = [{ ...projects[0], worktrees: [...projects[0].worktrees, { id: "runtime", path: created.path, isLinked: true, changedCount: 0 }] }];
    assert.equal(await exists(created.path), true);
    interruptedRun = { id: "interrupted-run" };
    await assert.rejects(
      service.removeWorktree({ projectId: "project", worktreePath: created.path, confirmation: created.path }),
      /Resolve the interrupted run/,
    );
    assert.equal(await exists(created.path), true, "pending recovery prevents destructive worktree removal");
    interruptedRun = null;
    assert.equal((await service.removeWorktree({ projectId: "project", worktreePath: created.path, confirmation: created.path })).removed, true);
    assert.equal(await exists(created.path), false);
    assert.ok(audit.some((entry) => entry.action === "git.commit"));
    assert.ok(audit.some((entry) => entry.action === "git.worktree.removed"));
  } finally {
    await rm(scanRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("parses portable filenames and supported quote characters from NUL porcelain output", async () => {
  const scanRoot = await mkdtemp(path.join(os.tmpdir(), "outright-git-spaces-"));
  const rawRepository = path.join(scanRoot, "project");
  try {
    await git(scanRoot, ["init", "project"]);
    const canonicalScanRoot = await realpath(scanRoot);
    const repository = await realpath(rawRepository);
    const projects = [{ id: "project", name: "project", path: repository, worktrees: [{ id: "main", path: repository, isLinked: false, changedCount: 0 }] }];
    await git(repository, ["config", "user.email", "outright@example.test"]);
    await git(repository, ["config", "user.name", "Outright Test"]);
    const service = createGitService({ database: { audit: () => {}, getSettings: () => ({ editor: "zed" }) }, getProjects: () => projects, getConfig: async () => ({ scanRoots: [canonicalScanRoot] }) });

    await writeFile(path.join(repository, "hello world.txt"), "hello\n");
    let status = await service.status(repository);
    assert.equal(status.files[0].path, "hello world.txt");
    assert.equal(status.files[0].worktree, "?");

    await service.stage(repository, ["hello world.txt"]);
    status = await service.status(repository);
    assert.equal(status.stagedCount, 1);
    await git(repository, ["commit", "-m", "add spaced file"]);

    await git(repository, ["mv", "hello world.txt", "renamed file.txt"]);
    status = await service.status(repository);
    const renamed = status.files.find((file) => file.index === "R");
    assert.equal(renamed.path, "renamed file.txt");
    assert.equal(renamed.originalPath, "hello world.txt");

    // Windows filesystems reject double quotes before Git can observe them.
    if (process.platform !== "win32") {
      await writeFile(path.join(repository, `quoted "name".txt`), "q\n");
      status = await service.status(repository);
      assert.ok(status.files.some((file) => file.path === `quoted "name".txt`));
    }
  } finally {
    await rm(scanRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

async function git(cwd, args) {
  await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

async function exists(target) {
  try { await access(target); return true; }
  catch { return false; }
}
