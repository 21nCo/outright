import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { CHECKPOINT_LIMITS, CHECKPOINT_REF_PREFIX, RESTORE_MARKER, WRITE_MARKER, batches, createWorktreeCheckpoints } from "./worktree-checkpoints.mjs";

const execFileAsync = promisify(execFile);
process.env.GIT_TRACE2_EVENT = "0";

async function git(cwd, args) { return (await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" })).stdout; }

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "outright-checkpoints-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = path.join(root, "project");
  await git(root, ["init", "-q", "project"]);
  await git(repository, ["config", "user.email", "outright@example.test"]);
  await git(repository, ["config", "user.name", "Outright Test"]);
  await writeFile(path.join(repository, ".gitignore"), "*.log\n");
  await writeFile(path.join(repository, "a.txt"), "committed\n");
  await writeFile(path.join(repository, "old.txt"), "rename me\n");
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-qm", "initial"]);
  return { root, repository };
}

function service(options = {}) {
  const audits = [];
  const runner = options.run ?? ((file, args, runOptions) => execFileAsync(file, args, runOptions));
  const checkpoints = createWorktreeCheckpoints({
    database: { auditAdmission: (action, details) => audits.push({ action, details }), auditCritical: (action, details) => audits.push({ action, details }) },
    subprocesses: { run: (...args) => runner(...args), capacity: options.capacity },
    ...options,
  });
  return { checkpoints, audits };
}

const target = (worktreePath) => ({ worktreePath, worktree: { path: worktreePath } });
const status = (cwd) => git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);

async function restoreAll(checkpoints, cwd, id, extra = {}) {
  const preview = await checkpoints.preview(target(cwd), id);
  const paths = preview.entries.filter((entry) => !entry.blocked).map((entry) => entry.path);
  return { preview, result: await checkpoints.restore(target(cwd), { id, planDigest: preview.planDigest, paths, ...extra }) };
}

test("a checkpoint keeps staged, unstaged and untracked work apart without touching the worktree", async (t) => {
  const { repository } = await fixture(t);
  await writeFile(path.join(repository, "a.txt"), "staged\n");
  await git(repository, ["add", "a.txt"]);
  await writeFile(path.join(repository, "a.txt"), "unstaged\n");
  await writeFile(path.join(repository, "new.txt"), "untracked\n");
  await writeFile(path.join(repository, "secret.log"), "ignored\n");
  const before = await status(repository);
  const indexBefore = await readFile(path.join(repository, ".git", "index"));
  const { checkpoints, audits } = service();

  const checkpoint = await checkpoints.capture(target(repository), { label: "Before agent\nrun" });
  assert.equal(checkpoint.label, "Before agent run");
  assert.deepEqual(checkpoint.counts, { staged: 1, unstaged: 1, untracked: 1 });
  assert.equal(await status(repository), before);
  assert.deepEqual(await readFile(path.join(repository, ".git", "index")), indexBefore, "capture rewrote the index");
  assert.equal(await git(repository, ["stash", "list"]), "");
  assert.deepEqual(audits.map((entry) => entry.action), ["worktree.checkpoint.capture.requested", "worktree.checkpoint.capture"]);

  const files = await git(repository, ["ls-tree", "-r", "--name-only", checkpoint.commit]);
  assert.match(files, /^new\.txt$/m);
  assert.doesNotMatch(files, /secret\.log/, "an ignored file was captured");
  assert.equal(await git(repository, ["show", `${checkpoint.commit}^1:a.txt`]), "staged\n");
  assert.equal(await git(repository, ["show", `${checkpoint.commit}:a.txt`]), "unstaged\n");

  const inspected = await checkpoints.inspect(target(repository), checkpoint.id);
  assert.deepEqual(inspected.entries.map(({ path: file, state }) => `${state}:${file}`).sort(), ["staged:a.txt", "unstaged:a.txt", "untracked:new.txt"]);
  const listed = await checkpoints.describe(target(repository));
  assert.deepEqual(listed.checkpoints.map((item) => item.id), [checkpoint.id]);
  assert.equal(listed.restore, null);
});

test("an edit Git can tell only by content, made as the index was written, is captured", async (t) => {
  const { repository } = await fixture(t);
  // Same size, inode and times as the index entry: only the index file
  // being as new as the entry tells Git to compare the content.
  await git(repository, ["config", "core.trustctime", "false"]);
  const when = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
  const file = path.join(repository, "a.txt");
  await writeFile(file, "aaaa\n");
  await utimes(file, when, when);
  await git(repository, ["add", "a.txt"]);
  await writeFile(file, "bbbb\n");
  await utimes(file, when, when);
  await utimes(path.join(repository, ".git", "index"), when, when);
  const { checkpoints } = service();
  const checkpoint = await checkpoints.capture(target(repository));
  assert.equal(await git(repository, ["show", `${checkpoint.commit}:a.txt`]), "bbbb\n");
  assert.deepEqual(checkpoint.counts, { staged: 1, unstaged: 1, untracked: 0 });
});

test("restore previews each change, needs that preview, and returns all three states with a way back", async (t) => {
  const { repository } = await fixture(t);
  await writeFile(path.join(repository, "a.txt"), "staged\n");
  await git(repository, ["add", "a.txt"]);
  await writeFile(path.join(repository, "a.txt"), "unstaged\n");
  await writeFile(path.join(repository, "new.txt"), "untracked\n");
  const { checkpoints } = service();
  const checkpoint = await checkpoints.capture(target(repository));
  const expected = await status(repository);

  await git(repository, ["reset", "-q", "--hard"]);
  await rm(path.join(repository, "new.txt"));
  await writeFile(path.join(repository, "later.txt"), "made after the checkpoint\n");
  await writeFile(path.join(repository, "build.log"), "ignored and newer\n");

  const preview = await checkpoints.preview(target(repository), checkpoint.id);
  assert.deepEqual(preview.entries.map(({ path: file, index, file: change }) => [file, index?.action ?? null, change?.action ?? null]), [
    ["a.txt", "update", "update"],
    ["later.txt", null, "delete"],
    ["new.txt", null, "create"],
  ]);
  assert.deepEqual(preview.blockers, []);
  assert.equal(preview.head.moved, false);
  await assert.rejects(checkpoints.restore(target(repository), { id: checkpoint.id, paths: ["a.txt"] }),
    (error) => error.details.code === "CHECKPOINT_PREVIEW_REQUIRED");
  // The preview is exact: any later change asks for a new one.
  await writeFile(path.join(repository, "later.txt"), "edited after the preview\n");
  await assert.rejects(checkpoints.restore(target(repository), { id: checkpoint.id, planDigest: preview.planDigest, paths: ["a.txt"] }),
    (error) => error.details.code === "CHECKPOINT_PLAN_CHANGED");
  assert.equal(await readFile(path.join(repository, "later.txt"), "utf8"), "edited after the preview\n");
  assert.equal(await readFile(path.join(repository, "a.txt"), "utf8"), "committed\n");

  const { result } = await restoreAll(checkpoints, repository, checkpoint.id);
  assert.equal(result.restored, 3);
  assert.equal(await status(repository), expected);
  assert.equal(await git(repository, ["show", ":a.txt"]), "staged\n");
  assert.equal(await readFile(path.join(repository, "a.txt"), "utf8"), "unstaged\n");
  assert.equal(await readFile(path.join(repository, "build.log"), "utf8"), "ignored and newer\n", "restore changed an ignored file");

  // The state replaced by the restore is itself a checkpoint.
  assert.equal(result.safetyCheckpoint.reason, "before-restore");
  await restoreAll(checkpoints, repository, result.safetyCheckpoint.id);
  assert.equal(await readFile(path.join(repository, "later.txt"), "utf8"), "edited after the preview\n");
  assert.equal(await readFile(path.join(repository, "a.txt"), "utf8"), "committed\n");
});

test("binary content and staged renames survive a restore byte for byte", async (t) => {
  const { repository } = await fixture(t);
  const binary = Buffer.from([0, 1, 2, 255, 0, 10, 13, 0, 200]);
  await writeFile(path.join(repository, "image.bin"), binary);
  await git(repository, ["mv", "old.txt", "renamed.txt"]);
  await git(repository, ["add", "image.bin"]);
  const { checkpoints } = service();
  const checkpoint = await checkpoints.capture(target(repository));
  const inspected = await checkpoints.inspect(target(repository), checkpoint.id);
  assert.ok(inspected.entries.some((entry) => entry.state === "staged" && entry.status === "R" && entry.originalPath === "old.txt" && entry.path === "renamed.txt"));

  await git(repository, ["mv", "renamed.txt", "old.txt"]);
  await writeFile(path.join(repository, "image.bin"), Buffer.from([9, 9, 9]));
  const { preview } = await restoreAll(checkpoints, repository, checkpoint.id);
  assert.deepEqual(preview.entries.map((entry) => entry.path), ["image.bin", "old.txt", "renamed.txt"]);
  const diff = await checkpoints.fileDiff(target(repository), { id: checkpoint.id, tree: preview.currentTree, file: "image.bin" });
  assert.match(diff.diff, /Binary files/);
  assert.deepEqual(await readFile(path.join(repository, "image.bin")), binary);
  assert.match(await git(repository, ["status", "--porcelain=v1"]), /^R {2}old\.txt -> renamed\.txt$/m);
});

