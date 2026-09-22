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

const result = spawnSync(process.execPath, ["--test", "--test-timeout=300000", ...tests], {
  stdio: "inherit",
  timeout: 600_000,
  killSignal: "SIGKILL",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
