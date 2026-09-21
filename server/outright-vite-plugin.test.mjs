import assert from "node:assert/strict";
import test from "node:test";
import { outrightApiPlugin } from "./outright-vite-plugin.mjs";

test("Vite disposal awaits runtime process supervision before completing", async () => {
  let release;
  const termination = new Promise((resolve) => { release = resolve; });
  let attached;
  const plugin = outrightApiPlugin({ configUrl: new URL("file:///fixture/config.json"), createRuntime: () => ({ attach: (server) => { attached = server; }, shutdown: () => termination }) });
  const server = {};
  plugin.configureServer(server);
  assert.equal(attached, server);
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
