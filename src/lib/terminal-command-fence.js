// The socket callback runs before React commits the terminal warning. Fence
// commands at that boundary so another runtime event cannot reopen input.
export function createTerminalCommandFence() {
  const unknown = new Set();
  return {
    observe(event) {
      if (event.type !== "terminal.audit-failed" || typeof event.terminalId !== "string") return false;
      unknown.delete(event.terminalId);
      unknown.add(event.terminalId);
      // The runtime permits at most 256 terminals. Older IDs have either
      // been removed or remain protected by the server's ownership check.
      if (unknown.size > 256) unknown.delete(unknown.values().next().value);
      return true;
    },
    allows(message) {
      return !["terminal.input", "terminal.resize"].includes(message.type) || !unknown.has(message.terminalId);
    },
    snapshot() { return new Set(unknown); },
  };
}
