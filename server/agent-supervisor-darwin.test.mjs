import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AGENT_SUPERVISOR } from "./agent-manager.mjs";
import { MANAGED_OWNER_SOURCE, assertKeptShell, assertReattachPausesWindow, assertStopEndsDetachedProvider, brokerStandIn,
  delay, reattachCrashedTerminal, waitUntil } from "../tests/fixtures/supervisor-detach.mjs";

// The macOS supervisor's detach mode; Linux has its own in
// agent-supervisor-linux.test.mjs, and Windows keeps its supervisor until its
// own slice.
const darwinOnly = { skip: process.platform !== "darwin" };
const temporaryRoot = process.platform === "darwin"
  ? realpathSync(execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).trim()) : "";
const detach = (windowMs) => ["--detach", String(windowMs)];

// The Outright owner: it launches the supervisor as managed terminals do,
// reports its pid and exit, and forwards a stop or closes its stdin on
// request. The test kills this owner to stand for a runtime that crashed.
const OWNER_SOURCE = `
const { spawn } = require("node:child_process");
const [supervisor, ...args] = process.argv.slice(1);
const child = spawn(supervisor, args, { stdio: ["pipe", "pipe", "ignore"], detached: true,
  env: { ...process.env, OUTRIGHT_TERMINAL_CONTROL: "1" } });
child.stdout.resume();
child.stdin.on("error", () => {});
console.log("pid " + child.pid);
child.on("exit", (code, signal) => console.log("exit " + code + " " + signal));
process.stdin.setEncoding("utf8");
process.stdin.on("data", (command) => {
  if (command.includes("stop")) child.stdin.write("stop\\n");
  if (command.includes("close")) child.stdin.end();
});`;

// The broker stand-in's descendant escapes its session.
const PROVIDER_SOURCE = brokerStandIn(`/usr/bin/perl -e 'use POSIX qw(setsid); exit 0 if fork(); setsid(); open(my $f, ">", "$ARGV[0]") or die; print $f "$$\\n"; close $f; open(STDIN, "<", "/dev/null"); open(STDOUT, ">", "/dev/null"); open(STDERR, ">", "/dev/null"); exec("/bin/sleep", "600")' "$dir/escaped.pid"`);

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

const serviceRegistered = (label) => spawnSync("/bin/launchctl", ["print", `gui/${process.getuid()}/${label}`],
  { stdio: "ignore", timeout: 10_000 }).status === 0;

const control = (mode, label) => {
  const result = spawnSync(AGENT_SUPERVISOR, [mode, label], { encoding: "utf8", timeout: 15_000 });
  return { status: result.status, state: result.stdout.trim() };
};

// One supervised provider per call, each under a unique label and directory,
// all of which the test's cleanup ends and removes even after a failure.
function supervisors(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-darwin-detach-"));
  const provider = path.join(root, "provider.sh");
  writeFileSync(provider, PROVIDER_SOURCE, { mode: 0o700 });
  const runs = [];
  t.after(() => {
    for (const run of runs) {
      try { run.owner.kill("SIGKILL"); } catch {}
      spawnSync(AGENT_SUPERVISOR, ["--terminate", run.label], { stdio: "ignore", timeout: 15_000 });
      for (const pid of [run.supervisorPid, run.providerPid()]) if (pid && alive(pid)) try { process.kill(pid, "SIGKILL"); } catch {}
    }
    rmSync(root, { recursive: true, force: true });
  });
  return async (name, detachArgs = []) => {
    const label = `com.21n.outright.detach-${name}-${randomUUID()}`;
    const directory = path.join(root, name);
    mkdirSync(directory);
    const owner = spawn(process.execPath, ["-e", OWNER_SOURCE, AGENT_SUPERVISOR, ...detachArgs, label, "/bin/sh", provider, directory],
      { cwd: directory, stdio: ["pipe", "pipe", "ignore"] });
    let lines = "";
    owner.stdout.setEncoding("utf8");
    owner.stdout.on("data", (chunk) => { lines += chunk; });
    const pidFile = path.join(directory, "provider.pid");
    const run = { label, directory, owner, supervisorPid: 0,
      providerPid: () => existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) || 0 : 0,
      supervisorExit: () => lines.match(/^exit (\S+) (\S+)$/m)?.slice(1) ?? null,
      request: (file) => writeFileSync(path.join(directory, file), ""),
      invocation: path.join(temporaryRoot, `outright-env-${label}`) };
    runs.push(run);
    await waitUntil(() => /^pid \d+$/m.test(lines), () => `owner did not start its supervisor: ${lines}`);
    run.supervisorPid = Number(lines.match(/^pid (\d+)$/m)[1]);
    await waitUntil(() => run.providerPid() > 0, () => `${name}: the provider did not start: ${lines}`);
    return run;
  };
}

