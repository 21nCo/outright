import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const executable = process.env.OUTRIGHT_TEST_MISSING_CHILD ? "outright-nonexistent-child-executable" : process.execPath;
const descendant = spawn(executable, [fileURLToPath(new URL("./stubborn-child.mjs", import.meta.url))], {
  stdio: ["ignore", "inherit", "inherit"],
  windowsHide: true,
});
descendant.once("error", (error) => {
  process.stdout.write(`spawn-error:${error.message}\n`);
  process.exitCode = 1;
});
descendant.once("spawn", () => {
  descendant.unref();
  process.stdout.write(`descendant:${descendant.pid}\n`);
  // Keep the leader alive until the harness records its child's identity.
  process.stdin.once("data", () => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
});
