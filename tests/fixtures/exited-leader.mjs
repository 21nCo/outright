import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const executable = process.env.OUTRIGHT_TEST_MISSING_CHILD ? "outright-nonexistent-child-executable" : process.execPath;
const descendant = spawn(executable, [fileURLToPath(new URL("./stubborn-child.mjs", import.meta.url))], {
  detached: process.platform === "win32",
  stdio: process.platform === "win32" ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
  windowsHide: true,
});
descendant.once("error", (error) => {
  process.stdout.write(`spawn-error:${error.message}\n`);
  process.exitCode = 1;
});
descendant.once("spawn", () => {
  descendant.unref();
  if (process.platform === "win32") {
    descendant.stdout.once("data", () => process.stdout.write(`descendant:${descendant.pid}:ready\n`));
    descendant.stderr.on("data", (chunk) => process.stderr.write(chunk));
  } else process.stdout.write(`descendant:${descendant.pid}:ready\n`);
  // Keep the leader alive until the harness records a ready child's identity.
  process.stdin.once("data", () => process.exit(0));
  setTimeout(() => { process.stdout.write("leader-expiry\n"); process.exit(1); }, 20_000).unref();
});
