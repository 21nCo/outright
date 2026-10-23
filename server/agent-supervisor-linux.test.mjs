import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AGENT_SUPERVISOR, LAUNCH_AUTHORIZED_CONTROL } from "./agent-manager.mjs";
import { recoverManagedTerminal } from "./managed-terminal.mjs";
import { MANAGED_OWNER_SOURCE, assertKeptShell, assertReattachPausesWindow, assertStopEndsDetachedProvider, brokerStandIn,
  delay, reattachCrashedTerminal, waitUntil } from "../tests/fixtures/supervisor-detach.mjs";

// Linux detach mode is this slice's; the other platforms' supervisors keep
// their own tests, so these run on Linux only.
const linuxOnly = { skip: process.platform !== "linux" };
const detach = (windowMs) => ["--detach-on-owner-exit", String(windowMs)];

// The Outright owner: it launches and authorizes the supervisor as managed
// terminals do, reports its pid and exit, and forwards a stop or closes its
// stdin on request. The test kills this owner to stand for a crashed runtime.
const OWNER_SOURCE = `
const { spawn } = require("node:child_process");
const [supervisor, ...args] = process.argv.slice(1);
const child = spawn(supervisor, args, { stdio: ["pipe", "pipe", "ignore", "pipe"], detached: true });
child.stdout.resume();
child.stdin.on("error", () => {});
child.stdio[3].setEncoding("utf8");
child.stdio[3].on("data", (data) => { if (data.includes(${JSON.stringify(LAUNCH_AUTHORIZED_CONTROL)})) console.log("authorized"); });
child.stdio[3].on("error", () => {});
console.log("pid " + child.pid);
child.on("exit", (code, signal) => console.log("exit " + code + " " + signal));
child.stdin.write("go\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (command) => {
  if (command.includes("stop")) child.stdin.write("stop\\n");
  if (command.includes("close")) child.stdin.end();
});`;

// The broker stand-in's descendant is orphaned to the supervisor.
const PROVIDER_SOURCE = brokerStandIn(`( sh -c 'echo $$ > "$1.tmp" && mv "$1.tmp" "$1"; exec sleep 600' sh "$dir/escaped.pid" </dev/null >/dev/null 2>&1 & )`);

// A zombie awaiting its reaper has ended; only a running process counts.
function alive(pid) {
  if (!pid) return false;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") return false; throw error; }
}

const terminateOwned = (handshakePath, markerPath = handshakePath) => {
  const handshake = JSON.parse(readFileSync(handshakePath, "utf8"));
  const result = spawnSync(AGENT_SUPERVISOR, ["--terminate-owned", String(handshake.pid), handshake.processIdentity, markerPath],
    { encoding: "utf8", timeout: 10_000 });
  return { status: result.status, output: result.stdout.trim() };
};

// One supervised provider per call, each with its own handshake and
// directory, all of which the test's cleanup ends and removes after a failure.
function supervisors(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-linux-detach-"));
  const provider = path.join(root, "provider.sh");
  writeFileSync(provider, PROVIDER_SOURCE, { mode: 0o700 });
  const runs = [];
  t.after(() => {
    for (const run of runs) {
      try { run.owner.kill("SIGKILL"); } catch {}
      for (const pid of [run.supervisorPid, run.providerPid(), run.escapedPid()]) if (alive(pid)) try { process.kill(pid, "SIGKILL"); } catch {}
    }
    rmSync(root, { recursive: true, force: true });
  });
  return async (name, modeArgs) => {
    const directory = path.join(root, name);
    mkdirSync(directory);
    const handshakePath = path.join(directory, "launch", "handshake.json");
    const owner = spawn(process.execPath, ["-e", OWNER_SOURCE, AGENT_SUPERVISOR, ...modeArgs, handshakePath, "/bin/sh", provider, directory],
      { cwd: directory, stdio: ["pipe", "pipe", "ignore"] });
    let lines = "";
    owner.stdout.setEncoding("utf8");
    owner.stdout.on("data", (chunk) => { lines += chunk; });
    const pidFile = path.join(directory, "provider.pid");
    const escapedFile = path.join(directory, "escaped.pid");
    const run = { directory, owner, handshakePath, supervisorPid: 0,
      providerPid: () => existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) || 0 : 0,
      escapedPid: () => existsSync(escapedFile) ? Number(readFileSync(escapedFile, "utf8").trim()) || 0 : 0,
      supervisorExit: () => lines.match(/^exit (\S+) (\S+)$/m)?.slice(1) ?? null,
      request: (file) => writeFileSync(path.join(directory, file), "") };
    runs.push(run);
    await waitUntil(() => /^pid \d+$/m.test(lines), () => `owner did not start its supervisor: ${lines}`);
    run.supervisorPid = Number(lines.match(/^pid (\d+)$/m)[1]);
    await waitUntil(() => lines.includes("authorized\n") && run.providerPid() > 0, () => `${name}: the provider did not start: ${lines}`);
    return run;
  };
}

