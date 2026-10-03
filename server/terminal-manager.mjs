import * as pty from "node-pty";
import { randomUUID } from "node:crypto";

export function createTerminalManager({ publish, database, spawnTerminal = pty.spawn, maxTerminals = 12, maxTerminalsPerCwd = 4, exitedRetentionMs = 15 * 60 * 1000, maxBufferChars = 150_000 }) {
  const terminals = new Map();

  function create({ cwd, name, cols = 100, rows = 30 }) {
    pruneExitedForCapacity(cwd);
    if (terminals.size >= maxTerminals) throw terminalError(429, `At most ${maxTerminals} terminals can run at once`);
    if ([...terminals.values()].filter((terminal) => terminal.cwd === cwd).length >= maxTerminalsPerCwd) throw terminalError(429, `At most ${maxTerminalsPerCwd} terminals can run for one worktree`);
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
    const terminal = { id, cwd, name: name || "Terminal", pid: processInstance.pid, process: processInstance, buffer: "", outputCursor: 0, createdAt: new Date().toISOString(), status: "running" };
    try { database.auditCritical("terminal.created", { ...evidence, pid: terminal.pid }); }
    catch (error) { try { processInstance.kill(); } catch { /* Ownership is uncertain; report the operation id. */ } throw outcomeUnknown(error, evidence.operationId); }
    terminals.set(id, terminal);
    processInstance.onData((data) => {
      if (!terminals.has(id)) return;
      terminal.buffer = `${terminal.buffer}${data}`.slice(-maxBufferChars);
      terminal.outputCursor += 1;
      publish({ type: "terminal.output", terminalId: id, payload: { data: data.slice(-64 * 1024), cursor: terminal.outputCursor } });
    });
    processInstance.onExit(({ exitCode, signal }) => {
      if (!terminals.has(id)) return;
      terminal.status = "exited";
      terminal.exitCode = exitCode;
      publish({ type: "terminal.exit", terminalId: id, payload: { exitCode, signal } });
      // A process can exit without an API request. Keep its audit independent
      // of the PTY callback and retry while offline maintenance holds SQLite.
      void database.auditRequired("terminal.exited", { target: id, exitCode, signal }).catch((error) => {
        publish({ type: "terminal.audit-failed", terminalId: id, payload: { error: error.message } });
      });
      terminal.cleanupTimer = setTimeout(() => terminals.delete(id), exitedRetentionMs);
      terminal.cleanupTimer.unref?.();
    });
    return publicTerminal(terminal);
  }

  function list() { return [...terminals.values()].map(publicTerminal); }
  function get(id) { const terminal = terminals.get(id); return terminal ? { ...publicTerminal(terminal), buffer: terminal.buffer, outputCursor: terminal.outputCursor } : null; }
  function write(id, data) { const terminal = terminals.get(id); if (!terminal || terminal.status !== "running" || typeof data !== "string" || Buffer.byteLength(data) > 64 * 1024) return false; terminal.process.write(data); return true; }
  function resize(id, cols, rows) { const terminal = terminals.get(id); if (!terminal || terminal.status !== "running") return false; terminal.process.resize(clamp(cols, 20, 400), clamp(rows, 5, 200)); return true; }
  function close(id) {
    const terminal = terminals.get(id);
    if (!terminal) return false;
    const evidence = { target: id, cwd: terminal.cwd, operationId: randomUUID() };
    database.auditCritical("terminal.close.requested", evidence);
    clearTimeout(terminal.cleanupTimer);
    terminals.delete(id);
    try {
      if (terminal.status === "running") { terminal.process.kill(); terminal.killIssued = true; }
      database.auditCritical("terminal.closed", evidence);
    } catch (error) {
      throw outcomeUnknown(error, evidence.operationId);
    }
    return true;
  }
  // Reap every PTY even when storage is unavailable during archive maintenance.
  // A failed audit leaves terminal.created pending for lease-owned recovery.
  function shutdown() {
    const errors = [];
    for (const terminal of [...terminals.values()]) {
      try { close(terminal.id); }
      catch (error) {
        errors.push(error);
        clearTimeout(terminal.cleanupTimer);
        terminals.delete(terminal.id);
        if (terminal.status === "running" && !terminal.killIssued) {
          try { terminal.process.kill(); } catch (killError) { errors.push(killError); }
        }
      }
    }
    if (errors.length) throw new AggregateError(errors, "Terminal shutdown could not record every outcome");
  }

  function pruneExitedForCapacity(cwd) {
    while (terminals.size >= maxTerminals) {
      const exited = [...terminals.values()].find((terminal) => terminal.status === "exited");
      if (!exited) break;
      close(exited.id);
    }
    while ([...terminals.values()].filter((terminal) => terminal.cwd === cwd).length >= maxTerminalsPerCwd) {
      const exited = [...terminals.values()].find((terminal) => terminal.cwd === cwd && terminal.status === "exited");
      if (!exited) break;
      close(exited.id);
    }
  }

  return { create, list, get, write, resize, close, shutdown };
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
