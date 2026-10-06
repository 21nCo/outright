import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_SUPERVISOR } from "./agent-manager.mjs";
import { utilityProcesses } from "./subprocess-budget.mjs";

const BROKER = fileURLToPath(new URL("./terminal-broker.mjs", import.meta.url));
const START_TIMEOUT_MS = 8000;

export function terminalOwnership(id, launchDirectory) {
  const token = randomUUID();
  const socketDirectory = process.platform === "win32" ? null : privateSocketDirectory();
  return { label: `com.21n.outright.terminal.${id}`, token,
    address: process.platform === "win32" ? String.raw`\\.\pipe\outright-terminal-${id}` : path.join(socketDirectory, `${id}.sock`),
    handshakePath: path.join(launchDirectory, `terminal-${id}.json`) };
}

function privateSocketDirectory() {
  const directory = `/tmp/outright-pty-${process.getuid()}`;
  try { mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
    throw new Error("Terminal socket directory is not private");
  }
  return directory;
}

export function cleanupTerminalSocket(id) {
  if (process.platform === "win32" || !/^[0-9a-f-]{36}$/i.test(id)) return;
  const address = path.join(privateSocketDirectory(), `${id}.sock`);
  try { if (lstatSync(address).isSocket()) unlinkSync(address); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

export async function spawnManagedTerminal({ id, ownership, shell, cwd, cols, rows, env,
  subprocesses = utilityProcesses }) {
  const brokerArgs = [process.execPath, BROKER, ownership.address, ownership.token];
  let nativeArgs = brokerArgs;
  if (process.platform === "linux") nativeArgs = ["--stop-on-owner-exit", ownership.handshakePath, ...brokerArgs];
  else if (process.platform === "darwin") nativeArgs = [ownership.label, ...brokerArgs];
  const child = spawn(AGENT_SUPERVISOR, nativeArgs, { cwd, env: { ...env,
    ...(process.platform === "darwin" ? { OUTRIGHT_LAUNCH_GATE_FD: "3", OUTRIGHT_TERMINAL_CONTROL: "1" } : {}) },
    stdio: ["pipe", "pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
  child.stdout.resume();
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-2048); });
  child.stdin.on("error", () => {});
  child.stdio[3]?.on("error", () => {});
  let onData;
  let onExit;
  let earlyData = "";
  let finalResult;
  let closed = false;
  let socket;
  let verified = false;
  let readySeen = false;
  let shellExited = false;
  let windowsProcessIdentity;
  const verifyEmpty = async (signal, exitCode) => {
    if (process.platform === "linux") return !existsSync(ownership.handshakePath);
    if (process.platform === "darwin") {
      let status;
      try {
        const probe = await subprocesses.run(AGENT_SUPERVISOR, ["--probe", ownership.label],
          { encoding: "utf8", timeout: 1500, maxBuffer: 4096 });
        status = probe.stdout.trim();
      } catch (error) {
        status = error.stdout?.trim();
      }
      if (status === "absent") return true;
      if (status !== "exited") return false;
      try { await subprocesses.run(AGENT_SUPERVISOR, ["--terminate", ownership.label],
        { encoding: "utf8", timeout: 5000, maxBuffer: 4096 }); }
      catch { return false; }
      try { return (await subprocesses.run(AGENT_SUPERVISOR, ["--probe", ownership.label],
        { encoding: "utf8", timeout: 1500, maxBuffer: 4096 })).stdout.trim() === "absent"; }
      catch (error) { return error.stdout?.trim() === "absent"; }
    }
    if (process.platform !== "win32" || signal != null || !Number.isInteger(exitCode)) return false;
    if (exitCode < 70 || exitCode > 79) return true;
    // A shell may legitimately exit with a code reserved for native startup
    // failures. Once launch identity was observed, prove this exact Job Object
    // owner has exited instead of classifying the shell code as unknown.
    if (!windowsProcessIdentity) return false;
    try {
      const probe = await subprocesses.run(AGENT_SUPERVISOR,
        ["--probe", String(child.pid), windowsProcessIdentity],
        { encoding: "utf8", timeout: 1500, maxBuffer: 4096 });
      return probe.stdout.trim() === "absent";
    } catch (error) { return error.stdout?.trim() === "absent"; }
  };
  const closeResult = new Promise((resolve) => {
    child.on("error", (error) => { stderr = `${stderr}${error.message}`.slice(-2048); });
    child.on("close", async (exitCode, signal) => {
      closed = true;
      socket?.destroy();
      verified = await verifyEmpty(signal, exitCode);
      finalResult = { exitCode, signal, verified };
      onExit?.(finalResult);
      resolve(finalResult);
    });
  });
  const adapter = {
    pid: child.pid,
    onData(callback) { onData = callback; if (earlyData) { callback(earlyData); earlyData = ""; } },
    onExit(callback) { onExit = callback; if (finalResult) callback(finalResult); },
    write(data) {
      if (!socket || socket.destroyed || socket.writableLength > 256 * 1024) return false;
      socket.write(`${JSON.stringify({ type: "write", data })}\n`);
      return true;
    },
    resize(nextCols, nextRows) {
      if (!socket || socket.destroyed || socket.writableLength > 256 * 1024) return false;
      socket.write(`${JSON.stringify({ type: "resize", cols: nextCols, rows: nextRows })}\n`);
      return true;
    },
    async terminate() {
      if (!closed) {
        child.stdin.write("stop\n");
      }
      let timeout;
      const result = await Promise.race([closeResult, new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("PTY ownership teardown timed out")), 5000);
      })]).finally(() => clearTimeout(timeout));
      if (!result.verified && !await verifyEmpty(result.signal, result.exitCode)) throw new Error("PTY owned process boundary could not be verified empty");
    },
  };
  try {
    if (process.platform === "linux") child.stdin.write("go\n");
    else if (process.platform === "darwin") child.stdio[3].end("go\n");
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline && !closed) {
      try {
        socket = await new Promise((resolve, reject) => {
          const client = net.createConnection(ownership.address);
          client.once("connect", () => resolve(client));
          client.once("error", reject);
        });
        break;
      } catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
    }
    if (!socket) throw new Error(`PTY broker did not start: ${stderr || "native supervisor unavailable"}`);
    const ready = new Promise((resolve, reject) => {
      let pending = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        pending += chunk;
        if (pending.length > 256 * 1024) { reject(new Error("PTY broker response exceeded its limit")); socket.destroy(); return; }
        let end;
        while ((end = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          let message;
          try { message = JSON.parse(line); } catch { reject(new Error("PTY broker returned malformed data")); socket.destroy(); return; }
          if (message.type === "ready") { readySeen = true; resolve(); }
          else if (message.type === "error") reject(new Error(message.message));
          else if (message.type === "shell-exited") shellExited = true;
          else if (message.type === "data" && typeof message.data === "string") {
            if (onData) onData(message.data);
            else earlyData = `${earlyData}${message.data}`.slice(-150_000);
          }
        }
      });
      socket.on("error", reject);
      socket.on("close", () => {
        if (!readySeen) reject(new Error("PTY broker closed before launch"));
        else if (!shellExited && !closed) void adapter.terminate().catch(() => {});
      });
    });
    socket.write(`${JSON.stringify({ type: "start", token: ownership.token, shell, cwd, cols, rows, env })}\n`);
    let timeout;
    await Promise.race([ready, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error("PTY broker launch timed out")), START_TIMEOUT_MS);
    })]).finally(() => clearTimeout(timeout));
    if (process.platform === "win32") {
      const result = await subprocesses.run(AGENT_SUPERVISOR, ["--identity", String(child.pid)],
        { encoding: "utf8", timeout: 1500, maxBuffer: 4096 });
      if (!/^\d+$/.test(result.stdout.trim())) throw new Error("Windows PTY supervisor identity is unavailable");
      windowsProcessIdentity = result.stdout.trim();
      adapter.processIdentity = windowsProcessIdentity;
    }
    return adapter;
  } catch (error) {
    try { await adapter.terminate(); }
    catch { error.terminationUnknown = true; }
    if (error.terminationUnknown) error.terminalTeardown = adapter;
    if (!error.terminationUnknown) try { cleanupTerminalSocket(id); } catch {}
    throw error;
  }
}

