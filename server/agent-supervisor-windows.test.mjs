import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AGENT_SUPERVISOR } from "./agent-manager.mjs";
import { recoverManagedTerminal } from "./managed-terminal.mjs";
import { ATTACHED, DETACHED, MANAGED_OWNER_SOURCE, assertKeptShell, assertReattachPausesWindow, assertStopEndsDetachedProvider,
  delay, reattachCrashedTerminal, waitUntil } from "../tests/fixtures/supervisor-detach.mjs";

// Windows detach mode is this slice's; the other platforms' supervisors keep
// their own tests, so these run on Windows only.
const windowsOnly = { skip: process.platform !== "win32" };
const detach = (windowMs) => ["--detach", String(windowMs)];
const removeTree = (directory) => rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });

// The Outright owner: it launches the supervisor as managed terminals do,
// outside libuv's kill-on-close job only in detach mode, reports its pid and
// exit, and forwards a stop or closes its stdin on request. The test kills
// this owner to stand for a runtime that crashed.
const OWNER_SOURCE = `
const { spawn } = require("node:child_process");
const [supervisor, ...args] = process.argv.slice(1);
const child = spawn(supervisor, args, { stdio: ["pipe", "pipe", "ignore"], detached: args[0] === "--detach", windowsHide: true });
child.stdout.resume();
child.stdin.on("error", () => {});
console.log("pid " + child.pid);
child.on("exit", (code, signal) => console.log("exit " + code + " " + signal));
process.stdin.setEncoding("utf8");
process.stdin.on("data", (command) => {
  if (command.includes("stop")) child.stdin.write("stop\\n");
  if (command.includes("close")) child.stdin.end();
});`;

// Stands in for the broker: records its pid, and prints a broker status line,
// starts a descendant that outlives it inside the supervisor's job, or exits
// when the test drops a request file in its directory.
const PROVIDER_SOURCE = `
const { spawn } = require("node:child_process");
const { existsSync, rmSync, writeFileSync, writeSync } = require("node:fs");
const path = require("node:path");
const directory = process.argv[2];
writeFileSync(path.join(directory, "provider.pid"), String(process.pid));
const take = (name) => existsSync(path.join(directory, name)) && (rmSync(path.join(directory, name)), true);
setInterval(() => {
  if (take("escape")) {
    const escaped = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore", windowsHide: true });
    writeFileSync(path.join(directory, "escaped.pid"), String(escaped.pid));
    escaped.unref();
  }
  if (take("attach")) writeSync(1, ${JSON.stringify(`${ATTACHED}\n`)});
  if (take("detach")) writeSync(1, ${JSON.stringify(`${DETACHED}\n`)});
  if (existsSync(path.join(directory, "exit"))) process.exit(0);
}, 50);`;

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

const control = (mode, ...args) => {
  const result = spawnSync(AGENT_SUPERVISOR, [mode, ...args], { encoding: "utf8", timeout: 15_000, windowsHide: true });
  return { status: result.status, state: result.stdout.trim() };
};

const readPid = (file) => existsSync(file) ? Number(readFileSync(file, "utf8").trim()) || 0 : 0;

