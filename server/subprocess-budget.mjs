import { execFile, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENT_SUPERVISOR } from "./agent-manager.mjs";
import { withoutDirectProviderCredentials } from "./execution-adapters/index.mjs";

const TREE_EMPTY_PROOF = "__OUTRIGHT_UTILITY_TREE_EMPTY_V1__\n";
const UTILITY_DIAGNOSTIC_PREFIX = "__OUTRIGHT_UTILITY_DIAGNOSTIC_V1__ ";
const MAX_REPORTED_UNKNOWN_OWNERS = 32;
const BOOT_READ_RETRIES = 3;
const BOOT_READ_BACKOFF_MS = 60_000;
// Positive whole-tree evidence: the supervisor's empty-tree frame, an opened
// empty job, an absent launchd service, a supervisor-removed handshake, an
// unlaunched owner's gone runtime, or an earlier boot.
const RELEASE_EVIDENCE = new Set(["proven", "earlier-boot"]);
// Verdicts that observed the recorded tree, or its runtime, still running.
const LIVE_OWNER_REASONS = new Set(["owner-alive", "runtime-alive", "job-alive", "service-retained", "handshake-retained"]);
// Verdicts on the record itself, reached before any boot comparison.
const REJECTED_RECORD_REASONS = new Set(["record-unreadable", "identity-mismatch"]);
// States no proof has examined since they arose; a re-check may release them.
const RECHECK_REASONS = new Set(["awaiting-reconciliation", "owner-unsettled", "release-failed"]);

// The one release predicate. The live supervisor frame, startup and admission
// reconciliation, and an operator re-check all lower utility capacity only
// when it holds; every other verdict keeps the reservation charged.
export function utilityOwnerReleased(proof) {
  return proof?.empty === true && RELEASE_EVIDENCE.has(proof.reason);
}

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

// A Windows supervisor's emptiness marker belongs to its owner record. One
// left behind after that record was released is stale evidence.
function retainedEmptyMarker(directory, name) {
  const marker = lstatSync(path.join(directory, name));
  if (!marker.isFile() || marker.size > 4096) return false;
  try { lstatSync(path.join(directory, `${name.slice(0, -6)}.json`)); }
  catch {
    try { unlinkSync(path.join(directory, name)); } catch { /* A later startup retries. */ }
  }
  return null;
}

function retainedOwnerId(directory, name) {
  if (/^[0-9a-f-]{36}\.empty$/.test(name)) return retainedEmptyMarker(directory, name);
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
      // A replaced record keeps its original time; only identity changes.
      writeFileSync(descriptor, `${JSON.stringify({ recordedAt: new Date().toISOString(), ...owner, platform: process.platform })}\n`);
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

// The Windows supervisor accepts only an absolute marker path.
function emptyMarkerPath(directory, id) {
  return path.resolve(directory, `${id}.empty`);
}

function releaseOwnerRecord(directory, id) {
  if (!directory) return;
  unlinkSync(path.join(directory, `${id}.json`));
  syncDirectory(directory);
  // The marker proved this released owner empty; startup removes a leftover.
  try { unlinkSync(emptyMarkerPath(directory, id)); } catch { /* Stale markers are swept on startup. */ }
}

function nativeOwner(id, platform = process.platform) {
  if (platform === "darwin") return { label: `com.21n.outright.utility.${id}` };
  if (platform === "linux") return { handshakePath: path.join(os.tmpdir(), `outright-utility-${id}`, "owner.json") };
  return { jobName: String.raw`Local\OutrightUtility-${id}` };
}

function readBootIdentity() {
  try {
    let identity = null;
    if (process.platform === "linux") identity = readFileSync("/proc/sys/kernel/random/boot_id", "utf8");
    else if (process.platform === "darwin") identity = execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { encoding: "utf8", timeout: 5000 });
    else if (process.platform === "win32") identity = execFileSync(AGENT_SUPERVISOR, ["--boot-identity"], { encoding: "utf8", timeout: 5000, windowsHide: true, env: withoutDirectProviderCredentials(process.env) });
    identity = identity?.trim();
    return identity && /^[\w:.-]{1,128}$/.test(identity) ? identity : null;
  } catch { return null; }
}

