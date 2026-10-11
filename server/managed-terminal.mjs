import { spawn } from "./child-process.mjs";
import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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

function emptyProofPath(id, launchDirectory) {
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Invalid terminal owner id");
  const directory = lstatSync(launchDirectory);
  if (!directory.isDirectory() || directory.isSymbolicLink()
    || (process.platform !== "win32" && (directory.uid !== process.getuid() || (directory.mode & 0o077) !== 0))) {
    throw new Error("Terminal proof directory is not private");
  }
  return path.join(launchDirectory, `terminal-${id}.empty`);
}

// A creation audit may fail after the native owner has been verified empty.
// Keep that proof outside the unavailable SQLite writer so a successor can
// settle the pending request without guessing from a missing created event.
export function recordTerminalEmpty(id, launchDirectory) {
  const filename = emptyProofPath(id, launchDirectory);
  let descriptor;
  try { descriptor = openSync(filename, "wx", 0o600); }
  catch (error) {
    if (error.code === "EEXIST" && hasTerminalEmpty(id, launchDirectory)) return;
    if (error.code !== "EEXIST") throw error;
    // An interrupted write may leave a partial marker. Repair only a regular
    // single-link file in the private launch directory; never follow a link
    // or replace another owner's evidence.
    const before = lstatSync(filename);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
      || (process.platform !== "win32" && (before.uid !== process.getuid() || (before.mode & 0o077) !== 0))) throw error;
    descriptor = openSync(filename, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fstatSync(descriptor);
      if (opened.ino !== before.ino || opened.dev !== before.dev) {
        throw new Error("Terminal empty proof changed during repair");
      }
    } catch (error_) {
      closeSync(descriptor);
      throw error_;
    }
  }
  try {
    ftruncateSync(descriptor, 0);
    writeFileSync(descriptor, `${id}\n`);
    fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
  if (process.platform !== "win32") {
    const directory = openSync(launchDirectory, "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
}

export function removeTerminalEmpty(id, launchDirectory) {
  const filename = emptyProofPath(id, launchDirectory);
  try { unlinkSync(filename); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

function hasTerminalEmpty(id, launchDirectory) {
  try {
    const filename = emptyProofPath(id, launchDirectory);
    const info = lstatSync(filename);
    return info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size === id.length + 1
      && (process.platform === "win32" || (info.uid === process.getuid() && (info.mode & 0o077) === 0))
      && readFileSync(filename, "utf8") === `${id}\n`;
  } catch { return false; }
}

async function probeDarwinTerminal(subprocesses, label) {
  try { return (await subprocesses.run(AGENT_SUPERVISOR, ["--probe", label],
    { encoding: "utf8", timeout: 1500, maxBuffer: 4096 })).stdout.trim(); }
  catch (error) { return error.stdout?.trim() ?? "unknown"; }
}

async function verifyDarwinTerminalEmpty(subprocesses, label) {
  const status = await probeDarwinTerminal(subprocesses, label);
  if (status === "absent") return true;
  if (status !== "exited") return false;
  try { await subprocesses.run(AGENT_SUPERVISOR, ["--terminate", label],
    { encoding: "utf8", timeout: 5000, maxBuffer: 4096 }); }
  catch { return false; }
  return await probeDarwinTerminal(subprocesses, label) === "absent";
}

async function verifyWindowsTerminalEmpty(subprocesses, childPid, processIdentity, signal, exitCode) {
  if (signal != null || !Number.isInteger(exitCode)) return false;
  if (exitCode < 70 || exitCode > 79) return true;
  // Reserved native-startup codes can also be legitimate shell exits. In that
  // case prove this exact owner has exited instead of guessing from the code.
  if (!processIdentity) return false;
  try { return (await subprocesses.run(AGENT_SUPERVISOR,
    ["--probe", String(childPid), processIdentity],
    { encoding: "utf8", timeout: 1500, maxBuffer: 4096 })).stdout.trim() === "absent"; }
  catch (error) { return error.stdout?.trim() === "absent"; }
}

async function connectBroker(address, isClosed, failureDetails) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline && !isClosed()) {
    try {
      return await new Promise((resolve, reject) => { // NOSONAR S9382: connect retries until the broker start deadline
        const client = net.createConnection(address);
        client.once("connect", () => resolve(client));
        client.once("error", reject);
      });
    } catch { await new Promise((resolve) => setTimeout(resolve, 25)); } // NOSONAR S9382: backoff between broker connect retries
  }
  throw new Error(`PTY broker did not start: ${failureDetails() || "native supervisor unavailable"}`);
}

function waitForBrokerReady(socket, handleMessage, onClose, wasReady) {
  return new Promise((resolve, reject) => {
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
        try { message = JSON.parse(line); }
        catch { reject(new Error("PTY broker returned malformed data")); socket.destroy(); return; }
        if (!message || typeof message !== "object" || Array.isArray(message)) {
          reject(new Error("PTY broker returned malformed data")); socket.destroy(); return;
        }
        handleMessage(message, resolve, reject);
      }
    });
    socket.on("error", reject);
    socket.on("close", () => {
      onClose();
      if (!wasReady()) reject(new Error("PTY broker closed before launch"));
    });
  });
}

