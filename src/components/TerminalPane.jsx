import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ArrowDown, ArrowUp, ArrowsClockwise, MagnifyingGlass, Plus, TerminalWindow, X } from "@phosphor-icons/react";
import "@xterm/xterm/css/xterm.css";
import { Button } from "@/components/ui/button";
import { domId, nextTabIndex } from "@/lib/accessibility";
import { preferredTerminal, pruneExitedIds, savedOutputRows, savedPageText, savedRowPages, terminalEndLabel, terminalTabBadge, terminalTabLabel } from "@/lib/terminal-exit-state";
import { api } from "@/lib/runtime-api";
import { createTerminalSearch, TERMINAL_MATCH_LIMIT } from "@/lib/terminal-search";

const EMPTY_UNVERIFIED_IDS = new Set();
const NEW_SHELL_MARKER = "\x1b[90m[new shell started; the saved session was not resumed]\x1b[0m\r\n";
// Only a verified reattach to the process that kept running is marked live.
const REATTACHED_MARKER = "\x1b[90m[live process reattached; this shell kept running while Outright restarted]\x1b[0m\r\n";
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
const NO_FIND_RESULT = { total: 0, capped: false, index: -1, covered: false, selected: false };
// A count that only output changed is announced at most this often; what the
// user's own Find actions change is announced as it settles.
const FIND_OUTPUT_ANNOUNCE_MS = 5000;
// The Find bar overlays about the first two 15px rows of the output, from
// the cell under its left edge to the right.
const FIND_COVERED_ROWS = 2;
function findCoveredColumn(xterm, bar) {
  const screen = xterm.element?.querySelector(".xterm-screen")?.getBoundingClientRect();
  if (!bar || !screen?.width || !(xterm.cols > 0)) return 0;
  return Math.max(0, Math.floor((bar.getBoundingClientRect().left - screen.left) / (screen.width / xterm.cols)));
}
// Ctrl+F is a shell key, so outside macOS Find takes Ctrl+Shift+F. Either
// shortcut is withheld from the process; every other key still reaches it.
const MAC_SHORTCUTS = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const FIND_SHORTCUT = MAC_SHORTCUTS ? "Meta+F" : "Control+Shift+F";
function isFindShortcut(event) {
  if (event.key?.toLowerCase() !== "f" || event.altKey) return false;
  return MAC_SHORTCUTS ? event.metaKey && !event.ctrlKey && !event.shiftKey : event.ctrlKey && event.shiftKey && !event.metaKey;
}

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
  const fencedIdsRef = useRef(unverifiedTerminalIds);
  const worktreeNameRef = useRef(worktree.name);
  const onErrorRef = useRef(onError);
  worktreeNameRef.current = worktree.name;
  onErrorRef.current = onError;
  const [terminals, setTerminals] = useState([]);
  const [activeId, setActiveId] = useState("");
  const [loading, setLoading] = useState(true);
  const [exitNotice, setExitNotice] = useState("");
  const [savedPage, setSavedPage] = useState(null);
  const searchRef = useRef(null);
  const findInputRef = useRef(null);
  const findBarRef = useRef(null);
  const focusFindRef = useRef(false);
  const findOpenRef = useRef(false);
  const findValueRef = useRef("");
  const [findOpen, setFindOpen] = useState(false);
  const [findValue, setFindValue] = useState("");
  const [findResult, setFindResult] = useState(NO_FIND_RESULT);
  const [announcedFind, setAnnouncedFind] = useState("");
  const [findAction, setFindAction] = useState(0);
  const findActionSeenRef = useRef(0);
  const findActionPendingRef = useRef(false);
  const findAnnouncedAtRef = useRef(0);
  const findHighlightRef = useRef(false);
  findOpenRef.current = findOpen;
  findValueRef.current = findValue;

  useEffect(() => {
    const xterm = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: '"DM Sans Variable", monospace',
      fontSize: 12,
      lineHeight: 1.25,
      screenReaderMode: true,
      scrollback: LIVE_SCROLLBACK,
      theme: findHighlightRef.current ? findTheme() : terminalTheme(),
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(hostRef.current);
    xtermRef.current = xterm;
    // Find reads the shown buffer only; the process never sees its keys.
    xterm.attachCustomKeyEventHandler((event) => !isFindShortcut(event));
    const search = createTerminalSearch(xterm, setFindResult, {
      coveredRows: FIND_COVERED_ROWS,
      coveredColumn: () => findCoveredColumn(xterm, findBarRef.current),
    });
    searchRef.current = search;
    if (findOpenRef.current) search.setQuery(findValueRef.current);
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
    return () => { disposable.dispose(); search.dispose(); searchRef.current = null; document.removeEventListener("visibilitychange", resizeTerminal); resize.disconnect(); fitSelectedRef.current = null; xterm.dispose(); xtermRef.current = null; };
  }, [sendRuntime]);

  // The selected terminal and the busy state both change the committed pane.
  // Publish its PTY size only after that React commit, using the same fit path
  // as ResizeObserver and visibility restoration.
  useLayoutEffect(() => {
    if (!loading && activeId) fitSelectedRef.current?.();
  }, [activeId, loading]);

  // The socket callback has already fenced sends. Commit a durable warning
  // even when a later output or capacity event replaced runtimeEvent. A tab
  // shown unknown only while fenced is read again from the server once its
  // fence lifts, whichever runtime event lifted it.
  useLayoutEffect(() => {
    const released = [...fencedIdsRef.current].filter((id) => !unverifiedTerminalIds.has(id));
    fencedIdsRef.current = unverifiedTerminalIds;
    if (terminalsRef.current.some((item) => item.status === "unknown" && released.includes(item.id))) {
      if (loadingRef.current || syncingRef.current) queuedSyncRef.current = true;
      else void syncListing();
    }
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
      const reattached = Boolean(detail.reattached ?? terminal.reattached);
      const marker = !reattached && Boolean(detail.relaunchedFrom ?? terminal.relaunchedFrom);
      // An unverified owner is never marked as the live process.
      const liveMarker = reattached ? (status === "unknown" ? "" : REATTACHED_MARKER) : marker ? NEW_SHELL_MARKER : "";
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
        xterm?.write(CLEAR_VIEW + liveMarker);
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
      else if (reattached) notice = `${terminal.name} live process reattached; it kept running while Outright restarted`;
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
        // An unknown tab no longer fenced follows the server again.
        const released = item.status === "unknown" && !unverifiedTerminalIdsRef.current.has(item.id);
        return released || current.status === "ended" || item.status === "ended" || current.recoveryReservation || item.recoveryReservation ? [current] : [item];
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

  // Opening Find moves focus to its query, selected so typing replaces it.
  function openFind() {
    setFindAction((count) => count + 1);
    if (findOpenRef.current) { findInputRef.current?.focus(); findInputRef.current?.select(); return; }
    focusFindRef.current = true;
    findOpenRef.current = true;
    setFindOpen(true);
  }

  // Closing Find removes its selection and returns focus to the terminal,
  // which routes keys to the process again when it accepts input.
  function closeFind() {
    searchRef.current?.clear();
    findOpenRef.current = false;
    setFindOpen(false);
    setFindResult(NO_FIND_RESULT);
    setAnnouncedFind("");
    xtermRef.current?.focus();
  }

  // Enter in the query steps; Escape anywhere in the bar closes it. Keys
  // that confirm or cancel an IME composition stay with the composition.
  function findKey(event) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && event.target === findInputRef.current) {
      event.preventDefault();
      stepFind(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeFind();
    }
  }

  function stepFind(direction) {
    setFindAction((count) => count + 1);
    searchRef.current?.step(direction);
  }

  function paneKey(event) {
    if (!isFindShortcut(event)) return;
    event.preventDefault();
    event.stopPropagation();
    openFind();
  }

  // Only Find's own highlight is drawn as the current match; a selection the
  // user makes while Find is open keeps the normal selection color.
  const findHighlight = findOpen && findResult.selected;
  findHighlightRef.current = findHighlight;
  useLayoutEffect(() => {
    if (xtermRef.current) xtermRef.current.options.theme = findHighlight ? findTheme() : terminalTheme();
  }, [findHighlight]);

  // A reopened query searches the view again once the bar is mounted, so
  // whether to scroll its match and lower the bar is decided from where the
  // bar really is, before it is painted.
  useLayoutEffect(() => {
    if (findOpen) searchRef.current?.setQuery(findValueRef.current);
  }, [findOpen]);

  useLayoutEffect(() => {
    if (!findOpen || !focusFindRef.current) return;
    focusFindRef.current = false;
    findInputRef.current?.focus();
    findInputRef.current?.select();
  }, [findOpen]);

  const activeTerminal = terminals.find((terminal) => terminal.id === activeId);
  const activeSaved = activeTerminal?.status === "ended" || activeTerminal?.recoveryReservation ? activeTerminal : null;
  // Saved output is searched one shown part at a time.
  const findScope = activeSaved && savedPage?.id === activeSaved.id && savedPage.count > 1 ? " in this part" : "";
  const findQuery = findOpen && findValue.trim();
  let findStatus = "";
  let findAnnouncement = "";
  if (findQuery && !findResult.total) {
    findStatus = "No matches";
    findAnnouncement = `No matches${findScope}`;
  } else if (findQuery) {
    const total = `${findResult.total}${findResult.capped ? "+" : ""}`;
    const more = findResult.capped ? `; only the newest ${TERMINAL_MATCH_LIMIT} are counted` : "";
    const matches = `${total} ${findResult.total === 1 ? "match" : "matches"}`;
    findStatus = findResult.index >= 0 ? `${findResult.index + 1} of ${total}` : matches;
    findAnnouncement = (findResult.index >= 0 ? `Match ${findResult.index + 1} of ${findResult.total}` : matches) + findScope + more;
  }
  // Streaming output recounts every 200 ms; announcing each count would talk
  // over the user, so output-only changes wait for the slower cadence. A user
  // action is always announced: when its text is unchanged (one match, or a
  // reopen), a trailing no-break space toggles so the live region still changes.
  useEffect(() => {
    if (findActionSeenRef.current !== findAction) { findActionSeenRef.current = findAction; findActionPendingRef.current = true; }
    const action = findActionPendingRef.current;
    const delay = action ? 180 : Math.max(180, findAnnouncedAtRef.current + FIND_OUTPUT_ANNOUNCE_MS - Date.now());
    const timer = window.setTimeout(() => {
      findActionPendingRef.current = false;
      findAnnouncedAtRef.current = Date.now();
      setAnnouncedFind((shown) => action && findAnnouncement && shown === findAnnouncement ? `${findAnnouncement}\u00a0` : findAnnouncement);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [findAnnouncement, findAction]);

  return <section className="terminal-pane" aria-label="Worktree terminals" onKeyDown={paneKey}>
    <p className="sr-only" id="terminal-help">Terminal input and output. Use the left and right arrow keys on a terminal tab to switch sessions.</p>
    <header className="terminal-tabs" role="tablist" aria-label="Open terminals" aria-orientation="horizontal" aria-busy={loading} onKeyDown={navigateTerminalTabs}>
      {terminals.map((terminal) => <div className={`terminal-tab ${terminal.id === activeId ? "is-active" : ""}`} key={terminal.id}><button className="terminal-tab-select" id={domId("terminal-tab", terminal.id)} data-tab-id={terminal.id} role="tab" aria-selected={terminal.id === activeId} aria-controls="terminal-panel" tabIndex={terminal.id === activeId || (!activeId && terminals[0]?.id === terminal.id) ? 0 : -1} aria-disabled={loading || undefined} aria-label={terminalTabLabel(terminal)} onClick={() => selectTerminal(terminal)}><TerminalWindow /><span>{terminal.name}</span>{terminalTabBadge(terminal) && <span className="terminal-tab-badge">{terminalTabBadge(terminal)}</span>}</button><button className="terminal-tab-close" aria-label={terminal.status === "ended" ? `Dismiss saved terminal ${terminal.name}` : `Close terminal ${terminal.name}`} disabled={loading || terminal.recoveryReservation} onClick={() => closeTerminal(terminal.id)}><X /></button></div>)}
      <Button variant="ghost" size="icon-xs" disabled={loading} onClick={createTerminal} aria-label="New terminal"><Plus /></Button>
      <Button variant="ghost" size="icon-xs" onClick={() => findOpen ? closeFind() : openFind()} aria-label="Find in terminal" aria-expanded={findOpen} aria-controls={findOpen ? "terminal-find" : undefined} aria-keyshortcuts={FIND_SHORTCUT}><MagnifyingGlass /></Button>
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
    {/* Find overlays the output, so opening it never resizes the process. */}
    <div className="terminal-stage">
      {/* It moves to the bottom while the current match is under it. */}
      {findOpen && <div ref={findBarRef} className={`window-find terminal-find${findResult.covered ? " is-lowered" : ""}`} id="terminal-find" role="search" aria-label={`Find in ${activeTerminal?.name ?? "terminal"} output`} onKeyDown={findKey}>
        <input ref={findInputRef} type="text" aria-label="Find in terminal output" aria-keyshortcuts={FIND_SHORTCUT} aria-describedby="terminal-find-help" spellCheck={false} autoComplete="off" value={findValue}
          onChange={(event) => { setFindAction((count) => count + 1); setFindValue(event.target.value); searchRef.current?.setQuery(event.target.value); }} />
        <span aria-hidden="true">{findStatus}</span>
        <button type="button" onClick={() => stepFind(-1)} disabled={!findQuery} aria-label="Previous terminal match"><ArrowUp /></button>
        <button type="button" onClick={() => stepFind(1)} disabled={!findQuery} aria-label="Next terminal match"><ArrowDown /></button>
        <button type="button" onClick={closeFind} aria-label="Close terminal find"><X /></button>
        <span className="sr-only" id="terminal-find-help">Enter finds the next match, Shift+Enter the previous, and Escape closes Find and returns to the terminal.</span>
        <span className="sr-only" role="status">{announcedFind}</span>
      </div>}
      <div className="terminal-host" id="terminal-panel" ref={hostRef} role="tabpanel" aria-label="Active terminal output" aria-labelledby={activeId ? domId("terminal-tab", activeId) : undefined} aria-describedby="terminal-help" />
    </div>
    <span className="sr-only" role="status">{exitNotice}</span>
  </section>;
}

// While Find holds the selection it is the current match, drawn opaque amber
// with dark text whatever color the program used: at least 3:1 against the
// terminal background and 4.5:1 for the text, focused or not.
function findTheme() {
  const match = document.documentElement.classList.contains("dark") ? "#e8b04a" : "#c4840c";
  return { ...terminalTheme(), selectionBackground: match, selectionInactiveBackground: match, selectionForeground: "#111110" };
}

function terminalTheme() {
  const dark = document.documentElement.classList.contains("dark");
  return dark
    ? { background: "#111110", foreground: "#d8d8d3", cursor: "#f1f1ed", selectionBackground: "#3b3b38" }
    : { background: "#fbfbfa", foreground: "#262624", cursor: "#111110", selectionBackground: "#d6d6d1" };
}
