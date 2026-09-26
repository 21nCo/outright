import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";

const root = fileURLToPath(new URL("../", import.meta.url));
const viteCli = path.join(root, "node_modules", "vite", "bin", "vite.js");
const stubbornChild = path.join(root, "tests", "fixtures", "stubborn-child.mjs");
const cooperativeChild = path.join(root, "tests", "fixtures", "cooperative-child.mjs");
const exitedLeader = path.join(root, "tests", "fixtures", "exited-leader.mjs");

function chromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"),
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe"),
  ].filter(Boolean);
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) throw new Error("Chrome or Chromium is required to run the UI interaction regressions");
  return executable;
}

async function unusedPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForServer(url, child, logs, deadline = Date.now() + 20_000) {
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Vite exited before the UI harness loaded:\n${logs()}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(Math.max(1, Math.min(2_000, deadline - Date.now()))) });
      if (response.ok) return;
    } catch { /* Vite is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}:\n${logs()}`);
}

function hasExited(child) {
  return !child || child.exitCode !== null || child.signalCode !== null;
}

function pipesClosed(child) {
  return child.stdout?.closed !== false && child.stderr?.closed !== false;
}

function waitForExit(child, timeout) {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const exited = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { child.off("exit", exited); resolve(false); }, timeout);
    child.once("exit", exited);
  });
}

function windowsProcesses(pids) {
  if (pids?.length === 0) return [];
  const filter = pids ? ` -Filter "${pids.map((pid) => `ProcessId = ${Number(pid)}`).join(" OR ")}"` : "";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `Get-CimInstance Win32_Process${filter} | Select-Object ProcessId,ParentProcessId,@{Name='CreatedMs';Expression={([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}} | ConvertTo-Json -Compress`],
  { encoding: "utf8", windowsHide: true, timeout: 8_000 });
  if (result.status !== 0) throw new Error(`Cannot inspect Windows process identities: ${result.stderr || result.error}`);
  const processes = result.stdout.trim() ? [JSON.parse(result.stdout)].flat().filter(Boolean) : [];
  if (processes.some((item) => !Number.isSafeInteger(item.ProcessId) || !Number.isSafeInteger(item.ParentProcessId)
    || !Number.isSafeInteger(item.CreatedMs))) throw new Error("Cannot verify Windows process identity timestamps");
  return processes;
}

function snapshotWindowsTree(child) {
  if (process.platform !== "win32" || !child?.pid) return;
  if (hasExited(child) && !child.ownedWindows?.size) return;
  recordWindowsTree(child, windowsProcesses());
}

function recordWindowsTree(child, processes) {
  child.ownedWindows ??= new Map();
  const live = new Map(processes.map((item) => [item.ProcessId, item]));
  if (!hasExited(child)) {
    const root = live.get(child.pid);
    if (!root && !child.ownedWindows.has(child.pid)) throw new Error(`Cannot identify owned Windows process ${child.pid}`);
    // A recorded launcher can disappear/recycle before Node observes exit.
    // Keep its old identity for child cleanup, but never adopt its replacement.
    if (root && !child.ownedWindows.has(child.pid)) child.ownedWindows.set(child.pid, root.CreatedMs);
  }
  // An exited leader's numeric PID may be recycled. Only traverse descendants
  // whose recorded creation identity still matches the current snapshot.
  const frontier = [...child.ownedWindows].filter(([pid, created]) =>
    live.get(pid)?.CreatedMs === created).map(([pid]) => pid);
  const visited = new Set(frontier);
  while (frontier.length) {
    const parent = frontier.shift();
    const parentCreated = child.ownedWindows.get(parent);
    for (const item of processes.filter((candidate) => candidate.ParentProcessId === parent)) {
      // Windows retains stale PPIDs when a PID is recycled. Creation order
      // must establish parentage before this process becomes a kill target.
      if (item.CreatedMs < parentCreated) continue;
      if (child.ownedWindows.has(item.ProcessId) && child.ownedWindows.get(item.ProcessId) !== item.CreatedMs) continue;
      child.ownedWindows.set(item.ProcessId, item.CreatedMs);
      if (!visited.has(item.ProcessId)) {
        visited.add(item.ProcessId);
        frontier.push(item.ProcessId);
      }
    }
  }
}

function liveWindowsOwned(child) {
  const owned = child.ownedWindows;
  if (!owned?.size) return [];
  return matchingOwnedProcesses(child, windowsProcesses([...owned.keys()]));
}

function matchingOwnedProcesses(child, processes) {
  return processes.filter((item) => child.ownedWindows?.get(item.ProcessId) === item.CreatedMs
    && (item.ProcessId !== child.pid || !hasExited(child)));
}

function killWindowsOwned(item) {
  if (!Number.isSafeInteger(item.CreatedMs)) throw new Error(`Windows process ${item.ProcessId} has no verified creation time`);
  // A .NET Process handle is held across the identity check and Kill(), so a
  // recycled numeric PID cannot become the termination target between them.
  const command = `$p=[System.Diagnostics.Process]::GetProcessById(${Number(item.ProcessId)}); try { $handle=$p.Handle; if (([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds() -eq ${item.CreatedMs}) { $p.Kill() } } finally { $p.Dispose() }`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command],
    { encoding: "utf8", windowsHide: true, timeout: 8_000 });
  // A process exiting during acquisition is not an error if the later liveness
  // check verifies it gone; all other errors remain visible to cleanup.
  if (result.status !== 0 && windowsProcesses([item.ProcessId]).some((current) => current.CreatedMs === item.CreatedMs)) {
    throw new Error(`Could not terminate owned Windows process ${item.ProcessId}: ${result.stderr || result.error}`);
  }
}

function posixGroupHasExecutable(output, groupId) {
  const members = output.split("\n").map((line) => {
    const fields = line.trim().match(/^(\d+)\s+(\S+)/);
    return fields && Number(fields[1]) === groupId ? fields[2] : null;
  }).filter(Boolean);
  return members.length === 0 || members.some((status) => !status.startsWith("Z"));
}

function livePosixGroup(child) {
  const result = spawnSync("ps", ["-e", "-o", "pgid=,stat="], { encoding: "utf8", timeout: 5_000 });
  if (result.status !== 0) throw new Error(`Cannot inspect POSIX group ${child.pid}: ${result.stderr || result.error}`);
  return posixGroupHasExecutable(result.stdout, child.pid);
}

function posixGroupDiagnostic(child) {
  const result = spawnSync("ps", ["-e", "-o", "pid=,ppid=,pgid=,stat=,comm="], { encoding: "utf8", timeout: 5_000 });
  if (result.status !== 0) return `ps failed: ${result.stderr || result.error}`;
  return result.stdout.split("\n").filter((line) => Number(line.trim().split(/\s+/)[2]) === child.pid).join(" | ");
}

function liveProfileHelpers(child) {
  if (!child.profile || process.platform === "win32") return [];
  const result = spawnSync("ps", ["-e", "-o", "pid=,stat=,command="], { encoding: "utf8", timeout: 5_000 });
  if (result.status !== 0) throw new Error(`Cannot inspect Chrome profile processes: ${result.stderr || result.error}`);
  const profileArg = `--user-data-dir=${child.profile}`;
  return result.stdout.split("\n").map((line) => line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/))
    .filter((match) => match && !match[2].startsWith("Z") && match[3].includes(profileArg))
    .map((match) => Number(match[1]));
}

function terminateOwnedChromeHelpers(child, signal) {
  if (!child.profile) return false;
  // The profile is a freshly created, private path passed only to this Chrome
  // launch. pkill matches commands when signalling, rather than checking a
  // numeric PID and later risking termination of a recycled, unrelated PID.
  const pattern = child.profile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const result = spawnSync("pkill", [signal === "SIGKILL" ? "-KILL" : "-TERM", "-f", pattern], { encoding: "utf8", timeout: 5_000 });
  if (result.status !== 0 && result.status !== 1) throw new Error(`Cannot terminate profile-owned Chrome helpers: ${result.stderr || result.error}`);
  return true;
}

function terminateTree(child, signal) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    // Never enumerate from or signal an exited leader's recycled numeric PID.
    snapshotWindowsTree(child);
    for (const item of liveWindowsOwned(child)) {
      if (item.ProcessId === child.pid && hasExited(child)) continue;
      killWindowsOwned(item);
    }
    return;
  }
  // A detached group can outlive its leader and retain its inherited pipes.
  try { process.kill(-child.pid, signal); }
  catch (error) {
    if (error.code === "ESRCH") {
      // Helpers can leave the launcher group even with file-backed output.
      terminateOwnedChromeHelpers(child, signal);
      return;
    }
    if (error.code !== "EPERM") throw error;
    // macOS Chrome may put protected helpers in its process group. The group
    // signal is rejected even though other helpers in this private profile
    // can be terminated individually without targeting a recycled PID.
    const profileOwned = terminateOwnedChromeHelpers(child, signal);
    if (!hasExited(child)) child.kill(signal);
    else if (!pipesClosed(child) && !profileOwned) throw error;
    return;
  }
  terminateOwnedChromeHelpers(child, signal);
}

function treeGone(child) {
  if (process.platform === "win32") return hasExited(child) && liveWindowsOwned(child).length === 0 && pipesClosed(child);
  try { process.kill(-child.pid, 0); }
  catch (error) {
    if (error.code === "ESRCH") return hasExited(child) && pipesClosed(child) && liveProfileHelpers(child).length === 0;
    if (error.code !== "EPERM") throw error;
    return false; // Permission denial cannot prove that the group is gone.
  }
  return hasExited(child) && pipesClosed(child) && !livePosixGroup(child) && liveProfileHelpers(child).length === 0;
}

async function waitForTree(child, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (treeGone(child)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return treeGone(child);
}

async function stop(child) {
  if (!child?.pid) return "absent";
  snapshotWindowsTree(child);
  if (hasExited(child) && pipesClosed(child) && treeGone(child)) return "graceful";
  terminateTree(child, "SIGTERM");
  if (await waitForTree(child, 2_000)) return process.platform === "win32" ? "forced" : "graceful";
  terminateTree(child, "SIGKILL");
  if (!await waitForTree(child, 5_000)) throw new Error(`Process tree ${child.pid} did not exit after forced termination; exit=${child.exitCode}/${child.signalCode}, pipes=${pipesClosed(child)}, group=${process.platform === "win32" ? "Windows owned-process snapshot" : posixGroupDiagnostic(child)}`);
  return "forced";
}

async function cleanupResources(steps) {
  const errors = [];
  for (const [label, cleanup] of steps) {
    try { await cleanup(); }
    catch (error) { errors.push(new Error(`${label}: ${error.message}`, { cause: error })); }
  }
  if (errors.length) throw new AggregateError(errors, `UI harness cleanup failed: ${errors.map((error) => error.message).join("; ")}`);
}

async function waitForJson(url, child, logs, diagnostic, deadline = Date.now() + 45_000) {
  while (Date.now() < deadline) {
    if (hasExited(child)) throw new Error(`Chrome exited before DevTools was ready: ${diagnostic()}; output: ${logs()}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(Math.max(1, Math.min(2_000, deadline - Date.now()))) });
      if (response.ok) return response.json();
    } catch { /* Chrome is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}: ${diagnostic()}; output: ${logs()}`);
}

function connectDevTools(url, handshakeTimeout = 10_000) {
  return new Promise((resolve, reject) => {
    // A responsive DevTools HTTP endpoint does not guarantee its WebSocket
    // upgrade completes. Bound the handshake independently of test timeout.
    const socket = new WebSocket(url, { handshakeTimeout });
    const pending = new Map();
    let sequence = 0;
    let eventHandler = () => {};
    socket.once("error", reject);
    socket.once("open", () => resolve({
      socket,
      onEvent(handler) { eventHandler = handler; },
      send(method, params = {}, timeout = 10_000) {
        return new Promise((done, fail) => {
          const id = ++sequence;
          const timer = setTimeout(() => {
            pending.delete(id);
            fail(new Error(`Timed out waiting for DevTools ${method}`));
          }, timeout);
          pending.set(id, { done, fail, timer });
          socket.send(JSON.stringify({ id, method, params }));
        });
      },
    }));
    socket.on("message", (message) => {
      const payload = JSON.parse(message);
      if (!payload.id) { eventHandler(payload); return; }
      if (!pending.has(payload.id)) return;
      const { done, fail, timer } = pending.get(payload.id);
      pending.delete(payload.id);
      clearTimeout(timer);
      if (payload.error) fail(new Error(payload.error.message));
      else done(payload.result);
    });
    socket.on("close", () => {
      for (const { fail, timer } of pending.values()) { clearTimeout(timer); fail(new Error("DevTools connection closed")); }
      pending.clear();
    });
  });
}

async function closeDevTools(devtools) {
  if (!devtools) return;
  try {
    await Promise.race([
      devtools.send("Browser.close"),
      new Promise((resolve) => setTimeout(resolve, 1_000)),
    ]);
  } catch { /* Forced process cleanup below remains authoritative. */ }
  if (devtools.socket.readyState === WebSocket.CLOSED) return;
  await Promise.race([
    new Promise((resolve) => devtools.socket.once("close", resolve)),
    new Promise((resolve) => setTimeout(resolve, 1_000)),
  ]);
  if (devtools.socket.readyState !== WebSocket.CLOSED) devtools.socket.terminate();
}

