import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENT_SUPERVISOR } from "./agent-manager.mjs";

const TREE_EMPTY_PROOF = "__OUTRIGHT_UTILITY_TREE_EMPTY_V1__\n";
const UTILITY_DIAGNOSTIC_PREFIX = "__OUTRIGHT_UTILITY_DIAGNOSTIC_V1__ ";
const UTILITY_MEMBERS_PREFIX = "__OUTRIGHT_UTILITY_MEMBERS_V1__ ";

export function utilityBudgetUnavailable(error) {
  return ["SUBPROCESS_CAPACITY", "SUBPROCESS_OWNERSHIP_UNKNOWN", "SUBPROCESS_OWNERSHIP_RECORD_FAILED"].includes(error?.code);
}

function syncDirectory(directory) {
  if (process.platform === "win32") return;
  const descriptor = openSync(directory, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function ownerDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (!info.isDirectory() || (process.platform !== "win32" &&
      (info.uid !== process.getuid() || (info.mode & 0o077) !== 0))) {
    throw new Error("Utility ownership directory is not private");
  }
}

function retainedOwnerId(directory, name) {
  if (/^[0-9a-f-]{36}\.tmp$/.test(name)) {
    const temporary = lstatSync(path.join(directory, name));
    if (!temporary.isFile() || temporary.nlink !== 1 || temporary.size > 4096) return false;
    try { lstatSync(path.join(directory, `${name.slice(0, -4)}.json`)); }
    catch { return false; }
    return null;
  }
  if (!/^[0-9a-f-]{36}\.json$/.test(name)) return false;
  const filename = path.join(directory, name);
  const info = lstatSync(filename);
  if (!info.isFile() || info.nlink !== 1 || info.size > 4096) return false;
  try {
    const owner = JSON.parse(readFileSync(filename, "utf8"));
    if (!["active", "unknown"].includes(owner.state)
      || !["darwin", "linux", "win32"].includes(owner.platform)) return false;
  } catch { return false; }
  return name.slice(0, -5);
}

function retainedUnknownOwners(directory) {
  if (!directory) return { ids: new Set(), unreadable: false };
  try { ownerDirectory(directory); } catch { return { ids: new Set(), unreadable: true }; }
  const ids = new Set();
  for (const name of readdirSync(directory)) {
    // A crash-era temporary file is not a second owner, but an orphan
    // without its prior record keeps the entire inventory unreadable.
    let id;
    try { id = retainedOwnerId(directory, name); }
    catch { return { ids, unreadable: true }; }
    if (id === false) return { ids, unreadable: true };
    if (id) ids.add(id);
  }
  return { ids, unreadable: false };
}

function ownerRecord(directory, id, owner, replace = false) {
  if (!directory) return;
  ownerDirectory(directory);
  const filename = path.join(directory, `${id}.json`);
  const temporary = replace ? path.join(directory, `${id}.tmp`) : filename;
  let created = false;
  try {
    const descriptor = openSync(temporary, "wx", 0o600);
    created = true;
    try {
      writeFileSync(descriptor, `${JSON.stringify({ ...owner, platform: process.platform, recordedAt: new Date().toISOString() })}\n`);
      fsyncSync(descriptor);
    } finally { closeSync(descriptor); }
    if (replace) renameSync(temporary, filename);
    syncDirectory(directory);
  } catch (error) {
    if (created) try { unlinkSync(temporary); }
    catch (error_) { if (error_.code !== "ENOENT") error.cleanupError = error_; }
    throw error;
  }
}

function releaseOwnerRecord(directory, id) {
  if (!directory) return;
  unlinkSync(path.join(directory, `${id}.json`));
  syncDirectory(directory);
}

function nativeOwner(id, platform = process.platform) {
  if (platform === "darwin") return { label: `com.21n.outright.utility.${id}` };
  if (platform === "linux") return { handshakePath: path.join(os.tmpdir(), `outright-utility-${id}`, "owner.json") };
  return { jobName: String.raw`Local\OutrightUtility-${id}` };
}

function linuxBootId() {
  try { return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null; }
  catch { return null; }
}

// Windows reports the supervisor and its direct child with creation times so
// recovery can verify those exact processes, not a reusable PID or job name.
function parseOwnerMembers(text) {
  const members = text.trim().split(" ").map((entry) => {
    const match = /^([1-9]\d{0,9}):([1-9]\d{0,19})$/.exec(entry);
    return match ? { pid: Number(match[1]), birth: match[2] } : null;
  });
  return members.length > 0 && members.length <= 2 && members.every(Boolean) ? members : null;
}

function nativeOwnerCommand(owner, file, args) {
  if (process.platform === "darwin") return [owner.label, file, ...args];
  if (process.platform === "linux") return ["--stop-on-owner-exit", owner.handshakePath, file, ...args];
  if (process.platform === "win32") return ["--utility-owner", owner.jobName, file, ...args];
  return [file, ...args];
}

function privateHandshakeDirectory(directory) {
  const info = lstatSync(directory);
  return info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid() && (info.mode & 0o077) === 0;
}

// The private owner directory outlives its handshake until the durable owner
// record is released. A present directory without a handshake is therefore
// the supervisor's own empty-tree evidence; a missing directory is not.
function removeOwnedHandshake(handshakePath) {
  if (!privateHandshakeDirectory(path.dirname(handshakePath))) throw new Error("Utility handshake directory is not private");
  try { unlinkSync(handshakePath); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

function removeOwnerDirectory(handshakePath) {
  if (!handshakePath) return;
  try { rmdirSync(path.dirname(handshakePath)); }
  catch { /* A later reconciliation or sweep can remove an empty directory. */ }
}

// The supervisor owns the entire native tree. Only its explicit empty-tree
// frame permits capacity release after close, including escaped Git hooks.
export function runOwned(file, args, options, onClose) {
  // Native inspection/control commands already wait for their own launchctl,
  // pidfd, or Job Object operation. Wrapping one supervisor in another would
  // make terminal emptiness proof depend on a second, unrelated owner.
  if (file === AGENT_SUPERVISOR && ["--probe", "--terminate", "--terminate-owned", "--identity",
    "--utility-probe", "--utility-terminate"].includes(args[0])) {
    return execFile(file, args, options, (error, stdout, stderr) => onClose(error, stdout, stderr, true));
  }
  const ownerId = options.__ownerId ?? randomUUID();
  const owner = nativeOwner(ownerId);
  const directory = process.platform === "linux" ? path.dirname(owner.handshakePath) : null;
  if (directory) mkdirSync(directory, { mode: 0o700 });
  const command = nativeOwnerCommand(owner, file, args);
  let child;
  try {
    child = (options.__spawn ?? spawn)(AGENT_SUPERVISOR, command, { cwd: options.cwd,
      env: { ...(options.env ?? process.env), OUTRIGHT_UTILITY_OWNER: "1" },
      windowsHide: true, stdio: ["pipe", "pipe", "pipe", "pipe"] });
  } catch (error) {
    if (directory) rmdirSync(directory);
    queueMicrotask(() => onClose(error, undefined, undefined, true, {}));
    return;
  }
  let encoding = options.encoding;
  if (encoding === undefined) encoding = "utf8";
  if (encoding === "buffer") encoding = null;
  const maxBuffer = options.maxBuffer ?? 1024 * 1024;
  let stdout = [];
  let stderr = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let error;
  let timedOut = false;
  let deadlineTimer;
  let spawned = false;
  let proof = "";
  const diagnostics = [];
  let treeEmpty = false;
  let invalidProof = false;
  let stopSent = false;
  let stopGraceTimer;
  let finalized = false;
  const output = (chunks) => encoding === null ? Buffer.concat(chunks) : Buffer.concat(chunks).toString(encoding);
  child.stdin.on("error", () => {});
  const stop = () => {
    if (stopSent) return;
    stopSent = true;
    if (process.platform === "darwin") child.kill("SIGTERM");
    else if (!child.stdin.destroyed) child.stdin.write("stop\n");
    // A native owner can retain its charged permit while its caller is free
    // to retry. An unresponsive supervisor must not hold bootstrap forever.
    stopGraceTimer = setTimeout(() => {
      if (!finalized) onClose(Object.assign(new Error("Utility owner did not settle after stop", { cause: error }),
        { code: "SUBPROCESS_OWNERSHIP_UNKNOWN", statusCode: 503 }),
      output(stdout), output(stderr), false, { pid: child.pid, ...owner });
    }, options.__stopGraceMs ?? 5000);
  };
  const onAbort = () => {
    error ??= Object.assign(new Error("Utility process was aborted"), { name: "AbortError", code: "ABORT_ERR" });
    stop();
  };
  if (options.signal) {
    options.signal.addEventListener("abort", onAbort, { once: true });
    if (options.signal.aborted) onAbort();
  }
  const capture = (stream, chunks, addBytes) => stream.on("data", (chunk) => {
    const size = addBytes(chunk.length);
    if (size > maxBuffer) {
      error ??= Object.assign(new Error("Utility process output exceeded maxBuffer"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
      stop();
    } else chunks.push(chunk);
  });
  capture(child.stdout, stdout, (size) => (stdoutBytes += size));
  capture(child.stderr, stderr, (size) => (stderrBytes += size));
  child.once("error", (failure) => { error ??= failure; });
  // Returns false for a frame outside the supervisor's control protocol.
  const readControlLine = (line) => {
    if (line === TREE_EMPTY_PROOF) {
      if (treeEmpty) return false;
      treeEmpty = true;
      return true;
    }
    if (line.startsWith(UTILITY_MEMBERS_PREFIX)) {
      const members = parseOwnerMembers(line.slice(UTILITY_MEMBERS_PREFIX.length));
      if (!members) return false;
      // Without this durable evidence a crash leaves the owner unknown.
      try { options.__onOwnerMembers?.(members); } catch { /* The permit stays charged on restart. */ }
      return true;
    }
    if (line.startsWith(UTILITY_DIAGNOSTIC_PREFIX)) {
      if (diagnostics.length < 12) diagnostics.push(line.slice(UTILITY_DIAGNOSTIC_PREFIX.length).trimEnd());
      return true;
    }
    return line === "__OUTRIGHT_LAUNCH_AUTHORIZED_V1__\n";
  };
  child.stdio[3]?.on("data", (chunk) => {
    proof += chunk.toString("utf8");
    if (proof.length > 4096) invalidProof = true;
    while (!invalidProof && proof.includes("\n")) {
      const end = proof.indexOf("\n") + 1;
      const line = proof.slice(0, end);
      proof = proof.slice(end);
      if (!readControlLine(line)) invalidProof = true;
    }
    if (invalidProof) treeEmpty = false;
  });
  child.stdio[3]?.on("error", (failure) => {
    invalidProof = true;
    error ??= failure;
  });
  child.once("spawn", () => {
    spawned = true;
    try { options.__onOwnerSpawn?.(child.pid, owner); }
    catch (error_) { error ??= error_; stop(); }
    if (stopSent && process.platform === "darwin") child.kill("SIGTERM");
    if (!stopSent) child.stdin.write("go\n");
  });
  if (options.timeout > 0) deadlineTimer = setTimeout(() => {
    timedOut = true;
    error ??= Object.assign(new Error(`Utility process timed out after ${options.timeout}ms`), { killed: true, signal: "SIGTERM" });
    stop();
  }, options.timeout);
  child.once("close", (code, signal) => {
    clearTimeout(deadlineTimer);
    options.signal?.removeEventListener("abort", onAbort);
    treeEmpty &&= !invalidProof && proof.length === 0;
    const finishClose = () => {
      finalized = true;
      clearTimeout(stopGraceTimer);
      try {
        // The owner directory stays until the durable record is released.
        if (directory && (treeEmpty || !spawned)) removeOwnedHandshake(owner.handshakePath);
      } catch (error_) {
        treeEmpty = false;
        error ??= error_;
      }
      if (!error && (code !== 0 || signal)) error = Object.assign(new Error(`Utility process exited with ${signal ?? code}`), { code, signal });
      if (error && diagnostics.length) error.supervisorDiagnostics = diagnostics;
      if (timedOut && error) error.killed = true;
      onClose(error, output(stdout), output(stderr), treeEmpty || !spawned,
        { pid: child.pid, ...owner });
    };
    if (process.platform === "darwin" && !treeEmpty && spawned) {
      // The submitted service can relaunch after the supervisor dies. Keep
      // its environment available until a bounded native bootout attempt
      // finishes, then retain unknown capacity if emptiness was not proven.
      try {
        execFile(AGENT_SUPERVISOR, ["--terminate", command[0]], { env: options.env ?? process.env, timeout: 5000, maxBuffer: 64 * 1024 },
          (terminationError) => {
            if (!terminationError) treeEmpty = true;
            else error ??= terminationError;
            finishClose();
          });
      } catch (terminationError) { error ??= terminationError; finishClose(); }
    } else finishClose();
  });
  // A failed native owner without an empty-tree frame leaves a durable
  // unknown reservation; close alone cannot prove descendant cleanup.
  return child;
}

function nativeStatus(args, env = process.env) {
  return new Promise((resolve) => {
    execFile(AGENT_SUPERVISOR, args, { env, timeout: 5000, maxBuffer: 4096 }, (error, stdout) => {
      resolve({ status: String(stdout ?? "").trim(), failed: Boolean(error && ![3].includes(error.code)) });
    });
  });
}

function ownerProcessGone(pid, platform = process.platform) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      if (close >= 0 && stat.slice(close + 2, close + 3) === "Z") return true;
    } catch (error) { if (error.code === "ENOENT") return true; }
  }
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === "ESRCH"; }
}

function recordedLinuxHandshake(record, id) {
  // Older records predate a durable handshake path. The current TMPDIR then
  // names only a lookup candidate; its absence proves nothing.
  if (record.handshakePath === undefined) return nativeOwner(id, "linux").handshakePath;
  const recorded = record.handshakePath;
  if (typeof recorded !== "string" || !path.posix.isAbsolute(recorded)
    || path.posix.basename(recorded) !== "owner.json"
    || path.posix.basename(path.posix.dirname(recorded)) !== `outright-utility-${id}`) return null;
  return recorded;
}

function recordedIdentityMatches(record, id, platform) {
  if (platform === "linux") return Boolean(recordedLinuxHandshake(record, id));
  const expected = nativeOwner(id, platform);
  return Object.keys(expected).every((key) => record[key] === undefined || record[key] === expected[key]);
}

function handshakeRemovedBySupervisor(handshakePath) {
  try { if (!privateHandshakeDirectory(path.dirname(handshakePath))) return false; }
  catch { return false; }
  try { lstatSync(handshakePath); return false; }
  catch (error) { return error.code === "ENOENT"; }
}

async function linuxTreeEmpty(record, id, status, bootId) {
  // Every process from an earlier boot is gone.
  if (typeof record.bootId === "string" && record.bootId && bootId && record.bootId !== bootId) return true;
  const handshakePath = recordedLinuxHandshake(record, id);
  let handshake;
  try { handshake = JSON.parse(readFileSync(handshakePath, "utf8")); }
  catch (error) { return error.code === "ENOENT" && handshakeRemovedBySupervisor(handshakePath); }
  if (!Number.isSafeInteger(handshake.pid) || handshake.pid <= 0 || typeof handshake.processIdentity !== "string") return false;
  await status(["--terminate-owned", String(handshake.pid), handshake.processIdentity, handshakePath]);
  return handshakeRemovedBySupervisor(handshakePath);
}

async function darwinTreeEmpty(id, status) {
  // launchd reports absent only after the recorded coalition is reaped.
  const { label } = nativeOwner(id, "darwin");
  const first = await status(["--probe", label]);
  if (first.status === "alive" || first.status === "exited") await status(["--terminate", label]);
  const last = await status(["--probe", label]);
  return last.status === "absent";
}

async function windowsTreeEmpty(record, id, status) {
  const { jobName } = nativeOwner(id, "win32");
  const first = await status(["--utility-probe", jobName]);
  if (first.status === "alive") await status(["--utility-terminate", jobName]);
  const last = await status(["--utility-probe", jobName]);
  // An opened Job Object with zero active processes is the kernel's proof.
  if (last.status === "exited") return true;
  if (last.status !== "absent") return false;
  // A vanished name is not: KILL_ON_JOB_CLOSE teardown is asynchronous, and a
  // Local\ name is invisible from another logon session. Every member the
  // supervisor reported must be verifiably terminated or replaced.
  const members = Array.isArray(record.members) ? parseOwnerMembers(record.members.map((member) => `${member?.pid}:${member?.birth}`).join(" ")) : null;
  if (!members) return false;
  const verdicts = await Promise.all(members.map((member) => status(["--probe", String(member.pid), member.birth])));
  return verdicts.every((verdict) => verdict.status === "absent" && !verdict.failed);
}

// Only positive platform evidence that the recorded tree is empty releases a
// utility permit. Missing, unreadable, foreign or ambiguous evidence keeps the
// reservation charged as recoverable unknown capacity.
export async function nativeOwnerTreeEmpty(record, id, platform = process.platform, status = nativeStatus, bootId = platform === "linux" ? linuxBootId() : null) {
  if (!record || record.platform !== platform || !["active", "unknown"].includes(record.state)) return false;
  if (!recordedIdentityMatches(record, id, platform)) return false;
  // Sound only because the authorized record is fsynced before "go".
  if (record.authorized === false) return ownerProcessGone(record.runtimePid, platform);
  if (!ownerProcessGone(record.pid, platform)) return false;
  if (platform === "linux") return linuxTreeEmpty(record, id, status, bootId);
  if (platform === "darwin") return darwinTreeEmpty(id, status);
  return windowsTreeEmpty(record, id, status);
}

async function releaseReconciledOwner(directory, id, record) {
  if (!await nativeOwnerTreeEmpty(record, id)) return false;
  try { unlinkSync(path.join(directory, `${id}.tmp`)); }
  catch (error) { if (error.code !== "ENOENT") return false; }
  try { releaseOwnerRecord(directory, id); }
  catch { return false; }
  if (process.platform === "linux") removeOwnerDirectory(recordedLinuxHandshake(record, id));
  return true;
}

// Git, scanner and editor requests share one admission point. Command permits
// stay charged until close; detached editor permits cover process creation.
export function createSubprocessBudget({ limit = 8, execute = runOwned, launch = spawn, unknownDirectory = null } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("Utility process limit must be a non-negative integer");
  const retained = retainedUnknownOwners(unknownDirectory);
  const unreadableOwners = retained.unreadable;
  const accountedOwners = retained.ids;
  const unknownOwners = new Set(retained.ids);
  let unknown = unreadableOwners ? limit : retained.ids.size;
  let active = unknown;
  const inFlightOwners = new Set();
  let reconciliationPromise;
  function admit() {
    if (active >= limit) {
      if (unknown > 0) void reconcileUnknown().catch(() => {});
      const error = new Error("Utility process capacity is full; retry when a process finishes");
      error.statusCode = 429;
      error.code = "SUBPROCESS_CAPACITY";
      throw error;
    }
    active += 1;
  }
  function run(file, args, options = {}) {
    try { admit(); } catch (error) { return Promise.reject(error); }
    const ownerId = randomUUID();
    // The absolute handshake path and boot identity are recorded at spawn;
    // recovery never re-derives them from a later runtime environment.
    const identity = { ...nativeOwner(ownerId), ...(process.platform === "linux" ? { bootId: linuxBootId() } : {}) };
    let authorizedOwner = null;
    try { ownerRecord(unknownDirectory, ownerId, { state: "active", authorized: false,
      runtimePid: process.pid, ...identity }); }
    catch (error) {
      active -= 1;
      return Promise.reject(Object.assign(new Error("Utility ownership reservation could not be recorded", { cause: error }),
        { code: "SUBPROCESS_OWNERSHIP_RECORD_FAILED", statusCode: 503 }));
    }
    inFlightOwners.add(ownerId);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, stdout, stderr, ownerProven = true, owner = {}) => {
        if (settled) {
          // A stop-grace rejection settles the caller, not the native tree.
          // Only a later genuine empty-tree frame may release its permit.
          if (ownerProven && unknownOwners.has(ownerId)) {
            try {
              releaseOwnerRecord(unknownDirectory, ownerId);
              unknownOwners.delete(ownerId);
              accountedOwners.delete(ownerId);
              active -= 1;
              unknown -= 1;
              removeOwnerDirectory(owner.handshakePath);
            } catch { /* Recovery retains the charged record. */ }
          }
          return;
        }
        settled = true;
        inFlightOwners.delete(ownerId);
        if (ownerProven) {
          try {
            releaseOwnerRecord(unknownDirectory, ownerId);
            active -= 1;
            removeOwnerDirectory(owner.handshakePath);
          } catch (releaseError) {
            ownerProven = false;
            error = new Error("Utility ownership reservation could not be cleared", { cause: releaseError });
          }
        }
        if (!ownerProven) {
          unknown += 1;
          accountedOwners.add(ownerId);
          unknownOwners.add(ownerId);
          // The reservation already contains the last durable authorization
          // state. A failed replacement may have reached rename before fsync;
          // overwriting it here could falsely turn an authorized native tree
          // into an unlaunched owner that recovery would release too early.
          error = Object.assign(new Error("Utility descendant ownership is unknown; capacity remains reserved", { cause: error }),
            { code: "SUBPROCESS_OWNERSHIP_UNKNOWN", statusCode: 503, owner });
        }
        if (error) reject(Object.assign(error, { stdout, stderr }));
        else resolve({ stdout, stderr });
      };
      try { execute(file, args, { ...options, __ownerId: ownerId,
        __onOwnerSpawn(pid, observedOwner) {
          const owner = { state: "active", authorized: true, pid, runtimePid: process.pid, ...identity, ...observedOwner };
          ownerRecord(unknownDirectory, ownerId, owner, true);
          authorizedOwner = owner;
        },
        __onOwnerMembers(members) {
          if (!authorizedOwner || settled) return;
          ownerRecord(unknownDirectory, ownerId, { ...authorizedOwner, members }, true);
        } }, finish); }
      catch (error) { finish(error); }
    });
  }
  // Editors are external GUI applications. Charge their launch admission,
  // then release the utility permit when the OS confirms process creation;
  // waiting for the window to close would strand a long-running editor slot.
  function launchDetached(file, args, options = {}) {
    try { admit(); } catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      let settled = false;
      let child;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        active -= 1;
        if (error) reject(error);
        else { child.unref?.(); resolve({ pid: child.pid }); }
      };
      try {
        child = launch(file, args, { ...options, stdio: "ignore", detached: process.platform !== "win32" });
        child.once("error", finish);
        child.once("spawn", () => finish(null));
      } catch (error) { finish(error); }
    });
  }
  async function reconcileUnknown() {
    if (!unknownDirectory || !unknown || unreadableOwners) return 0;
    if (reconciliationPromise) return reconciliationPromise;
    reconciliationPromise = (async () => {
      let released = 0;
      for (const name of readdirSync(unknownDirectory)) {
        if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
        const id = name.slice(0, -5);
        if (!accountedOwners.has(id) || inFlightOwners.has(id) || !unknownOwners.has(id)) continue;
        let record;
        try { record = JSON.parse(readFileSync(path.join(unknownDirectory, name), "utf8")); }
        catch { continue; }
        if (!await releaseReconciledOwner(unknownDirectory, id, record)) continue;
        active -= 1;
        unknown -= 1;
        accountedOwners.delete(id);
        unknownOwners.delete(id);
        released += 1;
      }
      return released;
    })().finally(() => { reconciliationPromise = null; });
    return reconciliationPromise;
  }
  return { run, launchDetached, reconcileUnknown, capacity: () => ({ active, limit, unknown }) };
}

export const utilityProcesses = createSubprocessBudget({
  unknownDirectory: path.join(process.env.OUTRIGHT_DATA_DIR ?? path.join(os.homedir(), ".outright"), "utility-unknown"),
});
