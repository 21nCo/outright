import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdtemp, readFile, realpath, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { utilityBudgetUnavailable } from "./subprocess-budget.mjs";

// Checkpoints are Git objects in the worktree's own repository. Each one is a
// commit whose tree is every non-ignored file in the worktree (tracked and
// untracked, as on disk) and whose first parent is a commit of the index; the
// second parent, when there is one, is HEAD. A per-worktree ref keeps them
// reachable, so `git gc` keeps them and removing the worktree removes them.
// Ignored files are never captured, and restore never touches them.
export const CHECKPOINT_LIMITS = Object.freeze({
  perWorktree: 20,
  // Recorded content kept per worktree, newest first; older checkpoints are
  // removed and Git reclaims their objects in its next garbage collection.
  retainedBytes: 1024 * 1024 * 1024,
  fileBytes: 64 * 1024 * 1024,
  totalBytes: 256 * 1024 * 1024,
  files: 20_000,
  planEntries: 5_000,
  labelCharacters: 120,
  gitTimeoutMs: 120_000,
  diffBytes: 4 * 1024 * 1024,
});

export const CHECKPOINT_REF_PREFIX = "refs/worktree/outright/checkpoints/";
// Written in the worktree's own Git directory before a restore changes
// anything and removed once it has finished; its presence afterwards means
// the restore was interrupted.
export const RESTORE_MARKER = "outright-checkpoint-restore.json";
const ID_PATTERN = /^[0-9a-z]{6,12}-[0-9a-f]{8}$/;
const OID_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const MODE_PATTERN = /^(?:100644|100755|120000|160000)$/;
const EMPTY_TREES = { sha1: "4b825dc642cb6eb9a060e54bf8d69288fbee4904", sha256: "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321" };
const IDENTITY = { GIT_AUTHOR_NAME: "Outright", GIT_AUTHOR_EMAIL: "checkpoints@outright.invalid",
  GIT_COMMITTER_NAME: "Outright", GIT_COMMITTER_EMAIL: "checkpoints@outright.invalid" };
const IN_PROGRESS = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"];
// Exact paths go on the command line in bounded batches (Windows limits a
// command line to 32,767 characters).
const BATCH_CHARACTERS = 12_000;
const BATCH_PATHS = 256;