test("restore and every app-owned writer exclude each other in a worktree", async (t) => {
  const { repository } = await fixture(t);
  await writeFile(path.join(repository, "a.txt"), "checkpointed\n");
  let blockers = [];
  let open = [];
  let releaseRestore;
  let gate = null;
  const { checkpoints } = service({
    writers: () => blockers, terminals: () => open,
    run: async (file, args, options) => {
      if (gate && args.includes("commit-tree")) await gate;
      return execFileAsync(file, args, options);
    },
  });
  const checkpoint = await checkpoints.capture(target(repository));
  await writeFile(path.join(repository, "a.txt"), "current\n");
  const preview = await checkpoints.preview(target(repository), checkpoint.id);
  const request = { id: checkpoint.id, planDigest: preview.planDigest, paths: ["a.txt"] };

  blockers = [{ code: "WORKTREE_AGENT_ACTIVE", message: "An agent run is queued or running in this worktree" }];
  await assert.rejects(checkpoints.restore(target(repository), request), (error) => error.details.code === "CHECKPOINT_WRITERS_ACTIVE"
    && error.details.blockers[0].code === "WORKTREE_AGENT_ACTIVE");
  blockers = [];
  await writeFile(path.join(repository, ".git", "index.lock"), "");
  await assert.rejects(checkpoints.restore(target(repository), request), (error) => error.details.blockers?.[0].code === "GIT_INDEX_LOCKED");
  await rm(path.join(repository, ".git", "index.lock"));
  open = [{ id: "terminal-1", name: "zsh" }];
  await assert.rejects(checkpoints.restore(target(repository), request), (error) => error.details.code === "CHECKPOINT_TERMINALS_UNACKNOWLEDGED");
  // A stage, unstage or commit admitted in the worktree refuses a restore.
  const releaseWriter = checkpoints.admitWriter([repository]);
  assert.deepEqual((await checkpoints.preview(target(repository), checkpoint.id)).blockers.map((item) => item.code), ["GIT_WRITE_ACTIVE"]);
  await assert.rejects(checkpoints.restore(target(repository), { ...request, acknowledgeTerminals: ["terminal-1"] }),
    (error) => error.details.blockers?.[0].code === "GIT_WRITE_ACTIVE");
  releaseWriter();
  // So does a terminal that is starting there.
  const releaseTerminal = checkpoints.admitWriter([repository], "terminal");
  await assert.rejects(checkpoints.restore(target(repository), { ...request, acknowledgeTerminals: ["terminal-1"] }),
    (error) => error.details.blockers?.[0].code === "TERMINAL_STARTING");
  releaseTerminal(Object.assign(new Error("lost"), { code: "SUBPROCESS_OWNERSHIP_UNKNOWN" }));
  assert.equal(checkpoints.holding(repository), null, "a terminal's failure held the worktree as a Git write");
  assert.equal(await readFile(path.join(repository, "a.txt"), "utf8"), "current\n");

  gate = new Promise((resolve) => { releaseRestore = resolve; });
  const running = checkpoints.restore(target(repository), { ...request, acknowledgeTerminals: ["terminal-1"] });
  while (!checkpoints.holding(repository)) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(checkpoints.holding(repository), "CHECKPOINT_RESTORE_RUNNING");
  assert.throws(() => checkpoints.admitWriter([repository]), (error) => error.details.code === "CHECKPOINT_RESTORE_RUNNING");
  assert.throws(() => checkpoints.admitWriter([repository], "terminal"), (error) => error.details.code === "CHECKPOINT_RESTORE_RUNNING");
  await assert.rejects(checkpoints.capture(target(repository)), (error) => error.details.code === "CHECKPOINT_BUSY");
  assert.equal((await checkpoints.describe(target(repository))).restore.status, "running");
  releaseRestore();
  await running;
  assert.equal(checkpoints.holding(repository), null);
  checkpoints.admitWriter([repository])();
  assert.equal(await readFile(path.join(repository, "a.txt"), "utf8"), "checkpointed\n");
});

test("an ignored file where a checkpoint file would go is never overwritten", async (t) => {
  const { repository } = await fixture(t);
  await writeFile(path.join(repository, "cache"), "untracked when captured\n");
  const { checkpoints } = service();
  const checkpoint = await checkpoints.capture(target(repository));
  await rm(path.join(repository, "cache"));
  await writeFile(path.join(repository, ".git", "info", "exclude"), "cache\n");
  await writeFile(path.join(repository, "cache"), "ignored now, not captured\n");

  const preview = await checkpoints.preview(target(repository), checkpoint.id);
  const entry = preview.entries.find((item) => item.path === "cache");
  assert.match(entry.blocked, /ignored/);
  await assert.rejects(checkpoints.restore(target(repository), { id: checkpoint.id, planDigest: preview.planDigest, paths: ["cache"] }),
    (error) => error.details.code === "CHECKPOINT_SELECTION_INVALID");
  assert.equal(await readFile(path.join(repository, "cache"), "utf8"), "ignored now, not captured\n");
});

test("a selective restore changes only the chosen paths and keeps file/directory swaps together", async (t) => {
  const { repository } = await fixture(t);
  await mkdir(path.join(repository, "dir"));
  await writeFile(path.join(repository, "dir", "inner.txt"), "inside\n");
  await writeFile(path.join(repository, "a.txt"), "checkpointed\n");
  const { checkpoints } = service();
  const checkpoint = await checkpoints.capture(target(repository));
  await rm(path.join(repository, "dir"), { recursive: true });
  await writeFile(path.join(repository, "dir"), "now a file\n");
  await writeFile(path.join(repository, "a.txt"), "keep this\n");

  const preview = await checkpoints.preview(target(repository), checkpoint.id);
  assert.deepEqual(preview.entries.filter((entry) => entry.group === "dir").map((entry) => [entry.path, entry.groupSize]), [["dir", 2], ["dir/inner.txt", 2]]);
  await assert.rejects(checkpoints.restore(target(repository), { id: checkpoint.id, planDigest: preview.planDigest, paths: ["dir/inner.txt"] }),
    (error) => /2 paths restored together with dir must all be chosen$/.test(error.message));
  await checkpoints.restore(target(repository), { id: checkpoint.id, planDigest: preview.planDigest, paths: ["dir", "dir/inner.txt"] });
  assert.equal(await readFile(path.join(repository, "dir", "inner.txt"), "utf8"), "inside\n");
  assert.equal(await readFile(path.join(repository, "a.txt"), "utf8"), "keep this\n");
});