function terminalSupervisorArgs(ownership) {
  const brokerArgs = [process.execPath, BROKER, ownership.address, ownership.token];
  if (process.platform === "linux") return ["--stop-on-owner-exit", ownership.handshakePath, ...brokerArgs];
  if (process.platform === "darwin") return [ownership.label, ...brokerArgs];
  return brokerArgs;
}

// A launch that failed after the native owner started must prove that owner
// empty before its durable marker and socket are settled. An unverified
// teardown keeps both, so restart recovery still has the evidence.
async function teardownFailedLaunch(error, adapter, id, ownership) {
  try {
    await adapter.terminate();
    error.terminationVerified = true;
    try { recordTerminalEmpty(id, path.dirname(ownership.handshakePath)); }
    catch (proofError) { error.emptyProofError = proofError; }
  }
  catch { error.terminationUnknown = true; }
  error.terminalTeardown = adapter;
  if (!error.terminationUnknown) try { cleanupTerminalSocket(id); } catch {}
  return error;
}

export async function spawnManagedTerminal({ id, ownership, shell, cwd, cols, rows, env,
  subprocesses = utilityProcesses }) {
  const child = spawn(AGENT_SUPERVISOR, terminalSupervisorArgs(ownership), { cwd, env: { ...env,
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
  let shellResult;
  let settleFrame;
  let settleSocket;
  const frameSettled = new Promise((resolve) => { settleFrame = resolve; });
  const socketSettled = new Promise((resolve) => { settleSocket = resolve; });
  let windowsProcessIdentity;
  const verifyEmpty = (signal, exitCode) => {
    if (process.platform === "linux") return Promise.resolve(!existsSync(ownership.handshakePath));
    if (process.platform === "darwin") return verifyDarwinTerminalEmpty(subprocesses, ownership.label);
    if (process.platform === "win32") return verifyWindowsTerminalEmpty(subprocesses, child.pid,
      windowsProcessIdentity, signal, exitCode);
    return Promise.resolve(false);
  };
  const closeResult = new Promise((resolve) => {
    child.on("error", (error) => { stderr = `${stderr}${error.message}`.slice(-2048); });
    child.on("close", async (exitCode, signal) => {
      closed = true;
      // The native owner can close just before Node delivers the final socket
      // frame. Give the independently bounded frame/close event its turn
      // before deciding that the outcome is unknown.
      if (socket && !socket.destroyed && !shellResult) {
        let timeout;
        await Promise.race([frameSettled, socketSettled, new Promise((resolve) => {
          timeout = setTimeout(resolve, 1000);
        })]).finally(() => clearTimeout(timeout));
      }
      socket?.destroy();
      verified = await verifyEmpty(signal, exitCode);
      const expectedCode = shellResult?.signal > 0 ? 128 + shellResult.signal : shellResult?.exitCode;
      const processCode = process.platform === "win32" ? expectedCode : expectedCode % 256;
      const outcomeKnown = Boolean(shellResult) && signal == null && processCode === exitCode;
      finalResult = { exitCode: outcomeKnown ? shellResult.exitCode : exitCode,
        signal: outcomeKnown ? shellResult.signal : signal, verified, outcomeKnown };
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
  const handleBrokerMessage = (message, resolve, reject) => {
    if (message.type === "ready") { readySeen = true; resolve(); return; }
    if (message.type === "error") { reject(new Error(message.message)); return; }
    if (message.type === "shell-exited") {
      if (shellExited || !Number.isSafeInteger(message.exitCode) || message.exitCode < 0
        || !Number.isSafeInteger(message.signal) || message.signal < 0) {
        socket.destroy();
        return;
      }
      shellExited = true;
      shellResult = { exitCode: message.exitCode, signal: message.signal };
      settleFrame();
      return;
    }
    if (message.type === "data" && typeof message.data === "string") {
      if (onData) onData(message.data);
      else earlyData = `${earlyData}${message.data}`.slice(-150_000);
    }
  };
  try {
    if (process.platform === "linux") child.stdin.write("go\n");
    else if (process.platform === "darwin") child.stdio[3].end("go\n");
    socket = await connectBroker(ownership.address, () => closed, () => stderr);
    const ready = waitForBrokerReady(socket, handleBrokerMessage, () => {
      settleSocket();
      if (readySeen && !shellExited && !closed) void adapter.terminate().catch(() => {});
    }, () => readySeen);
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
    throw await teardownFailedLaunch(error, adapter, id, ownership);
  }
}

async function recoverDarwinTerminal(label, subprocesses) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const status = await probeDarwinTerminal(subprocesses, label);
    if (status === "absent") return true;
    if (status === "alive" || status === "exited") {
      try { await subprocesses.run(AGENT_SUPERVISOR, ["--terminate", label],
        { encoding: "utf8", timeout: 5000, maxBuffer: 4096 }); }
      catch { /* The owner may be finishing concurrently; probe again. */ }
      if (await probeDarwinTerminal(subprocesses, label) === "absent") return true;
    }
    if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 75)); // NOSONAR S9382: bounded retries wait between native probes
  }
  return false;
}

async function recoverLinuxTerminal(target, launchDirectory, subprocesses) {
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
    await new Promise((resolve) => setTimeout(resolve, 50)); // NOSONAR S9382: polls handshake removal within bounded retries
  }
  return !existsSync(handshakePath);
}

async function recoverWindowsTerminal(pid, processIdentity, subprocesses) {
  if (!Number.isSafeInteger(pid) || pid <= 0
    || typeof processIdentity !== "string" || !/^\d+$/.test(processIdentity)) return false;
  const args = [String(pid), processIdentity];
  const probe = async () => {
    try { return (await subprocesses.run(AGENT_SUPERVISOR, ["--probe", ...args],
      { encoding: "utf8", timeout: 1500, maxBuffer: 4096 })).stdout.trim(); }
    catch (error) { return error.stdout?.trim() ?? "unknown"; }
  };
  let state = await probe();
  if (state === "alive") {
    try { await subprocesses.run(AGENT_SUPERVISOR, ["--terminate", ...args],
      { encoding: "utf8", timeout: 5000, maxBuffer: 4096 }); }
    catch { return false; }
    state = await probe();
  }
  return state === "absent";
}

// Only a fully launched PTY has a recoverable native owner. A request that
// crashed before launch acknowledgment stays unknown for operator inspection.
export async function recoverManagedTerminal({ target, created, ownershipLabel, launchDirectory, pid, processIdentity,
  subprocesses = utilityProcesses }) {
  if (typeof target !== "string" || !/^[0-9a-f-]{36}$/i.test(target)
    || ownershipLabel !== `com.21n.outright.terminal.${target}`) return false;
  if (hasTerminalEmpty(target, launchDirectory)) return true;
  if (created !== 1) return false;
  if (process.platform === "darwin") return recoverDarwinTerminal(ownershipLabel, subprocesses);
  if (process.platform === "linux") return recoverLinuxTerminal(target, launchDirectory, subprocesses);
  if (process.platform === "win32") return recoverWindowsTerminal(pid, processIdentity, subprocesses);
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
