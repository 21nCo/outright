import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const windowsSupervisor = process.platform === "win32"
  ? (() => {
    const manifest = JSON.parse(readFileSync(new URL("../server/bin/agent-supervisor.json", import.meta.url), "utf8"));
    if (typeof manifest.filename !== "string" || !/^agent-supervisor-[0-9a-f]{16}\.exe$/.test(manifest.filename)) throw new Error("Windows test supervisor manifest is invalid");
    return fileURLToPath(new URL(`../server/bin/${manifest.filename}`, import.meta.url));
  })() : null;
const directories = ["server", path.join("automation", "hermes")];
const tests = directories.flatMap((directory) => readdirSync(path.join(root, directory))
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => path.join(root, directory, name)));
tests.push(
  path.join(root, "tests", "run-tests.test.mjs"),
  path.join(root, "tests", "ui-accessibility.test.mjs"),
  path.join(root, "tests", "terminal-exit-state.test.mjs"),
  path.join(root, "tests", "ui-races.test.mjs"),
);

// Native supervisor and browser fixtures can leave descendants after a test
// worker closes. Isolate each file's signal target and reap it before the next
// file starts; browser measurements also stay uncontended.
const files = process.argv.length > 2 ? process.argv.slice(2).map((file) => path.resolve(file)) : tests;
let child = null;
let cancelFile = null;
let forwardedSignal = null;
let timedOut = false;
let escalation;
const requestedTimeout = Number(process.env.OUTRIGHT_TEST_SUITE_TIMEOUT_MS);
const suiteTimeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
  ? Math.min(600_000, Math.max(1000, requestedTimeout)) : 600_000;
// The focused 1000px wheel fixture has a 330-second interaction phase and a
// separate cleanup allowance. Its per-file runner must outlive both.
const smallWheelCap = Number(process.env.OUTRIGHT_TEST_WHEEL_DELTA_CAP);
const testFileTimeoutMs = smallWheelCap > 0 && smallWheelCap <= 1000 ? 390_000 : 300_000;
const deadline = setTimeout(() => {
  timedOut = true;
  console.error(`Test suite timed out after ${suiteTimeoutMs}ms`);
  signalRunner("SIGKILL");
}, suiteTimeoutMs);

function signalRunner(signal) {
  if (!child?.pid || (process.platform === "win32" && (child.exitCode !== null || child.signalCode !== null))) return;
  try {
    // The Windows supervisor must remain alive to terminate its Job Object
    // and observe that every helper has stopped before the launcher exits.
    if (process.platform === "win32") {
      if (cancelFile) writeFileSync(cancelFile, signal);
    }
    else process.kill(-child.pid, signal);
  } catch (error) { if (error?.code !== "ESRCH") console.error(`Test runner signal failed: ${error.message}`); }
}

function onSignal(signal) {
  if (forwardedSignal) return;
  forwardedSignal = signal;
  if (process.env.CI) console.error(`CI test launcher received ${signal}: launcher=${process.pid} parent=${process.ppid} runner=${child?.pid ?? "none"}`);
  signalRunner(signal);
  if (process.platform !== "win32") escalation = setTimeout(() => signalRunner("SIGKILL"), 3000);
}
const signalHandlers = new Map(["SIGINT", "SIGTERM"].map((signal) => [signal, () => onSignal(signal)]));
for (const [signal, handler] of signalHandlers) process.on(signal, handler);
// A supervising test process can request the same graceful cancellation path
// over its owned IPC channel, including on Windows where kill() is forced.
if (process.send) {
  process.on("message", (message) => { if (message === "cancel") onSignal("SIGTERM"); });
  process.channel?.unref();
}

function liveGroupMembers(groupId) {
  if (process.platform === "win32") return [];
  const snapshot = spawnSync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,stat=,command="],
    { encoding: "utf8", timeout: 1000 });
  if (snapshot.status !== 0) throw new Error(`Test runner group inspection failed: ${snapshot.error?.message ?? snapshot.stderr?.trim() ?? snapshot.status}`);
  return snapshot.stdout.split("\n").filter((line) => {
    const fields = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)/);
    return fields && Number(fields[3]) === groupId && !fields[4].startsWith("Z");
  });
}

async function reapGroup(groupId) {
  // The Windows runner is inside a native Job Object. Its supervisor closes
  // only after the job has no active processes; cancellation closes the job
  // handle and the kernel kills the remaining members.
  if (process.platform === "win32") return true;
  // Inspect independently of the signal helper: a closed runner is not proof
  // that a SIGTERM-ignoring descendant stopped executing.
  let members = liveGroupMembers(groupId);
  const until = Date.now() + 3000;
  while (members.length && Date.now() < until) {
    signalRunner("SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 40));
    members = liveGroupMembers(groupId);
  }
  if (members.length) console.error(`CI failed test runner group: runner=${groupId} members=${JSON.stringify(members.slice(0, 32))}`);
  return members.length === 0;
}

async function runFile(file) {
  if (process.env.CI) console.error(`CI test runner starting: file=${path.basename(file)} launcher=${process.pid}`);
  const cancelDirectory = windowsSupervisor ? mkdtempSync(path.join(os.tmpdir(), "outright-test-cancel-")) : null;
  cancelFile = cancelDirectory ? path.join(cancelDirectory, "cancel") : null;
  child = spawn(windowsSupervisor ?? process.execPath, [
    ...(windowsSupervisor ? ["--test-runner", cancelFile, process.execPath] : []),
    "--test", "--test-concurrency=1", `--test-timeout=${testFileTimeoutMs}`, file,
  ], {
    stdio: "inherit",
    detached: process.platform !== "win32",
  });
  const runner = child;
  const closed = await new Promise((resolve) => {
    runner.once("error", (error) => { console.error(`Test runner could not start ${file}: ${error.message}`); });
    runner.once("close", (status, signal) => resolve({ status, signal }));
  });
  if (process.env.CI && process.platform !== "win32" && (closed.status !== 0 || closed.signal)) {
    try { console.error(`CI failed test runner group: runner=${runner.pid} members=${JSON.stringify(liveGroupMembers(runner.pid).slice(0, 32))}`); }
    catch (error) { console.error(error.message); }
  }
  if (process.env.CI) console.error(`CI test runner closed: file=${path.basename(file)} runner=${runner.pid} status=${closed.status} signal=${closed.signal ?? "none"} launcher=${process.pid} parent=${process.ppid}`);
  if (process.platform !== "win32") signalRunner("SIGKILL");
  const groupGone = runner.pid ? await reapGroup(runner.pid) : true;
  child = null;
  cancelFile = null;
  if (cancelDirectory) rmSync(cancelDirectory, { recursive: true, force: true });
  return { groupGone, passed: groupGone && closed.status === 0 && !closed.signal };
}

let passed = true;
try {
  for (const file of files) {
    if (forwardedSignal || timedOut) { passed = false; break; }
    const outcome = await runFile(file);
    if (!outcome.passed) passed = false;
    // A group that still executes can interfere with the next file. Leave the
    // suite failed and stop at that boundary rather than contaminating it.
    if (!outcome.groupGone) break;
  }
} catch (error) {
  console.error(error);
  passed = false;
} finally {
  clearTimeout(deadline);
  clearTimeout(escalation);
  for (const [signal, handler] of signalHandlers) process.off(signal, handler);
}
process.exitCode = forwardedSignal === "SIGINT" ? 130 : forwardedSignal ? 143 : timedOut || !passed ? 1 : 0;
