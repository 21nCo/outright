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

function windowsProcessIdentity(pid) {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `Get-CimInstance Win32_Process -Filter 'ProcessId = ${Number(pid)}' | Select-Object ProcessId,@{Name='CreatedMs';Expression={([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}} | ConvertTo-Json -Compress`],
  { encoding: "utf8", timeout: 8000, windowsHide: true });
  assert.equal(result.status, 0, `Could not inspect Windows test helper: ${result.stderr || result.error}`);
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

test("Windows launcher removes owned helpers after success, failure and cancellation", { skip: process.platform !== "win32", timeout: 45000 }, async () => {
  for (const outcome of ["success", "failure", "cancel"]) {
    const root = mkdtempSync(path.join(os.tmpdir(), `outright-win-runner-${outcome}-`));
    const marker = path.join(root, "helper.pid");
    const release = path.join(root, "release");
    const fixture = path.join(root, "owned.test.mjs");
    const helper = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`;
    writeFileSync(fixture, `import test from 'node:test';\nimport { spawn } from 'node:child_process';\nimport { existsSync } from 'node:fs';\ntest('owned helper', async () => {\n const child = spawn(process.execPath, ['-e', ${JSON.stringify(helper)}], { stdio: 'ignore' }); child.unref();\n const until = Date.now() + 5000; while (!existsSync(${JSON.stringify(marker)}) && Date.now() < until) await new Promise(r => setTimeout(r, 20));\n if (!existsSync(${JSON.stringify(marker)})) throw new Error('helper did not start');\n ${outcome === "cancel" ? "await new Promise(() => setInterval(() => {}, 1000));" : `while (!existsSync(${JSON.stringify(release)})) await new Promise(r => setTimeout(r, 20));` }\n ${outcome === "failure" ? "throw new Error('induced failure');" : ""}\n});\n`);
    const env = { ...process.env, CI: "1", ...(outcome === "cancel" ? { OUTRIGHT_TEST_SUITE_TIMEOUT_MS: "8000" } : {}) };
    delete env.NODE_TEST_CONTEXT;
    const launcherChild = spawn(process.execPath, [launcher, fixture], { stdio: ["ignore", "pipe", "pipe"], env });
    const closed = new Promise((resolve) => launcherChild.once("close", (status) => resolve(status)));
    let output = "";
    launcherChild.stdout.on("data", (chunk) => { output += chunk; });
    launcherChild.stderr.on("data", (chunk) => { output += chunk; });
    let identity;
    try {
      const deadline = Date.now() + 7000;
      while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
      assert.ok(existsSync(marker), `Windows helper did not start: ${output}`);
      const pid = Number(readFileSync(marker, "utf8"));
      identity = windowsProcessIdentity(pid);
      assert.ok(identity?.CreatedMs, `Windows helper identity was not captured: ${output}`);
      if (outcome !== "cancel") writeFileSync(release, "go");
      let timer;
      const status = await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Windows launcher hung: ${output}`)), 12000); })])
        .finally(() => clearTimeout(timer));
      assert.equal(status, outcome === "success" ? 0 : 1, output);
      if (outcome === "cancel") assert.match(output, /Test suite timed out after 8000ms/);
      const stopped = Date.now() + 3000;
      while (windowsProcessIdentity(pid)?.CreatedMs === identity.CreatedMs && Date.now() < stopped) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.notEqual(windowsProcessIdentity(pid)?.CreatedMs, identity.CreatedMs, `Owned helper survived ${outcome}: ${output}`);
    } finally {
      if (identity && windowsProcessIdentity(identity.ProcessId)?.CreatedMs === identity.CreatedMs) {
        spawnSync("taskkill", ["/PID", String(identity.ProcessId), "/T", "/F"], { windowsHide: true });
      }
      if (launcherChild.exitCode === null && launcherChild.signalCode === null) launcherChild.kill("SIGKILL");
      rmSync(root, { recursive: true, force: true });
    }
  }
});

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

test("a prior file's group-bound helper cannot interrupt the next test file", { skip: process.platform === "win32", timeout: 15000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-test-file-groups-"));
  const first = path.join(root, "first.test.mjs");
  const second = path.join(root, "second.test.mjs");
  const helperMarker = path.join(root, "helper.pid");
  const secondMarker = path.join(root, "second.started");
  const helper = `const { spawnSync } = require('node:child_process');
const { existsSync, writeFileSync } = require('node:fs');
const group = Number(spawnSync('/bin/ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).stdout.trim());
writeFileSync(${JSON.stringify(helperMarker)}, String(process.pid));
const deadline = Date.now() + 5000;
const timer = setInterval(() => {
  if (existsSync(${JSON.stringify(secondMarker)})) { clearInterval(timer); process.kill(-group, 'SIGKILL'); }
  else if (Date.now() > deadline) { clearInterval(timer); process.exit(0); }
}, 10);`;
  writeFileSync(first, `import test from 'node:test';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
test('first file owns a helper', async () => {
  const child = spawn(process.execPath, ['-e', ${JSON.stringify(helper)}], { stdio: 'ignore' });
  child.unref();
  const deadline = Date.now() + 2000;
  while (!existsSync(${JSON.stringify(helperMarker)}) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  if (!existsSync(${JSON.stringify(helperMarker)})) throw new Error('helper did not start');
});
`);
  writeFileSync(second, `import test from 'node:test';
import { writeFileSync } from 'node:fs';
test('second file survives its predecessor', async () => {
  writeFileSync(${JSON.stringify(secondMarker)}, 'started');
  await new Promise((resolve) => setTimeout(resolve, 200));
});
`);
  const env = { ...process.env, CI: "1" };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [launcher, first, second], { stdio: ["ignore", "pipe", "pipe"], env });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  let helperPid;
  try {
    const closed = new Promise((resolve) => child.once("close", (status, signal) => resolve({ status, signal })));
    let timer;
    const result = await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("File-isolated launcher did not finish")), 10_000); })])
      .finally(() => clearTimeout(timer));
    assert.deepEqual(result, { status: 0, signal: null }, output);
    assert.ok(existsSync(secondMarker), `second file never started: ${output}`);
    assert.match(output, /second file survives its predecessor/);
    helperPid = Number(readFileSync(helperMarker, "utf8"));
    assert.equal(running(helperPid), false, "prior file's helper survived its group cleanup");
  } finally {
    if (!helperPid && existsSync(helperMarker)) helperPid = Number(readFileSync(helperMarker, "utf8"));
    if (helperPid && running(helperPid)) try { process.kill(helperPid, "SIGKILL"); } catch { /* Already gone. */ }
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});
