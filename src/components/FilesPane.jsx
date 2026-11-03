import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowsClockwise, CaretDown, CaretRight, Eye, EyeSlash, File, FileImage, FilePdf, FileText, Folder, FolderOpen, LinkBreak, LinkSimple, SpinnerGap, WarningCircle } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FilePreview } from "@/components/FilePreview";
import { ancestorsOf, normalizeTypedPath, treeKeyTarget, visibleRows } from "@/lib/file-tree";
import { api, query } from "@/lib/runtime-api";

const HIDDEN_KEY = "outright.files.show-hidden";
const REFRESH_EVENTS = new Set(["run.completed", "run.failed", "run.stopped"]);

// Browses one worktree. The pane is keyed by the worktree, so nothing it
// loaded can appear for another one; each folder's request is fenced by a
// token, so a reload or a hidden-file change supersedes answers in flight.
export function FilesPane({ project, worktree, settings, runtimeEvent, quickOpen, onQuickOpenHandled, onError }) {
  const [showHidden, setShowHidden] = useState(() => localStorage.getItem(HIDDEN_KEY) === "true");
  const [folders, setFolders] = useState({});
  const [expanded, setExpanded] = useState(() => new Set());
  const [focusedId, setFocusedId] = useState("");
  const [selected, setSelected] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [jump, setJump] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const tokensRef = useRef({});
  const foldersRef = useRef(folders);
  const expandedRef = useRef(expanded);
  const hiddenRef = useRef(showHidden);
  const treeRef = useRef(null);
  const jumpRef = useRef(null);
  const aliveRef = useRef(true);
  useLayoutEffect(() => { foldersRef.current = folders; expandedRef.current = expanded; hiddenRef.current = showHidden; });
  useEffect(() => () => { aliveRef.current = false; }, []);

  const loadFolder = useCallback(async (directory, cursor = null) => {
    const token = (tokensRef.current[directory] ?? 0) + 1;
    tokensRef.current[directory] = token;
    setFolders((current) => ({ ...current, [directory]: cursor
      ? { ...current[directory], loadingMore: true, moreError: "" }
      : { ...current[directory], status: "loading" } }));
    const fresh = () => aliveRef.current && tokensRef.current[directory] === token;
    try {
      const page = await api(query("/api/files", { projectId: project.id, path: worktree.path, dir: directory, cursor, hidden: hiddenRef.current ? "true" : undefined }));
      if (!fresh()) return;
      setFolders((current) => ({ ...current, [directory]: { status: "loaded", entries: cursor ? [...(current[directory]?.entries ?? []), ...page.entries] : page.entries,
        nextCursor: page.nextCursor, total: page.total, hiddenCount: page.hiddenCount, truncated: page.truncated, scanLimit: page.scanLimit } }));
    } catch (error) {
      if (!fresh()) return;
      if (error.status === 429 || error.status >= 500) onError(error);
      setFolders((current) => ({ ...current, [directory]: cursor
        ? { ...current[directory], loadingMore: false, moreError: error.message }
        : { status: "error", error: { message: error.message, code: error.payload?.code ?? "" } } }));
    }
  }, [project.id, worktree.path, onError]);

  // Reloads the root and every open folder from their first page.
  const reloadAll = useCallback(() => {
    for (const directory of Object.keys(foldersRef.current)) {
      if (directory && !expandedRef.current.has(directory)) { tokensRef.current[directory] = (tokensRef.current[directory] ?? 0) + 1; }
    }
    setFolders((current) => Object.fromEntries(Object.entries(current).filter(([directory]) => !directory || expandedRef.current.has(directory))));
    for (const directory of ["", ...expandedRef.current]) void loadFolder(directory);
  }, [loadFolder]);

  useEffect(() => { void loadFolder(""); }, [loadFolder]);
  const listedHiddenRef = useRef(showHidden);
  useEffect(() => {
    localStorage.setItem(HIDDEN_KEY, String(showHidden));
    if (listedHiddenRef.current === showHidden) return;
    listedHiddenRef.current = showHidden;
    reloadAll();
  }, [showHidden, reloadAll]);

  const lastEventRef = useRef(runtimeEvent);
  const refreshTimerRef = useRef(null);
  useEffect(() => {
    if (!runtimeEvent || runtimeEvent === lastEventRef.current) return;
    lastEventRef.current = runtimeEvent;
    const type = runtimeEvent.type === "run.event" ? runtimeEvent.payload?.type : runtimeEvent.type;
    if (!REFRESH_EVENTS.has(type)) return;
    // An agent run may have changed files; one refresh covers a burst, and
    // later events of other kinds do not cancel it.
    clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => { reloadAll(); setRefreshKey((value) => value + 1); }, 400);
  }, [runtimeEvent, reloadAll]);
  useEffect(() => () => clearTimeout(refreshTimerRef.current), []);

  const rows = useMemo(() => visibleRows(folders, expanded), [folders, expanded]);
  const activeIndex = Math.max(0, rows.findIndex((row) => row.id === focusedId));
  const activeId = rows[activeIndex]?.id ?? "";

  // Keyboard moves keep focus on the active row as rows load around it.
  useLayoutEffect(() => {
    const tree = treeRef.current;
    if (!tree?.contains(document.activeElement) || document.activeElement === tree) return;
    const element = tree.querySelector(`[data-row-id="${CSS.escape(activeId)}"]`);
    if (element && element !== document.activeElement) element.focus({ preventScroll: false });
  }, [activeId, rows]);

  const toggleFolder = useCallback((path, open) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (open) next.add(path); else next.delete(path);
      return next;
    });
    const folder = foldersRef.current[path];
    if (open && (!folder || folder.status === "error")) void loadFolder(path);
  }, [loadFolder]);

  const activate = (row) => {
    if (row.type === "more" && !row.loading) void loadFolder(row.directory, foldersRef.current[row.directory]?.nextCursor);
    else if (row.type === "error") void loadFolder(row.directory);
    else if (row.type === "entry" && row.entry.path) {
      if (row.expandable) toggleFolder(row.entry.path, !row.open);
      else setSelected(row.entry.path);
    }
  };

  const onTreeKeyDown = (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    // The row that has focus owns the key, even before its focus is rendered.
    const focusedIndex = rows.findIndex((item) => item.id === event.target.closest?.("[data-row-id]")?.dataset.rowId);
    const index = focusedIndex >= 0 ? focusedIndex : activeIndex;
    const row = rows[index];
    if (!row) return;
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(row); return; }
    if (event.key === "ArrowRight" && row.expandable && !row.open) { event.preventDefault(); toggleFolder(row.entry.path, true); return; }
    if (event.key === "ArrowLeft" && row.expandable && row.open) { event.preventDefault(); toggleFolder(row.entry.path, false); return; }
    const target = treeKeyTarget(rows, index, event.key);
    if (target < 0) return;
    event.preventDefault();
    setFocusedId(rows[target].id);
  };

  const openPath = useCallback((value) => {
    const file = normalizeTypedPath(value);
    if (!file) return;
    const ancestors = ancestorsOf(file);
    setExpanded((current) => new Set([...current, ...ancestors]));
    for (const directory of ancestors) if (!foldersRef.current[directory]) void loadFolder(directory);
    setSelected(file);
    setFocusedId(`entry:${file}`);
    setAnnouncement(`Opening ${file}`);
  }, [loadFolder]);

  const revealFolder = useCallback((path) => {
    setSelected((current) => (current === path ? "" : current));
    setExpanded((current) => new Set([...current, ...ancestorsOf(path), path]));
    for (const directory of [...ancestorsOf(path), path]) if (!foldersRef.current[directory]) void loadFolder(directory);
    setFocusedId(`entry:${path}`);
    setAnnouncement(`${path} is a folder; it is open in the tree`);
  }, [loadFolder]);

  const refreshFolderOf = useCallback((file) => {
    const directory = ancestorsOf(file).at(-1) ?? "";
    void loadFolder(directory);
    setSelected("");
    setAnnouncement(`Refreshed ${directory || "the worktree root"}`);
  }, [loadFolder]);

  useEffect(() => {
    if (!quickOpen) return;
    jumpRef.current?.focus();
    jumpRef.current?.select();
    onQuickOpenHandled?.();
  }, [quickOpen, onQuickOpenHandled]);

  const root = folders[""];
  const rowLabel = (row) => {
    if (row.type === "loading") return "Loading…";
    if (row.type === "error") return row.error.code === "MISSING" ? `${row.directory || "This worktree"} no longer exists. Retry` : `Could not open ${row.directory || "the worktree"}: ${row.error.message}. Retry`;
    if (row.type === "empty") return row.hiddenCount && !showHidden ? `Empty, ${row.hiddenCount} hidden` : "Empty folder";
    if (row.type === "more") return row.loading ? "Loading more…" : row.error ? `Could not load more: ${row.error}. Retry` : `Load ${Math.min(row.remaining, 200)} more of ${row.remaining}`;
    if (row.type === "truncated") return `Only the first ${row.limit.toLocaleString()} entries were read`;
    return row.entry.name;
  };

  return <section className="files-pane">
    <header className="pane-toolbar">
      <div><strong>{worktree.name}</strong><span>{root?.status === "loaded" ? `${root.total} items${root.hiddenCount && !showHidden ? `, ${root.hiddenCount} hidden` : ""}` : "Files"}</span></div>
      <div className="files-actions">
        <Button variant={showHidden ? "secondary" : "ghost"} size="icon-sm" aria-pressed={showHidden} aria-label="Show hidden files" title={showHidden ? "Hide dotfiles" : "Show dotfiles"} onClick={() => setShowHidden((value) => !value)}>{showHidden ? <Eye /> : <EyeSlash />}</Button>
        <Button variant="ghost" size="icon-sm" aria-label="Refresh files" onClick={() => { reloadAll(); setRefreshKey((value) => value + 1); }}><ArrowsClockwise className={root?.status === "loading" ? "spin" : ""} /></Button>
      </div>
    </header>
    <form className="files-jump" role="search" aria-label="Go to file" onSubmit={(event) => { event.preventDefault(); openPath(jump); }}>
      <Input ref={jumpRef} aria-label="Go to file path" placeholder="Go to file… (⌘P)" value={jump} onChange={(event) => setJump(event.target.value)} spellCheck={false} autoComplete="off" />
    </form>
    <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
    <div className="files-layout">
      <div className="file-tree" role="tree" aria-label={`Files in ${worktree.name}`} aria-busy={root?.status === "loading"} ref={treeRef} onKeyDown={onTreeKeyDown}>
        {rows.map((row) => <TreeRow key={row.id} row={row} label={rowLabel(row)} active={row.id === activeId} selected={row.type === "entry" && row.entry.path === selected}
          onFocus={() => setFocusedId(row.id)} onActivate={() => { setFocusedId(row.id); activate(row); }} />)}
      </div>
      {selected ? <FilePreview key={selected} project={project} worktree={worktree} file={selected} refreshKey={refreshKey} settings={settings} onError={onError}
        onNavigate={openPath} onFolder={revealFolder} onRefreshFolder={refreshFolderOf} />
        : <div className="file-preview preview-state" role="note">Choose a file to preview it. Markdown, text, images and PDFs open here.</div>}
    </div>
  </section>;
}

