import { useEffect, useMemo, useRef, useState } from "react";
import { ChatCircle, FolderOpen, GitBranch, MagnifyingGlass } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, query as buildQuery } from "@/lib/runtime-api";

export function CommandPalette({ open, onOpenChange, projects, onSelectProject, onSelectConversation }) {
  const [query, setQuery] = useState("");
  const [remote, setRemote] = useState({ query: "", conversations: [], messages: [], loading: false, error: null });
  const [searchAttempt, setSearchAttempt] = useState(0);
  const [activeIndex, setActiveIndex] = useState(-1);
  const resultsRef = useRef(null);
  const normalizedQuery = query.trim();
  useEffect(() => {
    if (!open) setQuery("");
    if (!open || normalizedQuery.length < 2) { setRemote({ query: normalizedQuery, conversations: [], messages: [], loading: false, error: null }); return; }
    const controller = new AbortController();
    setRemote({ query: normalizedQuery, conversations: [], messages: [], loading: true, error: null });
    const timer = window.setTimeout(() => api(buildQuery("/api/search", { q: normalizedQuery }), { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setRemote({ query: normalizedQuery, ...result, loading: false, error: null }); })
      .catch(() => { if (!controller.signal.aborted) setRemote({ query: normalizedQuery, conversations: [], messages: [], loading: false, error: "Conversation search failed." }); }), 180);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [open, normalizedQuery, searchAttempt]);
  const local = useMemo(() => {
    const needle = normalizedQuery.toLowerCase();
    if (!needle) return [];
    return projects.flatMap((project) => [
      ...(project.name.toLowerCase().includes(needle) ? [{ type: "project", project }] : []),
      ...project.worktrees.filter((worktree) => `${worktree.name} ${worktree.branch}`.toLowerCase().includes(needle)).map((worktree) => ({ type: "worktree", project, worktree })),
    ]).slice(0, 12);
  }, [projects, normalizedQuery]);
  const remoteConversations = remote.query === normalizedQuery ? remote.conversations : [];
  const remoteError = remote.query === normalizedQuery ? remote.error : null;
  const results = useMemo(() => [
    ...local,
    ...remoteConversations.map((conversation) => ({ type: "conversation", conversation })),
  ], [local, remoteConversations]);
  useEffect(() => { setActiveIndex(results.length ? 0 : -1); }, [open, results]);
  function select(item) { if (!item) return; onOpenChange(false); if (item.type === "conversation") onSelectConversation(item.conversation); else onSelectProject(item.project, item.worktree); }
  function handleKeyDown(event) {
    if (event.key === "Escape") { onOpenChange(false); return; }
    if (!results.length) return;
    let next = activeIndex;
    if (event.key === "ArrowDown") next = (activeIndex + 1 + results.length) % results.length;
    else if (event.key === "ArrowUp") next = (activeIndex - 1 + results.length) % results.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = results.length - 1;
    else if (event.key === "Enter" && activeIndex >= 0 && activeIndex < results.length) { event.preventDefault(); select(results[activeIndex]); return; }
    else return;
    event.preventDefault();
    setActiveIndex(next);
    resultsRef.current?.querySelector(`[data-result-index="${next}"]`)?.scrollIntoView({ block: "nearest" });
  }
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="command-dialog" showCloseButton={false}><DialogHeader className="sr-only"><DialogTitle>Command palette</DialogTitle><DialogDescription>Search projects, worktrees, and conversations.</DialogDescription></DialogHeader><div className="command-search"><MagnifyingGlass /><Input autoFocus role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls="command-results" aria-activedescendant={activeIndex >= 0 && activeIndex < results.length ? `command-result-${activeIndex}` : undefined} aria-label="Search projects, worktrees, and conversations" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={handleKeyDown} placeholder="Search projects, worktrees, chats…" /></div><div className="command-results" ref={resultsRef}>
    {!normalizedQuery && <div className="command-hint"><span><kbd>⌘</kbd><kbd>K</kbd> Search anywhere</span><span><kbd>⌘</kbd><kbd>N</kbd> New chat</span><span><kbd>⌘</kbd><kbd>⇧</kbd><kbd>T</kbd> Terminal</span></div>}
    <div className="command-options" id="command-results" role="listbox" aria-label="Search results">
    {results.map((item, index) => item.type === "conversation"
      ? <button id={`command-result-${index}`} data-result-index={index} role="option" aria-selected={activeIndex === index} className={activeIndex === index ? "is-active" : ""} tabIndex={-1} key={item.conversation.id} onMouseMove={() => setActiveIndex(index)} onClick={() => select(item)}><ChatCircle /><span><strong>{item.conversation.title}</strong><small>{item.conversation.provider} · {item.conversation.worktreePath}</small></span></button>
      : <button id={`command-result-${index}`} data-result-index={index} role="option" aria-selected={activeIndex === index} className={activeIndex === index ? "is-active" : ""} tabIndex={-1} key={`${item.type}:${item.project.id}:${item.worktree?.id ?? ""}`} onMouseMove={() => setActiveIndex(index)} onClick={() => select(item)}>{item.type === "project" ? <FolderOpen /> : <GitBranch />}<span><strong>{item.type === "project" ? item.project.name : item.worktree.name}</strong><small>{item.project.name}{item.worktree ? ` · ${item.worktree.branch}` : ""}</small></span></button>)}
    </div>
    {normalizedQuery.length >= 2 && !remote.loading && remoteError && <div className="command-error"><span>{results.length ? "Conversation search failed. Showing local matches only." : "Search failed. Try again."}</span><Button size="sm" variant="outline" onClick={() => setSearchAttempt((current) => current + 1)}>Retry search</Button></div>}
    {normalizedQuery.length >= 2 && !remote.loading && !remoteError && !results.length && <p className="no-results">No matching projects or conversations.</p>}
    <span className="sr-only" role="status" aria-live="polite">{!normalizedQuery ? "Type to search" : remote.loading ? "Searching" : remoteError ? (results.length ? `Conversation search failed. Showing ${results.length} local results. Retry search available.` : "Search failed. Retry search available.") : `${results.length} results`}</span>
  </div></DialogContent></Dialog>;
}
