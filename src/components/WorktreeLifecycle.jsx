import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { CheckCircle, CircleNotch, ShieldWarning, WarningCircle, Wrench } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, query } from "@/lib/runtime-api";
import { lifecycleOutputUpdate, lifecycleSummary } from "@/lib/worktree-lifecycle";

const ICONS = { running: CircleNotch, ready: CheckCircle, attention: WarningCircle, trust: ShieldWarning };

// A compact toolbar status for the selected worktree's setup or teardown.
// It is absent when nothing needs attention.
export function LifecycleState({ state, onOpen }) {
  const summary = lifecycleSummary(state);
  const [announcement, setAnnouncement] = useState("");
  const previous = useRef(summary?.label ?? "");
  useEffect(() => {
    if ((summary?.label ?? "") === previous.current) return;
    previous.current = summary?.label ?? "";
    setAnnouncement(summary ? summary.label : "");
  }, [summary]);
  const Icon = ICONS[summary?.tone] ?? Wrench;
  return <>
    <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
    {summary && !summary.quiet && <Button variant="ghost" size="sm" className={`lifecycle-state ${summary.tone}`} onClick={onOpen} aria-label={`${summary.short}: ${summary.label}. Open worktree setup`}>
      <Icon className={summary.tone === "running" ? "spin" : undefined} aria-hidden="true" /><span>{summary.short}</span>
    </Button>}
  </>;
}

// A small mark beside a worktree in the sidebar while its setup or teardown
// is running or needs attention.
export function LifecycleMark({ state }) {
  const summary = lifecycleSummary(state);
  if (!summary || summary.quiet) return null;
  const Icon = ICONS[summary.tone] ?? Wrench;
  return <span className={`lifecycle-mark ${summary.tone}`} title={summary.label}><Icon aria-hidden="true" /><span className="sr-only">{summary.label}</span></span>;
}

