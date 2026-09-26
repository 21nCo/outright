export function pruneExitedIds(exitedIds, terminals, pending) {
  const retained = new Set(terminals.map((item) => item.id));
  // Preserve an exit observed while its activation snapshot is still pending.
  if (pending?.exit) retained.add(pending.id);
  for (const id of exitedIds) {
    if (!retained.has(id)) exitedIds.delete(id);
  }
}