test("an interrupted restore holds the worktree across a restart and finishes only through a new preview", async (t) => {
  const { repository } = await fixture(t);
  await writeFile(path.join(repository, "a.txt"), "staged\n");
  await git(repository, ["add", "a.txt"]);
  await writeFile(path.join(repository, "new.txt"), "untracked\n");
  await writeFile(path.join(repository, "other.txt"), "untracked too\n");
  const first = service({
    // The real index, not a capture's copy of it.
    run: (file, args, options) => args.includes("update-index") && args.includes("--add") && !options.env?.GIT_INDEX_FILE
      ? Promise.reject(Object.assign(new Error("killed"), { killed: true, signal: "SIGKILL" }))
      : execFileAsync(file, args, options),
  });
  const checkpoint = await first.checkpoints.capture(target(repository));
  await git(repository, ["reset", "-q", "--hard"]);
  await rm(path.join(repository, "new.txt"));
  await rm(path.join(repository, "other.txt"));
  await assert.rejects(restoreAll(first.checkpoints, repository, checkpoint.id), (error) =>
    error.details.code === "CHECKPOINT_RESTORE_INTERRUPTED" && Boolean(error.details.safetyCheckpointId));
  assert.ok(first.audits.some((entry) => entry.action === "worktree.checkpoint.restore.failed"));
  // Files were written; the index was not.
  assert.equal(await readFile(path.join(repository, "new.txt"), "utf8"), "untracked\n");
  assert.equal(await git(repository, ["show", ":a.txt"]), "committed\n");

  // After a restart the marker alone holds the worktree against every writer.
  let open = [{ id: "terminal-1", name: "zsh" }];
  const { checkpoints, audits } = service({ terminals: () => open });
  assert.equal(checkpoints.holding(repository), "CHECKPOINT_RESTORE_INTERRUPTED");
  assert.throws(() => checkpoints.admitWriter([repository]), (error) => error.details.code === "CHECKPOINT_RESTORE_INTERRUPTED");
  const described = await checkpoints.describe(target(repository));
  assert.equal(described.restore.status, "interrupted");
  assert.equal(described.restore.checkpointId, checkpoint.id);
  assert.equal(described.restore.ownerUnconfirmed, false);
  await assert.rejects(restoreAll(checkpoints, repository, checkpoint.id), (error) => error.details.code === "CHECKPOINT_RESTORE_INTERRUPTED");
  await assert.rejects(checkpoints.remove(target(repository), described.restore.safetyCheckpointId), (error) => error.details.code === "CHECKPOINT_RESTORE_INTERRUPTED");
  await assert.rejects(checkpoints.recover(target(repository), "resume"), (error) => error.details.code === "CHECKPOINT_RECOVERY_INVALID");
  const another = await checkpoints.capture(target(repository), { label: "taken while interrupted" });
  await assert.rejects(checkpoints.preview(target(repository), another.id, { resume: true }), (error) => error.details.code === "CHECKPOINT_RESUME_MISMATCH");

  // Work done after the interruption is previewed again, confirmed, and kept
  // in the checkpoint taken before the restore finishes.
  const stale = await checkpoints.preview(target(repository), checkpoint.id, { resume: true });
  await writeFile(path.join(repository, "new.txt"), "edited after the interruption\n");
  await assert.rejects(checkpoints.restore(target(repository), { id: checkpoint.id, planDigest: stale.planDigest, paths: ["a.txt"], resume: true,
    acknowledgeTerminals: ["terminal-1"] }), (error) => error.details.code === "CHECKPOINT_PLAN_CHANGED");
  const resumed = await checkpoints.preview(target(repository), checkpoint.id, { resume: true });
  assert.equal(resumed.resume, true);
  assert.deepEqual(resumed.blockers, []);
  // other.txt was already restored; only what still differs is offered.
  assert.deepEqual(resumed.entries.map(({ path: file, index, file: change }) => [file, index?.action ?? null, change?.action ?? null]),
    [["a.txt", "update", null], ["new.txt", null, "update"]]);
  const request = { id: checkpoint.id, planDigest: resumed.planDigest, paths: ["a.txt", "new.txt"], resume: true };
  await assert.rejects(checkpoints.restore(target(repository), request), (error) => error.details.code === "CHECKPOINT_TERMINALS_UNACKNOWLEDGED");
  assert.equal(await readFile(path.join(repository, "new.txt"), "utf8"), "edited after the interruption\n");
  const result = await checkpoints.restore(target(repository), { ...request, acknowledgeTerminals: ["terminal-1"] });
  assert.equal(result.restored, 2);
  assert.equal(await git(repository, ["show", ":a.txt"]), "staged\n");
  assert.equal(await readFile(path.join(repository, "new.txt"), "utf8"), "untracked\n");
  assert.equal(await git(repository, ["show", `${result.safetyCheckpoint.commit}:new.txt`]), "edited after the interruption\n");
  assert.ok(audits.some((entry) => entry.action === "worktree.checkpoint.restore.resumed"));
  assert.equal((await checkpoints.describe(target(repository))).restore, null);
  await assert.rejects(readFile(path.join(repository, ".git", RESTORE_MARKER)), { code: "ENOENT" });
  assert.equal(checkpoints.holding(repository), null);
  checkpoints.admitWriter([repository])();
  // Every checkpoint the restores relied on was kept.
  const kept = new Set((await checkpoints.describe(target(repository))).checkpoints.map((item) => item.id));
  assert.ok([checkpoint.id, described.restore.safetyCheckpointId, result.safetyCheckpoint.id].every((id) => kept.has(id)));

  open = [];
  await writeFile(path.join(repository, ".git", RESTORE_MARKER), "{not json");
  assert.equal((await checkpoints.describe(target(repository))).restore.unreadable, true);
  assert.equal(checkpoints.holding(repository), "CHECKPOINT_RESTORE_INTERRUPTED");
  await assert.rejects(checkpoints.preview(target(repository), checkpoint.id, { resume: true }), (error) => error.details.code === "CHECKPOINT_MARKER_UNREADABLE");
  await checkpoints.recover(target(repository), "keep");
  assert.equal((await checkpoints.describe(target(repository))).restore, null);
  assert.equal(checkpoints.holding(repository), null);
});

test("a restore that loses track of a Git process holds the worktree until the process is proven gone", async (t) => {
  const { repository } = await fixture(t);
  await writeFile(path.join(repository, "a.txt"), "checkpointed\n");
  let unknown = 0;
  let lose = false;
  let released = 0;
  const run = (file, args, options) => {
    if (lose && args.includes("show")) {
      unknown = 1;
      return Promise.reject(Object.assign(new Error("Utility descendant ownership is unknown"), { code: "SUBPROCESS_OWNERSHIP_UNKNOWN", cause: new Error("lost") }));
    }
    return execFileAsync(file, args, options);
  };
  const capacity = () => ({ active: 0, limit: 8, unknown });
  const first = service({ run, capacity, onRelease: () => { released += 1; } });
  const checkpoint = await first.checkpoints.capture(target(repository));
  await writeFile(path.join(repository, "a.txt"), "current\n");
  lose = true;
  await assert.rejects(restoreAll(first.checkpoints, repository, checkpoint.id), (error) => error.details.code === "CHECKPOINT_RESTORE_INTERRUPTED");
  lose = false;
  assert.equal(first.checkpoints.holding(repository), "CHECKPOINT_RESTORE_INTERRUPTED");
  assert.equal(JSON.parse(await readFile(path.join(repository, ".git", RESTORE_MARKER), "utf8")).ownerUnconfirmed, true);
  assert.equal((await first.checkpoints.describe(target(repository))).restore.ownerUnconfirmed, true);
  await assert.rejects(first.checkpoints.recover(target(repository), "keep"), (error) => error.details.code === "CHECKPOINT_OWNER_UNCONFIRMED");
  await assert.rejects(first.checkpoints.preview(target(repository), checkpoint.id, { resume: true }), (error) => error.details.code === "CHECKPOINT_OWNER_UNCONFIRMED");

  // A restarted runtime reads the same hold from the marker.
  const { checkpoints } = service({ run, capacity, onRelease: () => { released += 1; } });
  await assert.rejects(checkpoints.recover(target(repository), "keep"), (error) => error.details.code === "CHECKPOINT_OWNER_UNCONFIRMED");
  assert.equal(checkpoints.holding(repository), "CHECKPOINT_RESTORE_INTERRUPTED");
  unknown = 0;
  const before = released;
  await checkpoints.recover(target(repository), "keep");
  assert.equal(checkpoints.holding(repository), null);
  assert.ok(released > before, "runs that waited for the restore were not released");
  assert.equal(await readFile(path.join(repository, "a.txt"), "utf8"), "current\n");
});

test("checkpoints belong to one worktree, keep the newest, and refuse oversized files", async (t) => {
  const { root, repository } = await fixture(t);
  const linked = path.join(root, "linked");
  await git(repository, ["worktree", "add", "-q", "-b", "feature", linked]);
  const { checkpoints } = service({ limits: { ...CHECKPOINT_LIMITS, perWorktree: 2, fileBytes: 1024 } });
  const kept = [];
  for (const label of ["one", "two", "three"]) {
    await writeFile(path.join(linked, "a.txt"), `${label}\n`);
    kept.push(await checkpoints.capture(target(linked), { label }));
  }
  assert.deepEqual((await checkpoints.describe(target(linked))).checkpoints.map((item) => item.label), ["three", "two"]);
  assert.deepEqual((await checkpoints.describe(target(repository))).checkpoints, []);
  assert.equal(await git(repository, ["for-each-ref", CHECKPOINT_REF_PREFIX]), "");
  await checkpoints.remove(target(linked), kept[2].id);
  assert.deepEqual((await checkpoints.describe(target(linked))).checkpoints.map((item) => item.label), ["two"]);

  // Older checkpoints also give way to the retained-content budget.
  const budgeted = service({ limits: { ...CHECKPOINT_LIMITS, perWorktree: 5, retainedBytes: 1500 } }).checkpoints;
  await writeFile(path.join(linked, "medium.bin"), Buffer.alloc(1000));
  await budgeted.capture(target(linked), { label: "medium" });
  await writeFile(path.join(linked, "medium.bin"), Buffer.alloc(1000, 1));
  await budgeted.capture(target(linked), { label: "medium again" });
  assert.deepEqual((await budgeted.describe(target(linked))).checkpoints.map((item) => item.label), ["medium again"]);
  await rm(path.join(linked, "medium.bin"));

  await writeFile(path.join(linked, "large.bin"), Buffer.alloc(2048));
  await assert.rejects(checkpoints.capture(target(linked)), (error) => error.statusCode === 413 && error.details.path === "large.bin");
  assert.equal((await checkpoints.describe(target(linked))).checkpoints.length, 1);
  await assert.rejects(checkpoints.inspect(target(linked), "../../HEAD"), (error) => error.statusCode === 400);
});

