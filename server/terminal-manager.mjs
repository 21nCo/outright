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
    const processInstance = spawnTerminal(shell, [], {
      name: "xterm-256color",
      cols: clamp(cols, 20, 400),
      rows: clamp(rows, 5, 200),
      cwd,
      env: { ...terminalEnvironment(process.env), TERM: "xterm-256color", COLORTERM: "truecolor" },
    });
    const terminal = { id, cwd, name: name || "Terminal", pid: processInstance.pid, process: processInstance, buffer: "", outputCursor: 0, createdAt: new Date().toISOString(), status: "running" };
    terminals.set(id, terminal);
    database.audit("terminal.created", { target: id, cwd, pid: terminal.pid });
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
      database.audit("terminal.exited", { target: id, exitCode, signal });
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
    clearTimeout(terminal.cleanupTimer);
    terminals.delete(id);
    if (terminal.status === "running") terminal.process.kill();
    database.audit("terminal.closed", { target: id, cwd: terminal.cwd });
    return true;
  }
  function shutdown() { for (const id of terminals.keys()) close(id); }

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
function terminalEnvironment(environment) {
  const blocked = /^(OUTRIGHT_|VITE_|npm_|NODE_OPTIONS$)/i;
  return Object.fromEntries(Object.entries(environment).filter(([key, value]) => value != null && !blocked.test(key)));
}
