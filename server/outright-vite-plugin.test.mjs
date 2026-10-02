import assert from "node:assert/strict";
import test from "node:test";
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
  const plugin = outrightApiPlugin({
    configUrl: new URL("file:///fixture/config.json"),
    recoverArchive: () => new Promise((resolve) => { finishRecovery = resolve; }),
    createRuntime: () => ({
      attach() {},
      handleRequest: async () => { requests += 1; return true; },
      shutdown: async () => {},
    }),
  });
  plugin.configureServer({ middlewares: { use(fn) { middleware = fn; } } });
  await Promise.resolve();
  let status;
  let body;
  const response = { writeHead(code) { status = code; }, end(value) { body = JSON.parse(value); } };
  middleware({ url: "/api/capacity" }, response, () => assert.fail("API request fell through"));
  assert.equal(status, 503);
  assert.match(body.error, /recovery is in progress/);
  finishRecovery();
  await new Promise((resolve) => setImmediate(resolve));
  middleware({ url: "/api/capacity" }, response, () => assert.fail("API request fell through"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests, 1);
  await plugin.closeBundle();
});