function TreeRow({ row, label, active, selected, onFocus, onActivate }) {
  const entry = row.entry;
  const isEntry = row.type === "entry";
  let icon = null;
  let note = "";
  if (!isEntry) icon = row.type === "loading" || row.loading ? <SpinnerGap className="spin" /> : row.type === "error" || row.error ? <WarningCircle /> : null;
  else if (entry.kind === "symlink") {
    const state = entry.target?.state;
    icon = state === "outside" || state === "missing" ? <LinkBreak /> : <LinkSimple />;
    note = state === "outside" ? "links outside the worktree" : state === "missing" ? "broken link" : entry.target?.path ? `→ ${entry.target.path}` : "";
  } else if (row.expandable) icon = row.open ? <FolderOpen weight="duotone" /> : <Folder weight="duotone" />;
  else icon = fileIcon(entry.name);
  if (isEntry && !entry.path) note = "name is not UTF-8";
  if (isEntry && entry.kind === "other") note = "special file";
  return <div role="treeitem" data-row-id={row.id} tabIndex={active ? 0 : -1} aria-level={row.level}
    aria-setsize={isEntry ? row.setSize : undefined} aria-posinset={isEntry ? row.position : undefined}
    aria-expanded={row.expandable ? row.open : undefined} aria-selected={isEntry && !row.expandable ? selected : undefined}
    aria-disabled={(isEntry && !entry.path) || row.type === "empty" || row.type === "truncated" || row.type === "loading" || undefined}
    className={`tree-row tree-${row.type}${selected ? " is-selected" : ""}${entry?.hidden ? " is-hidden" : ""}`}
    style={{ "--tree-level": row.level - 1 }} onFocus={onFocus} onClick={onActivate}>
    <span className="tree-caret" aria-hidden="true">{row.expandable ? (row.open ? <CaretDown /> : <CaretRight />) : null}</span>
    <span className="tree-icon" aria-hidden="true">{icon}</span>
    <span className="tree-label">{label}</span>
    {note && <small className="tree-note">{note}</small>}
  </div>;
}

function fileIcon(name) {
  const extension = name.split(".").at(-1)?.toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg"].includes(extension)) return <FileImage />;
  if (extension === "pdf") return <FilePdf />;
  if (["md", "markdown", "txt", "mdown", "mkd"].includes(extension)) return <FileText />;
  return <File />;
}
