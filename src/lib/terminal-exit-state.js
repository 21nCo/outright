export function pruneExitedIds(exitedIds, terminals, pending) {
  const retained = new Set(terminals.map((item) => item.id));
  // Preserve an exit observed while its activation snapshot is still pending.
  if (pending?.exit) retained.add(pending.id);
  for (const id of exitedIds) {
    if (!retained.has(id)) exitedIds.delete(id);
  }
}

// A saved session never ran in this Outright process. Its label states how it
// ended and never implies the process is still running or can resume.
export function terminalEndLabel(terminal) {
  if (terminal?.status === "ended" && terminal.endReason === "restart") return "ended when Outright restarted";
  if (terminal?.status === "ended" && terminal.endReason === "closed") return "closed; its saved output could not be deleted";
  if (terminal?.status === "ended" || terminal?.status === "exited") return `process exited ${terminal.exitCode ?? "unknown"}`;
  return "";
}

export function terminalTabLabel(terminal) {
  if (terminal.status === "ended") return `${terminal.name}, saved output, ${terminalEndLabel(terminal)}`;
  if (terminal.status === "unknown") return `${terminal.name}, ownership unverified`;
  const name = terminal.relaunchedFrom ? `${terminal.name}, new shell` : terminal.name;
  return terminal.status === "exited" ? `${name}, ${terminalEndLabel(terminal)}` : name;
}

// Reopening a worktree shows a live or unverified terminal first, then its
// newest saved session. Only when none exists does the pane start a shell.
export function preferredTerminal(terminals, previousId = "") {
  const previous = terminals.find((item) => item.id === previousId && (item.status === "running" || item.status === "ended"));
  if (previous) return previous;
  const running = terminals.find((item) => item.status === "running") ?? terminals.find((item) => item.status === "unknown");
  if (running) return running;
  let saved = null;
  for (const item of terminals) {
    if (item.status === "ended" && (!saved || String(item.endedAt ?? "") >= String(saved.endedAt ?? ""))) saved = item;
  }
  return saved;
}
