import assert from "node:assert/strict";
import test from "node:test";
import { checkpointCountsText, groupCheckpointEntries, initialRestoreSelection, restoreBlockedReason, restoreChangeText, toggleRestorePath } from "../src/lib/worktree-checkpoints.js";

const entries = [
  { path: "a.txt", index: { action: "update" }, file: { action: "update" } },
  { path: "cache", index: null, file: { action: "create" }, blocked: "An ignored file or directory is in the way" },
  { path: "dir", index: null, file: { action: "delete" }, coupled: ["dir/inner.txt"] },
  { path: "dir/inner.txt", index: null, file: { action: "create" }, coupled: ["dir"] },
];

test("a restore starts with every offered path chosen and never a blocked one", () => {
  const selected = initialRestoreSelection(entries);
  assert.deepEqual([...selected].sort(), ["a.txt", "dir", "dir/inner.txt"]);
  assert.equal(toggleRestorePath(entries, selected, "cache", true), selected);
});

test("file/directory swaps are chosen and cleared together", () => {
  const none = new Set();
  assert.deepEqual([...toggleRestorePath(entries, none, "dir/inner.txt", true)].sort(), ["dir", "dir/inner.txt"]);
  assert.deepEqual([...toggleRestorePath(entries, initialRestoreSelection(entries), "dir", false)], ["a.txt"]);
});

test("restore stays disabled while a writer is active, nothing is chosen or open terminals are unconfirmed", () => {
  const preview = { blockers: [], terminals: [] };
  assert.equal(restoreBlockedReason(preview, new Set(["a.txt"]), false), null);
  assert.match(restoreBlockedReason(preview, new Set(), false), /at least one path/);
  assert.match(restoreBlockedReason({ ...preview, terminals: [{ id: "t", name: "zsh" }] }, new Set(["a.txt"]), false), /terminals/);
  assert.equal(restoreBlockedReason({ ...preview, terminals: [{ id: "t", name: "zsh" }] }, new Set(["a.txt"]), true), null);
  assert.match(restoreBlockedReason({ ...preview, blockers: [{ code: "WORKTREE_AGENT_ACTIVE", message: "an agent run is queued or running in this worktree" }] }, new Set(["a.txt"]), true), /agent run/);
});

test("checkpoint text names each state and each restore change", () => {
  assert.equal(checkpointCountsText({ staged: 1, unstaged: 0, untracked: 3 }), "1 staged · 3 untracked");
  assert.equal(checkpointCountsText({ staged: 0, unstaged: 0, untracked: 0 }), "No local changes");
  assert.equal(restoreChangeText(entries[0]), "Replace file · Restage");
  assert.equal(restoreChangeText({ index: { action: "remove" }, file: { action: "delete" } }), "Delete file · Unstage");
  const groups = groupCheckpointEntries([{ path: "a", state: "staged" }, { path: "b", state: "untracked" }, { path: "a", state: "unstaged" }]);
  assert.deepEqual(Object.fromEntries(Object.entries(groups).map(([key, list]) => [key, list.length])), { staged: 1, unstaged: 1, untracked: 1 });
});
