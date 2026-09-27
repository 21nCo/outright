import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createProviderDiscovery, defaultProbe } from "./provider-discovery.mjs";

test("aborting a version check reaps a CLI that ignores SIGTERM", { skip: process.platform === "win32" }, async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-probe-"));
  const executable = path.join(directory, "stubborn-probe");
  const pidFile = path.join(directory, "pid");
  writeFileSync(executable, `#!${process.execPath}\nprocess.on("SIGTERM", () => {}); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);\n`);
  chmodSync(executable, 0o755);
  const controller = new AbortController();
  let pid;
  try {
    const pending = defaultProbe(executable, { signal: controller.signal });
    const deadline = Date.now() + 2_000;
    while (!existsSync(pidFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(existsSync(pidFile), "the CLI reached its SIGTERM handler");
    pid = Number(readFileSync(pidFile, "utf8"));
    const started = Date.now();
    controller.abort();
    await assert.rejects(pending, /aborted/);
    assert.ok(Date.now() - started < 1_500, "abort completed within its cleanup bound");
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "the version-check child is reaped");
  } finally {
    controller.abort();
    if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("abort and timeout reap a pipe-holding CLI descendant", { skip: process.platform === "win32" }, async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-probe-tree-"));
  const executable = path.join(directory, "tree-probe");
  const pidFile = path.join(directory, "descendant-pid");
  const childSource = `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
  writeFileSync(executable, `#!${process.execPath}\nconst { spawn } = require("node:child_process"); spawn(process.execPath, ["-e", ${JSON.stringify(childSource)}], { stdio: "inherit" }); setInterval(() => {}, 1000);\n`);
  chmodSync(executable, 0o755);
  try {
    for (const mode of ["abort", "timeout"]) {
      const controller = new AbortController();
      let descendantPid;
      try {
        const pending = defaultProbe(executable, { signal: controller.signal });
        const readyUntil = Date.now() + 2_000;
        while (!existsSync(pidFile) && Date.now() < readyUntil) await new Promise((resolve) => setTimeout(resolve, 10));
        assert.ok(existsSync(pidFile), "the descendant inherited the probe pipes");
        descendantPid = Number(readFileSync(pidFile, "utf8"));
        const started = Date.now();
        if (mode === "abort") controller.abort();
        await assert.rejects(pending, mode === "abort" ? /aborted|did not close/ : /timed out|did not close/);
        assert.ok(Date.now() - started < 4_000, `${mode} remains bounded`);
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.throws(() => process.kill(descendantPid, 0), { code: "ESRCH" }, `the whole probe tree must be gone after ${mode}`);
      } finally {
        controller.abort();
        if (descendantPid) try { process.kill(descendantPid, "SIGKILL"); } catch { /* Already gone. */ }
        rmSync(pidFile, { force: true });
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("shutdown aborts and reaps a running version-check child", async () => {
  let childPid;
  const discovery = createProviderDiscovery({ probe: (id, { signal }) => {
    if (id !== "codex") throw new Error("not installed");
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { signal, stdio: "ignore" });
      childPid = child.pid;
      let error;
      child.once("error", (reason) => { error = reason; });
      child.once("close", () => error ? reject(error) : resolve("version"));
    });
  } });
  try {
    await Promise.resolve();
    assert.ok(childPid > 0);
  } finally { await discovery.close(); }
  assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" }, "shutdown resolved while the probe process still existed");
});

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
    assert.equal(calls, 2, "a successful in-flight probe must authorize without a second serial probe");
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

test("the periodic display tick observes install and removal after a slow initial probe", async () => {
  let tick;
  let cancelled = false;
  let releaseInitial;
  let installed = false;
  const calls = [];
  const discovery = createProviderDiscovery({
    refreshMs: 30_000,
    schedule(callback, delay) { assert.equal(delay, 30_000); tick = callback; return 1; },
    cancel(timer) { assert.equal(timer, 1); cancelled = true; },
    probe: async (id) => {
      calls.push(id);
      if (id !== "codex") throw new Error("missing");
      if (calls.filter((item) => item === id).length === 1) await new Promise((resolve) => { releaseInitial = resolve; });
      if (!installed) throw new Error("missing");
      return "codex ready";
    },
  });
  try {
    await Promise.resolve();
    tick(); // A scheduled tick while the initial probe is still running shares it.
    installed = true;
    releaseInitial();
    await discovery.refresh();
    assert.equal(discovery.list()[0].available, true);
    installed = false;
    tick();
    await discovery.refresh();
    assert.equal(discovery.list()[0].available, false, "removal must appear on the first post-probe tick");
    installed = true;
    tick();
    await discovery.refresh();
    assert.equal(discovery.list()[0].available, true, "installation must appear on the next tick");
    assert.equal(calls.filter((item) => item === "codex").length, 3);
  } finally { discovery.close(); }
  assert.equal(cancelled, true);
});
