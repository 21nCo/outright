// The Files tree's visible rows, in reading order. Folders load lazily, so a
// row is an entry, or a folder's loading, failure, empty, "load more" or
// scan-limit state; each is reachable from the keyboard. Folders are kept in
// a Map keyed by path, so a folder named "constructor" or "__proto__" is an
// ordinary key rather than an inherited property. An entry without a path
// (a name that is not UTF-8) cannot be addressed, so it never expands.

export function isExpandable(entry) {
  return isFolderPath(entry?.path) && (entry.kind === "directory" || (entry.kind === "symlink" && entry.target?.state === "directory"));
}

// A path names one entry; an entry without one is named by its folder and
// its raw name bytes (nameKey), since two such names can decode alike. Ids
// carry no NUL or other control character (JSON escapes them), since a row
// id is a DOM attribute value.
export function entryRowId(directory, entry) {
  return typeof entry.path === "string" ? `entry:${entry.path}` : `raw:${JSON.stringify([directory, entry.nameKey ?? entry.name])}`;
}

// The row element with `id`, compared as a string rather than through a CSS
// selector, which cannot match every attribute value.
export function rowElement(tree, id) {
  for (const element of tree.querySelectorAll("[data-row-id]")) if (element.dataset.rowId === id) return element;
  return null;
}

// The show-hidden choice is saved in the browser. Storage that is full,
// unavailable or refused (a private window, a sandboxed frame) keeps the
// choice in memory for this pane: reading gives false and saving returns
// false, and neither throws into the workspace. `storage` returns the
// Storage, so a refused localStorage getter is caught here too.
export const HIDDEN_FILES_KEY = "outright.files.show-hidden";

export function readHiddenPreference(storage) {
  try { return storage().getItem(HIDDEN_FILES_KEY) === "true"; } catch { return false; }
}

export function saveHiddenPreference(storage, value) {
  try { storage().setItem(HIDDEN_FILES_KEY, String(Boolean(value))); return true; } catch { return false; }
}

export function isFolderPath(path) { return typeof path === "string" && path !== ""; }

// Folders are walked with an explicit stack, not recursion, so a chain of
// open folders as deep as the deepest revealable path (2,047 levels) cannot
// overflow the call stack. Rows come out in the same depth-first order.
export function visibleRows(folders, expanded) {
  const rows = [];
  // A folder is shown once per tree, however its entries name it.
  const visited = new Set();
  const stack = [];
  // Adds a folder's own state rows; a listed folder is pushed for its entries.
  const enter = (directory, level) => {
    visited.add(directory);
    const folder = folders.get(directory);
    if (!folder || (folder.status === "loading" && !folder.entries)) { rows.push({ id: `loading:${directory}`, type: "loading", directory, level }); return; }
    if (folder.status === "error" && folder.error?.code === "LISTING_UNAVAILABLE") { rows.push({ id: `unavailable:${directory}`, type: "unavailable", directory, level, error: folder.error }); return; }
    if (folder.status === "error") { rows.push({ id: `error:${directory}`, type: "error", directory, level, error: folder.error }); return; }
    if (!folder.entries.length) rows.push({ id: `empty:${directory}`, type: "empty", directory, level, hiddenCount: folder.hiddenCount });
    // What follows the shown entries, as the server counted it with the
    // last page; unknown (null) without that count. The folder's total
    // can mix generations once later pages are added to earlier ones.
    let remaining = 0;
    if (folder.nextCursor) remaining = Number.isInteger(folder.remaining) && folder.remaining >= 0 ? folder.remaining : null;
    const setSize = remaining === null ? folder.entries.length : folder.entries.length + remaining;
    stack.push({ directory, level, folder, remaining, setSize, index: 0 });
  };
  enter("", 1);
  while (stack.length) {
    const frame = stack.at(-1);
    const { directory, level, folder } = frame;
    if (frame.index < folder.entries.length) {
      const entry = folder.entries[frame.index];
      frame.index += 1;
      const expandable = isExpandable(entry);
      const open = expandable && expanded.has(entry.path) && !visited.has(entry.path);
      rows.push({ id: entryRowId(directory, entry), type: "entry", entry, directory, level, expandable, open,
        setSize: frame.setSize, position: frame.index });
      if (open) enter(entry.path, level + 1);
      continue;
    }
    stack.pop();
    // While the first page reloads, the old cursor belongs to a listing that
    // is being replaced, so "load more" waits for the new one.
    if (folder.nextCursor) rows.push({ id: `more:${directory}`, type: "more", directory, level, loading: Boolean(folder.loadingMore) || folder.status === "loading", error: folder.moreError, remaining: frame.remaining });
    if (folder.truncated) rows.push({ id: `truncated:${directory}`, type: "truncated", directory, level, limit: folder.scanLimit });
  }
  return rows;
}