// Nothing of a finished provider remains: supervisor, provider, an orphaned
// descendant or the durable launch handshake recovery would act on.
async function assertReleased(run, timeout = 10_000) {
  await waitUntil(() => !alive(run.providerPid()), `${run.directory}: the provider outlived its supervisor`, timeout);
  await waitUntil(() => !alive(run.supervisorPid), `${run.directory}: the supervisor did not exit`, timeout);
  assert.equal(alive(run.escapedPid()), false, `${run.directory}: an orphaned descendant outlived its supervisor`);
  assert.equal(existsSync(run.handshakePath), false, `${run.directory} kept its launch handshake`);
}

test("a detach-mode provider outlives its owner until the window ends; stop-on-owner-exit still ends it with its owner", { ...linuxOnly, timeout: 60_000 }, async (t) => {
  const start = supervisors(t);
  const detached = await start("window", ["--detach-on-owner-exit", "1000"]);
  const plain = await start("plain", ["--stop-on-owner-exit"]);
  const ownerGone = Date.now();
  detached.owner.kill("SIGKILL");
  plain.owner.kill("SIGKILL");
  await assertReleased(plain, 5000);
  await delay(Math.max(0, ownerGone + 700 - Date.now()));
  assert.equal(alive(detached.providerPid()), true, "a detach-mode provider ended with its owner");
  assert.equal(alive(detached.supervisorPid), true, "the detach-mode supervisor exited with its owner");
  assert.equal(existsSync(detached.handshakePath), true, "recovery lost the detached provider's handshake");
  await assertReleased(detached, 10_000);
  assert.ok(Date.now() - ownerGone >= 1000, "the detached provider ended before its window");
});

test("a reattached broker pauses the detach window and its next detach starts it again", { ...linuxOnly, timeout: 60_000 }, async (t) => {
  await assertReattachPausesWindow({ start: supervisors(t), detach, alive, assertReleased });
});

test("a detach-mode provider ends at once on an explicit stop, and stdin EOF alone does not end it", { ...linuxOnly, timeout: 60_000 }, async (t) => {
  await assertStopEndsDetachedProvider({ start: supervisors(t), detach, alive, assertReleased });
});

test("a detached provider whose reattached broker exits ends its orphaned descendants at once", { ...linuxOnly, timeout: 60_000 }, async (t) => {
  const start = supervisors(t);
  const run = await start("broker-exit", ["--detach-on-owner-exit", "500"]);
  run.request("escape");
  await waitUntil(() => run.escapedPid() > 0 && alive(run.escapedPid()), "the provider did not start its orphaned descendant");
  run.owner.kill("SIGKILL");
  run.request("attach");
  await delay(300);
  // The broker exits while attached and never reports a detach.
  run.request("exit");
  // Well inside the 500 ms window and its grace plus slack, without recovery.
  await assertReleased(run, 2500);
});

