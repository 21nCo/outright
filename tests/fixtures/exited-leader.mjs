import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const descendant = spawn(process.execPath, [fileURLToPath(new URL("./stubborn-child.mjs", import.meta.url))], {
  stdio: ["ignore", "inherit", "inherit"],
  windowsHide: true,
});
descendant.once("error", (error) => { throw error; });
descendant.unref();
process.stdout.write(`descendant:${descendant.pid}\n`);
// The descendant retains the inherited pipe after its group leader exits.