test("a file replaced by a directory, and a directory by a file, restore unless uncaptured content is in the way", async (t) => {
  const { repository } = await fixture(t);
  const x = path.join(repository, "x");
  await mkdir(path.join(x, "deep"), { recursive: true });
  await writeFile(path.join(x, "inner.txt"), "inside\n");
  await writeFile(path.join(x, "deep", "more.txt"), "deeper\n");
  const { checkpoints } = service();
  const asDirectory = await checkpoints.capture(target(repository), { label: "directory" });
  await rm(x, { recursive: true });
  await writeFile(x, "a file\n");
  const asFile = await checkpoints.capture(target(repository), { label: "file" });

  await restoreAll(checkpoints, repository, asDirectory.id);
  assert.equal(await readFile(path.join(x, "inner.txt"), "utf8"), "inside\n");
  // A directory whose files are all captured and deleted gives way to the
  // file, and empty directories in it go too.
  await mkdir(path.join(x, "empty", "nested"), { recursive: true });
  const { preview } = await restoreAll(checkpoints, repository, asFile.id);
  assert.deepEqual(preview.entries.map((entry) => [entry.path, entry.file.action, entry.blocked ?? null]),
    [["x", "create", null], ["x/deep/more.txt", "delete", null], ["x/inner.txt", "delete", null]]);
  assert.equal(await readFile(x, "utf8"), "a file\n");

  // An ignored file inside the directory is not captured, so neither the
  // file nor the deletions it is coupled with are offered.
  await restoreAll(checkpoints, repository, asDirectory.id);
  await writeFile(path.join(x, "deep", "build.log"), "ignored\n");
  const blocked = await checkpoints.preview(target(repository), asFile.id);
  assert.match(blocked.entries.find((entry) => entry.path === "x").blocked, /x\/deep\/build\.log/);
  assert.ok(blocked.entries.every((entry) => entry.blocked));
  await assert.rejects(checkpoints.restore(target(repository), { id: asFile.id, planDigest: blocked.planDigest, paths: blocked.entries.map((entry) => entry.path) }),
    (error) => error.details.code === "CHECKPOINT_SELECTION_INVALID");
  assert.equal(await readFile(path.join(x, "deep", "build.log"), "utf8"), "ignored\n");
  assert.equal(await readFile(path.join(x, "inner.txt"), "utf8"), "inside\n");
});

test("file bytes round-trip exactly whatever line-ending conversion or filter applies", async (t) => {
  const { repository } = await fixture(t);
  await git(repository, ["config", "core.autocrlf", "input"]);
  await git(repository, ["config", "filter.upper.clean", "tr a-z A-Z"]);
  await git(repository, ["config", "filter.upper.smudge", "tr A-Z a-z"]);
  await writeFile(path.join(repository, ".gitattributes"), "*.crlf text eol=crlf\n*.up filter=upper\n");
  await writeFile(path.join(repository, "doc.crlf"), "a\nb\n");
  await writeFile(path.join(repository, "same.txt"), "same\n");
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-qm", "attributes"]);
  // Only the line endings change; Git reports it modified, and so does the
  // checkpoint, which keeps the bytes.
  await writeFile(path.join(repository, "same.txt"), "same\r\n");
  const files = {
    "windows.txt": Buffer.from("one\r\ntwo\r\n"),
    "doc.crlf": Buffer.from("changed\nwith LF\n"),
    "note.up": Buffer.from("Hello, Filter\n"),
  };
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(repository, name), content);
  const { checkpoints } = service();
  const checkpoint = await checkpoints.capture(target(repository));
  assert.deepEqual(checkpoint.counts, { staged: 0, unstaged: 2, untracked: 2 });
  assert.deepEqual((await status(repository)).split("\n").filter(Boolean).sort(), [" M doc.crlf", " M same.txt", "?? note.up", "?? windows.txt"]);

  await rm(path.join(repository, "windows.txt"));
  await rm(path.join(repository, "note.up"));
  await writeFile(path.join(repository, "doc.crlf"), "replaced\n");
  await writeFile(path.join(repository, "same.txt"), "same\n");
  const { preview } = await restoreAll(checkpoints, repository, checkpoint.id);
  assert.deepEqual(preview.entries.map((entry) => entry.path), ["doc.crlf", "note.up", "same.txt", "windows.txt"]);
  for (const [name, content] of Object.entries(files)) assert.deepEqual(await readFile(path.join(repository, name)), content, `${name} changed on its way back`);
  assert.deepEqual(await readFile(path.join(repository, "same.txt")), Buffer.from("same\r\n"));

  // A change of line endings alone is a change to restore.
  await writeFile(path.join(repository, "windows.txt"), "one\ntwo\n");
  assert.deepEqual((await checkpoints.preview(target(repository), checkpoint.id)).entries.map((entry) => entry.path), ["windows.txt"]);
});

test("staged content counts against the budget, and every checkpoint that is taken can be restored", async (t) => {
  const { repository } = await fixture(t);
  assert.throws(() => service({ limits: { ...CHECKPOINT_LIMITS, files: 3, planEntries: 5 } }), /twice/);
  const { checkpoints } = service({ limits: { ...CHECKPOINT_LIMITS, files: 3, planEntries: 6, fileBytes: 1024, totalBytes: 2000 } });
  // A staged file whose copy on disk matches the index is still stored.
  await writeFile(path.join(repository, "big.bin"), Buffer.alloc(1500, 1));
  await git(repository, ["add", "big.bin"]);
  await assert.rejects(checkpoints.capture(target(repository)), (error) => error.statusCode === 413 && error.details.path === "big.bin");
  await git(repository, ["rm", "-q", "--cached", "big.bin"]);
  await rm(path.join(repository, "big.bin"));
  for (const name of ["s1.bin", "s2.bin"]) await writeFile(path.join(repository, name), Buffer.alloc(900, name.length));
  await git(repository, ["add", "s1.bin", "s2.bin"]);
  await writeFile(path.join(repository, "u.bin"), Buffer.alloc(300));
  await assert.rejects(checkpoints.capture(target(repository)), (error) => error.statusCode === 413 && error.details.code === "CHECKPOINT_TOO_LARGE");
  await rm(path.join(repository, "u.bin"));
  await git(repository, ["rm", "-q", "--cached", "s2.bin"]);
  await rm(path.join(repository, "s2.bin"));
  assert.equal((await checkpoints.capture(target(repository))).bytes, 900);
  await git(repository, ["rm", "-q", "--cached", "s1.bin"]);
  await rm(path.join(repository, "s1.bin"));

  // A checkpoint at the file limit restores onto a state at the limit.
  for (const name of ["u1", "u2", "u3"]) await writeFile(path.join(repository, name), `${name}\n`);
  const full = await checkpoints.capture(target(repository));
  for (const name of ["u1", "u2", "u3"]) await rm(path.join(repository, name));
  for (const name of ["v1", "v2", "v3"]) await writeFile(path.join(repository, name), `${name}\n`);
  const preview = await checkpoints.preview(target(repository), full.id);
  assert.equal(preview.entries.length, 6);
  // Every path offered except those named.
  await checkpoints.restore(target(repository), { id: full.id, planDigest: preview.planDigest, except: ["v3"] });
  assert.deepEqual((await status(repository)).split("\n").filter(Boolean).sort(), ["?? u1", "?? u2", "?? u3", "?? v3"]);
  await assert.rejects(checkpoints.capture(target(repository)), (error) => error.statusCode === 413 && /before taking a checkpoint$/.test(error.message));
  // A restore first checkpoints the worktree as it is, and says so.
  await assert.rejects(checkpoints.preview(target(repository), full.id), (error) => error.statusCode === 413
    && /before restoring: the restore first takes a checkpoint/.test(error.message));
  for (const name of ["u1", "u2", "u3", "v3"]) await rm(path.join(repository, name));

  // Deletions count as paths too, so a checkpoint never holds more than a
  // restore can change.
  const small = service({ limits: { ...CHECKPOINT_LIMITS, files: 2, planEntries: 4 } }).checkpoints;
  await git(repository, ["rm", "-q", "a.txt", "old.txt", ".gitignore"]);
  await assert.rejects(small.capture(target(repository)), (error) => error.statusCode === 413 && /deleted/.test(error.message));
  await git(repository, ["reset", "-q", "--hard"]);
  for (const name of ["a.txt", "old.txt", ".gitignore"]) await rm(path.join(repository, name));
  await assert.rejects(small.capture(target(repository)), (error) => error.statusCode === 413);
});

test("the preview shows how a path's staged content changes, apart from its file", async (t) => {
  const { repository } = await fixture(t);
  await writeFile(path.join(repository, "a.txt"), "staged A\n");
  await git(repository, ["add", "a.txt"]);
  await writeFile(path.join(repository, "a.txt"), "on disk B\n");
  const { checkpoints } = service();
  const checkpoint = await checkpoints.capture(target(repository));
  await git(repository, ["add", "a.txt"]);

  const preview = await checkpoints.preview(target(repository), checkpoint.id);
  assert.deepEqual(preview.entries.map(({ path: file, index, file: change }) => [file, index?.action ?? null, change]), [["a.txt", "update", null]]);
  const staged = await checkpoints.fileDiff(target(repository), { id: checkpoint.id, tree: preview.currentIndexTree, file: "a.txt", side: "index" });
  assert.match(staged.diff, /^-on disk B$/m);
  assert.match(staged.diff, /^\+staged A$/m);
  assert.equal((await checkpoints.fileDiff(target(repository), { id: checkpoint.id, tree: preview.currentTree, file: "a.txt" })).diff, "");
  await assert.rejects(checkpoints.fileDiff(target(repository), { id: checkpoint.id, tree: preview.currentTree, file: "a.txt", side: "head" }),
    (error) => error.statusCode === 400);
});