test("recovery verifies a detach-mode supervisor's marker and ends it through its pidfd", { ...linuxOnly, timeout: 60_000 }, async (t) => {
  const start = supervisors(t);
  const run = await start("recovery", ["--detach-on-owner-exit", "60000"]);
  run.request("escape");
  await waitUntil(() => run.escapedPid() > 0 && alive(run.escapedPid()), "the provider did not start its orphaned descendant");
  run.owner.kill("SIGKILL");
  await delay(300);
  // Another terminal's handshake path does not name this owner.
  assert.deepEqual(terminateOwned(run.handshakePath, path.join(run.directory, "other.json")), { status: 4, output: "" });
  assert.equal(alive(run.supervisorPid), true, "a mismatched marker signaled the supervisor");
  assert.deepEqual(terminateOwned(run.handshakePath), { status: 0, output: "signaled" });
  await assertReleased(run, 5000);
});

test("a malformed detach request starts nothing", linuxOnly, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-linux-detach-malformed-"));
  try {
    for (const [args, environment] of [[["49"], {}], [["600001"], {}], [["1e3"], {}], [["-1"], {}], [[""], {}],
      [["1000"], { OUTRIGHT_UTILITY_OWNER: "1" }]]) {
      const handshakePath = path.join(root, randomUUID(), "handshake.json");
      const result = spawnSync(AGENT_SUPERVISOR, ["--detach-on-owner-exit", ...args, handshakePath, "/bin/sleep", "30"],
        { encoding: "utf8", timeout: 10_000, env: { ...process.env, ...environment }, input: "go\n", stdio: ["pipe", "pipe", "pipe", "pipe"] });
      assert.equal(result.status, 64, `${args.join(" ")} was accepted`);
      assert.equal(existsSync(path.dirname(handshakePath)), false, `${args.join(" ")} wrote launch ownership`);
    }
    for (const args of [["--detach-on-owner-exit"], ["--detach-on-owner-exit", "1000"], ["--detach-on-owner-exit", "1000", path.join(root, "only.json")]]) {
      assert.equal(spawnSync(AGENT_SUPERVISOR, args, { stdio: "ignore", timeout: 10_000 }).status, 64, `${args.join(" ")} was accepted`);
    }
    assert.equal(existsSync(path.join(root, "only.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// A managed terminal whose owner crashed, for a later runtime to reattach
// through slice 2 or recover through its native owner. With pause, the
// supervisor stops itself at the pause point once the test drops
// pause.trigger.
async function crashedManagedTerminal(t, windowMs, pause = null) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-linux-detach-managed-"));
  const launchDirectory = path.join(directory, "launch");
  mkdirSync(launchDirectory, { mode: 0o700 });
  const id = randomUUID();
  const handshakePath = path.join(launchDirectory, `terminal-${id}.json`);
  const managed = new URL("./managed-terminal.mjs", import.meta.url).href;
  const owner = spawn(process.execPath, ["--input-type=module", "-e", MANAGED_OWNER_SOURCE, managed, id, launchDirectory, directory, String(windowMs)],
    { cwd: directory, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...pause?.env } });
  let supervisorPid = 0;
  t.after(() => {
    try { owner.kill("SIGKILL"); } catch {}
    if (alive(supervisorPid)) try { process.kill(supervisorPid, "SIGTERM"); process.kill(supervisorPid, "SIGCONT"); } catch {}
    rmSync(directory, { recursive: true, force: true });
  });
  let lines = "";
  let stderr = "";
  owner.stdout.setEncoding("utf8");
  owner.stdout.on("data", (chunk) => { lines += chunk; });
  owner.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4096); });
  await waitUntil(() => lines.includes("\n"), () => `the managed terminal did not start: ${stderr}`, 20_000);
  const started = JSON.parse(lines.slice(0, lines.indexOf("\n")));
  supervisorPid = started.pid;
  assert.equal(existsSync(handshakePath), true, "the managed terminal has no launch handshake");
  owner.kill("SIGKILL");
  const ownerGone = Date.now();
  const recover = () => recoverManagedTerminal({ target: id, created: 1, ownershipLabel: `com.21n.outright.terminal.${id}`, launchDirectory });
  return { ...started, id, handshakePath, recover, ownerGone };
}

