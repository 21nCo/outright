import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ArrowsClockwise, Plus, TerminalWindow, X } from "@phosphor-icons/react";
import "@xterm/xterm/css/xterm.css";
import { Button } from "@/components/ui/button";
import { domId, nextTabIndex } from "@/lib/accessibility";
import { preferredTerminal, pruneExitedIds, savedOutputRows, savedPageText, savedRowPages, terminalEndLabel, terminalTabLabel } from "@/lib/terminal-exit-state";
import { api } from "@/lib/runtime-api";

const EMPTY_UNVERIFIED_IDS = new Set();
const NEW_SHELL_MARKER = "\x1b[90m[new shell started; the saved session was not resumed]\x1b[0m\r\n";
// A saved page has at most 2,000 rows at the view's width, so it stays in
// this scrollback even if the view narrows to a fifth of that width.
const LIVE_SCROLLBACK = 5000;
const SAVED_SCROLLBACK = 10_000;
// Replacing the view is written as a full reset (RIS) in order with any
// output still queued, so nothing written for an earlier view lands after it.
const CLEAR_VIEW = "\x1bc";
const RESERVATION_LABEL = "its prior-run owner is unverified and not attached";
const EARLIER_NOT_SHOWN = "\x1b[90m[earlier saved output not shown]\x1b[0m\r\n";
// One announcement per distinct storage condition for this page session.
let announcedHistoryWarning = "";

export function TerminalPane(props) {
  return <WorktreeTerminalPane key={JSON.stringify([props.worktree.id, props.worktree.path])} {...props} />;
}

function announceHistoryWarning(status, onError) {
  const warning = status?.warning;
  if (!warning || warning === announcedHistoryWarning) return;
  announcedHistoryWarning = warning;
  onError(new Error(warning));
}

// A saved detail replaces any recovery reservation the tab was listed as.
function savedFields(detail, item) {
  return { name: detail.name ?? item.name, status: "ended", endReason: detail.endReason, exitCode: detail.exitCode,
    endedAt: detail.endedAt, saved: true, recoveryReservation: undefined, pid: null };
}

// The page-scoped audit fence guards live owners. A session the server lists
// as saved output has no owner, so its status wins for display and actions;
// input and resize stay off because a saved session never sends them.
function fencedLive(item, unverifiedIds) {
  return item.status !== "ended" && unverifiedIds.has(item.id);
}

