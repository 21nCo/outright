import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export function assertCleanHead(cwd, head) {
  const actual = git(cwd, "rev-parse", "HEAD");
  if (actual !== head) throw new Error(`Review head changed: expected ${head}, got ${actual}`);
  const status = git(cwd, "status", "--porcelain");
  if (status) throw new Error(`Review snapshot was modified; preserve it for inspection: ${cwd}\n${status}`);
}

export function createSnapshot(repo, head) {
  const root = mkdtempSync(join(tmpdir(), "outright-review-"));
  const cwd = join(root, "repo");
  try {
    git(repo, "worktree", "add", "--detach", cwd, head);
    assertCleanHead(cwd, head);
    return { root, cwd, repo, head };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export function releaseSnapshot(snapshot) {
  assertCleanHead(snapshot.cwd, snapshot.head);
  git(snapshot.repo, "worktree", "remove", snapshot.cwd);
  rmSync(snapshot.root, { recursive: true, force: true });
}

export function runHermesJson({ profile, prompt, cwd, timeoutMs = 1_800_000 }) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, GH_CONFIG_DIR: "/Users/serro/.config/gh-other" };
    for (const key of Object.keys(env)) if (key.startsWith("HERMES_KANBAN_") || key === "HERMES_PROFILE") delete env[key];
    const child = spawn("hermes", ["--profile", profile, "chat", "--query-file", "-", "--oneshot", "-Q", "--in", cwd], {
      cwd, env, stdio: ["pipe", "pipe", "pipe"]
    });
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
    let stdout = "";
    let stderr = "";
    let finished = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
    }, timeoutMs);
    timer.unref();
    const collect = (which, chunk) => {
      const next = (which === "stdout" ? stdout : stderr) + chunk;
      if (next.length > 1_000_000) {
        child.kill("SIGTERM");
        return;
      }
      if (which === "stdout") stdout = next;
      else stderr = next;
    };
    child.stdout.on("data", (chunk) => collect("stdout", chunk));
    child.stderr.on("data", (chunk) => collect("stderr", chunk));
    child.on("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`${profile} failed (${signal ?? code}): ${stderr.slice(-3000) || stdout.slice(-3000)}`));
      try {
        const lines = stdout.split(/\r?\n/);
        const firstJsonLine = lines.findIndex((line) => line.trimStart().startsWith("{"));
        if (firstJsonLine < 0) throw new Error("No JSON object in response");
        resolve(JSON.parse(lines.slice(firstJsonLine).join("\n").trim()));
      } catch {
        reject(new Error(`${profile} did not return JSON: ${stdout.slice(-3000)}`));
      }
    });
  });
}
