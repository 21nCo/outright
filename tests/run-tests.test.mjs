import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const launcher = fileURLToPath(new URL("../scripts/run-tests.mjs", import.meta.url));

function running(pid) {
  const result = spawnSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8", timeout: 1000 });
  if (result.status === 1 && !result.stdout.trim()) return false;
  assert.equal(result.status, 0, `Could not inspect test worker ${pid}: ${result.stderr}`);
  return !result.stdout.trim().startsWith("Z");
}

test("test launcher forwards interruption to its detached runner and worker", { skip: process.platform === "win32", timeout: 15000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-test-runner-"));
  const marker = path.join(root, "worker.pid");
  const fixture = path.join(root, "hold.test.mjs");
  writeFileSync(fixture, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`);
  const env = { ...process.env, CI: "1" };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [launcher, fixture], { stdio: ["ignore", "pipe", "pipe"], env });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  let workerPid;
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(existsSync(marker), `Test worker did not start: ${output}`);
    workerPid = Number(readFileSync(marker, "utf8"));
    child.kill("SIGTERM");
    let timer;
    const result = await Promise.race([
      new Promise((resolve) => child.once("close", (status, signal) => resolve({ status, signal }))),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Test launcher did not stop")), 5000); }),
    ]).finally(() => clearTimeout(timer));
    assert.deepEqual(result, { status: 143, signal: null }, output);
    const stopped = Date.now() + 3000;
    while (running(workerPid) && Date.now() < stopped) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(running(workerPid), false, `Test worker survived launcher interruption: ${output}`);
    assert.match(output, /CI test launcher received SIGTERM/);
    assert.match(output, /CI test runner closed:/);
  } finally {
    if (workerPid && running(workerPid)) try { process.kill(workerPid, "SIGKILL"); } catch { /* Already gone. */ }
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});