test("an interrupted restore stays held until no Git process with a lost owner is left, however it stopped", async (t) => {
  const { repository } = await fixture(t);
  let unknown = 0;
  let released = 0;
  const { checkpoints } = service({ capacity: () => ({ active: 0, limit: 8, unknown }), onRelease: () => { released += 1; } });
  await writeFile(path.join(repository, "a.txt"), "checkpointed\n");
  const checkpoint = await checkpoints.capture(target(repository));
  // The marker as a restore writes it before changing anything: a crash
  // leaves nothing else, while the budget still holds the crashed run's
  // unknown owners.
  await writeFile(path.join(repository, ".git", RESTORE_MARKER), JSON.stringify({ version: 2, operationId: "op", checkpointId: checkpoint.id,
    commit: checkpoint.commit, safetyCheckpointId: checkpoint.id, startedAt: new Date().toISOString(), paths: ["a.txt"] }));
  unknown = 1;
  assert.equal((await checkpoints.describe(target(repository))).restore.ownerUnconfirmed, true);
  await assert.rejects(checkpoints.recover(target(repository), "keep"), (error) => error.details.code === "CHECKPOINT_OWNER_UNCONFIRMED");
  await assert.rejects(checkpoints.preview(target(repository), checkpoint.id, { resume: true }), (error) => error.details.code === "CHECKPOINT_OWNER_UNCONFIRMED");
  unknown = 0;
  assert.equal((await checkpoints.preview(target(repository), checkpoint.id, { resume: true })).resume, true);
  await checkpoints.recover(target(repository), "keep");
  assert.equal(checkpoints.holding(repository), null);
  assert.ok(released > 0);
});

test("a stage, unstage or commit that loses track of its Git process holds the worktree until it is proven gone", async (t) => {
  const { repository } = await fixture(t);
  let unknown = 0;
  let released = 0;
  const { checkpoints } = service({ capacity: () => ({ active: 0, limit: 8, unknown }), onRelease: () => { released += 1; } });
  const checkpoint = await checkpoints.capture(target(repository));
  await writeFile(path.join(repository, "a.txt"), "current\n");
  const preview = await checkpoints.preview(target(repository), checkpoint.id);
  const request = { id: checkpoint.id, planDigest: preview.planDigest, paths: ["a.txt"] };

  // A failure that is not about ownership releases the worktree at once.
  checkpoints.admitWriter([repository])(Object.assign(new Error("hook failed"), { code: 1 }));
  assert.equal(checkpoints.holding(repository), null);
  unknown = 1;
  checkpoints.admitWriter([repository])(Object.assign(new Error("Utility descendant ownership is unknown"), { code: "SUBPROCESS_OWNERSHIP_UNKNOWN" }));
  assert.equal(checkpoints.holding(repository), "GIT_WRITE_UNCONFIRMED");
  assert.throws(() => checkpoints.admitWriter([repository]), (error) => error.details.code === "GIT_WRITE_UNCONFIRMED");
  assert.deepEqual((await checkpoints.preview(target(repository), checkpoint.id)).blockers.map((item) => item.code), ["GIT_WRITE_UNCONFIRMED"]);
  await assert.rejects(checkpoints.restore(target(repository), request), (error) => error.details.blockers?.[0].code === "GIT_WRITE_UNCONFIRMED");
  assert.equal(await readFile(path.join(repository, "a.txt"), "utf8"), "current\n");

  unknown = 0;
  assert.equal(checkpoints.holding(repository), null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(released, 1, "runs that waited for the worktree were not released");
  await checkpoints.restore(target(repository), request);
  assert.equal(await readFile(path.join(repository, "a.txt"), "utf8"), "committed\n");
});

test("capture never runs a content filter, and leaves nested repositories alone", async (t) => {
  const { root, repository } = await fixture(t);
  const sentinel = path.join(root, "filter-ran");
  await git(repository, ["config", "filter.fail.clean", "false"]);
  await git(repository, ["config", "filter.fail.required", "true"]);
  await git(repository, ["config", "filter.mark.clean", `sh -c 'touch "$0"; cat' ${JSON.stringify(sentinel)}`]);
  await writeFile(path.join(repository, ".gitattributes"), "*.fail filter=fail\n*.mark filter=mark\n");
  await git(repository, ["add", ".gitattributes"]);
  await git(repository, ["commit", "-qm", "filters"]);
  // A tracked file whose entry is as new as the index is compared by content.
  await writeFile(path.join(repository, "tracked.mark"), "tracked\n");
  await git(repository, ["-c", "filter.mark.clean=cat", "add", "tracked.mark"]);
  const files = { "new.fail": "never cleaned\r\n", "new.mark": "not marked\n" };
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(repository, name), content);
  // An untracked repository with no commit yet.
  await git(repository, ["init", "-q", "inner"]);
  await writeFile(path.join(repository, "inner", "own.txt"), "its own\n");

  const { checkpoints } = service();
  const checkpoint = await checkpoints.capture(target(repository));
  assert.deepEqual(checkpoint.counts, { staged: 1, unstaged: 0, untracked: 2 });
  assert.equal(await git(repository, ["ls-tree", "-r", "--name-only", checkpoint.commit, "--", "inner"]), "");
  await assert.rejects(readFile(sentinel), { code: "ENOENT" }, "a clean filter ran during capture");
  for (const name of Object.keys(files)) await rm(path.join(repository, name));
  const { preview } = await restoreAll(checkpoints, repository, checkpoint.id);
  assert.deepEqual(preview.entries.map((entry) => entry.path), ["new.fail", "new.mark"]);
  for (const [name, content] of Object.entries(files)) assert.equal(await readFile(path.join(repository, name), "utf8"), content);
  assert.equal(await readFile(path.join(repository, "inner", "own.txt"), "utf8"), "its own\n");
  await assert.rejects(readFile(sentinel), { code: "ENOENT" }, "a clean filter ran");
});

test("a restore waits for another Git command's index lock instead of stopping part way", async (t) => {
  const { repository } = await fixture(t);
  let held = false;
  const lock = path.join(repository, ".git", "index.lock");
  const { checkpoints } = service({
    run: async (file, args, options) => {
      // Something like an editor's `git status` takes the lock as the
      // restore starts writing the index.
      if (!held && args.includes("update-index") && !options.env?.GIT_INDEX_FILE) {
        held = true;
        await writeFile(lock, "");
        setTimeout(() => { void rm(lock, { force: true }); }, 600);
      }
      return execFileAsync(file, args, options);
    },
  });
  await writeFile(path.join(repository, "a.txt"), "staged\n");
  await git(repository, ["add", "a.txt"]);
  const checkpoint = await checkpoints.capture(target(repository));
  await git(repository, ["reset", "-q", "--hard"]);
  await restoreAll(checkpoints, repository, checkpoint.id);
  assert.ok(held);
  assert.equal(await git(repository, ["show", ":a.txt"]), "staged\n");
  assert.equal(checkpoints.holding(repository), null);
});

test("a preview of a directory with thousands of paths swapped for a file stays linear in size", async (t) => {
  const { repository } = await fixture(t);
  const count = 3000;
  await mkdir(path.join(repository, "many"));
  await Promise.all(Array.from({ length: count }, (_, index) => writeFile(path.join(repository, "many", `f${index}`), `${index}\n`)));
  const { checkpoints } = service();
  const checkpoint = await checkpoints.capture(target(repository));
  await rm(path.join(repository, "many"), { recursive: true });
  await writeFile(path.join(repository, "many"), "a file now\n");

  const preview = await checkpoints.preview(target(repository), checkpoint.id);
  assert.equal(preview.entries.length, count + 1);
  assert.ok(preview.entries.every((entry) => entry.group === "many" && entry.groupSize === count + 1));
  assert.ok(JSON.stringify(preview).length < count * 300, `the preview took ${JSON.stringify(preview).length} bytes`);
  await assert.rejects(checkpoints.restore(target(repository), { id: checkpoint.id, planDigest: preview.planDigest, except: ["many/f7"] }),
    (error) => error.details.code === "CHECKPOINT_SELECTION_INVALID");
  await checkpoints.restore(target(repository), { id: checkpoint.id, planDigest: preview.planDigest, except: [] });
  assert.equal(await readFile(path.join(repository, "many", "f2999"), "utf8"), "2999\n");
});

