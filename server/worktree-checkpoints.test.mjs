import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { CHECKPOINT_LIMITS, CHECKPOINT_REF_PREFIX, RESTORE_MARKER, createWorktreeCheckpoints } from "./worktree-checkpoints.mjs";

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
    subprocesses: { run: (...args) => runner(...args) },
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

test("restore is refused while another writer is active, and holds agent work while it runs", async (t) => {
  const { repository } = await fixture(t);
  await writeFile(path.join(repository, "a.txt"), "checkpointed\n");
  let blockers = [];
  let open = [];
  let releaseRestore;
  let gate = null;
  const { checkpoints } = service({
    writers: () => blockers, terminals: () => open,
    run: async (file, args, options) => {
      if (gate && args.includes("restore")) await gate;
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
  assert.equal(await readFile(path.join(repository, "a.txt"), "utf8"), "current\n");

  gate = new Promise((resolve) => { releaseRestore = resolve; });
  const running = checkpoints.restore(target(repository), { ...request, acknowledgeTerminals: ["terminal-1"] });
  while (!checkpoints.holding(repository)) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(checkpoints.capture(target(repository)), (error) => error.details.code === "CHECKPOINT_BUSY");
  assert.equal((await checkpoints.describe(target(repository))).restore.status, "running");
  releaseRestore();
  await running;
  assert.equal(checkpoints.holding(repository), false);
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
  assert.deepEqual(preview.entries.find((entry) => entry.path === "dir").coupled, ["dir/inner.txt"]);
  await assert.rejects(checkpoints.restore(target(repository), { id: checkpoint.id, planDigest: preview.planDigest, paths: ["dir/inner.txt"] }),
    (error) => /together with dir$/.test(error.message));
  await checkpoints.restore(target(repository), { id: checkpoint.id, planDigest: preview.planDigest, paths: ["dir", "dir/inner.txt"] });
  assert.equal(await readFile(path.join(repository, "dir", "inner.txt"), "utf8"), "inside\n");
  assert.equal(await readFile(path.join(repository, "a.txt"), "utf8"), "keep this\n");
});

test("an interrupted restore is reported after a restart and can be finished or kept", async (t) => {
  const { repository } = await fixture(t);
  await writeFile(path.join(repository, "a.txt"), "staged\n");
  await git(repository, ["add", "a.txt"]);
  await writeFile(path.join(repository, "new.txt"), "untracked\n");
  const first = service({
    run: (file, args, options) => args.includes("update-index") && args.includes("--add")
      ? Promise.reject(Object.assign(new Error("killed"), { killed: true, signal: "SIGKILL" }))
      : execFileAsync(file, args, options),
  });
  const checkpoint = await first.checkpoints.capture(target(repository));
  await git(repository, ["reset", "-q", "--hard"]);
  await rm(path.join(repository, "new.txt"));
  await assert.rejects(restoreAll(first.checkpoints, repository, checkpoint.id), (error) =>
    error.details.code === "CHECKPOINT_RESTORE_INTERRUPTED" && Boolean(error.details.safetyCheckpointId));
  assert.ok(first.audits.some((entry) => entry.action === "worktree.checkpoint.restore.failed"));
  // Files were written; the index was not.
  assert.equal(await readFile(path.join(repository, "new.txt"), "utf8"), "untracked\n");
  assert.equal(await git(repository, ["show", ":a.txt"]), "committed\n");

  const { checkpoints } = service();
  const described = await checkpoints.describe(target(repository));
  assert.equal(described.restore.status, "interrupted");
  assert.equal(described.restore.checkpointId, checkpoint.id);
  await assert.rejects(restoreAll(checkpoints, repository, checkpoint.id), (error) => error.details.code === "CHECKPOINT_RESTORE_INTERRUPTED");
  await assert.rejects(checkpoints.remove(target(repository), described.restore.safetyCheckpointId), (error) => error.details.code === "CHECKPOINT_RESTORE_INTERRUPTED");
  await checkpoints.recover(target(repository), "resume");
  assert.equal(await git(repository, ["show", ":a.txt"]), "staged\n");
  assert.equal((await checkpoints.describe(target(repository))).restore, null);
  await assert.rejects(readFile(path.join(repository, ".git", RESTORE_MARKER)), { code: "ENOENT" });

  await writeFile(path.join(repository, ".git", RESTORE_MARKER), "{not json");
  assert.equal((await checkpoints.describe(target(repository))).restore.unreadable, true);
  await assert.rejects(checkpoints.recover(target(repository), "resume"), (error) => error.details.code === "CHECKPOINT_MARKER_UNREADABLE");
  await checkpoints.recover(target(repository), "keep");
  assert.equal((await checkpoints.describe(target(repository))).restore, null);
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
