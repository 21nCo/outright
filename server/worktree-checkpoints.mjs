import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rename, rm, rmdir, stat, unlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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
  // Staged content and changed or untracked files, counted per path, and
  // paths that differ from HEAD, deletions included.
  fileBytes: 64 * 1024 * 1024,
  totalBytes: 256 * 1024 * 1024,
  files: 10_000,
  // A restore changes the paths the checkpoint and the current state differ
  // from HEAD by, so this is at least twice `files`: a restore onto the
  // commit the checkpoint was taken on is never too large. (A restore first
  // checkpoints the current state, so that must be within the limits too.)
  planEntries: 20_000,
  labelCharacters: 120,
  gitTimeoutMs: 120_000,
  diffBytes: 4 * 1024 * 1024,
});

export const CHECKPOINT_REF_PREFIX = "refs/worktree/outright/checkpoints/";
// Written in the worktree's own Git directory before a restore changes
// anything and removed once it has finished; while it is there, the restore
// did not finish and the worktree is held against other writers.
export const RESTORE_MARKER = "outright-checkpoint-restore.json";
// Written beside it when a stage, unstage or commit loses track of its Git
// process, and removed once no such process is left.
export const WRITE_MARKER = "outright-git-write-unconfirmed";
const ID_PATTERN = /^[0-9a-z]{6,12}-[0-9a-f]{8}$/;
const OID_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const REGULAR_MODE = /^100(?:644|755)$/;
const EMPTY_TREES = { sha1: "4b825dc642cb6eb9a060e54bf8d69288fbee4904", sha256: "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321" };
const IDENTITY = { GIT_AUTHOR_NAME: "Outright", GIT_AUTHOR_EMAIL: "checkpoints@outright.invalid",
  GIT_COMMITTER_NAME: "Outright", GIT_COMMITTER_EMAIL: "checkpoints@outright.invalid" };
const LITERAL = { GIT_LITERAL_PATHSPECS: "1" };
const IN_PROGRESS = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"];
// Exact paths go on the command line in bounded batches (Windows limits a
// command line to 32,767 characters); each value counts with room for its
// quoting and an option before it, as `--cacheinfo`.
const BATCH_CHARACTERS = 12_000;
const BATCH_OVERHEAD = 16;
const BATCH_PATHS = 256;
const RUNNING = "CHECKPOINT_RESTORE_RUNNING";
const UNFINISHED = "CHECKPOINT_RESTORE_INTERRUPTED";
const STRAY = "GIT_WRITE_UNCONFIRMED";
// Another Git command may hold the index lock for a moment; a restore's
// index writes wait for it this long.
const INDEX_LOCK_RETRIES = 20;
const INDEX_LOCK_WAIT_MS = 250;

