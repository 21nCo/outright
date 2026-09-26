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
    assert.equal(changes.length, 1);
  } finally { discovery.close(); }
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
