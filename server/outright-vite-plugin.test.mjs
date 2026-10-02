import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
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