// Only a fully launched PTY has a recoverable native owner. A request that
// crashed before launch acknowledgment stays unknown for operator inspection.
export async function recoverManagedTerminal({ target, created, ownershipLabel, launchDirectory, pid, processIdentity,
  subprocesses = utilityProcesses }) {
  if (created !== 1 || typeof target !== "string" || !/^[0-9a-f-]{36}$/i.test(target)
    || ownershipLabel !== `com.21n.outright.terminal.${target}`) return false;
  if (process.platform === "darwin") {
    const label = `com.21n.outright.terminal.${target}`;
    const probe = async () => {
      try { return (await subprocesses.run(AGENT_SUPERVISOR, ["--probe", label],
        { encoding: "utf8", timeout: 1500, maxBuffer: 4096 })).stdout.trim(); }
      catch (error) { return error.stdout?.trim() ?? "unknown"; }
    };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      let status = await probe();
      if (status === "absent") return true;
      if (status === "alive" || status === "exited") {
        try { await subprocesses.run(AGENT_SUPERVISOR, ["--terminate", label],
          { encoding: "utf8", timeout: 5000, maxBuffer: 4096 }); }
        catch { /* The owner may be finishing concurrently; probe again. */ }
        status = await probe();
        if (status === "absent") return true;
      }
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 75));
    }
    return false;
  }
  if (process.platform === "linux") {
    const handshakePath = path.join(launchDirectory, `terminal-${target}.json`);
    if (!existsSync(handshakePath)) return true;
    let handshake;
    try { handshake = JSON.parse(readFileSync(handshakePath, "utf8")); } catch { return false; }
    const pid = Number(handshake.pid);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !handshake.processIdentity
      || linuxProcessIdentity(pid) !== handshake.processIdentity) return false;
    try { await subprocesses.run(AGENT_SUPERVISOR, ["--terminate-owned", String(pid), handshake.processIdentity, handshakePath],
      { encoding: "utf8", timeout: 1500, maxBuffer: 4096 }); }
    catch { return false; }
    for (let retry = 0; retry < 100; retry += 1) {
      if (!existsSync(handshakePath)) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return !existsSync(handshakePath);
  }
  if (process.platform === "win32" && Number.isSafeInteger(pid) && pid > 0
    && typeof processIdentity === "string" && /^\d+$/.test(processIdentity)) {
    const status = async () => {
      try { return (await subprocesses.run(AGENT_SUPERVISOR, ["--probe", String(pid), processIdentity],
        { encoding: "utf8", timeout: 1500, maxBuffer: 4096 })).stdout.trim(); }
      catch (error) { return error.stdout?.trim() ?? "unknown"; }
    };
    let state = await status();
    if (state === "alive") {
      try { await subprocesses.run(AGENT_SUPERVISOR, ["--terminate", String(pid), processIdentity],
        { encoding: "utf8", timeout: 5000, maxBuffer: 4096 }); }
      catch { return false; }
      state = await status();
    }
    return state === "absent";
  }
  // A request without an acknowledged native owner remains unknown.
  return false;
}

function linuxProcessIdentity(pid) {
  try {
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const startTicks = close >= 0 ? stat.slice(close + 2).split(" ")[19] : "";
    return boot && startTicks ? `linux:${boot}:${startTicks}` : null;
  } catch { return null; }
}
