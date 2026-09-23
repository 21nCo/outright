import { useCallback, useEffect, useState } from "react";
import { ArrowSquareOut, ArrowsClockwise, Check, GitCommit, Minus, Plus } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, query } from "@/lib/runtime-api";

export function ChangesPane({ worktree, runtimeEvent, settings, onError, onToast }) {
  const [status, setStatus] = useState(null);
  const [selectedFile, setSelectedFile] = useState("");
  const [viewMode, setViewMode] = useState("unstaged");
  const [diff, setDiff] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [loading, setLoading] = useState(true);

  const loadDiff = useCallback(async (filePath, mode) => {
    if (!filePath) { setDiff(""); return; }
    try { setDiff((await api(query("/api/git/diff", { path: worktree.path, file: filePath, staged: mode === "staged" }))).diff); }
    catch (error) { onError(error); }
  }, [worktree.path, onError]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await api(query("/api/git/status", { path: worktree.path }));
      setStatus(next);
      const current = next.files.find((file) => file.path === selectedFile);
      const nextFile = current?.path ?? next.files[0]?.path ?? "";
      setSelectedFile(nextFile);
      if (nextFile) {
        const entry = current ?? next.files[0];
        const mode = hasStaged(entry) ? viewMode : "unstaged";
        setViewMode(mode);
        await loadDiff(nextFile, mode);
      } else setDiff("");
    } catch (error) { onError(error); }
    finally { setLoading(false); }
  }, [worktree.path, selectedFile, viewMode, loadDiff, onError]);

  useEffect(() => { refresh(); }, [worktree.id]);
  useEffect(() => {
    // Completion events arrive nested as run.event payloads, not top-level types.
    const eventType = runtimeEvent?.type === "run.event" ? runtimeEvent.payload?.type : runtimeEvent?.type;
    if (["projects.changed", "run.completed", "run.failed", "run.stopped"].includes(eventType)) refresh();
  }, [runtimeEvent, refresh]);

  async function chooseFile(file) {
    const mode = hasStaged(file) ? "staged" : "unstaged";
    setSelectedFile(file.path);
    setViewMode(mode);
    await loadDiff(file.path, mode);
  }
  async function chooseMode(mode) { setViewMode(mode); await loadDiff(selectedFile, mode); }
  async function mutate(endpoint, files) {
    try { setStatus(await api(endpoint, { method: "POST", body: { path: worktree.path, files } })); await refresh(); }
    catch (error) { onError(error); }
  }
  async function commit() {
    try {
      await api("/api/git/commit", { method: "POST", body: { path: worktree.path, message: commitMessage } });
      setCommitMessage(""); onToast("Commit created"); await refresh();
    } catch (error) { onError(error); }
  }

  const selected = status?.files.find((file) => file.path === selectedFile) ?? null;
  const stagedEligible = hasStaged(selected);

  return <section className="changes-pane">
    <header className="pane-toolbar"><div><strong>{status?.branch || worktree.branch}</strong><span>{status?.files.length ?? 0} changed files</span></div><Button variant="ghost" size="icon-sm" onClick={refresh} aria-label="Refresh changes"><ArrowsClockwise className={loading ? "spin" : ""} /></Button></header>
    <div className="changes-layout">
      <div className="changed-files" aria-busy={loading}>
        {!status?.files.length && <div className="clean-state" role="status"><Check />Working tree is clean</div>}
        {status?.files.map((file) => <div key={file.path} className={`change-file ${file.path === selectedFile ? "is-active" : ""}`}><button className="change-file-select" aria-pressed={file.path === selectedFile} onClick={() => chooseFile(file)}><span className={`file-status ${hasStaged(file) ? "staged" : ""}`}>{file.status}</span><span>{file.path}</span></button><span className="file-actions">{hasStaged(file) ? <Button variant="ghost" size="icon-xs" onClick={() => mutate("/api/git/unstage", [file.path])} aria-label={`Unstage ${file.path}`}><Minus /></Button> : <Button variant="ghost" size="icon-xs" onClick={() => mutate("/api/git/stage", [file.path])} aria-label={`Stage ${file.path}`}><Plus /></Button>}<Button variant="ghost" size="icon-xs" onClick={() => api("/api/editor/open", { method: "POST", body: { path: worktree.path, file: file.path, editor: settings.editor } }).catch(onError)} aria-label={`Open ${file.path}`}><ArrowSquareOut /></Button></span></div>)}
      </div>
      <div className="diff-column">
        {selected && <div className="diff-mode" role="group" aria-label="Diff view"><Button variant={viewMode === "unstaged" ? "secondary" : "ghost"} size="xs" aria-pressed={viewMode === "unstaged"} onClick={() => chooseMode("unstaged")}>Unstaged</Button><Button variant={viewMode === "staged" ? "secondary" : "ghost"} size="xs" aria-pressed={viewMode === "staged"} disabled={!stagedEligible} onClick={() => chooseMode("staged")}>Staged{selected.originalPath ? ` (renamed from ${selected.originalPath})` : ""}</Button></div>}
        <pre className="diff-view" tabIndex={0} aria-label={selected ? `Diff for ${selected.path}, ${viewMode}` : "No diff selected"}>{diff ? diff.split("\n").map((line, index) => <span className={line.startsWith("+") && !line.startsWith("+++") ? "added" : line.startsWith("-") && !line.startsWith("---") ? "removed" : line.startsWith("@@") ? "hunk" : ""} key={`${index}:${line}`}><i aria-hidden="true">{index + 1}</i>{line}{"\n"}</span>) : <span className="diff-empty">Select a changed file to inspect its diff.</span>}</pre>
      </div>
    </div>
    <footer className="commit-bar"><Input aria-label="Commit message" value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} placeholder="Commit message" onKeyDown={(event) => { if (event.key === "Enter") commit(); }} /><Button onClick={commit} disabled={!commitMessage.trim() || !status?.stagedCount}><GitCommit /> Commit {status?.stagedCount ? `${status.stagedCount} staged` : ""}</Button></footer>
  </section>;
}

function hasStaged(file) { return Boolean(file) && file.index !== " " && file.index !== "?" && file.status !== "??"; }
