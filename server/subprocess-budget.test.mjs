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
import { createSubprocessBudget, runOwned } from "./subprocess-budget.mjs";
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

test("a prior-format native owner uses its deterministic identity after its supervisor is gone", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-utility-prior-owner-"));
  const id = "7c538332-3e62-491e-9231-e90d34d687a7";
  const identityKey = process.platform === "darwin" ? "label"
    : process.platform === "linux" ? "handshakePath" : "jobName";
  const filename = path.join(root, `${id}.json`);
  try {
    writeFileSync(filename, JSON.stringify({ state: "unknown", platform: process.platform,
      authorized: true, pid: 2147483647, [identityKey]: "conflicting-owner" }), { mode: 0o600 });
    const budget = createSubprocessBudget({ limit: 1, unknownDirectory: root });
    assert.deepEqual(budget.capacity(), { active: 1, unknown: 1, limit: 1 });
    assert.equal(await budget.reconcileUnknown(), 0, "a conflicting recorded native identity cannot release capacity");
    writeFileSync(filename, JSON.stringify({ state: "unknown", platform: process.platform,
      authorized: true, pid: 2147483647 }), { mode: 0o600 });
    assert.equal(await budget.reconcileUnknown(), 1);
    assert.deepEqual(budget.capacity(), { active: 0, unknown: 0, limit: 1 });
  } finally { rmSync(root, { recursive: true, force: true }); }
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
