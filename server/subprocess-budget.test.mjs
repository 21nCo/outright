import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

test("a prior-format owner without a boot identity is bounded by its age before this boot", async () => {
  const id = randomUUID();
  const now = Date.parse("2026-10-09T12:00:00Z");
  const uptimeSeconds = 3600;
  for (const platform of ["linux", "darwin", "win32"]) {
    const record = { state: "unknown", platform, authorized: true, pid: 2147483647, ...ownerIdentity(platform, id),
      recordedAt: "2026-10-09T10:00:00Z" };
    const alive = { status: "alive", failed: false };
    const stub = nativeStatusStub({ "--probe": alive, "--utility-probe": alive, "--terminate-owned": alive });
    const proof = (overrides) => nativeOwnerProof({ ...record, ...overrides }, id, { platform, status: stub.status,
      bootId: "boot-current", now, uptimeSeconds, directory: os.tmpdir() });
    assert.deepEqual(await proof({}), { empty: true, reason: "predates-boot" }, platform);
    assert.deepEqual(stub.calls, []);
    assert.equal((await proof({ recordedAt: "2026-10-09T10:55:00Z" })).empty, false, "a record inside the boot margin is not proof");
    assert.equal((await proof({ recordedAt: "not a time" })).empty, false);
    assert.equal((await proof({ bootId: "boot-current", recordedAt: "2026-10-09T10:00:00Z" })).empty, false,
      "a comparable same-boot identity overrides wall-clock age");
    if (platform === process.platform) {
      assert.deepEqual(await proof({ pid: process.pid }), { empty: false, reason: "owner-alive" }, "age never releases a live owner");
    }
  }
});

test("restarted utility budgets release earlier-boot and pre-boot owners through the real platform proof", async (t) => {
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
    write(randomUUID(), { authorized: true, pid: 2147483647,
      recordedAt: new Date(Date.now() - os.uptime() * 1000 - 3_600_000).toISOString() });
    write(live, { authorized: true, pid: process.pid, runtimePid: process.pid, bootId: current });
    const budget = createSubprocessBudget({ limit: 4, unknownDirectory: root });
    const charged = current ? 4 : 2;
    assert.deepEqual(budget.capacity(), { active: charged, unknown: charged, limit: 4 });
    assert.equal(await budget.reconcileUnknown(), charged - 1);
    assert.deepEqual(budget.capacity(), { active: 1, unknown: 1, limit: 4 });
    assert.deepEqual(budget.unknownOwnerStatus(), [{ id: live, reason: "owner-alive", releasable: false }]);
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

test("an operator release bounds an unproven utility owner and is refused while its owner runs", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-utility-operator-"));
  const unproven = randomUUID();
  const running = randomUUID();
  for (const id of [unproven, running]) {
    writeFileSync(path.join(root, `${id}.json`), JSON.stringify({ state: "unknown", platform: process.platform,
      authorized: true, pid: 2147483647, recordedAt: "2026-10-09T10:00:00.000Z", ...ownerIdentity(process.platform, id) }), { mode: 0o600 });
  }
  writeFileSync(path.join(root, `${randomUUID()}.empty`), "stale marker");
  const reasons = { [unproven]: "job-absent-without-marker", [running]: "owner-alive" };
  const audits = [];
  try {
    const budget = createSubprocessBudget({ limit: 2, unknownDirectory: root,
      proveOwner: async (_record, id) => ({ empty: false, reason: reasons[id] }) });
    assert.equal(readdirSync(root).filter((name) => name.endsWith(".empty")).length, 0, "a stale marker without its owner record was not swept");
    assert.deepEqual(budget.capacity(), { active: 2, unknown: 2, limit: 2 });
    assert.equal(await budget.reconcileUnknown(), 0);
    assert.deepEqual(new Set(budget.unknownOwnerStatus().map((owner) => `${owner.reason}:${owner.releasable}`)),
      new Set(["job-absent-without-marker:true", "owner-alive:false"]));
    await assert.rejects(budget.releaseUnknownOwner(running, { audit: async (outcome) => audits.push(outcome) }),
      (error) => error.statusCode === 409 && error.details.code === "UTILITY_OWNER_ALIVE");
    await assert.rejects(budget.releaseUnknownOwner(unproven, { audit: async () => { throw new Error("audit refused"); } }), /audit refused/);
    assert.deepEqual(budget.capacity(), { active: 2, unknown: 2, limit: 2 }, "a refused audit keeps the reservation");
    assert.deepEqual(audits, []);
    const released = await budget.releaseUnknownOwner(unproven, { audit: async (outcome) => audits.push(outcome) });
    assert.deepEqual(released, { id: unproven, proven: false, reason: "job-absent-without-marker", platform: process.platform,
      recordedAt: "2026-10-09T10:00:00.000Z" });
    assert.deepEqual(audits, [released]);
    assert.deepEqual(budget.capacity(), { active: 1, unknown: 1, limit: 2 });
    assert.equal(existsSync(path.join(root, `${unproven}.json`)), false);
    await assert.rejects(budget.releaseUnknownOwner(unproven, { audit: async () => {} }), (error) => error.statusCode === 404);
    await budget.run(process.execPath, ["-e", "process.exit(0)"], { timeout: 10_000 });
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
      assert.deepEqual([unproven?.reason, unproven?.releasable], ["job-absent-without-marker", true]);
      const audits = [];
      await restarted.releaseUnknownOwner(unproven.id, { audit: async (outcome) => audits.push(outcome) });
      assert.deepEqual(audits.map((outcome) => [outcome.proven, outcome.reason]), [[false, "job-absent-without-marker"]]);
      assert.deepEqual(restarted.capacity(), { active: 0, unknown: 0, limit: 1 });
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
