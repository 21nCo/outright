import { randomUUID } from "node:crypto";
import { lstatSync, opendirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { utilityProcesses } from "./subprocess-budget.mjs";
import { cleanupTerminalSocket, reattachManagedTerminal, reattachToken, readReattachRecord, recoverManagedTerminal, removeReattachRecord,
  removeTerminalEmpty, recordTerminalEmpty, spawnManagedTerminal, terminalOwnership, writeReattachRecord } from "./managed-terminal.mjs";
import { openTerminalHistory } from "./terminal-history.mjs";

const TERMINAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OWNER_FILE = /^terminal-([0-9a-f-]{36})\.(?:empty|reattach(?:\.[0-9a-f]{16}\.tmp)?)$/;

function reservationTerminal(entry) {
  return { id: entry.target, cwd: entry.cwd, name: "Terminal recovery required", pid: entry.pid,
    status: "unknown", createdAt: null, recoveryReservation: true };
}

export function createTerminalManager({ publish, database, spawnTerminal = null, startManagedTerminal = spawnManagedTerminal,
  recoverTerminal = recoverManagedTerminal, cleanupSocket = cleanupTerminalSocket,
  reattachTerminal = reattachManagedTerminal, reattachEnabled = () => false, detachWindowMs = 10 * 60 * 1000, runtimeInstanceId = null,
  subprocesses = utilityProcesses, terminate = (terminal, options) => {
  if (typeof terminal.process?.terminate !== "function") throw new Error("PTY owner has no termination verifier");
  return terminal.process.terminate(options);
}, maxTerminals = 12, maxTerminalsPerCwd = 4, exitedRetentionMs = 15 * 60 * 1000, maxBufferChars = 150_000,
  history = defaultHistory(database, (status) => publish({ type: "terminal.history", payload: status })) }) {
  if (!Number.isSafeInteger(maxTerminals) || maxTerminals < 1 || maxTerminals > 256
    || !Number.isSafeInteger(maxTerminalsPerCwd) || maxTerminalsPerCwd < 1 || maxTerminalsPerCwd > 256) {
    throw new RangeError("Terminal process limits must be whole numbers from 1 to 256");
  }
  if (!Number.isSafeInteger(detachWindowMs) || detachWindowMs < 50 || detachWindowMs > 10 * 60 * 1000) {
    throw new RangeError("Terminal detach window must be 50 ms to 10 minutes");
  }
  const terminals = new Map();
  const unresolvedReservations = () => (database.terminalUnknownReservations?.() ?? [])
    .filter((entry) => !terminals.has(entry.target));
  let reservedUnknown = unresolvedReservations();
  const verifiedCreateFailures = new Map();
  let reconciliationPromise;
  // One coalesced signal covers every saved-session transition: restore from
  // a reservation, quota eviction, retention expiry and removal. Clients
  // re-list on it, so a dropped or merged event cannot strand their state.
  let changePending = false;
  function terminalsChanged() {
    if (changePending) return;
    changePending = true;
    queueMicrotask(() => { changePending = false; publish({ type: "terminals.changed" }); });
  }
  // Leaving the map changes the listing: the terminal is gone, or its saved
  // history now lists as an ended session. No history record changes then.
  function forget(terminal) {
    clearTimeout(terminal.cleanupTimer);
    terminals.delete(terminal.id);
    terminalsChanged();
  }
  history?.subscribe?.(terminalsChanged);
  let shuttingDown = false;
  let sweepingProofs = false;
  // Old audit records may lack a worktree path. Charge their unknown owner
  // against every worktree until native proof or operator recovery clears it.
  const reservedForCwd = (cwd) => reservedUnknown.filter((entry) => !entry.cwd || entry.cwd === cwd).length;

  function sweepStaleEmptyProofs() {
    if (sweepingProofs || shuttingDown || database.terminalAuditScanPending
      || reservedUnknown.length > 256 || !database.launchDirectory) return;
    let directory;
    try {
      const info = lstatSync(database.launchDirectory);
      if (!info.isDirectory() || info.isSymbolicLink()
        || (process.platform !== "win32" && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0))) return;
      directory = opendirSync(database.launchDirectory);
    } catch { return; }
    sweepingProofs = true;
    const step = () => {
      let more = false;
      try {
        let entry;
        for (let examined = 0; examined < 64 && !shuttingDown; examined += 1) {
          entry = directory.readSync();
          if (!entry) break;
          const match = OWNER_FILE.exec(entry.name);
          if (!match || terminals.has(match[1]) || reservedUnknown.some((owner) => owner.target === match[1])) continue;
          try { unlinkSync(path.join(database.launchDirectory, entry.name)); } catch { /* A later sweep can retry. */ }
        }
        more = Boolean(entry && !shuttingDown);
      } catch { /* Keep any unexamined marker for a later bounded sweep. */ }
      if (more) { setImmediate(step); return; }
      try { directory.closeSync(); } catch {}
      sweepingProofs = false;
    };
    setImmediate(step);
  }

  function assertCapacity(cwd) {
    if (database.terminalAuditScanPending) throw terminalError(503,
      database.terminalAuditScanError
        ? "Terminal ownership recovery stopped; restart Outright after checking storage"
        : "Terminal ownership recovery is scanning retained audit history; retry shortly");
    pruneExitedForCapacity(cwd);
    if (terminals.size + reservedUnknown.length >= maxTerminals) throw terminalError(429, `At most ${maxTerminals} terminals can run at once`);
    if ([...terminals.values()].filter((terminal) => terminal.cwd === cwd).length + reservedForCwd(cwd) >= maxTerminalsPerCwd) throw terminalError(429, `At most ${maxTerminalsPerCwd} terminals can run for one worktree`);
  }

  async function reconcileReservedTerminal(entry) {
    const verified = verifiedCreateFailures.get(entry.target);
    if (verified) {
      recordTerminalEmpty(entry.target, database.launchDirectory);
      cleanupSocket(entry.target);
      database.auditCritical("terminal.create.failed", verified);
      verifiedCreateFailures.delete(entry.target);
    } else {
      // With reattach off, recovery runs exactly as before, with no added turn.
      if (reattachable(entry)) {
        if (await joinReattach(entry)) return true;
        // Shutdown leaves this owner, untouched, to the next runtime's recovery.
        if (shuttingDown) return false;
      }
      const empty = await recoverTerminal({ ...entry, launchDirectory: database.launchDirectory, subprocesses });
      if (!empty || shuttingDown) return false;
      // Socket removal belongs to the same proof as native emptiness.
      // A failed unlink must leave the durable reservation charged.
      cleanupSocket(entry.target);
      database.resolveTerminalUnknown(entry.target, `Native ${process.platform} owner was verified empty after restart`);
      forgetReattach(entry.target);
    }
    try { removeTerminalEmpty(entry.target, database.launchDirectory); }
    catch { /* The verified owner remains absent; retry cleanup later. */ }
    reservedUnknown = unresolvedReservations();
    terminalsChanged();
    return true;
  }

  function forgetReattach(id) {
    if (!database.launchDirectory) return;
    try { removeReattachRecord(id, database.launchDirectory); } catch { /* The stale-proof sweep retries it. */ }
  }

  // A prior-run shell that its broker kept through the detach window becomes
  // live again only when the broker and this runtime prove the stored token
  // to each other for its identity and the reattach is recorded. Otherwise
  // the caller proves the owner empty, so the session ends as after any
  // restart.
  function reattachable(entry) {
    return reattachEnabled() && entry.created === 1 && Boolean(database.launchDirectory) && !terminals.has(entry.target)
      && entry.ownershipLabel === `com.21n.outright.terminal.${entry.target}` && typeof entry.cwd === "string";
  }
  // Shutdown joins every attempt in flight, so none acts after the lease ends.
  const pendingReattaches = new Set();
  function joinReattach(entry) {
    const attempt = reattachReserved(entry);
    pendingReattaches.add(attempt);
    return attempt.finally(() => pendingReattaches.delete(attempt));
  }
  async function reattachReserved(entry) {
    const id = entry.target;
    if (shuttingDown) return false;
    const record = readReattachRecord(id, database.launchDirectory);
    if (!record) return false;
    const nextToken = reattachToken();
    const processInstance = await reattachTerminal({ id, identity: record.identity, token: record.token, nextToken,
      verifyEmpty: () => recoverTerminal({ ...entry, launchDirectory: database.launchDirectory, subprocesses }) });
    // A refused token is never offered again.
    if (!processInstance) { forgetReattach(id); return false; }
    try { writeReattachRecord(id, database.launchDirectory, { identity: record.identity, token: nextToken }); }
    catch { forgetReattach(id); }
    if (shuttingDown) {
      // The broker detaches again and keeps the shell for its window. Ending
      // it now would take a shell the next runtime can reattach.
      processInstance.release?.();
      return false;
    }
    try {
      database.auditCritical("terminal.reattached", { target: id, cwd: entry.cwd, ownershipLabel: entry.ownershipLabel });
    } catch {
      // An unrecorded reattach is not offered as live. Ending it here lets
      // native proof settle the reservation as for any other prior-run shell.
      try { await processInstance.terminate(); } catch { /* Native proof decides below. */ }
      forgetReattach(id);
      return false;
    }
    const saved = history?.saved().find((item) => item.id === id);
    const terminal = { id, cwd: entry.cwd, name: saved?.name ?? "Terminal", pid: entry.pid ?? processInstance.pid,
      process: processInstance, buffer: (history?.read(id) ?? "").slice(-maxBufferChars), outputCursor: 0,
      createdAt: saved?.createdAt ?? new Date().toISOString(), status: "running", exitSeen: false, recorded: true, reattached: true,
      relaunchedFrom: saved?.relaunchedFrom };
    terminals.set(id, terminal);
    // The saved session is writable again before the broker's buffered
    // output can arrive, so that output reaches history once, after it.
    if (!history?.resume(id)) beginHistory(terminal);
    observeManaged(terminal, processInstance);
    reservedUnknown = unresolvedReservations();
    // A page that connected while this was a reservation learns here that
    // this runtime holds it as the verified live process.
    publish({ type: "terminal.reattached", terminalId: id, payload: { ...publicTerminal(terminal), runtimeInstanceId } });
    terminalsChanged();
    return true;
  }

  function reconcileUnknown() {
    if (shuttingDown || database.terminalAuditScanPending) return Promise.resolve(0);
    if (reconciliationPromise) return reconciliationPromise;
    reconciliationPromise = (async () => {
      let resolved = 0;
      const entries = [...reservedUnknown];
      let next = 0;
      // Native proof can take seconds. Limit simultaneous helpers while letting
      // independent owners progress without serializing the entire inventory.
      await Promise.all(Array.from({ length: Math.min(4, entries.length) }, async () => {
        while (next < entries.length) {
          if (shuttingDown) break;
          const entry = entries[next++];
          try {
            if (!await reconcileReservedTerminal(entry)) continue; // NOSONAR S9382: one worker of a bounded reconciliation pool
            resolved += 1;
            publish({ type: "capacity.changed" });
          } catch { /* A refused helper or unavailable audit keeps capacity unknown. */ }
        }
      }));
      return resolved;
    })().finally(() => { reconciliationPromise = null; });
    return reconciliationPromise;
  }

  function reloadUnknownReservations() {
    if (database.terminalAuditScanPending) return;
    reservedUnknown = unresolvedReservations();
    sweepStaleEmptyProofs();
    publish({ type: "capacity.changed" });
    terminalsChanged();
  }

  function create(input) {
    if (!spawnTerminal) return createManagedEntry(input);
    return createInjected(input);
  }

  async function createManagedEntry(input) {
    const relaunchedFrom = relaunchSource(input.relaunchedFrom);
    if (reservedUnknown.length && (terminals.size + reservedUnknown.length >= maxTerminals
      || [...terminals.values()].filter((terminal) => terminal.cwd === input.cwd).length
        + reservedForCwd(input.cwd) >= maxTerminalsPerCwd)) {
      // Refuse promptly at capacity. The proof runs in the background and
      // publishes capacity when a subsequent request can safely be admitted.
      void reconcileUnknown().catch(() => {});
    }
    assertCapacity(input.cwd);
    const { cwd, name, cols = 100, rows = 30 } = input;
    const id = randomUUID();
    const shell = process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "/bin/sh");
    const evidence = { target: id, cwd, shell, operationId: randomUUID() };
    return createManaged({ id, cwd, name, cols, rows, shell, evidence, relaunchedFrom });
  }

  function createInjected({ cwd, name, cols = 100, rows = 30, relaunchedFrom: source }) {
    const relaunchedFrom = relaunchSource(source);
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
    const terminal = { id, cwd, name: name || "Terminal", pid: processInstance.pid, process: processInstance, buffer: "", outputCursor: 0, createdAt: new Date().toISOString(), status: "running", exitSeen: false, relaunchedFrom };
    terminals.set(id, terminal);
    processInstance.onData((data) => {
      if (!terminals.has(id)) return;
      terminal.buffer = `${terminal.buffer}${data}`.slice(-maxBufferChars);
      terminal.outputCursor += 1;
      history?.append(id, data);
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
          forget(terminal);
        } catch { terminal.status = "unknown"; terminal.closePromise = null; }
      });
      throw outcomeUnknown(error, evidence.operationId);
    }
    beginHistory(terminal);
    return publicTerminal(terminal);
  }

  async function failManagedCreate(terminal, error, evidence, ownership) {
    const id = terminal.id;
    terminal.status = "closing";
    if (error.terminalTeardown) {
      terminal.process = error.terminalTeardown;
      terminal.pid = terminal.process.pid;
    }
    if (error.terminationUnknown) {
      terminal.status = "unknown";
      throw outcomeUnknown(error, evidence.operationId);
    }
    let verifiedEmpty = Boolean(error.terminationVerified);
    if (terminal.process && !verifiedEmpty) {
      try { await terminal.process.terminate(); verifiedEmpty = true; }
      catch { terminal.status = "unknown"; throw outcomeUnknown(error, evidence.operationId); }
    }
    const failureEvidence = { ...evidence, error: String(error.message ?? error).slice(0, 1024) };
    try {
      if (!verifiedEmpty) throw new Error("PTY owner has no empty-tree proof");
      recordTerminalEmpty(id, database.launchDirectory);
      cleanupSocket(id);
      database.auditCritical("terminal.create.failed", failureEvidence);
    } catch {
      forget(terminal);
      if (verifiedEmpty) verifiedCreateFailures.set(id, failureEvidence);
      reservedUnknown = [...reservedUnknown, { ...evidence, ownershipLabel: ownership.label,
        handshakePath: ownership.handshakePath, created: 0 }];
      throw outcomeUnknown(error, evidence.operationId);
    }
    try { removeTerminalEmpty(id, database.launchDirectory); } catch { /* A stale proof is harmless for this unique id. */ }
    forgetReattach(id);
    forget(terminal);
    throw error;
  }

  async function createManaged({ id, cwd, name, cols, rows, shell, evidence, relaunchedFrom }) {
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
      recorded: false, relaunchedFrom };
    terminals.set(id, terminal);
    // With reattach on, the broker keeps the shell through a detach window
    // and accepts only this token, which stays in the private directory.
    const session = reattachEnabled() ? { label: ownership.label, token: reattachToken(), windowMs: detachWindowMs } : null;
    try {
      terminal.ready = startManagedTerminal({ id, ownership, shell, cwd, cols: clamp(cols, 20, 400),
        rows: clamp(rows, 5, 200), env, subprocesses, ...(session ? { session } : {}) });
      const processInstance = await terminal.ready;
      terminal.process = processInstance;
      terminal.pid = processInstance.pid;
      observeManaged(terminal, processInstance);
      database.auditCritical("terminal.created", { ...evidence, pid: terminal.pid,
        processIdentity: processInstance.processIdentity,
        ownershipLabel: ownership.label, handshakePath: ownership.handshakePath });
      terminal.recorded = true;
      if (terminal.status === "unknown") throw new Error("PTY ownership could not be verified after launch");
      if (terminal.status === "launching") terminal.status = "running";
      if (session && processInstance.sessionIdentity) {
        try { writeReattachRecord(id, database.launchDirectory, { identity: processInstance.sessionIdentity, token: session.token }); }
        catch { /* Without a record this shell ends with its runtime, as before. */ }
      }
      beginHistory(terminal);
      if (terminal.exitSeen && !terminal.closePromise && terminal.status !== "closing") startNaturalExit(terminal);
      return publicTerminal(terminal);
    } catch (error) { return failManagedCreate(terminal, error, evidence, ownership); }
  }

  function observeManaged(terminal, processInstance) {
    const { id } = terminal;
    processInstance.onData((data) => {
      if (!terminals.has(id)) return;
      terminal.buffer = `${terminal.buffer}${data}`.slice(-maxBufferChars);
      terminal.outputCursor += 1;
      history?.append(id, data);
      publish({ type: "terminal.output", terminalId: id, payload: { data: data.slice(-64 * 1024), cursor: terminal.outputCursor } });
    });
    processInstance.onExit(({ exitCode, signal, verified, outcomeKnown }) => {
      if (!terminals.has(id)) return;
      if (!verified || (!outcomeKnown && terminal.status !== "closing")) {
        terminal.status = "unknown";
        publish({ type: "terminal.audit-failed", terminalId: id, payload: { runtimeInstanceId, error: verified
          ? "PTY exit result could not be verified" : "PTY ownership could not be verified empty" } });
        return;
      }
      terminal.exitSeen = true;
      terminal.exitCode = exitCode;
      terminal.signal = signal;
      if (terminal.recorded && !terminal.closePromise && terminal.status !== "closing") startNaturalExit(terminal);
    });
  }

  // A saved session is read-only history. A prior-run owner that still
  // awaits native proof stays a recovery reservation, never ended or live.
  function savedSessions() {
    return (history?.saved() ?? []).filter((entry) => !terminals.has(entry.id)
      && !reservedUnknown.some((owner) => owner.target === entry.id));
  }
  // Until the audit scan rebuilds reservations, a session with no recorded
  // exit may still have a live prior-run owner. Show it as unverified.
  function listedSaved(entry) {
    if (database.terminalAuditScanPending && entry.endReason === "restart") {
      return reservationTerminal({ target: entry.id, cwd: entry.cwd, pid: null });
    }
    return savedTerminal(entry);
  }
  // Saved sessions are bounded by the history quota, not by a frame size, so
  // the socket's connection snapshot omits them; clients list them over HTTP.
  function list({ saved = true } = {}) {
    const reservations = reservedUnknown.filter((entry) => !terminals.has(entry.target));
    return [...terminals.values()].map(publicTerminal).concat(reservations.map(reservationTerminal),
      saved ? savedSessions().map(listedSaved) : []);
  }
  function capacity() {
    if (database.terminalAuditScanPending) return { active: maxTerminals, unknown: maxTerminals, limit: maxTerminals,
      recoveryPending: true, recoveryError: database.terminalAuditScanError ?? null };
    return { active: [...terminals.values()].filter((terminal) => terminal.status !== "exited").length + reservedUnknown.length,
      unknown: [...terminals.values()].filter((terminal) => terminal.status === "unknown").length + reservedUnknown.length, limit: maxTerminals };
  }
  function get(id) {
    const terminal = terminals.get(id);
    if (terminal) return { ...publicTerminal(terminal), buffer: terminal.buffer, outputCursor: terminal.outputCursor };
    // Saved output is served whole, at most the 2 MiB history cap, whether
    // it is ended or still awaits ownership proof; the pane pages through it
    // read-only. An unverified owner stays recovery-only, never running.
    const reservation = reservedUnknown.find((entry) => entry.target === id);
    if (reservation) return { ...reservationTerminal(reservation), buffer: history?.read(id) ?? "", outputCursor: 0 };
    const saved = savedSessions().find((entry) => entry.id === id);
    return saved ? { ...listedSaved(saved), buffer: history.read(id), outputCursor: 0 } : null;
  }
  function historyStatus() { return history?.status() ?? { persistent: false, warning: null }; }
  function relaunchSource(value) {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string" || !TERMINAL_ID.test(value)) throw terminalError(400, "Relaunch source must be a terminal id");
    return value;
  }
  function beginHistory(terminal) {
    history?.begin({ id: terminal.id, name: terminal.name, cwd: terminal.cwd, createdAt: terminal.createdAt,
      relaunchedFrom: terminal.relaunchedFrom }, terminal.buffer);
  }
  function write(id, data) {
    const terminal = terminals.get(id);
    if (terminal?.status !== "running" || typeof data !== "string" || Buffer.byteLength(data) > 64 * 1024) return false;
    return terminal.process.write(data) !== false;
  }
  function resize(id, cols, rows) {
    const terminal = terminals.get(id);
    if (terminal?.status !== "running") return false;
    return terminal.process.resize(clamp(cols, 20, 400), clamp(rows, 5, 200)) !== false;
  }
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
      if (!spawnTerminal) { cleanupSocket(terminal.id); forgetReattach(terminal.id); }
      if (!terminals.has(terminal.id) || terminal.closePromise) return;
      // The verified exit is saved even if its audit fails, so a later start
      // labels it with its status rather than as ended by restart.
      history?.end(terminal.id, { exitCode: terminal.exitCode, signal: terminal.signal });
      await database.auditRequired("terminal.exited", { target: terminal.id, exitCode: terminal.exitCode, signal: terminal.signal });
      if (!terminals.has(terminal.id) || terminal.closePromise) return;
      terminal.status = "exited";
      publish({ type: "terminal.exit", terminalId: terminal.id, payload: { exitCode: terminal.exitCode, signal: terminal.signal } });
      terminal.cleanupTimer = setTimeout(() => forget(terminal), exitedRetentionMs);
      terminal.cleanupTimer.unref?.();
    } catch (error) {
      if (terminals.get(terminal.id) === terminal && !terminal.closePromise) {
        terminal.status = "unknown";
        publish({ type: "terminal.audit-failed", terminalId: terminal.id, payload: { runtimeInstanceId, error: error.message } });
      }
    }
  }
  function close(id) {
    const terminal = terminals.get(id);
    // Dismissing a saved session deletes its history; no process remains.
    if (!terminal) return Promise.resolve().then(() => savedSessions().some((entry) => entry.id === id
      && listedSaved(entry).status === "ended") && history.remove(id));
    // A user's close removes the history even when shutdown later joins or
    // retries it; only a shutdown-initiated close keeps it to restore.
    if (!shuttingDown) terminal.userClosed = true;
    if (terminal.closePromise) return shuttingDown ? terminal.closePromise : reportCleanup(terminal);
    // An exit observed before the first close is the command's own end; any
    // exit after it comes from this termination, so it is not recorded.
    if (terminal.exitBeforeClose === undefined) {
      terminal.exitBeforeClose = terminal.exitSeen ? { exitCode: terminal.exitCode, signal: terminal.signal } : null;
    }
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
        if (!spawnTerminal) { cleanupSocket(id); forgetReattach(id); }
        await database.auditRequired("terminal.closed", evidence);
        forget(terminal);
      } catch (error) {
        terminal.status = "unknown";
        try { database.auditCritical("terminal.close.unknown", { ...evidence, error: String(error.message ?? error).slice(0, 1024) }); }
        catch { /* The request remains pending for lease-owned reconciliation. */ }
        terminal.closePromise = null;
        throw outcomeUnknown(error, evidence.operationId);
      }
      // The process is gone and its outcome recorded, which is all shutdown
      // waits for. A failed history removal is reported to the user's close:
      // kept metadata leaves the session listed to dismiss again, and output
      // left on disk stays charged against the quota until a retry deletes it.
      if (terminal.userClosed) {
        try { history?.remove(id); } catch (error) { terminal.cleanupError = error; }
      } else history?.finish(id, terminal.exitBeforeClose);
      return true;
    });
    return shuttingDown ? terminal.closePromise : reportCleanup(terminal);
  }
  function reportCleanup(terminal) {
    return terminal.closePromise.then((closed) => {
      if (terminal.cleanupError) throw terminal.cleanupError;
      return closed;
    });
  }
  // Reap every PTY even when storage is unavailable during archive maintenance.
  // A failed audit leaves terminal.created pending for lease-owned recovery.
  async function shutdown() {
    shuttingDown = true;
    await Promise.allSettled([...pendingReattaches]);
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
    history?.close();
    const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, "Terminal shutdown could not record every outcome");
  }

  function pruneExitedForCapacity(cwd) {
    while (terminals.size + reservedUnknown.length >= maxTerminals) {
      const exited = [...terminals.values()].find((terminal) => terminal.status === "exited");
      if (!exited) break;
      forget(exited);
    }
    while ([...terminals.values()].filter((terminal) => terminal.cwd === cwd).length + reservedForCwd(cwd) >= maxTerminalsPerCwd) {
      const exited = [...terminals.values()].find((terminal) => terminal.cwd === cwd && terminal.status === "exited");
      if (!exited) break;
      forget(exited);
    }
  }

  queueMicrotask(sweepStaleEmptyProofs);
  return { create, list, capacity, get, write, resize, close, shutdown, reconcileUnknown, reloadUnknownReservations, historyStatus };
}

function defaultHistory(database, onStatusChange) {
  // In-memory storage is never restored, so its terminals keep no history.
  if (!database.launchDirectory || !database.filename || database.filename === ":memory:") return null;
  return openTerminalHistory({ directory: path.join(database.launchDirectory, "terminal-history"), onStatusChange });
}
function publicTerminal(terminal) {
  return { id: terminal.id, cwd: terminal.cwd, name: terminal.name, pid: terminal.pid, status: terminal.status, exitCode: terminal.exitCode, createdAt: terminal.createdAt,
    ...(terminal.relaunchedFrom ? { relaunchedFrom: terminal.relaunchedFrom } : {}),
    ...(terminal.reattached ? { reattached: true } : {}) };
}
function savedTerminal(entry) {
  return { ...entry, pid: null, status: "ended", saved: true };
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
