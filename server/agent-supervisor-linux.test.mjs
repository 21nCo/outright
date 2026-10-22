import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AGENT_SUPERVISOR, LAUNCH_AUTHORIZED_CONTROL } from "./agent-manager.mjs";
import { reattachManagedTerminal, reattachToken, recoverManagedTerminal } from "./managed-terminal.mjs";

// Linux detach mode is this slice's; the other platforms' supervisors keep
// their own tests, so these run on Linux only.
const linuxOnly = { skip: process.platform !== "linux" };
const ATTACHED = "__OUTRIGHT_BROKER_ATTACHED_V1__";
const DETACHED = "__OUTRIGHT_BROKER_DETACHED_V1__";

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

// Stands in for the broker: records its pid, and prints a broker status line,
// starts a descendant orphaned to the supervisor, or exits when the test drops
// a request file in its directory.
const PROVIDER_SOURCE = `#!/bin/sh
dir="$1"
echo $$ > "$dir/provider.pid"
while :; do
  if [ -f "$dir/escape" ]; then rm -f "$dir/escape"
    ( sh -c 'echo $$ > "$1.tmp" && mv "$1.tmp" "$1"; exec sleep 600' sh "$dir/escaped.pid" </dev/null >/dev/null 2>&1 & )
  fi
  if [ -f "$dir/attach" ]; then rm -f "$dir/attach"; echo ${ATTACHED}; fi
  if [ -f "$dir/detach" ]; then rm -f "$dir/detach"; echo ${DETACHED}; fi
  if [ -f "$dir/exit" ]; then exit 0; fi
  sleep 0.05
done
`;

async function waitUntil(predicate, message, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(typeof message === "function" ? message() : message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

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
  const start = supervisors(t);
  const run = await start("reattach", ["--detach-on-owner-exit", "500"]);
  run.owner.kill("SIGKILL");
  run.request("attach");
  // Far past the window and its grace: the reattached runtime keeps it.
  await delay(3000);
  assert.equal(alive(run.providerPid()), true, "the supervisor ended a reattached shell at the window");
  const detachedAgain = Date.now();
  run.request("detach");
  await assertReleased(run, 10_000);
  assert.ok(Date.now() - detachedAgain >= 500, "a fresh detach did not get its own window");
});

