import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import Database from "better-sqlite3";
import { outrightApiPlugin } from "./outright-vite-plugin.mjs";

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
    const socket = { writes: [], destroyed: false, write(value) { this.writes.push(value); }, destroy() { this.destroyed = true; } };
    httpServer.emit("upgrade", { url: "/" }, socket);
    assert.equal(socket.destroyed, false);
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
  let middleware;
  const options = {
    configUrl: new URL("file:///fixture/rejected-shutdown.json"),
    recoverArchive: async () => {},
    createRuntime: () => {
      if (held) throw Object.assign(new Error("predecessor owns lease"), { code: "OUTRIGHT_RUNTIME_LEASE_HELD" });
      held = true;
      return {
        attach() { attached += 1; },
        async handleRequest(_request, response) { response.writeHead(200); response.end("ready"); return true; },
        async shutdown() {
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
    await assert.rejects(first.closeBundle(), /cleanup failed/);
    const deadline = Date.now() + 1000;
    while (attached !== 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(attached, 2, "successor inherited predecessor's disposal error");
    let status;
    middleware({ url: "/api/capacity" }, { writeHead(code) { status = code; }, end() {} }, () => assert.fail("API fell through"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(status, 200);
  } finally { await second.closeBundle(); }
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
  globalThis.__out30ViteRestartFixture = { createRuntime: () => {
    if (leaseHeld) throw Object.assign(new Error("predecessor lease held"), { code: "OUTRIGHT_RUNTIME_LEASE_HELD" });
    leaseHeld = true;
    return {
      attach() { attached += 1; },
      async handleRequest(_request, response) { response.writeHead(200); response.end("ready"); return true; },
      async shutdown() {
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
