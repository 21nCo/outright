import { chmodSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform === "linux") {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const source = path.join(root, "server", "agent-supervisor.c");
  const outputDirectory = path.join(root, "server", "bin");
  const output = process.env.OUTRIGHT_AGENT_SUPERVISOR_OUTPUT || path.join(outputDirectory, "agent-supervisor");
  const temporary = `${output}.tmp-${process.pid}`;
  mkdirSync(path.dirname(output), { recursive: true });
  const compiler = process.env.CC || "cc";
  const result = spawnSync(compiler, ["-O2", "-std=c11", "-Wall", "-Wextra", source, "-o", temporary], { encoding: "utf8" });
  if (result.status !== 0) {
    rmSync(temporary, { force: true });
    const details = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`Unable to build the Linux agent supervisor with ${compiler}${details ? `:\n${details}` : ""}`);
  }
  chmodSync(temporary, 0o755);
  renameSync(temporary, output);
}