// Nothing of a finished job remains: supervisor, provider, launchd service,
// private launch directory or output FIFOs.
async function assertReleased(run, timeout = 10_000) {
  await waitUntil(() => !alive(run.providerPid()), `${run.label}: the provider outlived its job`, timeout);
  await waitUntil(() => !alive(run.supervisorPid), `${run.label}: the supervisor did not exit`, timeout);
  assert.equal(serviceRegistered(run.label), false, `${run.label} left a launchd job behind`);
  assert.equal(existsSync(run.invocation), false, `${run.label} kept its private launch directory`);
  for (const stream of ["stdout", "stderr"]) {
    assert.equal(existsSync(`/tmp/outright-agent-${run.label}-${stream}.fifo`), false, `${run.label} kept its ${stream} FIFO`);
  }
}

test("a detach-mode job outlives its owner until the window ends; without detach the owner's exit still ends it", { ...darwinOnly, timeout: 60_000 }, async (t) => {
  const start = supervisors(t);
  const detached = await start("window", ["--detach", "1000"]);
  const plain = await start("plain");
  const ownerGone = Date.now();
  detached.owner.kill("SIGKILL");
  plain.owner.kill("SIGKILL");
  await assertReleased(plain, 5000);
  await delay(Math.max(0, ownerGone + 700 - Date.now()));
  assert.equal(alive(detached.providerPid()), true, "a detach-mode job ended with its owner");
  assert.equal(alive(detached.supervisorPid), true, "the detach-mode supervisor exited with its owner");
  assert.equal(control("--probe", detached.label).state, "alive", "recovery could not see the detached job");
  await assertReleased(detached, 10_000);
  assert.ok(Date.now() - ownerGone >= 1000, "the detached job ended before its window");
});

test("a reattached broker pauses the detach window and its next detach starts it again", { ...darwinOnly, timeout: 60_000 }, async (t) => {
  await assertReattachPausesWindow({ start: supervisors(t), detach, alive, assertReleased });
});

test("a detach-mode job ends at once on an explicit stop, and stdin EOF alone does not end it", { ...darwinOnly, timeout: 60_000 }, async (t) => {
  await assertStopEndsDetachedProvider({ start: supervisors(t), detach, alive, assertReleased });
});

test("a detached job whose reattached broker exits ends its escaped descendants at once", { ...darwinOnly, timeout: 60_000 }, async (t) => {
  const start = supervisors(t);
  const run = await start("broker-exit", ["--detach", "500"]);
  const escapedFile = path.join(run.directory, "escaped.pid");
  run.request("escape");
  await waitUntil(() => existsSync(escapedFile) && Number(readFileSync(escapedFile, "utf8")) > 0, "the provider did not start its escaped descendant");
  const escaped = Number(readFileSync(escapedFile, "utf8"));
  t.after(() => { if (alive(escaped)) try { process.kill(escaped, "SIGKILL"); } catch {} });
  run.owner.kill("SIGKILL");
  run.request("attach");
  await delay(300);
  // The broker exits while attached and never reports a detach.
  run.request("exit");
  // Well inside the 500 ms window and its grace plus slack, without recovery.
  await assertReleased(run, 2500);
  assert.equal(alive(escaped), false, "an escaped descendant outlived its exited broker");
});

