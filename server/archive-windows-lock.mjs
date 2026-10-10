import { spawn, spawnSync } from "./child-process.mjs";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withoutDirectProviderCredentials } from "./execution-adapters/index.mjs";

function supervisorPath() {
  if (process.env.OUTRIGHT_AGENT_SUPERVISOR_PATH) return process.env.OUTRIGHT_AGENT_SUPERVISOR_PATH;
  const directory = fileURLToPath(new URL("./bin/", import.meta.url));
  const { filename } = JSON.parse(readFileSync(path.join(directory, "agent-supervisor.json"), "utf8"));
  if (typeof filename !== "string" || !/^agent-supervisor-[0-9a-f]{16}\.exe$/.test(filename)) {
    throw new Error("Windows archive lock supervisor manifest is invalid");
  }
  return path.join(directory, filename);
}

const pause = new Int32Array(new SharedArrayBuffer(4));
function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) return false;
    Atomics.wait(pause, 0, 0, 10);
  }
  return true;
}

export function sameWindowsArchiveFile(left, right) {
  if (process.platform !== "win32") throw new Error("Windows archive identity used on another platform");
  const result = spawnSync(supervisorPath(), ["--same-file", left, right],
    { stdio: "ignore", windowsHide: true, timeout: 5000, env: withoutDirectProviderCredentials(process.env) });
  if (result.status === 0) return true;
  if (result.status === 3) return false;
  throw new Error("Windows archive file identity could not be verified");
}

function archiveOwnerBirth(pid) {
  const result = spawnSync(supervisorPath(), ["--identity", String(pid)],
    { encoding: "utf8", windowsHide: true, timeout: 5000, env: withoutDirectProviderCredentials(process.env) });
  if (result.status === 3) return null;
  if (result.status === 0 && /^\d+$/.test(result.stdout.trim())) return result.stdout.trim();
  throw new Error("Windows archive lock owner identity is unknown");
}

function archiveOwnerExited(pid, birth) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  if (birth === undefined) return archiveOwnerBirth(pid) === null;
  if (birth === null) return true;
  const result = spawnSync(supervisorPath(), ["--probe", String(pid), birth],
    { encoding: "utf8", windowsHide: true, timeout: 5000, env: withoutDirectProviderCredentials(process.env) });
  if (result.status === 3) return true;
  if (result.status === 0 && result.stdout.trim() === "alive") return false;
  throw new Error("Windows archive lock owner exit is unknown");
}

function waitForArchiveRelease(ready, pid, birth, timeoutMs) {
  let nextProbeAt = 0;
  let exited = false;
  return waitUntil(() => {
    if (existsSync(ready)) return false;
    // The helper removes its ready file after releasing every OS lock.
    // Confirm process exit too, but do not spawn a native identity probe on
    // every 10 ms filesystem poll while Windows completes that exit.
    if (!exited && Date.now() >= nextProbeAt) {
      nextProbeAt = Date.now() + 100;
      exited = archiveOwnerExited(pid, birth);
    }
    return exited;
  }, timeoutMs);
}

// Call only after closing this process's SQLite connections. The native owner
// uses FILE_SHARE_DELETE and pins SQLite's lock bytes while synchronous JS
// performs the rename/unlink sequence. A competing SQLite connection cannot
// commit after acquisition; callers must revalidate source and candidate.
export function acquireWindowsArchiveLock(filenames) {
  if (process.platform !== "win32") throw new Error("Windows archive lock used on another platform");
  const unique = new Map();
  for (const filename of filenames) {
    const info = statSync(filename, { bigint: true });
    // Some Windows volumes report zero for ino. Do not collapse distinct
    // files to one lock when their identity is unavailable.
    const identity = info.ino > 0n ? `${info.dev}:${info.ino}` : path.resolve(filename).toLowerCase();
    unique.set(identity, filename);
  }
  const token = randomUUID();
  const ready = `${filenames[0]}.archive-lock-${token}.ready`;
  const stop = `${filenames[0]}.archive-lock-${token}.stop`;
  const child = spawn(supervisorPath(), ["--archive-lock", String(process.pid), ready, stop, ...unique.values()],
    { stdio: ["pipe", "ignore", "ignore"], windowsHide: true, env: withoutDirectProviderCredentials(process.env) });
  child.on("error", () => {});
  child.stdin.on("error", () => {});
  let ownerBirth;
  try {
    if (!Number.isSafeInteger(child.pid) || child.pid <= 0) throw new Error("Windows archive lock owner did not spawn");
    ownerBirth = archiveOwnerBirth(child.pid);
    let reported = "";
    if (!waitUntil(() => {
      try { reported = readFileSync(ready, "utf8"); return /^\d+$/.test(reported); }
      catch (error) {
        if (["ENOENT", "EACCES", "EPERM", "EBUSY"].includes(error.code)) return false;
        throw error;
      }
    }, 5000)) throw new Error("Windows archive lock did not start");
    const status = Number(reported);
    if (status !== 0) {
      const error = new Error(`Windows archive lock could not acquire its source and candidate (${status})`);
      if ([73, 74].includes(status)) error.code = "ARCHIVE_SOURCE_BUSY";
      throw error;
    }
    if (ownerBirth === null) throw new Error("Windows archive lock owner exited before admission");
  } catch (error) {
    try { writeFileSync(stop, "stop", { mode: 0o600, flag: "wx" }); } catch {}
    child.stdin.destroy();
    // The helper removes ready only after releasing its file locks. Preserve
    // stop and ready if that proof has not arrived; killing the helper would
    // strand the ready marker while its OS lock had already disappeared.
    if (!waitForArchiveRelease(ready, child.pid, ownerBirth, 5000)) {
      throw new AggregateError([error, new Error("Windows archive lock owner did not release")],
        "Windows archive lock startup and release failed");
    }
    rmSync(stop, { force: true });
    throw error;
  }
  return () => {
    let released = false;
    try {
      try { writeFileSync(stop, "stop", { mode: 0o600, flag: "wx" }); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      released = waitForArchiveRelease(ready, child.pid, ownerBirth, 5000);
      if (!released) {
        child.stdin.destroy();
        released = waitForArchiveRelease(ready, child.pid, ownerBirth, 5000);
        if (!released) {
          throw new Error("Windows archive lock did not release");
        }
      }
    } finally {
      child.stdin.destroy();
      if (released) rmSync(stop, { force: true });
    }
  };
}