test("a detach-mode provider ends at once on an explicit stop, and stdin EOF alone does not end it", { ...linuxOnly, timeout: 60_000 }, async (t) => {
  const start = supervisors(t);
  const stopped = await start("stop", ["--detach-on-owner-exit", "60000"]);
  stopped.owner.stdin.write("stop\n");
  await waitUntil(() => stopped.supervisorExit(), "an explicit stop did not end the detach-mode provider");
  assert.deepEqual(stopped.supervisorExit(), ["137", "null"]);
  await assertReleased(stopped, 5000);

  const eof = await start("eof", ["--detach-on-owner-exit", "60000"]);
  eof.owner.stdin.write("close\n");
  await delay(800);
  assert.equal(eof.supervisorExit(), null, "stdin EOF ended a detach-mode provider");
  assert.equal(alive(eof.providerPid()), true);
  process.kill(eof.supervisorPid, "SIGTERM");
  await waitUntil(() => eof.supervisorExit(), "a termination request did not end the detach-mode provider");
  assert.deepEqual(eof.supervisorExit(), ["137", "null"]);
  await assertReleased(eof, 5000);

  // The shell's own exit while detached settles it without the window.
  const exited = await start("exit", ["--detach-on-owner-exit", "60000"]);
  exited.owner.kill("SIGKILL");
  await delay(300);
  exited.request("exit");
  await assertReleased(exited, 5000);
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

// The whole path: a managed terminal launched with a reattach session, an
// owner that crashes, and a later runtime that reattaches through slice 2 or
// recovers the terminal through its native owner.
const MANAGED_OWNER_SOURCE = `
const [managed, id, launchDirectory, cwd, windowMs] = process.argv.slice(1);
const { reattachToken, spawnManagedTerminal, terminalOwnership } = await import(managed);
const ownership = terminalOwnership(id, launchDirectory);
const token = reattachToken();
const adapter = await spawnManagedTerminal({ id, ownership, shell: process.execPath, cwd, cols: 80, rows: 24,
  env: process.env, session: { label: ownership.label, token, windowMs: Number(windowMs) } });
let output = "";
adapter.onData((data) => {
  output += data;
  if (output.includes("41")) console.log(JSON.stringify({ identity: adapter.sessionIdentity, token, pid: adapter.pid }));
  if (output.includes("41")) output = "";
});
adapter.write("globalThis.kept = 41\\r");`;

async function crashedManagedTerminal(t, windowMs) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-linux-detach-managed-"));
  const launchDirectory = path.join(directory, "launch");
  mkdirSync(launchDirectory, { mode: 0o700 });
  const id = randomUUID();
  const handshakePath = path.join(launchDirectory, `terminal-${id}.json`);
  const managed = new URL("./managed-terminal.mjs", import.meta.url).href;
  const owner = spawn(process.execPath, ["--input-type=module", "-e", MANAGED_OWNER_SOURCE, managed, id, launchDirectory, directory, String(windowMs)],
    { cwd: directory, stdio: ["ignore", "pipe", "pipe"] });
  let supervisorPid = 0;
  t.after(() => {
    try { owner.kill("SIGKILL"); } catch {}
    if (alive(supervisorPid)) try { process.kill(supervisorPid, "SIGTERM"); } catch {}
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
  const recover = () => recoverManagedTerminal({ target: id, created: 1, ownershipLabel: `com.21n.outright.terminal.${id}`, launchDirectory });
  return { ...started, id, handshakePath, recover };
}

test("a crashed runtime's terminal survives its supervisor's owner and a reattached runtime keeps it past the window", { ...linuxOnly, timeout: 90_000 }, async (t) => {
  const { id, identity, token, pid: supervisorPid, handshakePath, recover } = await crashedManagedTerminal(t, 3000);
  let output = "";
  // The broker takes a reattach once it has seen its crashed peer close; a
  // refused attempt before then spends nothing.
  let adapter = null;
  const reattachDeadline = Date.now() + 2000;
  const nextToken = reattachToken();
  while (!adapter && Date.now() < reattachDeadline) {
    adapter = await reattachManagedTerminal({ id, identity, token, nextToken, cols: 80, rows: 24, verifyEmpty: recover });
    if (!adapter) await delay(50);
  }
  assert.ok(adapter, "the crashed runtime's terminal was not kept to reattach");
  adapter.onData((data) => { output += data; });
  // Well past both the broker's window and the supervisor's: still live.
  await delay(7000);
  assert.equal(adapter.write("kept + 1\r"), true, "the reattached broker went away");
  await waitUntil(() => output.includes("42"), () => `the reattached shell is not the live process: ${JSON.stringify(output.slice(-400))}`);
  assert.equal(alive(supervisorPid), true, "the crashed owner's supervisor left the reattached terminal");
  // Handing the shell back starts a new window, after which nothing remains.
  await adapter.release();
  await waitUntil(() => !alive(supervisorPid), "a released shell outlived its window", 20_000);
  assert.equal(existsSync(handshakePath), false, "an expired detached terminal left its launch handshake");
});

test("recovery verifies and ends a crashed runtime's detached terminal", { ...linuxOnly, timeout: 60_000 }, async (t) => {
  const { pid: supervisorPid, handshakePath, recover } = await crashedManagedTerminal(t, 60_000);
  await delay(500);
  assert.equal(alive(supervisorPid), true, "the detached terminal ended with its owner");
  assert.equal(await recover(), true, "recovery could not verify the detached terminal ended");
  assert.equal(existsSync(handshakePath), false);
  await waitUntil(() => !alive(supervisorPid), "recovery left the detached terminal's supervisor behind", 5000);
});