test("recovery verifies and ends a detached job whose owner is gone", { ...darwinOnly, timeout: 60_000 }, async (t) => {
  const start = supervisors(t);
  const run = await start("recovery", ["--detach", "60000"]);
  run.owner.kill("SIGKILL");
  await delay(300);
  assert.deepEqual(control("--probe", run.label), { status: 0, state: "alive" });
  assert.equal(control("--terminate", run.label).status, 0);
  assert.deepEqual(control("--probe", run.label), { status: 3, state: "absent" });
  await assertReleased(run, 15_000);
});

test("a malformed detach request starts nothing", darwinOnly, () => {
  for (const [args, environment] of [[["--detach", "49"], {}], [["--detach", "600001"], {}], [["--detach", "1e3"], {}],
    [["--detach", "-1"], {}], [["--detach", "1000"], { OUTRIGHT_UTILITY_OWNER: "1" }]]) {
    const label = `com.21n.outright.detach-malformed-${randomUUID()}`;
    const result = spawnSync(AGENT_SUPERVISOR, [...args, label, "/bin/sleep", "30"],
      { encoding: "utf8", timeout: 10_000, env: { ...process.env, ...environment }, stdio: ["ignore", "pipe", "pipe", "pipe"] });
    assert.equal(result.status, 64, `${args.join(" ")} was accepted`);
    assert.equal(serviceRegistered(label), false);
    assert.equal(existsSync(path.join(temporaryRoot, `outright-env-${label}`)), false);
  }
  assert.equal(spawnSync(AGENT_SUPERVISOR, ["--detach"], { stdio: "ignore", timeout: 10_000 }).status, 64);
});

// The whole path, through a later runtime that reattaches through slice 2.
test("a crashed runtime's terminal survives in its launchd job and a reattached runtime keeps it past the window", { ...darwinOnly, timeout: 90_000 }, async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-darwin-detach-managed-"));
  const id = randomUUID();
  const label = `com.21n.outright.terminal.${id}`;
  const managed = new URL("./managed-terminal.mjs", import.meta.url).href;
  const owner = spawn(process.execPath, ["--input-type=module", "-e", MANAGED_OWNER_SOURCE, managed, id, directory, directory, "3000"],
    { cwd: directory, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => {
    try { owner.kill("SIGKILL"); } catch {}
    spawnSync(AGENT_SUPERVISOR, ["--terminate", label], { stdio: "ignore", timeout: 15_000 });
    rmSync(directory, { recursive: true, force: true });
  });
  let lines = "";
  let stderr = "";
  owner.stdout.setEncoding("utf8");
  owner.stdout.on("data", (chunk) => { lines += chunk; });
  owner.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4096); });
  await waitUntil(() => lines.includes("\n"), () => `the managed terminal did not start: ${stderr}`, 20_000);
  const { identity, token, pid: supervisorPid } = JSON.parse(lines.slice(0, lines.indexOf("\n")));
  owner.kill("SIGKILL");
  const verifyEmpty = () => control("--probe", label).state === "absent";
  const adapter = await reattachCrashedTerminal({ id, identity, token, verifyEmpty });
  // Well past both the broker's window and the supervisor's: still live.
  await delay(7000);
  await assertKeptShell(adapter);
  assert.equal(alive(supervisorPid), true, "the crashed owner's supervisor left the reattached job");
  // Handing the shell back starts a new window, after which nothing remains.
  await adapter.release();
  await waitUntil(() => !alive(supervisorPid), "a released shell outlived its window", 20_000);
  assert.equal(serviceRegistered(label), false, "an expired detached terminal left its launchd job");
  assert.equal(existsSync(path.join(temporaryRoot, `outright-env-${label}`)), false);
});