// Interposes poll() and clock_gettime() in the supervisor alone: once the
// trigger file exists, it stops itself after the chosen point (an empty poll,
// or a CLOCK_MONOTONIC sample), standing for a supervisor descheduled there.
const PAUSE_SOURCE = `#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
static void pause_after(const char *point) {
  const char *program = getenv("OUTRIGHT_TEST_PAUSE_PROGRAM");
  const char *at = getenv("OUTRIGHT_TEST_PAUSE_AT");
  const char *trigger = getenv("OUTRIGHT_TEST_PAUSE_TRIGGER");
  if (program && at && trigger && strcmp(at, point) == 0 && strcmp(program_invocation_short_name, program) == 0
      && unlink(trigger) == 0) raise(SIGSTOP);
}
int poll(struct pollfd *descriptors, nfds_t count, int timeout) {
  static int (*next)(struct pollfd *, nfds_t, int);
  if (!next) next = (int (*)(struct pollfd *, nfds_t, int))dlsym(RTLD_NEXT, "poll");
  int result = next(descriptors, count, timeout);
  if (result == 0) pause_after("poll");
  return result;
}
int __poll_chk(struct pollfd *descriptors, nfds_t count, int timeout, size_t length) {
  (void)length;
  return poll(descriptors, count, timeout);
}
int clock_gettime(clockid_t clock, struct timespec *now) {
  static int (*next)(clockid_t, struct timespec *);
  if (!next) next = (int (*)(clockid_t, struct timespec *))dlsym(RTLD_NEXT, "clock_gettime");
  int result = next(clock, now);
  if (clock == CLOCK_MONOTONIC) pause_after("clock");
  return result;
}
`;

function pausing(t, at) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-linux-detach-pause-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, "pause.c");
  const library = path.join(directory, "pause.so");
  writeFileSync(source, PAUSE_SOURCE);
  const build = spawnSync(process.env.CC || "cc", ["-shared", "-fPIC", "-O2", source, "-o", library, "-ldl"], { encoding: "utf8" });
  assert.equal(build.status, 0, `the pause shim did not build: ${build.stderr}`);
  const trigger = path.join(directory, "trigger");
  return { trigger, env: { LD_PRELOAD: library, OUTRIGHT_TEST_PAUSE_PROGRAM: path.basename(AGENT_SUPERVISOR),
    OUTRIGHT_TEST_PAUSE_AT: at, OUTRIGHT_TEST_PAUSE_TRIGGER: trigger } };
}

const stopped = (pid) => {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return /^[Tt]$/.test(stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3));
};

test("a crashed runtime's terminal survives its supervisor's owner and a reattached runtime keeps it past the window", { ...linuxOnly, timeout: 90_000 }, async (t) => {
  const { id, identity, token, pid: supervisorPid, handshakePath, recover } = await crashedManagedTerminal(t, 3000);
  const adapter = await reattachCrashedTerminal({ id, identity, token, verifyEmpty: recover });
  // Well past both the broker's window and the supervisor's: still live.
  await delay(7000);
  await assertKeptShell(adapter);
  assert.equal(alive(supervisorPid), true, "the crashed owner's supervisor left the reattached terminal");
  // Handing the shell back starts a new window, after which nothing remains.
  await adapter.release();
  await waitUntil(() => !alive(supervisorPid), "a released shell outlived its window", 20_000);
  assert.equal(existsSync(handshakePath), false, "an expired detached terminal left its launch handshake");
});

test("a reattach queued while the supervisor is descheduled past its deadline keeps the shell", { ...linuxOnly, timeout: 90_000 }, async (t) => {
  const pause = pausing(t, "poll");
  const { id, identity, token, pid: supervisorPid, handshakePath, recover, ownerGone } = await crashedManagedTerminal(t, 1000, pause);
  // Once the supervisor has started its window, stop it after an empty poll.
  await delay(200);
  writeFileSync(pause.trigger, "");
  await waitUntil(() => stopped(supervisorPid), "the supervisor did not stop after an empty poll", 5000);
  // An authenticated reattach inside the broker's window queues ATTACHED.
  const adapter = await reattachCrashedTerminal({ id, identity, token, verifyEmpty: recover });
  // Resume it well past its deadline, the 1000 ms window and its grace.
  await delay(Math.max(0, ownerGone + 3500 - Date.now()));
  process.kill(supervisorPid, "SIGCONT");
  await delay(1500);
  assert.equal(alive(supervisorPid), true, "a stale deadline ended a terminal reattached inside its window");
  await assertKeptShell(adapter);
  await adapter.release();
  await waitUntil(() => !alive(supervisorPid), "a released shell outlived its window", 20_000);
  assert.equal(existsSync(handshakePath), false, "an expired detached terminal left its launch handshake");
});