// One supervised provider per call, each in its own directory, all of which
// the test's cleanup ends and removes even after a failure.
function supervisors(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-windows-detach-"));
  const provider = path.join(root, "provider.cjs");
  writeFileSync(provider, PROVIDER_SOURCE);
  const runs = [];
  t.after(() => {
    for (const run of runs) {
      try { run.owner.kill(); } catch {}
      for (const pid of [run.supervisorPid, run.providerPid(), run.escapedPid()]) if (alive(pid)) try { process.kill(pid); } catch {}
    }
    removeTree(root);
  });
  return async (name, modeArgs = []) => {
    const directory = path.join(root, name);
    mkdirSync(directory);
    const owner = spawn(process.execPath, ["-e", OWNER_SOURCE, AGENT_SUPERVISOR, ...modeArgs, process.execPath, provider, directory],
      { cwd: directory, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    let lines = "";
    owner.stdout.setEncoding("utf8");
    owner.stdout.on("data", (chunk) => { lines += chunk; });
    const run = { directory, owner, supervisorPid: 0, identity: "",
      providerPid: () => readPid(path.join(directory, "provider.pid")),
      escapedPid: () => readPid(path.join(directory, "escaped.pid")),
      supervisorExit: () => lines.match(/^exit (\S+) (\S+)\r?$/m)?.slice(1) ?? null,
      request: (file) => writeFileSync(path.join(directory, file), "") };
    runs.push(run);
    await waitUntil(() => /^pid \d+\r?$/m.test(lines), () => `owner did not start its supervisor: ${lines}`);
    run.supervisorPid = Number(lines.match(/^pid (\d+)\r?$/m)[1]);
    run.identity = control("--identity", String(run.supervisorPid)).state;
    assert.match(run.identity, /^\d+$/, `${name}: the supervisor has no process identity`);
    await waitUntil(() => run.providerPid() > 0, () => `${name}: the provider did not start: ${lines}`);
    return run;
  };
}

// Recovery's own termination request, which verifies the supervisor's
// identity before it ends the process and, with it, the job's only handle.
const terminate = (run) => control("--terminate", String(run.supervisorPid), run.identity);

// Nothing of a finished job remains: provider, a descendant that left it, or
// the supervisor that held the job's only handle.
async function assertReleased(run, timeout = 10_000) {
  await waitUntil(() => !alive(run.providerPid()), `${run.directory}: the provider outlived its job`, timeout);
  await waitUntil(() => !alive(run.escapedPid()), `${run.directory}: a descendant outlived its job`, timeout);
  await waitUntil(() => !alive(run.supervisorPid), `${run.directory}: the supervisor did not exit`, timeout);
  assert.deepEqual(control("--probe", String(run.supervisorPid), run.identity), { status: 3, state: "absent" });
}

test("a detach-mode job outlives its owner until the window ends; without detach the owner's exit still ends it", { ...windowsOnly, timeout: 60_000 }, async (t) => {
  const start = supervisors(t);
  const detached = await start("window", detach(1000));
  const plain = await start("plain");
  detached.request("escape");
  await waitUntil(() => alive(detached.escapedPid()), "the provider did not start its descendant");
  const ownerGone = Date.now();
  detached.owner.kill();
  plain.owner.kill();
  await assertReleased(plain, 5000);
  await delay(Math.max(0, ownerGone + 700 - Date.now()));
  assert.equal(alive(detached.providerPid()), true, "a detach-mode job ended with its owner");
  assert.equal(alive(detached.escapedPid()), true, "a detach-mode job lost a descendant with its owner");
  assert.deepEqual(control("--probe", String(detached.supervisorPid), detached.identity), { status: 0, state: "alive" },
    "recovery could not see the detached supervisor");
  await assertReleased(detached, 10_000);
  assert.ok(Date.now() - ownerGone >= 1000, "the detached job ended before its window");
});

test("a reattached broker pauses the detach window and its next detach starts it again", { ...windowsOnly, timeout: 60_000 }, async (t) => {
  await assertReattachPausesWindow({ start: supervisors(t), detach, alive, assertReleased });
});

test("a detach-mode job ends at once on an explicit stop, and stdin EOF alone does not end it", { ...windowsOnly, timeout: 60_000 }, async (t) => {
  await assertStopEndsDetachedProvider({ start: supervisors(t), detach, alive, assertReleased, terminate });
});

test("a detached job whose reattached broker exits ends its remaining descendants at once", { ...windowsOnly, timeout: 60_000 }, async (t) => {
  const start = supervisors(t);
  const run = await start("broker-exit", detach(500));
  run.request("escape");
  await waitUntil(() => alive(run.escapedPid()), "the provider did not start its descendant");
  run.owner.kill();
  run.request("attach");
  await delay(300);
  // The broker exits while attached and never reports a detach.
  run.request("exit");
  // Well inside the 500 ms window and its grace plus slack, without recovery.
  await assertReleased(run, 2500);
});

test("recovery verifies a detached supervisor's identity and ends its job", { ...windowsOnly, timeout: 60_000 }, async (t) => {
  const start = supervisors(t);
  const run = await start("recovery", detach(60_000));
  run.request("escape");
  await waitUntil(() => alive(run.escapedPid()), "the provider did not start its descendant");
  run.owner.kill();
  await delay(300);
  // Another process birth time does not name this supervisor.
  assert.deepEqual(control("--terminate", String(run.supervisorPid), String(BigInt(run.identity) + 1n)), { status: 3, state: "absent" });
  assert.equal(alive(run.supervisorPid), true, "a mismatched identity ended the supervisor");
  assert.deepEqual(terminate(run), { status: 0, state: "exited" });
  await assertReleased(run, 5000);
});

test("a malformed detach request starts nothing", windowsOnly, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-windows-detach-malformed-"));
  const launch = (args, environment = {}) => {
    const marker = path.join(root, randomUUID());
    const result = spawnSync(AGENT_SUPERVISOR, ["--detach", ...args, process.execPath, "-e",
      'require("node:fs").writeFileSync(process.argv[1], "")', marker],
    { encoding: "utf8", timeout: 10_000, env: { ...process.env, ...environment }, input: "", windowsHide: true });
    return { status: result.status, started: existsSync(marker) };
  };
  try {
    // A well-formed request, whose owner is already gone, runs its command.
    assert.deepEqual(launch(["1000"]), { status: 0, started: true });
    for (const [args, environment] of [[["49"], {}], [["600001"], {}], [["1e3"], {}], [["-1"], {}], [["+100"], {}], [[""], {}],
      [["1000"], { OUTRIGHT_UTILITY_OWNER: "1" }]]) {
      assert.deepEqual(launch(args, environment), { status: 64, started: false }, `${args.join(" ")} was accepted`);
    }
    for (const args of [["--detach"], ["--detach", "1000"]]) {
      assert.equal(spawnSync(AGENT_SUPERVISOR, args, { stdio: "ignore", timeout: 10_000, windowsHide: true }).status, 64, `${args.join(" ")} was accepted`);
    }
  } finally { removeTree(root); }
});

// A managed terminal launched with a reattach session, whose owner the test
// kills to stand for a crashed runtime, for a later runtime to reattach
// through slice 2 or recover through its native owner.
async function crashedManagedTerminal(t, windowMs) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-windows-detach-managed-"));
  const launchDirectory = path.join(directory, "launch");
  mkdirSync(launchDirectory);
  const id = randomUUID();
  const managed = new URL("./managed-terminal.mjs", import.meta.url).href;
  const owner = spawn(process.execPath, ["--input-type=module", "-e", MANAGED_OWNER_SOURCE, managed, id, launchDirectory, directory, String(windowMs)],
    { cwd: directory, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let supervisorPid = 0;
  t.after(() => {
    try { owner.kill(); } catch {}
    if (alive(supervisorPid)) try { process.kill(supervisorPid); } catch {}
    removeTree(directory);
  });
  let lines = "";
  let stderr = "";
  owner.stdout.setEncoding("utf8");
  owner.stdout.on("data", (chunk) => { lines += chunk; });
  owner.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4096); });
  await waitUntil(() => lines.includes("\n"), () => `the managed terminal did not start: ${stderr}`, 20_000);
  const started = JSON.parse(lines.slice(0, lines.indexOf("\n")));
  supervisorPid = started.pid;
  const processIdentity = control("--identity", String(supervisorPid)).state;
  owner.kill();
  const recover = () => recoverManagedTerminal({ target: id, created: 1, ownershipLabel: `com.21n.outright.terminal.${id}`,
    launchDirectory, pid: supervisorPid, processIdentity });
  return { ...started, id, processIdentity, recover };
}

