import { readdirSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
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

// Browser performance fixtures need an uncontended renderer to measure the
// app rather than simultaneous Chrome instances started by other test files.
const child = spawn(process.execPath, ["--test", "--test-concurrency=1", "--test-timeout=300000", ...(process.argv.length > 2 ? process.argv.slice(2).map((file) => path.resolve(file)) : tests)], {
  stdio: "inherit",
  // Native process-tree fixtures may signal an owned group. Give the test
  // runner its own group so a misplaced signal cannot terminate the CI shell
  // before it records the sender/target diagnostics and test result.
  detached: process.platform !== "win32",
});
let timeout = false;
let forwardedSignal = null;
let escalation;
const signalRunner = (signal) => {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) { if (error?.code !== "ESRCH") console.error(`Test runner signal failed: ${error.message}`); }
};
const onSignal = (signal) => {
  if (forwardedSignal) return;
  forwardedSignal = signal;
  if (process.env.CI) console.error(`CI test launcher received ${signal}: launcher=${process.pid} parent=${process.ppid} runner=${child.pid}`);
  signalRunner(signal);
  escalation = setTimeout(() => signalRunner("SIGKILL"), 3000);
};
const signalHandlers = new Map(["SIGINT", "SIGTERM"].map((signal) => [signal, () => onSignal(signal)]));
for (const [signal, handler] of signalHandlers) process.on(signal, handler);
const deadline = setTimeout(() => {
  timeout = true;
  console.error("Test suite timed out after 600 seconds");
  signalRunner("SIGKILL");
}, 600_000);
child.on("error", (error) => {
  console.error(`Test runner could not start: ${error.message}`);
  process.exitCode = 1;
});
child.on("close", (status, signal) => {
  clearTimeout(deadline);
  clearTimeout(escalation);
  for (const [name, handler] of signalHandlers) process.off(name, handler);
  if (process.env.CI) console.error(`CI test runner closed: runner=${child.pid} status=${status} signal=${signal ?? "none"} launcher=${process.pid} parent=${process.ppid}`);
  process.exitCode = timeout ? 1 : forwardedSignal ? forwardedSignal === "SIGINT" ? 130 : 143 : status ?? (signal ? 1 : process.exitCode || 1);
});
