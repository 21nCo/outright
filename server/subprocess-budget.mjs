import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENT_SUPERVISOR } from "./agent-manager.mjs";

// The supervisor owns the entire native tree. Its close is the capacity
// release proof, including hooks which outlive their immediate Git parent.
function runOwned(file, args, options, onClose) {
  // Native inspection/control commands already wait for their own launchctl,
  // pidfd, or Job Object operation. Wrapping one supervisor in another would
  // make terminal emptiness proof depend on a second, unrelated owner.
  if (file === AGENT_SUPERVISOR && ["--probe", "--terminate", "--terminate-owned", "--identity"].includes(args[0])) {
    return execFile(file, args, options, onClose);
  }
  const directory = process.platform === "linux" ? mkdtempSync(path.join(os.tmpdir(), "outright-utility-")) : null;
  const command = process.platform === "darwin"
    ? [`com.21n.outright.utility.${randomUUID()}`, file, ...args]
    : process.platform === "linux"
      ? ["--stop-on-owner-exit", path.join(directory, "owner.json"), file, ...args]
      : [file, ...args];
  let child;
  try {
    child = spawn(AGENT_SUPERVISOR, command, { cwd: options.cwd, env: options.env,
      windowsHide: true, stdio: ["pipe", "pipe", "pipe", "pipe"] });
  } catch (error) {
    if (directory) rmSync(directory, { recursive: true, force: true });
    queueMicrotask(() => onClose(error));
    return;
  }
  const encoding = options.encoding === "buffer" ? null : options.encoding ?? "utf8";
  const maxBuffer = options.maxBuffer ?? 1024 * 1024;
  let stdout = [];
  let stderr = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let error;
  let timedOut = false;
  let deadlineTimer;
  child.stdin.on("error", () => {});
  const stop = () => {
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
  child.stdio[3]?.resume();
  child.once("spawn", () => { if (process.platform === "linux") child.stdin.write("go\n"); });
  if (options.timeout > 0) deadlineTimer = setTimeout(() => {
    timedOut = true;
    error ??= Object.assign(new Error(`Utility process timed out after ${options.timeout}ms`), { killed: true, signal: "SIGTERM" });
    stop();
  }, options.timeout);
  child.once("close", (code, signal) => {
    clearTimeout(deadlineTimer);
    options.signal?.removeEventListener("abort", onAbort);
    if (directory) rmSync(directory, { recursive: true, force: true });
    const output = (chunks) => encoding === null ? Buffer.concat(chunks) : Buffer.concat(chunks).toString(encoding);
    if (!error && (code !== 0 || signal)) error = Object.assign(new Error(`Utility process exited with ${signal ?? code}`), { code, signal });
    if (timedOut && error) error.killed = true;
    onClose(error, output(stdout), output(stderr));
  });
  // A failed native owner is never counted as empty before close. Its own
  // platform teardown is responsible for the remaining descendant tree.
  return child;
}

// Git, scanner and editor requests share one admission point. Command permits
// stay charged until close; detached editor permits cover process creation.
export function createSubprocessBudget({ limit = 8, execute = runOwned, launch = spawn } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("Utility process limit must be a non-negative integer");
  let active = 0;
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
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, stdout, stderr) => {
        if (settled) return;
        settled = true;
        active -= 1;
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
  return { run, launchDetached, capacity: () => ({ active, limit }) };
}

export const utilityProcesses = createSubprocessBudget();
