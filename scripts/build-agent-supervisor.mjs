import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (["linux", "darwin", "win32"].includes(process.platform)) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const source = path.join(root, "server", process.platform === "darwin"
    ? "agent-supervisor-darwin.c"
    : process.platform === "win32" ? "agent-supervisor-windows.c" : "agent-supervisor.c");
  const outputDirectory = path.join(root, "server", "bin");
  const windowsDigest = process.platform === "win32"
    ? createHash("sha256").update(readFileSync(source)).digest("hex").slice(0, 16)
    : "";
  const output = process.env.OUTRIGHT_AGENT_SUPERVISOR_OUTPUT || path.join(outputDirectory,
    process.platform === "win32" ? `agent-supervisor-${windowsDigest}.exe` : "agent-supervisor");
  const temporary = process.platform === "win32" ? `${output}.tmp-${process.pid}.exe` : `${output}.tmp-${process.pid}`;
  mkdirSync(path.dirname(output), { recursive: true });
  const xcodeDeveloper = "/Applications/Xcode.app/Contents/Developer";
  const xcodeCompiler = path.join(xcodeDeveloper, "Toolchains", "XcodeDefault.xctoolchain", "usr", "bin", "clang");
  const xcodeSdk = path.join(xcodeDeveloper, "Platforms", "MacOSX.platform", "Developer", "SDKs", "MacOSX.sdk");
  const useXcode = process.platform === "darwin" && !process.env.CC && existsSync(xcodeCompiler) && existsSync(xcodeSdk);
  if (process.platform !== "win32" || !existsSync(output)) {
    let compiler = process.env.CC || (useXcode ? xcodeCompiler : "cc");
    let compilerArgs = [...(useXcode ? ["-isysroot", xcodeSdk] : []), "-O2", "-std=c11", "-Wall", "-Wextra", source, "-o", temporary];
    if (process.platform === "win32") {
      compiler = process.env.CC || "cl";
      compilerArgs = ["/nologo", "/O2", "/W4", source, `/Fe:${temporary}`];
      if (!process.env.CC && spawnSync("where.exe", ["cl.exe"], { stdio: "ignore" }).status !== 0) {
        const vswhere = path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe");
        const installation = existsSync(vswhere)
          ? spawnSync(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"], { encoding: "utf8" }).stdout?.trim()
          : "";
        const environment = installation ? path.join(installation, "VC", "Auxiliary", "Build", "vcvars64.bat") : "";
        if (!environment || !existsSync(environment)) {
          throw new Error("Unable to find the Visual C++ build tools; install the Desktop development with C++ workload or set CC");
        }
        compiler = "cmd.exe";
        compilerArgs = ["/d", "/s", "/c", `call "${environment}" >nul && cl /nologo /O2 /W4 "${source}" /Fe:"${temporary}"`];
      }
    }
    const result = spawnSync(compiler, compilerArgs, { encoding: "utf8" });
    if (result.status !== 0) {
      rmSync(temporary, { force: true });
      const details = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
      throw new Error(`Unable to build the ${process.platform} agent supervisor with ${compiler}${details ? `:\n${details}` : ""}`);
    }
    chmodSync(temporary, 0o755);
    renameSync(temporary, output);
  }
  if (process.platform === "win32" && !process.env.OUTRIGHT_AGENT_SUPERVISOR_OUTPUT) {
    writeFileSync(path.join(outputDirectory, "agent-supervisor.json"), `${JSON.stringify({ filename: path.basename(output) })}\n`);
  }
}