// The row a key moves to from `index`, or -1 when the key is not a move.
export function treeKeyTarget(rows, index, key) {
  if (!rows.length) return -1;
  if (key === "ArrowDown") return Math.min(rows.length - 1, index + 1);
  if (key === "ArrowUp") return Math.max(0, index - 1);
  if (key === "Home") return 0;
  if (key === "End") return rows.length - 1;
  if (key === "ArrowLeft") {
    const directory = rows[index]?.directory;
    return directory ? rows.findIndex((row) => row.type === "entry" && row.entry.path === directory) : -1;
  }
  if (key === "ArrowRight") return rows[index]?.open ? Math.min(rows.length - 1, index + 1) : -1;
  if (key.length === 1 && key.trim()) {
    const lower = key.toLowerCase();
    for (let step = 1; step <= rows.length; step += 1) {
      const row = rows[(index + step) % rows.length];
      if (row.type === "entry" && row.entry.name.toLowerCase().startsWith(lower)) return (index + step) % rows.length;
    }
  }
  return -1;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

// A typed path, as the runtime names it: empty and "." segments are dropped as it drops them. Spaces
// and backslashes are part of a POSIX name, so they are kept (on Windows, see FilePreview onResolved).
export function normalizeTypedPath(value) {
  const typed = String(value ?? "");
  if (!typed.trim()) return "";
  return typed.split("/").filter((segment) => segment && segment !== ".").join("/");
}

// The runtime refuses a path over 4096 characters, or with NUL, so none is planned or read.
export const revealable = (path) => typeof path === "string" && path !== "" && path.length <= 4096 && !path.includes("\0");

export function ancestorsOf(file) {
  const found = [];
  for (let at = file.indexOf("/"); at > 0; at = file.indexOf("/", at + 1)) found.push(file.slice(0, at));
  return found;
}

// Text is compared as text (and size), so a write the file's version cannot see (a
// timestamp of coarse resolution) is still shown. An image or PDF is kept
// only on the same version, which raw also checks before serving bytes.
export function samePreview(shown, next) {
  if (shown.previewType !== next.previewType || (shown.link?.target ?? null) !== (next.link?.target ?? null)) return false;
  // The size is shown too: a byte order mark added or removed leaves the
  // decoded text alike but changes it.
  if (typeof shown.text === "string" || typeof next.text === "string") return shown.text === next.text && shown.size === next.size;
  return shown.version === next.version && shown.size === next.size && shown.limit === next.limit && shown.reason === next.reason;
}

// A preview's state names the target it was asked for: its project, worktree
// and file. The runtime's resolved path, the label and Refresh folder target
// it gives, and a preview a refresh may keep, carry over only within the same
// target, never to another file or another worktree's file of the same name.
export const sameTarget = (a, b) => a?.projectId === b?.projectId && a?.worktreePath === b?.worktreePath && a?.file === b?.file;
const keptPath = (prior, target) => (sameTarget(prior?.target, target) ? prior.path : undefined);
export const loadingPreview = (prior, target) => ({ status: "loading", target, path: keptPath(prior, target) });
export const failedPreview = (prior, target, error) => ({ status: "error", target, path: keptPath(prior, target), code: error?.payload?.code ?? "", message: error?.message });
export const shownPreview = (state, target, mediaFailed) => (state.status === "ready" && sameTarget(state.target, target) && !mediaFailed ? state : null);
export const openedPath = (state, target) => (sameTarget(state.target, target) && state.path) || target.file;

// What a viewer that did not load offers (module-retry.js): one only a page
// reload repairs offers the reload, and an in-place retry only when retryable;
// any other failure offers the retry.
export const viewerFailure = (error) => (error?.reloadRequired ? { reload: true, retry: Boolean(error.retryable) } : { reload: false, retry: true });

// Go to file looks for each step of its path in up to this many entries of a folder.
export const MAX_REVEAL_ENTRIES = 2000;

// Whether a listing read needs another page: to list as many entries as
// were shown, or to reach `find` within MAX_REVEAL_ENTRIES.
export function needsPage(entries, { keep = 0, find = "" } = {}) {
  return entries.length < keep || (Boolean(find) && entries.length < MAX_REVEAL_ENTRIES && !entries.some((entry) => entry.path === find));
}

// The reads that show `path` in the tree: each folder on its way whose
// listing does not name the next step yet, read again until it does (depth: folders of `chain` it opens).
export function revealReads(folders, path, chain = ancestorsOf(path)) {
  return ["", ...chain].flatMap((directory, depth) => {
    const find = chain[depth] ?? path;
    const folder = folders.get(directory);
    if (folder?.status !== "error" && folder?.entries?.some((entry) => entry.path === find)) return [];
    return [{ directory, find, keep: folder?.entries?.length ?? 0, depth }];
  });
}

// Makes those reads one at a time, in order, and stops at a folder that does
// not list its next step (missing, refused or past the bound) or once
// `active()` is false, so a path deeper than what exists costs one read; a refused path costs none.
export async function revealPath(folders, path, read, active, chain) {
  if (!revealable(path)) return false;
  for (const step of revealReads(folders, path, chain ?? ancestorsOf(path))) {
    const entries = await read(step);
    if (!active() || !entries?.some((entry) => entry.path === step.find)) return false;
  }
  return true;
}

// Whether a run that ended in chat `id` may have changed the shown worktree:
// a listed chat answers at once; any other (archived while its run finished,
// or another project's) is read alone, so the cost does not grow with history.
export async function worktreeOwnsChat(id, { projectId, worktreeId }, knownChats, readChat) {
  const chat = knownChats.find((known) => known.id === id) ?? await readChat(id).catch(() => null);
  return chat?.projectId === projectId && chat?.worktreeId === worktreeId;
}
