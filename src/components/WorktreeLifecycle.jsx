import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { CheckCircle, CircleNotch, ShieldWarning, WarningCircle, Wrench } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, query } from "@/lib/runtime-api";
import { lifecycleDetailUpdate, lifecycleOutputUpdate, lifecycleSummary } from "@/lib/worktree-lifecycle";

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
  // The attempt whose unconfirmed processes the user checked, by run id: a
  // newer attempt is never shown as already checked.
  const [acknowledgedRunId, setAcknowledgedRunId] = useState(null);
  const outputRef = useRef(null);
  const pinnedRef = useRef(true);
  // The runtime's canonical form of this worktree's path, once loaded.
  const canonicalRef = useRef(null);
  // Reads overlap (open, events, reconnect, actions). Only a response to a
  // read issued after the one shown may replace it, so a slow older read
  // never hides a newer state; closing or retargeting discards all reads.
  const issuedRef = useRef(0);
  const shownRef = useRef(0);
  const target = { projectId: project.id, worktreePath: worktree.path };
  const load = useCallback(async () => {
    const generation = ++issuedRef.current;
    try {
      const next = await api(query("/api/worktrees/lifecycle", { projectId: project.id, path: worktree.path }));
      if (generation <= shownRef.current) return;
      shownRef.current = generation;
      canonicalRef.current = next.worktreePath ?? null;
      setDetail((current) => lifecycleDetailUpdate(current, next));
    } catch (error) {
      if (generation > shownRef.current) onError(error);
    }
  }, [project.id, worktree.path, onError]);

  useEffect(() => {
    if (!open) { setDetail(null); setAcknowledgedRunId(null); return undefined; }
    void load();
    const onState = (event) => {
      const payload = event.detail;
      if ([payload.worktreePath, payload.discoveredPath].some((value) => value && (value === worktree.path || value === canonicalRef.current))) void load();
    };
    const onReconnect = () => void load();
    const onOutput = (event) => setDetail((current) => {
      const next = lifecycleOutputUpdate(current?.state, event.detail);
      if (next === "reload") { void load(); return current; }
      return next ? { ...current, state: next } : current;
    });
    events.addEventListener("state", onState);
    events.addEventListener("output", onOutput);
    events.addEventListener("reconnect", onReconnect);
    return () => {
      events.removeEventListener("state", onState);
      events.removeEventListener("output", onOutput);
      events.removeEventListener("reconnect", onReconnect);
      shownRef.current = issuedRef.current;
      canonicalRef.current = null;
    };
  }, [open, load, events, worktree.path]);

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
  // Trusting runs nothing unless the user also asks for setup, so a teardown
  // the removal refused can run from its checkpoint before setup provisions.
  async function trust(runSetup) {
    setBusy(true);
    try {
      await api("/api/worktrees/lifecycle/trust", { method: "POST", body: { ...target, digest: detail.config.digest } });
      if (runSetup) await api("/api/worktrees/lifecycle/setup", { method: "POST", body: target });
    } catch (error) { onError(error); }
    finally { setBusy(false); await load(); }
  }

  const config = detail?.config;
  const state = detail?.state;
  const summary = lifecycleSummary(state);
  const running = Boolean(detail?.running);
  // Progress belongs to the file version it ran; steps of a changed file have not run.
  const matching = Boolean(state && config && state.configDigest === config.digest);
  const canTrust = Boolean(config && !config.error && !config.trusted && (config.setup.length || config.teardown.length));
  const canRun = Boolean(config && !config.error && config.trusted && config.setup.length && !running);
  const checkpoint = state?.checkpoints?.setup;
  let runLabel = "Run setup";
  if (checkpoint && checkpoint.configDigest === config?.digest) runLabel = `Retry from step ${checkpoint.stepIndex + 1}`;
  else if (matching && state.phase === "setup" && state.status === "ready") runLabel = "Run setup again";
  const needsAcknowledgement = Boolean(state?.outcomeUnknown) && !running;
  const acknowledged = needsAcknowledgement && Boolean(state.runId) && acknowledgedRunId === state.runId;

  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="lifecycle-dialog">
    <DialogHeader><DialogTitle>Worktree setup</DialogTitle><DialogDescription>{project.name} / {worktree.name}</DialogDescription></DialogHeader>
    {!detail && <p className="lifecycle-note" role="status">Reading setup configuration…</p>}
    {detail && !config && <p className="lifecycle-note">This worktree has no <code>{detail.file}</code>. Add one to run setup commands after a worktree is created and teardown commands before it is removed.</p>}
    {config?.error && <p className="lifecycle-error" role="alert">{config.error}</p>}
    {config && !config.error && <>
      <p className={`lifecycle-trust ${config.trusted ? "trusted" : ""}`}>{config.trusted
        ? <><CheckCircle aria-hidden="true" />You trusted this exact version of <code>{detail.file}</code>.</>
        : <><ShieldWarning aria-hidden="true" />Review these commands. Once trusted, they run as you, in this worktree, with your environment. Trust covers only the command lines in this exact file, and any change to it needs a new review. Scripts and package hooks those commands run are not reviewed and can change without one.</>}</p>
      <StepList title="Setup" steps={config.setup} current={matching && state.phase === "setup" ? state : null} />
      <StepList title="Teardown" steps={config.teardown} current={matching && state.phase === "teardown" ? state : null} />
    </>}
    {summary && <p className={`lifecycle-summary ${summary.tone}`} role="status" aria-live="polite">{config && !matching ? `For an earlier version of ${detail.file}: ` : ""}{summary.label}{state.error ? ` ${state.error}` : ""}</p>}
    {state?.output ? <pre ref={outputRef} className="lifecycle-output" tabIndex={0} /* NOSONAR S6845: a scrollable log must be reachable by keyboard */ aria-label={`${state.phase === "teardown" ? "Teardown" : "Setup"} output`}
      onScroll={(event) => { const element = event.currentTarget; pinnedRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24; }}>
      {state.outputTruncated ? "… earlier output was not kept\n" : ""}{state.output}</pre> : null}
    {needsAcknowledgement && <p className="lifecycle-note">Agent runs in this worktree wait until these processes are confirmed stopped or you acknowledge them.{state.phase === "teardown" ? " To run teardown again, remove the worktree again and acknowledge there." : ""}</p>}
    {needsAcknowledgement && <label className="lifecycle-acknowledge"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledgedRunId(event.target.checked ? state.runId : null)} />The last {state.phase}'s processes could not be confirmed stopped. I checked them.</label>}
    <DialogFooter>
      <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
      {running && <Button variant="destructive" disabled={busy} onClick={() => act("/api/worktrees/lifecycle/cancel")}>Cancel {detail.running}</Button>}
      {needsAcknowledgement && <Button variant="outline" disabled={busy || !acknowledged} onClick={() => act("/api/worktrees/lifecycle/acknowledge", { acknowledgeUnconfirmed: state.runId })}>Acknowledge</Button>}
      {!running && canTrust && config.setup.length > 0 && <Button variant="outline" disabled={busy} onClick={() => trust(false)}>Trust without running setup</Button>}
      {!running && canTrust && <Button disabled={busy} onClick={() => trust(config.setup.length > 0)}>{config.setup.length ? "Trust and run setup" : "Trust teardown"}</Button>}
      {canRun && <Button disabled={busy || (needsAcknowledgement && !acknowledged)} onClick={() => act("/api/worktrees/lifecycle/setup", acknowledged ? { acknowledgeUnconfirmed: state.runId } : {})}>{runLabel}</Button>}
    </DialogFooter>
  </DialogContent></Dialog>;
}