let bootIdentity = null;
let failedBootReads = 0;
let nextBootReadAt = 0;
// PIDs are reused across boots; a recorded boot identity is not. Every owner
// record carries it so recovery can prove an earlier boot before any PID check.
// Only a successful read is kept. A failed one is retried by the next caller,
// so boot adoption still stamps once the identity becomes readable; after
// repeated failures, synchronous retries are spaced out on the monotonic clock.
export function currentBootIdentity() {
  if (bootIdentity || performance.now() < nextBootReadAt) return bootIdentity;
  bootIdentity = readBootIdentity();
  if (bootIdentity) return bootIdentity;
  failedBootReads += 1;
  if (failedBootReads >= BOOT_READ_RETRIES) nextBootReadAt = performance.now() + BOOT_READ_BACKOFF_MS;
  return null;
}

function nativeOwnerCommand(owner, file, args) {
  if (process.platform === "darwin") return [owner.label, file, ...args];
  if (process.platform === "linux") return ["--stop-on-owner-exit", owner.handshakePath, file, ...args];
  if (process.platform === "win32") return ["--utility-owner", owner.jobName, owner.emptyMarker ?? "-", file, ...args];
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
    return execFile(file, args, { ...options, env: withoutDirectProviderCredentials(options.env ?? process.env) },
      (error, stdout, stderr) => onClose(error, stdout, stderr, true));
  }
  // Git runs repository hooks an agent may have written, so no utility ever
  // receives a direct provider's credential.
  const env = withoutDirectProviderCredentials(options.env ?? process.env);
  const ownerId = options.__ownerId ?? randomUUID();
  // The Windows supervisor writes its durable emptiness marker beside the
  // owner record only after its Job Object reports zero active processes.
  const owner = { ...nativeOwner(ownerId), ...(options.__emptyMarker ? { emptyMarker: options.__emptyMarker } : {}) };
  const directory = process.platform === "linux" ? path.dirname(owner.handshakePath) : null;
  if (directory) mkdirSync(directory, { mode: 0o700 });
  const command = nativeOwnerCommand(owner, file, args);
  let child;
  try {
    child = (options.__spawn ?? spawn)(AGENT_SUPERVISOR, command, { cwd: options.cwd,
      env: { ...env, OUTRIGHT_UTILITY_OWNER: "1" },
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
        execFile(AGENT_SUPERVISOR, ["--terminate", command[0]], { env, timeout: 5000, maxBuffer: 64 * 1024 },
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
    execFile(AGENT_SUPERVISOR, args, { env: withoutDirectProviderCredentials(env), timeout: 5000, maxBuffer: 4096 }, (error, stdout) => {
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

const proven = { empty: true, reason: "proven" };
const unproven = (reason) => ({ empty: false, reason });

async function linuxTreeProof(record, id, status) {
  const handshakePath = recordedLinuxHandshake(record, id);
  let handshake;
  try { handshake = JSON.parse(readFileSync(handshakePath, "utf8")); }
  catch (error) {
    if (error.code !== "ENOENT") return unproven("handshake-unreadable");
    return handshakeRemovedBySupervisor(handshakePath) ? proven : unproven("owner-directory-missing");
  }
  if (!Number.isSafeInteger(handshake.pid) || handshake.pid <= 0 || typeof handshake.processIdentity !== "string") return unproven("handshake-invalid");
  await status(["--terminate-owned", String(handshake.pid), handshake.processIdentity, handshakePath]);
  return handshakeRemovedBySupervisor(handshakePath) ? proven : unproven("handshake-retained");
}

async function darwinTreeProof(id, status) {
  // launchd reports absent only after the recorded coalition is reaped.
  const { label } = nativeOwner(id, "darwin");
  const first = await status(["--probe", label]);
  if (first.status === "alive" || first.status === "exited") await status(["--terminate", label]);
  const last = await status(["--probe", label]);
  if (last.status === "absent") return proven;
  return unproven(last.failed ? "probe-failed" : "service-retained");
}

function emptyMarkerMatches(record, id, directory) {
  if (!directory) return false;
  const filename = emptyMarkerPath(directory, id);
  try {
    const info = lstatSync(filename);
    if (!info.isFile() || info.size > 4096) return false;
    const [proof, jobName, boot, ...rest] = readFileSync(filename, "utf8").split(/[ \n]/);
    // The marker is bound to this owner's job name and, when recorded, to
    // the boot in which the supervisor observed zero job members.
    return proof === TREE_EMPTY_PROOF.trimEnd() && jobName === record.jobName && Boolean(boot)
      && (typeof record.bootId !== "string" || !record.bootId || boot === record.bootId)
      && rest.length === 1 && rest[0] === "";
  } catch { return false; }
}

async function windowsTreeProof(record, id, status, directory) {
  const { jobName } = nativeOwner(id, "win32");
  const first = await status(["--utility-probe", jobName]);
  if (first.status === "alive") await status(["--utility-terminate", jobName]);
  const last = await status(["--utility-probe", jobName]);
  // An opened Job Object with zero active processes is the kernel's proof.
  if (last.status === "exited") return proven;
  if (last.status !== "absent") return unproven(last.failed ? "probe-failed" : "job-alive");
  // A vanished name is not: KILL_ON_JOB_CLOSE teardown is asynchronous, a
  // Local\ name is invisible from another logon session, and the job may
  // hold unrecorded grandchildren. Only the supervisor's marker, written
  // after the kernel reported zero members, proves this whole tree empty.
  return emptyMarkerMatches({ ...record, jobName }, id, directory) ? proven : unproven("job-absent-without-marker");
}

// The boot a record was spawned in or, for a record written without one, the
// boot in which recovery first observed it. Either bounds its processes.
function recordedBootIdentity(record) {
  for (const value of [record?.bootId, record?.observedBootId]) {
    if (typeof value === "string" && value) return value;
  }
  return null;
}

// The checks nativeOwnerProof makes before any boot or native evidence. A
// record they reject is never proven by a later boot either.
function recordRejection(record, id, platform) {
  if (!record || record.platform !== platform || !["active", "unknown"].includes(record.state)) return "record-unreadable";
  if (!recordedIdentityMatches(record, id, platform)) return "identity-mismatch";
  return null;
}

// Whether a computer restart proves this record's tree gone: exactly when
// nativeOwnerProof, given a different readable boot identity, would reach and
// return earlier-boot for it.
export function clearsAfterRestart(record, id, platform = process.platform) {
  return !recordRejection(record, id, platform) && Boolean(recordedBootIdentity(record));
}

// Only positive platform evidence that the recorded tree is empty releases a
// utility permit. The order is fixed on every platform: an earlier recorded
// boot first (PIDs are reused across boots), then the recorded owner process,
// then the platform's whole-tree proof. A boot compares only when both
// identities were read; a missing one, wall-clock time or a dead direct PID
// is never proof. Missing, unreadable, foreign or ambiguous evidence returns
// its reason and keeps the reservation charged.
export async function nativeOwnerProof(record, id, { platform = process.platform, status = nativeStatus,
  bootId = platform === process.platform ? currentBootIdentity() : null, directory = null } = {}) {
  const rejection = recordRejection(record, id, platform);
  if (rejection) return unproven(rejection);
  const recordedBoot = recordedBootIdentity(record);
  if (recordedBoot && bootId && recordedBoot !== bootId) return { empty: true, reason: "earlier-boot" };
  // Sound only because the authorized record is fsynced before "go".
  if (record.authorized === false) return ownerProcessGone(record.runtimePid, platform) ? proven : unproven("runtime-alive");
  if (!ownerProcessGone(record.pid, platform)) return unproven("owner-alive");
  if (platform === "linux") return linuxTreeProof(record, id, status);
  if (platform === "darwin") return darwinTreeProof(id, status);
  return windowsTreeProof(record, id, status, directory);
}

function ownerReleaseError(statusCode, message, code, details = {}) {
  return Object.assign(new Error(message), { statusCode, code, details: { code, ...details } });
}

function releaseOwnerFiles(directory, id, record) {
  try { unlinkSync(path.join(directory, `${id}.tmp`)); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  releaseOwnerRecord(directory, id);
  if (process.platform === "linux" && record) removeOwnerDirectory(recordedLinuxHandshake(record, id));
}

// Git, scanner and editor requests share one admission point. Command permits
// stay charged until close; detached editor permits cover process creation.
export function createSubprocessBudget({ limit = 8, execute = runOwned, launch = spawn, unknownDirectory = null,
  proveOwner = nativeOwnerProof, bootIdentity = currentBootIdentity } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("Utility process limit must be a non-negative integer");
  const retained = retainedUnknownOwners(unknownDirectory);
  const unreadableOwners = retained.unreadable;
  const accountedOwners = retained.ids;
  const unknownOwners = new Set(retained.ids);
  let unknown = unreadableOwners ? limit : retained.ids.size;
  let active = unknown;
  // Owners whose release decision is in progress: a running command, or a
  // reconciliation or operator re-check proving its tree.
  const inFlightOwners = new Set();
  // The latest verdict for each unknown owner and whether a computer restart
  // proves its tree gone, reported with capacity.
  const ownerStates = new Map();
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
    const identity = { ...nativeOwner(ownerId), bootId: bootIdentity() };
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
      const finish = (error, stdout, stderr, frameProven = true, owner = {}) => {
        // The supervisor's frame (or no launched supervisor) is the live
        // path's evidence, read through the same release predicate.
        let ownerProven = utilityOwnerReleased(frameProven ? proven : unproven("owner-unsettled"));
        if (settled) {
          // A stop-grace rejection settles the caller, not the native tree.
          // Only a later genuine empty-tree frame may release its permit,
          // unless a reconciliation or operator re-check owns it right now.
          if (ownerProven && unknownOwners.has(ownerId) && !inFlightOwners.has(ownerId)) {
            try {
              releaseOwnerRecord(unknownDirectory, ownerId);
              unknownOwners.delete(ownerId);
              accountedOwners.delete(ownerId);
              active -= 1;
              unknown -= 1;
              ownerStates.delete(ownerId);
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
          ownerStates.set(ownerId, { reason: "owner-unsettled",
            restart: clearsAfterRestart({ state: "active", platform: process.platform, ...identity }, ownerId) });
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
      // Every identity recovery depends on is in this record, fsynced before
      // the supervisor may start the command. A failed write refuses launch.
      try { execute(file, args, { ...options, __ownerId: ownerId,
        ...(unknownDirectory && process.platform === "win32" ? { __emptyMarker: emptyMarkerPath(unknownDirectory, ownerId) } : {}),
        __onOwnerSpawn(pid, observedOwner) {
          const owner = { state: "active", authorized: true, pid, runtimePid: process.pid, ...identity, ...observedOwner };
          // The marker path is derived from the record's own directory.
          delete owner.emptyMarker;
          ownerRecord(unknownDirectory, ownerId, owner, true);
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
  function readOwnerRecord(id) {
    try { return JSON.parse(readFileSync(path.join(unknownDirectory, `${id}.json`), "utf8")); }
    catch { return null; }
  }
  function forgetOwner(id) {
    active -= 1;
    unknown -= 1;
    accountedOwners.delete(id);
    unknownOwners.delete(id);
    ownerStates.delete(id);
  }
  // Releases the owner's durable files after its proof; false keeps it charged.
  function releaseProvenOwner(id, record) {
    try { releaseOwnerFiles(unknownDirectory, id, record); }
    catch {
      ownerStates.set(id, { reason: "release-failed", restart: clearsAfterRestart(record, id) });
      return false;
    }
    forgetOwner(id);
    return true;
  }
  // A record without a boot identity cannot be bounded by a later boot until
  // recovery durably stamps the boot it was observed in. That boot is never
  // inferred: an unreadable identity or a failed write keeps it unstamped.
  function adoptObservedBoot(id, record) {
    const current = bootIdentity();
    if (!record || record.platform !== process.platform || recordedBootIdentity(record) || !current) return true;
    try {
      // A crash-era replacement file would block the new one.
      try { unlinkSync(path.join(unknownDirectory, `${id}.tmp`)); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      ownerRecord(unknownDirectory, id, { ...record, observedBootId: current }, true);
      record.observedBootId = current;
      return true;
    } catch { return false; }
  }
  // Every proof of a retained owner: the caller owns it while this runs.
  async function proveRetainedOwner(id) {
    const record = readOwnerRecord(id);
    let proof = await proveOwner(record, id, { directory: unknownDirectory, bootId: bootIdentity() });
    if (!utilityOwnerReleased(proof) && !adoptObservedBoot(id, record) && !LIVE_OWNER_REASONS.has(proof.reason)) {
      proof = unproven("boot-adoption-failed");
    }
    // A restart is promised only where this same proof, run in a later
    // boot, would return earlier-boot for the record it just examined.
    if (!utilityOwnerReleased(proof)) ownerStates.set(id, { reason: proof.reason,
      restart: !REJECTED_RECORD_REASONS.has(proof.reason) && clearsAfterRestart(record, id) });
    return { record, proof };
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
        inFlightOwners.add(id);
        try {
          const { record, proof } = await proveRetainedOwner(id); // NOSONAR S9382: native owner proofs are serialized; each may terminate a tree
          if (utilityOwnerReleased(proof) && releaseProvenOwner(id, record)) released += 1;
        } finally { inFlightOwners.delete(id); }
      }
      return released;
    })().finally(() => { reconciliationPromise = null; });
    return reconciliationPromise;
  }
  // Unknown owners stay visible with the reason their tree is unproven and
  // whether a computer restart will prove it gone.
  function unknownOwnerStatus() {
    return [...unknownOwners].slice(0, MAX_REPORTED_UNKNOWN_OWNERS).map((id) => {
      const { reason, restart = false } = ownerStates.get(id) ?? { reason: "awaiting-reconciliation" };
      return { id, reason, releasable: RECHECK_REASONS.has(reason) && !inFlightOwners.has(id), clearsAfterRestart: restart };
    });
  }
  // An operator release is a fresh, audited re-check through the same
  // release predicate. It never overrides missing or live evidence: those
  // owners stay charged until proof, or until a later boot for a record
  // that carries its boot.
  async function releaseUnknownOwner(id, { audit }) {
    if (!unknownDirectory || !unknownOwners.has(id)) {
      throw ownerReleaseError(404, "Unknown utility owner was not found", "UTILITY_OWNER_NOT_FOUND");
    }
    if (inFlightOwners.has(id)) throw ownerReleaseError(409, "The utility owner is already being checked", "UTILITY_OWNER_BUSY");
    inFlightOwners.add(id);
    try {
      const { record, proof } = await proveRetainedOwner(id);
      if (!utilityOwnerReleased(proof)) {
        const live = LIVE_OWNER_REASONS.has(proof.reason);
        throw ownerReleaseError(409, live ? "The recorded utility owner is still running"
          : "The utility owner's processes are not proven gone", live ? "UTILITY_OWNER_ALIVE" : "UTILITY_OWNER_UNPROVEN",
        { reason: proof.reason, clearsAfterRestart: ownerStates.get(id).restart });
      }
      const outcome = { id, proven: true, reason: proof.reason, platform: record?.platform ?? null, recordedAt: record?.recordedAt ?? null };
      await audit(outcome);
      if (!releaseProvenOwner(id, record)) {
        throw ownerReleaseError(503, "Utility ownership reservation could not be cleared", "UTILITY_OWNER_RELEASE_FAILED");
      }
      return outcome;
    } finally { inFlightOwners.delete(id); }
  }
  return { run, launchDetached, reconcileUnknown, unknownOwnerStatus, releaseUnknownOwner, capacity: () => ({ active, limit, unknown }) };
}

export const utilityProcesses = createSubprocessBudget({
  unknownDirectory: path.join(process.env.OUTRIGHT_DATA_DIR ?? path.join(os.homedir(), ".outright"), "utility-unknown"),
});
