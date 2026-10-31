// Restore previews can list thousands of paths; they are shown in pages.
export const RESTORE_PAGE_SIZE = 200;

const FILE_ACTIONS = { create: "Create file", update: "Replace file", delete: "Delete file" };
const INDEX_ACTIONS = { add: "Stage", update: "Restage", remove: "Unstage" };

export function checkpointCountsText(counts) {
  const parts = [["staged", counts?.staged], ["unstaged", counts?.unstaged], ["untracked", counts?.untracked]]
    .filter(([, count]) => count > 0).map(([name, count]) => `${count} ${name}`);
  return parts.length ? parts.join(" · ") : "No local changes";
}

export function checkpointTitle(checkpoint) {
  if (checkpoint.unreadable) return "Unreadable checkpoint";
  return checkpoint.label || (checkpoint.reason === "before-restore" ? "Before a restore" : "Checkpoint");
}

// What restoring one path does, in words, for the file on disk and the index.
export function restoreChangeText(entry) {
  return [entry.file && FILE_ACTIONS[entry.file.action], entry.index && INDEX_ACTIONS[entry.index.action]].filter(Boolean).join(" · ");
}

export function groupCheckpointEntries(entries) {
  const groups = { staged: [], unstaged: [], untracked: [] };
  for (const entry of entries ?? []) groups[entry.state]?.push(entry);
  return groups;
}

export function initialRestoreSelection(entries) {
  return new Set(entries.filter((entry) => !entry.blocked).map((entry) => entry.path));
}

// Paths whose file and directory forms both change are chosen together.
export function toggleRestorePath(entries, selected, path, checked) {
  const entry = entries.find((item) => item.path === path);
  if (!entry || entry.blocked) return selected;
  const next = new Set(selected);
  for (const value of [path, ...(entry.coupled ?? [])]) {
    if (checked) next.add(value); else next.delete(value);
  }
  return next;
}

// The chosen paths as a restore names them: listed, or, for a large
// selection, as every path offered except the ones left out, which is
// shorter. The server applies either to the preview it confirms.
export const EXPLICIT_PATHS = 1000;
export function restoreSelection(entries, selected) {
  if (selected.size <= EXPLICIT_PATHS) return { paths: [...selected] };
  const except = entries.filter((entry) => !entry.blocked && !selected.has(entry.path)).map((entry) => entry.path);
  return except.length < selected.size ? { except } : { paths: [...selected] };
}

// Why the confirmed restore cannot be sent yet, or null.
export function restoreBlockedReason(preview, selected, terminalsAcknowledged) {
  if (preview.blockers.length) return preview.blockers.map((blocker) => blocker.message).join("; ");
  if (!selected.size) return "Choose at least one path to restore";
  if (preview.terminals.length && !terminalsAcknowledged) return "Confirm the open terminals first";
  return null;
}
