// The Files tree's visible rows, in reading order. Folders load lazily, so a
// row is an entry, or a folder's loading, failure, empty, "load more" or
// scan-limit state; each is reachable from the keyboard. Folders are kept in
// a Map keyed by path, so a folder named "constructor" or "__proto__" is an
// ordinary key rather than an inherited property.

export function isExpandable(entry) { return entry?.kind === "directory" || (entry?.kind === "symlink" && entry.target?.state === "directory"); }

export function visibleRows(folders, expanded) {
  const rows = [];
  const visit = (directory, level) => {
    const folder = folders.get(directory);
    if (!folder || (folder.status === "loading" && !folder.entries)) { rows.push({ id: `loading:${directory}`, type: "loading", directory, level }); return; }
    if (folder.status === "error") { rows.push({ id: `error:${directory}`, type: "error", directory, level, error: folder.error }); return; }
    if (!folder.entries.length) rows.push({ id: `empty:${directory}`, type: "empty", directory, level, hiddenCount: folder.hiddenCount });
    folder.entries.forEach((entry, index) => {
      const expandable = isExpandable(entry);
      const open = expandable && expanded.has(entry.path);
      rows.push({ id: `entry:${entry.path ?? `${directory}\u0000${entry.name}`}`, type: "entry", entry, directory, level, expandable, open,
        setSize: Math.max(folder.total, folder.entries.length), position: index + 1 });
      if (open) visit(entry.path, level + 1);
    });
    if (folder.nextCursor) rows.push({ id: `more:${directory}`, type: "more", directory, level, loading: Boolean(folder.loadingMore), error: folder.moreError, remaining: folder.total - folder.entries.length });
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

// A typed path, as the runtime names it. Leading "./" and "/" and trailing
// slashes are dropped; the runtime still refuses anything outside the root.
export function normalizeTypedPath(value) {
  return String(value ?? "").trim().replace(/\\/g, "/").replace(/^(?:\.\/|\/)+/, "").replace(/\/+$/, "").replace(/\/{2,}/g, "/");
}

export function ancestorsOf(file) {
  const parts = file.split("/");
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
}
