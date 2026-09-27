import { readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const directories = ["server", path.join("automation", "hermes")];
const tests = directories.flatMap((directory) => readdirSync(path.join(root, directory))
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => path.join(root, directory, name)));
tests.push(
  path.join(root, "tests", "ui-accessibility.test.mjs"),
  path.join(root, "tests", "terminal-exit-state.test.mjs"),
  path.join(root, "tests", "ui-races.test.mjs"),
);

// Browser performance fixtures need an uncontended renderer to measure the
// app rather than simultaneous Chrome instances started by other test files.
const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "--test-timeout=300000", ...tests], {
  stdio: "inherit",
  // Native process-tree fixtures may signal an owned group. Give the test
  // runner its own group so a misplaced signal cannot terminate the CI shell
  // before it records the sender/target diagnostics and test result.
  detached: process.platform !== "win32",
  timeout: 600_000,
  killSignal: "SIGKILL",
});
if (process.env.CI && result.signal) console.error(`CI test runner exited by ${result.signal}: child=${result.pid} parent=${process.pid}`);
if (result.error?.code === "ETIMEDOUT" || result.error?.killed || result.signal === "SIGKILL") {
  console.error("Test suite timed out after 600 seconds");
  process.exitCode = 1;
} else if (result.error) {
  throw result.error;
} else {
  process.exitCode = result.status ?? 1;
}
