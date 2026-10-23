import assert from "node:assert/strict";
import { fork, spawn, spawnSync } from "node:child_process";
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
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };

// Either host, started as a user would run it, with archive recovery that
// can be held pending and terminal disposal that can be made to hang. A Vite
// host can load a config file and reload it, as an edited vite.config does.
// Windows cannot signal another process, so the test asks over IPC there.
function hostSource(kind, { gated = false, stuck = false, config = null } = {}) {
  const module = (name) => JSON.stringify(new URL(name, import.meta.url).href);
  return `import { createOutrightRuntime } from ${module("./outright-runtime.mjs")};
let release;
const recovered = new Promise((resolve) => { release = resolve; });
process.on("message", (message) => { if (message === "recover") release(); else if (typeof message === "string") process.emit(message); });
const recoverArchive = async () => { ${gated ? `process.stdout.write("recovering\\n"); await recovered;` : ""} };
const createRuntime = (options) => {
  const runtime = createOutrightRuntime(options);
  process.stdout.write("runtime-created\\n");
  ${stuck ? "runtime.terminals.shutdown = () => new Promise(() => {});" : ""}
  return runtime;
};
${kind === "vite" ? `const { createServer } = await import(${JSON.stringify(import.meta.resolve("vite"))});
const { outrightApiPlugin } = await import(${module("./outright-vite-plugin.mjs")});
globalThis.outrightFixture = { recoverArchive, createRuntime, failNext: false };
const server = await createServer({ configFile: ${config ? JSON.stringify(config) : "false"}, root: process.env.OUTRIGHT_CLIENT_DIR,
  logLevel: "silent", server: { host: "127.0.0.1", port: 0 },
  ${config ? "" : `plugins: [outrightApiPlugin({ configUrl: new URL(${module("../outright.config.json")}), recoverArchive, createRuntime })]`} });
await server.listen();
process.on("message", (message) => {
  if (message === "fail-restart") globalThis.outrightFixture.failNext = true;
  else if (message === "restart") server.restart().then(() => process.stdout.write("restart-done\\n"));
  // As Vite's q shortcut does.
  else if (message === "close") server.close().then(() => process.exit(0));
});
console.info("Outright is running at http://127.0.0.1:" + server.httpServer.address().port);`
    : `const { startStandalone } = await import(${module("./standalone-host.mjs")});
startStandalone({ recoverArchive, createRuntime });`}
`;
}