export function WorktreeLifecycleDialog({ open, onOpenChange, project, worktree, events, onError }) {
  const [detail, setDetail] = useState(null);
  const [busy, setBusy] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const outputRef = useRef(null);
  const pinnedRef = useRef(true);
  const target = { projectId: project.id, worktreeId: worktree.id, worktreePath: worktree.path };
  const load = useCallback(async () => {
    try { setDetail(await api(query("/api/worktrees/lifecycle", { projectId: project.id, worktreeId: worktree.id, path: worktree.path }))); }
    catch (error) { onError(error); }
  }, [project.id, worktree.id, worktree.path, onError]);

  useEffect(() => {
    if (!open) { setDetail(null); setAcknowledged(false); return undefined; }
    void load();
    const onState = (event) => {
      const payload = event.detail;
      if (payload.worktreeId === worktree.id || payload.worktreePath === worktree.path) void load();
    };
    const onOutput = (event) => setDetail((current) => {
      const next = lifecycleOutputUpdate(current?.state, event.detail);
      if (next === "reload") { void load(); return current; }
      return next ? { ...current, state: next } : current;
    });
    events.addEventListener("state", onState);
    events.addEventListener("output", onOutput);
    return () => { events.removeEventListener("state", onState); events.removeEventListener("output", onOutput); };
  }, [open, load, events, worktree.id, worktree.path]);

  // Follow new output unless the user scrolled up to read.
  useLayoutEffect(() => {
    const element = outputRef.current;
    if (element && pinnedRef.current) element.scrollTop = element.scrollHeight;
  }, [detail?.state?.output]);

  async function act(path, body = {}) {
    setBusy(true);
    try { await api(path, { method: "POST", body: { ...target, ...body } }); }
    catch (error) { onError(error); }
    finally { setBusy(false); await load(); }
  }
  async function trustAndRun() {
    setBusy(true);
    try {
      await api("/api/worktrees/lifecycle/trust", { method: "POST", body: { ...target, digest: detail.config.digest } });
      if (detail.config.setup.length) await api("/api/worktrees/lifecycle/setup", { method: "POST", body: target });
    } catch (error) { onError(error); }
    finally { setBusy(false); await load(); }
  }

  const config = detail?.config;
  const state = detail?.state;
  const summary = lifecycleSummary(state);
  const running = Boolean(detail?.running);
  const canTrust = Boolean(config && !config.error && !config.trusted && (config.setup.length || config.teardown.length));
  const canRun = Boolean(config && !config.error && config.trusted && config.setup.length && !running);
  const resumable = state?.phase === "setup" && ["failed", "cancelled", "interrupted"].includes(state.status) && state.configDigest === config?.digest;
  let runLabel = "Run setup";
  if (resumable) runLabel = `Retry from step ${state.stepIndex + 1}`;
  else if (state?.phase === "setup" && state.status === "ready") runLabel = "Run setup again";
  const needsAcknowledgement = Boolean(state?.outcomeUnknown);

  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="lifecycle-dialog">
    <DialogHeader><DialogTitle>Worktree setup</DialogTitle><DialogDescription>{project.name} / {worktree.name}</DialogDescription></DialogHeader>
    {!detail && <p className="lifecycle-note" role="status">Reading setup configuration…</p>}
    {detail && !config && <p className="lifecycle-note">This worktree has no <code>{detail.file}</code>. Add one to run setup commands after a worktree is created and teardown commands before it is removed.</p>}
    {config?.error && <p className="lifecycle-error" role="alert">{config.error}</p>}
    {config && !config.error && <>
      <p className={`lifecycle-trust ${config.trusted ? "trusted" : ""}`}>{config.trusted
        ? <><CheckCircle aria-hidden="true" />You trusted this exact version of <code>{detail.file}</code>.</>
        : <><ShieldWarning aria-hidden="true" />Review these commands. Once trusted, they run as you, in this worktree, with your environment. Trust covers only this exact file; any change needs a new review.</>}</p>
      <StepList title="Setup" steps={config.setup} current={state?.phase === "setup" ? state : null} />
      <StepList title="Teardown" steps={config.teardown} current={state?.phase === "teardown" ? state : null} />
    </>}
    {summary && <p className={`lifecycle-summary ${summary.tone}`} role="status" aria-live="polite">{summary.label}{state.error ? ` ${state.error}` : ""}</p>}
    {state?.output ? <pre ref={outputRef} className="lifecycle-output" tabIndex={0} aria-label={`${state.phase === "teardown" ? "Teardown" : "Setup"} output`}
      onScroll={(event) => { const element = event.currentTarget; pinnedRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24; }}>
      {state.outputTruncated ? "… earlier output was not kept\n" : ""}{state.output}</pre> : null}
    {needsAcknowledgement && !running && <label className="lifecycle-acknowledge"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />The last attempt's processes could not be confirmed stopped. I checked them; run again anyway.</label>}
    <DialogFooter>
      <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
      {running && <Button variant="destructive" disabled={busy} onClick={() => act("/api/worktrees/lifecycle/cancel")}>Cancel {detail.running}</Button>}
      {!running && canTrust && <Button disabled={busy} onClick={trustAndRun}>{config.setup.length ? "Trust and run setup" : "Trust teardown"}</Button>}
      {canRun && <Button disabled={busy || (needsAcknowledgement && !acknowledged)} onClick={() => act("/api/worktrees/lifecycle/setup", { acknowledgeUnconfirmed: acknowledged })}>{runLabel}</Button>}
    </DialogFooter>
  </DialogContent></Dialog>;
}

function StepList({ title, steps, current }) {
  if (!steps.length) return null;
  return <section className="lifecycle-steps" aria-label={`${title} steps`}><h3>{title}</h3><ol>{steps.map((step, index) => {
    let mark = "";
    if (current?.status === "running" && current.stepIndex === index) mark = "running";
    else if (current && (index < current.stepIndex || ["ready", "complete"].includes(current.status))) mark = "done";
    else if (current && index === current.stepIndex && ["failed", "cancelled", "interrupted"].includes(current.status)) mark = current.status;
    return <li key={`${index}:${step.name}`} className={mark}><strong>{step.name}{mark && <small> · {mark}</small>}</strong><code>{step.command.map((argument) => /^[\w@%+=:,./-]+$/.test(argument) ? argument : JSON.stringify(argument)).join(" ")}</code><small>Times out after {step.timeoutSeconds}s</small></li>;
  })}</ol></section>;
}
