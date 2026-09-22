import { chmodSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (["linux", "darwin", "win32"].includes(process.platform)) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const source = path.join(root, "server", process.platform === "darwin"
    ? "agent-supervisor-darwin.c"
    : process.platform === "win32" ? "agent-supervisor-windows.c" : "agent-supervisor.c");
  const outputDirectory = path.join(root, "server", "bin");
  const output = process.env.OUTRIGHT_AGENT_SUPERVISOR_OUTPUT || path.join(outputDirectory, process.platform === "win32" ? "agent-supervisor.exe" : "agent-supervisor");
  const temporary = process.platform === "win32" ? `${output}.tmp-${process.pid}.exe` : `${output}.tmp-${process.pid}`;
  mkdirSync(path.dirname(output), { recursive: true });
  const xcodeDeveloper = "/Applications/Xcode.app/Contents/Developer";
  const xcodeCompiler = path.join(xcodeDeveloper, "Toolchains", "XcodeDefault.xctoolchain", "usr", "bin", "clang");
  const xcodeSdk = path.join(xcodeDeveloper, "Platforms", "MacOSX.platform", "Developer", "SDKs", "MacOSX.sdk");
  const useXcode = process.platform === "darwin" && !process.env.CC && existsSync(xcodeCompiler) && existsSync(xcodeSdk);
  const compiler = process.env.CC || (process.platform === "win32" ? "cl" : useXcode ? xcodeCompiler : "cc");
  const compilerArgs = process.platform === "win32"
    ? ["/nologo", "/O2", "/W4", source, `/Fe:${temporary}`]
    : [...(useXcode ? ["-isysroot", xcodeSdk] : []), "-O2", "-std=c11", "-Wall", "-Wextra", source, "-o", temporary];
  const result = spawnSync(compiler, compilerArgs, { encoding: "utf8" });
  if (result.status !== 0) {
    rmSync(temporary, { force: true });
    const details = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`Unable to build the ${process.platform} agent supervisor with ${compiler}${details ? `:\n${details}` : ""}`);
  }
  chmodSync(temporary, 0o755);
  renameSync(temporary, output);
}