async function waitUntil(predicate, message, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(typeof message === "function" ? await message() : message);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function startOutright(t, env, { kind = null, ...fixture } = {}) {
  const child = kind
    ? spawn(process.execPath, ["--input-type=module", "-e", hostSource(kind, fixture)], { env: { ...env, CI: "true" }, stdio: ["ignore", "pipe", "pipe", "ipc"] })
    : fork(STANDALONE, [], { env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-8192); });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const running = () => child.exitCode === null && child.signalCode === null;
  t.after(async () => {
    if (!running()) return;
    if (kind === "vite") child.send("SIGTERM");
    else child.send({ type: "outright.shutdown", intent: "quit" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    await exited;
    clearTimeout(timer);
  });
  const host = {
    exited,
    running,
    stdout: () => stdout,
    send: (message) => child.send(message),
    signal(name) {
      if (process.platform === "win32") child.send(name);
      else child.kill(name);
    },
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
    // A live shell, and the pid of the shell process itself.
    async shell(cwd) {
      const terminal = await host.create(cwd);
      (await host.socket()).input(terminal.id, "console.log('shell-' + 'pid=' + process.pid)\r");
      const [, pid] = await waitUntil(async () => /shell-pid=(\d+)/.exec((await host.terminal(terminal.id))?.buffer ?? ""),
        "the shell did not report its pid");
      return { id: terminal.id, pid: Number(pid) };
    },
    // The next start shows the shell as saved output, never as live, and
    // has ended it.
    async ended(shell) {
      const saved = await waitUntil(async () => {
        const entry = await host.listed(shell.id);
        return entry?.status === "ended" ? entry : null;
      }, async () => `shell ${shell.id} was not restored as saved output: ${JSON.stringify(await host.listed(shell.id))}`);
      assert.equal(saved.reattached, undefined);
      assert.doesNotMatch(terminalTabLabel(saved), /reattached|running/);
      await waitUntil(() => !alive(shell.pid), `shell process ${shell.pid} outlived the next start`);
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

function workspace(t) {
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
  return { repo, env };
}

test("a live shell survives a graceful restart and reattaches with its output; after a quit, and once exited, it never resumes", { timeout: 180_000 }, async (t) => {
  const { repo, env } = workspace(t);

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

// One Ctrl-C reaches a process started by `npm run` twice at once: the
// terminal signals the process group and npm forwards the same signal.
test("one Ctrl-C delivered twice quits once; a later Ctrl-C forces the exit; neither leaves a shell to reattach", { timeout: 300_000 }, async (t) => {
  for (const kind of ["standalone", "vite"]) {
    const { repo, env } = workspace(t);
    const quitCode = kind === "vite" ? 130 : 0;
    const first = await startOutright(t, env, { kind });
    const shell = await first.shell(repo);
    first.signal("SIGINT");
    await delay(20);
    first.signal("SIGINT");
    assert.deepEqual(await first.exited, { code: quitCode, signal: null }, `${kind}: ${first.stdout()}`);
    // The quit ran to the end: it ended the shell before the host exited.
    assert.equal(alive(shell.pid), false, `${kind}: the repeated Ctrl-C abandoned the quit`);

    // Terminal disposal hangs here, so only a later Ctrl-C ends the host. The
    // shell it leaves running is ended, not reattached, by the next start.
    const stuck = await startOutright(t, env, { kind, stuck: true });
    await stuck.ended(shell);
    const left = await stuck.shell(repo);
    stuck.signal("SIGINT");
    await delay(1500);
    assert.equal(stuck.running(), true, `${kind}: the quit did not wait for terminal disposal`);
    stuck.signal("SIGINT");
    assert.deepEqual(await stuck.exited, { code: 130, signal: null }, `${kind}: ${stuck.stdout()}`);
    assert.equal(alive(left.pid), true, `${kind}: the forced exit was not the path under test`);

    const next = await startOutright(t, env);
    await next.ended(left);
    await next.stop("quit");
  }
});

test("a quit before the runtime exists leaves no shell to reattach, in either host", { timeout: 300_000 }, async (t) => {
  const { repo, env } = workspace(t);
  let host = await startOutright(t, env);
  for (const kind of ["vite", "standalone"]) {
    const shell = await host.shell(repo);
    await host.stop("restart");
    // Archive recovery holds startup; the quit arrives before the runtime.
    const quitting = await startOutright(t, env, { kind, gated: true });
    await waitUntil(() => quitting.stdout().includes("recovering"), `${kind}: recovery did not start`);
    quitting.signal("SIGINT");
    await delay(300);
    quitting.send("recover");
    assert.deepEqual(await quitting.exited, { code: kind === "vite" ? 130 : 0, signal: null }, `${kind}: ${quitting.stdout()}`);
    host = await startOutright(t, env);
    await host.ended(shell);
  }
  await host.stop("quit");
});

// Vite keeps the old server when a config reload fails, for example when a
// later plugin throws in its configureServer hook (before Vite runs
// Outright's post hook) or in its own post hook (after Outright's). That is
// not a restart: closing the server afterwards is still a quit, and the next
// successful reload hands the shells to the server that actually serves.
for (const phase of ["configureServer", "post hook"]) test(`a Vite config reload that fails in a later ${phase} is no restart: the served server reattaches after the next one, and a close still quits`, { timeout: 180_000 }, async (t) => {
  const { repo, env } = workspace(t);
  const config = path.join(path.dirname(repo), "vite.config.mjs");
  writeFileSync(config, `import { outrightApiPlugin } from ${JSON.stringify(new URL("./outright-vite-plugin.mjs", import.meta.url).href)};
const fixture = globalThis.outrightFixture;
export default { plugins: [
  outrightApiPlugin({ configUrl: new URL(${JSON.stringify(new URL("../outright.config.json", import.meta.url).href)}),
    recoverArchive: fixture.recoverArchive, createRuntime: fixture.createRuntime }),
  { name: "configures-after-outright", configureServer() {
    const fail = () => {
      if (!fixture.failNext) return;
      fixture.failNext = false;
      process.stdout.write("reload-failed\\n");
      throw new Error("a later plugin failed to configure");
    };
    ${phase === "post hook" ? "return fail;" : "fail();"}
  } }] };
`);
  const host = await startOutright(t, env, { kind: "vite", config });
  const reload = async ({ fail }) => {
    const done = host.stdout().split("restart-done").length;
    if (fail) host.send("fail-restart");
    host.send("restart");
    await waitUntil(() => host.stdout().split("restart-done").length > done, "the Vite reload did not finish");
    if (fail) assert.match(host.stdout(), /reload-failed/);
  };
  const shell = await host.shell(repo);
  await reload({ fail: true });
  await reload({ fail: false });
  // The server Vite now serves owns the runtime and reattached the same shell.
  const reattached = await waitUntil(async () => {
    const entry = await host.listed(shell.id).catch(() => null);
    return entry?.reattached && entry.status === "running" ? entry : null;
  }, async () => `the served server did not reattach the shell: ${host.stdout()}`);
  assert.equal(terminalTabLabel(reattached), "Terminal, live process reattached");
  assert.equal(host.stdout().split("runtime-created").length - 1, 2, "the failed reload started a runtime");
  assert.equal(alive(shell.pid), true);

  await reload({ fail: true });
  host.send("close");
  assert.deepEqual(await host.exited, { code: 0, signal: null }, host.stdout());
  const next = await startOutright(t, env);
  await next.ended(shell);
  await next.stop("quit");
});