// Running processes below root, from /proc's parent links.
function descendants(root) {
  const parents = new Map();
  for (const entry of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const [state, parent] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (state !== "Z") parents.set(Number(entry), Number(parent));
    } catch (error) { if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error; }
  }
  const found = [];
  for (let frontier = [root]; frontier.length;) {
    frontier = [...parents].filter(([, parent]) => frontier.includes(parent)).map(([pid]) => pid);
    found.push(...frontier);
  }
  return found;
}

// The supervisor stops just after a clock sample while a successor holds the
// shell past the old window and its grace, then the successor hands it back:
// the DETACHED it observes late still starts a whole window, whether its
// ATTACHED came before the pause or was queued with the DETACHED during it.
async function assertLateDetachGetsWholeWindow(t, attachDuringPause) {
  const windowMs = 1000;
  const pause = pausing(t, "clock");
  const { id, identity, token, pid: supervisorPid, handshakePath, recover, ownerGone } = await crashedManagedTerminal(t, windowMs, pause);
  const reattach = () => reattachCrashedTerminal({ id, identity, token, verifyEmpty: recover });
  let adapter = attachDuringPause ? null : await reattach();
  // Let the supervisor take its owner's loss and any reattach first.
  await delay(300);
  writeFileSync(pause.trigger, "");
  await waitUntil(() => stopped(supervisorPid), "the supervisor did not stop after a clock sample", 5000);
  adapter ??= await reattach();
  await delay(Math.max(0, ownerGone + 2 * windowMs + 1500 - Date.now()));
  // The broker has written DETACHED and started its own window by the time
  // release resolves.
  await adapter.release();
  const released = Date.now();
  process.kill(supervisorPid, "SIGCONT");
  await delay(Math.max(0, released + 0.8 * windowMs - Date.now()));
  const tree = descendants(supervisorPid);
  assert.equal(alive(supervisorPid), true, "a detach observed late ended its terminal before the window");
  assert.equal(existsSync(handshakePath), true, "a detach observed late removed its launch handshake before the window");
  assert.ok(tree.length >= 2, `the released broker and shell did not outlive the supervisor's pause: ${tree}`);
  // Window, grace, the 750 ms teardown budget and slack.
  await waitUntil(() => !alive(supervisorPid), "a released shell outlived its window", released + 2 * windowMs + 750 + 2000 - Date.now());
  assert.equal(existsSync(handshakePath), false, "an expired detached terminal left its launch handshake");
  assert.deepEqual(tree.filter(alive), [], "an expired detached terminal left a descendant behind");
}

test("a detach observed late after a clock-sample pause still gets its whole window", { ...linuxOnly, timeout: 90_000 }, async (t) => {
  await assertLateDetachGetsWholeWindow(t, false);
});

test("a reattach and release queued together during a clock-sample pause start a whole window", { ...linuxOnly, timeout: 90_000 }, async (t) => {
  await assertLateDetachGetsWholeWindow(t, true);
});

test("recovery verifies and ends a crashed runtime's detached terminal", { ...linuxOnly, timeout: 60_000 }, async (t) => {
  const { pid: supervisorPid, handshakePath, recover } = await crashedManagedTerminal(t, 60_000);
  await delay(500);
  assert.equal(alive(supervisorPid), true, "the detached terminal ended with its owner");
  assert.equal(await recover(), true, "recovery could not verify the detached terminal ended");
  assert.equal(existsSync(handshakePath), false);
  await waitUntil(() => !alive(supervisorPid), "recovery left the detached terminal's supervisor behind", 5000);
});
