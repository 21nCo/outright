import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const root = fileURLToPath(new URL("../", import.meta.url));

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

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
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
    socket.once("error", reject);
    socket.once("open", () => resolve({
      socket,
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
      if (!payload.id || !pending.has(payload.id)) return;
      const { done, fail } = pending.get(payload.id);
      pending.delete(payload.id);
      if (payload.error) fail(new Error(payload.error.message));
      else done(payload.result);
    });
  });
}

test("browser interaction regressions pass in headless Chrome", { timeout: 90_000 }, async () => {
  const port = await unusedPort();
  const debugPort = await unusedPort();
  const profile = mkdtempSync(path.join(tmpdir(), "outright-ui-races-"));
  const vite = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["exec", "--", "vite", "--config", "tests/vite.ui-races.config.mjs", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: root,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  vite.stdout.on("data", (chunk) => { output += chunk; });
  vite.stderr.on("data", (chunk) => { output += chunk; });
  const url = `http://127.0.0.1:${port}/tests/ui-races.html`;
  let browser;
  let devtools;

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
    });
    let browserOutput = "";
    browser.stdout.on("data", (chunk) => { browserOutput += chunk; });
    browser.stderr.on("data", (chunk) => { browserOutput += chunk; });
    await waitForJson(`http://127.0.0.1:${debugPort}/json/version`, browser, () => browserOutput);
    const targetResponse = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
    if (!targetResponse.ok) throw new Error(await targetResponse.text());
    const target = await targetResponse.json();
    devtools = await connectDevTools(target.webSocketDebuggerUrl);
    await devtools.send("Runtime.enable");
    const deadline = Date.now() + 30_000;
    let state;
    while (Date.now() < deadline) {
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
    assert.match(state.text, /8 interaction regressions passed/);
  } finally {
    devtools?.socket.close();
    await stop(browser);
    await stop(vite);
    rmSync(profile, { recursive: true, force: true });
  }
});