test("a crashed runtime's terminal survives in its job and a reattached runtime keeps it past the window", { ...windowsOnly, timeout: 90_000 }, async (t) => {
  const { id, identity, token, pid: supervisorPid, processIdentity, recover } = await crashedManagedTerminal(t, 3000);
  const adapter = await reattachCrashedTerminal({ id, identity, token, verifyEmpty: recover });
  // Well past both the broker's window and the supervisor's: still live.
  await delay(7000);
  await assertKeptShell(adapter);
  assert.equal(alive(supervisorPid), true, "the crashed owner's supervisor left the reattached terminal");
  // Handing the shell back starts a new window, after which nothing remains.
  await adapter.release();
  await waitUntil(() => !alive(supervisorPid), "a released shell outlived its window", 20_000);
  assert.deepEqual(control("--probe", String(supervisorPid), processIdentity), { status: 3, state: "absent" });
});

test("recovery verifies and ends a crashed runtime's detached terminal and its shell", { ...windowsOnly, timeout: 60_000 }, async (t) => {
  const { id, identity, token, pid: supervisorPid, recover } = await crashedManagedTerminal(t, 60_000);
  const adapter = await reattachCrashedTerminal({ id, identity, token, verifyEmpty: recover });
  let output = "";
  adapter.onData((data) => { output += data; });
  adapter.write("console.log('SHELL=' + process.pid)\r");
  await waitUntil(() => /SHELL=(\d+)/.test(output), () => `the shell did not report its pid: ${JSON.stringify(output.slice(-400))}`);
  const shellPid = Number(output.match(/SHELL=(\d+)/)[1]);
  await adapter.release();
  assert.equal(alive(shellPid), true, "a released shell ended before its window");
  assert.equal(await recover(), true, "recovery could not verify the detached terminal ended");
  await waitUntil(() => !alive(shellPid), "recovery left the detached terminal's shell behind", 5000);
  assert.equal(alive(supervisorPid), false, "recovery left the detached terminal's supervisor behind");
});
