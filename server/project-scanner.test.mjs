import assert from "node:assert/strict";
import test from "node:test";
import { mapWithConcurrency, parseWorktreePorcelain } from "./project-scanner.mjs";

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
