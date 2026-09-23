import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (["linux", "darwin", "win32"].includes(process.platform)) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  let sourceName = "agent-supervisor.c";
  if (process.platform === "darwin") sourceName = "agent-supervisor-darwin.c";
  if (process.platform === "win32") sourceName = "agent-supervisor-windows.c";
  const source = path.join(root, "server", sourceName);
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
    let compilerScript = null;
    if (process.platform === "win32") {
      const programFiles = process.env["ProgramFiles(x86)"] || String.raw`C:\Program Files (x86)`;
      const systemRoot = process.env.SystemRoot || String.raw`C:\Windows`;
      const vswhere = path.join(programFiles, "Microsoft Visual Studio", "Installer", "vswhere.exe");
      const commandInterpreter = path.join(systemRoot, "System32", "cmd.exe");
      if (!path.win32.isAbsolute(vswhere) || !path.win32.isAbsolute(commandInterpreter)) {
        throw new Error("Windows build-tool roots must be absolute paths");
      }
      const installation = existsSync(vswhere)
        ? spawnSync(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"], { encoding: "utf8" }).stdout?.trim()
        : "";
      const environment = installation ? path.join(installation, "VC", "Auxiliary", "Build", "vcvars64.bat") : "";
      if (!environment || !existsSync(environment)) {
        throw new Error("Unable to find the Visual C++ build tools; install the Desktop development with C++ workload");
      }
      compiler = commandInterpreter;
      // Keep vcvars invocation out of cmd.exe's /S nested-quote parser. A
      // temporary batch file lets cmd parse each quoted path exactly once and
      // preserves the environment that vcvars establishes for cl.exe.
      compilerScript = `${temporary}.cmd`;
      writeFileSync(compilerScript, [
        "@echo off",
        `call "${environment}" >nul`,
        "if errorlevel 1 exit /b %errorlevel%",
        `"%VCToolsInstallDir%bin\\Hostx64\\x64\\cl.exe" /nologo /O2 /W4 "${source}" /Fe:"${temporary}"`,
        "exit /b %errorlevel%",
        "",
      ].join("\r\n"));
      compilerArgs = ["/d", "/c", compilerScript];
    }
    const result = spawnSync(compiler, compilerArgs, { encoding: "utf8" });
    if (compilerScript) rmSync(compilerScript, { force: true });
    if (result.status !== 0) {
      rmSync(temporary, { force: true });
      const details = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
      const detailSuffix = details ? `:\n${details}` : "";
      throw new Error(`Unable to build the ${process.platform} agent supervisor with ${compiler}${detailSuffix}`);
    }
    chmodSync(temporary, 0o755);
    renameSync(temporary, output);
  }
  if (process.platform === "win32" && !process.env.OUTRIGHT_AGENT_SUPERVISOR_OUTPUT) {
    writeFileSync(path.join(outputDirectory, "agent-supervisor.json"), `${JSON.stringify({ filename: path.basename(output) })}\n`);
  }
}