test("a name that changes only by case restores on a filesystem that ignores case", async (t) => {
  const { root, repository } = await fixture(t);
  await writeFile(path.join(root, "CaseProbe"), "");
  const insensitive = await readFile(path.join(root, "caseprobe")).then(() => true, () => false);
  if (!insensitive) { t.skip("this filesystem tells case apart"); return; }
  await writeFile(path.join(repository, "Note.txt"), "untracked\n");
  const { checkpoints } = service();
  const checkpoint = await checkpoints.capture(target(repository));
  await git(repository, ["mv", "old.txt", "OLD.txt"]);
  await rename(path.join(repository, "Note.txt"), path.join(repository, "note.txt"));

  const { preview } = await restoreAll(checkpoints, repository, checkpoint.id);
  assert.deepEqual(preview.entries.map((entry) => [entry.path, entry.file?.action ?? null, entry.blocked ?? null, entry.groupSize ?? 1]),
    [["note.txt", "delete", null, 2], ["Note.txt", "create", null, 2], ["old.txt", "create", null, 2], ["OLD.txt", "delete", null, 2]]);
  assert.deepEqual((await readdir(repository)).filter((name) => /^(?:note|old)\.txt$/i.test(name)).sort(), ["Note.txt", "old.txt"]);
  assert.equal(await readFile(path.join(repository, "Note.txt"), "utf8"), "untracked\n");
  assert.equal(await status(repository), "?? Note.txt\n");
});

test("a Git write that lost its process keeps the worktree held after a restart, and its release is announced", async (t) => {
  const { repository } = await fixture(t);
  let unknown = 1;
  const capacity = () => ({ active: 0, limit: 8, unknown });
  const first = service({ capacity });
  const checkpoint = await first.checkpoints.capture(target(repository));
  await writeFile(path.join(repository, "a.txt"), "current\n");
  first.checkpoints.admitWriter([repository])(Object.assign(new Error("Utility descendant ownership is unknown"), { code: "SUBPROCESS_OWNERSHIP_UNKNOWN" }));

  // A new runtime knows only what the Git directory and the budget keep.
  let released = 0;
  const published = [];
  const { checkpoints } = service({ capacity, onRelease: () => { released += 1; }, publish: (event) => published.push(event) });
  assert.equal(checkpoints.holding(repository), "GIT_WRITE_UNCONFIRMED");
  assert.throws(() => checkpoints.admitWriter([repository]), (error) => error.details.code === "GIT_WRITE_UNCONFIRMED");
  const preview = await checkpoints.preview(target(repository), checkpoint.id);
  assert.deepEqual(preview.blockers.map((item) => item.code), ["GIT_WRITE_UNCONFIRMED"]);
  await assert.rejects(checkpoints.restore(target(repository), { id: checkpoint.id, planDigest: preview.planDigest, paths: ["a.txt"] }),
    (error) => error.details.blockers?.[0].code === "GIT_WRITE_UNCONFIRMED");
  assert.equal(checkpoints.reconcile(), false);

  // Proving the owner gone releases the worktree without anything else asking.
  unknown = 0;
  published.length = 0;
  assert.equal(checkpoints.reconcile(), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(released, 1, "runs that waited for the worktree were not released");
  assert.deepEqual(published.map((event) => event.payload.worktreePath), [repository]);
  await assert.rejects(readFile(path.join(repository, ".git", WRITE_MARKER)), { code: "ENOENT" });
  assert.equal(checkpoints.holding(repository), null);
});

test("a Git write is recorded before it runs, so a runtime that stops during it leaves the worktree held after a restart", async (t) => {
  const { repository } = await fixture(t);
  const marker = path.join(repository, ".git", WRITE_MARKER);
  let unknown = 0;
  const capacity = () => ({ active: 0, limit: 8, unknown });
  const first = service({ capacity });
  const checkpoint = await first.checkpoints.capture(target(repository));
  await writeFile(path.join(repository, "a.txt"), "current\n");

  // Writes admitted by this runtime hold their own marker: they do not hold
  // each other, and a reconcile meanwhile leaves the marker in place.
  const releaseOne = first.checkpoints.admitWriter([repository]);
  await lstat(marker);
  assert.equal(first.checkpoints.holding(repository), null);
  const releaseTwo = first.checkpoints.admitWriter([repository]);
  assert.equal(first.checkpoints.reconcile(), true);
  releaseOne();
  releaseOne(Object.assign(new Error("late"), { code: "SUBPROCESS_OWNERSHIP_UNKNOWN" }));
  await lstat(marker);
  releaseTwo();
  await assert.rejects(lstat(marker), { code: "ENOENT" });
  assert.equal(first.checkpoints.holding(repository), null, "a second call of a release held the worktree");

  // The runtime stops while a write is admitted; its Git process may live on.
  first.checkpoints.admitWriter([repository]);
  unknown = 1;
  let released = 0;
  const { checkpoints } = service({ capacity, onRelease: () => { released += 1; } });
  assert.equal(checkpoints.holding(repository), "GIT_WRITE_UNCONFIRMED");
  const preview = await checkpoints.preview(target(repository), checkpoint.id);
  assert.deepEqual(preview.blockers.map((item) => item.code), ["GIT_WRITE_UNCONFIRMED"]);
  const request = { id: checkpoint.id, planDigest: preview.planDigest, paths: ["a.txt"] };
  await assert.rejects(checkpoints.restore(target(repository), request), (error) => error.details.blockers?.[0].code === "GIT_WRITE_UNCONFIRMED");
  assert.equal(await readFile(path.join(repository, "a.txt"), "utf8"), "current\n");

  unknown = 0;
  assert.equal(checkpoints.reconcile(), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(released, 1);
  await assert.rejects(lstat(marker), { code: "ENOENT" });
  await checkpoints.restore(target(repository), request);
  assert.equal(await readFile(path.join(repository, "a.txt"), "utf8"), "committed\n");
});

test("a Git write that cannot be recorded does not run", { skip: process.platform === "win32" && "a directory in the marker's place is enough on POSIX" }, async (t) => {
  const { repository } = await fixture(t);
  const { checkpoints } = service({ capacity: () => ({ active: 0, limit: 8, unknown: 0 }) });
  await mkdir(path.join(repository, ".git", WRITE_MARKER, "inside"), { recursive: true });
  assert.throws(() => checkpoints.admitWriter([repository]), (error) => error.statusCode === 503 && error.details.code === "GIT_WRITE_UNRECORDED");
  await rm(path.join(repository, ".git", WRITE_MARKER), { recursive: true });
  checkpoints.admitWriter([repository])();
  await assert.rejects(lstat(path.join(repository, ".git", WRITE_MARKER)), { code: "ENOENT" });
});

test("a checkpoint keeps each file's type on disk, whatever its index entry is", async (t) => {
  const { repository } = await fixture(t);
  await symlink("a.txt", path.join(repository, "link"));
  await writeFile(path.join(repository, "plain.txt"), "plain\n");
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-qm", "link and file"]);
  // A link replaced by a regular file, and a regular file by a link.
  await rm(path.join(repository, "link"));
  await writeFile(path.join(repository, "link"), "regular file contents\n");
  await rm(path.join(repository, "plain.txt"));
  await symlink("a.txt", path.join(repository, "plain.txt"));
  const { checkpoints } = service();
  const checkpoint = await checkpoints.capture(target(repository));
  await git(repository, ["checkout", "--", "link", "plain.txt"]);
  await restoreAll(checkpoints, repository, checkpoint.id);
  assert.equal((await lstat(path.join(repository, "link"))).isFile(), true, "the regular file came back as a link");
  assert.equal(await readFile(path.join(repository, "link"), "utf8"), "regular file contents\n");
  assert.equal(await readlink(path.join(repository, "plain.txt")), "a.txt");

  // Where Git keeps links as files holding their target, so does a checkpoint.
  await git(repository, ["config", "core.symlinks", "false"]);
  await git(repository, ["checkout", "--", "link", "plain.txt"]);
  await rm(path.join(repository, "link"));
  await writeFile(path.join(repository, "link"), "b.txt");
  const emulated = await checkpoints.capture(target(repository));
  assert.match(await git(repository, ["ls-tree", emulated.commit, "link"]), /^120000 /);
  await writeFile(path.join(repository, "link"), "a.txt");
  await restoreAll(checkpoints, repository, emulated.id);
  assert.equal((await lstat(path.join(repository, "link"))).isFile(), true);
  assert.equal(await readFile(path.join(repository, "link"), "utf8"), "b.txt");
});

test("every Git command a capture runs fits a Windows command line, with SHA-256 object ids", async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "outright-checkpoints-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = path.join(root, "project");
  await git(root, ["init", "-q", "--object-format=sha256", "project"]);
  // Names as long as the path batches allow 256 of.
  for (let index = 0; index < 600; index += 1) await writeFile(path.join(repository, `${String(index).padStart(4, "0")}-${"n".repeat(42)}`), `${index}\n`);
  let longest = 0;
  const { checkpoints } = service({ run: (file, args, options) => {
    longest = Math.max(longest, [file, ...args].reduce((total, value) => total + value.length + 3, 0));
    return execFileAsync(file, args, options);
  } });
  const checkpoint = await checkpoints.capture(target(repository));
  assert.equal(checkpoint.counts.untracked, 600);
  assert.ok(longest < 32_767, `a command line was ${longest} characters`);
  assert.equal(batches(["a"]).length, 1);
});

test("a directory replaced by a link is recorded as the link, never through it", { skip: process.platform === "win32" && "directory links need privileges on Windows" }, async (t) => {
  const { root, repository } = await fixture(t);
  await mkdir(path.join(repository, "dir"));
  await writeFile(path.join(repository, "dir", "file.txt"), "inside\n");
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-qm", "dir"]);
  const outside = path.join(root, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "file.txt"), "SECRET-EXTERNAL\n");
  const secret = (await execFileAsync("git", ["hash-object", path.join(outside, "file.txt")], { encoding: "utf8" })).stdout.trim();
  const { checkpoints } = service();
  await writeFile(path.join(repository, "dir", "file.txt"), "edited\n");
  const real = await checkpoints.capture(target(repository));
  await rm(path.join(repository, "dir"), { recursive: true });
  await symlink(outside, path.join(repository, "dir"), "dir");

  const linked = await checkpoints.capture(target(repository));
  assert.equal(await git(repository, ["ls-tree", "-r", "--format=%(objectmode) %(path)", linked.commit, "dir"]), "120000 dir\n");
  assert.equal(await git(repository, ["show", `${linked.commit}:dir`]), outside);
  // The checkpoint taken before a restore records the same, and the restore
  // replaces the link without deleting anything outside the worktree.
  const { result } = await restoreAll(checkpoints, repository, real.id);
  assert.equal(await git(repository, ["ls-tree", "--format=%(objectmode)", result.safetyCheckpoint.commit, "dir"]), "120000\n");
  assert.equal((await lstat(path.join(repository, "dir"))).isDirectory(), true);
  assert.equal(await readFile(path.join(repository, "dir", "file.txt"), "utf8"), "edited\n");
  await restoreAll(checkpoints, repository, linked.id);
  assert.equal(await readlink(path.join(repository, "dir")), outside);
  assert.equal(await readFile(path.join(outside, "file.txt"), "utf8"), "SECRET-EXTERNAL\n");
  await assert.rejects(git(repository, ["cat-file", "-e", secret]), "content outside the worktree was stored");
});

