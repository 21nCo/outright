import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowsClockwise, CaretDown, CaretRight, Eye, EyeSlash, File, FileImage, FilePdf, FileText, Folder, FolderOpen, LinkBreak, LinkSimple, SpinnerGap, WarningCircle } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FilePreview } from "@/components/FilePreview";
import { ancestorsOf, isFolderPath, needsPage, normalizeTypedPath, readHiddenPreference, revealable, revealPath, rowElement, saveHiddenPreference, treeKeyTarget, visibleRows } from "@/lib/file-tree";
import { api, query } from "@/lib/runtime-api";

// Read inside the helpers, so a browser that refuses storage access is caught there.
const browserStorage = () => window.localStorage;
// The runtime's default and largest folder page sizes.
const PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 500;

// Browses one worktree. The pane is keyed by the worktree, so nothing it
// loaded can appear for another one; each folder's request is fenced by a
// token, so a reload or a hidden-file change supersedes answers in flight.
export function FilesPane({ project, worktree, settings, completions, quickOpen, quickOpenHint = "⌘P", onQuickOpenHandled, onError }) {
  const [showHidden, setShowHidden] = useState(() => readHiddenPreference(browserStorage));
  const [folders, setFolders] = useState(() => new Map());
  const [expanded, setExpanded] = useState(() => new Set());
  const [focusedId, setFocusedId] = useState("");
  const [selected, setSelected] = useState("");
  // The path the runtime opened for `selected`, when it names it differently.
  const [resolved, setResolved] = useState({});
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
  // Each folder's listing generation has one controller: a newer read, a
  // collapse on refresh or unmount aborts its requests.
  const controllersRef = useRef(new Map());
  const abortListing = (directory) => { controllersRef.current.get(directory)?.abort(); controllersRef.current.delete(directory); };
  // The read in flight for each folder, with the reveal (find, active) it serves.
  const readsRef = useRef(new Map());
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; for (const controller of controllersRef.current.values()) controller.abort(); }; }, []);

  const reportable = (error) => error.status === 429 || (error.status >= 500 && error.payload?.code !== "LISTING_UNAVAILABLE");

  // Reads a folder's first page, or with `keep`, as many pages as it takes
  // to list that many entries again, installed together. Each read starts a
  // new listing generation: an older read or a "load more" from an older
  // listing is dropped. The shown entries stay until the new ones arrive.
  const loadFolder = useCallback((directory, { keep = 0, find = "", active } = {}) => {
    if (typeof directory !== "string") return;
    // A reload replacing a reveal's read keeps looking for its target, and the reveal waits on it.
    const prior = readsRef.current.get(directory);
    const reload = !active && Boolean(prior?.active?.());
    if (reload) ({ find, active } = prior);
    const generation = (tokensRef.current.get(directory) ?? 0) + 1;
    tokensRef.current.set(directory, generation);
    abortListing(directory);
    const { signal } = controllersRef.current.set(directory, new AbortController()).get(directory);
    const hidden = hiddenRef.current;
    setFolders((current) => withFolder(current, directory, { ...current.get(directory), status: "loading", loadingMore: false, moreError: "" }));
    const fresh = () => aliveRef.current && tokensRef.current.get(directory) === generation;
    // A superseded reveal stops paging; the pages read so far are installed.
    const wanted = () => (!active || active() ? find : "");
    const replacement = () => { const next = readsRef.current.get(directory); return active && next?.active === active && next.generation > generation ? next.promise : undefined; };
    const promise = (async () => { try {
      const read = (cursor) => api(query("/api/files", { projectId: project.id, path: worktree.path, dir: directory, cursor, hidden: hidden ? "true" : undefined,
        limit: find ? MAX_PAGE_SIZE : keep > PAGE_SIZE ? Math.min(keep, MAX_PAGE_SIZE) : undefined }), { signal });
      const page = await read();
      let entries = page.entries;
      while (fresh() && page.nextCursor && needsPage(entries, { keep, find: wanted() })) {
        Object.assign(page, await read(page.nextCursor));
        entries = [...entries, ...page.entries];
      }
      if (!fresh()) return replacement();
      readsRef.current.delete(directory);
      setFolders((current) => withFolder(current, directory, { status: "loaded", generation, hidden, entries,
        nextCursor: page.nextCursor, total: page.total, remaining: page.remaining, hiddenCount: page.hiddenCount, truncated: page.truncated, scanLimit: page.scanLimit }));
      if (wanted() && !entries.some((entry) => entry.path === find)) setAnnouncement(`${find} is not ${page.nextCursor || page.truncated ? `in the first ${entries.length} entries of` : "in"} ${directory || "the worktree root"}`);
      return entries;
    } catch (error) {
      if (!fresh()) return replacement();
      readsRef.current.delete(directory);
      if (reportable(error)) onErrorRef.current(error);
      setFolders((current) => withFolder(current, directory, { status: "error", error: { message: error.message, code: error.payload?.code ?? "" } }));
    } })();
    readsRef.current.set(directory, { generation, find, active, reload, promise });
    return promise;
  }, [project.id, worktree.path]);

  // Ends a folder's read in flight, which a stopped reveal or a collapse no longer
  // wants: its answer is dropped, and the listing shown before stays (`keepShown`)
  // or the folder is read afresh when next opened.
  const dropListing = (directory, keepShown) => {
    const shown = foldersRef.current.get(directory);
    if ((!readsRef.current.has(directory) && !shown?.loadingMore) || (keepShown && !shown?.entries)) return false;
    readsRef.current.delete(directory);
    const generation = (tokensRef.current.get(directory) ?? 0) + 1;
    tokensRef.current.set(directory, generation);
    abortListing(directory);
    controllersRef.current.set(directory, new AbortController());
    setFolders((current) => { const next = new Map(current); if (keepShown) next.set(directory, { ...current.get(directory), status: "loaded", loadingMore: false, generation }); else next.delete(directory); return next; });
    return true;
  };
  // A reload's read stays: it was asked for in its own right.
  const dropReveal = () => { for (const [directory, read] of readsRef.current) if (read.active && !read.reload) dropListing(directory, true); };

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
      const page = await api(query("/api/files", { projectId: project.id, path: worktree.path, dir: directory, cursor: folder.nextCursor, hidden: folder.hidden ? "true" : undefined }), { signal: controllersRef.current.get(directory)?.signal });
      if (!fresh()) return;
      setFolders((current) => installed(current) ? withFolder(current, directory, { ...current.get(directory), loadingMore: false, entries: [...current.get(directory).entries, ...page.entries],
        nextCursor: page.nextCursor, total: page.total, remaining: page.remaining, hiddenCount: page.hiddenCount, truncated: page.truncated, scanLimit: page.scanLimit }) : current);
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
      if (directory && !expandedRef.current.has(directory)) { tokensRef.current.set(directory, (tokensRef.current.get(directory) ?? 0) + 1); abortListing(directory); readsRef.current.delete(directory); }
    }
    const loaded = foldersRef.current;
    setFolders((current) => new Map([...current].filter(([directory]) => !directory || expandedRef.current.has(directory))));
    for (const directory of ["", ...expandedRef.current]) void loadFolder(directory, { keep: keepPages ? loaded.get(directory)?.entries?.length ?? 0 : 0 });
  }, [loadFolder]);
  const refresh = useCallback(() => { reloadAll({ keepPages: true }); setRefreshKey((value) => value + 1); }, [reloadAll]);

  useEffect(() => { void loadFolder(""); }, [loadFolder]);
  const listedHiddenRef = useRef(showHidden);
  useEffect(() => {
    saveHiddenPreference(browserStorage, showHidden);
    if (listedHiddenRef.current === showHidden) return;
    listedHiddenRef.current = showHidden;
    reloadAll();
  }, [showHidden, reloadAll]);

  // `completions` counts runs that ended in this worktree's chats (App.jsx),
  // so no other event can hide one. One refresh covers a burst.
  const completionsRef = useRef(completions);
  const refreshTimerRef = useRef(null);
  useEffect(() => {
    if (completions === completionsRef.current) return;
    completionsRef.current = completions;
    clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(refresh, 400);
  }, [completions, refresh]);
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
  const scrollRef = useRef("");
  // A newer reveal or a tree activation stops a reveal, with its scroll and pending focus move.
  const revealRef = useRef(0);
  const stopReveal = (id = shownIdRef.current) => { revealRef.current += 1; dropReveal(); scrollRef.current = ""; moveRef.current = false; setFocusedId(id); };
  // The file whose reveal waits for the runtime's answer (onResolved); the user's own tree action drops it.
  const pendingOpenRef = useRef("");
  const takeTree = (id) => { pendingOpenRef.current = ""; stopReveal(id); };
  // Every runtime answer passes this gate: only the answer to an open nothing has superseded may reveal or move focus.
  const claimOpen = (file) => { const owned = pendingOpenRef.current === file; pendingOpenRef.current = ""; return owned; };
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
    // A revealed row is scrolled into view wherever focus is (scrollIntoTree).
    if (foundIndex >= 0 && scrollRef.current === focusedId) { scrollRef.current = ""; scrollIntoTree(tree, rowElement(tree, focusedId), 8); }
    const current = document.activeElement;
    const currentRow = current && tree.contains(current) ? current.closest("[data-row-id]") : null;
    let target = "";
    if (currentRow) {
      // A move to a row not listed yet stays pending, and focus stays put.
      if (moveRef.current) target = foundIndex >= 0 ? activeId : "";
      else if (currentRow.dataset.rowId !== focusedId && rows.some((row) => row.id === currentRow.dataset.rowId)) setFocusedId(currentRow.dataset.rowId);
    } else if ((!current || current === document.body) && treeFocusedRef.current && lastFocusRef.current && rows.length) {
      const { id, index } = lastFocusRef.current;
      target = rows.some((row) => row.id === id) ? id : rows[Math.min(index, rows.length - 1)].id;
      if (target !== focusedId) setFocusedId(target);
    }
    if (target) {
      const element = rowElement(tree, target);
      if (element && element !== current) element.focus({ preventScroll: false });
      if (element && target === activeId && foundIndex >= 0) moveRef.current = false;
    }
    rowsRef.current = rows;
    if (tree.contains(document.activeElement)) noteFocusedRow(document.activeElement);
    else if (document.activeElement && document.activeElement !== document.body) treeFocusedRef.current = false;
  }, [activeId, foundIndex, focusedId, rows]);

  const toggleFolder = useCallback((path, open) => {
    if (!isFolderPath(path)) return;
    // A collapse closes every folder under it too, so a reload reads only shown folders;
    // the reads in flight under it end, and those folders are read afresh when opened.
    const under = (directory) => directory === path || directory.startsWith(`${path}/`);
    if (!open) for (const directory of [...foldersRef.current.keys()].filter(under)) dropListing(directory, false);
    setExpanded((current) => {
      const next = new Set(current);
      if (open) next.add(path); else for (const each of current) if (under(each)) next.delete(each);
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

  // A click on a row activates it like Enter; the tree, which owns keyboard
  // handling for its rows, also owns their pointer activation.
  const onTreeClick = (event) => {
    const id = event.target.closest?.("[data-row-id]")?.dataset.rowId;
    const row = rows.find((candidate) => candidate.id === id);
    if (!row) return;
    takeTree(row.id);
    activate(row);
  };
  const onTreeKeyDown = (event) => {
    noteFocusedRow(event.target);
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    // The row that has focus owns the key, even before its focus is rendered.
    const focusedIndex = rows.findIndex((item) => item.id === event.target.closest?.("[data-row-id]")?.dataset.rowId);
    const index = focusedIndex >= 0 ? focusedIndex : activeIndex;
    const row = rows[index];
    if (!row) return;
    if (["Enter", " ", "ArrowRight", "ArrowLeft"].includes(event.key) || treeKeyTarget(rows, index, event.key) >= 0) takeTree(row.id);
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(row); return; }
    if (event.key === "ArrowRight" && row.expandable && !row.open) { event.preventDefault(); toggleFolder(row.entry.path, true); return; }
    if (event.key === "ArrowLeft" && row.expandable && row.open) { event.preventDefault(); toggleFolder(row.entry.path, false); return; }
    const target = treeKeyTarget(rows, index, event.key);
    if (target < 0) return;
    event.preventDefault();
    moveFocus(rows[target].id);
  };

  // Shows `path` in the tree: opens each folder on its way and reads each
  // until it lists the next step (revealPath), and opens `path` with `open`.
  // Only folders found are opened; a failed reveal leaves no scroll or focus move armed.
  const reveal = useCallback(async (path, open) => {
    dropReveal();
    const generation = ++revealRef.current;
    const active = () => aliveRef.current && revealRef.current === generation;
    const expand = (paths) => setExpanded((current) => new Set([...current, ...paths]));
    const target = `entry:${path}`;
    const chain = revealable(path) ? ancestorsOf(path) : [];
    scrollRef.current = target;
    moveFocus(target);
    if (!await revealPath(foldersRef.current, path, (step) => { expand(chain.slice(0, step.depth)); return loadFolder(step.directory, { ...step, active }); }, active, chain)) { if (active()) stopReveal(); return; }
    expand([...chain, ...(open ? [path] : [])]);
    if (open && !foldersRef.current.has(path)) void loadFolder(path);
  }, [loadFolder, moveFocus]);

  // A preview action replaces the control it was activated on, so focus on
  // the preview (or lost) moves first to the tree, which then follows its move.
  const keepFocus = useCallback(() => {
    const tree = treeRef.current;
    const current = document.activeElement;
    if (tree && (!current || current === document.body || (tree.parentElement.contains(current) && !tree.contains(current)))) tree.querySelector('[tabindex="0"]')?.focus();
  }, []);

  // Opens an exact worktree path, such as a resolved Markdown link target.
  const openPath = useCallback((file) => {
    if (typeof file !== "string" || !file) return;
    if (!revealable(file)) { setAnnouncement("That path is too long or invalid to open"); return; }
    setAnnouncement(`Opening ${file}`);
    keepFocus();
    pendingOpenRef.current = file;
    // The runtime already named this path (a repeated open gets no new answer); on Windows "\\" separates folders: revealed in onResolved.
    if (resolved.file === file) void reveal(resolved.path, false); else if (file.includes("\\")) stopReveal(); else void reveal(file, false);
    setSelected(file);
  }, [reveal, keepFocus, resolved]);
  // The tree selects the runtime's path; it is revealed only for an open that nothing has superseded.
  const onResolved = useCallback((file, path) => {
    const owned = claimOpen(file);
    setResolved({ file, path });
    if (owned && (path !== file || file.includes("\\"))) void reveal(path, false);
  }, [reveal]);

  const revealFolder = useCallback((path) => {
    const owned = claimOpen(path);
    setSelected((current) => (current === path ? "" : current));
    setAnnouncement(`${path} is a folder${owned ? "; it is open in the tree" : ""}`);
    keepFocus();
    if (owned) void reveal(path, true);
  }, [reveal, keepFocus]);

  // A Windows runtime, whose worktree path has a drive or UNC prefix, also separates folders with "\\"; elsewhere it is part of a name.
  const refreshFolderOf = useCallback((file) => {
    const directory = ancestorsOf(/^([A-Za-z]:|\\\\)/.test(worktree.path) ? file.replaceAll("\\", "/") : file).at(-1) ?? "";
    keepFocus();
    if (directory) moveFocus(`entry:${directory}`);
    void loadFolder(directory);
    setSelected("");
    setAnnouncement(`Refreshed ${directory || "the worktree root"}`);
  }, [loadFolder, keepFocus, moveFocus, worktree.path]);

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
    if (row.type === "more") return row.loading ? "Loading more…" : row.error ? `Could not load more: ${row.error}. Retry` : row.remaining ? `Load ${Math.min(row.remaining, PAGE_SIZE)} more of ${row.remaining}` : "Load more";
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
    <form className="files-jump" role="search" aria-label="Go to file" onSubmit={(event) => { event.preventDefault(); openPath(normalizeTypedPath(jump)); }}>
      <Input ref={jumpRef} aria-label="Go to file path" placeholder={`Go to file… (${quickOpenHint})`} value={jump} onChange={(event) => setJump(event.target.value)} spellCheck={false} autoComplete="off" />
    </form>
    <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
    <div className="files-layout">
      <div className="file-tree" role="tree" aria-label={`Files in ${worktree.name}`} aria-busy={root?.status === "loading"} ref={treeRef} onKeyDown={onTreeKeyDown} onClick={onTreeClick} onFocus={onTreeFocus} onBlur={onTreeBlur}>
        {rows.map((row) => <TreeRow key={row.id} row={row} label={rowLabel(row)} active={row.id === activeId} selected={row.type === "entry" && row.entry.path === (resolved.file === selected ? resolved.path : selected)}
          onFocus={() => { moveRef.current = false; setFocusedId(row.id); }} />)}
      </div>
      {selected ? <FilePreview key={selected} project={project} worktree={worktree} file={selected} refreshKey={refreshKey} settings={settings} onError={onError}
        onNavigate={openPath} onResolved={onResolved} onFolder={revealFolder} onRefreshFolder={refreshFolderOf} />
        : <div className="file-preview preview-state" role="note">Choose a file to preview it. Markdown, text, images and PDFs open here.</div>}
    </div>
  </section>;
}

// Rows laid out late (content-visibility) can move a row, so it is checked for a few frames.
function scrollIntoTree(tree, row, frames) {
  if (!row?.isConnected) return;
  const box = row.getBoundingClientRect(), view = tree.getBoundingClientRect();
  if (box.top < view.top || box.bottom > view.bottom) row.scrollIntoView({ block: "nearest" });
  if (frames) requestAnimationFrame(() => scrollIntoTree(tree, row, frames - 1));
}

function withFolder(folders, directory, folder) {
  const next = new Map(folders);
  next.set(directory, folder);
  return next;
}

function TreeRow({ row, label, active, selected, onFocus }) {
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
    style={{ "--tree-level": row.level - 1 }} onFocus={onFocus}>
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
