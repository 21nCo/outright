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

export function visibleRows(folders, expanded) {
  const rows = [];
  // A folder is shown once per tree, however its entries name it.
  const visited = new Set();
  const visit = (directory, level) => {
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
    folder.entries.forEach((entry, index) => {
      const expandable = isExpandable(entry);
      const open = expandable && expanded.has(entry.path) && !visited.has(entry.path);
      rows.push({ id: entryRowId(directory, entry), type: "entry", entry, directory, level, expandable, open,
        setSize, position: index + 1 });
      if (open) visit(entry.path, level + 1);
    });
    // While the first page reloads, the old cursor belongs to a listing that
    // is being replaced, so "load more" waits for the new one.
    if (folder.nextCursor) rows.push({ id: `more:${directory}`, type: "more", directory, level, loading: Boolean(folder.loadingMore) || folder.status === "loading", error: folder.moreError, remaining });
    if (folder.truncated) rows.push({ id: `truncated:${directory}`, type: "truncated", directory, level, limit: folder.scanLimit });
  };
  visit("", 1);
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
    const { directory } = rows[index];
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

// A typed path, as the runtime names it. Only separators are tidied: leading
// "./" and "/", trailing and repeated slashes. Spaces and backslashes are part
// of a POSIX name, so they are kept and never select a different file. The
// runtime still refuses anything outside the root.
export function normalizeTypedPath(value) {
  const typed = String(value ?? "");
  if (!typed.trim()) return "";
  // Runs of "/" are collapsed before one trailing "/" is dropped, so no
  // pattern backtracks across a long run (linear in the typed length).
  const collapsed = typed.replace(/^(?:\.\/|\/)+/, "").replace(/\/{2,}/g, "/");
  return collapsed.endsWith("/") ? collapsed.slice(0, -1) : collapsed;
}

export function ancestorsOf(file) {
  const parts = file.split("/");
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
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

// Go to file looks for each step of its path in up to this many entries of a folder.
export const MAX_REVEAL_ENTRIES = 2000;

// Whether a listing read needs another page: to list as many entries as
// were shown, or to reach `find` within MAX_REVEAL_ENTRIES.
export function needsPage(entries, { keep = 0, find = "" } = {}) {
  return entries.length < keep || (Boolean(find) && entries.length < MAX_REVEAL_ENTRIES && !entries.some((entry) => entry.path === find));
}

// The reads that show `path` in the tree: each folder on its way whose
// listing does not name the next step yet, read again until it does.
export function revealReads(folders, path) {
  const chain = ancestorsOf(path);
  return ["", ...chain].flatMap((directory, index) => {
    const find = chain[index] ?? path;
    const folder = folders.get(directory);
    if (folder?.status !== "error" && folder?.entries?.some((entry) => entry.path === find)) return [];
    return [{ directory, find, keep: folder?.entries?.length ?? 0 }];
  });
}

// Whether a run that ended in chat `id` may have changed the shown
// worktree: the chat is one of its open chats, or its chat lists (archived
// ones too, since a chat can be archived while its run finishes) name it.
export async function worktreeOwnsChat(id, openChats, listChats) {
  if (openChats.some((chat) => chat.id === id)) return true;
  const lists = await Promise.all([listChats(false), listChats(true)]).catch(() => []);
  return lists.some((chats) => chats.some((chat) => chat.id === id));
}