function WorktreeTerminalPane({ worktree, runtimeEvent, terminalsVersion = 0, unverifiedTerminalIds = EMPTY_UNVERIFIED_IDS, sendRuntime, onError }) {
  const hostRef = useRef(null);
  const xtermRef = useRef(null);
  const fitSelectedRef = useRef(null);
  const activeIdRef = useRef("");
  const displayedCursorRef = useRef(0);
  const inputReadyRef = useRef(false);
  const awaitingVisibleFitRef = useRef(false);
  const loadingRef = useRef(true);
  const reconcileTokenRef = useRef(0);
  const pendingOutputRef = useRef(null);
  const exitedIdsRef = useRef(new Set());
  const mutationRef = useRef(false);
  const reconcilingRef = useRef(false);
  const selectingRef = useRef(false);
  const mountedRef = useRef(false);
  const queuedReconnectRef = useRef(null);
  const syncingRef = useRef(false);
  const queuedSyncRef = useRef(false);
  const seenTerminalsVersionRef = useRef(terminalsVersion);
  const focusRequestRef = useRef(null);
  const terminalsRef = useRef([]);
  const savedViewRef = useRef(null);
  const unverifiedTerminalIdsRef = useRef(unverifiedTerminalIds);
  unverifiedTerminalIdsRef.current = unverifiedTerminalIds;
  const worktreeNameRef = useRef(worktree.name);
  const onErrorRef = useRef(onError);
  worktreeNameRef.current = worktree.name;
  onErrorRef.current = onError;
  const [terminals, setTerminals] = useState([]);
  const [activeId, setActiveId] = useState("");
  const [loading, setLoading] = useState(true);
  const [exitNotice, setExitNotice] = useState("");
  const [savedPage, setSavedPage] = useState(null);

  useEffect(() => {
    const xterm = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: '"DM Sans Variable", monospace',
      fontSize: 12,
      lineHeight: 1.25,
      screenReaderMode: true,
      scrollback: LIVE_SCROLLBACK,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(hostRef.current);
    xtermRef.current = xterm;
    const resizeTerminal = () => {
      try {
        if (document.hidden) return;
        const dimensions = fit.proposeDimensions();
        if (!dimensions) return;
        fit.fit();
        if (!loadingRef.current && activeIdRef.current && !exitedIdsRef.current.has(activeIdRef.current)
          && !unverifiedTerminalIdsRef.current.has(activeIdRef.current)
          && terminalsRef.current.find((item) => item.id === activeIdRef.current)?.status === "running"
          && (inputReadyRef.current || awaitingVisibleFitRef.current)) {
          sendRuntime({ type: "terminal.resize", terminalId: activeIdRef.current, cols: xterm.cols, rows: xterm.rows });
          inputReadyRef.current = true;
          awaitingVisibleFitRef.current = false;
        }
      } catch { /* The terminal may be transitioning out of the DOM. */ }
    };
    fitSelectedRef.current = resizeTerminal;
    const resize = new ResizeObserver(resizeTerminal);
    resize.observe(hostRef.current);
    document.addEventListener("visibilitychange", resizeTerminal);
    const disposable = xterm.onData((data) => {
      if (inputReadyRef.current && !loadingRef.current && activeIdRef.current
        && !unverifiedTerminalIdsRef.current.has(activeIdRef.current)) sendRuntime({ type: "terminal.input", terminalId: activeIdRef.current, data });
    });
    return () => { disposable.dispose(); document.removeEventListener("visibilitychange", resizeTerminal); resize.disconnect(); fitSelectedRef.current = null; xterm.dispose(); xtermRef.current = null; };
  }, [sendRuntime]);

  // The selected terminal and the busy state both change the committed pane.
  // Publish its PTY size only after that React commit, using the same fit path
  // as ResizeObserver and visibility restoration.
  useLayoutEffect(() => {
    if (!loading && activeId) fitSelectedRef.current?.();
  }, [activeId, loading]);

  // The socket callback has already fenced sends. Commit a durable warning
  // even when a later output or capacity event replaced runtimeEvent.
  useLayoutEffect(() => {
    const pending = pendingOutputRef.current;
    if (pending && unverifiedTerminalIds.has(pending.id)) pending.unknown = true;
    if (!terminalsRef.current.some((item) => fencedLive(item, unverifiedTerminalIds) && item.status !== "unknown")) return;
    stageTerminals(terminalsRef.current.map((item) => fencedLive(item, unverifiedTerminalIds)
      ? { ...item, status: "unknown" } : item));
    const active = terminalsRef.current.find((item) => item.id === activeIdRef.current);
    if (active && fencedLive(active, unverifiedTerminalIds)) {
      inputReadyRef.current = false;
      awaitingVisibleFitRef.current = false;
      setExitNotice("Terminal ownership is unverified. Inspect local terminal recovery.");
    }
  }, [unverifiedTerminalIds]);

  useLayoutEffect(() => {
    const request = focusRequestRef.current;
    if (!request?.id || request.id !== activeId || request.token !== reconcileTokenRef.current) return;
    focusRequestRef.current = null;
    if (document.activeElement === document.body) {
      document.getElementById(domId("terminal-tab", request.id))?.focus({ preventScroll: true });
    }
  }, [terminals, activeId, loading]);

  useEffect(() => {
    const cancelFocus = (event) => {
      if (event.type === "focusin" && event.target === document.body) return;
      if (focusRequestRef.current) focusRequestRef.current = null;
    };
    for (const type of ["pointerdown", "keydown", "focusin"]) document.addEventListener(type, cancelFocus, true);
    return () => {
      for (const type of ["pointerdown", "keydown", "focusin"]) document.removeEventListener(type, cancelFocus, true);
    };
  }, []);

  function beginSelection() {
    focusRequestRef.current = null;
    const token = ++reconcileTokenRef.current;
    loadingRef.current = true;
    inputReadyRef.current = false;
    awaitingVisibleFitRef.current = false;
    setLoading(true);
    return token;
  }

  function stageTerminals(next) {
    const guarded = next.map((item) => fencedLive(item, unverifiedTerminalIdsRef.current)
      ? { ...item, status: "unknown" } : item);
    terminalsRef.current = guarded;
    pruneExitedIds(exitedIdsRef.current, guarded, pendingOutputRef.current);
    if (activeIdRef.current && !guarded.some((item) => item.id === activeIdRef.current)) {
      activeIdRef.current = "";
      displayedCursorRef.current = 0;
      inputReadyRef.current = false;
      awaitingVisibleFitRef.current = false;
      xtermRef.current?.write(CLEAR_VIEW);
      setActiveId("");
    }
    setTerminals(guarded);
  }

  function recoverSelection(restoreInput = false, restoreFit = false) {
    const selected = terminalsRef.current.find((item) => item.id === activeIdRef.current) ?? terminalsRef.current[0];
    if (selected?.id !== activeIdRef.current) {
      activeIdRef.current = selected?.id ?? "";
      displayedCursorRef.current = 0;
      inputReadyRef.current = false;
      awaitingVisibleFitRef.current = false;
      xtermRef.current?.write(CLEAR_VIEW);
      setActiveId(activeIdRef.current);
    } else if (selected) {
      const running = !exitedIdsRef.current.has(selected.id) && !unverifiedTerminalIdsRef.current.has(selected.id)
        && selected.status === "running";
      inputReadyRef.current = restoreInput && running;
      awaitingVisibleFitRef.current = restoreFit && running;
    }
  }

  async function activateTerminal(terminal, token) {
    const pending = { id: terminal.id, chunks: [], length: 0, overflow: false, exit: null, unknown: false };
    pendingOutputRef.current = pending;
    try {
      const detail = await api(`/api/terminals/${terminal.id}`);
      if (token !== reconcileTokenRef.current) return;
      if (!detail || typeof detail !== "object") throw new Error("Terminal detail is unavailable");
      // Saved output, ended or awaiting ownership proof, is parsed once at the
      // view's size and shown read-only. A newer selection stops the parse.
      const saved = (detail.status ?? terminal.status) === "ended" || Boolean(detail.recoveryReservation);
      const visible = xtermRef.current;
      const savedOutput = saved && visible ? await savedOutputRows(detail.buffer ?? "", { cols: visible.cols, rows: visible.rows }, Terminal,
        () => token === reconcileTokenRef.current) : { rows: [], dropped: false };
      if (token !== reconcileTokenRef.current) return;
      // Leave output and exit events staged through the layout handoff. A
      // resize can settle while the snapshot request is in flight.
      await new Promise((resolve) => {
        let frame;
        const timer = setTimeout(() => { cancelAnimationFrame(frame); resolve(); }, 100);
        if (!document.hidden) frame = requestAnimationFrame(() => { clearTimeout(timer); resolve(); });
      });
      if (token !== reconcileTokenRef.current) return;
      if (pending.overflow) throw new Error("Terminal output exceeded the activation buffer; retry the tab");
      let status = detail.status ?? terminal.status;
      if (status !== "ended" && (pending.unknown || unverifiedTerminalIdsRef.current.has(terminal.id))) status = "unknown";
      const xterm = xtermRef.current;
      const marker = Boolean(detail.relaunchedFrom ?? terminal.relaunchedFrom);
      let savedLabel = status === "ended" ? terminalEndLabel(savedFields(detail, terminal)) : "";
      if (detail.recoveryReservation) savedLabel = RESERVATION_LABEL;
      let displayedCursor = Number.isSafeInteger(detail.outputCursor) ? detail.outputCursor : 0;
      if (saved) {
        savedViewRef.current = { id: terminal.id, rows: savedOutput.rows, dropped: savedOutput.dropped, pages: savedRowPages(savedOutput.rows), marker, label: savedLabel };
        showSavedPage(savedViewRef.current.pages.length - 1);
      } else {
        savedViewRef.current = null;
        setSavedPage(null);
        if (xterm) xterm.options.scrollback = LIVE_SCROLLBACK;
        xterm?.write(marker ? CLEAR_VIEW + NEW_SHELL_MARKER : CLEAR_VIEW);
        if (detail.buffer) xterm?.write(detail.buffer);
        for (const { cursor, data } of pending.chunks) {
          if (!Number.isSafeInteger(detail.outputCursor) || !Number.isSafeInteger(cursor) || cursor > detail.outputCursor) xterm?.write(data);
          if (Number.isSafeInteger(cursor)) displayedCursor = Math.max(displayedCursor, cursor);
        }
      }
      let exited = null;
      if (status !== "unknown" && status !== "ended") {
        if (pending.exit) exited = pending.exit;
        else if (status === "exited") exited = { exitCode: detail.exitCode };
      }
      if (status === "ended") {
        inputReadyRef.current = false;
        awaitingVisibleFitRef.current = false;
        stageTerminals(terminalsRef.current.map((item) => item.id === terminal.id ? { ...item, ...savedFields(detail, item) } : item));
      } else if (exited) {
        exitedIdsRef.current.add(terminal.id);
        xterm?.writeln(`\r\n\x1b[90m[process exited ${exited.exitCode ?? "unknown"}]\x1b[0m`);
        stageTerminals(terminalsRef.current.map((item) => item.id === terminal.id ? { ...item, status: "exited", exitCode: exited.exitCode } : item));
      } else if (status === "running") {
        exitedIdsRef.current.delete(terminal.id);
        stageTerminals(terminalsRef.current.map((item) => item.id === terminal.id ? { ...item, status: "running", exitCode: undefined } : item));
      } else {
        inputReadyRef.current = false;
        awaitingVisibleFitRef.current = false;
        stageTerminals(terminalsRef.current.map((item) => item.id === terminal.id ? { ...item, status } : item));
      }
      let notice = "";
      if (status === "ended") notice = `${detail.name ?? terminal.name} saved output, ${savedLabel}. Read-only.${savedOutput.dropped ? " Earlier saved output not shown." : ""}`;
      else if (exited) notice = `${terminal.name} process exited ${exited.exitCode ?? "unknown"}`;
      else if (status === "unknown") notice = `${terminal.name} ownership is unverified. Inspect local terminal recovery.`;
      setExitNotice(notice);
      activeIdRef.current = terminal.id;
      displayedCursorRef.current = displayedCursor;
      setActiveId(terminal.id);
      if (!exited && status === "running") awaitingVisibleFitRef.current = true;
    } finally {
      if (pendingOutputRef.current === pending) pendingOutputRef.current = null;
    }
  }

  // Each page replaces the view in one ordered write of its rows, which need
  // nothing from the rows before them. An earlier page opens at its first
  // line; the earliest says when older output was left out; the newest ends
  // with the saved label.
  function showSavedPage(index) {
    const view = savedViewRef.current;
    const xterm = xtermRef.current;
    if (!view) return;
    const newest = index >= view.pages.length - 1;
    const generation = (view.generation ?? 0) + 1;
    Object.assign(view, { shown: index, generation });
    if (xterm) xterm.options.scrollback = SAVED_SCROLLBACK;
    const marker = (view.marker && index <= 0 ? NEW_SHELL_MARKER : "") + (view.dropped && index <= 0 ? EARLIER_NOT_SHOWN : "");
    const label = newest ? `\r\n\x1b[90m[saved output; ${view.label}]\x1b[0m\r\n` : "";
    const opened = () => { if (!newest && savedViewRef.current === view && view.generation === generation) xterm.scrollToTop(); };
    xterm?.write(CLEAR_VIEW + marker + savedPageText(view.rows, view.pages[index] ?? [0, 0]) + label, opened);
    setSavedPage({ id: view.id, index, count: view.pages.length });
  }

  // Navigation steps from the page last requested, not the last rendered.
  function pageSavedOutput(step) {
    const view = savedViewRef.current;
    if (loading || !view || view.id !== activeIdRef.current) return;
    const index = view.shown + step;
    if (index < 0 || index >= view.pages.length) return;
    showSavedPage(index);
    const name = terminalsRef.current.find((item) => item.id === view.id)?.name ?? "Terminal";
    let earliest = "";
    if (index === 0) earliest = view.dropped ? ", the earliest kept; earlier saved output not shown" : ", the earliest";
    setExitNotice(`${name} saved output, part ${index + 1} of ${view.pages.length}${earliest}`);
  }

  useEffect(() => {
    mountedRef.current = true;
    const token = beginSelection();
    let cancelled = false;
    (async () => {
      try {
        const listing = await api("/api/terminals");
        if (cancelled || token !== reconcileTokenRef.current) return;
        announceHistoryWarning(listing.history, onErrorRef.current);
        const matching = listing.terminals.filter((terminal) => terminal.cwd === worktree.path);
        let terminal = preferredTerminal(matching);
        if (!terminal) terminal = await api("/api/terminals", { method: "POST", body: { cwd: worktree.path, name: worktreeNameRef.current, cols: 100, rows: 30 } });
        if (cancelled || token !== reconcileTokenRef.current) return;
        stageTerminals([...matching.filter((item) => item.id !== terminal.id), terminal]);
        await activateTerminal(terminal, token);
      } catch (error) { if (!cancelled && token === reconcileTokenRef.current) { recoverSelection(); onErrorRef.current(error); } }
      finally { if (!cancelled && token === reconcileTokenRef.current) { loadingRef.current = false; setLoading(false); drainReconnect(); } }
    })();
    return () => { cancelled = true; mountedRef.current = false; ++reconcileTokenRef.current; selectingRef.current = false; queuedReconnectRef.current = null; queuedSyncRef.current = false; focusRequestRef.current = null; pendingOutputRef.current = null; activeIdRef.current = ""; displayedCursorRef.current = 0; };
  }, [worktree.id, worktree.path]);

  useEffect(() => {
    if (runtimeEvent?.type === "terminal.output") {
      const pending = pendingOutputRef.current;
      if (pending?.id === runtimeEvent.terminalId) {
        const data = runtimeEvent.payload.data;
        pending.length += data.length;
        if (pending.length > 150_000) pending.overflow = true;
        else pending.chunks.push({ cursor: runtimeEvent.payload.cursor, data });
      } else if (runtimeEvent.terminalId === activeIdRef.current) {
        const cursor = runtimeEvent.payload.cursor;
        if (!Number.isSafeInteger(cursor) || cursor > displayedCursorRef.current) {
          xtermRef.current?.write(runtimeEvent.payload.data);
          if (Number.isSafeInteger(cursor)) displayedCursorRef.current = cursor;
        }
      }
    }
    if (runtimeEvent?.type === "terminal.exit") {
      const pending = pendingOutputRef.current;
      if (pending?.id === runtimeEvent.terminalId) pending.exit = runtimeEvent.payload;
      if (!unverifiedTerminalIdsRef.current.has(runtimeEvent.terminalId)
        && terminalsRef.current.some((item) => item.id === runtimeEvent.terminalId)) {
        const firstExit = !exitedIdsRef.current.has(runtimeEvent.terminalId);
        exitedIdsRef.current.add(runtimeEvent.terminalId);
        stageTerminals(terminalsRef.current.map((item) => item.id === runtimeEvent.terminalId
          ? { ...item, status: "exited", exitCode: runtimeEvent.payload.exitCode } : item));
        if (runtimeEvent.terminalId === activeIdRef.current) {
          inputReadyRef.current = false;
          awaitingVisibleFitRef.current = false;
          if (firstExit) {
            const currentName = terminalsRef.current.find((item) => item.id === runtimeEvent.terminalId)?.name ?? "Terminal";
            setExitNotice(`${currentName} process exited ${runtimeEvent.payload.exitCode ?? "unknown"}`);
            xtermRef.current?.writeln(`\r\n\x1b[90m[process exited ${runtimeEvent.payload.exitCode ?? "unknown"}]\x1b[0m`);
          }
        }
      }
    }
    if (runtimeEvent?.type === "terminal.audit-failed") {
      if (pendingOutputRef.current?.id === runtimeEvent.terminalId) pendingOutputRef.current.unknown = true;
      const audited = terminalsRef.current.find((item) => item.id === runtimeEvent.terminalId);
      if (audited && audited.status !== "ended") {
        stageTerminals(terminalsRef.current.map((item) => item === audited ? { ...item, status: "unknown" } : item));
        if (runtimeEvent.terminalId === activeIdRef.current) {
          inputReadyRef.current = false;
          awaitingVisibleFitRef.current = false;
          setExitNotice("Terminal ownership is unverified. Inspect local terminal recovery.");
        }
      }
    }
    if (runtimeEvent?.type === "runtime.connected") announceHistoryWarning(runtimeEvent.payload?.history, onErrorRef.current);
    if (runtimeEvent?.type === "runtime.connected" && (runtimeEvent.payload?.replay?.requestedAfter > 0 || runtimeEvent.payload?.restarted) && activeIdRef.current) {
      if (mutationRef.current || reconcilingRef.current || selectingRef.current || syncingRef.current) queuedReconnectRef.current = true;
      else reconcileConnection();
    }
  }, [runtimeEvent, worktree.path]);

  useEffect(() => {
    if (terminalsVersion === seenTerminalsVersionRef.current) return;
    seenTerminalsVersionRef.current = terminalsVersion;
    if (loadingRef.current || syncingRef.current) queuedSyncRef.current = true;
    else void syncListing();
  }, [terminalsVersion]);

  // Saved sessions and recovery reservations change on the server without a
  // per-tab event. The tabs become the server's listing: new sessions are
  // added, gone ones removed, and live tabs keep following their events.
  async function syncListing() {
    if (!mountedRef.current) return;
    syncingRef.current = true;
    const token = reconcileTokenRef.current;
    try {
      const listing = await api("/api/terminals");
      if (!mountedRef.current) return;
      if (token !== reconcileTokenRef.current || loadingRef.current) { queuedSyncRef.current = true; return; }
      announceHistoryWarning(listing.history, onErrorRef.current);
      const listed = new Map(listing.terminals.filter((item) => item.cwd === worktree.path).map((item) => [item.id, item]));
      const active = terminalsRef.current.find((item) => item.id === activeIdRef.current);
      const known = new Set(terminalsRef.current.map((item) => item.id));
      const next = terminalsRef.current.flatMap((item) => {
        const current = listed.get(item.id);
        if (!current) return [];
        return current.status === "ended" || item.status === "ended" || current.recoveryReservation || item.recoveryReservation ? [current] : [item];
      }).concat([...listed.values()].filter((item) => !known.has(item.id)));
      const nextActive = next.find((item) => item.id === active?.id);
      stageTerminals(next);
      // The selected session changed underneath its view: read it again so
      // its buffer, label and actions match the server.
      if (active && (nextActive?.status !== active.status || nextActive?.endReason !== active.endReason
        || nextActive?.recoveryReservation !== active.recoveryReservation)) queuedReconnectRef.current = true;
    } catch (error) {
      if (mountedRef.current && token === reconcileTokenRef.current) onErrorRef.current(error);
    } finally {
      syncingRef.current = false;
      if (mountedRef.current && !loadingRef.current) drainReconnect();
    }
  }

  // A reconnect re-lists over HTTP: the socket snapshot omits saved sessions.
  function reconcileConnection() {
    if (!mountedRef.current) return;
    reconcilingRef.current = true;
    const previousId = activeIdRef.current;
    const wasReady = inputReadyRef.current;
    const wasAwaitingFit = awaitingVisibleFitRef.current;
    const token = beginSelection();
    const reconcile = async () => {
      const listing = await api("/api/terminals");
      if (token !== reconcileTokenRef.current) return;
      announceHistoryWarning(listing.history, onErrorRef.current);
      const matching = listing.terminals.filter((terminal) => terminal.cwd === worktree.path);
      let terminal = preferredTerminal(matching, previousId);
      if (!terminal) terminal = await api("/api/terminals", { method: "POST", body: { cwd: worktree.path, name: worktreeNameRef.current, cols: 100, rows: 30 } });
      if (token !== reconcileTokenRef.current) return;
      stageTerminals([...matching.filter((item) => item.id !== terminal.id), terminal]);
      await activateTerminal(terminal, token);
    };
    reconcile().catch((error) => {
      if (token !== reconcileTokenRef.current) return;
      const retained = activeIdRef.current === previousId;
      recoverSelection(retained && wasReady, retained && wasAwaitingFit);
      onErrorRef.current(error);
    }).finally(() => {
      reconcilingRef.current = false;
      if (mountedRef.current && token === reconcileTokenRef.current) {
        loadingRef.current = false;
        setLoading(false);
        drainReconnect();
      }
    });
  }

  function drainReconnect() {
    if (!mountedRef.current || mutationRef.current || reconcilingRef.current || selectingRef.current || syncingRef.current) return;
    // A reconnect re-lists every tab, so it also satisfies a queued sync.
    if (queuedReconnectRef.current) {
      queuedReconnectRef.current = null;
      queuedSyncRef.current = false;
      reconcileConnection();
    } else if (queuedSyncRef.current) {
      queuedSyncRef.current = false;
      void syncListing();
    }
  }

  function finishMutation(token) {
    mutationRef.current = false;
    if (!mountedRef.current || token !== reconcileTokenRef.current) return;
    loadingRef.current = false;
    setLoading(false);
    drainReconnect();
  }

  function createTerminal() {
    return launchTerminal({ cwd: worktree.path, name: `${worktreeNameRef.current} ${terminals.length + 1}` });
  }

  // A saved session is never resumed: this starts a separate shell in the
  // same worktree that is marked as new. The button leaves with the saved
  // view, so focus moves to the new shell's tab unless it moved elsewhere.
  function startNewShell(saved) {
    return launchTerminal({ cwd: worktree.path, name: saved.name, relaunchedFrom: saved.id }, true);
  }

  async function launchTerminal(body, focusNew = false) {
    if (loading) return;
    mutationRef.current = true;
    const wasReady = inputReadyRef.current;
    const wasAwaitingFit = awaitingVisibleFitRef.current;
    const token = beginSelection();
    if (focusNew) focusRequestRef.current = { id: null, token };
    try {
      const terminal = await api("/api/terminals", { method: "POST", body });
      if (token !== reconcileTokenRef.current) return;
      if (focusRequestRef.current?.token === token) focusRequestRef.current.id = terminal.id;
      stageTerminals([...terminalsRef.current.filter((item) => item.id !== terminal.id), terminal]);
      await activateTerminal(terminal, token);
      if (body.relaunchedFrom && token === reconcileTokenRef.current) {
        setExitNotice(`${terminal.name} new shell started; the saved session was not resumed`);
      }
    } catch (error) {
      if (token === reconcileTokenRef.current) {
        recoverSelection(wasReady, wasAwaitingFit);
        if (focusRequestRef.current?.token === token) focusRequestRef.current = null;
        onErrorRef.current(error);
      }
    }
    finally { finishMutation(token); }
  }

  async function closeTerminal(id) {
    if (loading) return;
    mutationRef.current = true;
    const wasReady = inputReadyRef.current;
    const wasAwaitingFit = awaitingVisibleFitRef.current;
    const previousId = activeIdRef.current;
    const focusedClose = document.activeElement?.closest(".terminal-tab")?.querySelector('[role="tab"]')?.dataset.tabId === id;
    const token = beginSelection();
    if (focusedClose) focusRequestRef.current = { id: null, token };
    let deleted = false;
    try {
      try { await api(`/api/terminals/${id}`, { method: "DELETE" }); }
      catch (error) {
        // Quota or retention may already have removed a saved session; its
        // tab leaves too. Anything the server still lists keeps the error.
        if (error.status !== 404) throw error;
        const listing = await api("/api/terminals");
        if (listing.terminals.some((item) => item.id === id)) throw error;
      }
      deleted = true;
      if (token !== reconcileTokenRef.current) return;
      // An exit can update another tab while DELETE is pending; the render-time
      // list is not authoritative after the asynchronous wait.
      const remaining = terminalsRef.current.filter((item) => item.id !== id);
      let next = remaining.find((item) => item.id === previousId) ?? remaining[0];
      stageTerminals(remaining);
      if (!next) {
        next = await api("/api/terminals", { method: "POST", body: { cwd: worktree.path, name: worktreeNameRef.current } });
        remaining.push(next);
      }
      if (token !== reconcileTokenRef.current) return;
      stageTerminals(remaining);
      if (focusRequestRef.current?.token === token) focusRequestRef.current.id = next.id;
      await activateTerminal(next, token);
    } catch (error) {
      if (token === reconcileTokenRef.current) {
        // A failed close can still have ended the process, for example when
        // its saved output could not be deleted. Re-list before any input.
        if (deleted) recoverSelection(wasReady, wasAwaitingFit);
        else {
          recoverSelection();
          queuedReconnectRef.current = true;
        }
        if (focusRequestRef.current?.token === token && !focusRequestRef.current.id) {
          focusRequestRef.current = null;
        }
        onErrorRef.current(error);
      }
    }
    finally { finishMutation(token); }
  }

  async function selectTerminal(terminal) {
    if (loading || terminal.cwd !== worktree.path
      || (terminal.id === activeIdRef.current && (inputReadyRef.current || awaitingVisibleFitRef.current))) return;
    const wasReady = inputReadyRef.current;
    const wasAwaitingFit = awaitingVisibleFitRef.current;
    const token = beginSelection();
    selectingRef.current = token;
    try { await activateTerminal(terminal, token); }
    catch (error) {
      if (token === reconcileTokenRef.current) {
        recoverSelection(wasReady, wasAwaitingFit);
        if (document.activeElement?.dataset.tabId === terminal.id) {
          document.getElementById(domId("terminal-tab", activeIdRef.current))?.focus({ preventScroll: true });
        }
        onErrorRef.current(error);
      }
    }
    finally {
      if (selectingRef.current === token) selectingRef.current = false;
      if (mountedRef.current && token === reconcileTokenRef.current) {
        loadingRef.current = false;
        setLoading(false);
        drainReconnect();
      }
    }
  }

  function navigateTerminalTabs(event) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const currentTab = event.target.closest('[role="tab"]');
    if (!currentTab || !event.currentTarget.contains(currentTab)) return;
    if (loading) { event.preventDefault(); return; }
    const currentIndex = terminals.findIndex((terminal) => terminal.id === currentTab.dataset.tabId);
    if (currentIndex < 0) return;
    const nextIndex = nextTabIndex(currentIndex, terminals.length, event.key);
    if (nextIndex < 0) return;
    event.preventDefault();
    const next = terminals[nextIndex];
    event.currentTarget.querySelector(`[data-tab-id="${CSS.escape(next.id)}"]`)?.focus();
    if (next.id !== activeIdRef.current || (!inputReadyRef.current && !awaitingVisibleFitRef.current)) selectTerminal(next);
  }

  const activeTerminal = terminals.find((terminal) => terminal.id === activeId);
  const activeSaved = activeTerminal?.status === "ended" || activeTerminal?.recoveryReservation ? activeTerminal : null;

  return <section className="terminal-pane" aria-label="Worktree terminals">
    <p className="sr-only" id="terminal-help">Terminal input and output. Use the left and right arrow keys on a terminal tab to switch sessions.</p>
    <header className="terminal-tabs" role="tablist" aria-label="Open terminals" aria-orientation="horizontal" aria-busy={loading} onKeyDown={navigateTerminalTabs}>
      {terminals.map((terminal) => <div className={`terminal-tab ${terminal.id === activeId ? "is-active" : ""}`} key={terminal.id}><button className="terminal-tab-select" id={domId("terminal-tab", terminal.id)} data-tab-id={terminal.id} role="tab" aria-selected={terminal.id === activeId} aria-controls="terminal-panel" tabIndex={terminal.id === activeId || (!activeId && terminals[0]?.id === terminal.id) ? 0 : -1} aria-disabled={loading || undefined} aria-label={terminalTabLabel(terminal)} onClick={() => selectTerminal(terminal)}><TerminalWindow /><span>{terminal.name}</span>{terminal.status === "ended" ? <span className="terminal-tab-badge">Saved</span> : terminal.relaunchedFrom && <span className="terminal-tab-badge">New shell</span>}</button><button className="terminal-tab-close" aria-label={terminal.status === "ended" ? `Dismiss saved terminal ${terminal.name}` : `Close terminal ${terminal.name}`} disabled={loading || terminal.recoveryReservation} onClick={() => closeTerminal(terminal.id)}><X /></button></div>)}
      <Button variant="ghost" size="icon-xs" disabled={loading} onClick={createTerminal} aria-label="New terminal"><Plus /></Button>
      {loading && <span className="terminal-loading" role="status"><ArrowsClockwise className="spin" />Loading terminal</span>}
    </header>
    {activeSaved && <div className="terminal-saved-bar" role="group" aria-label="Saved terminal session">
      <span>Saved output, read-only: {activeSaved.status === "ended" ? terminalEndLabel(activeSaved) : RESERVATION_LABEL}.</span>
      {savedPage?.id === activeSaved.id && savedPage.count > 1 && <>
        <Button variant="ghost" size="xs" aria-disabled={loading || savedPage.index === 0 || undefined} onClick={() => pageSavedOutput(-1)}>Earlier output</Button>
        <span>Part {savedPage.index + 1} of {savedPage.count}</span>
        <Button variant="ghost" size="xs" aria-disabled={loading || savedPage.index === savedPage.count - 1 || undefined} onClick={() => pageSavedOutput(1)}>Later output</Button>
      </>}
      {activeSaved.status === "ended" && <Button variant="outline" size="xs" aria-disabled={loading || undefined} onClick={() => startNewShell(activeSaved)}>Start new shell</Button>}
    </div>}
    <div className="terminal-host" id="terminal-panel" ref={hostRef} role="tabpanel" aria-label="Active terminal output" aria-labelledby={activeId ? domId("terminal-tab", activeId) : undefined} aria-describedby="terminal-help" />
    <span className="sr-only" role="status">{exitNotice}</span>
  </section>;
}

function terminalTheme() {
  const dark = document.documentElement.classList.contains("dark");
  return dark
    ? { background: "#111110", foreground: "#d8d8d3", cursor: "#f1f1ed", selectionBackground: "#3b3b38" }
    : { background: "#fbfbfa", foreground: "#262624", cursor: "#111110", selectionBackground: "#d6d6d1" };
}
