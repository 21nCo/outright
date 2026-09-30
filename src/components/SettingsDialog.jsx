import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Bell, Brain, Code, ShieldCheck, Trash } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/runtime-api";

export function SettingsDialog({ open, onOpenChange, settings, providers, templates, runtimeEvent, onSaved, onError }) {
  const [draft, setDraft] = useState(settings);
  const [templateDraft, setTemplateDraft] = useState({ title: "", prompt: "" });
  const [capacity, setCapacity] = useState(null);
  const [cleanupResult, setCleanupResult] = useState(null);
  const [archived, setArchived] = useState([]);
  const [archivedCursor, setArchivedCursor] = useState(null);
  const [showingOlderArchived, setShowingOlderArchived] = useState(false);
  const [loadingArchived, setLoadingArchived] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const cancelDeleteRef = useRef(null);
  const cleanupButtonRef = useRef(null);
  const archivedListRef = useRef(null);
  const backToNewestRef = useRef(null);
  const deleteTriggerRef = useRef(null);
  const restoreDeleteFocusRef = useRef(false);
  const restorePageFocusRef = useRef(false);
  const archivedRequestRef = useRef(0);
  const archiveSessionRef = useRef(0);
  const openedSettingsRef = useRef(settings);
  // A bootstrap refresh can replace settings while the dialog is open.
  // Only opening the dialog starts a new editing session.
  useEffect(() => { if (open) { openedSettingsRef.current = settings; setDraft(settings); } }, [open]);
  useLayoutEffect(() => { archiveSessionRef.current += 1; }, [open]);
  useEffect(() => { if (open) { setCleanupResult(null); setPendingDelete(null); setDeleting(false); setLoadingArchived(false); } }, [open]);
  useLayoutEffect(() => {
    if (!open) { restoreDeleteFocusRef.current = false; return; }
    if (pendingDelete) cancelDeleteRef.current?.focus();
    else if (restoreDeleteFocusRef.current) {
      restoreDeleteFocusRef.current = false;
      const trigger = deleteTriggerRef.current;
      (trigger?.isConnected ? trigger : cleanupButtonRef.current)?.focus();
    }
  }, [open, pendingDelete]);
  useLayoutEffect(() => {
    if (!open || !restorePageFocusRef.current) return;
    restorePageFocusRef.current = false;
    (archivedListRef.current?.querySelector("button") ?? backToNewestRef.current ?? cleanupButtonRef.current)?.focus();
  }, [open, archived, showingOlderArchived]);
  useEffect(() => {
    if (!open) return;
    let current = true;
    api("/api/capacity").then((value) => { if (current) setCapacity(value); }).catch((error) => { if (current) onError(error); });
    const request = ++archivedRequestRef.current;
    api("/api/retention/archived").then((value) => { if (current && request === archivedRequestRef.current) {
      setArchived(Array.isArray(value?.conversations) ? value.conversations : []);
      setArchivedCursor(value?.nextCursor ?? null);
      setShowingOlderArchived(false);
    } }).catch((error) => { if (current) onError(error); });
    return () => { current = false; archivedRequestRef.current++; };
  }, [open, onError]);
  useEffect(() => {
    if (!open || runtimeEvent?.type !== "capacity.changed") return;
    const session = archiveSessionRef.current;
    api("/api/capacity").then((value) => {
      if (session === archiveSessionRef.current) setCapacity(value);
    }).catch((error) => { if (session === archiveSessionRef.current) onError(error); });
  }, [open, runtimeEvent, onError]);
  async function refreshArchived() {
    const request = ++archivedRequestRef.current;
    const value = await api("/api/retention/archived");
    if (request !== archivedRequestRef.current) return;
    setArchived(Array.isArray(value?.conversations) ? value.conversations : []);
    setArchivedCursor(value?.nextCursor ?? null);
    setShowingOlderArchived(false);
  }
  async function loadMoreArchived() {
    if (!archivedCursor || loadingArchived) return;
    const request = archivedRequestRef.current;
    const session = archiveSessionRef.current;
    setLoadingArchived(true);
    try {
      const value = await api(`/api/retention/archived?cursor=${encodeURIComponent(archivedCursor)}`);
      if (request !== archivedRequestRef.current || session !== archiveSessionRef.current) return;
      restorePageFocusRef.current = true;
      setArchived(Array.isArray(value?.conversations) ? value.conversations : []);
      setArchivedCursor(value?.nextCursor ?? null);
      setShowingOlderArchived(true);
    } catch (error) {
      if (session === archiveSessionRef.current) { restorePageFocusRef.current = false; onError(error); }
    } finally { if (session === archiveSessionRef.current) setLoadingArchived(false); }
  }
  async function save() {
    const session = archiveSessionRef.current;
    // PATCH only fields this session edited. Another Settings session may have
    // tightened a quota or execution policy since this draft was opened.
    const patch = Object.fromEntries(Object.entries(draft).filter(([key, value]) =>
      value !== openedSettingsRef.current[key]));
    try {
      const updated = Object.keys(patch).length
        ? await api("/api/settings", { method: "PATCH", body: patch })
        : await api("/api/settings");
      if (session !== archiveSessionRef.current) {
        if (Object.keys(patch).length) onSaved(null, "settings");
        return;
      }
      onSaved(updated);
      onOpenChange(false);
    }
    catch (error) { if (session === archiveSessionRef.current) onError(error); }
  }
  async function saveTemplate() {
    const session = archiveSessionRef.current;
    try {
      await api("/api/templates", { method: "POST", body: templateDraft });
      if (session === archiveSessionRef.current) setTemplateDraft({ title: "", prompt: "" });
      onSaved(null, "templates");
    } catch (error) { if (session === archiveSessionRef.current) onError(error); }
  }
  async function deleteTemplate(id) {
    const session = archiveSessionRef.current;
    try { await api(`/api/templates/${id}`, { method: "DELETE" }); onSaved(null, "templates"); }
    catch (error) { if (session === archiveSessionRef.current) onError(error); }
  }
  async function cleanHistory() {
    const session = archiveSessionRef.current;
    try {
      const result = await api("/api/retention/cleanup", { method: "POST", body: {} });
      if (session !== archiveSessionRef.current) { onSaved(settings, "history"); return; }
      setCapacity(result.capacity);
      setCleanupResult(result.deferred
        ? `Deleted ${result.deleted} old archived ${result.deleted === 1 ? "chat" : "chats"}; ${result.deferred} queued for cleanup after active runs finish.`
        : `Deleted ${result.deleted} old archived ${result.deleted === 1 ? "chat" : "chats"}.`);
      await refreshArchived();
      onSaved(settings, "history");
    } catch (error) { if (session === archiveSessionRef.current) onError(error); }
  }
  async function deleteSelectedArchive() {
    if (!pendingDelete || deleting) return;
    const session = archiveSessionRef.current;
    const selected = pendingDelete;
    setDeleting(true);
    try {
      const result = await api("/api/retention/delete-archived", { method: "POST", body: { id: selected.id, confirmation: selected.id } });
      if (session !== archiveSessionRef.current) { onSaved(settings, "history"); return; }
      setCapacity(result.capacity);
      setCleanupResult(result.deferred ? `Archived chat “${selected.title}” is queued for cleanup after active runs finish.`
        : `Deleted archived chat “${selected.title}”.`);
      let refreshError;
      try { await refreshArchived(); }
      catch (error) {
        if (session === archiveSessionRef.current) setArchived((current) => current.filter((item) => item.id !== selected.id));
        refreshError = error;
      }
      if (session !== archiveSessionRef.current) { onSaved(settings, "history"); return; }
      restoreDeleteFocusRef.current = true;
      setPendingDelete(null);
      onSaved(settings, "history");
      if (refreshError) onError(refreshError);
    } catch (error) {
      if (session === archiveSessionRef.current) {
        onError(error);
        await refreshArchived().catch(onError);
      }
    } finally { if (session === archiveSessionRef.current) setDeleting(false); }
  }
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="settings-dialog"><DialogHeader><DialogTitle>Outright settings</DialogTitle><DialogDescription>Defaults for new conversations and local execution.</DialogDescription></DialogHeader><div className="settings-grid">
    <Setting icon={Brain} label="Default provider"><select value={draft.provider} onChange={(event) => setDraft({ ...draft, provider: event.target.value })}>{providers.map((provider) => <option key={provider.id} value={provider.id} disabled={!provider.available}>{provider.label}{provider.available ? "" : " (unavailable)"}</option>)}</select></Setting>
    <Setting icon={Brain} label="Default model"><Input value={draft.model ?? ""} onChange={(event) => setDraft({ ...draft, model: event.target.value })} placeholder="Provider default" /></Setting>
    <Setting icon={ShieldCheck} label="Approval policy"><select value={draft.approvalPolicy} onChange={(event) => setDraft({ ...draft, approvalPolicy: event.target.value })}><option value="read-only">Read only</option><option value="workspace-write">Workspace write</option><option value="danger-full-access">Full access</option></select></Setting>
    <Setting icon={Brain} label="Reasoning effort"><select value={draft.reasoningEffort} onChange={(event) => setDraft({ ...draft, reasoningEffort: event.target.value })}>{["low", "medium", "high", "xhigh"].map((value) => <option key={value}>{value}</option>)}</select></Setting>
    <Setting icon={Code} label="Editor"><select value={draft.editor} onChange={(event) => setDraft({ ...draft, editor: event.target.value })}><option value="zed">Zed</option><option value="code">VS Code</option><option value="cursor">Cursor</option><option value="finder">Finder</option></select></Setting>
    <Setting icon={Bell} label="Notifications"><span className="switch-row"><input type="checkbox" aria-label="Notify when runs finish" checked={draft.notifications} onChange={(event) => setDraft({ ...draft, notifications: event.target.checked })} /> Notify when runs finish</span></Setting>
    <Setting icon={Brain} label="Concurrent runs"><Input type="number" min="1" max="8" value={draft.maxConcurrentRuns} onChange={(event) => setDraft({ ...draft, maxConcurrentRuns: Number(event.target.value) })} /></Setting>
    <Setting icon={Brain} label="Queued runs"><Input type="number" min="1" max="256" value={draft.maxQueuedRuns} onChange={(event) => setDraft({ ...draft, maxQueuedRuns: Number(event.target.value) })} /></Setting>
    <Setting icon={Brain} label="Retained history (MiB)"><Input type="number" min="64" max="4096" value={draft.maxRetainedMiB} onChange={(event) => setDraft({ ...draft, maxRetainedMiB: Number(event.target.value) })} /></Setting>
    <Setting icon={Brain} label="Archived history age (days)"><Input type="number" min="1" max="3650" value={draft.retentionDays} onChange={(event) => setDraft({ ...draft, retentionDays: Number(event.target.value) })} /></Setting>
  </div><section className="template-settings"><header><div><strong>Capacity and retention</strong><small>Cleanup removes unpinned archived chats older than the saved age. You can also select a recent archived chat to delete now. Active and recoverable runs stay protected.</small></div></header>{capacity?.limits && <output className="capacity-status">{capacity.queued} of {capacity.limits.maxQueuedRuns} queued · {capacity.active} active · {capacity.recoverable} awaiting recovery · {capacityUsageText(capacity)} ({(capacity.limits.reservedRetainedBytes / 1048576).toFixed(0)} MiB reserved for active runs). CPU, memory and allocated disk use are unknown.</output>}<Button ref={cleanupButtonRef} variant="outline" onClick={cleanHistory}>Clean old archived history</Button>{cleanupResult && <output className="capacity-status">{cleanupResult}</output>}{archived.length > 0 && <div ref={archivedListRef} className="template-list archived-history-list" aria-label="Archived chats available to delete">{archived.map((item) => <div key={item.id}><span><strong>{item.title}</strong><small title={item.worktreePath}>{item.worktreePath} · Archived {new Date(item.updatedAt).toLocaleDateString()}</small></span><Button variant="outline" size="sm" aria-label={`Delete archived chat “${item.title}” in ${item.worktreePath} (${item.id})`} onClick={(event) => { deleteTriggerRef.current = event.currentTarget; setPendingDelete(item); }}>Delete now</Button></div>)}</div>}{showingOlderArchived && <Button ref={backToNewestRef} variant="outline" onClick={() => { restorePageFocusRef.current = true; refreshArchived().catch((error) => { restorePageFocusRef.current = false; onError(error); }); }}>Back to newest archived chats</Button>}{archivedCursor && <Button variant="outline" onClick={loadMoreArchived} disabled={loadingArchived}>{loadingArchived ? "Loading archived chats…" : "Next archived page"}</Button>}{pendingDelete && <fieldset className="archive-delete-confirm"><legend className="sr-only">Confirm archived chat deletion</legend><p>Delete “{pendingDelete.title}” in {pendingDelete.worktreePath} and its messages and run history permanently?</p><div><Button ref={cancelDeleteRef} variant="outline" onClick={() => { restoreDeleteFocusRef.current = true; setPendingDelete(null); }} disabled={deleting}>Cancel</Button><Button variant="destructive" onClick={deleteSelectedArchive} disabled={deleting}>Delete archived chat</Button></div></fieldset>}</section><section className="template-settings"><header><div><strong>Prompt templates</strong><small>Reusable instructions available from the composer.</small></div></header><div className="template-list">{templates.map((template) => <div key={template.id}><span><strong>{template.title}</strong><small>{template.prompt}</small></span><Button variant="ghost" size="icon-xs" aria-label={`Delete template ${template.title}`} onClick={() => deleteTemplate(template.id)}><Trash /></Button></div>)}</div><div className="new-template"><Input aria-label="Template name" value={templateDraft.title} onChange={(event) => setTemplateDraft({ ...templateDraft, title: event.target.value })} placeholder="Template name" /><Input aria-label="Template prompt" value={templateDraft.prompt} onChange={(event) => setTemplateDraft({ ...templateDraft, prompt: event.target.value })} placeholder="Prompt" /><Button variant="outline" onClick={saveTemplate} disabled={!templateDraft.title.trim() || !templateDraft.prompt.trim()}>Add template</Button></div></section><DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={save}>Save settings</Button></DialogFooter></DialogContent></Dialog>;
}

function Setting({ icon: Icon, label, children }) { return <label className="setting-row"><span><Icon />{label}</span>{children}</label>; }

function capacityUsageText(capacity) {
  if (capacity.migrationStatus === "error") return "Retained history migration paused; retrying · new work paused";
  if (typeof capacity.retainedBytes !== "number") return "Measuring retained history · new work paused";
  if (capacity.migrationStatus === "migrating") return "Indexing retained history · new work paused";
  const usage = `${(capacity.retainedBytes / 1048576).toFixed(1)} of ${(capacity.limits.maxRetainedBytes / 1048576).toFixed(0)} MiB retained`;
  if (capacity.cleanupPending) return `${usage} · archived cleanup in progress; new launches paused`;
  return `${usage} · ${(capacity.availableForNewWorkBytes / 1048576).toFixed(1)} MiB available for new work`;
}
