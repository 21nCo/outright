import assert from "node:assert/strict";
import { fork, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { terminalTabLabel } from "../src/lib/terminal-exit-state.js";

// The whole restart path on each platform: the standalone host, its native
// supervisors and broker, and a real process exit between runtimes. A
// launcher asks for a graceful restart or a quit over the host's IPC channel.
const STANDALONE = fileURLToPath(new URL("./standalone.mjs", import.meta.url));

async function waitUntil(predicate, message, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(typeof message === "function" ? message() : message);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function startOutright(t, env) {
  const child = fork(STANDALONE, [], { env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-8192); });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const running = () => child.exitCode === null && child.signalCode === null;
  t.after(async () => {
    if (!running()) return;
    child.send({ type: "outright.shutdown", intent: "quit" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    await exited;
    clearTimeout(timer);
  });
  const host = {
    async ready() {
      const match = await waitUntil(() => /running at (http:\/\/[^\s]+)/.exec(stdout) || !running(),
        () => `Outright did not start: ${stderr}`);
      assert.ok(Array.isArray(match), `Outright exited before serving: ${stderr}`);
      host.url = match[1];
      return host;
    },
    async api(method, route, body) {
      const response = await fetch(new URL(route, host.url), { method,
        ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    },
    async terminal(id) { return (await host.api("GET", `/api/terminals/${id}`)).body; },
    async listed(id) { return (await host.api("GET", "/api/terminals")).body?.terminals?.find((entry) => entry.id === id); },
    async create(cwd) {
      // Run recovery answers 503 until it settles.
      const created = await waitUntil(async () => {
        const response = await host.api("POST", "/api/terminals", { cwd });
        if (response.status === 503) return null;
        return response;
      }, "terminal creation stayed unavailable");
      assert.equal(created.status, 201, JSON.stringify(created.body));
      return created.body;
    },
    async socket() {
      const socket = new WebSocket(`${host.url.replace(/^http/, "ws")}/api/events`);
      await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
      t.after(() => socket.terminate());
      return { input: (terminalId, data) => socket.send(JSON.stringify({ type: "terminal.input", terminalId, data })) };
    },
    async output(id, text) {
      return waitUntil(async () => {
        const terminal = await host.terminal(id);
        return terminal?.buffer?.includes(text) ? terminal : null;
      }, async () => `"${text}" never reached terminal ${id}`);
    },
    // The launcher's request; the host exits once the runtime has stopped.
    async stop(intent) {
      child.send({ type: "outright.shutdown", intent });
      const exit = await exited;
      assert.deepEqual(exit, { code: 0, signal: null }, stderr);
    },
  };
  return host.ready();
}

test("a live shell survives a graceful restart and reattaches with its output; after a quit, and once exited, it never resumes", { timeout: 180_000 }, async (t) => {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "outright-restart-")));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const repo = path.join(root, "repo");
  for (const args of [["init", repo], ["-C", repo, "config", "user.email", "test@example.com"],
    ["-C", repo, "config", "user.name", "Test"], ["-C", repo, "commit", "--allow-empty", "-m", "init"]]) {
    const result = spawnSync("git", args, { encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  }
  const client = path.join(root, "client");
  mkdirSync(client);
  writeFileSync(path.join(client, "index.html"), "<!doctype html><title>Fixture</title>");
  const env = { ...process.env, OUTRIGHT_DATA_DIR: path.join(root, "data"), OUTRIGHT_SCAN_ROOTS: root, OUTRIGHT_SCAN_DEPTH: "2",
    OUTRIGHT_CLIENT_DIR: client, PORT: "0", HOST: "127.0.0.1", SHELL: process.execPath, GIT_TRACE2_EVENT: "0" };

  const first = await startOutright(t, env);
  const live = await first.create(repo);
  const exited = await first.create(repo);
  const input = await first.socket();
  input.input(live.id, "globalThis.kept = 41; console.log('before-' + 'restart')\r");
  await first.output(live.id, "before-restart");
  // Printed while no runtime is attached; the broker keeps it for the next.
  input.input(live.id, "setTimeout(() => console.log('while-' + 'detached'), 1500); console.log('ar' + 'med')\r");
  await first.output(live.id, "armed");
  input.input(exited.id, "process.exit(3)\r");
  await waitUntil(async () => (await first.terminal(exited.id))?.status === "exited", "the command did not exit");
  await first.stop("restart");
  await new Promise((resolve) => setTimeout(resolve, 2000));

  const second = await startOutright(t, env);
  const reattached = await waitUntil(async () => {
    const entry = await second.listed(live.id);
    return entry?.reattached && entry.status === "running" ? entry : null;
  }, "the live shell was not reattached after a graceful restart");
  assert.equal(terminalTabLabel(reattached), "Terminal, live process reattached");
  const resumed = await second.output(live.id, "while-detached");
  assert.equal(resumed.buffer.split("before-restart").length, 2, resumed.buffer);
  assert.ok(resumed.buffer.indexOf("before-restart") < resumed.buffer.indexOf("while-detached"), resumed.buffer);
  // The same live process: its state survived the restart.
  (await second.socket()).input(live.id, "console.log('kept-' + (kept + 1))\r");
  await second.output(live.id, "kept-42");
  const ended = await second.listed(exited.id);
  assert.deepEqual([ended.status, ended.exitCode, ended.reattached], ["ended", 3, undefined]);
  assert.equal(terminalTabLabel(ended), "Terminal, saved output, process exited 3");
  await second.stop("quit");

  const third = await startOutright(t, env);
  const saved = await waitUntil(async () => {
    const entry = await third.listed(live.id);
    return entry?.status === "ended" ? entry : null;
  }, "the quit shell was not restored as saved output");
  assert.equal(saved.reattached, undefined);
  assert.doesNotMatch(terminalTabLabel(saved), /reattached|running/);
  assert.match((await third.terminal(live.id)).buffer, /kept-42/);
  assert.equal((await third.api("GET", "/api/capacity")).body.terminalProcesses.active, 0);
  await third.stop("quit");
});