async function waitForFixture(send, deadline) {
  let state;
  while (Date.now() < deadline) {
    const evaluated = await send("Runtime.evaluate", {
      expression: "({ title: document.title, text: document.getElementById('results')?.textContent ?? '', progress: window.__fixtureProgress && { ...window.__fixtureProgress, elapsedMs: Math.round(performance.now() - window.__fixtureStartedAt), stepElapsedMs: Math.round(performance.now() - window.__fixtureProgress.stepStartedAt) } })",
      returnByValue: true,
    });
    const next = evaluated?.exceptionDetails ? null : evaluated?.result?.value;
    if (next && typeof next.title === "string") {
      state = next;
      if (state.title.startsWith("PASS")) return state;
      if (state.title.startsWith("FAIL")) throw new Error(`${state.text}\n${fixtureProgress(state)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))));
  }
  throw new Error(`Interaction phase exceeded its pre-cleanup deadline: ${fixtureProgress(state)}; page=${state?.title ?? "unavailable"}; output=${state?.text?.slice(-1000) ?? "unavailable"}`);
}

function fixtureProgress(state) {
  const progress = state?.progress;
  return progress
    ? `${progress.completed}/${progress.total} complete, current step=${progress.step}, elapsed=${progress.elapsedMs}ms, step=${progress.stepElapsedMs}ms`
    : "fixture has not reported a step";
}

test("browser fixture polling reports its last step and preserves the phase deadline", { timeout: 5_000 }, async () => {
  const progress = { step: "terminal activation", completed: 7, total: 21, elapsedMs: 1234, stepElapsedMs: 250 };
  const send = async () => ({ result: { value: { title: "Running", text: "Running interaction regressions", progress } } });
  await assert.rejects(waitForFixture(send, Date.now() + 30), /7\/21 complete, current step=terminal activation, elapsed=1234ms/);
  let polls = 0;
  const completed = await waitForFixture(async () => {
    polls += 1;
    return { result: { value: { title: polls === 2 ? "PASS" : "Running", text: "21 interaction regressions passed", progress } } };
  }, Date.now() + 500);
  assert.equal(completed.title, "PASS");
  assert.equal(polls, 2);
  let transientPolls = 0;
  const recovered = await waitForFixture(async () => {
    transientPolls += 1;
    if (transientPolls === 1) return { result: { value: { title: "Running", text: "Still running", progress } } };
    if (transientPolls === 2) return { exceptionDetails: { text: "Execution context was destroyed" } };
    if (transientPolls === 3) return { result: {} };
    return { result: { value: { title: "PASS", text: "Done" } } };
  }, Date.now() + 1_000);
  assert.equal(recovered.title, "PASS");
  assert.equal(transientPolls, 4);
  let missing = false;
  let missingPolls = 0;
  await assert.rejects(waitForFixture(async () => {
    missingPolls += 1;
    if (!missing) { missing = true; return { result: { value: { title: "Running", progress } } }; }
    return { exceptionDetails: { text: "Execution context was destroyed" } };
  }, Date.now() + 250), /7\/21 complete, current step=terminal activation/);
  assert(missingPolls >= 2, "Negative transient diagnostic never exercised its exceptional second evaluation");
});

test("a silent DevTools request fails within its bound", { timeout: 5_000 }, async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  let devtools;
  try {
    devtools = await connectDevTools(`ws://127.0.0.1:${server.address().port}`);
    await assert.rejects(devtools.send("Page.enable", {}, 25), /Timed out waiting for DevTools Page.enable/);
  } finally {
    devtools?.socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a stalled DevTools handshake releases its socket", { timeout: 5_000 }, async () => {
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", () => {}); // Receive the upgrade request but never answer.
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await assert.rejects(connectDevTools(`ws://127.0.0.1:${server.address().port}`, 50), /timed out/i);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(sockets.size, 0, "Timed-out handshake retained an open server-side socket");
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("process cleanup terminates the tree and waits for pipe close", { timeout: 20_000 }, async () => {
  const child = spawn(process.execPath, [stubbornChild], {
    cwd: root,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  try {
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.stdout.once("data", resolve);
    });
    const outcome = await stop(child);
    assert.equal(outcome, "forced");
    assert.equal(hasExited(child) && child.stdout.closed && child.stderr.closed, true);
  } finally { await stop(child); }
});

test("private-profile fallback signals only its owned process", { skip: process.platform === "win32", timeout: 15_000 }, async () => {
  const profile = mkdtempSync(path.join(tmpdir(), "outright-ui-races-"));
  const child = spawn(process.execPath, [stubbornChild, `--user-data-dir=${profile}`], {
    cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  child.profile = profile;
  try {
    await new Promise((resolve, reject) => { child.once("error", reject); child.stdout.once("data", resolve); });
    assert.equal(terminateOwnedChromeHelpers(child, "SIGKILL"), true);
    assert(await waitForTree(child, 5_000), "Profile-owned process survived atomic command-line matching");
  } finally {
    await stop(child);
    rmSync(profile, { recursive: true, force: true });
  }
});

test("normal stop reaps an escaped profile helper with file-backed output", { skip: process.platform === "win32", timeout: 20_000 }, async () => {
  const profile = mkdtempSync(path.join(tmpdir(), "outright-ui-races-"));
  const logFd = openSync(path.join(profile, "chrome.log"), "w");
  let launcher;
  let helper;
  try {
    launcher = spawn(process.execPath, [stubbornChild, `--user-data-dir=${profile}`], {
      cwd: root, detached: true, stdio: ["ignore", logFd, logFd],
    });
    helper = spawn(process.execPath, [stubbornChild, `--user-data-dir=${profile}`], {
      cwd: root, detached: true, stdio: ["ignore", logFd, logFd],
    });
    launcher.profile = profile;
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(hasExited(helper), false, "Fixture helper exited before cleanup");
    await stop(launcher);
    assert(await waitForExit(helper, 3_000), "Normal stop left the profile-owned helper alive outside the launcher group");
  } finally {
    closeSync(logFd);
    if (helper && !hasExited(helper)) { helper.kill("SIGKILL"); await waitForExit(helper, 3_000); }
    await stop(launcher);
    rmSync(profile, { recursive: true, force: true });
  }
});

test("exited group leader cannot leave a pipe-holding descendant", { timeout: 30_000 }, async () => {
  const child = spawn(process.execPath, [exitedLeader], {
    cwd: root, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  let descendantId;
  let fixtureOutput = "";
  try {
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.stdout.on("data", (chunk) => {
        fixtureOutput += chunk;
        if (fixtureOutput.includes("spawn-error:")) { reject(new Error(fixtureOutput)); return; }
        const match = fixtureOutput.match(/descendant:(\d+):ready/);
        if (match) { descendantId = Number(match[1]); resolve(); }
      });
    });
    if (process.platform === "win32") {
      const deadline = Date.now() + 4_000;
      do {
        snapshotWindowsTree(child);
        if (child.ownedWindows.has(descendantId)) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      } while (Date.now() < deadline);
      assert(child.ownedWindows.has(descendantId), "Windows fixture descendant identity was not captured before leader exit");
    }
    child.stdin.end("exit\n");
    assert(await waitForExit(child, 3_000), "Leader did not exit independently");
    if (process.platform !== "win32") assert.equal(child.stdout.closed, false, "Fixture descendant did not retain the pipe");
    if (process.platform === "win32") {
      assert(liveWindowsOwned(child).some((item) => item.ProcessId === descendantId), "Verified Windows descendant exited before stop");
    } else process.kill(descendantId, 0);
    await stop(child);
    assert.equal(child.stdout.closed && child.stderr.closed, true);
    if (process.platform === "win32") assert.equal(liveWindowsOwned(child).length, 0, "Owned descendant survived cleanup");
  } finally { await stop(child); }
});

test("fixture reports descendant spawn failure without waiting for self-expiry", { timeout: 10_000 }, async () => {
  const child = spawn(process.execPath, [exitedLeader], {
    cwd: root, env: { ...process.env, OUTRIGHT_TEST_MISSING_CHILD: "1" },
    detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  try {
    assert(await waitForExit(child, 5_000), "Spawn failure was not reported before fixture expiry");
    if (!child.stdout.closed) await new Promise((resolve) => child.stdout.once("close", resolve));
    assert.match(output, /spawn-error:/);
    assert.notEqual(child.exitCode, 0);
  } finally { await stop(child); }
});

test("cleanup runs all owners after an earlier failure", async () => {
  const attempted = [];
  await assert.rejects(cleanupResources([
    ["DevTools", async () => { attempted.push("DevTools"); throw new Error("socket failure"); }],
    ["browser", async () => { attempted.push("browser"); }],
    ["Vite", async () => { attempted.push("Vite"); }],
    ["profile", async () => { attempted.push("profile"); }],
  ]), /UI harness cleanup failed/);
  assert.deepEqual(attempted, ["DevTools", "browser", "Vite", "profile"]);
});

test("recycled Windows PIDs and POSIX zombie-only groups are not live owned targets", () => {
  const exited = { pid: 4100, exitCode: 0, signalCode: null, ownedWindows: new Map([[4100, 100], [4101, 200]]) };
  assert.deepEqual(matchingOwnedProcesses(exited, [
    { ProcessId: 4100, CreatedMs: 300 },
    { ProcessId: 4101, CreatedMs: 200 },
    { ProcessId: 4102, CreatedMs: 400 },
  ]).map((item) => item.ProcessId), [4101]);
  assert.deepEqual(matchingOwnedProcesses(exited, [{ ProcessId: 4101, CreatedMs: 500 }]), []);
  assert.equal(posixGroupHasExecutable("4100 Z\n4100 Z+\n42 S", 4100), false);
  assert.equal(posixGroupHasExecutable("4100 Z\n4100 S+", 4100), true);
  assert.equal(posixGroupHasExecutable("42 S", 4100), true, "An unobservable group cannot be declared gone");
});

test("two Windows snapshots discover late grandchildren only below identity-matching children", () => {
  const leader = { pid: 4100, exitCode: null, signalCode: null };
  recordWindowsTree(leader, [
    { ProcessId: 4100, ParentProcessId: 1, CreatedMs: 100 },
    { ProcessId: 4101, ParentProcessId: 4100, CreatedMs: 200 },
  ]);
  leader.exitCode = 0;
  recordWindowsTree(leader, [
    { ProcessId: 4100, ParentProcessId: 1, CreatedMs: 999 },
    { ProcessId: 4101, ParentProcessId: 4100, CreatedMs: 200 },
    { ProcessId: 4102, ParentProcessId: 4101, CreatedMs: 300 },
    { ProcessId: 4103, ParentProcessId: 4100, CreatedMs: 400 },
  ]);
  assert.equal(leader.ownedWindows.get(4102), 300);
  assert.equal(leader.ownedWindows.has(4103), false);
  recordWindowsTree(leader, [
    { ProcessId: 4101, ParentProcessId: 4100, CreatedMs: 888 },
    { ProcessId: 4104, ParentProcessId: 4101, CreatedMs: 500 },
  ]);
  assert.equal(leader.ownedWindows.has(4104), false);
  const recycled = { pid: 4200, exitCode: null, signalCode: null };
  recordWindowsTree(recycled, [
    { ProcessId: 4200, ParentProcessId: 1, CreatedMs: 1000 },
    { ProcessId: 4201, ParentProcessId: 4200, CreatedMs: 50 },
    { ProcessId: 4202, ParentProcessId: 4200, CreatedMs: 1100 },
    { ProcessId: 4203, ParentProcessId: 4202, CreatedMs: 1050 },
  ]);
  assert.equal(recycled.ownedWindows.has(4201), false, "Stale PPID adopted an older unrelated process");
  assert.equal(recycled.ownedWindows.has(4202), true);
  assert.equal(recycled.ownedWindows.has(4203), false, "Stale grandchild adopted below a verified parent");
});

test("a vanished Windows launcher preserves verified descendants without adopting a reused PID", () => {
  const launcher = { pid: 4100, exitCode: null, signalCode: null };
  recordWindowsTree(launcher, [
    { ProcessId: 4100, ParentProcessId: 1, CreatedMs: 100 },
    { ProcessId: 4101, ParentProcessId: 4100, CreatedMs: 200 },
  ]);
  recordWindowsTree(launcher, [
    { ProcessId: 4101, ParentProcessId: 4100, CreatedMs: 200 },
    { ProcessId: 4102, ParentProcessId: 4101, CreatedMs: 300 },
  ]);
  assert.equal(launcher.ownedWindows.get(4102), 300);
  recordWindowsTree(launcher, [
    { ProcessId: 4100, ParentProcessId: 1, CreatedMs: 999 },
    { ProcessId: 4101, ParentProcessId: 4100, CreatedMs: 200 },
    { ProcessId: 4103, ParentProcessId: 4100, CreatedMs: 1000 },
  ]);
  assert.equal(launcher.ownedWindows.has(4103), false);
});

// The child has 120 seconds including its 95-second interaction phase and
// cleanup. The parent must outlive that contract before invoking fallback
// cleanup, and retain a separate reserve for its own tree/profile cleanup.
const browserFixtureTimeout = 120_000;
const nestedStartupAllowance = 15_000;
const nestedRunnerBudget = (childBudget, startupAllowance) => childBudget + startupAllowance;
const nestedExitTimeout = nestedRunnerBudget(browserFixtureTimeout, nestedStartupAllowance);
test("nested runner deadline exceeds its child's full browser budget", () => {
  assert(nestedExitTimeout > browserFixtureTimeout);
  assert(nestedExitTimeout > 95_000 + 25_000);
});

test("parent permits a slow child beyond the old shorter watchdog", { timeout: 5_000 }, async () => {
  const child = spawn(process.execPath, [cooperativeChild], {
    cwd: root, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  try {
    await new Promise((resolve, reject) => { child.once("error", reject); child.stdout.once("data", resolve); });
    assert.equal(await waitForExit(child, 90), false, "Controlled child exited before the old watchdog");
    assert(await waitForExit(child, nestedRunnerBudget(100, 100)), "Parent did not allow child to finish its declared scaled budget");
    assert.equal(child.exitCode, 0, "Child did not finish naturally within its declared budget");
    assert.equal(child.signalCode, null, "Test's own forced kill must not satisfy the child budget");
  } finally {
    if (!hasExited(child)) child.kill("SIGKILL");
    await stop(child);
  }
});

test("fixture assertion failures still clean Chrome, Vite and profile independently", { timeout: nestedExitTimeout + 25_000 }, async (context) => {
  if (process.env.OUTRIGHT_TEST_UI_ASSERTION_FAILURE) { context.skip("Nested injected-failure run"); return; }
  const profile = mkdtempSync(path.join(tmpdir(), "outright-ui-races-"));
  const env = { ...process.env, OUTRIGHT_TEST_UI_ASSERTION_FAILURE: "1", OUTRIGHT_TEST_UI_PROFILE: profile };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ["--test", "--test-name-pattern=browser interaction regressions", fileURLToPath(import.meta.url)], {
    cwd: root, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true,
  });
  child.profile = profile;
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  let failure;
  try {
    snapshotWindowsTree(child);
    assert(await waitForExit(child, nestedExitTimeout), "Injected browser assertion did not terminate within the child and cleanup budgets");
    assert.notEqual(child.exitCode, 0, output);
    assert.match(output, /Injected UI assertion failure after fixture pass/);
    assert.doesNotMatch(output, /UI harness cleanup failed|did not exit after forced termination|ENOTEMPTY/);
  } catch (error) { failure = error; }
  finally {
    try {
      await cleanupResources([
        ["nested runner", () => stop(child)],
        ["nested Chrome profile", () => rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })],
      ]);
    } catch (error) {
      if (failure) throw new AggregateError([failure, error], `Injected fixture failed: ${failure.message}; ${error.message}`);
      throw error;
    }
  }
  if (failure) throw failure;
});

test("browser interaction regressions pass in headless Chrome", { timeout: browserFixtureTimeout }, async () => {
  // Reserve the last part of the test's own bound for independent cleanup.
  const deadline = Date.now() + 95_000;
  let phase = "allocate fixture";
  const remaining = () => {
    const duration = deadline - Date.now();
    if (duration <= 0) throw new Error(`UI fixture exceeded its pre-cleanup deadline during ${phase}`);
    return duration;
  };
  const port = await unusedPort();
  const debugPort = await unusedPort();
  const profile = process.env.OUTRIGHT_TEST_UI_PROFILE ?? mkdtempSync(path.join(tmpdir(), "outright-ui-races-"));
  const vite = spawn(process.execPath, [viteCli, "--config", "tests/vite.ui-races.config.mjs", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: root,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  let output = "";
  vite.stdout.on("data", (chunk) => { output += chunk; });
  vite.stderr.on("data", (chunk) => { output += chunk; });
  const url = `http://127.0.0.1:${port}/tests/ui-races.html`;
  let browser;
  let devtools;
  let failure;

  try {
    phase = "wait for Vite";
    await waitForServer(url, vite, () => output, Math.min(Date.now() + 20_000, deadline));
    snapshotWindowsTree(vite);
    const executable = chromeExecutable();
    const launchedAt = new Date().toISOString();
    const browserLog = path.join(profile, "chrome.log");
    const logFd = openSync(browserLog, "w");
    try {
      browser = spawn(executable, [
      "--headless=new",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-default-browser-check",
      "--no-first-run",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      "about:blank",
    ], {
      cwd: root,
      // A browser helper may outlive its launcher and inherit these handles.
      // Capture diagnostics to a private file, not pipes keeping Node alive.
      stdio: ["ignore", logFd, logFd],
      detached: process.platform !== "win32",
      windowsHide: true,
      });
    } finally { closeSync(logFd); }
    browser.profile = profile;
    const logs = () => {
      try { return readFileSync(browserLog, "utf8").slice(-10_000); }
      catch { return ""; }
    };
    let browserError;
    browser.once("error", (error) => { browserError = error; });
    const diagnostic = () => JSON.stringify({ executable, pid: browser.pid, launchedAt, checkedAt: new Date().toISOString(), exitCode: browser.exitCode, signalCode: browser.signalCode, spawnError: browserError?.message });
    if (process.platform === "win32") {
      const captureDeadline = Date.now() + 10_000;
      while (!browserError && !hasExited(browser) && Date.now() < captureDeadline) {
        const rootProcess = windowsProcesses([browser.pid])[0];
        if (rootProcess) { recordWindowsTree(browser, [rootProcess]); break; }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (!browser.ownedWindows?.has(browser.pid)) throw new Error(`Cannot capture Chrome launch identity: ${diagnostic()}; output: ${logs()}`);
    }
    phase = "wait for Chrome DevTools HTTP";
    await waitForJson(`http://127.0.0.1:${debugPort}/json/version`, browser, logs, diagnostic, Math.min(Date.now() + 45_000, deadline));
    snapshotWindowsTree(browser);
    phase = "create DevTools target";
    const targetResponse = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT", signal: AbortSignal.timeout(Math.min(10_000, remaining())) });
    if (!targetResponse.ok) throw new Error(await targetResponse.text());
    const target = await targetResponse.json();
    phase = "connect DevTools WebSocket";
    devtools = await connectDevTools(target.webSocketDebuggerUrl, Math.min(10_000, remaining()));
    const send = (method, params) => devtools.send(method, params, Math.min(10_000, remaining()));
    phase = "install fixture bindings";
    await send("Runtime.enable");
    await send("Page.enable");
    await send("Runtime.addBinding", { name: "__requestFixtureViewport" });
    await send("Runtime.addBinding", { name: "__requestFixtureKey" });
    await send("Runtime.addBinding", { name: "__requestFixtureWheel" });
    await send("Page.addScriptToEvaluateOnNewDocument", { source: `
      window.__fixtureSetViewport = (width) => new Promise((resolve) => {
        const ready = (event) => {
          if (event.detail !== width) return;
          window.removeEventListener("fixture-viewport-ready", ready);
          resolve();
        };
        window.addEventListener("fixture-viewport-ready", ready);
        window.__requestFixtureViewport(String(width));
      });
      window.__fixtureSendKey = (key) => new Promise((resolve) => {
        const ready = (event) => {
          if (event.detail !== key) return;
          window.removeEventListener("fixture-key-ready", ready);
          resolve();
        };
        window.addEventListener("fixture-key-ready", ready);
        window.__requestFixtureKey(key);
      });
      window.__fixtureWheel = (x, y, deltaY) => new Promise((resolve) => {
        const id = Math.random().toString(36).slice(2);
        const ready = (event) => {
          if (event.detail !== id) return;
          window.removeEventListener("fixture-wheel-ready", ready);
          resolve();
        };
        window.addEventListener("fixture-wheel-ready", ready);
        window.__requestFixtureWheel(JSON.stringify({ id, x, y, deltaY }));
      });
    ` });
    let viewportError;
    devtools.onEvent((event) => {
      if (event.method !== "Runtime.bindingCalled") return;
      (async () => {
        if (event.params.name === "__requestFixtureWheel") {
          const wheel = JSON.parse(event.params.payload);
          await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: wheel.x, y: wheel.y, deltaX: 0, deltaY: wheel.deltaY });
          await send("Runtime.evaluate", { expression: `window.dispatchEvent(new CustomEvent("fixture-wheel-ready", { detail: ${JSON.stringify(wheel.id)} }))` });
          return;
        }
        if (event.params.name === "__requestFixtureKey") {
          if (!["Escape", "Tab", "End"].includes(event.params.payload)) throw new Error("Unexpected fixture key");
          const code = event.params.payload === "Tab" ? 9 : event.params.payload === "End" ? 35 : 27;
          const key = { key: event.params.payload, code: event.params.payload, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
          await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...key });
          await send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
          await send("Runtime.evaluate", { expression: `window.dispatchEvent(new CustomEvent("fixture-key-ready", { detail: ${JSON.stringify(event.params.payload)} }))` });
          return;
        }
        if (event.params.name !== "__requestFixtureViewport") return;
        const width = Number(event.params.payload);
        if (![1280, 1200, 760, 640, 620, 390].includes(width)) throw new Error(`Unexpected fixture viewport: ${width}`);
        await send("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 1, mobile: false });
        await send("Runtime.evaluate", { expression: `window.dispatchEvent(new CustomEvent("fixture-viewport-ready", { detail: ${width} }))` });
      })().catch((error) => { viewportError = error; });
    });
    await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 844, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url });
    phase = "run browser interaction fixtures";
    const state = await waitForFixture(async (method, params) => {
      if (viewportError) throw viewportError;
      return send(method, params);
    }, deadline);
    assert.match(state.text, /60 interaction regressions passed/);
    const performanceFixture = state.text.match(/Performance fixture: (\{[^\n]+\})/);
    assert.ok(performanceFixture, "large fixture measurements were not recorded");
    console.log(`UI performance: ${performanceFixture[1]}`);
    if (process.env.OUTRIGHT_TEST_UI_ASSERTION_FAILURE === "1") throw new Error("Injected UI assertion failure after fixture pass");
  } catch (error) {
    failure = new Error(`UI fixture ${phase}: ${error.message}`, { cause: error });
  } finally {
    try {
      await cleanupResources([
        ["Chrome identity snapshot", () => snapshotWindowsTree(browser)],
        ["DevTools", () => closeDevTools(devtools)],
        ["Chrome tree", () => stop(browser)],
        ["Vite tree", () => stop(vite)],
        ["Chrome profile", () => rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })],
      ]);
    } catch (error) {
      if (failure) throw new AggregateError([failure, error], `UI fixture failed: ${failure.message}; ${error.message}`);
      throw error;
    }
  }
  if (failure) throw failure;
});
