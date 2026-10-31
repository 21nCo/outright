import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { WarningCircle } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { WindowedDiff } from "@/components/WindowedDiff";
import { api, query } from "@/lib/runtime-api";
import { RESTORE_PAGE_SIZE, checkpointCountsText, checkpointTitle, groupCheckpointEntries, initialRestoreSelection,
  restoreBlockedReason, restoreChangeText, restoreGroupText, restoreSelection, toggleRestorePath } from "@/lib/worktree-checkpoints";

const LABEL_FIELD = ".checkpoint-create input";
const VIEW_HEADING = ".checkpoint-view-heading";
const FINISH = '[data-checkpoint-action="finish"]';

// Take, inspect and restore checkpoints of one worktree. A restore is always
// previewed first and confirmed against that exact preview.
export function WorktreeCheckpointsDialog({ open, onOpenChange, project, worktree, events }) {
  const [detail, setDetail] = useState(null);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  // null, { kind: "inspect", ... } or { kind: "preview", ... }
  const [view, setView] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [failure, setFailure] = useState(null);
  // Advanced on close: an action finishing after it changes nothing.
  const sessionRef = useRef(0);
  const canonicalRef = useRef(null);
  // A step that unmounts the focused control names where focus goes next:
  // a selector in the dialog (one selector, no commas).
  const contentRef = useRef(null);
  const focusNextRef = useRef(null);
  const frameRef = useRef(0);
  const returnFocusRef = useRef(LABEL_FIELD);
  const focusNext = (selector) => { focusNextRef.current = selector; };
  // Reads overlap (open, events, reconnect, actions); only an answer, list or
  // failure, to a read issued after the one shown replaces it, and closing
  // discards every read issued before or after it in that session.
  const issuedRef = useRef(0);
  const shownRef = useRef(0);
  const target = { projectId: project.id, worktreePath: worktree.path };
  // `focus` names where focus goes once the list is shown.
  const load = useCallback(async (focus) => {
    const generation = ++issuedRef.current;
    const session = sessionRef.current;
    const stale = () => session !== sessionRef.current || generation <= shownRef.current;
    try {
      const next = await api(query("/api/worktrees/checkpoints", { projectId: project.id, path: worktree.path }));
      if (stale()) return;
      shownRef.current = generation;
      canonicalRef.current = next.worktreePath;
      if (typeof focus === "string") focusNextRef.current = focus;
      setLoadError("");
      setDetail(next);
    } catch (error) {
      if (stale()) return;
      shownRef.current = generation;
      setLoadError(error.status === 404 && error.message === "API route not found"
        ? "Checkpoints are not available in this version of the Outright runtime." : `Checkpoints could not be read: ${error.message}`);
    }
  }, [project.id, worktree.path]);

  useLayoutEffect(() => {
    // A target that is gone or disabled (busy, unconfirmed) falls back to an
    // enabled control, so focus never drops out of the dialog (nor a pending action's trigger).
    const popup = contentRef.current;
    const selector = focusNextRef.current ?? (popup?.contains(document.activeElement) && document.activeElement.disabled ? LABEL_FIELD : null);
    if (!open || !selector || !popup) return;
    focusNextRef.current = null;
    const element = [selector, LABEL_FIELD, VIEW_HEADING, "button"].map((item) => popup.querySelector(`${item}:not(:disabled)`)).find(Boolean);
    element?.focus();
    // The dialog refocuses itself a frame after a focused control is removed;
    // that must not undo a move made in between.
    cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => { if (document.activeElement === popup && element?.isConnected && !element.disabled) element.focus(); });
  });

  useEffect(() => {
    if (!open) { setDetail(null); setView(null); setNotice(""); setConfirmDelete(null); setLoadError(""); setBusy(false); setFailure(null); return undefined; }
    void load();
    const onChanged = (event) => { if ([worktree.path, canonicalRef.current].includes(event.detail?.worktreePath)) void load(); };
    const onReconnect = () => void load();
    events.addEventListener("checkpoints", onChanged);
    events.addEventListener("reconnect", onReconnect);
    return () => {
      events.removeEventListener("checkpoints", onChanged);
      events.removeEventListener("reconnect", onReconnect);
      shownRef.current = issuedRef.current;
      sessionRef.current += 1;
      focusNextRef.current = null;
    };
  }, [open, load, events, worktree.path]);

  // A changed label or view is a new intent, so Retry no longer repeats the old one.
  useEffect(() => setFailure(null), [label, view]);
  // `work` gets `live()`, false once the dialog closed after it started. A failure
  // stays until an action succeeds; the list is reread so Retry starts from it.
  async function act(work) {
    const session = sessionRef.current;
    const live = () => session === sessionRef.current;
    setBusy(true);
    try { await work(live); if (live()) setFailure(null); }
    catch (error) { if (live()) { setFailure({ message: error.message, retry: work }); void load(); } }
    finally { if (live()) setBusy(false); }
  }
  const capture = () => act(async (live) => {
    const { checkpoint } = await api("/api/worktrees/checkpoints", { method: "POST", body: { ...target, label } });
    if (!live()) return;
    setLabel("");
    setNotice(`Checkpoint taken: ${checkpointCountsText(checkpoint.counts)}.`);
    await load();
  });
  // Back returns focus to the control (`from`, a selector) that opened a view.
  const inspect = (checkpoint) => act(async (live) => {
    const contents = await api(query("/api/worktrees/checkpoints/inspect", { projectId: project.id, path: worktree.path, id: checkpoint.id }));
    if (!live()) return;
    returnFocusRef.current = `[data-checkpoint-action="inspect:${checkpoint.id}"]`;
    setView({ kind: "inspect", ...contents });
    focusNext(VIEW_HEADING);
  });
  // `resume` previews finishing a restore that did not finish.
  async function openPreview(live, id, message = "", resume = false, from = null) {
    const preview = await api("/api/worktrees/checkpoints/preview", { method: "POST", body: { ...target, id, ...(resume ? { resume } : {}) } });
    if (!live()) return;
    if (from) returnFocusRef.current = from;
    setView({ kind: "preview", preview, selected: initialRestoreSelection(preview.entries), acknowledged: false, shown: RESTORE_PAGE_SIZE, diff: null });
    setNotice(message);
    focusNext(VIEW_HEADING);
  }
  const closeView = () => { setView(null); focusNext(returnFocusRef.current); };
  const restore = () => act(async (live) => {
    const { preview, selected, acknowledged } = view;
    let stopped = false;
    try {
      const result = await api("/api/worktrees/checkpoints/restore", { method: "POST", body: { ...target, id: preview.checkpoint.id,
        planDigest: preview.planDigest, ...restoreSelection(preview.entries, selected), ...(preview.resume ? { resume: true } : {}),
        acknowledgeTerminals: acknowledged ? preview.terminals.map((item) => item.id) : [] } });
      if (!live()) return;
      setView(null);
      setNotice(`${preview.resume ? "Finished the restore of" : "Restored"} ${result.restored} ${result.restored === 1 ? "path" : "paths"}. “${checkpointTitle(result.safetyCheckpoint)}” holds what was there before.`);
      focusNext(LABEL_FIELD);
    } catch (error) {
      const code = error.payload?.code;
      // A restore that stopped part way is finished or kept from the list,
      // and a terminal opened since the preview is listed in a new one.
      if (!live()) return;
      if (code === "CHECKPOINT_RESTORE_INTERRUPTED") { setView(null); stopped = true; }
      if (code === "CHECKPOINT_TERMINALS_UNACKNOWLEDGED") {
        await openPreview(live, preview.checkpoint.id, "A terminal was opened in this worktree after the preview. Confirm the terminals before restoring.", preview.resume);
      } else if (code === "CHECKPOINT_PLAN_CHANGED") {
        await openPreview(live, preview.checkpoint.id, "The worktree changed after the preview. Review this updated preview before restoring.", preview.resume);
      } else if (!stopped) throw error;
    } finally {
      if (live()) await load();
      if (stopped && live()) focusNext(FINISH);
    }
  });
  const keepFiles = () => act(async (live) => {
    await api("/api/worktrees/checkpoints/recover", { method: "POST", body: { ...target, action: "keep" } });
    if (!live()) return;
    setView(null);
    setNotice("The files were kept as they are.");
    await load();
    focusNext(LABEL_FIELD);
  });
  const remove = (checkpoint) => act(async (live) => {
    await api("/api/worktrees/checkpoints", { method: "DELETE", body: { ...target, id: checkpoint.id } });
    if (!live()) return;
    setConfirmDelete(null);
    setNotice(`Deleted “${checkpointTitle(checkpoint)}”.`);
    await load();
    focusNext(LABEL_FIELD);
  });
  const askDelete = (id) => { setConfirmDelete(id); focusNext('[data-checkpoint-action="keep"]'); };
  const keepCheckpoint = (id) => { setConfirmDelete(null); focusNext(`[data-checkpoint-action="delete:${id}"]`); };
  // `side` "index" shows how the staged content changes, "files" the file.
  const showDiff = (path, side) => act(async (live) => {
    const { diff, tooLarge } = await api(query("/api/worktrees/checkpoints/diff", { projectId: project.id, path: worktree.path,
      id: view.preview.checkpoint.id, tree: side === "index" ? view.preview.currentIndexTree : view.preview.currentTree, file: path, side }));
    if (live()) setView((current) => current?.preview === view.preview ? { ...current, diff: { path, side, text: tooLarge ? "This difference is too large to show." : diff || "No textual difference." } } : current);
  });

  const interrupted = detail?.restore?.status === "interrupted" ? detail.restore : null;
  const byId = new Map((detail?.checkpoints ?? []).map((checkpoint) => [checkpoint.id, checkpoint]));
  const named = (id) => (byId.get(id) ? `“${checkpointTitle(byId.get(id))}”` : "the checkpoint");

  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent ref={contentRef} className="lifecycle-dialog checkpoint-dialog">
    <DialogHeader><DialogTitle>Checkpoints</DialogTitle><DialogDescription>{project.name} / {worktree.name}</DialogDescription></DialogHeader>
    <p className={notice ? "lifecycle-summary" : "lifecycle-summary sr-only"} role="status" aria-live="polite">{notice}</p>
    {loadError && <div className="lifecycle-error" role="alert"><p>{loadError}</p>
      <Button size="sm" variant="outline" data-checkpoint-action="retry" onClick={() => void load(LABEL_FIELD)}>Retry</Button></div>}
    {failure && <div className="lifecycle-error" role="alert"><p>{failure.message}</p>
      <Button size="sm" variant="outline" data-checkpoint-action="retry-action" disabled={busy} onClick={() => void act(failure.retry)}>Retry</Button></div>}
    {!detail && !loadError && <p className="lifecycle-note" role="status">Reading checkpoints…</p>}
    {detail?.restore?.status === "running" && <p className="lifecycle-note" role="status">A restore is running in this worktree. Agent runs, setup and Git changes here wait until it finishes.</p>}
    {interrupted && !view && <div className="lifecycle-error" role="alert">
      <p>{interrupted.unreadable ? "A restore did not finish, and its record cannot be read." : `Restoring ${named(interrupted.checkpointId)} did not finish; some of its ${interrupted.paths} paths may already be restored.`} {capitalized(named(interrupted.safetyCheckpointId))} holds what was there before. Agent runs, setup and Git changes in this worktree wait until you finish the restore or keep the files.</p>
      {interrupted.ownerUnconfirmed && <p>Git processes the restore started are not confirmed stopped yet. Finishing or keeping becomes possible once they are.</p>}
      <div className="checkpoint-actions">
        {!interrupted.unreadable && <Button size="sm" data-checkpoint-action="finish" disabled={busy || interrupted.ownerUnconfirmed} onClick={() => act((live) => openPreview(live, interrupted.checkpointId, "", true, FINISH))}>Finish restore…</Button>}
        <Button size="sm" variant="outline" disabled={busy || interrupted.ownerUnconfirmed} onClick={keepFiles}>Keep files as they are</Button>
      </div>
    </div>}
    {detail && !view && <>
      <p className="lifecycle-note">A checkpoint records staged changes, unstaged changes and untracked files. Files Git ignores are not recorded, and a restore never changes them. Untracked files can contain secrets: checkpoints stay in this repository's local Git data and are removed with the worktree. The newest {detail.limits.perWorktree} are kept.</p>
      <form className="checkpoint-create" onSubmit={(event) => { event.preventDefault(); void capture(); }}>
        <Input aria-label="Checkpoint label (optional)" placeholder="Label (optional)" maxLength={120} value={label} onChange={(event) => setLabel(event.target.value)} />
        <Button type="submit" disabled={busy}>Take checkpoint</Button>
      </form>
      {detail.checkpoints.length ? <ul className="checkpoint-list" aria-label="Checkpoints">{detail.checkpoints.map((checkpoint) => <li key={checkpoint.id}>
        <span className="checkpoint-copy"><strong>{checkpointTitle(checkpoint)}</strong>
          <small>{checkpoint.createdAt ? new Date(checkpoint.createdAt).toLocaleString() : ""}{checkpoint.branch ? ` · ${checkpoint.branch}` : ""}{checkpoint.head ? ` @ ${checkpoint.head.slice(0, 7)}` : ""} · {checkpointCountsText(checkpoint.counts)}</small></span>
        <span className="checkpoint-actions">
          {confirmDelete === checkpoint.id
            ? <><Button size="xs" variant="destructive" disabled={busy} onClick={() => remove(checkpoint)}>Confirm delete</Button><Button size="xs" variant="outline" data-checkpoint-action="keep" onClick={() => keepCheckpoint(checkpoint.id)}>Keep</Button></>
            : <>{!checkpoint.unreadable && <><Button size="xs" variant="outline" data-checkpoint-action={`inspect:${checkpoint.id}`} disabled={busy} onClick={() => inspect(checkpoint)} aria-label={`Inspect ${checkpointTitle(checkpoint)}`}>Inspect</Button>
              <Button size="xs" variant="outline" data-checkpoint-action={`restore:${checkpoint.id}`} disabled={busy || Boolean(interrupted)} onClick={() => act((live) => openPreview(live, checkpoint.id, "", false, `[data-checkpoint-action="restore:${checkpoint.id}"]`))} aria-label={`Restore ${checkpointTitle(checkpoint)}`}>Restore…</Button></>}
              <Button size="xs" variant="ghost" data-checkpoint-action={`delete:${checkpoint.id}`} disabled={busy} onClick={() => askDelete(checkpoint.id)} aria-label={`Delete ${checkpointTitle(checkpoint)}`}>Delete</Button></>}
        </span>
      </li>)}</ul> : <p className="lifecycle-note">No checkpoints yet.</p>}
    </>}
    {view?.kind === "inspect" && <InspectView view={view} />}
    {view?.kind === "preview" && <PreviewView view={view} setView={setView} busy={busy} onDiff={showDiff} />}
    <DialogFooter>
      {view ? <Button variant="outline" onClick={closeView}>Back</Button> : <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>}
      {view?.kind === "preview" && view.preview.resume && !view.preview.entries.length && <Button disabled={busy} onClick={keepFiles}>Done</Button>}
      {view?.kind === "preview" && view.preview.entries.length > 0 && <Button variant="destructive" disabled={busy || Boolean(restoreBlockedReason(view.preview, view.selected, view.acknowledged))} onClick={restore}>
        {view.preview.resume ? "Finish restoring" : "Restore"} {view.selected.size} {view.selected.size === 1 ? "path" : "paths"}</Button>}
    </DialogFooter>
  </DialogContent></Dialog>;
}

