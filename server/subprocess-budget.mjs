import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENT_SUPERVISOR } from "./agent-manager.mjs";

const TREE_EMPTY_PROOF = "__OUTRIGHT_UTILITY_TREE_EMPTY_V1__\n";

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
  if (!directory) return 0;
  try { ownerDirectory(directory); } catch { return Infinity; }
  let count = 0;
  for (const name of readdirSync(directory)) {
    if (!/^[0-9a-f-]{36}\.json$/.test(name)) return Infinity;
    const filename = path.join(directory, name);
    const info = lstatSync(filename);
    if (!info.isFile() || info.nlink !== 1 || info.size > 4096) return Infinity;
    try {
      const owner = JSON.parse(readFileSync(filename, "utf8"));
      if (!["active", "unknown"].includes(owner.state)
          || !["darwin", "linux", "win32"].includes(owner.platform)) return Infinity;
    } catch { return Infinity; }
    count += 1;
  }
  return count;
}

function ownerRecord(directory, id, owner, replace = false) {
  if (!directory) return;
  ownerDirectory(directory);
  const filename = path.join(directory, `${id}.json`);
  const temporary = replace ? path.join(directory, `${id}.tmp`) : filename;
  try {
    writeFileSync(temporary, `${JSON.stringify({ ...owner, platform: process.platform, recordedAt: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" });
    const descriptor = openSync(temporary, "r");
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
    if (replace) renameSync(temporary, filename);
    syncDirectory(directory);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function releaseOwnerRecord(directory, id) {
  if (!directory) return;
  rmSync(path.join(directory, `${id}.json`));
  syncDirectory(directory);
}

// The supervisor owns the entire native tree. Only its explicit empty-tree
// frame permits capacity release after close, including escaped Git hooks.
export function runOwned(file, args, options, onClose) {
  // Native inspection/control commands already wait for their own launchctl,
  // pidfd, or Job Object operation. Wrapping one supervisor in another would
  // make terminal emptiness proof depend on a second, unrelated owner.
  if (file === AGENT_SUPERVISOR && ["--probe", "--terminate", "--terminate-owned", "--identity"].includes(args[0])) {
    return execFile(file, args, options, (error, stdout, stderr) => onClose(error, stdout, stderr, true));
  }
  const directory = process.platform === "linux" ? mkdtempSync(path.join(os.tmpdir(), "outright-utility-")) : null;
  let command = [file, ...args];
  if (process.platform === "darwin") command = [`com.21n.outright.utility.${randomUUID()}`, ...command];
  else if (process.platform === "linux") command = ["--stop-on-owner-exit", path.join(directory, "owner.json"), ...command];
  let child;
  try {
    child = spawn(AGENT_SUPERVISOR, command, { cwd: options.cwd,
      env: { ...(options.env ?? process.env), OUTRIGHT_UTILITY_OWNER: "1" },
      windowsHide: true, stdio: ["pipe", "pipe", "pipe", "pipe"] });
  } catch (error) {
    if (directory) rmSync(directory, { recursive: true, force: true });
    queueMicrotask(() => onClose(error, undefined, undefined, true));
    return;
  }
  const encoding = options.encoding === "buffer" ? null : options.encoding === undefined ? "utf8" : options.encoding;
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
  let treeEmpty = false;
  let invalidProof = false;
  let stopSent = false;
  child.stdin.on("error", () => {});
  const stop = () => {
    if (stopSent) return;
    stopSent = true;
    if (process.platform === "darwin") child.kill("SIGTERM");
    else if (!child.stdin.destroyed) child.stdin.write("stop\n");
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
    if (proof.length > 256) invalidProof = true;
    while (!invalidProof && proof.includes("\n")) {
      const end = proof.indexOf("\n") + 1;
      const line = proof.slice(0, end);
      proof = proof.slice(end);
      if (line === TREE_EMPTY_PROOF && !treeEmpty) treeEmpty = true;
      else if (line !== "__OUTRIGHT_LAUNCH_AUTHORIZED_V1__\n") invalidProof = true;
    }
    if (invalidProof) treeEmpty = false;
  });
  child.stdio[3]?.on("error", (failure) => {
    invalidProof = true;
    error ??= failure;
  });
  child.once("spawn", () => {
    spawned = true;
    if (stopSent && process.platform === "darwin") child.kill("SIGTERM");
    if (process.platform === "linux" && !stopSent) child.stdin.write("go\n");
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
      try {
        if (process.platform === "darwin" && !treeEmpty && spawned) {
          const temporaryRoot = options.env?.TMPDIR ?? process.env.TMPDIR;
          const root = temporaryRoot && path.isAbsolute(temporaryRoot) ? temporaryRoot : "/tmp";
          rmSync(path.join(root, `outright-env-${command[0]}`), { recursive: true, force: true });
        }
        if (directory && (treeEmpty || !spawned)) rmSync(directory, { recursive: true, force: true });
      } catch (cleanupFailure) {
        treeEmpty = false;
        error ??= cleanupFailure;
      }
      const output = (chunks) => encoding === null ? Buffer.concat(chunks) : Buffer.concat(chunks).toString(encoding);
      if (!error && (code !== 0 || signal)) error = Object.assign(new Error(`Utility process exited with ${signal ?? code}`), { code, signal });
      if (timedOut && error) error.killed = true;
      onClose(error, output(stdout), output(stderr), treeEmpty || !spawned,
        { pid: child.pid, label: process.platform === "darwin" ? command[0] : undefined,
          handshakePath: directory ? command[1] : undefined });
    };
    if (process.platform === "darwin" && !treeEmpty && spawned) {
      // The submitted service can relaunch after the supervisor dies. Keep
      // its environment available until a bounded native bootout attempt
      // finishes, then retain unknown capacity if emptiness was not proven.
      try {
        execFile(AGENT_SUPERVISOR, ["--terminate", command[0]], { timeout: 5000, maxBuffer: 64 * 1024 },
          (terminationError) => { error ??= terminationError; finishClose(); });
      } catch (terminationError) { error ??= terminationError; finishClose(); }
    } else finishClose();
  });
  // A failed native owner without an empty-tree frame leaves a durable
  // unknown reservation; close alone cannot prove descendant cleanup.
  return child;
}

// Git, scanner and editor requests share one admission point. Command permits
// stay charged until close; detached editor permits cover process creation.
export function createSubprocessBudget({ limit = 8, execute = runOwned, launch = spawn, unknownDirectory = null } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("Utility process limit must be a non-negative integer");
  let unknown = retainedUnknownOwners(unknownDirectory);
  if (!Number.isFinite(unknown)) unknown = limit;
  let active = unknown;
  function admit() {
    if (active >= limit) {
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
    try { ownerRecord(unknownDirectory, ownerId, { state: "active" }); }
    catch (error) {
      active -= 1;
      return Promise.reject(Object.assign(new Error("Utility ownership reservation could not be recorded", { cause: error }),
        { code: "SUBPROCESS_OWNERSHIP_RECORD_FAILED", statusCode: 503 }));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, stdout, stderr, ownerProven = true, owner = {}) => {
        if (settled) return;
        settled = true;
        if (ownerProven) {
          try { releaseOwnerRecord(unknownDirectory, ownerId); active -= 1; }
          catch (releaseError) {
            ownerProven = false;
            error = new Error("Utility ownership reservation could not be cleared", { cause: releaseError });
          }
        }
        if (!ownerProven) {
          unknown += 1;
          try { ownerRecord(unknownDirectory, ownerId, { state: "unknown", ...owner }, true); }
          catch (retentionError) { error = new Error("Utility ownership could not be updated durably", { cause: retentionError }); }
          error = Object.assign(new Error("Utility descendant ownership is unknown; capacity remains reserved", { cause: error }),
            { code: "SUBPROCESS_OWNERSHIP_UNKNOWN", statusCode: 503, owner });
        }
        if (error) reject(Object.assign(error, { stdout, stderr }));
        else resolve({ stdout, stderr });
      };
      try { execute(file, args, options, finish); }
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
  return { run, launchDetached, capacity: () => ({ active, limit, unknown }) };
}

export const utilityProcesses = createSubprocessBudget({
  unknownDirectory: path.join(process.env.OUTRIGHT_DATA_DIR ?? path.join(os.homedir(), ".outright"), "utility-unknown"),
});
