import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowsClockwise, CaretDown, CaretRight, Eye, EyeSlash, File, FileImage, FilePdf, FileText, Folder, FolderOpen, LinkBreak, LinkSimple, SpinnerGap, WarningCircle } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FilePreview } from "@/components/FilePreview";
import { ancestorsOf, isFolderPath, normalizeTypedPath, treeKeyTarget, visibleRows } from "@/lib/file-tree";
import { api, query } from "@/lib/runtime-api";

const HIDDEN_KEY = "outright.files.show-hidden";
const REFRESH_EVENTS = new Set(["run.completed", "run.failed", "run.stopped"]);
// The runtime's default and largest folder page sizes.
const PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 500;

// Browses one worktree. The pane is keyed by the worktree, so nothing it
// loaded can appear for another one; each folder's request is fenced by a
// token, so a reload or a hidden-file change supersedes answers in flight.
export function FilesPane({ project, worktree, settings, runtimeEvent, conversationIds, quickOpen, onQuickOpenHandled, onError }) {
  const [showHidden, setShowHidden] = useState(() => localStorage.getItem(HIDDEN_KEY) === "true");
  const [folders, setFolders] = useState(() => new Map());
  const [expanded, setExpanded] = useState(() => new Set());
  const [focusedId, setFocusedId] = useState("");
  const [selected, setSelected] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [jump, setJump] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const tokensRef = useRef(new Map());
  const foldersRef = useRef(folders);
  const expandedRef = useRef(expanded);
  const hiddenRef = useRef(showHidden);
  const treeRef = useRef(null);
  const jumpRef = useRef(null);
  const aliveRef = useRef(true);
  // A new onError function is not a reason to read anything again.
  const onErrorRef = useRef(onError);
  useLayoutEffect(() => { foldersRef.current = folders; expandedRef.current = expanded; hiddenRef.current = showHidden; onErrorRef.current = onError; });
  useEffect(() => () => { aliveRef.current = false; }, []);

  const reportable = (error) => error.status === 429 || (error.status >= 500 && error.payload?.code !== "LISTING_UNAVAILABLE");

  // Reads a folder's first page, or with `keep`, as many pages as it takes
  // to list that many entries again, installed together. Each read starts a
  // new listing generation: an older read or a "load more" from an older
  // listing is dropped. The shown entries stay until the new ones arrive.
  const loadFolder = useCallback(async (directory, { keep = 0 } = {}) => {
    if (typeof directory !== "string") return;
    const generation = (tokensRef.current.get(directory) ?? 0) + 1;
    tokensRef.current.set(directory, generation);
    const hidden = hiddenRef.current;
    setFolders((current) => withFolder(current, directory, { ...current.get(directory), status: "loading", loadingMore: false, moreError: "" }));
    const fresh = () => aliveRef.current && tokensRef.current.get(directory) === generation;
    try {
      const read = (cursor) => api(query("/api/files", { projectId: project.id, path: worktree.path, dir: directory, cursor, hidden: hidden ? "true" : undefined,
        limit: keep > PAGE_SIZE ? Math.min(keep, MAX_PAGE_SIZE) : undefined }));
      const page = await read();
      let entries = page.entries;
      while (fresh() && page.nextCursor && entries.length < keep) {
        Object.assign(page, await read(page.nextCursor));
        entries = [...entries, ...page.entries];
      }
      if (!fresh()) return;
      setFolders((current) => withFolder(current, directory, { status: "loaded", generation, hidden, entries,
        nextCursor: page.nextCursor, total: page.total, hiddenCount: page.hiddenCount, truncated: page.truncated, scanLimit: page.scanLimit }));
    } catch (error) {
      if (!fresh()) return;
      if (reportable(error)) onErrorRef.current(error);
      setFolders((current) => withFolder(current, directory, { status: "error", error: { message: error.message, code: error.payload?.code ?? "" } }));
    }
  }, [project.id, worktree.path]);

  // Reads the next page of the listing that is shown, with that listing's
  // cursor and hidden-file policy. It never supersedes a first-page read.
  const loadMore = useCallback(async (directory) => {
    const folder = foldersRef.current.get(directory);
    const generation = tokensRef.current.get(directory);
    if (!folder || folder.status !== "loaded" || !folder.nextCursor || folder.loadingMore || folder.generation !== generation) return;
    const installed = (current) => current.get(directory)?.status === "loaded" && current.get(directory).generation === generation;
    setFolders((current) => installed(current) ? withFolder(current, directory, { ...current.get(directory), loadingMore: true, moreError: "" }) : current);
    const fresh = () => aliveRef.current && tokensRef.current.get(directory) === generation;
    try {
      const page = await api(query("/api/files", { projectId: project.id, path: worktree.path, dir: directory, cursor: folder.nextCursor, hidden: folder.hidden ? "true" : undefined }));
      if (!fresh()) return;
      setFolders((current) => installed(current) ? withFolder(current, directory, { ...current.get(directory), loadingMore: false, entries: [...current.get(directory).entries, ...page.entries],
        nextCursor: page.nextCursor, total: page.total, hiddenCount: page.hiddenCount, truncated: page.truncated, scanLimit: page.scanLimit }) : current);
    } catch (error) {
      if (!fresh()) return;
      if (reportable(error)) onErrorRef.current(error);
      setFolders((current) => installed(current) ? withFolder(current, directory, { ...current.get(directory), loadingMore: false, moreError: error.message }) : current);
    }
  }, [project.id, worktree.path]);

  // Reloads the root and every open folder. A refresh keeps as many entries
  // as each folder had loaded; a hidden-file change starts from page one.
  const reloadAll = useCallback(({ keepPages = false } = {}) => {
    for (const directory of foldersRef.current.keys()) {
      if (directory && !expandedRef.current.has(directory)) tokensRef.current.set(directory, (tokensRef.current.get(directory) ?? 0) + 1);
    }
    const loaded = foldersRef.current;
    setFolders((current) => new Map([...current].filter(([directory]) => !directory || expandedRef.current.has(directory))));
    for (const directory of ["", ...expandedRef.current]) void loadFolder(directory, { keep: keepPages ? loaded.get(directory)?.entries?.length ?? 0 : 0 });
  }, [loadFolder]);
  const refresh = useCallback(() => { reloadAll({ keepPages: true }); setRefreshKey((value) => value + 1); }, [reloadAll]);

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
  const conversationsRef = useRef(conversationIds);
  useLayoutEffect(() => { conversationsRef.current = conversationIds; });
  useEffect(() => {
    if (!runtimeEvent || runtimeEvent === lastEventRef.current) return;
    lastEventRef.current = runtimeEvent;
    // Only a run in one of this worktree's conversations may have changed its files.
    if (runtimeEvent.type !== "run.event" || !REFRESH_EVENTS.has(runtimeEvent.payload?.type)
      || !conversationsRef.current?.includes(runtimeEvent.conversationId)) return;
    // One refresh covers a burst, and later events of other kinds do not cancel it.
    clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(refresh, 400);
  }, [runtimeEvent, refresh]);
  useEffect(() => () => clearTimeout(refreshTimerRef.current), []);

  const rows = useMemo(() => visibleRows(folders, expanded), [folders, expanded]);
  // The active row is the tree's one tab stop. A target that has not appeared
  // yet (Go to file, while its folder loads) is waited for; a row that was
  // shown and then removed gives way to the row now at its position, so the
  // first newly loaded entry follows a final "load more".
  const activeIndexRef = useRef(0);
  const shownIdRef = useRef("");
  const foundIndex = rows.findIndex((row) => row.id === focusedId);
  const activeIndex = foundIndex >= 0 ? foundIndex : Math.max(0, Math.min(activeIndexRef.current, rows.length - 1));
  const activeId = rows[activeIndex]?.id ?? "";
  // A keyboard move is pending until its row has focus. Otherwise the active
  // row follows whichever row has focus.
  const moveRef = useRef(false);
  const moveFocus = useCallback((id) => { moveRef.current = true; setFocusedId(id); }, []);
  // The row that had focus at the last commit, and whether focus is in the
  // tree. A row removed while focused leaves focus on the page body, with no
  // focus event in some browsers, so the last commit's focus is the evidence.
  const lastFocusRef = useRef(null);
  const rowsRef = useRef(rows);
  const treeFocusedRef = useRef(false);
  const noteFocusedRow = (element) => {
    const focusedRow = element?.closest?.("[data-row-id]");
    if (!focusedRow) return;
    treeFocusedRef.current = true;
    lastFocusRef.current = { id: focusedRow.dataset.rowId, index: rowsRef.current.findIndex((row) => row.id === focusedRow.dataset.rowId) };
  };
  const onTreeFocus = (event) => noteFocusedRow(event.target);
  const onTreeBlur = (event) => {
    const tree = treeRef.current;
    if (event.relatedTarget) { treeFocusedRef.current = Boolean(tree?.contains(event.relatedTarget)); return; }
    const left = event.target;
    // Focus that leaves for nothing is kept only if its row was removed.
    setTimeout(() => { if (left.isConnected && !tree?.contains(document.activeElement)) treeFocusedRef.current = false; });
  };

  useLayoutEffect(() => {
    if (foundIndex >= 0) { activeIndexRef.current = foundIndex; shownIdRef.current = focusedId; }
    else if (activeId && shownIdRef.current === focusedId) setFocusedId(activeId);
    const tree = treeRef.current;
    if (!tree) return;
    const current = document.activeElement;
    const currentRow = current && tree.contains(current) ? current.closest("[data-row-id]") : null;
    let target = "";
    if (currentRow) {
      if (moveRef.current) target = activeId;
      else if (currentRow.dataset.rowId !== focusedId && rows.some((row) => row.id === currentRow.dataset.rowId)) setFocusedId(currentRow.dataset.rowId);
    } else if ((!current || current === document.body) && treeFocusedRef.current && lastFocusRef.current && rows.length) {
      const { id, index } = lastFocusRef.current;
      target = rows.some((row) => row.id === id) ? id : rows[Math.min(index, rows.length - 1)].id;
      if (target !== focusedId) setFocusedId(target);
    }
    if (target) {
      const element = tree.querySelector(`[data-row-id="${CSS.escape(target)}"]`);
      if (element && element !== current) element.focus({ preventScroll: false });
      if (element && target === activeId) moveRef.current = false;
    }
    rowsRef.current = rows;
    if (tree.contains(document.activeElement)) noteFocusedRow(document.activeElement);
    else if (document.activeElement && document.activeElement !== document.body) treeFocusedRef.current = false;
  }, [activeId, foundIndex, focusedId, rows]);

  const toggleFolder = useCallback((path, open) => {
    if (!isFolderPath(path)) return;
    setExpanded((current) => {
      const next = new Set(current);
      if (open) next.add(path); else next.delete(path);
      return next;
    });
    const folder = foldersRef.current.get(path);
    if (open && (!folder || folder.status === "error")) void loadFolder(path);
  }, [loadFolder]);

  const activate = (row) => {
    if (row.type === "more" && !row.loading) void loadMore(row.directory);
    else if (row.type === "error") void loadFolder(row.directory);
    else if (row.type === "entry" && row.entry.path) {
      if (row.expandable) toggleFolder(row.entry.path, !row.open);
      else setSelected(row.entry.path);
    }
  };

  const onTreeKeyDown = (event) => {
    noteFocusedRow(event.target);
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
    moveFocus(rows[target].id);
  };

  const openPath = useCallback((value) => {
    const file = normalizeTypedPath(value);
    if (!file) return;
    const ancestors = ancestorsOf(file);
    setExpanded((current) => new Set([...current, ...ancestors]));
    for (const directory of ancestors) if (!foldersRef.current.has(directory)) void loadFolder(directory);
    setSelected(file);
    moveFocus(`entry:${file}`);
    setAnnouncement(`Opening ${file}`);
  }, [loadFolder, moveFocus]);

  const revealFolder = useCallback((path) => {
    setSelected((current) => (current === path ? "" : current));
    setExpanded((current) => new Set([...current, ...ancestorsOf(path), path]));
    for (const directory of [...ancestorsOf(path), path]) if (!foldersRef.current.has(directory)) void loadFolder(directory);
    moveFocus(`entry:${path}`);
    setAnnouncement(`${path} is a folder; it is open in the tree`);
  }, [loadFolder, moveFocus]);

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

  const root = folders.get("");
  const rowLabel = (row) => {
    if (row.type === "loading") return "Loading…";
    if (row.type === "unavailable") return `${row.error.message}.`;
    if (row.type === "error") return row.error.code === "MISSING" ? `${row.directory || "This worktree"} no longer exists. Retry` : `Could not open ${row.directory || "the worktree"}: ${row.error.message}. Retry`;
    if (row.type === "empty") return row.hiddenCount && !showHidden ? `Empty, ${row.hiddenCount} hidden` : "Empty folder";
    if (row.type === "more") return row.loading ? "Loading more…" : row.error ? `Could not load more: ${row.error}. Retry` : `Load ${Math.min(row.remaining, 200)} more of ${row.remaining}`;
    if (row.type === "truncated") return `Only the first ${row.limit.toLocaleString()} entries were read`;
    return row.entry.name;
  };

  return <section className="files-pane">
    <header className="pane-toolbar">
      <div><strong>{worktree.name}</strong><span>{root?.entries ? `${root.total} items${root.hiddenCount && !showHidden ? `, ${root.hiddenCount} hidden` : ""}` : "Files"}</span></div>
      <div className="files-actions">
        <Button variant={showHidden ? "secondary" : "ghost"} size="icon-sm" aria-pressed={showHidden} aria-label="Show hidden files" title={showHidden ? "Hide dotfiles" : "Show dotfiles"} onClick={() => setShowHidden((value) => !value)}>{showHidden ? <Eye /> : <EyeSlash />}</Button>
        <Button variant="ghost" size="icon-sm" aria-label="Refresh files" onClick={refresh}><ArrowsClockwise className={root?.status === "loading" ? "spin" : ""} /></Button>
      </div>
    </header>
    <form className="files-jump" role="search" aria-label="Go to file" onSubmit={(event) => { event.preventDefault(); openPath(jump); }}>
      <Input ref={jumpRef} aria-label="Go to file path" placeholder="Go to file… (⌘P)" value={jump} onChange={(event) => setJump(event.target.value)} spellCheck={false} autoComplete="off" />
    </form>
    <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
    <div className="files-layout">
      <div className="file-tree" role="tree" aria-label={`Files in ${worktree.name}`} aria-busy={root?.status === "loading"} ref={treeRef} onKeyDown={onTreeKeyDown} onFocus={onTreeFocus} onBlur={onTreeBlur}>
        {rows.map((row) => <TreeRow key={row.id} row={row} label={rowLabel(row)} active={row.id === activeId} selected={row.type === "entry" && row.entry.path === selected}
          onFocus={() => { moveRef.current = false; setFocusedId(row.id); }} onActivate={() => { moveRef.current = false; setFocusedId(row.id); activate(row); }} />)}
      </div>
      {selected ? <FilePreview key={selected} project={project} worktree={worktree} file={selected} refreshKey={refreshKey} settings={settings} onError={onError}
        onNavigate={openPath} onFolder={revealFolder} onRefreshFolder={refreshFolderOf} />
        : <div className="file-preview preview-state" role="note">Choose a file to preview it. Markdown, text, images and PDFs open here.</div>}
    </div>
  </section>;
}

function withFolder(folders, directory, folder) {
  const next = new Map(folders);
  next.set(directory, folder);
  return next;
}

function TreeRow({ row, label, active, selected, onFocus, onActivate }) {
  const entry = row.entry;
  const isEntry = row.type === "entry";
  let icon = null;
  let note = "";
  if (!isEntry) icon = row.type === "loading" || row.loading ? <SpinnerGap className="spin" /> : row.type === "error" || row.type === "unavailable" || row.error ? <WarningCircle /> : null;
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
    aria-disabled={(isEntry && !entry.path) || row.type === "empty" || row.type === "unavailable" || row.type === "truncated" || row.type === "loading" || undefined}
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
