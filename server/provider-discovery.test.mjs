import assert from "node:assert/strict";
import test from "node:test";
import { createProviderDiscovery } from "./provider-discovery.mjs";

test("provider reads stay responsive while an asynchronous probe is pending", async () => {
  let finish;
  let calls = 0;
  const changes = [];
  const discovery = createProviderDiscovery({
    probe: (id) => {
      calls += 1;
      if (id === "claude") return Promise.reject(new Error("not installed"));
      if (calls > 2) return Promise.resolve("codex 1.2.3");
      return new Promise((resolve) => { finish = resolve; });
    },
    onChange: (providers) => changes.push(providers),
  });
  try {
    await Promise.resolve();
    assert.equal(discovery.list().find((item) => item.id === "codex").checking, true);
    assert.equal(calls, 2);
    const available = discovery.available("codex");
    assert.equal(calls, 2, "concurrent authorization shares the in-flight probe");
    finish("codex 1.2.3");
    assert.equal(await available, true);
    assert.equal(await discovery.available("claude"), false);
    assert.equal(discovery.list().find((item) => item.id === "codex").version, "codex 1.2.3");
    assert.ok(changes.length >= 1);
  } finally { discovery.close(); }
});

test("a stale unavailable provider is probed again on the first authorization", async () => {
  let installed = false;
  let probes = 0;
  const discovery = createProviderDiscovery({ probe: async (id) => {
    if (id !== "codex") throw new Error("missing");
    probes += 1;
    if (!installed) throw new Error("missing");
    return "codex ready";
  } });
  try {
    await discovery.refresh();
    assert.equal(discovery.list()[0].available, false);
    installed = true;
    assert.equal(await discovery.available("codex"), true);
    assert.ok(probes >= 2);
    assert.equal(await discovery.available("unknown"), false);
  } finally { discovery.close(); }
});

test("authorization retries a negative probe that was already in flight before installation", async () => {
  let release;
  let calls = 0;
  const discovery = createProviderDiscovery({ probe: async (id) => {
    if (id !== "codex") throw new Error("missing");
    calls += 1;
    if (calls === 1) { await new Promise((resolve) => { release = resolve; }); throw new Error("old negative"); }
    return "installed";
  } });
  try {
    await Promise.resolve();
    const authorization = discovery.available("codex");
    release();
    assert.equal(await authorization, true);
    assert.equal(calls, 2);
  } finally { discovery.close(); }
});

test("authorization rechecks a positive snapshot after removal and recovers after reinstall", async () => {
  let state = "installed";
  const discovery = createProviderDiscovery({ probe: async (id) => {
    if (id !== "codex" || state !== "installed") throw new Error("CLI unavailable");
    return "codex ready";
  } });
  try {
    await discovery.refresh();
    assert.equal(discovery.list()[0].available, true);
    state = "removed";
    assert.equal(await discovery.available("codex"), false, "a cached positive must not authorize a removed CLI");
    state = "failed";
    assert.equal(await discovery.available("codex"), false, "probe failures deny authorization");
    state = "installed";
    assert.equal(await discovery.available("codex"), true, "the next attempt sees a reinstalled CLI");
  } finally { discovery.close(); }
});

test("a slow unrelated CLI cannot delay authorization of the requested provider", async () => {
  let releaseSibling;
  const discovery = createProviderDiscovery({ probe: (id) => id === "codex"
    ? Promise.resolve("codex ready")
    : new Promise((resolve) => { releaseSibling = resolve; }) });
  try {
    await Promise.resolve(); // Start background display discovery with both CLIs.
    const result = await Promise.race([
      discovery.available("codex"),
      new Promise((resolve) => setTimeout(() => resolve("timed out"), 100)),
    ]);
    assert.equal(result, true);
    assert.equal(discovery.list().find((entry) => entry.id === "claude").checking, true);
  } finally { releaseSibling?.("claude ready"); discovery.close(); }
});

test("provider checks are bounded after shutdown and stale cache refreshes without blocking reads", async () => {
  let calls = 0;
  const discovery = createProviderDiscovery({ probe: async () => { calls += 1; return "v1"; }, refreshMs: 1 });
  try {
    await discovery.refresh();
    const first = calls;
    await new Promise((resolve) => setTimeout(resolve, 3));
    assert.equal(await discovery.available("codex"), true);
    await discovery.refresh();
    assert.ok(calls > first);
  } finally { discovery.close(); }
  const closedCalls = calls;
  await discovery.refresh(true);
  assert.equal(calls, closedCalls);
});
