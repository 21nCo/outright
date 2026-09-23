import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const root = fileURLToPath(new URL("../", import.meta.url));
const viteCli = path.join(root, "node_modules", "vite", "bin", "vite.js");
const stubbornChild = path.join(root, "tests", "fixtures", "stubborn-child.mjs");
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

async function waitForServer(url, child, logs) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Vite exited before the UI harness loaded:\n${logs()}`);
    try {
      const response = await fetch(url);
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

function windowsDescendants(pid) {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress"],
  { encoding: "utf8", windowsHide: true, timeout: 5_000 });
  if (result.status !== 0) throw new Error(`Cannot inspect Windows process tree: ${result.stderr || result.error}`);
  const processes = [JSON.parse(result.stdout)].flat();
  const descendants = [];
  const frontier = [pid];
  while (frontier.length) {
    const parent = frontier.shift();
    for (const process of processes.filter((item) => item.ParentProcessId === parent)) {
      descendants.push(process.ProcessId);
      frontier.push(process.ProcessId);
    }
  }
  return descendants;
}

function terminateTree(child, signal) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    // Windows does not deliver catchable SIGTERM to Node children. Snapshot
    // descendants even when the leader has already exited, then force the tree.
    const descendants = windowsDescendants(child.pid);
    for (const pid of [child.pid, ...descendants].reverse()) {
      spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", windowsHide: true, timeout: 5_000 });
    }
    return;
  }
  // A detached group can outlive its leader and retain its inherited pipes.
  try { process.kill(-child.pid, signal); }
  catch (error) {
    if (error.code === "ESRCH") return;
    if (error.code !== "EPERM") throw error;
    // macOS Chrome may put protected helpers in its process group. The group
    // signal is rejected even though its own launcher is still ours to reap.
    if (!hasExited(child)) child.kill(signal);
    else if (!pipesClosed(child)) throw error;
  }
}

function treeGone(child) {
  if (process.platform === "win32") return hasExited(child) && windowsDescendants(child.pid).length === 0 && pipesClosed(child);
  try { process.kill(-child.pid, 0); return false; }
  catch (error) { if (error.code === "ESRCH" || error.code === "EPERM") return hasExited(child) && pipesClosed(child); throw error; }
}

async function waitForTree(child, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (treeGone(child)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return treeGone(child);
}

async function stop(child) {
  if (!child?.pid) return "absent";
  if (hasExited(child) && pipesClosed(child) && treeGone(child)) return "graceful";
  terminateTree(child, "SIGTERM");
  if (await waitForTree(child, 2_000)) return process.platform === "win32" ? "taskkill" : "graceful";
  terminateTree(child, "SIGKILL");
  if (!await waitForTree(child, 5_000)) throw new Error(`Process tree ${child.pid} did not exit after forced termination`);
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

async function waitForJson(url, child, logs) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Chrome exited before DevTools was ready:\n${logs()}`);
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch { /* Chrome is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}:\n${logs()}`);
}

function connectDevTools(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    let sequence = 0;
    let eventHandler = () => {};
    socket.once("error", reject);
    socket.once("open", () => resolve({
      socket,
      onEvent(handler) { eventHandler = handler; },
      send(method, params = {}) {
        return new Promise((done, fail) => {
          const id = ++sequence;
          pending.set(id, { done, fail });
          socket.send(JSON.stringify({ id, method, params }));
        });
      },
    }));
    socket.on("message", (message) => {
      const payload = JSON.parse(message);
      if (!payload.id) { eventHandler(payload); return; }
      if (!pending.has(payload.id)) return;
      const { done, fail } = pending.get(payload.id);
      pending.delete(payload.id);
      if (payload.error) fail(new Error(payload.error.message));
      else done(payload.result);
    });
    socket.on("close", () => {
      for (const { fail } of pending.values()) fail(new Error("DevTools connection closed"));
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
  if (devtools.socket.readyState >= WebSocket.CLOSING) return;
  await Promise.race([
    new Promise((resolve) => devtools.socket.once("close", resolve)),
    new Promise((resolve) => setTimeout(resolve, 1_000)),
  ]);
  if (devtools.socket.readyState < WebSocket.CLOSING) devtools.socket.close();
}

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
    assert.equal(outcome, process.platform === "win32" ? "taskkill" : "forced");
    assert.equal(hasExited(child) && child.stdout.closed && child.stderr.closed, true);
  } finally { await stop(child); }
});

test("exited group leader cannot leave a pipe-holding descendant", { timeout: 30_000 }, async () => {
  const child = spawn(process.execPath, [exitedLeader], {
    cwd: root, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  let descendantId;
  try {
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.stdout.on("data", (chunk) => {
        const match = chunk.toString().match(/descendant:(\d+)/);
        if (match) { descendantId = Number(match[1]); resolve(); }
      });
    });
    assert(await waitForExit(child, 3_000), "Leader did not exit independently");
    assert.equal(child.stdout.closed, false, "Fixture descendant did not retain the pipe");
    process.kill(descendantId, 0);
    await stop(child);
    assert.equal(child.stdout.closed && child.stderr.closed, true);
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

test("browser interaction regressions pass in headless Chrome", { timeout: 90_000 }, async () => {
  const port = await unusedPort();
  const debugPort = await unusedPort();
  const profile = mkdtempSync(path.join(tmpdir(), "outright-ui-races-"));
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
    await waitForServer(url, vite, () => output);
    browser = spawn(chromeExecutable(), [
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
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let browserOutput = "";
    browser.stdout.on("data", (chunk) => { browserOutput += chunk; });
    browser.stderr.on("data", (chunk) => { browserOutput += chunk; });
    await waitForJson(`http://127.0.0.1:${debugPort}/json/version`, browser, () => browserOutput);
    const targetResponse = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" });
    if (!targetResponse.ok) throw new Error(await targetResponse.text());
    const target = await targetResponse.json();
    devtools = await connectDevTools(target.webSocketDebuggerUrl);
    await devtools.send("Runtime.enable");
    await devtools.send("Page.enable");
    await devtools.send("Runtime.addBinding", { name: "__requestFixtureViewport" });
    await devtools.send("Runtime.addBinding", { name: "__requestFixtureKey" });
    await devtools.send("Page.addScriptToEvaluateOnNewDocument", { source: `
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
    ` });
    let viewportError;
    devtools.onEvent((event) => {
      if (event.method !== "Runtime.bindingCalled") return;
      (async () => {
        if (event.params.name === "__requestFixtureKey") {
          if (event.params.payload !== "Escape") throw new Error("Unexpected fixture key");
          const key = { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
          await devtools.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...key });
          await devtools.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
          await devtools.send("Runtime.evaluate", { expression: 'window.dispatchEvent(new CustomEvent("fixture-key-ready", { detail: "Escape" }))' });
          return;
        }
        if (event.params.name !== "__requestFixtureViewport") return;
        const width = Number(event.params.payload);
        if (![1280, 1200, 640, 620, 390].includes(width)) throw new Error(`Unexpected fixture viewport: ${width}`);
        await devtools.send("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 1, mobile: false });
        await devtools.send("Runtime.evaluate", { expression: `window.dispatchEvent(new CustomEvent("fixture-viewport-ready", { detail: ${width} }))` });
      })().catch((error) => { viewportError = error; });
    });
    await devtools.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 844, deviceScaleFactor: 1, mobile: false });
    await devtools.send("Page.navigate", { url });
    const deadline = Date.now() + 30_000;
    let state;
    while (Date.now() < deadline) {
      if (viewportError) throw viewportError;
      const evaluated = await devtools.send("Runtime.evaluate", {
        expression: "({ title: document.title, text: document.getElementById('results')?.textContent ?? '' })",
        returnByValue: true,
      });
      state = evaluated.result.value;
      if (state.title.startsWith("PASS")) break;
      if (state.title.startsWith("FAIL")) throw new Error(state.text);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.match(state?.title ?? "", /^PASS/, state?.text || browserOutput);
    assert.match(state.text, /10 interaction regressions passed/);
  } catch (error) {
    failure = error;
  } finally {
    try {
      await cleanupResources([
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
