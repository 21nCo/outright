import * as pty from "node-pty";
import { randomUUID } from "node:crypto";
import { utilityProcesses } from "./subprocess-budget.mjs";

export function createTerminalManager({ publish, database, spawnTerminal = pty.spawn, subprocesses = utilityProcesses, terminate = (terminal, options) => terminatePty(terminal, options, subprocesses), maxTerminals = 12, maxTerminalsPerCwd = 4, exitedRetentionMs = 15 * 60 * 1000, maxBufferChars = 150_000 }) {
  const terminals = new Map();
  const reservedUnknown = database.terminalUnknownReservations?.() ?? [];

  function create({ cwd, name, cols = 100, rows = 30 }) {
    pruneExitedForCapacity(cwd);
    if (terminals.size + reservedUnknown.length >= maxTerminals) throw terminalError(429, `At most ${maxTerminals} terminals can run at once`);
    if ([...terminals.values()].filter((terminal) => terminal.cwd === cwd).length + reservedUnknown.filter((terminal) => terminal.cwd === cwd).length >= maxTerminalsPerCwd) throw terminalError(429, `At most ${maxTerminalsPerCwd} terminals can run for one worktree`);
    const id = randomUUID();
    const shell = process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "/bin/zsh");
    const evidence = { target: id, cwd, shell, operationId: randomUUID() };
    database.auditAdmission("terminal.create.requested", evidence);
    let processInstance;
    try {
      processInstance = spawnTerminal(shell, [], {
        name: "xterm-256color",
        cols: clamp(cols, 20, 400),
        rows: clamp(rows, 5, 200),
        cwd,
        env: { ...terminalEnvironment(process.env), TERM: "xterm-256color", COLORTERM: "truecolor" },
      });
    } catch (error) {
      try { database.auditCritical("terminal.create.failed", { ...evidence, error: String(error.message ?? error).slice(0, 1024) }); }
      catch (auditError) { throw outcomeUnknown(auditError, evidence.operationId); }
      throw error;
    }
    const terminal = { id, cwd, name: name || "Terminal", pid: processInstance.pid, process: processInstance, buffer: "", outputCursor: 0, createdAt: new Date().toISOString(), status: "running", exitSeen: false,
      ownsGroup: process.platform !== "win32" ? ownsProcessGroup(processInstance.pid, subprocesses) : Promise.resolve(false) };
    terminals.set(id, terminal);
    processInstance.onData((data) => {
      if (!terminals.has(id)) return;
      terminal.buffer = `${terminal.buffer}${data}`.slice(-maxBufferChars);
      terminal.outputCursor += 1;
      publish({ type: "terminal.output", terminalId: id, payload: { data: data.slice(-64 * 1024), cursor: terminal.outputCursor } });
    });
    processInstance.onExit(({ exitCode, signal }) => {
      if (!terminals.has(id)) return;
      terminal.exitSeen = true;
      terminal.exitCode = exitCode;
      terminal.signal = signal;
      if (!terminal.closePromise) void settleNaturalExit(terminal);
    });
    try { database.auditCritical("terminal.created", { ...evidence, pid: terminal.pid }); }
    catch (error) {
      terminal.status = "closing";
      terminal.closePromise = Promise.resolve().then(async () => {
        try {
          await terminate(terminal);
          try { database.auditCritical("terminal.create.failed", { ...evidence, reason: "created outcome could not be recorded; PTY termination verified" }); }
          catch { /* The request remains for lease-owned reconciliation. */ }
          terminals.delete(id);
        } catch { terminal.status = "unknown"; terminal.closePromise = null; }
      });
      throw outcomeUnknown(error, evidence.operationId);
    }
    return publicTerminal(terminal);
  }

  function list() { return [...terminals.values()].map(publicTerminal); }
  function capacity() { return { active: [...terminals.values()].filter((terminal) => terminal.status !== "exited").length + reservedUnknown.length,
    unknown: [...terminals.values()].filter((terminal) => terminal.status === "unknown").length + reservedUnknown.length, limit: maxTerminals }; }
  function get(id) { const terminal = terminals.get(id); return terminal ? { ...publicTerminal(terminal), buffer: terminal.buffer, outputCursor: terminal.outputCursor } : null; }
  function write(id, data) { const terminal = terminals.get(id); if (!terminal || terminal.status !== "running" || typeof data !== "string" || Buffer.byteLength(data) > 64 * 1024) return false; terminal.process.write(data); return true; }
  function resize(id, cols, rows) { const terminal = terminals.get(id); if (!terminal || terminal.status !== "running") return false; terminal.process.resize(clamp(cols, 20, 400), clamp(rows, 5, 200)); return true; }
  async function settleNaturalExit(terminal) {
    // A PTY leader may exit while a shell child remains in its process group.
    // Keep the slot until the group has been reaped or forcefully stopped.
    try {
      await terminate(terminal, { alreadyExited: true });
      if (!terminals.has(terminal.id) || terminal.closePromise) return;
      terminal.status = "exited";
      publish({ type: "terminal.exit", terminalId: terminal.id, payload: { exitCode: terminal.exitCode, signal: terminal.signal } });
      await database.auditRequired("terminal.exited", { target: terminal.id, exitCode: terminal.exitCode, signal: terminal.signal });
      terminal.cleanupTimer = setTimeout(() => terminals.delete(terminal.id), exitedRetentionMs);
      terminal.cleanupTimer.unref?.();
    } catch (error) {
      terminal.status = "unknown";
      publish({ type: "terminal.audit-failed", terminalId: terminal.id, payload: { error: error.message } });
    }
  }
  function close(id) {
    const terminal = terminals.get(id);
    if (!terminal) return Promise.resolve(false);
    if (terminal.closePromise) return terminal.closePromise;
    const evidence = { target: id, cwd: terminal.cwd, operationId: randomUUID() };
    database.auditCritical("terminal.close.requested", evidence);
    terminal.status = "closing";
    terminal.closePromise = Promise.resolve().then(async () => {
      try {
        await terminate(terminal);
        await database.auditRequired("terminal.closed", evidence);
        clearTimeout(terminal.cleanupTimer);
        terminals.delete(id);
        return true;
      } catch (error) {
        terminal.status = "unknown";
        try { database.auditCritical("terminal.close.unknown", { ...evidence, error: String(error.message ?? error).slice(0, 1024) }); }
        catch { /* The request remains pending for lease-owned reconciliation. */ }
        terminal.closePromise = null;
        throw outcomeUnknown(error, evidence.operationId);
      }
    });
    return terminal.closePromise;
  }
  // Reap every PTY even when storage is unavailable during archive maintenance.
  // A failed audit leaves terminal.created pending for lease-owned recovery.
  async function shutdown() {
    const results = await Promise.allSettled([...terminals.values()].map((terminal) => Promise.resolve().then(async () => {
      try { await close(terminal.id); }
      catch (error) {
        // Shutdown must still terminate a PTY if audit admission failed.
        if (!terminal.closePromise && terminal.status === "running") {
          try { await terminate(terminal); } catch { /* Preserve the original error and unknown outcome. */ }
        }
        throw error;
      }
    })));
    const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, "Terminal shutdown could not record every outcome");
  }

  function pruneExitedForCapacity(cwd) {
    while (terminals.size + reservedUnknown.length >= maxTerminals) {
      const exited = [...terminals.values()].find((terminal) => terminal.status === "exited");
      if (!exited) break;
      clearTimeout(exited.cleanupTimer);
      terminals.delete(exited.id);
    }
    while ([...terminals.values()].filter((terminal) => terminal.cwd === cwd).length + reservedUnknown.filter((terminal) => terminal.cwd === cwd).length >= maxTerminalsPerCwd) {
      const exited = [...terminals.values()].find((terminal) => terminal.cwd === cwd && terminal.status === "exited");
      if (!exited) break;
      clearTimeout(exited.cleanupTimer);
      terminals.delete(exited.id);
    }
  }

  return { create, list, capacity, get, write, resize, close, shutdown };
}

