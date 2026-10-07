import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mapWithConcurrency, parseStatus, parseWorktreePorcelain, scanProjects } from "./project-scanner.mjs";

test("default-root candidate resolution is bounded and preserves first discovered worktree", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-scan-order-"));
  for (const name of ["a", "b", "c"]) mkdirSync(path.join(root, name, ".git"), { recursive: true });
  let active = 0;
  let maximum = 0;
  const budget = { async run(_file, args) {
    const cwd = args[1];
    if (args[2] === "rev-parse") {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, path.basename(cwd) === "a" ? 30 : 5));
      active -= 1;
      return { stdout: path.basename(cwd) === "c" ? "../other\n" : "../shared\n" };
    }
    if (args[2] === "worktree") return { stdout: `worktree ${cwd}\nHEAD abcdef123456\nbranch refs/heads/main\n\n` };
    return { stdout: "" };
  } };
  try {
    const result = await scanProjects({ scanRoots: [root], maxDepth: 1, maxProjects: 1,
      excludeDirectories: new Set() }, budget);
    assert.equal(result.candidateCount, 3);
    assert.equal(result.repositoryCount, 2);
    assert.equal(maximum, 2);
    assert.equal(result.projects[0].path, path.join(root, "a"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a falsy mapper rejection fails the whole scan after active workers settle", async () => {
  let rejectFirst;
  const first = new Promise((_, reject) => { rejectFirst = reject; });
  let finishOther;
  const other = new Promise((resolve) => { finishOther = resolve; });
  let settled = false;
  let laterAdmissions = 0;
  const scan = mapWithConcurrency([0, 1, 2], 2, async (item) => {
    if (item === 0) return first;
    if (item === 1) { await other; settled = true; return item; }
    laterAdmissions += 1;
    return item;
  });
  rejectFirst(undefined);
  await Promise.resolve();
  finishOther();
  let rejected = false;
  try { await scan; } catch (error) { rejected = true; assert.equal(error, undefined); }
  assert.equal(rejected, true, "a rejected mapper returned partial successes");
  assert.equal(settled, true, "an active worker was abandoned");
  assert.equal(laterAdmissions, 0, "new work was admitted after the first rejection");
});

test("parses git worktree porcelain records", () => {
  const records = parseWorktreePorcelain(`worktree /code/repo
HEAD abcdef123456
branch refs/heads/main

worktree /code/repo-feature
HEAD fedcba654321
branch refs/heads/feature/worktrees
prunable gitdir file points to non-existent location
`);

  assert.deepEqual(records, [
    { path: "/code/repo", HEAD: "abcdef123456", branch: "refs/heads/main" },
    {
      path: "/code/repo-feature",
      HEAD: "fedcba654321",
      branch: "refs/heads/feature/worktrees",
      prunable: "gitdir file points to non-existent location",
    },
  ]);
});

test("one branch-status result carries changed paths and upstream counts", () => {
  assert.deepEqual(parseStatus("## feature...origin/feature [ahead 2, behind 3]\n M src/app.js\n?? new.txt\n"), {
    divergence: { ahead: 2, behind: 3 },
    changedFiles: [{ status: "M", path: "src/app.js" }, { status: "??", path: "new.txt" }],
  });
  assert.deepEqual(parseStatus("## No commits yet on main\nA  first.txt\n"), {
    divergence: { ahead: 0, behind: 0 },
    changedFiles: [{ status: "A", path: "first.txt" }],
  });
  assert.deepEqual(parseStatus(""), { divergence: { ahead: 0, behind: 0 }, changedFiles: [] });
});