// `writers(paths)` lists agent runs, setup or teardown steps and other work
// that may write in the worktree now, as { code, message }; restore refuses
// while any is listed. `terminals(paths)` lists open terminals there, which
// the user must acknowledge. `onRelease` is called when a restore ends, so
// agent runs that waited for it can launch.
export function createWorktreeCheckpoints({ database, subprocesses, publish = () => {}, writers = () => [], terminals = () => [],
  onRelease = () => {}, limits = CHECKPOINT_LIMITS, now = () => new Date() }) {
  const active = new Map();
  let stopping = false;

  async function git(cwd, args, { env, maxBuffer = 16 * 1024 * 1024 } = {}) {
    const { stdout } = await subprocesses.run("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: limits.gitTimeoutMs,
      maxBuffer, ...(env ? { env: { ...process.env, ...env } } : {}) });
    return stdout;
  }
  // A command whose exit status 1 means "absent".
  async function optional(cwd, args) {
    try { return (await git(cwd, args)).trim() || null; }
    catch (error) { if (error.code === 1) return null; throw error; }
  }
  async function repository(cwd) {
    const [gitDir, indexPath, format] = (await git(cwd, ["rev-parse", "--absolute-git-dir", "--git-path", "index", "--show-object-format"])).trim().split("\n");
    return { gitDir, indexPath: path.resolve(cwd, indexPath), emptyTree: EMPTY_TREES[format] ?? EMPTY_TREES.sha1 };
  }

  // One checkpoint operation per worktree. Restore also holds the worktree
  // against agent runs and setup; the claim and the writer check are
  // synchronous, as the agent manager's launch fence is.
  function claim(target, kind) {
    if (stopping) throw checkpointError(503, "Runtime is shutting down", "RUNTIME_STOPPING");
    const paths = new Set([target.worktreePath, target.worktree?.path].filter(Boolean));
    const current = [...active.values()].find((entry) => [...paths].some((value) => entry.paths.has(value)));
    if (current) throw checkpointError(409, current.kind === "restore" ? "A restore is running in this worktree" : "Another checkpoint action is running in this worktree", "CHECKPOINT_BUSY");
    if (kind === "restore") {
      const blockers = writers([...paths]);
      if (blockers.length) throw checkpointError(409, `Restore refused: ${blockers.map((item) => item.message).join("; ")}`, "CHECKPOINT_WRITERS_ACTIVE", { blockers });
    }
    let resolveDone;
    const entry = { kind, paths, done: new Promise((resolve) => { resolveDone = resolve; }) };
    entry.release = () => {
      if (active.get(target.worktreePath) !== entry) return;
      active.delete(target.worktreePath);
      resolveDone();
      if (kind === "restore") onRelease();
    };
    active.set(target.worktreePath, entry);
    return entry;
  }
  function holding(worktreePath) {
    return [...active.values()].some((entry) => entry.kind === "restore" && entry.paths.has(worktreePath));
  }

  async function audited(action, details, mutate) {
    const evidence = { ...details, operationId: details.operationId ?? randomUUID() };
    database.auditAdmission(`${action}.requested`, evidence);
    let result;
    try { result = await mutate(evidence); }
    catch (error) {
      try { database.auditCritical(`${action}.failed`, { ...evidence, error: String(error.message ?? error).slice(0, 1024) }); }
      catch { /* The admission stays as the unresolved record. */ }
      throw error;
    }
    try { database.auditCritical(action, evidence); }
    catch (error) { throw checkpointError(503, `The ${action.split(".").at(-1)} finished, but its outcome could not be recorded (operation ${evidence.operationId})`, "OUTCOME_UNRECORDED", { operationId: evidence.operationId, outcomeUnknown: true }, error); }
    return result;
  }
  function changed(worktreePath) { publish({ type: "worktree.checkpoints", payload: { worktreePath } }); }

  // Large files are refused before Git copies anything into the object store.
  async function enforceBudget(cwd) {
    let listed;
    try { listed = await git(cwd, ["ls-files", "-z", "--modified", "--others", "--exclude-standard"], { maxBuffer: 32 * 1024 * 1024 }); }
    catch (error) {
      if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw checkpointError(413, `This worktree has more than ${limits.files} changed or untracked files`, "CHECKPOINT_TOO_LARGE");
      throw error;
    }
    // A trailing slash marks a nested repository, which is not captured.
    const files = [...new Set(listed.split("\0").filter((value) => value && !value.endsWith("/")))];
    if (files.length > limits.files) throw checkpointError(413, `This worktree has more than ${limits.files} changed or untracked files`, "CHECKPOINT_TOO_LARGE");
    let total = 0;
    for (const relative of files) {
      const info = await lstat(path.join(cwd, relative)).catch(() => null);
      if (!info?.isFile()) continue;
      if (info.size > limits.fileBytes) throw checkpointError(413, `${relative} is larger than ${mebibytes(limits.fileBytes)}; ignore or move it before taking a checkpoint`, "CHECKPOINT_TOO_LARGE", { path: relative });
      total += info.size;
      if (total > limits.totalBytes) throw checkpointError(413, `Changed and untracked files exceed ${mebibytes(limits.totalBytes)}; ignore or move large files before taking a checkpoint`, "CHECKPOINT_TOO_LARGE");
    }
    return total;
  }

  // The index and the files on disk as trees, through a copy of the index:
  // the worktree, its index and its refs are not changed.
  async function snapshot(cwd, repo, scratch) {
    const bytes = await enforceBudget(cwd);
    const index = path.join(scratch, `index-${randomUUID()}`);
    try { await copyFile(repo.indexPath, index); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const env = { GIT_INDEX_FILE: index };
    let indexTree;
    try { indexTree = (await git(cwd, ["write-tree"], { env })).trim(); }
    catch (error) {
      if (error.code !== 128) throw error;
      throw checkpointError(409, "Git could not record the index; resolve merge conflicts in this worktree first", "CHECKPOINT_UNMERGED");
    }
    await git(cwd, ["add", "-A"], { env });
    const filesTree = (await git(cwd, ["write-tree"], { env })).trim();
    const [head, branch] = await Promise.all([optional(cwd, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]),
      optional(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"])]);
    return { indexTree, filesTree, head, branch, bytes };
  }

  async function counts(cwd, repo, { indexTree, filesTree, head }) {
    const [staged, local] = await Promise.all([
      diffTrees(cwd, head ? `${head}^{tree}` : repo.emptyTree, indexTree),
      diffTrees(cwd, indexTree, filesTree).then((entries) => entries.filter((entry) => !nested(entry))),
    ]);
    return { staged: staged.length, unstaged: local.filter((entry) => entry.status !== "A").length, untracked: local.filter((entry) => entry.status === "A").length };
  }
  async function diffTrees(cwd, from, to, renames = false) {
    return parseRawDiff(await git(cwd, ["diff-tree", "-r", "-z", renames ? "-M" : "--no-renames", from, to], { maxBuffer: 64 * 1024 * 1024 }));
  }

  async function record(cwd, repo, trees, { label, reason, restoredFrom }) {
    const id = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const meta = { version: 1, id, label: cleanLabel(label, limits.labelCharacters), reason, createdAt: now().toISOString(),
      head: trees.head, branch: trees.branch, bytes: trees.bytes, counts: await counts(cwd, repo, trees), ...(restoredFrom ? { restoredFrom } : {}) };
    const parents = trees.head ? ["-p", trees.head] : [];
    const indexCommit = (await git(cwd, ["commit-tree", "--no-gpg-sign", trees.indexTree, ...parents, "-m", "Outright checkpoint index"], { env: IDENTITY })).trim();
    const commit = (await git(cwd, ["commit-tree", "--no-gpg-sign", trees.filesTree, "-p", indexCommit, ...parents,
      "-m", `Outright checkpoint: ${meta.label || id}\n\n${JSON.stringify(meta)}`], { env: IDENTITY })).trim();
    await git(cwd, ["update-ref", "-m", "Outright checkpoint", `${CHECKPOINT_REF_PREFIX}${id}`, commit, ""]);
    return { ...meta, commit };
  }

  async function stored(cwd) {
    const output = await git(cwd, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(contents:body)%00", CHECKPOINT_REF_PREFIX]);
    const parts = output.split("\0");
    const checkpoints = [];
    for (let index = 0; index + 2 < parts.length; index += 3) {
      const id = parts[index].trim().slice(CHECKPOINT_REF_PREFIX.length);
      if (ID_PATTERN.test(id)) checkpoints.push(readMeta(id, parts[index + 1].trim(), parts[index + 2]));
    }
    return checkpoints.sort((left, right) => right.id.localeCompare(left.id));
  }
  // A checkpoint's trees come from its commits, never from its message.
  async function load(cwd, id) {
    if (typeof id !== "string" || !ID_PATTERN.test(id)) throw checkpointError(400, "Checkpoint id is invalid", "CHECKPOINT_INVALID");
    const commit = await optional(cwd, ["rev-parse", "--verify", "--quiet", `${CHECKPOINT_REF_PREFIX}${id}^{commit}`]);
    if (!commit) throw checkpointError(404, "Checkpoint not found", "CHECKPOINT_NOT_FOUND");
    let filesTree, indexCommit, indexTree;
    try { [filesTree, indexCommit, indexTree] = (await git(cwd, ["rev-parse", `${commit}^{tree}`, `${commit}^1`, `${commit}^1^{tree}`])).trim().split("\n"); }
    catch (error) {
      if (error.code !== 128) throw error;
      throw checkpointError(409, "This checkpoint is damaged and cannot be read; delete it", "CHECKPOINT_DAMAGED");
    }
    const body = await git(cwd, ["log", "-1", "--format=%b", commit]);
    return { ...readMeta(id, commit, body), commit, filesTree, indexCommit, indexTree };
  }

  async function prune(cwd, keep) {
    try {
      let count = 0;
      let bytes = 0;
      for (const checkpoint of await stored(cwd)) {
        count += 1;
        bytes += checkpoint.bytes ?? 0;
        if (keep.has(checkpoint.id) || (count <= limits.perWorktree && bytes <= limits.retainedBytes)) continue;
        await git(cwd, ["update-ref", "-d", `${CHECKPOINT_REF_PREFIX}${checkpoint.id}`, checkpoint.commit]);
      }
    } catch (error) { if (utilityBudgetUnavailable(error)) throw error; /* Retention is retried on the next checkpoint. */ }
  }

  async function blockedByGit(repo) {
    if (await present(`${repo.indexPath}.lock`)) return [{ code: "GIT_INDEX_LOCKED", message: "Another Git command is writing this worktree's index" }];
    for (const name of IN_PROGRESS) {
      if (await present(path.join(repo.gitDir, name))) return [{ code: "GIT_OPERATION_IN_PROGRESS", message: "A merge, rebase, cherry-pick or revert is in progress; finish or abort it first" }];
    }
    return [];
  }

  // What restoring each path changes, from the current index and files to
  // the checkpoint's. A path whose directory and file forms both change is
  // coupled with the others, and they are restored together or not at all.
  async function plan(target, id, repo, scratch) {
    const cwd = target.worktreePath;
    const checkpoint = await load(cwd, id);
    const current = await snapshot(cwd, repo, scratch);
    const byPath = new Map();
    const entry = (relative) => byPath.get(relative) ?? byPath.set(relative, { path: relative, index: null, file: null }).get(relative);
    for (const change of await diffTrees(cwd, current.indexTree, checkpoint.indexTree)) {
      entry(change.path).index = change.status === "D" ? { action: "remove" } : { action: change.status === "A" ? "add" : "update", mode: change.dstMode, oid: change.dstOid };
    }
    for (const change of await diffTrees(cwd, current.filesTree, checkpoint.filesTree)) {
      if (nested(change)) continue;
      entry(change.path).file = { action: { A: "create", D: "delete" }[change.status] ?? "update" };
    }
    if (byPath.size > limits.planEntries) throw checkpointError(413, `Restoring would change more than ${limits.planEntries} paths`, "CHECKPOINT_TOO_LARGE");
    const entries = [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
    const group = new Map(entries.map((item) => [item.path, item.path]));
    const find = (value) => { while (group.get(value) !== value) value = group.get(value); return value; };
    for (const item of entries) {
      for (const ancestor of ancestors(item.path)) if (group.has(ancestor)) group.set(find(item.path), find(ancestor));
    }
    for (const item of entries) {
      if (item.file?.action !== "create") continue;
      // Anything already at a created path, or a file where it needs a
      // directory, is ignored or nested and was not captured: restore would
      // destroy it, so the path is not offered.
      if (await lstat(path.join(cwd, item.path)).then(() => true, () => false)) item.blocked = "An ignored file or directory is in the way";
      for (const ancestor of ancestors(item.path)) {
        const info = await lstat(path.join(cwd, ancestor)).catch(() => null);
        if (info && !info.isDirectory() && byPath.get(ancestor)?.file?.action !== "delete") item.blocked = `An ignored file is in the way at ${ancestor}`;
      }
    }
    const members = new Map();
    for (const item of entries) members.set(find(item.path), [...members.get(find(item.path)) ?? [], item]);
    for (const list of members.values()) {
      if (list.length < 2) continue;
      const blocked = list.find((item) => item.blocked);
      for (const item of list) {
        item.coupled = list.filter((other) => other !== item).map((other) => other.path);
        if (blocked && !item.blocked) item.blocked = `Restored together with ${blocked.path}, which is blocked`;
      }
    }
    const head = { current: current.head, checkpoint: checkpoint.head ?? null };
    const planDigest = createHash("sha256").update(JSON.stringify({ commit: checkpoint.commit, indexTree: current.indexTree,
      filesTree: current.filesTree, head: current.head, entries })).digest("hex");
    return { checkpoint, current, entries, head, planDigest };
  }

  async function readMarker(repo) {
    let text;
    try { text = await readFile(path.join(repo.gitDir, RESTORE_MARKER), "utf8"); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    try {
      const marker = JSON.parse(text);
      if (marker?.version === 1 && OID_PATTERN.test(marker.commit) && Array.isArray(marker.ops) && marker.ops.every(validOp)) return marker;
    } catch { /* Reported as unreadable below. */ }
    return { unreadable: true };
  }
  async function writeMarker(repo, marker) {
    const file = path.join(repo.gitDir, RESTORE_MARKER);
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(marker), { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  }
  async function clearMarker(repo) { await rm(path.join(repo.gitDir, RESTORE_MARKER), { force: true }); }

  // Every step is idempotent, so an interrupted restore can be applied again
  // from its marker: deletions, then file contents, then index entries.
  async function apply(cwd, marker, scratch) {
    const root = await realpath(cwd);
    for (const op of marker.ops) if (op.file === "delete") await removeFile(root, op.path);
    const writes = marker.ops.filter((op) => op.file === "write").map((op) => op.path);
    if (writes.length) {
      const list = path.join(scratch, `paths-${randomUUID()}`);
      await writeFile(list, `${writes.join("\0")}\0`, { mode: 0o600 });
      // Overlay mode writes only the listed files and removes nothing.
      await git(cwd, ["restore", "--overlay", `--source=${marker.commit}`, "--worktree", `--pathspec-from-file=${list}`, "--pathspec-file-nul"],
        { env: { GIT_LITERAL_PATHSPECS: "1" } });
    }
    // Exact paths, never pathspecs: a pathspec for `a` also matches `a/b`.
    for (const batch of batches(marker.ops.filter((op) => op.index === "remove").map((op) => op.path))) {
      await git(cwd, ["update-index", "--force-remove", "--", ...batch]);
    }
    for (const batch of batches(marker.ops.filter((op) => op.index && op.index !== "remove").map((op) => `${op.index.mode},${op.index.oid},${op.path}`))) {
      await git(cwd, ["update-index", "--add", ...batch.flatMap((value) => ["--cacheinfo", value])]);
    }
  }

  function target(value) { return value.worktreePath; }

  async function describe(value) {
    const cwd = target(value);
    const repo = await repository(cwd);
    const [checkpoints, marker] = await Promise.all([stored(cwd), readMarker(repo)]);
    const running = [...active.values()].find((entry) => entry.paths.has(cwd));
    let restore = null;
    if (running?.kind === "restore") restore = { status: "running" };
    else if (marker) restore = { status: "interrupted", unreadable: Boolean(marker.unreadable), checkpointId: marker.checkpointId ?? null,
      safetyCheckpointId: marker.safetyCheckpointId ?? null, startedAt: marker.startedAt ?? null, paths: marker.ops?.length ?? 0 };
    return { worktreePath: cwd, checkpoints, restore, busy: running?.kind ?? null,
      limits: { perWorktree: limits.perWorktree, retainedBytes: limits.retainedBytes, fileBytes: limits.fileBytes, totalBytes: limits.totalBytes } };
  }

  async function capture(value, { label } = {}) {
    const cwd = target(value);
    const entry = claim(value, "capture");
    try {
      return await withScratch(async (scratch) => {
        const repo = await repository(cwd);
        const marker = await readMarker(repo);
        const checkpoint = await audited("worktree.checkpoint.capture", { target: cwd }, async (evidence) => {
          const created = await record(cwd, repo, await snapshot(cwd, repo, scratch), { label, reason: "manual" });
          evidence.checkpointId = created.id;
          return created;
        });
        await prune(cwd, new Set([checkpoint.id, marker?.checkpointId, marker?.safetyCheckpointId].filter(Boolean)));
        changed(cwd);
        return checkpoint;
      });
    } finally { entry.release(); }
  }

  async function inspect(value, id) {
    const cwd = target(value);
    const repo = await repository(cwd);
    const checkpoint = await load(cwd, id);
    const [staged, local] = await Promise.all([
      diffTrees(cwd, checkpoint.head ? `${checkpoint.head}^{tree}` : repo.emptyTree, checkpoint.indexTree, true),
      diffTrees(cwd, checkpoint.indexTree, checkpoint.filesTree).then((list) => list.filter((change) => !nested(change))),
    ]);
    const entries = [
      ...staged.map((change) => ({ path: change.path, originalPath: change.originalPath, state: "staged", status: change.status })),
      ...local.map((change) => ({ path: change.path, state: change.status === "A" ? "untracked" : "unstaged", status: change.status })),
    ];
    return { checkpoint, entries: entries.slice(0, limits.planEntries), truncated: entries.length > limits.planEntries };
  }

  async function preview(value, id) {
    const cwd = target(value);
    return withScratch(async (scratch) => {
      const repo = await repository(cwd);
      const marker = await readMarker(repo);
      const result = await plan(value, id, repo, scratch);
      const paths = [...new Set([cwd, value.worktree?.path].filter(Boolean))];
      const blockers = [...writers(paths), ...await blockedByGit(repo),
        ...(marker ? [{ code: "CHECKPOINT_RESTORE_INTERRUPTED", message: "An earlier restore did not finish; finish it or keep the files first" }] : [])];
      return { checkpoint: publicCheckpoint(result.checkpoint), planDigest: result.planDigest, currentTree: result.current.filesTree,
        head: { ...result.head, moved: result.head.current !== result.head.checkpoint }, entries: result.entries, blockers,
        terminals: terminals(paths) };
    });
  }

  async function restore(value, { id, planDigest, paths, acknowledgeTerminals = [] } = {}) {
    const cwd = target(value);
    if (typeof planDigest !== "string" || !/^[0-9a-f]{64}$/.test(planDigest)) throw checkpointError(400, "Restore needs the preview it confirms", "CHECKPOINT_PREVIEW_REQUIRED");
    if (!Array.isArray(paths) || !paths.length || paths.length > limits.planEntries || !paths.every((item) => typeof item === "string")) {
      throw checkpointError(400, "Choose at least one path to restore", "CHECKPOINT_SELECTION_INVALID");
    }
    const entry = claim(value, "restore");
    try {
      return await withScratch(async (scratch) => {
        const repo = await repository(cwd);
        if (await readMarker(repo)) throw checkpointError(409, "An earlier restore did not finish; finish it or keep the files first", "CHECKPOINT_RESTORE_INTERRUPTED");
        const gitBlockers = await blockedByGit(repo);
        if (gitBlockers.length) throw checkpointError(409, `Restore refused: ${gitBlockers[0].message}`, "CHECKPOINT_WRITERS_ACTIVE", { blockers: gitBlockers });
        const open = terminals([...entry.paths]);
        const acknowledged = new Set(Array.isArray(acknowledgeTerminals) ? acknowledgeTerminals : []);
        if (open.some((terminal) => !acknowledged.has(terminal.id))) {
          throw checkpointError(409, "Confirm the terminals open in this worktree before restoring", "CHECKPOINT_TERMINALS_UNACKNOWLEDGED", { terminals: open });
        }
        const result = await plan(value, id, repo, scratch);
        if (result.planDigest !== planDigest) throw checkpointError(409, "The worktree changed after the preview; review the new preview before restoring", "CHECKPOINT_PLAN_CHANGED");
        const ops = selectedOps(result.entries, paths);
        const safety = await record(cwd, repo, result.current, { label: `Before restoring ${result.checkpoint.label || id}`, reason: "before-restore", restoredFrom: id });
        await prune(cwd, new Set([id, safety.id]));
        const marker = { version: 1, operationId: randomUUID(), checkpointId: id, commit: result.checkpoint.commit,
          safetyCheckpointId: safety.id, startedAt: now().toISOString(), ops };
        await audited("worktree.checkpoint.restore", { target: cwd, checkpointId: id, safetyCheckpointId: safety.id,
          operationId: marker.operationId, paths: ops.length }, async () => {
          await writeMarker(repo, marker);
          try { await apply(cwd, marker, scratch); }
          catch (error) { throw interrupted(error, safety); }
          await clearMarker(repo);
        });
        return { restored: ops.length, safetyCheckpoint: publicCheckpoint(safety) };
      });
    } finally {
      entry.release();
      changed(cwd);
    }
  }

  // An interrupted restore is finished from its marker or left as it is;
  // the checkpoint taken before it keeps the earlier state either way.
  async function recover(value, action) {
    const cwd = target(value);
    if (!["resume", "keep"].includes(action)) throw checkpointError(400, "Choose to finish the restore or keep the files", "CHECKPOINT_RECOVERY_INVALID");
    const entry = claim(value, action === "resume" ? "restore" : "recover");
    try {
      return await withScratch(async (scratch) => {
        const repo = await repository(cwd);
        const marker = await readMarker(repo);
        if (!marker) throw checkpointError(409, "No restore is waiting to finish", "CHECKPOINT_NO_INTERRUPTED_RESTORE");
        if (action === "keep") {
          await audited("worktree.checkpoint.restore.kept", { target: cwd, checkpointId: marker.checkpointId ?? null, operationId: marker.operationId }, () => clearMarker(repo));
          return { kept: true };
        }
        if (marker.unreadable) throw checkpointError(409, "The interrupted restore's record is unreadable; keep the files and restore again", "CHECKPOINT_MARKER_UNREADABLE");
        const gitBlockers = await blockedByGit(repo);
        if (gitBlockers.length) throw checkpointError(409, `Restore refused: ${gitBlockers[0].message}`, "CHECKPOINT_WRITERS_ACTIVE", { blockers: gitBlockers });
        await audited("worktree.checkpoint.restore.resumed", { target: cwd, checkpointId: marker.checkpointId, operationId: marker.operationId }, async () => {
          try { await apply(cwd, marker, scratch); }
          catch (error) { throw interrupted(error, { id: marker.safetyCheckpointId }); }
          await clearMarker(repo);
        });
        return { restored: marker.ops.length };
      });
    } finally {
      entry.release();
      changed(cwd);
    }
  }

  async function remove(value, id) {
    const cwd = target(value);
    const entry = claim(value, "delete");
    try {
      const repo = await repository(cwd);
      const checkpoint = await load(cwd, id);
      if (await readMarker(repo)) throw checkpointError(409, "Finish or keep the interrupted restore before deleting checkpoints", "CHECKPOINT_RESTORE_INTERRUPTED");
      await audited("worktree.checkpoint.delete", { target: cwd, checkpointId: id }, () =>
        git(cwd, ["update-ref", "-d", `${CHECKPOINT_REF_PREFIX}${id}`, checkpoint.commit]));
      changed(cwd);
      return { deleted: true };
    } finally { entry.release(); }
  }

  // One file's change from the previewed state to the checkpoint.
  async function fileDiff(value, { id, tree, file }) {
    const cwd = target(value);
    if (typeof tree !== "string" || !OID_PATTERN.test(tree)) throw checkpointError(400, "Preview tree is invalid", "CHECKPOINT_INVALID");
    if (typeof file !== "string" || !file || file.includes("\0") || !isWithin(cwd, path.resolve(cwd, file))) throw checkpointError(400, "File path is invalid", "CHECKPOINT_INVALID");
    const checkpoint = await load(cwd, id);
    try {
      return { diff: await git(cwd, ["-c", "core.quotePath=false", "diff", "--no-ext-diff", "--no-textconv", "--unified=3", tree, checkpoint.commit, "--", file],
        { env: { GIT_LITERAL_PATHSPECS: "1" }, maxBuffer: limits.diffBytes }) };
    } catch (error) {
      if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return { diff: "", tooLarge: true };
      if (error.code === 128) throw checkpointError(409, "This preview is no longer available; open the preview again", "CHECKPOINT_PREVIEW_STALE");
      throw error;
    }
  }

  async function shutdown() {
    stopping = true;
    await Promise.all([...active.values()].map((entry) => entry.done));
  }

  return { describe, capture, inspect, preview, restore, recover, remove, fileDiff, holding, shutdown };
}

// Raw `diff-tree -z` records: ":<mode> <mode> <oid> <oid> <status>\0<path>\0",
// with the original path first for a rename or copy.
export function parseRawDiff(output) {
  const parts = output.split("\0");
  const entries = [];
  for (let index = 0; index < parts.length - 1;) {
    const header = parts[index++];
    if (!header.startsWith(":")) continue;
    const [srcMode, dstMode, srcOid, dstOid, status = ""] = header.slice(1).split(" ");
    const entry = { srcMode, dstMode, srcOid, dstOid, status: status[0], path: parts[index++] };
    if (entry.status === "R" || entry.status === "C") { entry.originalPath = entry.path; entry.path = parts[index++]; }
    entries.push(entry);
  }
  return entries;
}

// The confirmed paths as replayable operations. A selection must name whole
// coupled groups and no blocked path.
export function selectedOps(entries, paths) {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const chosen = new Set(paths);
  for (const relative of chosen) {
    const entry = byPath.get(relative);
    if (!entry) throw checkpointError(409, `${relative} is not part of this restore`, "CHECKPOINT_SELECTION_INVALID");
    if (entry.blocked) throw checkpointError(409, `${relative} cannot be restored: ${entry.blocked}`, "CHECKPOINT_SELECTION_INVALID");
    const missing = (entry.coupled ?? []).find((other) => !chosen.has(other));
    if (missing) throw checkpointError(409, `${relative} must be restored together with ${missing}`, "CHECKPOINT_SELECTION_INVALID");
  }
  return [...chosen].sort().map((relative) => {
    const entry = byPath.get(relative);
    const index = entry.index && (entry.index.action === "remove" ? "remove" : { mode: entry.index.mode, oid: entry.index.oid });
    return { path: relative, file: entry.file && (entry.file.action === "delete" ? "delete" : "write"), index: index ?? null };
  });
}

function validOp(op) {
  if (!op || typeof op.path !== "string" || !op.path || op.path.includes("\0") || path.isAbsolute(op.path) || op.path.split(/[\\/]/).includes("..")) return false;
  if (![null, "write", "delete"].includes(op.file)) return false;
  return op.index === null || op.index === "remove" || (MODE_PATTERN.test(op.index?.mode) && OID_PATTERN.test(op.index?.oid));
}

function readMeta(id, commit, body) {
  let meta = null;
  try { meta = JSON.parse(body.trim()); } catch { /* Reported as unreadable. */ }
  if (!meta || meta.id !== id) return { id, commit, label: "", unreadable: true };
  const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  return { id, commit, label: typeof meta.label === "string" ? meta.label : "", reason: meta.reason === "before-restore" ? "before-restore" : "manual",
    createdAt: typeof meta.createdAt === "string" ? meta.createdAt : null, head: OID_PATTERN.test(meta.head ?? "") ? meta.head : null,
    branch: typeof meta.branch === "string" ? meta.branch : null, bytes: count(meta.bytes),
    counts: { staged: count(meta.counts?.staged), unstaged: count(meta.counts?.unstaged), untracked: count(meta.counts?.untracked) },
    restoredFrom: typeof meta.restoredFrom === "string" ? meta.restoredFrom : null };
}

function publicCheckpoint({ id, commit, label, reason, createdAt, head, branch, bytes, counts, restoredFrom, unreadable }) {
  return { id, commit, label, reason, createdAt, head, branch, bytes, counts, restoredFrom: restoredFrom ?? null, ...(unreadable ? { unreadable } : {}) };
}

// Submodules and nested repositories are recorded as commit pointers, not
// files; restore leaves their contents alone.
function nested(change) { return change.srcMode === "160000" || change.dstMode === "160000"; }

function ancestors(relative) {
  const parts = relative.split("/");
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
}

async function removeFile(root, relative) {
  const target = path.join(root, relative);
  // A parent replaced by a link must not lead a deletion out of the worktree.
  const parent = await realpath(path.dirname(target)).catch(() => null);
  if (!parent || !isWithin(root, parent)) return;
  const info = await lstat(target).catch(() => null);
  if (!info || info.isDirectory()) return;
  await unlink(target);
  // Like Git, remove directories the deletion left empty.
  for (let directory = path.dirname(target); directory !== root && isWithin(root, directory); directory = path.dirname(directory)) {
    try { await rmdir(directory); } catch { break; }
  }
}

function batches(values) {
  const result = [];
  let current = [];
  let characters = 0;
  for (const value of values) {
    if (current.length && (current.length >= BATCH_PATHS || characters + value.length > BATCH_CHARACTERS)) { result.push(current); current = []; characters = 0; }
    current.push(value);
    characters += value.length + 1;
  }
  if (current.length) result.push(current);
  return result;
}

async function withScratch(work) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "outright-checkpoint-"));
  try { return await work(scratch); }
  finally { await rm(scratch, { recursive: true, force: true }).catch(() => {}); }
}

function interrupted(cause, safety) {
  const before = safety?.id ? `; checkpoint ${safety.id} holds the state from before` : "";
  return checkpointError(409, `Restore stopped before finishing (${String(cause?.message ?? cause).slice(0, 300)}). Finish it or keep the files as they are${before}`,
    "CHECKPOINT_RESTORE_INTERRUPTED", { safetyCheckpointId: safety?.id ?? null }, cause);
}

function cleanLabel(label, limit) {
  // eslint-disable-next-line no-control-regex
  return typeof label === "string" ? label.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, limit) : "";
}
function mebibytes(bytes) { return `${Math.round(bytes / (1024 * 1024))} MiB`; }
async function present(target) { try { await lstat(target); return true; } catch { return false; } }
function isWithin(root, target) { const relative = path.relative(root, target); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); }
function checkpointError(statusCode, message, code, extra = {}, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.statusCode = statusCode;
  error.details = { code, ...extra };
  return error;
}
