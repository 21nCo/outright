import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PassThrough } from "node:stream";
import { createSubprocessBudget, currentBootIdentity, nativeOwnerProof, runOwned } from "./subprocess-budget.mjs";
import { createGitService } from "./git-service.mjs";
import { scanProjects } from "./project-scanner.mjs";
import { AGENT_SUPERVISOR } from "./agent-manager.mjs";

function cleanupDescendant(root, pidFile) {
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, "utf8"));
    if (Number.isSafeInteger(pid) && pid > 0) try { process.kill(pid, "SIGKILL"); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  rmSync(root, { recursive: true, force: true });
}

// A child's output, including FD 3 proof frames, is complete only at 'close':
// 'exit' can fire while its pipes still hold data.
function closed(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => resolve(status));
  });
}

test("Git and scanner share admission, reject bursts before spawn, and recover after child close", async () => {
  const root = await realpath(mkdtempSync(path.join(os.tmpdir(), "outright-process-budget-")));
  const budget = createSubprocessBudget({ limit: 1 });
  execFileSync("git", ["init", root]);
  const service = createGitService({ database: {}, getProjects: () => [{ worktrees: [{ path: root }] }], getConfig: async () => ({ scanRoots: [root] }), subprocesses: budget });
  const holdFile = path.join(root, "hold");
  writeFileSync(holdFile, "hold");
  try {
    // A long child reserves the only utility slot. Both public read paths
    // must reject instead of launching another child or returning a partial scan.
    const hold = budget.run(process.execPath, ["-e", "const fs=require('node:fs'); setInterval(() => { if (!fs.existsSync(process.argv.at(-1))) process.exit(0); }, 10)", holdFile], { timeout: 10_000 });
    assert.equal(budget.capacity().active, 1);
    await assert.rejects(service.status(root), (error) => error.statusCode === 429 && error.code === "SUBPROCESS_CAPACITY");
    await assert.rejects(scanProjects({ scanRoots: [root], maxDepth: 1, maxProjects: 1, excludeDirectories: new Set() }, budget),
      (error) => error.statusCode === 429 && error.code === "SUBPROCESS_CAPACITY");
    rmSync(holdFile);
    await hold;
    assert.equal(budget.capacity().active, 0);
    const scan = await scanProjects({ scanRoots: [root], maxDepth: 1, maxProjects: 1, excludeDirectories: new Set() }, budget);
    assert.equal(scan.projects.length, 1);
  } finally { rmSync(holdFile, { force: true }); rmSync(root, { recursive: true, force: true }); }
});

test("malformed utility caps fail closed before admitting work", () => {
  for (const limit of [NaN, Infinity, -1, 0.5, "8"]) {
    assert.throws(() => createSubprocessBudget({ limit }), RangeError);
  }
  assert.equal(createSubprocessBudget({ limit: 0 }).capacity().limit, 0);
});

