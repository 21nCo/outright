import assert from "node:assert/strict";
import test from "node:test";
import { parseWorktreePorcelain } from "./project-scanner.mjs";

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