function capitalized(text) { return text.charAt(0).toUpperCase() + text.slice(1); }

function InspectView({ view }) {
  const groups = groupCheckpointEntries(view.entries);
  return <section className="checkpoint-inspect" aria-label={`Contents of ${checkpointTitle(view.checkpoint)}`}>
    <h3 className="checkpoint-view-heading" tabIndex={-1}>{checkpointTitle(view.checkpoint)}</h3>
    {!view.entries.length && <p className="lifecycle-note">This checkpoint has no changes from its commit.</p>}
    {[["staged", "Staged"], ["unstaged", "Unstaged"], ["untracked", "Untracked"]].map(([key, title]) => groups[key].length > 0 && <section key={key} aria-label={title}>
      <h4>{title} ({groups[key].length})</h4>
      <ul>{groups[key].map((entry) => <li key={`${key}:${entry.path}`}><code>{entry.originalPath ? `${entry.originalPath} → ${entry.path}` : entry.path}</code><small>{STATUS[entry.status] ?? entry.status}</small></li>)}</ul>
    </section>)}
    {view.truncated && <p className="lifecycle-note">Only the first {view.entries.length} paths are listed.</p>}
  </section>;
}
const STATUS = { A: "added", M: "modified", D: "deleted", R: "renamed", T: "type changed" };

