// The socket callback runs before React commits the terminal warning. Fence
// commands at that boundary so another runtime event cannot reopen input.
export function createTerminalCommandFence() {
  // Each fenced ID keeps the runtime instance that reported it unverified.
  const unknown = new Map();
  let runtime = null;
  return {
    observe(event) {
      if (event.type === "runtime.connected") return release(event.payload);
      if (event.type !== "terminal.audit-failed" || typeof event.terminalId !== "string") return false;
      unknown.delete(event.terminalId);
      unknown.set(event.terminalId, runtime);
      // The runtime permits at most 256 terminals. Older IDs have either
      // been removed or remain protected by the server's ownership check.
      if (unknown.size > 256) unknown.delete(unknown.keys().next().value);
      return true;
    },
    allows(message) {
      return !["terminal.input", "terminal.resize"].includes(message.type) || !unknown.has(message.terminalId);
    },
    snapshot() { return new Set(unknown.keys()); },
  };

  // A later runtime that verified a live reattach owns the same process
  // again, so the earlier runtime's fence no longer applies. A reconnect to
  // the runtime that fenced it, an unverified reservation or any status but
  // running keeps the fence.
  function release(payload) {
    const instance = typeof payload?.runtimeInstanceId === "string" ? payload.runtimeInstanceId : null;
    if (!instance) return false;
    runtime = instance;
    // Events replayed before this page's first connection came from the
    // runtime that is now connecting.
    for (const [id, owner] of unknown) if (owner === null) unknown.set(id, instance);
    if (!Array.isArray(payload.terminals)) return false;
    let released = false;
    for (const terminal of payload.terminals) {
      if (!terminal || terminal.status !== "running" || terminal.reattached !== true || terminal.recoveryReservation) continue;
      if (!unknown.has(terminal.id) || unknown.get(terminal.id) === instance) continue;
      unknown.delete(terminal.id);
      released = true;
    }
    return released;
  }
}
