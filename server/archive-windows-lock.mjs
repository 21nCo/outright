import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
    { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
  child.on("error", () => {});
  child.stdin.on("error", () => {});
  try {
    let reported = "";
    if (!waitUntil(() => {
      try { reported = readFileSync(ready, "utf8"); return /^\d+$/.test(reported); }
      catch (error) { if (["ENOENT", "EACCES", "EPERM", "EBUSY"].includes(error.code)) return false; throw error; }
    }, 5000)) throw new Error("Windows archive lock did not start");
    const status = Number(reported);
    if (status !== 0) {
      const error = new Error(`Windows archive lock could not acquire its source and candidate (${status})`);
      if ([73, 74].includes(status)) error.code = "ARCHIVE_SOURCE_BUSY";
      throw error;
    }
  } catch (error) {
    try { writeFileSync(stop, "stop", { mode: 0o600, flag: "wx" }); } catch {}
    child.stdin.destroy();
    // The helper removes ready only after releasing its file locks. Preserve
    // stop and ready if that proof has not arrived; killing the helper would
    // strand the ready marker while its OS lock had already disappeared.
    if (!waitUntil(() => !existsSync(ready), 5000)) {
      throw new AggregateError([error, new Error("Windows archive lock owner did not release")],
        "Windows archive lock startup and release failed");
    }
    rmSync(stop, { force: true });
    throw error;
  }
  return () => {
    try {
      try { writeFileSync(stop, "stop", { mode: 0o600, flag: "wx" }); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      if (!waitUntil(() => !existsSync(ready), 5000)) {
        child.stdin.destroy();
        if (!waitUntil(() => !existsSync(ready), 5000)) {
          throw new Error("Windows archive lock did not release");
        }
      }
    } finally {
      child.stdin.destroy();
      if (!existsSync(ready)) rmSync(stop, { force: true });
    }
  };
}