for (const [name, swapped] of [["the file", "a.txt"], ["a directory above it", "dir"]]) {
  test(`capture never stores content a link swapped in for ${name} while it ran`, { skip: process.platform === "win32" && "links need privileges on Windows" }, async (t) => {
    const { root, repository } = await fixture(t);
    await mkdir(path.join(repository, "dir"));
    await writeFile(path.join(repository, "dir", "a.txt"), "inside\n");
    await git(repository, ["add", "."]);
    await git(repository, ["commit", "-qm", "dir"]);
    await writeFile(path.join(repository, "dir", "a.txt"), "edited\n");
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "a.txt"), "SECRET-EXTERNAL\n");
    const secret = (await execFileAsync("git", ["hash-object", path.join(outside, "a.txt")], { encoding: "utf8" })).stdout.trim();
    const swap = path.join(repository, "dir", ...(swapped === "dir" ? [] : [swapped]));
    let armed = true;
    // The swap lands after the capture looked at the file and before it reads it.
    const { checkpoints } = service({ run: async (file, args, options) => {
      if (armed && args.includes("ls-files") && args.includes("-s")) {
        armed = false;
        await rename(swap, `${swap}-moved`);
        await symlink(swapped === "dir" ? outside : path.join(outside, "a.txt"), swap);
      }
      return execFileAsync(file, args, options);
    } });
    await assert.rejects(checkpoints.capture(target(repository)), (error) => error.statusCode === 409 && error.details.code === "CHECKPOINT_CHANGED");
    await assert.rejects(git(repository, ["cat-file", "-e", secret]), "content outside the worktree was stored");
    assert.equal(await git(repository, ["for-each-ref", CHECKPOINT_REF_PREFIX]), "");
    // Once the path is back, a new capture records it.
    await rm(swap);
    await rename(`${swap}-moved`, swap);
    const checkpoint = await checkpoints.capture(target(repository));
    assert.equal(await git(repository, ["show", `${checkpoint.commit}:dir/a.txt`]), "edited\n");
  });
}

test("capture refuses promptly, and lets the worktree go, when a FIFO is swapped in for a file", { skip: process.platform === "win32" && "no FIFOs on Windows" }, async (t) => {
  const { repository } = await fixture(t);
  await writeFile(path.join(repository, "a.txt"), "edited\n");
  const file = path.join(repository, "a.txt");
  let armed = true;
  // The swap lands after the capture looked at the file and before it opens it.
  const { checkpoints } = service({ run: async (command, args, options) => {
    if (armed && args.includes("ls-files") && args.includes("-s")) {
      armed = false;
      await rename(file, `${file}-moved`);
      await execFileAsync("mkfifo", [file]);
    }
    return execFileAsync(command, args, options);
  } });
  let timer;
  const hung = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("capture hung on the FIFO")), 5_000); });
  try {
    await assert.rejects(Promise.race([checkpoints.capture(target(repository)), hung]),
      (error) => error.statusCode === 409 && error.details.code === "CHECKPOINT_CHANGED");
  } finally { clearTimeout(timer); }
  assert.equal(await git(repository, ["for-each-ref", CHECKPOINT_REF_PREFIX]), "");
  assert.equal((await checkpoints.describe(target(repository))).busy, null);
  await rm(file);
  await rename(`${file}-moved`, file);
  const checkpoint = await checkpoints.capture(target(repository));
  assert.equal(await git(repository, ["show", `${checkpoint.commit}:a.txt`]), "edited\n");
});

test("files added with git add -N, empty or not, restore as untracked files and leave the index alone", async (t) => {
  const { repository } = await fixture(t);
  await writeFile(path.join(repository, "empty.txt"), "");
  await writeFile(path.join(repository, "full.txt"), "intent\n");
  await git(repository, ["add", "-N", "empty.txt", "full.txt"]);
  const { checkpoints } = service();
  const checkpoint = await checkpoints.capture(target(repository));
  assert.equal(await git(repository, ["ls-tree", "--name-only", checkpoint.commit, "empty.txt", "full.txt"]), "empty.txt\nfull.txt\n");
  assert.equal(await git(repository, ["ls-tree", "--name-only", `${checkpoint.commit}^1`, "empty.txt", "full.txt"]), "");
  assert.deepEqual(checkpoint.counts, { staged: 0, unstaged: 0, untracked: 2 });
  await rm(path.join(repository, "empty.txt"));
  await rm(path.join(repository, "full.txt"));
  const index = await git(repository, ["ls-files", "-s", "--debug"]);
  const { preview } = await restoreAll(checkpoints, repository, checkpoint.id);
  assert.deepEqual(preview.entries.map((entry) => `${entry.path}:${entry.file?.action}:${entry.index?.action ?? "-"}`), ["empty.txt:create:-", "full.txt:create:-"]);
  assert.equal(await readFile(path.join(repository, "empty.txt"), "utf8"), "");
  assert.equal(await readFile(path.join(repository, "full.txt"), "utf8"), "intent\n");
  assert.equal(await git(repository, ["ls-files", "-s", "--debug"]), index, "the restore changed the live index");
});

test("a file whose name is near the length limit restores and clears the restore record", { skip: process.platform === "win32" && "Windows limits the whole path" }, async (t) => {
  const { repository } = await fixture(t);
  const name = "n".repeat(250);
  await writeFile(path.join(repository, name), "long name\n");
  const { checkpoints } = service();
  const checkpoint = await checkpoints.capture(target(repository));
  await rm(path.join(repository, name));
  await restoreAll(checkpoints, repository, checkpoint.id);
  assert.equal(await readFile(path.join(repository, name), "utf8"), "long name\n");
  await assert.rejects(readFile(path.join(repository, ".git", RESTORE_MARKER)), { code: "ENOENT" });
  assert.equal((await readdir(repository)).filter((entry) => entry.startsWith(".outright-")).length, 0);
  assert.equal((await checkpoints.describe(target(repository))).restore, null);
});

test("preview and restore refuse a Git without overlay restore before changing anything", async (t) => {
  const { repository } = await fixture(t);
  await writeFile(path.join(repository, "a.txt"), "edited\n");
  const { checkpoints } = service({ run: (file, args, options) => args.at(-1) === "version"
    ? Promise.resolve({ stdout: "git version 2.25.4\n", stderr: "" }) : execFileAsync(file, args, options) });
  const checkpoint = await checkpoints.capture(target(repository));
  await writeFile(path.join(repository, "a.txt"), "later\n");
  const before = await git(repository, ["for-each-ref", CHECKPOINT_REF_PREFIX]);
  await assert.rejects(checkpoints.preview(target(repository), checkpoint.id), (error) => error.details?.code === "CHECKPOINT_GIT_UNSUPPORTED");
  await assert.rejects(checkpoints.restore(target(repository), { id: checkpoint.id, planDigest: "0".repeat(64), paths: ["a.txt"] }),
    (error) => error.details?.code === "CHECKPOINT_GIT_UNSUPPORTED");
  assert.equal(await readFile(path.join(repository, "a.txt"), "utf8"), "later\n");
  assert.equal(await git(repository, ["for-each-ref", CHECKPOINT_REF_PREFIX]), before, "a safety checkpoint was taken");
  await assert.rejects(readFile(path.join(repository, ".git", RESTORE_MARKER)), { code: "ENOENT" });
});