const TEARDOWN_CHOICE_LABELS = {
  retry: "Run teardown again from the step that did not finish",
  acknowledge: "The last attempt's processes could not be confirmed stopped. I checked them; run teardown again from the step that did not finish",
  remove: "The last attempt's processes could not be confirmed stopped. I checked them; remove the worktree",
  skip: "Remove without running teardown; its cleanup will not happen",
};
const UNCONFIRMED_SKIP_LABEL = "The last attempt's processes could not be confirmed stopped. I checked them; remove without running teardown, so its cleanup will not happen";

function choiceLabel(problem, choice) {
  if (choice === "skip" && problem.outcomeUnknown) return UNCONFIRMED_SKIP_LABEL;
  if (choice === "acknowledge" && !problem.teardown) return TEARDOWN_CHOICE_LABELS.remove;
  return TEARDOWN_CHOICE_LABELS[choice];
}

// The explicit next step after a teardown problem kept a worktree.
export function TeardownChoices({ problem, onChoose }) {
  if (!problem?.choices.length) return null;
  return <fieldset className="lifecycle-choices"><legend>Next attempt</legend>{problem.choices.map((choice) => <label key={choice} className="lifecycle-acknowledge">
    <input type="radio" name="teardown-choice" value={choice} checked={problem.choice === choice} onChange={() => onChoose(choice)} />
    {choiceLabel(problem, choice)}
  </label>)}</fieldset>;
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
