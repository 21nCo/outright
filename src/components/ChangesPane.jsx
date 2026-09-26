import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowSquareOut, ArrowsClockwise, Check, GitCommit, Minus, Plus } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, query } from "@/lib/runtime-api";
import { WindowedDiff } from "@/components/WindowedDiff";

export function ChangesPane({ worktree, runtimeEvent, settings, onError, onToast }) {
  const [status, setStatus] = useState(null);
  const [selectedFile, setSelectedFile] = useState("");
  const [viewMode, setViewMode] = useState("unstaged");
  const [diff, setDiff] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const diffRequestRef = useRef(0);
  const statusRequestRef = useRef(0);
  const selectionRef = useRef({ file: "", mode: "unstaged" });
  const refreshRef = useRef(null);
  const lastRuntimeEventRef = useRef(null);
  const ownerRef = useRef({ path: worktree.path, generation: 0 });
  if (ownerRef.current.path !== worktree.path) ownerRef.current = { path: worktree.path, generation: ownerRef.current.generation + 1 };

  useEffect(() => {
    ++statusRequestRef.current;
    ++diffRequestRef.current;
    setStatus(null);
    setDiff("");
    selectionRef.current = { file: "", mode: "unstaged" };
    setSelectedFile("");
    setViewMode("unstaged");
    setCommitMessage("");
    return () => { ++statusRequestRef.current; ++diffRequestRef.current; };
  }, [worktree.path]);

  const loadDiff = useCallback(async (filePath, mode) => {
    const owner = ownerRef.current;
    if (owner.path !== worktree.path) return;
    const request = ++diffRequestRef.current;
    if (!filePath) { setDiff(""); return; }
    try {
      const next = await api(query("/api/git/diff", { path: worktree.path, file: filePath, staged: mode === "staged" }));
      if (ownerRef.current === owner && request === diffRequestRef.current && selectionRef.current.file === filePath && selectionRef.current.mode === mode) setDiff(next.diff);
    } catch (error) { if (ownerRef.current === owner && request === diffRequestRef.current && selectionRef.current.file === filePath && selectionRef.current.mode === mode) onError(error); }
  }, [worktree.path, onError]);

  const refresh = useCallback(async () => {
    const owner = ownerRef.current;
    if (owner.path !== worktree.path) return;
    const request = ++statusRequestRef.current;
    setLoading(true);
    try {
      const next = await api(query("/api/git/status", { path: worktree.path }));
      if (ownerRef.current !== owner || request !== statusRequestRef.current) return;
      setStatus(next);
      const selection = selectionRef.current;
      const current = next.files.find((file) => file.path === selection.file);
      const nextFile = current?.path ?? next.files[0]?.path ?? "";
      const entry = current ?? next.files[0];
      const mode = hasStaged(entry) ? selection.mode : "unstaged";
      selectionRef.current = { file: nextFile, mode };
      setSelectedFile(nextFile);
      setViewMode(mode);
      if (nextFile) {
        await loadDiff(nextFile, mode);
      } else { ++diffRequestRef.current; setDiff(""); }
    } catch (error) { if (ownerRef.current === owner && request === statusRequestRef.current) onError(error); }
    finally { if (ownerRef.current === owner && request === statusRequestRef.current) setLoading(false); }
  }, [worktree.path, loadDiff, onError]);

  refreshRef.current = refresh;
  useEffect(() => { refreshRef.current(); }, [worktree.path]);
  useEffect(() => {
    if (!runtimeEvent || lastRuntimeEventRef.current === runtimeEvent) return;
    lastRuntimeEventRef.current = runtimeEvent;
    // Completion events arrive nested as run.event payloads, not top-level types.
    const eventType = runtimeEvent?.type === "run.event" ? runtimeEvent.payload?.type : runtimeEvent?.type;
    if (["projects.changed", "run.completed", "run.failed", "run.stopped"].includes(eventType)) refreshRef.current();
  }, [runtimeEvent]);

  async function chooseFile(file) {
    const mode = hasStaged(file) ? "staged" : "unstaged";
    selectionRef.current = { file: file.path, mode };
    setSelectedFile(file.path);
    setViewMode(mode);
    await loadDiff(file.path, mode);
  }
  async function chooseMode(mode) { const file = selectionRef.current.file; selectionRef.current = { file, mode }; setViewMode(mode); await loadDiff(file, mode); }
  async function mutate(endpoint, files) {
    const owner = ownerRef.current;
    const path = worktree.path;
    try {
      await api(endpoint, { method: "POST", body: { path, files } });
      if (ownerRef.current === owner) await refresh();
    } catch (error) { if (ownerRef.current === owner) onError(error); }
  }
  async function commit() {
    const owner = ownerRef.current;
    const path = worktree.path;
    try {
      await api("/api/git/commit", { method: "POST", body: { path, message: commitMessage } });
      if (ownerRef.current !== owner) return;
      setCommitMessage(""); onToast("Commit created"); await refresh();
    } catch (error) { if (ownerRef.current === owner) onError(error); }
  }

  const selected = status?.files.find((file) => file.path === selectedFile) ?? null;
  const stagedEligible = hasStaged(selected);

  return <section className="changes-pane">
    <header className="pane-toolbar"><div><strong>{status?.branch || worktree.branch}</strong><span>{status?.files.length ?? 0} changed files</span></div><Button variant="ghost" size="icon-sm" onClick={refresh} aria-label="Refresh changes"><ArrowsClockwise className={loading ? "spin" : ""} /></Button></header>
    <div className="changes-layout">
      <div className="changed-files" aria-busy={loading}>
        {status && !status.files.length && <div className="clean-state" role="status"><Check />Working tree is clean</div>}
        {status?.files.map((file) => <div key={file.path} className={`change-file ${file.path === selectedFile ? "is-active" : ""}`}><button className="change-file-select" aria-pressed={file.path === selectedFile} onClick={() => chooseFile(file)}><span className={`file-status ${hasStaged(file) ? "staged" : ""}`}>{file.status}</span><span>{file.path}</span></button><span className="file-actions">{hasStaged(file) ? <Button variant="ghost" size="icon-xs" onClick={() => mutate("/api/git/unstage", [file.path])} aria-label={`Unstage ${file.path}`}><Minus /></Button> : <Button variant="ghost" size="icon-xs" onClick={() => mutate("/api/git/stage", [file.path])} aria-label={`Stage ${file.path}`}><Plus /></Button>}<Button variant="ghost" size="icon-xs" onClick={() => api("/api/editor/open", { method: "POST", body: { path: worktree.path, file: file.path, editor: settings.editor } }).catch(onError)} aria-label={`Open ${file.path}`}><ArrowSquareOut /></Button></span></div>)}
      </div>
      <div className="diff-column">
        {selected && <div className="diff-mode" role="group" aria-label="Diff view"><Button variant={viewMode === "unstaged" ? "secondary" : "ghost"} size="xs" aria-pressed={viewMode === "unstaged"} onClick={() => chooseMode("unstaged")}>Unstaged</Button><Button variant={viewMode === "staged" ? "secondary" : "ghost"} size="xs" aria-pressed={viewMode === "staged"} disabled={!stagedEligible} onClick={() => chooseMode("staged")}>Staged{selected.originalPath ? ` (renamed from ${selected.originalPath})` : ""}</Button></div>}
        <WindowedDiff key={`${worktree.id}:${selectedFile}:${viewMode}`} diff={diff} label={selected ? `Diff for ${selected.path}, ${viewMode}` : "No diff selected"} />
      </div>
    </div>
    <footer className="commit-bar"><Input aria-label="Commit message" value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} placeholder="Commit message" onKeyDown={(event) => { if (event.key === "Enter") commit(); }} /><Button onClick={commit} disabled={!commitMessage.trim() || !status?.stagedCount}><GitCommit /> Commit {status?.stagedCount ? `${status.stagedCount} staged` : ""}</Button></footer>
  </section>;
}

function hasStaged(file) { return Boolean(file) && file.index !== " " && file.index !== "?" && file.status !== "??"; }