function PreviewView({ view, setView, busy, onDiff }) {
  const { preview, selected, shown } = view;
  const blocked = restoreBlockedReason(preview, selected, view.acknowledged);
  const update = (change) => setView((current) => current?.kind === "preview" ? { ...current, ...change(current) } : current);
  const choosable = preview.entries.filter((entry) => !entry.blocked);
  return <section className="checkpoint-preview" aria-label={`Restore ${checkpointTitle(preview.checkpoint)}`}>
    <h3 className="checkpoint-view-heading" tabIndex={-1}>{preview.resume ? "Finish restoring" : "Restore"} “{checkpointTitle(preview.checkpoint)}”?</h3>
    {preview.resume && <p className="lifecycle-note">Only the paths the unfinished restore was restoring are listed, compared with the worktree as it is now, including anything changed since it stopped.</p>}
    <p className="lifecycle-note">These are the exact changes a restore makes to this worktree. Before it changes anything, Outright takes a checkpoint of the current state, so the restore can be undone. The branch and its commits do not change.</p>
    {preview.head.moved && <p className="checkpoint-warning"><WarningCircle aria-hidden="true" /><span>HEAD has moved since this checkpoint ({preview.head.checkpoint?.slice(0, 7) ?? "no commit"} → {preview.head.current?.slice(0, 7) ?? "no commit"}). Restored index entries are staged against the current HEAD.</span></p>}
    {preview.blockers.length > 0 && <div className="lifecycle-error" role="alert"><p>Restore is not possible now:</p><ul>{preview.blockers.map((item) => <li key={item.code}>{item.message}</li>)}</ul></div>}
    {preview.terminals.length > 0 && <label className="lifecycle-acknowledge"><input type="checkbox" checked={view.acknowledged} onChange={(event) => update(() => ({ acknowledged: event.target.checked }))} />
      {preview.terminals.length === 1 ? "A terminal is" : `${preview.terminals.length} terminals are`} open in this worktree ({preview.terminals.map((item) => item.name).join(", ")}). Nothing running in {preview.terminals.length === 1 ? "it" : "them"} is writing files during the restore.</label>}
    {!preview.entries.length ? <p className="lifecycle-note">{preview.resume ? "Everything the restore was restoring is already in place. Choose Done to finish." : "The worktree already matches this checkpoint."}</p> : <fieldset className="checkpoint-paths">
      <legend>Paths to restore ({selected.size} of {choosable.length} chosen)</legend>
      <div className="checkpoint-actions">
        <Button size="xs" variant="outline" onClick={() => update(() => ({ selected: initialRestoreSelection(preview.entries) }))}>Choose all</Button>
        <Button size="xs" variant="outline" onClick={() => update(() => ({ selected: new Set() }))}>Choose none</Button>
      </div>
      <ul>{preview.entries.slice(0, shown).map((entry) => <li key={entry.path} className={entry.blocked ? "blocked" : undefined}>
        <label><input type="checkbox" disabled={Boolean(entry.blocked)} checked={selected.has(entry.path)}
          onChange={(event) => update((current) => ({ selected: toggleRestorePath(preview.entries, current.selected, entry.path, event.target.checked) }))} />
          <code>{entry.path}</code><small>{restoreChangeText(entry)}{entry.blocked ? ` · Not offered: ${entry.blocked}` : ""}{restoreGroupText(entry) ? ` · ${restoreGroupText(entry)}` : ""}</small></label>
        <span className="checkpoint-actions">
          {entry.file && <Button size="xs" variant="ghost" disabled={busy} onClick={() => onDiff(entry.path, "files")} aria-label={`Show file difference for ${entry.path}`}>File difference</Button>}
          {entry.index && <Button size="xs" variant="ghost" disabled={busy} onClick={() => onDiff(entry.path, "index")} aria-label={`Show staged difference for ${entry.path}`}>Staged difference</Button>}
        </span>
      </li>)}</ul>
      {shown < preview.entries.length && <Button size="xs" variant="outline" onClick={() => update((current) => ({ shown: current.shown + RESTORE_PAGE_SIZE }))}>Show {Math.min(RESTORE_PAGE_SIZE, preview.entries.length - shown)} more of {preview.entries.length - shown}</Button>}
    </fieldset>}
    {view.diff && <div className="checkpoint-diff"><WindowedDiff key={`${view.diff.side}:${view.diff.path}`} diff={view.diff.text} label={`${view.diff.side === "index" ? "Staged difference" : "File difference"} restoring ${view.diff.path}`} /></div>}
    {blocked && preview.entries.length > 0 && <p className="lifecycle-note" role="status">{blocked}</p>}
  </section>;
}
