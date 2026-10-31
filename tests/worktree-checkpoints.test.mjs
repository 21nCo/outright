import assert from "node:assert/strict";
import test from "node:test";
import { EXPLICIT_PATHS, checkpointCountsText, groupCheckpointEntries, initialRestoreSelection, restoreBlockedReason, restoreChangeText, restoreGroupText,
  restoreSelection, toggleRestorePath } from "../src/lib/worktree-checkpoints.js";

const entries = [
  { path: "a.txt", index: { action: "update" }, file: { action: "update" } },
  { path: "cache", index: null, file: { action: "create" }, blocked: "An ignored file or directory is in the way" },
  { path: "dir", index: null, file: { action: "delete" }, group: "dir", groupSize: 2 },
  { path: "dir/inner.txt", index: null, file: { action: "create" }, group: "dir", groupSize: 2 },
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
  assert.equal(restoreGroupText(entries[2]), "Restored together with 1 other path");
  assert.equal(restoreGroupText(entries[3]), "Restored together with dir");
  assert.equal(restoreGroupText({ ...entries[3], groupSize: 4 }), "Restored together with dir and 2 other paths");
  assert.equal(restoreGroupText(entries[0]), "");
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

test("a large selection is sent as the few offered paths left out", () => {
  assert.deepEqual(restoreSelection(entries, new Set(["a.txt"])), { paths: ["a.txt"] });
  const many = Array.from({ length: EXPLICIT_PATHS + 2 }, (_, index) => ({ path: `f${index}`, index: null, file: { action: "create" } }));
  const blocked = { path: "ignored", index: null, file: { action: "create" }, blocked: "In the way" };
  const allButOne = new Set(many.slice(1).map((entry) => entry.path));
  assert.deepEqual(restoreSelection([...many, blocked], allButOne), { except: ["f0"] });
  // Under half chosen: the chosen paths are the shorter list.
  const wide = [...many, ...many.map((entry) => ({ ...entry, path: `g/${entry.path}` }))];
  assert.deepEqual(restoreSelection(wide, allButOne), { paths: [...allButOne] });
});
