import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import Database from "better-sqlite3";
import { outrightApiPlugin } from "./outright-vite-plugin.mjs";
import { createOutrightRuntime } from "./outright-runtime.mjs";
import { createOutrightDatabase } from "./database.mjs";
import { createTerminalManager } from "./terminal-manager.mjs";

test("Vite disposal awaits runtime process supervision before completing", async () => {
  let release;
  const termination = new Promise((resolve) => { release = resolve; });
  let attached;
  const plugin = outrightApiPlugin({ configUrl: new URL("file:///fixture/config.json"), recoverArchive: async () => {}, createRuntime: () => ({ attach: (server) => { attached = server; }, shutdown: () => termination }) });
  const server = { middlewares: { use() {} } };
  plugin.configureServer(server);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(attached);
  let closed = false;
  const closing = plugin.closeBundle().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  release();
  await closing;
  assert.equal(closed, true);
});

test("Vite disposal waits for storage recovery instead of caching a rejected close", async () => {
  let releaseRecovery;
  const recovered = new Promise((resolve) => { releaseRecovery = resolve; });
  let held = false;
  let attached = 0;
  const options = { configUrl: new URL("file:///fixture/storage-recovery.json"), recoverArchive: async () => {},
    createRuntime: () => {
      if (held) throw Object.assign(new Error("runtime lease held"), { code: "OUTRIGHT_RUNTIME_LEASE_HELD" });
      held = true;
      return { attach() { attached += 1; },
        shutdown: async () => { throw Object.assign(new Error("storage unavailable"), { code: "OUTRIGHT_SHUTDOWN_RECOVERY_PENDING" }); },
        whenShutdownComplete: () => recovered };
    } };
  const first = outrightApiPlugin(options);
  first.configureServer({ middlewares: { use() {} } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attached, 1);
  const closing = first.closeBundle();
  let settled = false;
  void closing.then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "Vite dropped the old runtime while its recovery owner held the lease");
  held = false;
  releaseRecovery();
  await closing;
  assert.equal(settled, true);
  const successor = outrightApiPlugin(options);
  successor.configureServer({ middlewares: { use() {} } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attached, 2);
  held = false;
  releaseRecovery();
  await successor.closeBundle();
});

test("Vite reports a final disposal error after storage recovery releases the lease", async () => {
  let rejectRecovery;
  const completion = new Promise((_, reject) => { rejectRecovery = reject; });
  let held = false;
  const options = { configUrl: new URL("file:///fixture/final-disposal.json"), recoverArchive: async () => {},
    createRuntime: () => {
      if (held) throw Object.assign(new Error("lease held"), { code: "OUTRIGHT_RUNTIME_LEASE_HELD" });
      held = true;
      return { attach() {}, shutdown: async () => {
        throw Object.assign(new Error("outcome pending"), { code: "OUTRIGHT_SHUTDOWN_RECOVERY_PENDING" });
      }, whenShutdownComplete: () => completion };
    } };
  const first = outrightApiPlugin(options);
  first.configureServer({ middlewares: { use() {} } });
  await new Promise((resolve) => setImmediate(resolve));
  const closing = first.closeBundle();
  held = false;
  rejectRecovery(Object.assign(new Error("terminal disposal failed"), { code: "OUTRIGHT_SHUTDOWN_DISPOSAL_FAILED" }));
  await assert.rejects(closing, /terminal disposal failed/);
  const successor = outrightApiPlugin(options);
  successor.configureServer({ middlewares: { use() {} } });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(successor.closeBundle(), /terminal disposal failed/);
});

test("build-only plugin disposal does not start a runtime", () => {
  const plugin = outrightApiPlugin({ configUrl: new URL("file:///fixture/config.json"), createRuntime: () => { throw new Error("Unexpected runtime"); } });
  assert.equal(plugin.closeBundle(), undefined);
});

test("Vite serves a retryable API response while archive recovery is pending", async () => {
  let finishRecovery;
  let middleware;
  let requests = 0;
  const httpServer = new EventEmitter();
  const plugin = outrightApiPlugin({
    configUrl: new URL("file:///fixture/config.json"),
    recoverArchive: () => new Promise((resolve) => { finishRecovery = resolve; }),
    createRuntime: () => ({
      attach() {},
      handleRequest: async () => { requests += 1; return true; },
      shutdown: async () => {},
    }),
  });
  plugin.configureServer({ httpServer, middlewares: { use(fn) { middleware = fn; } } });
  await Promise.resolve();
  let status;
  let headers;
  let body;
  const response = { writeHead(code, nextHeaders) { status = code; headers = nextHeaders; }, end(value) { body = JSON.parse(value); } };
  middleware({ url: "/api/capacity" }, response, () => assert.fail("API request fell through"));
  assert.equal(status, 503);
  assert.equal(headers["retry-after"], "1");
  assert.match(body.error, /recovery is in progress/);
  assert.equal(body.code, "ARCHIVE_MAINTENANCE_TRANSIENT");
  const upgrade = { writes: [], destroyed: false, write(value) { this.writes.push(value); }, destroy() { this.destroyed = true; } };
  httpServer.emit("upgrade", { url: "/" }, upgrade);
  assert.equal(upgrade.destroyed, false, "Vite HMR upgrade was rejected during archive recovery");
  httpServer.emit("upgrade", { url: "/api/events-other" }, upgrade);
  assert.equal(upgrade.destroyed, false, "Unrelated API upgrade was rejected during archive recovery");
  assert.equal(upgrade.writes.length, 0, "Unrelated upgrades received an API response");
  httpServer.emit("upgrade", { url: "/api/events?cursor=0" }, upgrade);
  assert.equal(upgrade.destroyed, true);
  assert.match(upgrade.writes[0], /503 Service Unavailable[\s\S]*Retry-After: 1/);
  finishRecovery();
  await new Promise((resolve) => setImmediate(resolve));
  middleware({ url: "/api/capacity" }, response, () => assert.fail("API request fell through"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests, 1);
  await plugin.closeBundle();
});

test("failed Vite recovery reports a terminal API error without taking HMR ownership", async () => {
  const httpServer = new EventEmitter();
  let middleware;
  const plugin = outrightApiPlugin({
    configUrl: new URL("file:///fixture/config.json"),
    recoverArchive: async () => { throw new Error("invalid archive marker"); },
    createRuntime: () => assert.fail("invalid recovery started the runtime"),
  });
  const priorError = console.error;
  console.error = () => {};
  try {
    plugin.configureServer({ httpServer, middlewares: { use(fn) { middleware = fn; } } });
    await new Promise((resolve) => setImmediate(resolve));
    let status;
    let headers;
    let body;
    middleware({ url: "/api/capacity" }, {
      writeHead(code, nextHeaders) { status = code; headers = nextHeaders; },
      end(value) { body = JSON.parse(value); },
    }, () => assert.fail("failed recovery fell through"));
    assert.equal(status, 500);
    assert.equal(headers["retry-after"], undefined);
    assert.match(body.error, /requires inspection/);
    assert.equal(body.code, "ARCHIVE_MAINTENANCE_FAILED");
    const socket = { writes: [], destroyed: false, write(value) { this.writes.push(value); }, destroy() { this.destroyed = true; } };
    httpServer.emit("upgrade", { url: "/" }, socket);
    assert.equal(socket.destroyed, false);
    assert.deepEqual(socket.writes, [], "failed recovery wrote to Vite's HMR socket");
    httpServer.emit("upgrade", { url: "/api/events" }, socket);
    assert.equal(socket.destroyed, true);
    assert.match(socket.writes[0], /500 Internal Server Error/);
    await plugin.closeBundle();
  } finally { console.error = priorError; }
});

test("Vite config restart releases the old runtime lease before the replacement attaches", async () => {
  let leaseHeld = false;
  let attached = 0;
  let released = 0;
  const createRuntime = () => {
    if (leaseHeld) {
      const error = new Error("prior runtime owns the database");
      error.code = "OUTRIGHT_RUNTIME_LEASE_HELD";
      throw error;
    }
    leaseHeld = true;
    return {
      attach() { attached += 1; },
      async shutdown() {
        await new Promise((resolve) => setTimeout(resolve, 50));
        leaseHeld = false;
        released += 1;
      },
    };
  };
  const firstServer = { httpServer: new EventEmitter(), middlewares: { use() {} } };
  const secondServer = { httpServer: new EventEmitter(), middlewares: { use() {} } };
  const options = { configUrl: new URL("file:///fixture/config.json"), recoverArchive: async () => {}, createRuntime };
  const first = outrightApiPlugin(options);
  first.configureServer(firstServer);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attached, 1);
  const second = outrightApiPlugin(options);
  second.configureServer(secondServer);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attached, 1, "replacement bypassed the old runtime lease");
  firstServer.httpServer.emit("close");
  const deadline = Date.now() + 1000;
  while (attached !== 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(released, 1, "server close did not release the old runtime");
  assert.equal(attached, 2, "replacement did not recover after the old lease closed");
  await Promise.all([first.closeBundle(), second.closeBundle()]);
  assert.equal(released, 2, "plugin disposal did not close each runtime once");
});

test("a Vite config restart keeps terminals for the successor runtime; a close with no successor quits", async () => {
  const intents = [];
  const createRuntime = () => ({ attach() {}, async shutdown(options) { intents.push(options?.restart === true ? "restart" : "quit"); } });
  const options = { configUrl: new URL(`file:///fixture/${randomUUID()}.json`), recoverArchive: async () => {}, createRuntime };
  const firstServer = { httpServer: new EventEmitter(), middlewares: { use() {} } };
  const secondServer = { httpServer: new EventEmitter(), middlewares: { use() {} } };
  const first = outrightApiPlugin(options);
  first.configureServer(firstServer);
  await new Promise((resolve) => setImmediate(resolve));
  // Vite configures the replacement before it closes the old server.
  const second = outrightApiPlugin(options);
  second.configureServer(secondServer);
  firstServer.httpServer.emit("close");
  await first.closeBundle();
  assert.deepEqual(intents, ["restart"]);
  await new Promise((resolve) => setImmediate(resolve));
  await second.closeBundle();
  assert.deepEqual(intents, ["restart", "quit"]);
});

// The real runtime registers its own HTTP close listener, which asks for a
// shutdown without an intent and can run before or after the plugin's.
test("a Vite restart keeps a live terminal whichever close event reaches the real runtime first; a close without a successor ends it", { timeout: 60_000 }, async () => {
  for (const successor of [true, false]) for (const closeFirst of [true, false]) {
    const name = `${successor ? "restart" : "quit"}, ${closeFirst ? "HTTP close first" : "closeBundle first"}`;
    const directory = mkdtempSync(join(tmpdir(), "outright-vite-intent-"));
    const calls = [];
    const adapter = { pid: 4242, sessionIdentity: randomUUID(), handedBack: false, onData() {}, onExit() {},
      write: () => true, resize: () => true,
      async terminate() { calls.push("terminate"); },
      async release() { calls.push("release"); adapter.handedBack = true; return []; } };
    let runtime;
    const options = { configUrl: new URL(`file:///fixture/${randomUUID()}.json`), recoverArchive: async () => {},
      createRuntime: (runtimeOptions) => (runtime = createOutrightRuntime({ ...runtimeOptions,
        databaseFactory: (databaseOptions) => createOutrightDatabase({ ...databaseOptions, filename: join(directory, "runtime.db") }),
        terminalManagerFactory: (managerOptions) => createTerminalManager({ ...managerOptions,
          startManagedTerminal: async () => adapter, cleanupSocket: () => {} }) })) };
    const server = { httpServer: new EventEmitter(), middlewares: { use() {} } };
    const plugin = outrightApiPlugin(options);
    try {
      plugin.configureServer(server);
      for (let turn = 0; !runtime && turn < 100; turn += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      await runtime.database.waitForTerminalAuditReconciliation();
      await runtime.terminals.create({ cwd: directory });
      // Vite configures the replacement before it closes the old server.
      if (successor) outrightApiPlugin({ ...options, createRuntime: () => ({ attach() {}, async shutdown() {} }) })
        .configureServer({ httpServer: new EventEmitter(), middlewares: { use() {} } });
      if (closeFirst) server.httpServer.emit("close");
      const closing = plugin.closeBundle();
      if (!closeFirst) server.httpServer.emit("close");
      await closing;
      await runtime.whenShutdownComplete();
      assert.deepEqual(calls, [successor ? "release" : "terminate"], name);
    } finally {
      await runtime?.shutdown().catch(() => {});
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

// Vite leaves SIGINT to Node, which would exit without any shutdown.
test("Ctrl-C on the Vite dev server is an explicit quit that shuts the runtime down before exiting", { timeout: 30_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "outright-vite-interrupt-"));
  const source = `import { createServer } from ${JSON.stringify(import.meta.resolve("vite"))};
import { outrightApiPlugin } from ${JSON.stringify(new URL("./outright-vite-plugin.mjs", import.meta.url).href)};
const server = await createServer({ configFile: false, root: ${JSON.stringify(directory)}, logLevel: "silent",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [outrightApiPlugin({ configUrl: new URL("file:///fixture/${randomUUID()}.json"), recoverArchive: async () => {},
    createRuntime: () => ({ attach() {}, async shutdown(options) {
      process.stdout.write("shutdown:" + (options?.restart === false ? "quit" : "other") + "\\n");
    } }) })] });
await server.listen();
// Windows cannot deliver SIGINT to another process; the launcher asks.
process.on("message", () => process.emit("SIGINT"));
process.stdout.write("ready\\n");
`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source],
    { cwd: directory, stdio: ["pipe", "pipe", "pipe", "ipc"], env: { ...process.env, CI: "true", OUTRIGHT_DATA_DIR: join(directory, "data") } });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  try {
    for (let turn = 0; !stdout.includes("ready") && turn < 400; turn += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.match(stdout, /ready/, stderr);
    if (process.platform === "win32") child.send("interrupt");
    else child.kill("SIGINT");
    assert.deepEqual(await exited, { code: 130, signal: null }, stderr);
    assert.match(stdout, /shutdown:quit/);
  } finally {
    child.kill("SIGKILL");
    rmSync(directory, { recursive: true, force: true });
  }
});

// A quit during a Vite restart reaches the old runtime while it is still
// handing its shells to the new one, and the new one quits too.
test("Ctrl-C or SIGTERM during a Vite restart quits the old runtime still shutting down and exits only after it stops", { timeout: 60_000 }, async () => {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const directory = mkdtempSync(join(tmpdir(), "outright-vite-restart-quit-"));
    writeFileSync(join(directory, "vite.config.mjs"), `import { defineConfig } from ${JSON.stringify(import.meta.resolve("vite"))};
import { outrightApiPlugin } from ${JSON.stringify(new URL("./outright-vite-plugin.mjs", import.meta.url).href)};
export default defineConfig({ plugins: [outrightApiPlugin({ configUrl: new URL("file:///fixture/restart-quit.json"),
  recoverArchive: async () => {}, createRuntime: globalThis.restartQuitFixture })] });
`);
    const source = `import { createServer } from ${JSON.stringify(import.meta.resolve("vite"))};
const log = (line) => process.stdout.write(line + "\\n");
let leaseHeld = false;
let count = 0;
globalThis.restartQuitFixture = () => {
  if (leaseHeld) throw Object.assign(new Error("lease held"), { code: "OUTRIGHT_RUNTIME_LEASE_HELD" });
  leaseHeld = true;
  const name = "runtime" + ++count;
  let quit = false;
  let done;
  return { attach() {}, async handleRequest() { return false; },
    shutdown(options) {
      log(name + ":" + (options?.restart === false ? "quit" : options?.restart === true ? "restart" : "none"));
      if (options?.restart === false) quit = true;
      done ??= (async () => {
        // The old runtime is still handing its shells back.
        if (name === "runtime1") { log("runtime1:handing-back"); await new Promise((resolve) => setTimeout(resolve, 1500)); }
        log(name + ":stopped-as-" + (quit ? "quit" : "restart"));
        leaseHeld = false;
      })();
      return done;
    } };
};
const server = await createServer({ configFile: ${JSON.stringify(join(directory, "vite.config.mjs"))}, root: ${JSON.stringify(directory)},
  logLevel: "silent", server: { host: "127.0.0.1", port: 0 } });
await server.listen();
// Windows cannot deliver these signals to another process; the launcher asks.
process.on("message", (message) => { if (message === "restart") server.restart().catch(() => {}); else process.emit(message); });
log("ready");
`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", source],
      { cwd: directory, stdio: ["pipe", "pipe", "pipe", "ipc"], env: { ...process.env, CI: "true", OUTRIGHT_DATA_DIR: join(directory, "data") } });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const exited = new Promise((resolve) => child.once("exit", (code, exitSignal) => resolve({ code, signal: exitSignal })));
    const until = async (text) => {
      for (let turn = 0; !stdout.includes(text) && turn < 400; turn += 1) await new Promise((resolve) => setTimeout(resolve, 25));
      assert.match(stdout, new RegExp(text), `${signal}: ${stdout}${stderr}`);
    };
    try {
      await until("ready");
      child.send("restart");
      await until("runtime1:handing-back");
      if (process.platform === "win32") child.send(signal);
      else child.kill(signal);
      const { signal: killedBy } = await exited;
      assert.equal(killedBy, null, `${signal}: the process died without its shutdown`);
      // Each quit request is forwarded; the runtime joins repeats.
      const lines = [...new Set(stdout.trim().split("\n"))];
      // The quit wins over the restart already under way, the process exits
      // only after the old runtime stopped, and the new one quits as well.
      assert.deepEqual(lines.filter((line) => line.startsWith("runtime1")),
        ["runtime1:restart", "runtime1:handing-back", "runtime1:quit", "runtime1:stopped-as-quit"], `${signal}: ${stdout}${stderr}`);
      assert.deepEqual(lines.filter((line) => line.startsWith("runtime2")), ["runtime2:quit", "runtime2:stopped-as-quit"],
        `${signal}: ${stdout}${stderr}`);
    } finally {
      child.kill("SIGKILL");
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("Vite retries a transient archive worker lease conflict before opening the runtime", async () => {
  let attempts = 0;
  let attached = false;
  const plugin = outrightApiPlugin({
    configUrl: new URL("file:///fixture/config.json"),
    recoverArchive: async () => {
      if (++attempts === 1) throw Object.assign(new Error("lease busy"), { code: "SQLITE_BUSY" });
    },
    createRuntime: () => ({ attach() { attached = true; }, shutdown: async () => {} }),
  });
  plugin.configureServer({ middlewares: { use() {} } });
  const deadline = Date.now() + 1000;
  while (!attached && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(attempts, 2);
  assert.equal(attached, true);
  await plugin.closeBundle();
});

test("a rejected predecessor shutdown lets the successor recheck a released lease", async () => {
  let held = false;
  let attached = 0;
  let attempts = 0;
  let finishShutdown;
  const shutdownGate = new Promise((resolve) => { finishShutdown = resolve; });
  let middleware;
  const options = {
    configUrl: new URL("file:///fixture/rejected-shutdown.json"),
    recoverArchive: async () => {},
    createRuntime: () => {
      attempts += 1;
      if (held) {
        throw Object.assign(new Error("predecessor owns lease"), { code: "OUTRIGHT_RUNTIME_LEASE_HELD" });
      }
      held = true;
      return {
        attach() { attached += 1; },
        async handleRequest(_request, response) { response.writeHead(200); response.end("ready"); return true; },
        async shutdown() {
          if (attached === 1) await shutdownGate;
          held = false;
          if (attached === 1) throw new Error("cleanup failed after lease release");
        },
      };
    },
  };
  const first = outrightApiPlugin(options);
  const firstServer = { httpServer: new EventEmitter(), middlewares: { use() {} } };
  first.configureServer(firstServer);
  await new Promise((resolve) => setImmediate(resolve));
  const second = outrightApiPlugin(options);
  second.configureServer({ middlewares: { use(fn) { middleware = fn; } } });
  firstServer.httpServer.emit("close");
  try {
    const contentionDeadline = Date.now() + 1_000;
    while (attempts < 2 && Date.now() < contentionDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
    let status;
    middleware({ url: "/api/capacity" }, { writeHead(code) { status = code; }, end() {} }, () => assert.fail("API fell through"));
    assert.equal(status, 503, "contending successor did not stay retryable while disposal was pending");
    assert.ok(attempts >= 2, "successor never attempted the held physical lease");
    finishShutdown();
    await assert.rejects(first.closeBundle(), /cleanup failed/);
    const recoveryDeadline = Date.now() + 1_000;
    while (attached !== 2 && Date.now() < recoveryDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(attached, 2, "successor inherited predecessor's disposal error");
    middleware({ url: "/api/capacity" }, { writeHead(code) { status = code; }, end() {} }, () => assert.fail("API fell through"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(status, 200);
  } finally { finishShutdown(); await Promise.allSettled([first.closeBundle(), second.closeBundle()]); }
});

test("a slow local Vite shutdown remains retryable beyond the unknown-owner lease deadline", { timeout: 25_000 }, async () => {
  let leaseHeld = false;
  let attached = 0;
  let middleware;
  const createRuntime = () => {
    if (leaseHeld) throw Object.assign(new Error("old runtime is closing"), { code: "OUTRIGHT_RUNTIME_LEASE_HELD" });
    leaseHeld = true;
    return {
      attach() { attached += 1; },
      async handleRequest(_request, response) { response.writeHead(200); response.end("ready"); return true; },
      async shutdown() {
        await new Promise((resolve) => setTimeout(resolve, attached === 1 ? 16_000 : 0));
        leaseHeld = false;
      },
    };
  };
  const options = { configUrl: new URL("file:///fixture/slow-restart.json"), recoverArchive: async () => {}, createRuntime };
  const first = outrightApiPlugin(options);
  const firstServer = { httpServer: new EventEmitter(), middlewares: { use() {} } };
  first.configureServer(firstServer);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attached, 1);
  // Vite evaluates a fresh config module before closing the prior server.
  const { outrightApiPlugin: reloadedPlugin } = await import("./outright-vite-plugin.mjs?slow-restart");
  const second = reloadedPlugin(options);
  const secondServer = { httpServer: new EventEmitter(), middlewares: { use(fn) { middleware = fn; } } };
  second.configureServer(secondServer);
  firstServer.httpServer.emit("close");
  try {
    await new Promise((resolve) => setTimeout(resolve, 15_300));
    let status;
    middleware({ url: "/api/capacity" }, { writeHead(code) { status = code; }, end() {} }, () => assert.fail("API fell through"));
    assert.equal(status, 503, "known local shutdown became a permanent startup error");
    const deadline = Date.now() + 3_000;
    while (attached !== 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(attached, 2, "successor never acquired the released local lease");
    middleware({ url: "/api/capacity" }, { writeHead(code) { status = code; }, end() {} }, () => assert.fail("API fell through"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(status, 200);
  } finally {
    await Promise.all([first.closeBundle(), second.closeBundle()]);
  }
});

test("a real Vite config restart serves API after a 16 second predecessor shutdown", { timeout: 30_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), `out30-vite-restart-${randomUUID()}-`));
  const config = join(directory, "vite.config.mjs");
  writeFileSync(config, `import { defineConfig } from ${JSON.stringify(import.meta.resolve("vite"))};
import { outrightApiPlugin } from ${JSON.stringify(new URL("./outright-vite-plugin.mjs", import.meta.url).href)};
export default defineConfig({ plugins: [outrightApiPlugin({
  configUrl: new URL("file:///fixture/out30-restart.json"),
  recoverArchive: async () => {},
  createRuntime: globalThis.__out30ViteRestartFixture.createRuntime,
})] });\n`);
  let leaseHeld = false;
  let attached = 0;
  const intents = [];
  globalThis.__out30ViteRestartFixture = { createRuntime: () => {
    if (leaseHeld) throw Object.assign(new Error("predecessor lease held"), { code: "OUTRIGHT_RUNTIME_LEASE_HELD" });
    leaseHeld = true;
    return {
      attach() { attached += 1; },
      async handleRequest(_request, response) { response.writeHead(200); response.end("ready"); return true; },
      async shutdown(options) {
        intents.push(options?.restart === true ? "restart" : "quit");
        await new Promise((resolve) => setTimeout(resolve, attached === 1 ? 16_000 : 0));
        leaseHeld = false;
      },
    };
  } };
  let server;
  try {
    server = await createServer({ configFile: config, root: fileURLToPath(new URL("../", import.meta.url)),
      server: { host: "127.0.0.1", port: 0 }, logLevel: "silent" });
    await server.listen();
    const apiStatus = () => fetch(new URL("/api/capacity", server.resolvedUrls.local[0])).then((response) => response.status);
    assert.equal(await apiStatus(), 200);
    assert.equal(attached, 1);
    await server.restart();
    assert.equal(await apiStatus(), 200, "restart left a permanent API error after the local lease was released");
    assert.equal(attached, 2);
    // Vite's restart is a graceful restart; closing the server is a quit.
    assert.deepEqual(intents, ["restart"]);
    await server.close();
    assert.deepEqual(intents, ["restart", "quit"]);
  } finally {
    try { await server?.close(); }
    finally { rmSync(directory, { recursive: true }); delete globalThis.__out30ViteRestartFixture; }
  }
});

test("a real Vite restart waits for recovery that owned the lease before runtime creation", { timeout: 30_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), `out30-vite-recovery-${randomUUID()}-`));
  const config = join(directory, "vite.config.mjs");
  writeFileSync(config, `import { defineConfig } from ${JSON.stringify(import.meta.resolve("vite"))};
import { outrightApiPlugin } from ${JSON.stringify(new URL("./outright-vite-plugin.mjs", import.meta.url).href)};
export default defineConfig({ plugins: [outrightApiPlugin({
  configUrl: new URL("file:///fixture/out30-recovery.json"),
  recoverArchive: globalThis.__out30RecoveryFixture.recoverArchive,
  createRuntime: globalThis.__out30RecoveryFixture.createRuntime,
})] });\n`);
  let finishRecovery;
  let recoveryStarted;
  const started = new Promise((resolve) => { recoveryStarted = resolve; });
  let recoveryCalls = 0;
  const leaseFile = join(directory, "recovery-lease.db");
  let recoveryLease;
  let attached = 0;
  globalThis.__out30RecoveryFixture = {
    recoverArchive: async () => {
      if (++recoveryCalls === 1) {
        recoveryLease = new Database(leaseFile);
        recoveryLease.pragma("locking_mode = EXCLUSIVE");
        recoveryLease.exec("BEGIN EXCLUSIVE; COMMIT;");
        recoveryStarted();
        try { await new Promise((resolve) => { finishRecovery = resolve; }); }
        finally { recoveryLease.close(); recoveryLease = undefined; }
      } else {
        const contender = new Database(leaseFile);
        try {
          contender.pragma("busy_timeout = 50");
          contender.pragma("locking_mode = EXCLUSIVE");
          contender.exec("BEGIN EXCLUSIVE; COMMIT;");
        } finally { contender.close(); }
      }
    },
    createRuntime: () => ({
      attach() { attached += 1; },
      async handleRequest(_request, response) { response.writeHead(200); response.end("ready"); return true; },
      async shutdown() {},
    }),
  };
  let server;
  try {
    server = await createServer({ configFile: config, root: fileURLToPath(new URL("../", import.meta.url)),
      server: { host: "127.0.0.1", port: 0 }, logLevel: "silent" });
    await server.listen();
    await started;
    const releaseTimer = setTimeout(() => finishRecovery(), 16_200);
    const restarting = server.restart();
    const status = () => fetch(new URL("/api/capacity", server.resolvedUrls.local[0])).then((response) => response.status);
    try { await restarting; } finally { clearTimeout(releaseTimer); finishRecovery(); }
    const deadline = Date.now() + 3_000;
    let current;
    do {
      current = await status();
      if (current === 200) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
    assert.equal(current, 200, "restart did not serve API after recovery released its lease");
    assert.equal(attached, 1, "disposed predecessor created a runtime after recovery");
  } finally {
    finishRecovery?.();
    try { await server?.close(); }
    finally { recoveryLease?.close(); rmSync(directory, { recursive: true }); delete globalThis.__out30RecoveryFixture; }
  }
});
