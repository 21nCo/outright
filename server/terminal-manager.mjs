import { randomUUID } from "node:crypto";
import { utilityProcesses } from "./subprocess-budget.mjs";
import { cleanupTerminalSocket, recoverManagedTerminal, spawnManagedTerminal, terminalOwnership } from "./managed-terminal.mjs";

export function createTerminalManager({ publish, database, spawnTerminal = null, startManagedTerminal = spawnManagedTerminal,
  recoverTerminal = recoverManagedTerminal,
  subprocesses = utilityProcesses, terminate = (terminal, options) => {
  if (typeof terminal.process?.terminate !== "function") throw new Error("PTY owner has no termination verifier");
  return terminal.process.terminate(options);
}, maxTerminals = 12, maxTerminalsPerCwd = 4, exitedRetentionMs = 15 * 60 * 1000, maxBufferChars = 150_000 }) {
  if (!Number.isSafeInteger(maxTerminals) || maxTerminals < 1 || maxTerminals > 256
    || !Number.isSafeInteger(maxTerminalsPerCwd) || maxTerminalsPerCwd < 1 || maxTerminalsPerCwd > 256) {
    throw new RangeError("Terminal process limits must be whole numbers from 1 to 256");
  }
  const terminals = new Map();
  let reservedUnknown = database.terminalUnknownReservations?.() ?? [];
  let reconciliationPromise;

  function assertCapacity(cwd) {
    pruneExitedForCapacity(cwd);
    if (terminals.size + reservedUnknown.length >= maxTerminals) throw terminalError(429, `At most ${maxTerminals} terminals can run at once`);
    if ([...terminals.values()].filter((terminal) => terminal.cwd === cwd).length + reservedUnknown.filter((terminal) => terminal.cwd === cwd).length >= maxTerminalsPerCwd) throw terminalError(429, `At most ${maxTerminalsPerCwd} terminals can run for one worktree`);
  }

  function reconcileUnknown() {
    if (reconciliationPromise) return reconciliationPromise;
    reconciliationPromise = (async () => {
      let resolved = 0;
      for (const entry of reservedUnknown) {
        try {
          const empty = await recoverTerminal({ ...entry, launchDirectory: database.launchDirectory, subprocesses });
          if (!empty) continue;
          cleanupTerminalSocket(entry.target);
          database.resolveTerminalUnknown(entry.target, `Native ${process.platform} owner was verified empty after restart`);
          resolved += 1;
        } catch { /* A refused helper or unavailable audit keeps capacity unknown. */ }
      }
      if (resolved) {
        reservedUnknown = database.terminalUnknownReservations();
        publish({ type: "capacity.changed" });
      }
      return resolved;
    })().finally(() => { reconciliationPromise = null; });
    return reconciliationPromise;
  }

  function create(input) {
    if (!spawnTerminal) return createManagedEntry(input);
    return createInjected(input);
  }

  async function createManagedEntry(input) {
    if (reservedUnknown.length && (terminals.size + reservedUnknown.length >= maxTerminals
      || [...terminals.values()].filter((terminal) => terminal.cwd === input.cwd).length
        + reservedUnknown.filter((entry) => entry.cwd === input.cwd).length >= maxTerminalsPerCwd)) {
      await reconcileUnknown();
    }
    assertCapacity(input.cwd);
    const { cwd, name, cols = 100, rows = 30 } = input;
    const id = randomUUID();
    const shell = process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "/bin/sh");
    const evidence = { target: id, cwd, shell, operationId: randomUUID() };
    return createManaged({ id, cwd, name, cols, rows, shell, evidence });
  }

  function createInjected({ cwd, name, cols = 100, rows = 30 }) {
    assertCapacity(cwd);
    const id = randomUUID();
    const shell = process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "/bin/sh");
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
    const terminal = { id, cwd, name: name || "Terminal", pid: processInstance.pid, process: processInstance, buffer: "", outputCursor: 0, createdAt: new Date().toISOString(), status: "running", exitSeen: false };
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
      if (!terminal.closePromise) startNaturalExit(terminal);
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

  async function createManaged({ id, cwd, name, cols, rows, shell, evidence }) {
    if (!database.launchDirectory) throw new Error("Managed PTYs require a private launch directory");
    const env = { ...terminalEnvironment(process.env), TERM: "xterm-256color", COLORTERM: "truecolor" };
    if (Buffer.byteLength(JSON.stringify(env)) > 96 * 1024) {
      throw terminalError(413, "Terminal environment exceeds 96 KiB");
    }
    const ownership = terminalOwnership(id, database.launchDirectory);
    database.auditAdmission("terminal.create.requested", { ...evidence, ownershipLabel: ownership.label,
      handshakePath: ownership.handshakePath });
    const terminal = { id, cwd, name: name || "Terminal", pid: null, process: null,
      buffer: "", outputCursor: 0, createdAt: new Date().toISOString(), status: "launching", exitSeen: false,
      recorded: false };
    terminals.set(id, terminal);
    try {
      terminal.ready = startManagedTerminal({ id, ownership, shell, cwd, cols: clamp(cols, 20, 400),
        rows: clamp(rows, 5, 200), env, subprocesses });
      const processInstance = await terminal.ready;
      terminal.process = processInstance;
      terminal.pid = processInstance.pid;
      processInstance.onData((data) => {
        if (!terminals.has(id)) return;
        terminal.buffer = `${terminal.buffer}${data}`.slice(-maxBufferChars);
        terminal.outputCursor += 1;
        publish({ type: "terminal.output", terminalId: id, payload: { data: data.slice(-64 * 1024), cursor: terminal.outputCursor } });
      });
      processInstance.onExit(({ exitCode, signal, verified }) => {
        if (!terminals.has(id)) return;
        if (!verified) {
          terminal.status = "unknown";
          publish({ type: "terminal.audit-failed", terminalId: id, payload: { error: "PTY ownership could not be verified empty" } });
          return;
        }
        terminal.exitSeen = true;
        terminal.exitCode = exitCode;
        terminal.signal = signal;
        if (terminal.recorded && !terminal.closePromise && terminal.status !== "closing") startNaturalExit(terminal);
      });
      database.auditCritical("terminal.created", { ...evidence, pid: terminal.pid,
        processIdentity: processInstance.processIdentity,
        ownershipLabel: ownership.label, handshakePath: ownership.handshakePath });
      terminal.recorded = true;
      if (terminal.status === "unknown") throw new Error("PTY ownership could not be verified after launch");
      if (terminal.status === "launching") terminal.status = "running";
      if (terminal.exitSeen && !terminal.closePromise && terminal.status !== "closing") startNaturalExit(terminal);
      return publicTerminal(terminal);
    } catch (error) {
      terminal.status = "closing";
      if (error.terminalTeardown) {
        terminal.process = error.terminalTeardown;
        terminal.pid = terminal.process.pid;
      }
      if (error.terminationUnknown) {
        terminal.status = "unknown";
        throw outcomeUnknown(error, evidence.operationId);
      }
      if (terminal.process) {
        try { await terminal.process.terminate(); } catch { terminal.status = "unknown"; throw outcomeUnknown(error, evidence.operationId); }
      }
      try { database.auditCritical("terminal.create.failed", { ...evidence, error: String(error.message ?? error).slice(0, 1024) }); }
      catch { terminal.status = "unknown"; throw outcomeUnknown(error, evidence.operationId); }
      terminals.delete(id);
      throw error;
    }
  }

  function reservationTerminal(entry) {
    return { id: entry.target, cwd: entry.cwd, name: "Terminal recovery required", pid: entry.pid,
      status: "unknown", createdAt: null, recoveryReservation: true };
  }
  function list() { return [...terminals.values()].map(publicTerminal).concat(reservedUnknown
    .filter((entry) => !terminals.has(entry.target)).map(reservationTerminal)); }
  function capacity() { return { active: [...terminals.values()].filter((terminal) => terminal.status !== "exited").length + reservedUnknown.length,
    unknown: [...terminals.values()].filter((terminal) => terminal.status === "unknown").length + reservedUnknown.length, limit: maxTerminals }; }
  function get(id) {
    const terminal = terminals.get(id);
    if (terminal) return { ...publicTerminal(terminal), buffer: terminal.buffer, outputCursor: terminal.outputCursor };
    const reservation = reservedUnknown.find((entry) => entry.target === id);
    return reservation ? { ...reservationTerminal(reservation), buffer: "", outputCursor: 0 } : null;
  }
  function write(id, data) { const terminal = terminals.get(id); if (!terminal || terminal.status !== "running" || typeof data !== "string" || Buffer.byteLength(data) > 64 * 1024) return false; return terminal.process.write(data) !== false; }
  function resize(id, cols, rows) { const terminal = terminals.get(id); if (!terminal || terminal.status !== "running") return false; return terminal.process.resize(clamp(cols, 20, 400), clamp(rows, 5, 200)) !== false; }
  function startNaturalExit(terminal) {
    if (terminal.settlePromise) return;
    terminal.status = "settling";
    terminal.settlePromise = settleNaturalExit(terminal).finally(() => { terminal.settlePromise = null; });
  }
  async function settleNaturalExit(terminal) {
    // Native supervisors report exit only after their ownership boundary is
    // empty. Keep the slot if that proof or its required audit is unavailable.
    try {
      await terminate(terminal, { alreadyExited: true });
      if (!spawnTerminal) cleanupTerminalSocket(terminal.id);
      if (!terminals.has(terminal.id) || terminal.closePromise) return;
      await database.auditRequired("terminal.exited", { target: terminal.id, exitCode: terminal.exitCode, signal: terminal.signal });
      if (!terminals.has(terminal.id) || terminal.closePromise) return;
      terminal.status = "exited";
      publish({ type: "terminal.exit", terminalId: terminal.id, payload: { exitCode: terminal.exitCode, signal: terminal.signal } });
      terminal.cleanupTimer = setTimeout(() => terminals.delete(terminal.id), exitedRetentionMs);
      terminal.cleanupTimer.unref?.();
    } catch (error) {
      if (terminals.get(terminal.id) === terminal && !terminal.closePromise) {
        terminal.status = "unknown";
        publish({ type: "terminal.audit-failed", terminalId: terminal.id, payload: { error: error.message } });
      }
    }
  }
  function close(id) {
    const terminal = terminals.get(id);
    if (!terminal) return Promise.resolve(false);
    if (terminal.closePromise) return terminal.closePromise;
    const evidence = { target: id, cwd: terminal.cwd, operationId: randomUUID() };
    terminal.status = "closing";
    terminal.closePromise = Promise.resolve().then(async () => {
      try {
        // Admission may fail during storage maintenance. Still tear down the
        // owned process before reporting an unknown outcome to the caller.
        try { database.auditCritical("terminal.close.requested", evidence); }
        catch { /* A durable terminal.closed outcome can still settle created. */ }
        if (terminal.ready && !terminal.process) {
          terminal.process = await terminal.ready;
          terminal.pid = terminal.process.pid;
        }
        try { await terminate(terminal); }
        catch (error) { error.terminationUnknown = true; throw error; }
        if (!spawnTerminal) cleanupTerminalSocket(id);
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
        // A failed first native termination must receive one more attempt
        // during shutdown. Keep the slot and audit reservation if both fail.
        if (error.cause?.terminationUnknown && !terminal.closePromise) {
          try { await close(terminal.id); return; }
          catch { /* Preserve the first unknown outcome for the caller. */ }
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

  return { create, list, capacity, get, write, resize, close, shutdown, reconcileUnknown };
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
