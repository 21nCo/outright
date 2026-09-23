import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ArrowsClockwise, Plus, TerminalWindow, X } from "@phosphor-icons/react";
import "@xterm/xterm/css/xterm.css";
import { Button } from "@/components/ui/button";
import { domId, nextTabIndex } from "@/lib/accessibility";
import { api } from "@/lib/runtime-api";

export function TerminalPane(props) {
  return <WorktreeTerminalPane key={JSON.stringify([props.worktree.id, props.worktree.path])} {...props} />;
}

function WorktreeTerminalPane({ worktree, runtimeEvent, sendRuntime, onError }) {
  const hostRef = useRef(null);
  const xtermRef = useRef(null);
  const fitRef = useRef(null);
  const activeIdRef = useRef("");
  const displayedCursorRef = useRef(0);
  const inputReadyRef = useRef(false);
  const awaitingVisibleFitRef = useRef(false);
  const loadingRef = useRef(true);
  const reconcileTokenRef = useRef(0);
  const pendingOutputRef = useRef(null);
  const exitedIdsRef = useRef(new Set());
  const mutationRef = useRef(false);
  const queuedReconnectRef = useRef(null);
  const terminalsRef = useRef([]);
  const [terminals, setTerminals] = useState([]);
  const [activeId, setActiveId] = useState("");
  const [loading, setLoading] = useState(true);
  const [exitNotice, setExitNotice] = useState("");

  useEffect(() => {
    const xterm = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: '"DM Sans Variable", monospace',
      fontSize: 12,
      lineHeight: 1.25,
      screenReaderMode: true,
      scrollback: 5000,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(hostRef.current);
    xtermRef.current = xterm;
    fitRef.current = fit;
    const resizeTerminal = () => {
      try {
        if (document.hidden) return;
        fit.fit();
        if (!loadingRef.current && activeIdRef.current && !exitedIdsRef.current.has(activeIdRef.current)
          && (inputReadyRef.current || awaitingVisibleFitRef.current)) {
          sendRuntime({ type: "terminal.resize", terminalId: activeIdRef.current, cols: xterm.cols, rows: xterm.rows });
          inputReadyRef.current = true;
          awaitingVisibleFitRef.current = false;
        }
      } catch { /* The terminal may be transitioning out of the DOM. */ }
    };
    const resize = new ResizeObserver(resizeTerminal);
    resize.observe(hostRef.current);
    document.addEventListener("visibilitychange", resizeTerminal);
    const disposable = xterm.onData((data) => {
      if (inputReadyRef.current && !loadingRef.current && activeIdRef.current) sendRuntime({ type: "terminal.input", terminalId: activeIdRef.current, data });
    });
    return () => { disposable.dispose(); document.removeEventListener("visibilitychange", resizeTerminal); resize.disconnect(); xterm.dispose(); xtermRef.current = null; };
  }, [sendRuntime]);

  function beginSelection() {
    const token = ++reconcileTokenRef.current;
    loadingRef.current = true;
    inputReadyRef.current = false;
    awaitingVisibleFitRef.current = false;
    setLoading(true);
    return token;
  }

  function stageTerminals(next) {
    terminalsRef.current = next;
    if (activeIdRef.current && !next.some((item) => item.id === activeIdRef.current)) {
      activeIdRef.current = "";
      displayedCursorRef.current = 0;
      inputReadyRef.current = false;
      awaitingVisibleFitRef.current = false;
      xtermRef.current?.reset();
      setActiveId("");
    }
    setTerminals(next);
  }

  function recoverSelection(restoreInput = false, restoreFit = false) {
    const selected = terminalsRef.current.find((item) => item.id === activeIdRef.current) ?? terminalsRef.current[0];
    if (selected?.id !== activeIdRef.current) {
      activeIdRef.current = selected?.id ?? "";
      displayedCursorRef.current = 0;
      inputReadyRef.current = false;
      awaitingVisibleFitRef.current = false;
      xtermRef.current?.reset();
      setActiveId(activeIdRef.current);
    } else if (selected) {
      const running = !exitedIdsRef.current.has(selected.id) && selected.status !== "exited";
      inputReadyRef.current = restoreInput && running;
      awaitingVisibleFitRef.current = restoreFit && running;
    }
  }

  async function activateTerminal(terminal, token) {
    const pending = { id: terminal.id, chunks: [], length: 0, overflow: false, exit: null };
    pendingOutputRef.current = pending;
    try {
      const detail = await api(`/api/terminals/${terminal.id}`);
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
      const xterm = xtermRef.current;
      xterm?.reset();
      if (detail.buffer) xterm?.write(detail.buffer);
      let displayedCursor = Number.isSafeInteger(detail.outputCursor) ? detail.outputCursor : 0;
      for (const { cursor, data } of pending.chunks) {
        if (!Number.isSafeInteger(detail.outputCursor) || !Number.isSafeInteger(cursor) || cursor > detail.outputCursor) xterm?.write(data);
        if (Number.isSafeInteger(cursor)) displayedCursor = Math.max(displayedCursor, cursor);
      }
      const exited = pending.exit || (detail.status === "exited" ? { exitCode: detail.exitCode } : null);
      if (exited) {
        exitedIdsRef.current.add(terminal.id);
        xterm?.writeln(`\r\n\x1b[90m[process exited ${exited.exitCode ?? "unknown"}]\x1b[0m`);
        stageTerminals(terminalsRef.current.map((item) => item.id === terminal.id ? { ...item, status: "exited", exitCode: exited.exitCode } : item));
      } else {
        exitedIdsRef.current.delete(terminal.id);
        stageTerminals(terminalsRef.current.map((item) => item.id === terminal.id ? { ...item, status: "running", exitCode: undefined } : item));
      }
      setExitNotice(exited ? `${terminal.name} process exited ${exited.exitCode ?? "unknown"}` : "");
      activeIdRef.current = terminal.id;
      displayedCursorRef.current = displayedCursor;
      if (!exited && !document.hidden) {
        try { fitRef.current?.fit(); } catch { /* The host may be transitioning. */ }
        if (xterm) sendRuntime({ type: "terminal.resize", terminalId: terminal.id, cols: xterm.cols, rows: xterm.rows });
        inputReadyRef.current = true;
      } else if (!exited) awaitingVisibleFitRef.current = true;
      setActiveId(terminal.id);
    } finally {
      if (pendingOutputRef.current === pending) pendingOutputRef.current = null;
    }
  }

  useEffect(() => {
    const token = beginSelection();
    let cancelled = false;
    (async () => {
      try {
        const { terminals: all } = await api("/api/terminals");
        if (cancelled || token !== reconcileTokenRef.current) return;
        const matching = all.filter((terminal) => terminal.cwd === worktree.path);
        let terminal = matching.find((item) => item.status === "running");
        if (!terminal) terminal = await api("/api/terminals", { method: "POST", body: { cwd: worktree.path, name: worktree.name, cols: 100, rows: 30 } });
        if (cancelled || token !== reconcileTokenRef.current) return;
        stageTerminals([...matching.filter((item) => item.id !== terminal.id), terminal]);
        await activateTerminal(terminal, token);
      } catch (error) { if (!cancelled && token === reconcileTokenRef.current) { recoverSelection(); onError(error); } }
      finally { if (!cancelled && token === reconcileTokenRef.current) { loadingRef.current = false; setLoading(false); } }
    })();
    return () => { cancelled = true; ++reconcileTokenRef.current; pendingOutputRef.current = null; activeIdRef.current = ""; displayedCursorRef.current = 0; };
  }, [worktree.id, worktree.name, worktree.path, onError]);

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
      if (terminalsRef.current.some((item) => item.id === runtimeEvent.terminalId)) {
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
    if (runtimeEvent?.type === "runtime.connected" && (runtimeEvent.payload?.replay?.requestedAfter > 0 || runtimeEvent.payload?.restarted) && activeIdRef.current) {
      if (mutationRef.current) queuedReconnectRef.current = runtimeEvent.payload;
      else reconcileConnection(runtimeEvent.payload);
    }
  }, [runtimeEvent, onError, worktree.name, worktree.path]);

  function reconcileConnection(payload, refresh = false) {
    const previousId = activeIdRef.current;
    const token = beginSelection();
    const reconcile = async () => {
      const all = refresh ? (await api("/api/terminals")).terminals : (payload.terminals ?? []);
      if (token !== reconcileTokenRef.current) return;
      const matching = all.filter((terminal) => terminal.cwd === worktree.path);
      let terminal = matching.find((item) => item.id === previousId && item.status === "running") ?? matching.find((item) => item.status === "running");
      if (!terminal) terminal = await api("/api/terminals", { method: "POST", body: { cwd: worktree.path, name: worktree.name, cols: 100, rows: 30 } });
      if (token !== reconcileTokenRef.current) return;
      stageTerminals([...matching.filter((item) => item.id !== terminal.id), terminal]);
      await activateTerminal(terminal, token);
    };
    reconcile().catch((error) => { if (token === reconcileTokenRef.current) { recoverSelection(); onError(error); } }).finally(() => {
      if (token === reconcileTokenRef.current) { loadingRef.current = false; setLoading(false); }
    });
  }

  function finishMutation(token) {
    mutationRef.current = false;
    if (token === reconcileTokenRef.current) { loadingRef.current = false; setLoading(false); }
    const queued = queuedReconnectRef.current;
    queuedReconnectRef.current = null;
    if (queued) reconcileConnection(queued, true);
  }

  async function createTerminal() {
    if (loading) return;
    mutationRef.current = true;
    const wasReady = inputReadyRef.current;
    const wasAwaitingFit = awaitingVisibleFitRef.current;
    const token = beginSelection();
    try {
      const terminal = await api("/api/terminals", { method: "POST", body: { cwd: worktree.path, name: `${worktree.name} ${terminals.length + 1}` } });
      if (token !== reconcileTokenRef.current) return;
      stageTerminals([...terminals, terminal]);
      await activateTerminal(terminal, token);
    } catch (error) { if (token === reconcileTokenRef.current) { recoverSelection(wasReady, wasAwaitingFit); onError(error); } }
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
    try {
      await api(`/api/terminals/${id}`, { method: "DELETE" });
      if (token !== reconcileTokenRef.current) return;
      const remaining = terminals.filter((item) => item.id !== id);
      let next = remaining.find((item) => item.id === previousId) ?? remaining[0];
      stageTerminals(remaining);
      if (!next) {
        next = await api("/api/terminals", { method: "POST", body: { cwd: worktree.path, name: worktree.name } });
        remaining.push(next);
      }
      if (token !== reconcileTokenRef.current) return;
      stageTerminals(remaining);
      if (focusedClose) {
        const nextId = next.id;
        requestAnimationFrame(() => {
          if (document.activeElement === document.body) document.getElementById(domId("terminal-tab", nextId))?.focus({ preventScroll: true });
        });
      }
      await activateTerminal(next, token);
    } catch (error) { if (token === reconcileTokenRef.current) { recoverSelection(wasReady, wasAwaitingFit); onError(error); } }
    finally { finishMutation(token); }
  }

  async function selectTerminal(terminal) {
    if (loading || terminal.cwd !== worktree.path
      || (terminal.id === activeIdRef.current && (inputReadyRef.current || awaitingVisibleFitRef.current))) return;
    const wasReady = inputReadyRef.current;
    const wasAwaitingFit = awaitingVisibleFitRef.current;
    const token = beginSelection();
    try { await activateTerminal(terminal, token); }
    catch (error) {
      if (token === reconcileTokenRef.current) {
        recoverSelection(wasReady, wasAwaitingFit);
        if (document.activeElement?.dataset.tabId === terminal.id) {
          document.getElementById(domId("terminal-tab", activeIdRef.current))?.focus({ preventScroll: true });
        }
        onError(error);
      }
    }
    finally { if (token === reconcileTokenRef.current) { loadingRef.current = false; setLoading(false); } }
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

  return <section className="terminal-pane" aria-label="Worktree terminals">
    <p className="sr-only" id="terminal-help">Terminal input and output. Use the left and right arrow keys on a terminal tab to switch sessions.</p>
    <header className="terminal-tabs" role="tablist" aria-label="Open terminals" aria-orientation="horizontal" aria-busy={loading} onKeyDown={navigateTerminalTabs}>
      {terminals.map((terminal) => <div className={`terminal-tab ${terminal.id === activeId ? "is-active" : ""}`} key={terminal.id}><button className="terminal-tab-select" id={domId("terminal-tab", terminal.id)} data-tab-id={terminal.id} role="tab" aria-selected={terminal.id === activeId} aria-controls="terminal-panel" tabIndex={terminal.id === activeId || (!activeId && terminals[0]?.id === terminal.id) ? 0 : -1} aria-disabled={loading || undefined} aria-label={`${terminal.name}${terminal.status === "exited" ? `, process exited ${terminal.exitCode ?? "unknown"}` : ""}`} onClick={() => selectTerminal(terminal)}><TerminalWindow /><span>{terminal.name}</span></button><button className="terminal-tab-close" aria-label={`Close terminal ${terminal.name}`} disabled={loading} onClick={() => closeTerminal(terminal.id)}><X /></button></div>)}
      <Button variant="ghost" size="icon-xs" disabled={loading} onClick={createTerminal} aria-label="New terminal"><Plus /></Button>
      {loading && <span className="terminal-loading" role="status"><ArrowsClockwise className="spin" />Loading terminal</span>}
    </header>
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