// `writers(paths)` lists agent runs, setup or teardown steps and other work
// that may write in the worktree now, as { code, message }; restore refuses
// while any is listed. `terminals(paths)` lists open terminals there, which
// the user must acknowledge. `onRelease` is called when a worktree is no
// longer held by a restore, so agent runs that waited for it can launch;
// `reconcile()` is called when the utility budget proves owners gone.
export function createWorktreeCheckpoints({ database, subprocesses, publish = () => {}, writers = () => [], terminals = () => [],
  onRelease = () => {}, limits = CHECKPOINT_LIMITS, now = () => new Date() }) {
  if (limits.planEntries < 2 * limits.files) throw new Error("Checkpoint planEntries must be at least twice files");
  const active = new Map();
  // Git stages, unstages and commits, and terminal launches, admitted
  // through `admitWriter`.
  const admitted = new Set();
  // Worktrees whose restore lost track of a Git process it started, and
  // those whose stage, unstage or commit did (also kept in WRITE_MARKER).
  const unconfirmed = new Set();
  const strays = new Set();
  const gitDirs = new Map();
  let stopping = false;

  async function git(cwd, args, { env, maxBuffer = 16 * 1024 * 1024, encoding = "utf8" } = {}) {
    const { stdout } = await subprocesses.run("git", ["-C", cwd, ...args], { encoding, timeout: limits.gitTimeoutMs,
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
    gitDirs.set(cwd, gitDir);
    return { gitDir, indexPath: path.resolve(cwd, indexPath), emptyTree: EMPTY_TREES[format] ?? EMPTY_TREES.sha1 };
  }

  // The worktree's Git directory without running Git, for the synchronous
  // admission checks: `.git` is the directory or a file naming it.
  function gitDirOf(worktreePath) {
    if (gitDirs.has(worktreePath)) return gitDirs.get(worktreePath);
    const dotGit = path.join(worktreePath, ".git");
    try {
      if (lstatSync(dotGit).isDirectory()) return dotGit;
      const match = /^gitdir: *(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"));
      return match ? path.resolve(worktreePath, match[1]) : null;
    } catch { return null; }
  }
  function markerPresent(worktreePath, name = RESTORE_MARKER) {
    const gitDir = gitDirOf(worktreePath);
    if (!gitDir) return false;
    try { lstatSync(path.join(gitDir, name)); return true; }
    // Anything but a missing marker keeps the worktree held.
    catch (error) { return !["ENOENT", "ENOTDIR"].includes(error.code); }
  }

  // The utility budget keeps every Git process whose owner was lost, across
  // restarts too, until it proves it gone. Once none is left, worktrees held
  // only for such processes are released and the runs waiting for them can
  // launch. True when that is so.
  function reconcile() {
    if ((subprocesses.capacity?.().unknown ?? 0) > 0) return false;
    const released = [...new Set([...unconfirmed, ...strays])];
    unconfirmed.clear();
    strays.clear();
    for (const value of released) {
      const gitDir = gitDirOf(value);
      try { if (gitDir) rmSync(path.join(gitDir, WRITE_MARKER), { force: true }); }
      catch { strays.add(value); }
      changed(value);
    }
    if (released.length) queueMicrotask(onRelease);
    return true;
  }
  function strayWrite(worktreePath) {
    if (!strays.has(worktreePath) && !markerPresent(worktreePath, WRITE_MARKER)) return false;
    strays.add(worktreePath);
    return !reconcile();
  }

  // Why another writer may not start in a worktree now, or null: a restore
  // is running, or one did not finish (its marker is in the Git directory,
  // which survives a restart, or a Git process it started is unconfirmed),
  // or a stage, unstage or commit there lost track of its Git process.
  function holding(worktreePath) {
    if ([...active.values()].some((entry) => entry.kind === "restore" && entry.paths.has(worktreePath))) return RUNNING;
    if (unconfirmed.has(worktreePath) || markerPresent(worktreePath)) return UNFINISHED;
    return strayWrite(worktreePath) ? STRAY : null;
  }

  // Admits an application-owned writer (a Git stage, unstage or commit, or
  // a terminal launch) unless a restore holds the worktree; a restore is
  // refused while one is admitted. Synchronous, as `claim` is. Returns the
  // release, which takes the write's failure: a Git write that lost track of
  // its process keeps the worktree held, across restarts too.
  function admitWriter(paths, kind = "git") {
    const code = paths.map(holding).find(Boolean);
    if (code) throw checkpointError(409, holdMessage(code, "try again"), code);
    const token = { paths: new Set(paths), kind };
    admitted.add(token);
    return (error) => {
      admitted.delete(token);
      if (kind !== "git" || !ownershipUnknown(error)) return;
      for (const value of paths) {
        strays.add(value);
        const gitDir = gitDirOf(value);
        try { if (gitDir) writeFileSync(path.join(gitDir, WRITE_MARKER), `${now().toISOString()}\n`, { mode: 0o600 }); }
        catch { /* Held in memory until the process is proven gone. */ }
      }
    };
  }
  function gitWriters(paths) {
    const found = [];
    for (const token of admitted) {
      if (![...paths].some((value) => token.paths.has(value))) continue;
      found.push(token.kind === "terminal" ? { code: "TERMINAL_STARTING", message: "a terminal is starting in this worktree" }
        : { code: "GIT_WRITE_ACTIVE", message: "a Git stage, unstage or commit is running in this worktree" });
    }
    if ([...paths].some(strayWrite)) found.push({ code: STRAY, message: "a Git stage, unstage or commit here is not confirmed stopped" });
    return found;
  }

  // One checkpoint operation per worktree. Restore also holds the worktree
  // against agent runs, setup and Git writes; the claim and the writer check
  // are synchronous, as the agent manager's launch fence is.
  function claim(target, kind) {
    if (stopping) throw checkpointError(503, "Runtime is shutting down", "RUNTIME_STOPPING");
    const paths = pathsOf(target);
    const current = [...active.values()].find((entry) => [...paths].some((value) => entry.paths.has(value)));
    if (current) throw checkpointError(409, current.kind === "restore" ? "A restore is running in this worktree" : "Another checkpoint action is running in this worktree", "CHECKPOINT_BUSY");
    if (kind === "restore") {
      const blockers = [...writers([...paths]), ...gitWriters(paths)];
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

  // Git processes a restore started and lost track of may still write, and
  // after a crash nothing says whether it did: an interrupted restore cannot
  // be finished or dismissed until the utility budget has proven every
  // process whose owner was lost gone.
  function ownerPending(target, marker) {
    const paths = [...pathsOf(target)];
    if (!marker && !paths.some((value) => unconfirmed.has(value))) return false;
    if (reconcile()) return false;
    // Remembered, so the release is signalled once the owners are proven gone.
    for (const value of paths) unconfirmed.add(value);
    return true;
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

  // Object sizes of the blobs at exact paths in a tree.
  async function blobs(cwd, treeish, paths) {
    const found = new Map();
    for (const batch of batches(paths)) {
      const listed = await git(cwd, ["ls-tree", "-l", "-z", "--full-tree", treeish, "--", ...batch], { env: LITERAL, maxBuffer: 32 * 1024 * 1024 });
      for (const record of listed.split("\0")) {
        const tab = record.indexOf("\t");
        if (tab < 0) continue;
        const [mode, type, oid, size] = record.slice(0, tab).trim().split(/\s+/);
        if (type === "blob") found.set(record.slice(tab + 1), { mode, oid, size: Number(size) });
      }
    }
    return found;
  }

  // Content filters configured for this repository, switched off for Git's
  // own content comparisons (a command that writes an index compares the
  // entries as new as it), so no clean filter runs and a failing required
  // one cannot stop a capture or restore; and whether Git tracks the
  // executable bit and makes symbolic links.
  async function captureSettings(cwd) {
    let listed = "";
    try { listed = await git(cwd, ["config", "-z", "--get-regexp", "^(filter\\..+\\.(clean|process|required)|core\\.(filemode|symlinks))$"]); }
    catch (error) { if (error.code !== 1) throw error; }
    const names = new Set();
    const settings = { "core.filemode": true, "core.symlinks": true };
    for (const record of listed.split("\0")) {
      const key = record.split("\n", 1)[0];
      const filter = /^filter\.(.+)\.(?:clean|process|required)$/.exec(key);
      if (filter) names.add(filter[1]);
      else if (key in settings) settings[key] = !/^(?:false|no|off|0)$/i.test(record.slice(key.length + 1).trim());
    }
    return { fileMode: settings["core.filemode"], symlinks: settings["core.symlinks"], unfiltered: [...names].flatMap((name) => ["-c", `filter.${name}.clean=`, "-c", `filter.${name}.process=`, "-c", `filter.${name}.required=false`]) };
  }

  // Index entries ({ mode, oid }) at exact paths.
  async function indexEntries(cwd, env, paths) {
    const found = new Map();
    for (const record of (await git(cwd, ["ls-files", "-s", "-z", "--", ...paths], { env: { ...env, ...LITERAL } })).split("\0")) {
      const tab = record.indexOf("\t");
      if (tab >= 0) { const [mode, oid] = record.slice(0, tab).split(" "); found.set(record.slice(tab + 1), { mode, oid }); }
    }
    return found;
  }

  // The index and the files on disk as trees, through a copy of the index:
  // the worktree, its index and its refs are not changed. Files are recorded
  // byte for byte: no clean filter, line-ending conversion or encoding
  // applies, so a restore writes back exactly what was on disk. Nested
  // repositories and their contents are left out. Everything stored beyond
  // HEAD counts against the budget, which `when` names in its refusal:
  // staged content (even when the file on disk matches it), changed and
  // untracked files, and every staged or unstaged deletion.
  async function snapshot(cwd, repo, scratch, when = "before taking a checkpoint") {
    const index = path.join(scratch, `index-${randomUUID()}`);
    try {
      // Git trusts an entry's stat data unless the entry is as new as the
      // index file, so the copy keeps the index's times (read first, never
      // newer than its content): a same-size edit in the second of the last
      // index write is still compared by content.
      const { atime, mtime } = await stat(repo.indexPath);
      await copyFile(repo.indexPath, index);
      await utimes(index, atime, mtime);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const env = { GIT_INDEX_FILE: index };
    const settings = await captureSettings(cwd);
    const temporary = (args, options) => git(cwd, [...settings.unfiltered, ...args], { ...options, env });
    let indexTree;
    try { indexTree = (await temporary(["write-tree"])).trim(); }
    catch (error) {
      if (error.code !== 128) throw error;
      throw checkpointError(409, "Git could not record the index; resolve merge conflicts in this worktree first", "CHECKPOINT_UNMERGED");
    }
    const [head, branch] = await Promise.all([optional(cwd, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]),
      optional(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"])]);
    const tooMany = () => checkpointError(413, `This worktree has more than ${limits.files} changed, staged, deleted or untracked files; ignore, commit or remove some ${when}`, "CHECKPOINT_TOO_LARGE");
    const staged = (await diffTrees(cwd, head ? `${head}^{tree}` : repo.emptyTree, indexTree)).filter((change) => !nested(change));
    let listed;
    try { listed = await temporary(["ls-files", "-z", "--modified", "--others", "--exclude-standard"], { maxBuffer: 32 * 1024 * 1024 }); }
    catch (error) { throw error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? tooMany() : error; }
    // A trailing slash marks a nested repository, which is not captured.
    const changedPaths = [...new Set(listed.split("\0").filter((value) => value && !value.endsWith("/")))];
    if (new Set([...staged.map((change) => change.path), ...changedPaths]).size > limits.files) throw tooMany();
    let bytes = 0;
    const count = (relative, size) => {
      if (size > limits.fileBytes) throw checkpointError(413, `${relative} is larger than ${mebibytes(limits.fileBytes)}; ignore, unstage or move it ${when}`, "CHECKPOINT_TOO_LARGE", { path: relative });
      bytes += size;
      if (bytes > limits.totalBytes) throw checkpointError(413, `Staged, changed and untracked files exceed ${mebibytes(limits.totalBytes)}; ignore, unstage or move large files ${when}`, "CHECKPOINT_TOO_LARGE");
    };
    for (const [relative, blob] of await blobs(cwd, indexTree, staged.filter((change) => change.status !== "D").map((change) => change.path))) count(relative, blob.size);
    // Large files are refused before anything is copied into the object store.
    const found = new Map();
    for (const relative of changedPaths) {
      const info = await lstat(path.join(cwd, relative)).catch(() => null);
      if (info?.isFile()) count(relative, info.size);
      found.set(relative, info);
    }
    for (const batch of batches(changedPaths)) {
      const entries = await indexEntries(cwd, env, batch);
      const removed = [];
      const hashed = [];
      for (const relative of batch) {
        const info = found.get(relative);
        const entry = entries.get(relative);
        if (entry?.mode === "160000") continue;
        if (!info || info.isDirectory()) { if (entry) removed.push(relative); continue; }
        if (info.isSymbolicLink()) {
          const link = path.join(scratch, `link-${randomUUID()}`);
          await writeFile(link, await readlink(path.join(cwd, relative), { encoding: "buffer" }));
          hashed.push({ relative, source: link, mode: "120000", entry });
        } else if (info.isFile()) {
          // The type on disk, except where Git keeps a link as a file holding
          // its target, or does not track the executable bit.
          const executable = settings.fileMode ? (info.mode & 0o111) !== 0 : entry?.mode === "100755";
          const link = !settings.symlinks && entry?.mode === "120000";
          hashed.push({ relative, source: relative, mode: link ? "120000" : executable ? "100755" : "100644", entry });
        }
      }
      const oids = [];
      for (const sources of batches(hashed.map((item) => item.source))) {
        oids.push(...(await git(cwd, ["hash-object", "-w", "--no-filters", "--", ...sources])).trim().split("\n"));
      }
      const updates = hashed.map((item, position) => ({ ...item, oid: oids[position] }))
        .filter((item) => OID_PATTERN.test(item.oid ?? "") && (item.entry?.mode !== item.mode || item.entry?.oid !== item.oid));
      if (removed.length) await temporary(["update-index", "--force-remove", "--", ...removed]);
      for (const batch of batches(updates.map((item) => `${item.mode},${item.oid},${item.relative}`))) {
        await temporary(["update-index", "--add", "--replace", ...batch.flatMap((value) => ["--cacheinfo", value])]);
      }
    }
    const filesTree = (await temporary(["write-tree"])).trim();
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

  // A file or link under a directory where a file is restored that the
  // restore does not delete: it is ignored or nested and was not captured.
  async function uncaptured(cwd, directory, byPath) {
    const pending = [directory];
    let visited = 0;
    while (pending.length) {
      const current = pending.pop();
      for (const child of await readdir(path.join(cwd, current), { withFileTypes: true })) {
        const relative = `${current}/${child.name}`;
        if ((visited += 1) > limits.planEntries) return relative;
        if (child.isDirectory()) pending.push(relative);
        else if (byPath.get(relative)?.file?.action !== "delete") return relative;
      }
    }
    return null;
  }

  // What restoring each path changes, from the current index and files to
  // the checkpoint's. A path whose directory and file forms both change, or
  // a file whose name changes only by case or Unicode form on a filesystem
  // that does not tell them apart, is coupled with the others: they share a
  // `group` of `groupSize` paths, restored together or not at all. Finishing
  // an interrupted restore (`resumed`, its marker) offers only the paths it
  // was restoring.
  async function plan(target, id, repo, scratch, resumed = null) {
    const cwd = target.worktreePath;
    const checkpoint = await load(cwd, id);
    // The restore checkpoints the current state first, within the same limits.
    const current = await snapshot(cwd, repo, scratch, "before restoring: the restore first takes a checkpoint of the worktree as it is");
    const [indexChanges, fileChanges, recordedRaw] = await Promise.all([
      diffTrees(cwd, current.indexTree, checkpoint.indexTree),
      diffTrees(cwd, current.filesTree, checkpoint.filesTree),
      // A checkpoint file that differs from its index entry was recorded
      // byte for byte, and is written back as it is.
      diffTrees(cwd, checkpoint.indexTree, checkpoint.filesTree).then((list) => new Set(list.map((change) => change.path))),
    ]);
    const byPath = new Map();
    const entry = (relative) => byPath.get(relative) ?? byPath.set(relative, { path: relative, index: null, file: null }).get(relative);
    for (const change of indexChanges) {
      entry(change.path).index = change.status === "D" ? { action: "remove" } : { action: change.status === "A" ? "add" : "update", mode: change.dstMode, oid: change.dstOid };
    }
    for (const change of fileChanges) {
      if (nested(change)) continue;
      entry(change.path).file = change.status === "D" ? { action: "delete" } : { action: change.status === "A" ? "create" : "update",
        mode: change.dstMode, oid: change.dstOid, raw: REGULAR_MODE.test(change.dstMode) && recordedRaw.has(change.path) };
    }
    if (byPath.size > limits.planEntries) throw checkpointError(413, `Restoring would change more than ${limits.planEntries} paths`, "CHECKPOINT_TOO_LARGE");
    const entries = [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
    const group = new Map(entries.map((item) => [item.path, item.path]));
    const find = (value) => { while (group.get(value) !== value) value = group.get(value); return value; };
    for (const item of entries) {
      for (const ancestor of ancestors(item.path)) if (group.has(ancestor)) group.set(find(item.path), find(ancestor));
    }
    const deleted = new Map();
    for (const item of entries) if (item.file?.action === "delete") deleted.set(folded(item.path), [...deleted.get(folded(item.path)) ?? [], item.path]);
    for (const item of entries) {
      if (item.file?.action !== "create") continue;
      // Anything still at a created path after the restore's deletions, or a
      // file where it needs a directory, is ignored or nested and was not
      // captured: restore would destroy it, so the path is not offered. The
      // file the restore deletes under another case of the same name is not
      // in the way once it is deleted, which happens first.
      const info = await lstat(path.join(cwd, item.path)).catch(() => null);
      const renamed = info && !info.isDirectory() && await sameFile(cwd, info, deleted.get(folded(item.path)) ?? []);
      if (renamed) group.set(find(item.path), find(renamed));
      else if (info?.isDirectory()) {
        const left = await uncaptured(cwd, item.path, byPath);
        if (left) item.blocked = `An ignored or nested file is in the way at ${left}`;
      } else if (info) item.blocked = "An ignored file or directory is in the way";
      for (const ancestor of ancestors(item.path)) {
        const above = await lstat(path.join(cwd, ancestor)).catch(() => null);
        if (above && !above.isDirectory() && byPath.get(ancestor)?.file?.action !== "delete") item.blocked = `An ignored file is in the way at ${ancestor}`;
      }
    }
    const members = new Map();
    for (const item of entries) {
      const list = members.get(find(item.path)) ?? members.set(find(item.path), []).get(find(item.path));
      list.push(item);
    }
    const only = resumed && new Set(resumed.paths);
    for (const [root, list] of members) {
      if (list.length < 2) continue;
      const blocked = list.find((item) => item.blocked);
      const outside = only && list.find((item) => !only.has(item.path));
      for (const item of list) {
        Object.assign(item, { group: root, groupSize: list.length });
        if (blocked && !item.blocked) item.blocked = `Restored together with ${blocked.path}, which is blocked`;
        else if (outside && !item.blocked) item.blocked = `Restored together with ${outside.path}, which this restore did not include`;
      }
    }
    const shown = only ? entries.filter((item) => only.has(item.path)) : entries;
    const head = { current: current.head, checkpoint: checkpoint.head ?? null };
    const planDigest = createHash("sha256").update(JSON.stringify({ commit: checkpoint.commit, indexTree: current.indexTree,
      filesTree: current.filesTree, head: current.head, resumes: resumed?.operationId ?? null, entries: shown })).digest("hex");
    return { checkpoint, current, entries: shown, head, planDigest };
  }

  async function readMarker(repo) {
    let text;
    try { text = await readFile(path.join(repo.gitDir, RESTORE_MARKER), "utf8"); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    try {
      const marker = JSON.parse(text);
      if (marker?.version === 2 && ID_PATTERN.test(marker.checkpointId) && OID_PATTERN.test(marker.commit)
        && Array.isArray(marker.paths) && marker.paths.every(validPath)) return marker;
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

  // Whether a restore of checkpoint `id` may go ahead beside the marker of
  // one that did not finish: only as that restore's finish, and only once
  // its Git processes are confirmed stopped. Returns the marker it finishes.
  function admitMarker(target, marker, id, resume) {
    if (!resume) {
      if (marker) throw checkpointError(409, "An earlier restore did not finish; finish it or keep the files first", UNFINISHED);
      return null;
    }
    if (!marker) throw checkpointError(409, "No restore is waiting to finish", "CHECKPOINT_NO_INTERRUPTED_RESTORE");
    if (marker.unreadable) throw checkpointError(409, "The interrupted restore's record is unreadable; keep the files and restore again", "CHECKPOINT_MARKER_UNREADABLE");
    if (marker.checkpointId !== id) throw checkpointError(409, "The restore that did not finish was of another checkpoint", "CHECKPOINT_RESUME_MISMATCH");
    if (ownerPending(target, marker)) throw ownerUnconfirmedError();
    return marker;
  }

  // A Git command that writes the real index, waiting a bounded time while
  // another one (an editor's or a shell's status) holds its lock.
  async function indexWrite(cwd, args, options) {
    for (let attempt = 1; ; attempt += 1) {
      try { return await git(cwd, args, options); }
      catch (error) {
        if (attempt >= INDEX_LOCK_RETRIES || error.code !== 128 || !/index\.lock/.test(`${error.stderr ?? ""}${error.message}`)) throw error;
        await delay(INDEX_LOCK_WAIT_MS);
      }
    }
  }

  // Deletions, then file contents, then index entries.
  async function apply(cwd, ops, commit, scratch) {
    const root = await realpath(cwd);
    const { unfiltered } = await captureSettings(cwd);
    for (const op of ops) if (op.file === "delete") await removeFile(root, op.path);
    const writes = ops.filter((op) => op.file === "write");
    // A directory where a file goes held only paths the deletions removed.
    for (const op of writes) await removeEmptyDirectory(root, op.path);
    const checkedOut = writes.filter((op) => !op.raw).map((op) => op.path);
    if (checkedOut.length) {
      const list = path.join(scratch, `paths-${randomUUID()}`);
      await writeFile(list, `${checkedOut.join("\0")}\0`, { mode: 0o600 });
      // Overlay mode writes only the listed files and removes nothing.
      await indexWrite(cwd, ["restore", "--overlay", `--source=${commit}`, "--worktree", `--pathspec-from-file=${list}`, "--pathspec-file-nul"], { env: LITERAL });
    }
    await writeRecorded(cwd, root, commit, writes.filter((op) => op.raw));
    // Exact paths, never pathspecs: a pathspec for `a` also matches `a/b`.
    for (const batch of batches(ops.filter((op) => op.index === "remove").map((op) => op.path))) {
      await indexWrite(cwd, [...unfiltered, "update-index", "--force-remove", "--", ...batch]);
    }
    for (const batch of batches(ops.filter((op) => op.index && op.index !== "remove").map((op) => `${op.index.mode},${op.index.oid},${op.path}`))) {
      await indexWrite(cwd, [...unfiltered, "update-index", "--add", ...batch.flatMap((value) => ["--cacheinfo", value])]);
    }
  }

  // Files recorded byte for byte are written from their blobs without any
  // filter or line-ending conversion. Blobs are read a bounded number of
  // bytes at a time, and each is checked against its object id.
  async function writeRecorded(cwd, root, commit, ops) {
    if (!ops.length) return;
    const sizes = await blobs(cwd, commit, ops.map((op) => op.path));
    let group = [];
    let bytes = 0;
    const flush = async () => {
      const oids = [...new Set(group.map((op) => op.oid))];
      const output = await git(cwd, ["show", ...oids], { encoding: "buffer", maxBuffer: bytes + 1024 * 1024 });
      const contents = new Map();
      let offset = 0;
      for (const oid of oids) {
        const content = output.subarray(offset, offset + sizes.get(group.find((op) => op.oid === oid).path).size);
        offset += content.length;
        if (blobId(content, oid) !== oid) throw checkpointError(409, "This checkpoint's content could not be read back intact", "CHECKPOINT_DAMAGED");
        contents.set(oid, content);
      }
      for (const op of group) await writeFileAt(root, op.path, contents.get(op.oid), op.mode === "100755");
      group = [];
      bytes = 0;
    };
    for (const op of ops) {
      const blob = sizes.get(op.path);
      if (!blob || blob.oid !== op.oid) throw checkpointError(409, `${op.path} is missing from this checkpoint`, "CHECKPOINT_DAMAGED");
      if (group.length && (group.length >= BATCH_PATHS || bytes + blob.size > limits.fileBytes)) await flush();
      group.push({ ...op, mode: blob.mode });
      if (!group.slice(0, -1).some((other) => other.oid === op.oid)) bytes += blob.size;
    }
    await flush();
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
      safetyCheckpointId: marker.safetyCheckpointId ?? null, startedAt: marker.startedAt ?? null, paths: marker.paths?.length ?? 0,
      ownerUnconfirmed: ownerPending(value, marker) };
    return { worktreePath: cwd, checkpoints, restore, busy: running?.kind ?? null,
      limits: { perWorktree: limits.perWorktree, retainedBytes: limits.retainedBytes, fileBytes: limits.fileBytes, totalBytes: limits.totalBytes, files: limits.files } };
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
        await prune(cwd, new Set([checkpoint.id, ...markerCheckpoints(marker)]));
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

  // `resume` previews finishing the interrupted restore of `id`: what is
  // still different on the paths it was restoring, from the state now.
  async function preview(value, id, { resume = false } = {}) {
    const cwd = target(value);
    return withScratch(async (scratch) => {
      const repo = await repository(cwd);
      const marker = await readMarker(repo);
      const resumed = resume ? admitMarker(value, marker, id, true) : null;
      const result = await plan(value, id, repo, scratch, resumed);
      const paths = [...pathsOf(value)];
      const blockers = [...writers(paths), ...gitWriters(paths), ...await blockedByGit(repo),
        ...(marker && !resume ? [{ code: UNFINISHED, message: "An earlier restore did not finish; finish it or keep the files first" }] : [])];
      return { checkpoint: publicCheckpoint(result.checkpoint), planDigest: result.planDigest, resume: Boolean(resumed),
        currentTree: result.current.filesTree, currentIndexTree: result.current.indexTree,
        head: { ...result.head, moved: result.head.current !== result.head.checkpoint }, entries: result.entries, blockers,
        terminals: terminals(paths) };
    });
  }

  // Restores the chosen paths of a confirmed preview: `paths`, or every
  // offered path `except` those. Finishing an interrupted restore (`resume`)
  // is admitted the same way, against a preview of the state now.
  async function restore(value, { id, planDigest, paths, except, acknowledgeTerminals = [], resume = false } = {}) {
    const cwd = target(value);
    if (typeof planDigest !== "string" || !/^[0-9a-f]{64}$/.test(planDigest)) throw checkpointError(400, "Restore needs the preview it confirms", "CHECKPOINT_PREVIEW_REQUIRED");
    const list = except === undefined ? paths : except;
    if (!Array.isArray(list) || list.length > limits.planEntries || !list.every((item) => typeof item === "string") || (except === undefined && !list.length)) {
      throw checkpointError(400, "Choose at least one path to restore", "CHECKPOINT_SELECTION_INVALID");
    }
    const entry = claim(value, "restore");
    try {
      return await withScratch(async (scratch) => {
        const repo = await repository(cwd);
        const resumed = admitMarker(value, await readMarker(repo), id, resume === true);
        const gitBlockers = await blockedByGit(repo);
        if (gitBlockers.length) throw checkpointError(409, `Restore refused: ${gitBlockers[0].message}`, "CHECKPOINT_WRITERS_ACTIVE", { blockers: gitBlockers });
        const open = terminals([...entry.paths]);
        const acknowledged = new Set(Array.isArray(acknowledgeTerminals) ? acknowledgeTerminals : []);
        if (open.some((terminal) => !acknowledged.has(terminal.id))) {
          throw checkpointError(409, "Confirm the terminals open in this worktree before restoring", "CHECKPOINT_TERMINALS_UNACKNOWLEDGED", { terminals: open });
        }
        const result = await plan(value, id, repo, scratch, resumed);
        if (result.planDigest !== planDigest) throw checkpointError(409, "The worktree changed after the preview; review the new preview before restoring", "CHECKPOINT_PLAN_CHANGED");
        const ops = selectedOps(result.entries, chosenPaths(result.entries, { paths, except }));
        const name = result.checkpoint.label || id;
        const safety = await record(cwd, repo, result.current, { label: resumed ? `Before finishing the restore of ${name}` : `Before restoring ${name}`,
          reason: "before-restore", restoredFrom: id });
        await prune(cwd, new Set([id, safety.id, ...markerCheckpoints(resumed)]));
        const marker = { version: 2, operationId: randomUUID(), checkpointId: id, commit: result.checkpoint.commit, safetyCheckpointId: safety.id,
          ...(resumed ? { earlierSafetyCheckpointIds: markerCheckpoints(resumed).filter((value) => value !== id) } : {}),
          startedAt: now().toISOString(), paths: ops.map((op) => op.path) };
        await audited(resumed ? "worktree.checkpoint.restore.resumed" : "worktree.checkpoint.restore", { target: cwd, checkpointId: id,
          safetyCheckpointId: safety.id, operationId: marker.operationId, ...(resumed ? { resumes: resumed.operationId ?? null } : {}), paths: ops.length }, async () => {
          await writeMarker(repo, marker);
          try { await apply(cwd, ops, result.checkpoint.commit, scratch); }
          catch (error) {
            if (ownershipUnknown(error)) {
              for (const value of entry.paths) unconfirmed.add(value);
              await writeMarker(repo, { ...marker, ownerUnconfirmed: true }).catch(() => {});
            }
            throw interrupted(error, safety);
          }
          await clearMarker(repo);
        });
        return { restored: ops.length, safetyCheckpoint: publicCheckpoint(safety) };
      });
    } finally {
      entry.release();
      changed(cwd);
    }
  }

  // An interrupted restore is finished through its preview (`restore` with
  // `resume`) or its files are kept as they are, which this does; the
  // checkpoint taken before it keeps the earlier state either way.
  async function recover(value, action) {
    const cwd = target(value);
    if (action !== "keep") throw checkpointError(400, "Keep the files, or finish the restore from its preview", "CHECKPOINT_RECOVERY_INVALID");
    const entry = claim(value, "recover");
    try {
      const repo = await repository(cwd);
      const marker = await readMarker(repo);
      if (!marker) throw checkpointError(409, "No restore is waiting to finish", "CHECKPOINT_NO_INTERRUPTED_RESTORE");
      if (ownerPending(value, marker)) throw ownerUnconfirmedError();
      await audited("worktree.checkpoint.restore.kept", { target: cwd, checkpointId: marker.checkpointId ?? null, operationId: marker.operationId }, () => clearMarker(repo));
      onRelease();
      return { kept: true };
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
      if (await readMarker(repo)) throw checkpointError(409, "Finish or keep the interrupted restore before deleting checkpoints", UNFINISHED);
      await audited("worktree.checkpoint.delete", { target: cwd, checkpointId: id }, () =>
        git(cwd, ["update-ref", "-d", `${CHECKPOINT_REF_PREFIX}${id}`, checkpoint.commit]));
      changed(cwd);
      return { deleted: true };
    } finally { entry.release(); }
  }

  // One path's change from the previewed state to the checkpoint: the file
  // on disk (`tree` is the preview's current tree) or its index entry
  // (`side` "index", `tree` the preview's current index tree).
  async function fileDiff(value, { id, tree, file, side = "files" }) {
    const cwd = target(value);
    if (typeof tree !== "string" || !OID_PATTERN.test(tree) || !["files", "index"].includes(side)) throw checkpointError(400, "Preview tree is invalid", "CHECKPOINT_INVALID");
    if (typeof file !== "string" || !file || file.includes("\0") || !isWithin(cwd, path.resolve(cwd, file))) throw checkpointError(400, "File path is invalid", "CHECKPOINT_INVALID");
    const checkpoint = await load(cwd, id);
    try {
      return { diff: await git(cwd, ["-c", "core.quotePath=false", "diff", "--no-ext-diff", "--no-textconv", "--unified=3", tree,
        side === "index" ? checkpoint.indexCommit : checkpoint.commit, "--", file], { env: LITERAL, maxBuffer: limits.diffBytes }) };
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

  return { describe, capture, inspect, preview, restore, recover, remove, fileDiff, holding, admitWriter, reconcile, shutdown };
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

// The chosen paths of a preview: `paths`, or every path offered `except`
// those.
export function chosenPaths(entries, { paths, except }) {
  if (except === undefined) return paths;
  const left = new Set(except);
  const known = new Set(entries.map((entry) => entry.path));
  const stale = [...left].find((relative) => !known.has(relative));
  if (stale) throw checkpointError(409, `${stale} is not part of this restore`, "CHECKPOINT_SELECTION_INVALID");
  const chosen = entries.filter((entry) => !entry.blocked && !left.has(entry.path)).map((entry) => entry.path);
  if (!chosen.length) throw checkpointError(400, "Choose at least one path to restore", "CHECKPOINT_SELECTION_INVALID");
  return chosen;
}

// The confirmed paths as operations. A selection must name whole coupled
// groups and no blocked path.
export function selectedOps(entries, paths) {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const chosen = new Set(paths);
  const groups = new Map();
  for (const relative of chosen) {
    const entry = byPath.get(relative);
    if (!entry) throw checkpointError(409, `${relative} is not part of this restore`, "CHECKPOINT_SELECTION_INVALID");
    if (entry.blocked) throw checkpointError(409, `${relative} cannot be restored: ${entry.blocked}`, "CHECKPOINT_SELECTION_INVALID");
    if (entry.group !== undefined) groups.set(entry.group, { size: entry.groupSize, count: (groups.get(entry.group)?.count ?? 0) + 1 });
  }
  for (const [group, { size, count }] of groups) {
    if (count < size) throw checkpointError(409, `The ${size} paths restored together with ${group} must all be chosen`, "CHECKPOINT_SELECTION_INVALID");
  }
  return [...chosen].sort().map((relative) => {
    const { file, index } = byPath.get(relative);
    return { path: relative, file: file && (file.action === "delete" ? "delete" : "write"), raw: Boolean(file?.raw), oid: file?.oid ?? null,
      index: index && (index.action === "remove" ? "remove" : { mode: index.mode, oid: index.oid }) };
  });
}

function validPath(value) {
  return typeof value === "string" && Boolean(value) && !value.includes("\0") && !path.isAbsolute(value) && !value.split(/[\\/]/).includes("..");
}

// What a writer that `holding` refuses is told; `action` is what it may do
// once the worktree is free, as "start setup".
export function holdMessage(code, action) {
  if (code === RUNNING) return `A checkpoint restore is running in this worktree; ${action} when it finishes`;
  if (code === UNFINISHED) return "A checkpoint restore in this worktree did not finish; finish it or keep the files in Checkpoints first";
  return `A Git stage, unstage or commit in this worktree lost track of its process; ${action} once Outright confirms it stopped`;
}

// A path as a filesystem that ignores case and Unicode form may see it.
function folded(relative) { return relative.normalize("NFC").toLowerCase(); }

// The first of `candidates` (paths the restore deletes) that is the file
// `info` describes, under another name.
async function sameFile(cwd, info, candidates) {
  for (const candidate of candidates) {
    const other = await lstat(path.join(cwd, candidate)).catch(() => null);
    if (other && other.ino === info.ino && other.dev === info.dev) return candidate;
  }
  return null;
}

function pathsOf(target) { return new Set([target.worktreePath, target.worktree?.path].filter(Boolean)); }

// Checkpoints an unfinished restore needs: what it restores and what was
// there before it, and before any restore it finishes.
function markerCheckpoints(marker) {
  if (!marker || marker.unreadable) return [];
  return [marker.checkpointId, marker.safetyCheckpointId, ...(marker.earlierSafetyCheckpointIds ?? [])].filter((value) => typeof value === "string");
}

function ownershipUnknown(error) {
  for (let cause = error; cause; cause = cause.cause) if (cause.code === "SUBPROCESS_OWNERSHIP_UNKNOWN") return true;
  return false;
}
function ownerUnconfirmedError() {
  return checkpointError(409, "Git processes the interrupted restore started are not confirmed stopped yet; finish or keep it once they are", "CHECKPOINT_OWNER_UNCONFIRMED");
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

// Removes a directory where a file is restored, once the restore's
// deletions have left nothing but empty directories in it.
async function removeEmptyDirectory(root, relative) {
  const target = path.join(root, relative);
  const parent = await realpath(path.dirname(target)).catch(() => null);
  if (!parent || !isWithin(root, parent)) return;
  const info = await lstat(target).catch(() => null);
  if (!info?.isDirectory()) return;
  for (const child of await readdir(target, { withFileTypes: true })) {
    if (!child.isDirectory()) throw checkpointError(409, `${relative}/${child.name} is in the way of ${relative}`, "CHECKPOINT_PATH_OBSTRUCTED");
    await removeEmptyDirectory(root, `${relative}/${child.name}`);
  }
  await rmdir(target);
}

// Writes one file through a new file beside it, never through a link.
async function writeFileAt(root, relative, content, executable) {
  for (const ancestor of ancestors(relative)) {
    const info = await lstat(path.join(root, ancestor)).catch(() => null);
    if (!info) break;
    if (!info.isDirectory()) throw checkpointError(409, `${ancestor} is in the way of ${relative}`, "CHECKPOINT_PATH_OBSTRUCTED");
  }
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.outright-${randomUUID().slice(0, 8)}`);
  try {
    await writeFile(temporary, content, { mode: executable ? 0o777 : 0o666, flag: "wx" });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

// A blob's object id, SHA-1 or SHA-256 as the repository uses.
function blobId(content, oid) {
  return createHash(oid.length === 64 ? "sha256" : "sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
}

export function batches(values) {
  const result = [];
  let current = [];
  let characters = 0;
  for (const value of values) {
    if (current.length && (current.length >= BATCH_PATHS || characters + value.length > BATCH_CHARACTERS)) { result.push(current); current = []; characters = 0; }
    current.push(value);
    characters += value.length + BATCH_OVERHEAD;
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
