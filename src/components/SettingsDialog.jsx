import { useEffect, useState } from "react";
import { Bell, Brain, Code, ShieldCheck, Trash } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/runtime-api";

export function SettingsDialog({ open, onOpenChange, settings, providers, templates, onSaved, onError }) {
  const [draft, setDraft] = useState(settings);
  const [templateDraft, setTemplateDraft] = useState({ title: "", prompt: "" });
  const [capacity, setCapacity] = useState(null);
  const [cleanupResult, setCleanupResult] = useState(null);
  useEffect(() => { setDraft(settings); if (open) setCleanupResult(null); }, [settings, open]);
  useEffect(() => {
    if (!open) return;
    let current = true;
    api("/api/capacity").then((value) => { if (current) setCapacity(value); }).catch(onError);
    return () => { current = false; };
  }, [open, onError]);
  async function save() {
    try { onSaved(await api("/api/settings", { method: "PATCH", body: draft })); onOpenChange(false); }
    catch (error) { onError(error); }
  }
  async function saveTemplate() {
    try { await api("/api/templates", { method: "POST", body: templateDraft }); setTemplateDraft({ title: "", prompt: "" }); onSaved(await api("/api/settings"), true); }
    catch (error) { onError(error); }
  }
  async function cleanHistory() {
    try {
      const result = await api("/api/retention/cleanup", { method: "POST", body: {} });
      setCapacity(result.capacity);
      setCleanupResult(`Deleted ${result.deleted} old archived ${result.deleted === 1 ? "chat" : "chats"}.`);
      onSaved(settings, true);
    } catch (error) { onError(error); }
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
  </div><section className="template-settings"><header><div><strong>Capacity and retention</strong><small>Cleanup removes archived chats older than the saved age. Active and recoverable runs stay protected.</small></div></header>{capacity?.limits && <p role="status">{capacity.queued} of {capacity.limits.maxQueuedRuns} queued · {capacity.active} active · {capacity.recoverable} awaiting recovery · {(capacity.retainedBytes / 1048576).toFixed(1)} of {(capacity.limits.maxRetainedBytes / 1048576).toFixed(0)} MiB retained · {(capacity.availableForNewWorkBytes / 1048576).toFixed(1)} MiB available for new work ({(capacity.limits.reservedRetainedBytes / 1048576).toFixed(0)} MiB reserved for active runs). CPU, memory and allocated disk use are unknown.</p>}<Button variant="outline" onClick={cleanHistory}>Clean old archived history</Button>{cleanupResult && <p role="status">{cleanupResult}</p>}</section><section className="template-settings"><header><div><strong>Prompt templates</strong><small>Reusable instructions available from the composer.</small></div></header><div className="template-list">{templates.map((template) => <div key={template.id}><span><strong>{template.title}</strong><small>{template.prompt}</small></span><Button variant="ghost" size="icon-xs" aria-label={`Delete template ${template.title}`} onClick={() => api(`/api/templates/${template.id}`, { method: "DELETE" }).then(() => onSaved(settings, true)).catch(onError)}><Trash /></Button></div>)}</div><div className="new-template"><Input aria-label="Template name" value={templateDraft.title} onChange={(event) => setTemplateDraft({ ...templateDraft, title: event.target.value })} placeholder="Template name" /><Input aria-label="Template prompt" value={templateDraft.prompt} onChange={(event) => setTemplateDraft({ ...templateDraft, prompt: event.target.value })} placeholder="Prompt" /><Button variant="outline" onClick={saveTemplate} disabled={!templateDraft.title.trim() || !templateDraft.prompt.trim()}>Add template</Button></div></section><DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={save}>Save settings</Button></DialogFooter></DialogContent></Dialog>;
}

function Setting({ icon: Icon, label, children }) { return <label className="setting-row"><span><Icon />{label}</span>{children}</label>; }
