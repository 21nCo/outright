import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const launcher = fileURLToPath(new URL("../scripts/run-tests.mjs", import.meta.url));

function running(pid) {
  const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8", timeout: 1000 });
  if (result.error) throw result.error;
  if (result.status === 1 && !result.stdout.trim()) return false;
  assert.equal(result.status, 0, `Could not inspect test worker ${pid}: ${result.stderr}`);
  return !result.stdout.trim().startsWith("Z");
}

function runnerFor(launcherPid) {
  const result = spawnSync("ps", ["-e", "-o", "pid=,ppid=,pgid="], { encoding: "utf8", timeout: 1000 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Could not inspect test runner: ${result.stderr}`);
  const children = result.stdout.split("\n").map((line) => line.trim().split(/\s+/).map(Number));
  const runner = children.find(([pid, parent, group]) => parent === launcherPid && pid === group);
  return runner?.[0] ?? null;
}

function groupRunning(groupId) {
  const result = spawnSync("ps", ["-e", "-o", "pgid=,stat="], { encoding: "utf8", timeout: 1000 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Could not inspect test runner group: ${result.stderr}`);
  return result.stdout.split("\n").some((line) => {
    const [group, state] = line.trim().split(/\s+/);
    return Number(group) === groupId && state && !state.startsWith("Z");
  });
}

test("test launcher reaps its detached runner and a SIGTERM-ignoring descendant", { skip: process.platform === "win32", timeout: 15000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-test-runner-"));
  const marker = path.join(root, "worker.pid");
  const descendantMarker = path.join(root, "descendant.pid");
  const fixture = path.join(root, "hold.test.mjs");
  const descendant = `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(${JSON.stringify(descendantMarker)}, String(process.pid)); setInterval(() => {}, 1000);`;
  writeFileSync(fixture, `import { spawn } from "node:child_process";\nimport { writeFileSync } from "node:fs";\nspawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore" });\nwriteFileSync(${JSON.stringify(marker)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`);
  const env = { ...process.env, CI: "1" };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [launcher, fixture], { stdio: ["ignore", "pipe", "pipe"], env });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  let workerPid;
  let descendantPid;
  let runnerPid;
  try {
    const deadline = Date.now() + 5000;
    while ((!existsSync(marker) || !existsSync(descendantMarker) || !runnerPid) && Date.now() < deadline) {
      runnerPid ??= runnerFor(child.pid);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(existsSync(marker), `Test worker did not start: ${output}`);
    assert.ok(runnerPid, `Detached test runner did not start: ${output}`);
    workerPid = Number(readFileSync(marker, "utf8"));
    descendantPid = Number(readFileSync(descendantMarker, "utf8"));
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
    while (running(descendantPid) && Date.now() < stopped) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(running(descendantPid), false, `SIGTERM-ignoring descendant survived launcher interruption: ${output}`);
    assert.equal(groupRunning(runnerPid), false, `Detached test runner group survived launcher interruption: ${output}`);
    assert.match(output, /CI test launcher received SIGTERM/);
    assert.match(output, /CI test runner closed:/);
  } finally {
    if (runnerPid && groupRunning(runnerPid)) try { process.kill(-runnerPid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    if (workerPid && running(workerPid)) try { process.kill(workerPid, "SIGKILL"); } catch { /* Already gone. */ }
    if (descendantPid && running(descendantPid)) try { process.kill(descendantPid, "SIGKILL"); } catch { /* Already gone. */ }
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("test launcher reaps its detached group when a test worker fails to start", { skip: process.platform === "win32", timeout: 10000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-test-runner-startup-"));
  const fixture = path.join(root, "silent.test.mjs");
  const descendantMarker = path.join(root, "descendant.pid");
  const descendant = `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(${JSON.stringify(descendantMarker)}, String(process.pid)); setInterval(() => {}, 1000);`;
  writeFileSync(fixture, `import { spawn } from "node:child_process";\nspawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore" });\nawait new Promise((resolve) => setTimeout(resolve, 500));\nthrow new Error('induced worker startup failure');\n`);
  const env = { ...process.env, CI: "1" };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [launcher, fixture], { stdio: ["ignore", "pipe", "pipe"], env });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const closed = new Promise((resolve) => child.once("close", (status, signal) => resolve({ status, signal })));
  let runnerPid;
  let descendantPid;
  try {
    const deadline = Date.now() + 3000;
    while (!runnerPid && Date.now() < deadline) {
      runnerPid = runnerFor(child.pid);
      if (!runnerPid) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(runnerPid, "startup fixture never exposed its detached runner");
    assert.deepEqual(await closed, { status: 1, signal: null }, output);
    assert.match(output, /induced worker startup failure/);
    assert.ok(existsSync(descendantMarker), "startup fixture did not create its stubborn descendant");
    descendantPid = Number(readFileSync(descendantMarker, "utf8"));
    const stopped = Date.now() + 3000;
    while (running(descendantPid) && Date.now() < stopped) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(running(descendantPid), false, "failed worker left a SIGTERM-ignoring descendant executing");
    assert.equal(groupRunning(runnerPid), false, "a failed worker left the detached runner group executing");
  } finally {
    if (runnerPid && groupRunning(runnerPid)) try { process.kill(-runnerPid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    if (descendantPid && running(descendantPid)) try { process.kill(descendantPid, "SIGKILL"); } catch { /* Already gone. */ }
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});
