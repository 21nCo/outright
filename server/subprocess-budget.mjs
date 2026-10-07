import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENT_SUPERVISOR } from "./agent-manager.mjs";

const TREE_EMPTY_PROOF = "__OUTRIGHT_UTILITY_TREE_EMPTY_V1__\n";
const UTILITY_DIAGNOSTIC_PREFIX = "__OUTRIGHT_UTILITY_DIAGNOSTIC_V1__ ";

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

function retainedUnknownOwners(directory) {
  if (!directory) return { ids: new Set(), unreadable: false };
  try { ownerDirectory(directory); } catch { return { ids: new Set(), unreadable: true }; }
  const ids = new Set();
  for (const name of readdirSync(directory)) {
    if (/^[0-9a-f-]{36}\.tmp$/.test(name)) {
      // Atomic replacement leaves the old .json in place until rename. A
      // crash-era temporary file is not a second owner, but an orphan without
      // its prior record is not safe to ignore.
      const temporary = lstatSync(path.join(directory, name));
      if (!temporary.isFile() || temporary.nlink !== 1 || temporary.size > 4096) return { ids, unreadable: true };
      try { lstatSync(path.join(directory, `${name.slice(0, -4)}.json`)); }
      catch { return { ids, unreadable: true }; }
      continue;
    }
    if (!/^[0-9a-f-]{36}\.json$/.test(name)) return { ids, unreadable: true };
    const filename = path.join(directory, name);
    const info = lstatSync(filename);
    if (!info.isFile() || info.nlink !== 1 || info.size > 4096) return { ids, unreadable: true };
    try {
      const owner = JSON.parse(readFileSync(filename, "utf8"));
      if (!["active", "unknown"].includes(owner.state)
          || !["darwin", "linux", "win32"].includes(owner.platform)) return { ids, unreadable: true };
    } catch { return { ids, unreadable: true }; }
    ids.add(name.slice(0, -5));
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

function nativeOwner(id) {
  if (process.platform === "darwin") return { label: `com.21n.outright.utility.${id}` };
  if (process.platform === "linux") return { handshakePath: path.join(os.tmpdir(), `outright-utility-${id}`, "owner.json") };
  return { jobName: `Local\\OutrightUtility-${id}` };
}

function removeOwnedHandshake(handshakePath) {
  const directory = path.dirname(handshakePath);
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()
    || (info.mode & 0o077) !== 0) throw new Error("Utility handshake directory is not private");
  try { unlinkSync(handshakePath); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  rmdirSync(directory);
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
  let command = [file, ...args];
  if (process.platform === "darwin") command = [owner.label, ...command];
  else if (process.platform === "linux") command = ["--stop-on-owner-exit", owner.handshakePath, ...command];
  else if (process.platform === "win32") command = ["--utility-owner", owner.jobName, ...command];
  let child;
  try {
    child = (options.__spawn ?? spawn)(AGENT_SUPERVISOR, command, { cwd: options.cwd,
      env: { ...(options.env ?? process.env), OUTRIGHT_UTILITY_OWNER: "1" },
      windowsHide: true, stdio: ["pipe", "pipe", "pipe", "pipe"] });
  } catch (error) {
    if (directory) rmdirSync(directory);
    queueMicrotask(() => onClose(error, undefined, undefined, true));
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
  child.stdio[3]?.on("data", (chunk) => {
    proof += chunk.toString("utf8");
    if (proof.length > 4096) invalidProof = true;
    while (!invalidProof && proof.includes("\n")) {
      const end = proof.indexOf("\n") + 1;
      const line = proof.slice(0, end);
      proof = proof.slice(end);
      if (line === TREE_EMPTY_PROOF && !treeEmpty) treeEmpty = true;
      else if (line.startsWith(UTILITY_DIAGNOSTIC_PREFIX)) {
        if (diagnostics.length < 12) diagnostics.push(line.slice(UTILITY_DIAGNOSTIC_PREFIX.length).trimEnd());
      } else if (line !== "__OUTRIGHT_LAUNCH_AUTHORIZED_V1__\n") invalidProof = true;
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
    catch (failure) { error ??= failure; stop(); }
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
        if (directory && (treeEmpty || !spawned)) {
          removeOwnedHandshake(owner.handshakePath);
        }
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

function ownerProcessGone(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === "ESRCH"; }
}

async function reconcileNativeOwner(record, id) {
  if (!record || record.platform !== process.platform || !["active", "unknown"].includes(record.state)) return false;
  const expected = nativeOwner(id);
  if (Object.keys(expected).some((key) => record[key] !== expected[key])) return false;
  if (record.authorized === false) return ownerProcessGone(record.runtimePid);
  if (!ownerProcessGone(record.pid)) return false;
  if (process.platform === "linux") {
    let handshake;
    try { handshake = JSON.parse(readFileSync(record.handshakePath, "utf8")); }
    catch (error) { return error.code === "ENOENT"; }
    if (!Number.isSafeInteger(handshake.pid) || handshake.pid <= 0 || typeof handshake.processIdentity !== "string") return false;
    await nativeStatus(["--terminate-owned", String(handshake.pid), handshake.processIdentity, record.handshakePath]);
    try { lstatSync(record.handshakePath); return false; }
    catch (error) { return error.code === "ENOENT"; }
  }
  if (process.platform === "darwin") {
    const first = await nativeStatus(["--probe", record.label]);
    if (first.status === "alive" || first.status === "exited") await nativeStatus(["--terminate", record.label]);
    const last = await nativeStatus(["--probe", record.label]);
    return last.status === "absent";
  }
  const first = await nativeStatus(["--utility-probe", record.jobName]);
  if (first.status === "alive") await nativeStatus(["--utility-terminate", record.jobName]);
  const last = await nativeStatus(["--utility-probe", record.jobName]);
  // A disappeared named Job Object means its handles closed, but Windows may
  // still be terminating members. Only an observed zero active-process count
  // (or the live supervisor's proof frame) releases capacity.
  return last.status === "exited";
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
    const identity = nativeOwner(ownerId);
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
            } catch { /* Recovery retains the charged record. */ }
          }
          return;
        }
        settled = true;
        inFlightOwners.delete(ownerId);
        if (ownerProven) {
          try { releaseOwnerRecord(unknownDirectory, ownerId); active -= 1; }
          catch (releaseError) {
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
          ownerRecord(unknownDirectory, ownerId, { state: "active", authorized: true,
            pid, runtimePid: process.pid, ...observedOwner }, true);
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
        if (!await reconcileNativeOwner(record, id)) continue;
        try { unlinkSync(path.join(unknownDirectory, `${id}.tmp`)); }
        catch (error) { if (error.code !== "ENOENT") continue; }
        try { releaseOwnerRecord(unknownDirectory, id); }
        catch { continue; }
        if (record.handshakePath) {
          try { rmdirSync(path.dirname(record.handshakePath)); } catch { /* A later sweep can remove an empty directory. */ }
        }
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