function publicTerminal(terminal) {
  return { id: terminal.id, cwd: terminal.cwd, name: terminal.name, pid: terminal.pid, status: terminal.status, exitCode: terminal.exitCode, createdAt: terminal.createdAt };
}
function clamp(value, minimum, maximum) { return Math.max(minimum, Math.min(maximum, Number(value) || minimum)); }
function terminalError(statusCode, message) { const error = new Error(message); error.statusCode = statusCode; return error; }
function outcomeUnknown(cause, operationId) {
  const error = terminalError(503, `Terminal outcome could not be recorded; inspect its state before retrying (operation ${operationId})`);
  error.details = { operationId, outcomeUnknown: true };
  error.cause = cause;
  return error;
}
function terminalEnvironment(environment) {
  const blocked = /^(OUTRIGHT_|VITE_|npm_|NODE_OPTIONS$)/i;
  return Object.fromEntries(Object.entries(environment).filter(([key, value]) => value != null && !blocked.test(key)));
}

async function terminatePty(terminal, { alreadyExited = false } = {}, subprocesses = utilityProcesses) {
  const pid = terminal.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("PTY process identity is unavailable");
  const ownsGroup = await terminal.ownsGroup;
  const owned = new Set([pid]);
  collectDescendants(owned, await processSnapshot(subprocesses));
  if (process.platform === "win32") {
    await killWindowsTree(pid, subprocesses);
  } else if (!alreadyExited && !terminal.exitSeen) terminal.process.kill();
  const deadline = Date.now() + 4000;
  let escalated = false;
  while (Date.now() < deadline) {
    const snapshot = process.platform === "win32" ? null : await processSnapshot(subprocesses);
    if (snapshot) collectDescendants(owned, snapshot);
    const membersAlive = snapshot
      ? [...owned].some((member) => liveProcess(snapshot.get(member)))
        || (ownsGroup && [...snapshot.values()].some((member) => member.pgid === pid && liveProcess(member)))
      : pidAlive(pid);
    if (terminal.exitSeen && !membersAlive) return;
    if (!escalated && Date.now() > deadline - 3500) {
      escalated = true;
      if (process.platform === "win32") {
        await killWindowsTree(pid, subprocesses);
      } else {
        // The foreground job may have its own process group. Kill every
        // descendant captured while the shell was still its parent.
        for (const member of [...owned].reverse()) {
          if (!liveProcess(snapshot?.get(member))) continue;
          try { process.kill(member, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
        }
        if (ownsGroup) {
          try { process.kill(-pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("PTY process tree exit could not be verified");
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

async function ownsProcessGroup(pid, subprocesses) {
  try {
    const { stdout } = await subprocesses.run("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8", timeout: 1000, maxBuffer: 4096 });
    return Number(stdout.trim()) === pid;
  } catch { return false; }
}
async function killWindowsTree(pid, subprocesses) {
  try { await subprocesses.run("taskkill", ["/PID", String(pid), "/T", "/F"], { timeout: 1500, maxBuffer: 4096 }); }
  catch (error) { if (error.code === "SUBPROCESS_CAPACITY" || pidAlive(pid)) throw error; }
}
async function processSnapshot(subprocesses) {
  if (process.platform === "win32") return null;
  const { stdout } = await subprocesses.run("ps", ["-A", "-o", "pid=,ppid=,pgid=,stat="], { encoding: "utf8", timeout: 1000, maxBuffer: 4 * 1024 * 1024 });
  const processes = new Map();
  for (const line of stdout.split("\n")) {
    const [pid, ppid, pgid, state] = line.trim().split(/\s+/);
    if (Number.isSafeInteger(Number(pid)) && Number(pid) > 0) processes.set(Number(pid), { pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), state });
  }
  return processes;
}
function collectDescendants(owned, snapshot) {
  if (!snapshot) return;
  let changed;
  do {
    changed = false;
    for (const entry of snapshot.values()) {
      if (owned.has(entry.ppid) && !owned.has(entry.pid)) { owned.add(entry.pid); changed = true; }
    }
  } while (changed);
}
function liveProcess(entry) { return entry && !entry.state?.startsWith("Z"); }