// Runs `body` (a module function given `createWorktreeCheckpoints` and the
// directory) in a child process, so a lookup that blocks the thread fails
// on the timeout instead of freezing the test runner.
async function inChild(directory, body) {
  const script = `const { createWorktreeCheckpoints } = await import(${JSON.stringify(new URL("./worktree-checkpoints.mjs", import.meta.url).href)});
    const checkpoints = createWorktreeCheckpoints({ database: {}, subprocesses: { run: () => Promise.reject(new Error("no Git here")), capacity: () => ({ unknown: 0 }) } });
    const attempt = (work) => { try { work(); return "admitted"; } catch (error) { return error.details?.code ?? error.message; } };
    console.log(JSON.stringify(await (${body})(checkpoints, ${JSON.stringify(directory)}, attempt)));`;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], { timeout: 10_000 });
  return JSON.parse(stdout);
}

test("the Git directory is found through a linked .git, and one that cannot be read never blocks or frees the worktree", { skip: process.platform === "win32" && "no FIFOs or unprivileged links on Windows" }, async (t) => {
  const { root, repository } = await fixture(t);
  // A FIFO for .git: holding() and admitWriter() return at once and the worktree stays held.
  const fifo = path.join(root, "fifo-worktree");
  await mkdir(fifo);
  await execFileAsync("mkfifo", [path.join(fifo, ".git")]);
  assert.deepEqual(await inChild(fifo, `(checkpoints, directory, attempt) => [checkpoints.holding(directory), attempt(() => checkpoints.admitWriter([directory]))]`),
    ["CHECKPOINT_RESTORE_INTERRUPTED", "CHECKPOINT_RESTORE_INTERRUPTED"]);
  // A directory with no .git is not a worktree a restore can hold.
  assert.deepEqual(await inChild(root, `(checkpoints, directory) => [checkpoints.holding(directory)]`), [null]);

  // The write marker of a live write swapped for a FIFO: the next write is refused at once, never waited on.
  assert.deepEqual(await inChild(repository, `async (checkpoints, directory, attempt) => {
    const { rm } = await import("node:fs/promises");
    const { execFileSync } = await import("node:child_process");
    const release = checkpoints.admitWriter([directory]);
    await rm(directory + "/.git/${WRITE_MARKER}");
    execFileSync("mkfifo", [directory + "/.git/${WRITE_MARKER}"]);
    const second = attempt(() => checkpoints.admitWriter([directory]));
    release();
    return [second];
  }`), ["GIT_WRITE_UNRECORDED"]);
  await rm(path.join(repository, ".git", WRITE_MARKER), { force: true });

  // .git linked to the real Git directory: both markers hold a new instance,
  // and a write records its marker in the directory the link names.
  const real = path.join(root, "real-git");
  await rename(path.join(repository, ".git"), real);
  await symlink(real, path.join(repository, ".git"));
  const checkpoint = await service().checkpoints.capture(target(repository));
  await writeFile(path.join(real, RESTORE_MARKER), JSON.stringify({ version: 2, operationId: "op", checkpointId: checkpoint.id,
    commit: checkpoint.commit, safetyCheckpointId: checkpoint.id, startedAt: new Date().toISOString(), paths: ["a.txt"] }));
  assert.equal(service().checkpoints.holding(repository), "CHECKPOINT_RESTORE_INTERRUPTED");
  await rm(path.join(real, RESTORE_MARKER));
  let unknown = 1;
  const capacity = () => ({ active: 0, limit: 8, unknown });
  await writeFile(path.join(real, WRITE_MARKER), "stopped\n");
  const { checkpoints } = service({ capacity });
  assert.equal(checkpoints.holding(repository), "GIT_WRITE_UNCONFIRMED");
  unknown = 0;
  assert.equal(checkpoints.holding(repository), null);
  await assert.rejects(lstat(path.join(real, WRITE_MARKER)), { code: "ENOENT" });
  const release = checkpoints.admitWriter([repository]);
  assert.ok((await lstat(path.join(real, WRITE_MARKER))).isFile());
  release();
  await assert.rejects(lstat(path.join(real, WRITE_MARKER)), { code: "ENOENT" });
});

test("a restore record or index swapped for a FIFO is refused at once, never waited on", { skip: process.platform === "win32" && "no FIFOs on Windows" }, async (t) => {
  const { repository } = await fixture(t);
  const { checkpoints } = service();
  const checkpoint = await checkpoints.capture(target(repository));
  const promptly = async (work) => {
    let timer;
    const hung = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("blocked on a FIFO")), 5_000); });
    try { return await Promise.race([work, hung]); } finally { clearTimeout(timer); }
  };
  await execFileAsync("mkfifo", [path.join(repository, ".git", RESTORE_MARKER)]);
  const described = await promptly(checkpoints.describe(target(repository)));
  assert.deepEqual([described.restore.status, described.restore.unreadable], ["interrupted", true]);
  assert.equal(checkpoints.holding(repository), "CHECKPOINT_RESTORE_INTERRUPTED");
  await promptly(checkpoints.recover(target(repository), "keep"));
  assert.equal(checkpoints.holding(repository), null);

  const index = path.join(repository, ".git", "index");
  await rename(index, `${index}-moved`);
  await execFileAsync("mkfifo", [index]);
  await assert.rejects(promptly(checkpoints.capture(target(repository))), (error) => error.code === "EFTYPE");
  assert.equal((await checkpoints.describe(target(repository))).busy, null);
  await rm(index);
  await rename(`${index}-moved`, index);
  assert.notEqual((await checkpoints.capture(target(repository))).id, checkpoint.id);
});

test("a restore refused admission at the retention limit leaves checkpoints, files and the record as they were", async (t) => {
  const { repository } = await fixture(t);
  let refuse = false;
  const audits = [];
  const database = {
    auditAdmission: (action, details) => {
      if (refuse && action.startsWith("worktree.checkpoint.restore")) throw Object.assign(new Error("Audit quota reached"), { statusCode: 507 });
      audits.push({ action, details });
    },
    auditCritical: (action, details) => audits.push({ action, details }),
  };
  const { checkpoints } = service({ database, limits: { ...CHECKPOINT_LIMITS, perWorktree: 2 } });
  await writeFile(path.join(repository, "a.txt"), "first\n");
  await checkpoints.capture(target(repository));
  await writeFile(path.join(repository, "a.txt"), "second\n");
  const checkpoint = await checkpoints.capture(target(repository));
  await writeFile(path.join(repository, "a.txt"), "current\n");
  const refs = () => git(repository, ["for-each-ref", CHECKPOINT_REF_PREFIX]);
  const before = await refs();
  const markerFile = path.join(repository, ".git", RESTORE_MARKER);

  refuse = true;
  await assert.rejects(restoreAll(checkpoints, repository, checkpoint.id), { message: "Audit quota reached" });
  assert.equal(await refs(), before, "a safety checkpoint was recorded or an older one pruned before the admission");
  assert.equal(await readFile(path.join(repository, "a.txt"), "utf8"), "current\n");
  await assert.rejects(lstat(markerFile), { code: "ENOENT" });

  // Finishing an interrupted restore is admitted the same way.
  const marker = JSON.stringify({ version: 2, operationId: "op", checkpointId: checkpoint.id, commit: checkpoint.commit,
    safetyCheckpointId: checkpoint.id, startedAt: new Date().toISOString(), paths: ["a.txt"] });
  await writeFile(markerFile, marker);
  const preview = await checkpoints.preview(target(repository), checkpoint.id, { resume: true });
  const resume = { id: checkpoint.id, planDigest: preview.planDigest, paths: ["a.txt"], resume: true };
  await assert.rejects(checkpoints.restore(target(repository), resume), { message: "Audit quota reached" });
  assert.equal(await refs(), before);
  assert.equal(await readFile(path.join(repository, "a.txt"), "utf8"), "current\n");
  assert.equal(await readFile(markerFile, "utf8"), marker);

  refuse = false;
  const result = await checkpoints.restore(target(repository), resume);
  assert.equal(await readFile(path.join(repository, "a.txt"), "utf8"), "second\n");
  const recorded = audits.find((entry) => entry.action === "worktree.checkpoint.restore.resumed");
  assert.equal(recorded.details.safetyCheckpointId, result.safetyCheckpoint.id);
  assert.equal(audits.find((entry) => entry.action === "worktree.checkpoint.restore.resumed.requested").details.operationId, recorded.details.operationId);
});
