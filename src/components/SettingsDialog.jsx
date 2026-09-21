import { useEffect, useState } from "react";
import { Bell, Brain, Code, ShieldCheck, Trash } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/runtime-api";

export function SettingsDialog({ open, onOpenChange, settings, providers, templates, onSaved, onError }) {
  const [draft, setDraft] = useState(settings);
  const [templateDraft, setTemplateDraft] = useState({ title: "", prompt: "" });
  useEffect(() => setDraft(settings), [settings, open]);
  async function save() {
    try { onSaved(await api("/api/settings", { method: "PATCH", body: draft })); onOpenChange(false); }
    catch (error) { onError(error); }
  }
  async function saveTemplate() {
    try { await api("/api/templates", { method: "POST", body: templateDraft }); setTemplateDraft({ title: "", prompt: "" }); onSaved(await api("/api/settings"), true); }
    catch (error) { onError(error); }
  }
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="settings-dialog"><DialogHeader><DialogTitle>Outright settings</DialogTitle><DialogDescription>Defaults for new conversations and local execution.</DialogDescription></DialogHeader><div className="settings-grid">
    <Setting icon={Brain} label="Default provider"><select value={draft.provider} onChange={(event) => setDraft({ ...draft, provider: event.target.value })}>{providers.map((provider) => <option key={provider.id} value={provider.id} disabled={!provider.available}>{provider.label}{provider.available ? "" : " (unavailable)"}</option>)}</select></Setting>
    <Setting icon={Brain} label="Default model"><Input value={draft.model ?? ""} onChange={(event) => setDraft({ ...draft, model: event.target.value })} placeholder="Provider default" /></Setting>
    <Setting icon={ShieldCheck} label="Approval policy"><select value={draft.approvalPolicy} onChange={(event) => setDraft({ ...draft, approvalPolicy: event.target.value })}><option value="read-only">Read only</option><option value="workspace-write">Workspace write</option><option value="danger-full-access">Full access</option></select></Setting>
    <Setting icon={Brain} label="Reasoning effort"><select value={draft.reasoningEffort} onChange={(event) => setDraft({ ...draft, reasoningEffort: event.target.value })}>{["low", "medium", "high", "xhigh"].map((value) => <option key={value}>{value}</option>)}</select></Setting>
    <Setting icon={Code} label="Editor"><select value={draft.editor} onChange={(event) => setDraft({ ...draft, editor: event.target.value })}><option value="zed">Zed</option><option value="code">VS Code</option><option value="cursor">Cursor</option><option value="finder">Finder</option></select></Setting>
    <Setting icon={Bell} label="Notifications"><label className="switch-row"><input type="checkbox" checked={draft.notifications} onChange={(event) => setDraft({ ...draft, notifications: event.target.checked })} /> Notify when runs finish</label></Setting>
    <Setting icon={Brain} label="Concurrent runs"><Input type="number" min="1" max="8" value={draft.maxConcurrentRuns} onChange={(event) => setDraft({ ...draft, maxConcurrentRuns: Number(event.target.value) })} /></Setting>
  </div><section className="template-settings"><header><div><strong>Prompt templates</strong><small>Reusable instructions available from the composer.</small></div></header><div className="template-list">{templates.map((template) => <div key={template.id}><span><strong>{template.title}</strong><small>{template.prompt}</small></span><Button variant="ghost" size="icon-xs" onClick={() => api(`/api/templates/${template.id}`, { method: "DELETE" }).then(() => onSaved(settings, true)).catch(onError)}><Trash /></Button></div>)}</div><div className="new-template"><Input value={templateDraft.title} onChange={(event) => setTemplateDraft({ ...templateDraft, title: event.target.value })} placeholder="Template name" /><Input value={templateDraft.prompt} onChange={(event) => setTemplateDraft({ ...templateDraft, prompt: event.target.value })} placeholder="Prompt" /><Button variant="outline" onClick={saveTemplate} disabled={!templateDraft.title.trim() || !templateDraft.prompt.trim()}>Add</Button></div></section><DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={save}>Save settings</Button></DialogFooter></DialogContent></Dialog>;
}

function Setting({ icon: Icon, label, children }) { return <label className="setting-row"><span><Icon />{label}</span>{children}</label>; }
