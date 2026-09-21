import { chmod, readdir } from "node:fs/promises";
import path from "node:path";

if (process.platform !== "win32") {
  const root = "node_modules/node-pty";
  for (const entry of await readdir(root, { recursive: true })) {
    if (path.basename(entry) === "spawn-helper") await chmod(path.join(root, entry), 0o755);
  }
}
