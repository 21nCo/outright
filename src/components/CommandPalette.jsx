import { useEffect, useMemo, useState } from "react";
import { ChatCircle, FolderOpen, GitBranch, MagnifyingGlass } from "@phosphor-icons/react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, query as buildQuery } from "@/lib/runtime-api";

export function CommandPalette({ open, onOpenChange, projects, onSelectProject, onSelectConversation }) {
  const [query, setQuery] = useState("");
  const [remote, setRemote] = useState({ conversations: [], messages: [] });
  useEffect(() => {
    if (!open) setQuery("");
    if (!open || query.trim().length < 2) { setRemote({ conversations: [], messages: [] }); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(() => api(buildQuery("/api/search", { q: query }), { signal: controller.signal }).then(setRemote).catch(() => {}), 180);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [open, query]);
  const local = useMemo(() => {
    const needle = query.toLowerCase();
    return projects.flatMap((project) => [
      ...(project.name.toLowerCase().includes(needle) ? [{ type: "project", project }] : []),
      ...project.worktrees.filter((worktree) => `${worktree.name} ${worktree.branch}`.toLowerCase().includes(needle)).map((worktree) => ({ type: "worktree", project, worktree })),
    ]).slice(0, 12);
  }, [projects, query]);
  function select(item) { onOpenChange(false); if (item.type === "conversation") onSelectConversation(item.conversation); else onSelectProject(item.project, item.worktree); }
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="command-dialog" showCloseButton={false}><DialogHeader className="sr-only"><DialogTitle>Command palette</DialogTitle><DialogDescription>Search projects, worktrees, and conversations.</DialogDescription></DialogHeader><div className="command-search"><MagnifyingGlass /><Input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search projects, worktrees, chats…" /></div><div className="command-results">
    {!query && <div className="command-hint"><span><kbd>⌘</kbd><kbd>K</kbd> Search anywhere</span><span><kbd>⌘</kbd><kbd>N</kbd> New chat</span><span><kbd>⌘</kbd><kbd>⇧</kbd><kbd>T</kbd> Terminal</span></div>}
    {local.map((item) => <button key={`${item.type}:${item.project.id}:${item.worktree?.id ?? ""}`} onClick={() => select(item)}>{item.type === "project" ? <FolderOpen /> : <GitBranch />}<span><strong>{item.type === "project" ? item.project.name : item.worktree.name}</strong><small>{item.project.name}{item.worktree ? ` · ${item.worktree.branch}` : ""}</small></span></button>)}
    {remote.conversations.map((conversation) => <button key={conversation.id} onClick={() => select({ type: "conversation", conversation })}><ChatCircle /><span><strong>{conversation.title}</strong><small>{conversation.provider} · {conversation.worktreePath}</small></span></button>)}
    {query.length >= 2 && !local.length && !remote.conversations.length && <p className="no-results">No matching projects or conversations.</p>}
  </div></DialogContent></Dialog>;
}
