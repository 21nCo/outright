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
  const reconcileTokenRef = useRef(0);
  const [terminals, setTerminals] = useState([]);
  const [activeId, setActiveId] = useState("");
  const [loading, setLoading] = useState(true);

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
    const resize = new ResizeObserver(() => {
      try {
        fit.fit();
        if (activeIdRef.current) sendRuntime({ type: "terminal.resize", terminalId: activeIdRef.current, cols: xterm.cols, rows: xterm.rows });
      } catch { /* The terminal may be transitioning out of the DOM. */ }
    });
    resize.observe(hostRef.current);
    const disposable = xterm.onData((data) => activeIdRef.current && sendRuntime({ type: "terminal.input", terminalId: activeIdRef.current, data }));
    return () => { disposable.dispose(); resize.disconnect(); xterm.dispose(); xtermRef.current = null; };
  }, [sendRuntime]);

  function beginSelection() {
    const token = ++reconcileTokenRef.current;
    activeIdRef.current = "";
    setActiveId("");
    setLoading(true);
    xtermRef.current?.reset();
    return token;
  }

  async function activateTerminal(terminal, token) {
    const detail = await api(`/api/terminals/${terminal.id}`);
    if (token !== reconcileTokenRef.current) return;
    xtermRef.current?.reset();
    if (detail.buffer) xtermRef.current?.write(detail.buffer);
    activeIdRef.current = terminal.id;
    setActiveId(terminal.id);
  }

  useEffect(() => {
    const token = beginSelection();
    setTerminals([]);
    let cancelled = false;
    (async () => {
      try {
        const { terminals: all } = await api("/api/terminals");
        if (cancelled || token !== reconcileTokenRef.current) return;
        const matching = all.filter((terminal) => terminal.cwd === worktree.path);
        let terminal = matching.find((item) => item.status === "running");
        if (!terminal) terminal = await api("/api/terminals", { method: "POST", body: { cwd: worktree.path, name: worktree.name, cols: 100, rows: 30 } });
        if (cancelled || token !== reconcileTokenRef.current) return;
        setTerminals([...matching.filter((item) => item.id !== terminal.id), terminal]);
        await activateTerminal(terminal, token);
      } catch (error) { if (!cancelled && token === reconcileTokenRef.current) onError(error); }
      finally { if (!cancelled && token === reconcileTokenRef.current) setLoading(false); }
    })();
    return () => { cancelled = true; ++reconcileTokenRef.current; activeIdRef.current = ""; };
  }, [worktree.id, worktree.name, worktree.path, onError]);

  useEffect(() => {
    if (runtimeEvent?.type === "terminal.output" && runtimeEvent.terminalId === activeIdRef.current) xtermRef.current?.write(runtimeEvent.payload.data);
    if (runtimeEvent?.type === "terminal.exit" && runtimeEvent.terminalId === activeIdRef.current) xtermRef.current?.writeln(`\r\n\x1b[90m[process exited ${runtimeEvent.payload.exitCode}]\x1b[0m`);
    if (runtimeEvent?.type === "runtime.connected" && (runtimeEvent.payload?.replay?.requestedAfter > 0 || runtimeEvent.payload?.restarted) && activeIdRef.current) {
      const previousId = activeIdRef.current;
      const token = beginSelection();
      const reconcile = async () => {
        setLoading(true);
        const matching = (runtimeEvent.payload.terminals ?? []).filter((terminal) => terminal.cwd === worktree.path);
        let terminal = matching.find((item) => item.id === previousId && item.status === "running") ?? matching.find((item) => item.status === "running");
        if (!terminal) terminal = await api("/api/terminals", { method: "POST", body: { cwd: worktree.path, name: worktree.name, cols: 100, rows: 30 } });
        if (token !== reconcileTokenRef.current) return;
        setTerminals([...matching.filter((item) => item.id !== terminal.id), terminal]);
        await activateTerminal(terminal, token);
      };
      reconcile().catch((error) => { if (token === reconcileTokenRef.current) onError(error); }).finally(() => token === reconcileTokenRef.current && setLoading(false));
    }
  }, [runtimeEvent, onError, worktree.name, worktree.path]);

  async function createTerminal() {
    if (loading) return;
    const token = beginSelection();
    try {
      const terminal = await api("/api/terminals", { method: "POST", body: { cwd: worktree.path, name: `${worktree.name} ${terminals.length + 1}` } });
      if (token !== reconcileTokenRef.current) return;
      setTerminals((current) => [...current, terminal]);
      await activateTerminal(terminal, token);
    } catch (error) { if (token === reconcileTokenRef.current) onError(error); }
    finally { if (token === reconcileTokenRef.current) setLoading(false); }
  }

  async function closeTerminal(id) {
    if (loading) return;
    const previousId = activeIdRef.current;
    const token = beginSelection();
    try {
      await api(`/api/terminals/${id}`, { method: "DELETE" });
      if (token !== reconcileTokenRef.current) return;
      const remaining = terminals.filter((item) => item.id !== id);
      let next = remaining.find((item) => item.id === previousId) ?? remaining[0];
      if (!next) {
        next = await api("/api/terminals", { method: "POST", body: { cwd: worktree.path, name: worktree.name } });
        remaining.push(next);
      }
      if (token !== reconcileTokenRef.current) return;
      setTerminals(remaining);
      await activateTerminal(next, token);
    } catch (error) { if (token === reconcileTokenRef.current) onError(error); }
    finally { if (token === reconcileTokenRef.current) setLoading(false); }
  }

  async function selectTerminal(terminal) {
    if (loading || terminal.cwd !== worktree.path || terminal.id === activeIdRef.current) return;
    const token = ++reconcileTokenRef.current;
    setLoading(true);
    try { await activateTerminal(terminal, token); }
    catch (error) { if (token === reconcileTokenRef.current) onError(error); }
    finally { if (token === reconcileTokenRef.current) setLoading(false); }
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
    if (next.id !== activeIdRef.current) selectTerminal(next);
  }

  return <section className="terminal-pane" aria-label="Worktree terminals">
    <p className="sr-only" id="terminal-help">Terminal input and output. Use the left and right arrow keys on a terminal tab to switch sessions.</p>
    <header className="terminal-tabs" role="tablist" aria-label="Open terminals" aria-orientation="horizontal" aria-busy={loading} onKeyDown={navigateTerminalTabs}>
      {terminals.map((terminal) => <div className={`terminal-tab ${terminal.id === activeId ? "is-active" : ""}`} key={terminal.id}><button className="terminal-tab-select" id={domId("terminal-tab", terminal.id)} data-tab-id={terminal.id} role="tab" aria-selected={terminal.id === activeId} aria-controls="terminal-panel" tabIndex={terminal.id === activeId ? 0 : -1} aria-disabled={loading || undefined} onClick={() => selectTerminal(terminal)}><TerminalWindow /><span>{terminal.name}</span></button><button className="terminal-tab-close" aria-label={`Close terminal ${terminal.name}`} disabled={loading} onClick={() => closeTerminal(terminal.id)}><X /></button></div>)}
      <Button variant="ghost" size="icon-xs" disabled={loading} onClick={createTerminal} aria-label="New terminal"><Plus /></Button>
      {loading && <span className="terminal-loading" role="status"><ArrowsClockwise className="spin" />Loading terminal</span>}
    </header>
    <div className="terminal-host" id="terminal-panel" ref={hostRef} role="tabpanel" aria-label="Active terminal output" aria-labelledby={activeId ? domId("terminal-tab", activeId) : undefined} aria-describedby="terminal-help" />
  </section>;
}

function terminalTheme() {
  const dark = document.documentElement.classList.contains("dark");
  return dark
    ? { background: "#111110", foreground: "#d8d8d3", cursor: "#f1f1ed", selectionBackground: "#3b3b38" }
    : { background: "#fbfbfa", foreground: "#262624", cursor: "#111110", selectionBackground: "#d6d6d1" };
}