test("project discovery propagates an unknown native utility owner", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-scan-unknown-owner-"));
  try {
    mkdirSync(path.join(root, ".git"));
    const unavailable = Object.assign(new Error("owner proof missing"), { code: "SUBPROCESS_OWNERSHIP_UNKNOWN" });
    await assert.rejects(scanProjects({ scanRoots: [root], maxDepth: 0, maxProjects: 1, excludeDirectories: new Set() },
      { run: () => Promise.reject(unavailable) }), (error) => error === unavailable);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("explicit null encoding preserves binary stdout and stderr", async () => {
  const budget = createSubprocessBudget({ limit: 1 });
  const { stdout, stderr } = await budget.run(process.execPath, ["-e",
    "process.stdout.write(Buffer.from([0,255,10]));process.stderr.write(Buffer.from([255,0]))"],
  { encoding: null, timeout: 5000 });
  assert.deepEqual(stdout, Buffer.from([0, 255, 10]));
  assert.deepEqual(stderr, Buffer.from([255, 0]));
});

test("an in-flight utility reservation survives runtime reconstruction", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-utility-restart-"));
  let complete;
  try {
    const budget = createSubprocessBudget({ limit: 1, unknownDirectory: root,
      execute(_file, _args, _options, onClose) { complete = onClose; } });
    const command = budget.run("git", ["status"]);
    assert.equal(budget.capacity().active, 1);
    const reopened = createSubprocessBudget({ limit: 1, unknownDirectory: root });
    assert.equal(reopened.capacity().unknown, 1);
    await assert.rejects(reopened.run("git", ["status"]), (error) => error.code === "SUBPROCESS_CAPACITY");
    complete(null, "done", "", true);
    assert.deepEqual(await command, { stdout: "done", stderr: "" });
    assert.equal(createSubprocessBudget({ limit: 1, unknownDirectory: root }).capacity().unknown, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a preexisting owner update file is retained when durable ownership cannot advance", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-utility-owner-collision-"));
  let temporary;
  try {
    const budget = createSubprocessBudget({ limit: 1, unknownDirectory: root,
      execute(_file, _args, options, onClose) {
        temporary = path.join(root, `${options.__ownerId}.tmp`);
        writeFileSync(temporary, "prior crash evidence", { mode: 0o600 });
        let failure;
        try { options.__onOwnerSpawn(123, {}); } catch (error) { failure = error; }
        onClose(failure, "", "", false, {});
      } });
    await assert.rejects(budget.run("git", ["status"]), (error) => error.code === "SUBPROCESS_OWNERSHIP_UNKNOWN");
    assert.equal(readFileSync(temporary, "utf8"), "prior crash evidence");
    const reservation = JSON.parse(readFileSync(temporary.replace(/\.tmp$/, ".json"), "utf8"));
    assert.equal(reservation.authorized, false, "failed owner update must preserve the original authorization fence");
    assert.equal(reservation.runtimePid, process.pid);
    assert.equal(budget.capacity().active, 1);
    assert.equal(createSubprocessBudget({ limit: 1, unknownDirectory: root }).capacity().unknown, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("unknown completion preserves the last durable native owner identity", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-utility-owner-state-"));
  try {
    const budget = createSubprocessBudget({ limit: 1, unknownDirectory: root,
      execute(_file, _args, options, onClose) {
        options.__onOwnerSpawn(2147483647, {});
        onClose(new Error("native proof missing"), "", "", false, {});
      } });
    await assert.rejects(budget.run("git", ["status"]), (error) => error.code === "SUBPROCESS_OWNERSHIP_UNKNOWN");
    const [entry] = readdirSync(root).filter((name) => name.endsWith(".json"));
    const reservation = JSON.parse(readFileSync(path.join(root, entry), "utf8"));
    assert.equal(reservation.authorized, true);
    assert.equal(reservation.pid, 2147483647);
    assert.equal(reservation.runtimePid, process.pid);
    assert.equal(budget.capacity().active, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a late native empty-tree proof releases a timed-out caller's charged permit", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-utility-late-proof-"));
  let close;
  try {
    const budget = createSubprocessBudget({ limit: 1, unknownDirectory: root,
      execute(_file, _args, options, onClose) {
        options.__onOwnerSpawn(2147483647, {});
        close = onClose;
      } });
    const pending = budget.run("git", ["status"]);
    close(new Error("stop grace expired"), "", "", false, {});
    await assert.rejects(pending, (error) => error.code === "SUBPROCESS_OWNERSHIP_UNKNOWN");
    assert.deepEqual(budget.capacity(), { active: 1, unknown: 1, limit: 1 });
    close(null, "", "", true, {});
    assert.deepEqual(budget.capacity(), { active: 0, unknown: 0, limit: 1 });
    assert.equal(readdirSync(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stop grace settles a hung caller while late native proof still clears ownership", { timeout: 1000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-utility-stop-grace-"));
  const child = new EventEmitter();
  child.pid = 2147483647;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdio = [child.stdin, child.stdout, child.stderr, new PassThrough()];
  child.kill = () => true;
  try {
    const budget = createSubprocessBudget({ limit: 1, unknownDirectory: root,
      execute(file, args, options, onClose) {
        const owner = runOwned(file, args, { ...options, timeout: 10, __stopGraceMs: 20,
          __spawn: () => child }, onClose);
        queueMicrotask(() => child.emit("spawn"));
        return owner;
      } });
    await assert.rejects(budget.run("git", ["status"]), (error) => error.code === "SUBPROCESS_OWNERSHIP_UNKNOWN");
    assert.deepEqual(budget.capacity(), { active: 1, unknown: 1, limit: 1 });
    child.stdio[3].emit("data", Buffer.from("__OUTRIGHT_UTILITY_TREE_EMPTY_V1__\n"));
    child.emit("close", 0, null);
    assert.deepEqual(budget.capacity(), { active: 0, unknown: 0, limit: 1 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("reconciliation only debits records counted by this budget", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-utility-accounted-"));
  const unknown = () => ({ execute(_file, _args, _options, onClose) {
    onClose(new Error("owner stopped without proof"), "", "", false, {});
  }, unknownDirectory: root, limit: 2 });
  try {
    const first = createSubprocessBudget(unknown());
    await assert.rejects(first.run("git", ["status"]));
    const second = createSubprocessBudget(unknown());
    await assert.rejects(second.run("git", ["status"]));
    for (const name of readdirSync(root).filter((entry) => entry.endsWith(".json"))) {
      const filename = path.join(root, name);
      const record = JSON.parse(readFileSync(filename, "utf8"));
      writeFileSync(filename, JSON.stringify({ ...record, runtimePid: 2147483647 }));
    }
    assert.equal(await first.reconcileUnknown(), 1);
    assert.deepEqual(first.capacity(), { active: 0, unknown: 0, limit: 2 });
    assert.equal(readdirSync(root).filter((entry) => entry.endsWith(".json")).length, 1);
    assert.equal(await second.reconcileUnknown(), 1);
    assert.deepEqual(second.capacity(), { active: 1, unknown: 1, limit: 2 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an unlaunched utility reservation reconciles only after its runtime owner is gone", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-utility-unlaunched-"));
  const id = "3e759090-5c11-44d3-b923-3b57ad71f0a0";
  const identity = process.platform === "darwin" ? { label: `com.21n.outright.utility.${id}` }
    : process.platform === "linux" ? { handshakePath: path.join(os.tmpdir(), `outright-utility-${id}`, "owner.json") }
      : { jobName: `Local\\OutrightUtility-${id}` };
  try {
    writeFileSync(path.join(root, `${id}.json`), JSON.stringify({ state: "active", platform: process.platform,
      authorized: false, runtimePid: process.pid, ...identity }), { mode: 0o600 });
    const budget = createSubprocessBudget({ limit: 1, unknownDirectory: root });
    assert.equal(await budget.reconcileUnknown(), 0, "a still-live caller may authorize work");
    writeFileSync(path.join(root, `${id}.json`), JSON.stringify({ state: "active", platform: process.platform,
      authorized: false, runtimePid: 2147483647, ...identity }), { mode: 0o600 });
    assert.equal(await budget.reconcileUnknown(), 1);
    assert.deepEqual(budget.capacity(), { active: 0, unknown: 0, limit: 1 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a prior-format native owner releases only on positive evidence after its supervisor is gone", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-utility-prior-owner-"));
  const id = randomUUID();
  const identityKey = process.platform === "darwin" ? "label"
    : process.platform === "linux" ? "handshakePath" : "jobName";
  const filename = path.join(root, `${id}.json`);
  const ownerDirectory = path.join(os.tmpdir(), `outright-utility-${id}`);
  try {
    writeFileSync(filename, JSON.stringify({ state: "unknown", platform: process.platform,
      authorized: true, pid: 2147483647, [identityKey]: "conflicting-owner" }), { mode: 0o600 });
    const budget = createSubprocessBudget({ limit: 1, unknownDirectory: root });
    assert.deepEqual(budget.capacity(), { active: 1, unknown: 1, limit: 1 });
    assert.equal(await budget.reconcileUnknown(), 0, "a conflicting recorded native identity cannot release capacity");
    writeFileSync(filename, JSON.stringify({ state: "unknown", platform: process.platform,
      authorized: true, pid: 2147483647 }), { mode: 0o600 });
    if (process.platform === "darwin") {
      // launchd's coalition proof is bound to the deterministic label.
      assert.equal(await budget.reconcileUnknown(), 1);
      assert.deepEqual(budget.capacity(), { active: 0, unknown: 0, limit: 1 });
      return;
    }
    assert.equal(await budget.reconcileUnknown(), 0,
      "a missing handshake directory or job name is not evidence that the tree is empty");
    assert.deepEqual(budget.capacity(), { active: 1, unknown: 1, limit: 1 });
    if (process.platform === "linux") {
      // The supervisor removes only its handshake. The private directory it
      // leaves behind is the positive evidence for this exact owner.
      mkdirSync(ownerDirectory, { mode: 0o700 });
      assert.equal(await budget.reconcileUnknown(), 1);
      assert.deepEqual(budget.capacity(), { active: 0, unknown: 0, limit: 1 });
      assert.equal(existsSync(ownerDirectory), false, "the released owner directory was not removed");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(ownerDirectory, { recursive: true, force: true });
  }
});

function nativeStatusStub(responses) {
  const calls = [];
  return { calls, status: async (args) => {
    calls.push(args);
    const response = responses[args[0]];
    return typeof response === "function" ? response(args) : (response ?? { status: "unknown", failed: true });
  } };
}

function ownerIdentity(platform, id) {
  if (platform === "darwin") return { label: `com.21n.outright.utility.${id}` };
  if (platform === "linux") return { handshakePath: `/tmp/outright-utility-${id}/owner.json` };
  return { jobName: `Local\\OutrightUtility-${id}` };
}

// Every fixture below uses a real host directory, so it runs only where the
// Linux handshake proof applies. Contract tests that force a platform use
// POSIX literals and status stubs instead.
test("Linux utility proof binds to the recorded handshake, never the current TMPDIR", { skip: process.platform !== "linux" && "Linux handshake proof" }, async () => {
  const id = randomUUID();
  const recordedRoot = mkdtempSync(path.join(os.tmpdir(), "outright-recorded-tmp-"));
  const handshakePath = path.join(recordedRoot, `outright-utility-${id}`, "owner.json");
  const record = { state: "unknown", platform: "linux", authorized: true, pid: 2147483647 };
  const proof = (overrides, stub = nativeStatusStub({}), bootId = "boot-current") =>
    nativeOwnerProof({ ...record, ...overrides }, id, { platform: "linux", status: stub.status, bootId }).then((result) => result.empty);
  try {
    // A prior-format record from a runtime with another TMPDIR: the derived
    // current-TMPDIR candidate is absent, which proves nothing.
    assert.equal(await proof({}), false);
    // The recorded owner directory is gone too: its evidence was lost.
    assert.equal(await proof({ handshakePath }), false);
    mkdirSync(path.dirname(handshakePath), { mode: 0o700 });
    writeFileSync(handshakePath, JSON.stringify({ pid: 4242, processIdentity: "linux:boot-current:1" }), { mode: 0o600 });
    const live = nativeStatusStub({ "--terminate-owned": { status: "signaled", failed: false } });
    assert.equal(await proof({ handshakePath }, live), false, "a live handshake stays charged until its supervisor removes it");
    assert.deepEqual(live.calls, [["--terminate-owned", "4242", "linux:boot-current:1", handshakePath]]);
    const settled = nativeStatusStub({ "--terminate-owned": () => { rmSync(handshakePath); return { status: "signaled", failed: false }; } });
    assert.equal(await proof({ handshakePath }, settled), true, "the supervisor's removal under its private directory is the proof");
    assert.equal(await proof({ handshakePath }), true, "a restarted runtime with another TMPDIR still finds the recorded owner");
    assert.equal(await proof({ handshakePath: path.join(recordedRoot, "outright-utility-other", "owner.json") }), false);
    assert.equal(await proof({ handshakePath: "relative/owner.json" }), false);
    rmSync(path.dirname(handshakePath), { recursive: true });
    assert.equal(await proof({ handshakePath, bootId: "boot-current" }), false);
    assert.equal(await proof({ handshakePath, bootId: "boot-before-restart" }), true, "an earlier boot has no surviving processes");
    assert.equal(await proof({ handshakePath, bootId: "boot-before-restart" }, nativeStatusStub({}), null), false,
      "an unreadable current boot identity is not proof");
  } finally { rmSync(recordedRoot, { recursive: true, force: true }); }
});

test("an earlier recorded boot proves an owner empty before any reused PID or native evidence", async () => {
  const id = randomUUID();
  for (const platform of ["linux", "darwin", "win32"]) {
    for (const authorization of [{ authorized: true, pid: process.pid, runtimePid: process.pid }, { authorized: false, runtimePid: process.pid }]) {
      // The recorded PIDs now name this live test process, as after a reboot.
      const record = { state: "unknown", platform, ...ownerIdentity(platform, id), ...authorization,
        bootId: "boot-before-restart", recordedAt: new Date().toISOString() };
      const stub = nativeStatusStub({});
      const proof = (bootId) => nativeOwnerProof(record, id, { platform, status: stub.status, bootId });
      assert.deepEqual(await proof("boot-current"), { empty: true, reason: "earlier-boot" }, `${platform} ${authorization.authorized}`);
      assert.deepEqual(stub.calls, [], "boot evidence precedes every native probe");
      // Liveness of the recorded process is observable only on its own platform.
      if (platform === process.platform) {
        assert.equal((await proof(null)).empty, false, "an unreadable current boot identity is not proof");
        assert.deepEqual(await proof("boot-before-restart"), { empty: false,
          reason: authorization.authorized ? "owner-alive" : "runtime-alive" }, "the same boot keeps a live owner charged");
      }
    }
  }
});

test("wall-clock age and a missing boot identity never prove an owner empty", async () => {
  const id = randomUUID();
  const alive = { status: "alive", failed: false };
  for (const platform of ["linux", "darwin", "win32"]) {
    // Recorded long before any plausible boot of this host, with its direct
    // owner gone: neither age nor a dead PID says anything about its tree.
    const record = { state: "unknown", platform, authorized: true, pid: 2147483647, ...ownerIdentity(platform, id),
      recordedAt: "2000-01-01T00:00:00.000Z" };
    for (const [overrides, bootId] of [[{}, "boot-current"], [{}, null], [{ bootId: "boot-current" }, null], [{ bootId: null }, null]]) {
      const stub = nativeStatusStub({ "--probe": alive, "--utility-probe": alive, "--terminate-owned": alive });
      // A forward-stepped clock and short uptime, which an earlier age rule
      // read as a prior boot, are not inputs to the proof at all.
      const proof = await nativeOwnerProof({ ...record, ...overrides }, id, { platform, status: stub.status, bootId,
        directory: os.tmpdir(), now: Date.now() + 86_400_000, uptimeSeconds: 1 });
      const label = `${platform} ${JSON.stringify(overrides)} current=${bootId}`;
      assert.equal(proof.empty, false, label);
      // Only the platform's own tree proof decides; nothing short-circuits it.
      if (platform !== "linux") assert.notEqual(stub.calls.length, 0, `${label} skipped the native tree proof`);
    }
    if (platform !== "linux") {
      // Positive whole-tree evidence needs no boot identity.
      const empty = platform === "darwin" ? { "--probe": { status: "absent", failed: false } } : { "--utility-probe": { status: "exited", failed: false } };
      assert.deepEqual(await nativeOwnerProof(record, id, { platform, status: nativeStatusStub(empty).status, bootId: null }),
        { empty: true, reason: "proven" }, platform);
    }
  }
});

test("a record without a boot identity is bounded by the boot recovery first observed it in", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-utility-adopt-"));
  const legacy = randomUUID();
  const blocked = randomUUID();
  const write = (id, record) => writeFileSync(path.join(root, `${id}.json`), JSON.stringify({ state: "unknown", platform: process.platform,
    authorized: true, pid: 2147483647, recordedAt: "2026-10-09T10:00:00.000Z", ...ownerIdentity(process.platform, id), ...record }), { mode: 0o600 });
  const read = (id) => JSON.parse(readFileSync(path.join(root, `${id}.json`), "utf8"));
  write(legacy, {});
  write(blocked, { bootId: null });
  // The real proof order, with native evidence that never proves the tree empty.
  const budgetAt = (bootId) => createSubprocessBudget({ limit: 2, unknownDirectory: root, bootIdentity: () => bootId,
    proveOwner: (record, id, options) => nativeOwnerProof(record, id, { ...options, status: async () => ({ status: "unknown", failed: true }) }) });
  const states = (budget) => Object.fromEntries(budget.unknownOwnerStatus().map((owner) => [owner.id, [owner.reason, owner.releasable, owner.clearsAfterRestart]]));
  try {
    const unreadable = budgetAt(null);
    assert.equal(await unreadable.reconcileUnknown(), 0);
    assert.equal(read(legacy).observedBootId, undefined, "an unreadable boot identity was stamped");
    assert.deepEqual(Object.values(states(unreadable)).map((state) => state[2]), [false, false]);
    const first = budgetAt("boot-a");
    // A directory where the replacement file must go makes the stamp fail.
    mkdirSync(path.join(root, `${blocked}.tmp`));
    assert.equal(await first.reconcileUnknown(), 0);
    assert.deepEqual([read(legacy).observedBootId, read(legacy).recordedAt], ["boot-a", "2026-10-09T10:00:00.000Z"]);
    assert.equal(read(blocked).observedBootId, undefined);
    assert.equal(states(first)[legacy][2], true);
    assert.equal(states(first)[legacy][1], false);
    assert.deepEqual(states(first)[blocked], ["boot-adoption-failed", false, false]);
    assert.deepEqual(first.capacity(), { active: 2, unknown: 2, limit: 2 });
    rmSync(path.join(root, `${blocked}.tmp`), { recursive: true });
    const same = budgetAt("boot-a");
    assert.equal(await same.reconcileUnknown(), 0, "the boot an owner was observed in cannot prove it gone");
    assert.equal(read(blocked).observedBootId, "boot-a");
    const later = budgetAt("boot-b");
    assert.equal(await later.reconcileUnknown(), 2);
    assert.deepEqual(later.capacity(), { active: 0, unknown: 0, limit: 2 });
    assert.deepEqual(readdirSync(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a restart is promised exactly where the real proof in a later boot releases the owner", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-utility-restart-"));
  const foreign = process.platform === "linux" ? "darwin" : "linux";
  const shapes = {
    "owner-alive": { pid: process.pid, bootId: "boot-a" },
    "native-unproven": { bootId: "boot-a" },
    "identity-mismatch": () => ({ bootId: "boot-a", ...ownerIdentity(process.platform, randomUUID()) }),
    "record-unreadable": (id) => ({ bootId: "boot-a", platform: foreign, ...ownerIdentity(foreign, id) }),
    adopted: {},
    "adoption-failed": {},
  };
  const ids = Object.fromEntries(Object.keys(shapes).map((name) => [name, randomUUID()]));
  for (const [name, shape] of Object.entries(shapes)) {
    const id = ids[name];
    const fields = typeof shape === "function" ? shape(id) : shape;
    writeFileSync(path.join(root, `${id}.json`), JSON.stringify({ state: "unknown", platform: process.platform, authorized: true,
      pid: 2147483647, recordedAt: "2026-10-09T10:00:00.000Z", ...ownerIdentity(process.platform, id), ...fields }), { mode: 0o600 });
  }
  // The real proof order, with native evidence that never proves a tree empty.
  const budgetAt = (bootId) => createSubprocessBudget({ limit: 6, unknownDirectory: root, bootIdentity: () => bootId,
    proveOwner: (record, id, options) => nativeOwnerProof(record, id, { ...options, status: async () => ({ status: "unknown", failed: true }) }) });
  try {
    const before = budgetAt("boot-a");
    // A directory where the boot stamp's replacement file must go.
    const blocked = path.join(root, `${ids["adoption-failed"]}.tmp`);
    mkdirSync(blocked);
    assert.equal(await before.reconcileUnknown(), 0);
    const promised = new Map(before.unknownOwnerStatus().map((owner) => [owner.id, owner.clearsAfterRestart]));
    for (const id of Object.values(ids)) {
      await assert.rejects(before.releaseUnknownOwner(id, { audit: async () => {} }),
        (error) => error.statusCode === 409 && error.details.clearsAfterRestart === promised.get(id), id);
    }
    // Stamped only in the new boot, the owner is not bounded by it.
    rmSync(blocked, { recursive: true });
    const after = budgetAt("boot-b");
    await after.reconcileUnknown();
    const released = Object.fromEntries(Object.entries(ids).map(([name, id]) => [name, !existsSync(path.join(root, `${id}.json`))]));
    assert.deepEqual(Object.fromEntries(Object.entries(ids).map(([name, id]) => [name, promised.get(id)])), released);
    assert.deepEqual(released, { "owner-alive": true, "native-unproven": true, "identity-mismatch": false,
      "record-unreadable": false, adopted: true, "adoption-failed": false });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a failed boot identity read is retried, so a later reconciliation stamps the owner", { timeout: 20_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-utility-boot-retry-"));
  const preload = path.join(root, "fail-boot-reads.mjs");
  // Fails the platform's real boot identity source for the first N reads.
  writeFileSync(preload, `import cp from "node:child_process";
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    globalThis.bootReads = 0;
    const failing = Number(process.env.FAIL_BOOT_READS);
    const fail = () => { globalThis.bootReads += 1; if (globalThis.bootReads <= failing) throw Object.assign(new Error("transient"), { code: "EAGAIN" }); };
    const execFileSync = cp.execFileSync;
    cp.execFileSync = function (file, args, ...rest) {
      if (args?.includes("kern.bootsessionuuid") || args?.includes("--boot-identity")) fail();
      return execFileSync.call(this, file, args, ...rest);
    };
    const readFileSync = fs.readFileSync;
    fs.readFileSync = function (file, ...rest) {
      if (file === "/proc/sys/kernel/random/boot_id") fail();
      return readFileSync.call(this, file, ...rest);
    };
    syncBuiltinESMExports();`);
  const script = `const { createSubprocessBudget, currentBootIdentity } = await import(${JSON.stringify(new URL("./subprocess-budget.mjs", import.meta.url).href)});
    const fs = await import("node:fs");
    const path = await import("node:path");
    const [directory, id] = process.argv.slice(1);
    const reads = [currentBootIdentity(), currentBootIdentity()];
    const budget = createSubprocessBudget({ limit: 1, unknownDirectory: directory, proveOwner: async () => ({ empty: false, reason: "probe-failed" }) });
    await budget.reconcileUnknown();
    for (let call = 0; call < 6; call += 1) currentBootIdentity();
    const record = JSON.parse(fs.readFileSync(path.join(directory, id + ".json"), "utf8"));
    console.log(JSON.stringify({ reads, observed: record.observedBootId ?? null, restart: budget.unknownOwnerStatus()[0].clearsAfterRestart, bootReads: globalThis.bootReads }));`;
  const run = (failing) => {
    const directory = mkdtempSync(path.join(root, "owners-"));
    const id = randomUUID();
    writeFileSync(path.join(directory, `${id}.json`), JSON.stringify({ state: "unknown", platform: process.platform, authorized: true,
      pid: 2147483647, recordedAt: "2026-10-09T10:00:00.000Z", ...ownerIdentity(process.platform, id) }), { mode: 0o600 });
    const result = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, "--input-type=module", "-e", script, directory, id],
      { encoding: "utf8", timeout: 15_000, env: { ...process.env, FAIL_BOOT_READS: String(failing) } });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim().split("\n").at(-1));
  };
  try {
    const control = run(0);
    if (!control.reads[0]) return assert.equal(process.platform, "win32", "this platform has no readable boot identity");
    // One transient failure: the next caller reads it, and recovery stamps it.
    const transient = run(1);
    assert.deepEqual(transient.reads, [null, control.reads[0]]);
    assert.equal(transient.observed, control.reads[0]);
    assert.equal(transient.restart, true);
    assert.equal(transient.bootReads, 2, "a successful read was not kept");
    // A persistently unreadable identity is retried, then spaced out.
    const persistent = run(Number.MAX_SAFE_INTEGER);
    assert.deepEqual([persistent.reads, persistent.observed, persistent.restart], [[null, null], null, false]);
    assert.equal(persistent.bootReads, 3, "failed boot reads were retried without bound");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("restarted utility budgets release earlier-boot owners through the real platform proof", async (t) => {
  const current = currentBootIdentity();
  t.diagnostic(`boot identity: ${current}`);
  if (process.platform !== "win32") assert.match(current ?? "", /^[\w:.-]{1,128}$/, "this platform has no readable boot identity");
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-utility-boot-"));
  const write = (id, record) => writeFileSync(path.join(root, `${id}.json`), JSON.stringify({ state: "unknown",
    platform: process.platform, ...ownerIdentity(process.platform, id), recordedAt: new Date().toISOString(), ...record }), { mode: 0o600 });
  const live = randomUUID();
  try {
    if (current) {
      write(randomUUID(), { authorized: true, pid: process.pid, runtimePid: process.pid, bootId: `${current}-earlier` });
      write(randomUUID(), { authorized: false, runtimePid: process.pid, bootId: `${current}-earlier` });
    }
    write(live, { authorized: true, pid: process.pid, runtimePid: process.pid, bootId: current });
    const budget = createSubprocessBudget({ limit: 3, unknownDirectory: root });
    const charged = current ? 3 : 1;
    assert.deepEqual(budget.capacity(), { active: charged, unknown: charged, limit: 3 });
    assert.equal(await budget.reconcileUnknown(), charged - 1);
    assert.deepEqual(budget.capacity(), { active: 1, unknown: 1, limit: 3 });
    assert.deepEqual(budget.unknownOwnerStatus(), [{ id: live, reason: "owner-alive", releasable: false, clearsAfterRestart: Boolean(current) }]);
    assert.deepEqual(readdirSync(root), [`${live}.json`]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Windows utility proof requires an empty job or the supervisor's emptiness marker", async () => {
  const id = randomUUID();
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-utility-marker-"));
  const jobName = `Local\\OutrightUtility-${id}`;
  const record = { state: "unknown", platform: "win32", authorized: true, pid: 2147483647, jobName, bootId: "windows-boot:7" };
  const proof = (overrides, responses) => {
    const stub = nativeStatusStub(responses);
    return nativeOwnerProof({ ...record, ...overrides }, id, { platform: "win32", status: stub.status, bootId: "windows-boot:7", directory })
      .then((result) => ({ ...result, calls: stub.calls }));
  };
  const absent = { "--utility-probe": { status: "absent", failed: false } };
  const marker = path.join(directory, `${id}.empty`);
  try {
    assert.equal((await proof({}, { "--utility-probe": { status: "exited", failed: false } })).empty, true, "an opened job with zero active processes");
    assert.equal((await proof({}, { "--utility-probe": { status: "unknown", failed: true } })).reason, "probe-failed");
    const alive = await proof({}, { "--utility-probe": { status: "alive", failed: false }, "--utility-terminate": { status: "unknown", failed: true } });
    assert.equal(alive.reason, "job-alive");
    assert.deepEqual(alive.calls.map((call) => call[0]), ["--utility-probe", "--utility-terminate", "--utility-probe"]);
    // A vanished job name, even with every directly recorded process gone,
    // can still hide an unrecorded grandchild that is tearing down.
    const vanished = await proof({ members: [{ pid: 4100, birth: "1" }, { pid: 4101, birth: "2" }] }, absent);
    assert.deepEqual([vanished.empty, vanished.reason], [false, "job-absent-without-marker"]);
    assert.equal(vanished.calls.some((call) => call[0] === "--probe"), false, "member identities are not whole-tree proof");
    writeFileSync(marker, `__OUTRIGHT_UTILITY_TREE_EMPTY_V1__ Local\\OutrightUtility-other windows-boot:7\n`);
    assert.equal((await proof({}, absent)).empty, false, "a marker for another job is not proof");
    writeFileSync(marker, `__OUTRIGHT_UTILITY_TREE_EMPTY_V1__ ${jobName} windows-boot:6\n`);
    assert.equal((await proof({}, absent)).empty, false, "a marker from another boot is not proof");
    writeFileSync(marker, `__OUTRIGHT_UTILITY_TREE_EMPTY_V1__ ${jobName} windows-boot:7\n`);
    assert.deepEqual((await proof({}, absent)).empty, true, "the supervisor's identity-bound marker after zero members");
    assert.equal((await proof({ jobName: "Local\\OutrightUtility-other" }, absent)).reason, "identity-mismatch");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("reconciliation, operator re-check and the reported flag share one release predicate", async () => {
  const live = ["owner-alive", "runtime-alive", "job-alive", "service-retained", "handshake-retained"];
  const missing = ["handshake-invalid", "handshake-unreadable", "probe-failed", "owner-directory-missing",
    "job-absent-without-marker", "identity-mismatch", "record-unreadable"];
  // A prover's claim of emptiness without whole-tree evidence is no release either.
  const verdicts = [...live, ...missing].map((reason) => ({ empty: false, reason }))
    .concat([{ empty: true, reason: "predates-boot" }, { empty: true, reason: "owner-alive" }]);
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-utility-predicate-"));
  const ids = verdicts.map(() => randomUUID());
  const verdictFor = new Map(ids.map((id, index) => [id, verdicts[index]]));
  for (const id of ids) {
    writeFileSync(path.join(root, `${id}.json`), JSON.stringify({ state: "unknown", platform: process.platform, authorized: true,
      pid: 2147483647, recordedAt: "2026-10-09T10:00:00.000Z", bootId: "boot-a", ...ownerIdentity(process.platform, id) }), { mode: 0o600 });
  }
  writeFileSync(path.join(root, `${randomUUID()}.empty`), "stale marker");
  const audits = [];
  const audit = async (outcome) => audits.push(outcome);
  const count = ids.length;
  try {
    const budget = createSubprocessBudget({ limit: count, unknownDirectory: root, bootIdentity: () => "boot-a",
      proveOwner: async (_record, id) => verdictFor.get(id) });
    assert.equal(readdirSync(root).filter((name) => name.endsWith(".empty")).length, 0, "a stale marker without its owner record was not swept");
    assert.ok(budget.unknownOwnerStatus().every((owner) => owner.reason === "awaiting-reconciliation" && owner.releasable));
    assert.equal(await budget.reconcileUnknown(), 0);
    for (const owner of budget.unknownOwnerStatus()) {
      const { reason } = verdictFor.get(owner.id);
      // A later boot never reaches a record its proof rejects before comparing boots.
      const restart = !["identity-mismatch", "record-unreadable"].includes(reason);
      assert.deepEqual(owner, { id: owner.id, reason, releasable: false, clearsAfterRestart: restart });
      const code = live.includes(reason) ? "UTILITY_OWNER_ALIVE" : "UTILITY_OWNER_UNPROVEN";
      await assert.rejects(budget.releaseUnknownOwner(owner.id, { audit }), (error) => error.statusCode === 409
        && error.details.code === code && error.details.reason === reason && error.details.clearsAfterRestart === restart, reason);
    }
    assert.deepEqual(audits, []);
    assert.deepEqual(budget.capacity(), { active: count, unknown: count, limit: count });
    assert.equal(readdirSync(root).length, count, "an unproven owner lost its durable record");
    // Positive evidence releases through either path, and only after its audit.
    verdictFor.set(ids[0], { empty: true, reason: "proven" });
    verdictFor.set(ids[1], { empty: true, reason: "earlier-boot" });
    await assert.rejects(budget.releaseUnknownOwner(ids[0], { audit: async () => { throw new Error("audit refused"); } }), /audit refused/);
    assert.deepEqual(budget.capacity(), { active: count, unknown: count, limit: count }, "a refused audit keeps the reservation");
    const released = await budget.releaseUnknownOwner(ids[0], { audit });
    assert.deepEqual(released, { id: ids[0], proven: true, reason: "proven", platform: process.platform, recordedAt: "2026-10-09T10:00:00.000Z" });
    assert.deepEqual(audits, [released]);
    assert.equal(await budget.reconcileUnknown(), 1);
    assert.deepEqual(budget.capacity(), { active: count - 2, unknown: count - 2, limit: count });
    assert.deepEqual(new Set([ids[0], ids[1]].filter((id) => existsSync(path.join(root, `${id}.json`)))), new Set());
    await assert.rejects(budget.releaseUnknownOwner(ids[0], { audit }), (error) => error.statusCode === 404);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an operator re-check is refused while a reconciliation proves the same owner", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-utility-busy-"));
  const id = randomUUID();
  writeFileSync(path.join(root, `${id}.json`), JSON.stringify({ state: "unknown", platform: process.platform, authorized: true,
    pid: 2147483647, bootId: "boot-a", ...ownerIdentity(process.platform, id) }), { mode: 0o600 });
  let finishProof;
  const proofs = [];
  try {
    const budget = createSubprocessBudget({ limit: 1, unknownDirectory: root, bootIdentity: () => "boot-a",
      proveOwner: () => new Promise((resolve) => { proofs.push(id); finishProof = resolve; }) });
    const reconciling = budget.reconcileUnknown();
    assert.deepEqual(proofs, [id], "reconciliation did not start its proof");
    assert.deepEqual(budget.unknownOwnerStatus().map((owner) => owner.releasable), [false]);
    await assert.rejects(budget.releaseUnknownOwner(id, { audit: async () => {} }),
      (error) => error.statusCode === 409 && error.details.code === "UTILITY_OWNER_BUSY");
    finishProof({ empty: true, reason: "proven" });
    assert.equal(await reconciling, 1);
    assert.deepEqual(proofs, [id], "a refused re-check ran a second concurrent proof");
    assert.deepEqual(budget.capacity(), { active: 0, unknown: 0, limit: 1 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a Windows utility owner writes its emptiness marker only after its job is empty", { skip: process.platform !== "win32", timeout: 20_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-utility-win-marker-"));
  const pidFile = path.join(root, "grandchild.pid");
  const unknownDirectory = path.join(root, "unknown");
  let observed = null;
  const budget = createSubprocessBudget({ limit: 1, unknownDirectory,
    execute(file, args, options, onClose) {
      return runOwned(file, args, options, (...result) => {
        // Observe the durable evidence before the budget releases it.
        const marker = path.join(unknownDirectory, `${options.__ownerId}.empty`);
        let grandchildAlive = true;
        try { process.kill(Number(readFileSync(pidFile, "utf8")), 0); }
        catch (error) { if (error.code !== "ESRCH") throw error; grandchildAlive = false; }
        observed = { proven: result[3], marker: existsSync(marker) ? readFileSync(marker, "utf8") : null,
          record: JSON.parse(readFileSync(path.join(unknownDirectory, `${options.__ownerId}.json`), "utf8")), grandchildAlive };
        onClose(...result);
      });
    } });
  const script = `const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    require('node:fs').writeFileSync(process.argv[1], String(child.pid)); child.unref();`;
  try {
    await budget.run(process.execPath, ["-e", script, pidFile], { timeout: 15_000 });
    assert.equal(observed?.proven, true);
    assert.equal(observed.grandchildAlive, false, "the marker was written while a grandchild was alive");
    assert.ok(observed.marker?.startsWith(`__OUTRIGHT_UTILITY_TREE_EMPTY_V1__ ${observed.record.jobName} `), observed.marker);
    if (observed.record.bootId) assert.ok(observed.marker.endsWith(` ${observed.record.bootId}\n`), observed.marker);
    assert.equal(observed.record.members, undefined);
    assert.deepEqual(budget.capacity(), { active: 0, unknown: 0, limit: 1 });
    assert.deepEqual(readdirSync(unknownDirectory), [], "the released owner left its record or marker behind");
  } finally { cleanupDescendant(root, pidFile); }
});

test("a Windows supervisor that finds its job name already in use writes no marker or frame", { skip: process.platform !== "win32", timeout: 20_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-utility-win-existing-"));
  const unknownDirectory = path.join(root, "unknown");
  let jobName;
  let marker;
  let squatter;
  const probe = () => spawnSync(AGENT_SUPERVISOR, ["--utility-probe", jobName], { encoding: "utf8", timeout: 5000 }).stdout.trim();
  const budget = createSubprocessBudget({ limit: 1, unknownDirectory,
    execute(file, args, options, onClose) {
      jobName = `Local\\OutrightUtility-${options.__ownerId}`;
      marker = options.__emptyMarker;
      // Another owner already holds this job name with a live member.
      squatter = spawn(AGENT_SUPERVISOR, ["--utility-owner", jobName, "-", process.execPath, "-e", "setInterval(() => {}, 1000)"],
        { env: { ...process.env, OUTRIGHT_UTILITY_OWNER: "1" }, stdio: ["pipe", "ignore", "ignore", "pipe"], windowsHide: true });
      squatter.stdin.write("go\n");
      const deadline = Date.now() + 10_000;
      const launchWhenOccupied = () => {
        if (probe() === "alive") runOwned(file, args, options, onClose);
        else if (Date.now() > deadline) onClose(new Error("the existing job did not start"), "", "", false, {});
        else setTimeout(launchWhenOccupied, 25);
      };
      launchWhenOccupied();
    } });
  try {
    await assert.rejects(budget.run(process.execPath, ["-e", "process.exit(0)"], { timeout: 10_000 }),
      (error) => error.code === "SUBPROCESS_OWNERSHIP_UNKNOWN" && error.cause?.code === 69);
    assert.equal(existsSync(marker), false, "an emptiness marker was written for a job this supervisor did not create");
    assert.deepEqual(budget.capacity(), { active: 1, unknown: 1, limit: 1 }, "an existing job's frame released capacity");
    assert.equal(probe(), "alive", "the existing job's member did not survive");
  } finally {
    if (squatter && squatter.exitCode === null) {
      const closed = new Promise((resolve) => squatter.once("close", resolve));
      squatter.stdin.end("stop\n");
      await closed;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Windows supervisor that cannot create its job launches nothing and proves its tree empty", { skip: process.platform !== "win32", timeout: 30_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-utility-win-nojob-"));
  const unknownDirectory = path.join(root, "unknown");
  const launched = path.join(root, "launched");
  let squatter;
  let observed = null;
  const budget = createSubprocessBudget({ limit: 1, unknownDirectory,
    execute(file, args, options, onClose) {
      const jobName = `Local\\OutrightUtility-${options.__ownerId}`;
      // A named event already holds the job's name, so CreateJobObjectW fails.
      squatter = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `$held = [System.Threading.EventWaitHandle]::new($false, [System.Threading.EventResetMode]::ManualReset, '${jobName}'); [Console]::Out.WriteLine('held'); [void][Console]::In.ReadLine()`],
      { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
      squatter.once("error", (error) => onClose(error, "", "", false, {}));
      squatter.stdout.once("data", () => runOwned(file, args, options, (...result) => {
        // Observe the durable evidence before the budget releases it.
        const marker = path.join(unknownDirectory, `${options.__ownerId}.empty`);
        observed = { proven: result[3], marker: existsSync(marker) ? readFileSync(marker, "utf8") : null, jobName };
        onClose(...result);
      }));
    } });
  try {
    await assert.rejects(budget.run(process.execPath, ["-e", `require('node:fs').writeFileSync(${JSON.stringify(launched)}, '1')`], { timeout: 20_000 }),
      (error) => error.code === 70);
    assert.equal(existsSync(launched), false, "the command ran without a job");
    assert.equal(observed?.proven, true);
    assert.ok(observed.marker?.startsWith(`__OUTRIGHT_UTILITY_TREE_EMPTY_V1__ ${observed.jobName} `), observed.marker);
    assert.deepEqual(budget.capacity(), { active: 0, unknown: 0, limit: 1 }, "a supervisor that launched nothing kept its permit");
    assert.deepEqual(readdirSync(unknownDirectory), []);
  } finally {
    if (squatter && squatter.exitCode === null) {
      const closed = new Promise((resolve) => squatter.once("close", resolve));
      squatter.stdin.end("\n");
      await closed;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("a crashed macOS owner settles after launchd drops its service and coalition", { skip: process.platform !== "darwin", timeout: 20_000 }, async () => {
  // Real launchd boundary: the supervisor dies after recording its coalition,
  // then launchd removes the job. The reaped coalition is the empty proof.
  const label = `com.21n.outright.utility.${randomUUID()}`;
  const temporaryRoot = realpathSync(execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).trim());
  const invocation = path.join(temporaryRoot, `outright-env-${label}`);
  const owner = spawn(AGENT_SUPERVISOR, [label, "/bin/sleep", "30"], { stdio: "ignore" });
  try {
    const deadline = Date.now() + 10_000;
    while (!existsSync(path.join(invocation, "coalition")) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(existsSync(path.join(invocation, "coalition")), "the owner did not record its coalition");
    owner.kill("SIGKILL");
    spawnSync("/bin/launchctl", ["bootout", `gui/${process.getuid()}/${label}`], { stdio: "ignore", timeout: 10_000 });
    const probe = spawnSync(AGENT_SUPERVISOR, ["--probe", label], { encoding: "utf8", timeout: 10_000 });
    assert.equal(probe.stdout.trim(), "absent", "a reaped coalition must not stay an unknown owner");
    assert.equal(probe.status, 3);
    assert.equal(existsSync(invocation), false, "the private launch environment outlived its proven-empty owner");
  } finally {
    owner.kill("SIGKILL");
    spawnSync(AGENT_SUPERVISOR, ["--terminate", label], { stdio: "ignore", timeout: 10_000 });
  }
});

// launchd restarts a KeepAlive job that exits after its 10 s minimum runtime.
// Every supervisor mode must report the provider's own first exit, start it
// once, and leave no job, private directory or FIFO behind.
test("macOS supervisor reports the first provider exit after launchd's minimum runtime", { skip: process.platform !== "darwin", timeout: 60_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-darwin-first-exit-"));
  const temporaryRoot = realpathSync(execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).trim());
  const provider = path.join(root, "provider.sh");
  writeFileSync(provider, "#!/bin/sh\necho start >> \"$1\"\nsleep \"$2\"\nexit \"$3\"\n", { mode: 0o700 });
  const labels = [];
  const supervise = (name, seconds, code, environment = {}, stdio = ["ignore", "ignore", "ignore"]) => {
    const label = `com.21n.outright.first-exit-${name}-${randomUUID()}`;
    labels.push(label);
    const starts = path.join(root, `${name}.starts`);
    const child = spawn(AGENT_SUPERVISOR, [label, "/bin/sh", provider, starts, String(seconds), String(code)],
      { cwd: root, stdio, env: { ...process.env, ...environment } });
    return { label, starts, child, exited: closed(child), invocation: path.join(temporaryRoot, `outright-env-${label}`) };
  };
  const startCount = (run) => existsSync(run.starts) ? readFileSync(run.starts, "utf8").split("\n").filter(Boolean).length : 0;
  try {
    const clean = supervise("clean", 12, 0);
    const failed = supervise("failed", 12, 5);
    const terminal = supervise("terminal", 12, 3, { OUTRIGHT_TERMINAL_CONTROL: "1" }, ["pipe", "ignore", "ignore"]);
    const utility = supervise("utility", 12, 4, { OUTRIGHT_UTILITY_OWNER: "1" }, ["pipe", "ignore", "ignore", "pipe"]);
    const frames = [];
    utility.child.stdio[3].on("data", (chunk) => frames.push(chunk.toString()));
    utility.child.stdin.write("go\n");
    const short = supervise("short", 1, 6);
    const deadline = Date.now() + 15_000;
    while (startCount(clean) === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(startCount(clean), 1, "the provider did not start");
    // A second start of the job's helper, as a kickstart or relaunch would
    // run it, finds the launch claimed and must not run the provider again.
    const relaunch = spawnSync(AGENT_SUPERVISOR, ["--utility-exec", clean.invocation], { encoding: "utf8", timeout: 10_000 });
    assert.equal(relaunch.status, 73);
    assert.deepEqual(await Promise.all([clean.exited, failed.exited, terminal.exited, utility.exited, short.exited]), [0, 5, 3, 4, 6],
      "a launchd relaunch replaced the provider's first exit");
    assert.deepEqual([clean, failed, terminal, utility, short].map(startCount), [1, 1, 1, 1, 1], "launchd ran a provider twice");
    assert.ok(frames.join("").includes("__OUTRIGHT_UTILITY_TREE_EMPTY_V1__\n"), "the utility owner did not prove its tree empty");
    for (const run of [clean, failed, terminal, utility, short]) {
      assert.equal(existsSync(run.invocation), false, `${run.label} kept its private launch directory`);
      assert.equal(existsSync(`/tmp/outright-agent-${run.label}-stdout.fifo`), false, `${run.label} kept its output FIFO`);
      const service = spawnSync("/bin/launchctl", ["print", `gui/${process.getuid()}/${run.label}`], { stdio: "ignore" });
      assert.notEqual(service.status, 0, `${run.label} left a launchd job behind`);
    }
  } finally {
    for (const label of labels) spawnSync(AGENT_SUPERVISOR, ["--terminate", label], { stdio: "ignore", timeout: 10_000 });
    rmSync(root, { recursive: true, force: true });
  }
});

test("macOS launch helper runs its provider once and records only the first exit", { skip: process.platform !== "darwin", timeout: 20_000 }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-darwin-helper-"));
  const invocation = path.join(root, "invocation");
  const starts = path.join(root, "starts");
  // Private launch file: NUL-terminated cwd, argument count, arguments, environment.
  const launchFile = (code) => writeFileSync(path.join(invocation, "environment"),
    [root, "3", "/bin/sh", "-c", `echo "$MARKER" >> ${JSON.stringify(starts)}; exit ${code}`, "MARKER=ran"].map((entry) => `${entry}\0`).join(""),
    { mode: 0o600 });
  try {
    mkdirSync(invocation, { mode: 0o700 });
    launchFile(7);
    const first = spawnSync(AGENT_SUPERVISOR, ["--utility-exec", invocation], { encoding: "utf8" });
    assert.equal(first.status, 7);
    assert.equal(readFileSync(path.join(invocation, "status"), "utf8"), "7\n", "the helper did not record the provider's exit");
    assert.equal(existsSync(path.join(invocation, "environment")), false, "the launch file was not claimed");
    // Consumed launch: nothing runs again.
    assert.equal(spawnSync(AGENT_SUPERVISOR, ["--utility-exec", invocation]).status, 73);
    // A recorded first exit is final even if a launch file reappears.
    launchFile(9);
    assert.equal(spawnSync(AGENT_SUPERVISOR, ["--utility-exec", invocation]).status, 73);
    assert.equal(readFileSync(path.join(invocation, "status"), "utf8"), "7\n");
    assert.equal(readFileSync(starts, "utf8"), "ran\n", "the provider ran more than once");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("macOS launch helper forwards termination only to a provider it has not reaped", { skip: process.platform !== "darwin", timeout: 30_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-darwin-helper-signal-"));
  const started = path.join(root, "started");
  const helpers = [];
  const helper = (name, script) => {
    const invocation = path.join(root, name);
    mkdirSync(invocation, { mode: 0o700 });
    writeFileSync(path.join(invocation, "environment"), [root, "3", "/bin/sh", "-c", script].map((entry) => `${entry}\0`).join(""),
      { mode: 0o600 });
    // The test hook pauses after the provider exits, before its exit is recorded.
    const child = spawn(AGENT_SUPERVISOR, ["--utility-exec", invocation], { stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, OUTRIGHT_LAUNCH_HELPER_TEST_RECORD_PAUSE_MS: "1500" } });
    helpers.push(child);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    return { child, status: closed(child), stderr: () => stderr, recorded: () => readFileSync(path.join(invocation, "status"), "utf8") };
  };
  const until = async (condition, description) => {
    const deadline = Date.now() + 10_000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  try {
    const reaped = helper("reaped", "exit 7");
    await until(() => reaped.stderr().includes("recording\n"), "the record window");
    reaped.child.kill("SIGTERM");
    assert.equal(await reaped.status, 7, "a request after the provider exited changed the helper's exit");
    assert.equal(reaped.stderr().includes("forwarded"), false, "a request was forwarded to an already reaped provider");
    assert.equal(reaped.recorded(), "7\n");
    // Control: a running provider still receives the request.
    const running = helper("running", `echo > ${JSON.stringify(started)}; exec /bin/sleep 30`);
    await until(() => existsSync(started), "the provider to start");
    running.child.kill("SIGTERM");
    assert.equal(await running.status, 143);
    assert.ok(running.stderr().includes("forwarded\n"), "a running provider did not receive the request");
    assert.equal(running.recorded(), "143\n");
  } finally {
    for (const child of helpers) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("a macOS supervisor started by a relative path runs its provider once", { skip: process.platform !== "darwin", timeout: 20_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-darwin-relative-"));
  const starts = path.join(root, "starts");
  const label = `com.21n.outright.relative-${randomUUID()}`;
  const temporaryRoot = realpathSync(execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).trim());
  // launchd starts the job from its own working directory, not the caller's.
  const cwd = path.dirname(path.dirname(path.resolve(AGENT_SUPERVISOR)));
  const relative = `./${path.relative(cwd, path.resolve(AGENT_SUPERVISOR))}`;
  try {
    const child = spawn(relative, [label, "/bin/sh", "-c", `echo ran >> ${JSON.stringify(starts)}; exit 5`], { cwd, stdio: "ignore" });
    assert.equal(await closed(child), 5, "launchd could not start the helper named by a relative path");
    assert.equal(readFileSync(starts, "utf8"), "ran\n");
    assert.equal(existsSync(path.join(temporaryRoot, `outright-env-${label}`)), false, "the private launch directory was left behind");
    const service = spawnSync("/bin/launchctl", ["print", `gui/${process.getuid()}/${label}`], { stdio: "ignore" });
    assert.notEqual(service.status, 0, "the launchd job was left behind");
  } finally {
    spawnSync(AGENT_SUPERVISOR, ["--terminate", label], { stdio: "ignore", timeout: 10_000 });
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed native owner releases capacity only after its detached child is gone", { timeout: 15_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-utility-fault-"));
  const pidFile = path.join(root, "descendant.pid");
  const unknownDirectory = path.join(root, "unknown");
  let supervisor;
  let owner;
  let releasedWhileDescendantLive = false;
  const budget = createSubprocessBudget({ limit: 1, unknownDirectory,
    execute(file, args, options, onClose) {
      supervisor = runOwned(file, args, options, (...result) => {
        if (result[3] && existsSync(pidFile)) {
          try { process.kill(Number(readFileSync(pidFile, "utf8")), 0); releasedWhileDescendantLive = true; }
          catch (error) { if (error.code !== "ESRCH") throw error; }
        }
        onClose(...result);
      });
      return supervisor;
    } });
  const script = `const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
      { detached: true, stdio: 'ignore' });
    fs.writeFileSync(process.argv[1], String(child.pid));
    child.unref(); setTimeout(() => process.exit(0), 800);`;
  try {
    const command = budget.run(process.execPath, ["-e", script, pidFile], { timeout: 8000 });
    command.catch(() => {});
    const deadline = Date.now() + 5000;
    while (!existsSync(pidFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(existsSync(pidFile), "fault fixture did not start its detached child");
    supervisor.kill("SIGKILL");
    await assert.rejects(command, (error) => {
      owner = error.owner;
      return error.code === "SUBPROCESS_OWNERSHIP_UNKNOWN" || error.signal === "SIGKILL";
    });
    const childPid = Number(readFileSync(pidFile, "utf8"));
    let childAlive = true;
    try { process.kill(childPid, 0); }
    catch (error) { if (error.code !== "ESRCH") throw error; childAlive = false; }
    assert.equal(releasedWhileDescendantLive, false, "native owner reported empty while the descendant was live");
    if (process.platform !== "darwin" || childAlive || budget.capacity().active === 1) {
      assert.equal(budget.capacity().active, 1, "unproven native tree lost its capacity reservation");
      assert.equal(budget.capacity().unknown, 1);
    } else assert.equal(budget.capacity().active, 0, "empty macOS coalition retained a permit");
    const restarted = createSubprocessBudget({ limit: 1, unknownDirectory });
    const expectedUnknown = budget.capacity().unknown;
    assert.equal(restarted.capacity().unknown, expectedUnknown);
    if (expectedUnknown) await assert.rejects(restarted.run("git", ["--version"]),
      (error) => error.code === "SUBPROCESS_CAPACITY");
    if (process.platform === "win32") {
      // Killing the supervisor closed the only job handle: the Local\ name is
      // gone while KILL_ON_JOB_CLOSE teardown runs, and no marker was written.
      assert.equal(await restarted.reconcileUnknown(), 0, "a vanished job without a marker released capacity");
      const [unproven] = restarted.unknownOwnerStatus();
      assert.deepEqual([unproven?.reason, unproven?.releasable, unproven?.clearsAfterRestart],
        ["job-absent-without-marker", false, Boolean(currentBootIdentity())]);
      // An operator cannot override missing evidence; a later boot clears it.
      const audits = [];
      await assert.rejects(restarted.releaseUnknownOwner(unproven.id, { audit: async (outcome) => audits.push(outcome) }),
        (error) => error.statusCode === 409 && error.details.code === "UTILITY_OWNER_UNPROVEN");
      assert.deepEqual(audits, []);
      assert.deepEqual(restarted.capacity(), { active: 1, unknown: 1, limit: 1 });
    }
  } finally {
    if (process.platform === "darwin" && owner?.label) {
      try { execFileSync(AGENT_SUPERVISOR, ["--terminate", owner.label], { timeout: 5000 }); }
      catch { /* A missing job is already empty; the detached PID is checked below. */ }
    }
    cleanupDescendant(root, pidFile);
  }
});

test("failed and timed-out utility children release admission", async () => {
  const budget = createSubprocessBudget({ limit: 1 });
  await assert.rejects(budget.run("missing-outright-executable", []));
  assert.equal(budget.capacity().active, 0);
  await assert.rejects(budget.run(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], { timeout: 20 }));
  assert.equal(budget.capacity().active, 0);
  await budget.run(process.execPath, ["-e", "process.exit(0)"]);
});

test("timed-out utility commands keep the permit until a detached descendant is gone", { timeout: 15_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-utility-tree-"));
  const pidFile = path.join(root, "descendant.pid");
  const budget = createSubprocessBudget({ limit: 1 });
  const script = `const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
      { detached: true, stdio: 'ignore' });
    fs.writeFileSync(process.argv[1], String(child.pid));
    child.unref(); setInterval(() => {}, 1000);`;
  try {
    await assert.rejects(budget.run(process.execPath, ["-e", script, pidFile], { timeout: 3000 }),
      (error) => error.killed === true);
    assert.equal(budget.capacity().active, 0, "native tree owner retained the capacity permit after closing");
    assert.ok(existsSync(pidFile), "descendant did not launch before the utility deadline");
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(pid > 0, "detached descendant was not launched");
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" },
      "capacity was released while a detached descendant still ran");
  } finally { cleanupDescendant(root, pidFile); }
});

test("aborting a utility command retains its permit through native descendant cleanup", { timeout: 15_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-utility-abort-"));
  const pidFile = path.join(root, "descendant.pid");
  const controller = new AbortController();
  const budget = createSubprocessBudget({ limit: 1 });
  const script = `const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
      { detached: true, stdio: 'ignore' });
    fs.writeFileSync(process.argv[1], String(child.pid));
    child.unref(); setInterval(() => {}, 1000);`;
  try {
    const command = budget.run(process.execPath, ["-e", script, pidFile], { signal: controller.signal });
    command.catch(() => {});
    const deadline = Date.now() + 5000;
    while (!existsSync(pidFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(existsSync(pidFile), "descendant was not launched before cancellation");
    controller.abort();
    await assert.rejects(command, (error) => error.name === "AbortError" && error.code === "ABORT_ERR");
    assert.equal(budget.capacity().active, 0);
    assert.throws(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0), { code: "ESRCH" },
      "permit was released while a cancelled descendant still ran");
  } finally { cleanupDescendant(root, pidFile); }
});

test("a utility leader exiting keeps its permit until the native owner reaps its detached descendant", { timeout: 15_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-utility-leader-"));
  const pidFile = path.join(root, "descendant.pid");
  const budget = createSubprocessBudget({ limit: 1 });
  const script = `const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
      { detached: true, stdio: 'ignore' });
    fs.writeFileSync(process.argv[1], String(child.pid));
    child.unref();`;
  try {
    const command = budget.run(process.execPath, ["-e", script, pidFile], { timeout: 8000 });
    command.catch(() => {});
    const deadline = Date.now() + 5000;
    while (!existsSync(pidFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(existsSync(pidFile), "leader did not launch before the ownership probe");
    const pid = Number(readFileSync(pidFile, "utf8"));
    // Native supervisors may reap the descendant immediately after the
    // leader exits, so either state is valid here: a charged permit, or a
    // released permit with no live descendant. A live unowned descendant is not.
    const descendantAlive = () => {
      try { process.kill(pid, 0); return true; }
      catch (error) { if (error.code === "ESRCH") return false; throw error; }
    };
    const released = budget.capacity().active === 0;
    assert.equal(released && descendantAlive(), false, "permit was released while the descendant remained live");
    await command;
    assert.equal(budget.capacity().active, 0);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally { cleanupDescendant(root, pidFile); }
});

test("one large worktree scan stays within its own budget and returns every changed count", async () => {
  const previousGitConfig = process.env.GIT_CONFIG_GLOBAL;
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), "outright-scan-burst-")));
  const isolatedGitConfig = path.join(directory, "empty.gitconfig");
  writeFileSync(isolatedGitConfig, "");
  process.env.GIT_CONFIG_GLOBAL = isolatedGitConfig;
  const repository = path.join(directory, "repo");
  mkdirSync(repository);
  const git = (...args) => execFileSync("git", ["-C", repository, ...args], { stdio: "ignore" });
  try {
    git("init");
    git("config", "user.name", "Outright Test");
    git("config", "user.email", "outright@example.invalid");
    writeFileSync(path.join(repository, "seed.txt"), "seed");
    git("add", "seed.txt");
    git("commit", "-m", "seed");
    for (let index = 0; index < 12; index += 1) git("worktree", "add", "-b", `branch-${index}`, path.join(directory, `wt-${index}`));
    writeFileSync(path.join(repository, "dirty.txt"), "dirty");
    for (let index = 0; index < 12; index += 1) writeFileSync(path.join(directory, `wt-${index}`, "dirty.txt"), "dirty");
    const budget = createSubprocessBudget({ limit: 8 });
    const scan = await scanProjects({ scanRoots: [repository], maxDepth: 0, maxProjects: 1, excludeDirectories: new Set() }, budget);
    assert.equal(scan.projects[0].worktrees.length, 13);
    assert.ok(scan.projects[0].worktrees.every((worktree) => worktree.changedCount === 1));
    assert.equal(budget.capacity().active, 0);
  } finally {
    if (previousGitConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previousGitConfig;
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
