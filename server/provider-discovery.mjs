import { execFile } from "node:child_process";
const PROVIDERS = [
  { id: "codex", label: "Codex", models: ["gpt-5.4", "gpt-5.3-codex"] },
  { id: "claude", label: "Claude Code", models: ["sonnet", "opus", "haiku"] },
];

export function createProviderDiscovery({ probe = defaultProbe, onChange = () => {}, refreshMs = 30_000, schedule = setInterval, cancel = clearInterval } = {}) {
  let snapshot = PROVIDERS.map((provider) => ({ ...provider, available: false, version: "", checking: true }));
  const pending = new Map();
  const controllers = new Map();
  const lastChecked = new Map();
  let closed = false;

  function probeProvider(id, force = false) {
    const provider = PROVIDERS.find((item) => item.id === id);
    if (!provider) return Promise.resolve(false);
    if (pending.has(id)) return pending.get(id);
    if (!force && lastChecked.has(id) && Date.now() - lastChecked.get(id) < refreshMs) return Promise.resolve(snapshot.find((item) => item.id === id)?.available === true);
    const controller = new AbortController();
    controllers.set(id, controller);
    const task = (async () => {
      let next;
      try {
        const version = await probe(id, { signal: controller.signal });
        next = { ...provider, available: true, version: String(version).trim(), checking: false };
      } catch {
        next = { ...provider, available: false, version: "", checking: false };
      }
      if (!closed) {
        const index = snapshot.findIndex((item) => item.id === id);
        const changed = JSON.stringify(snapshot[index]) !== JSON.stringify(next);
        snapshot = snapshot.map((item) => item.id === id ? next : item);
        lastChecked.set(id, Date.now());
        if (changed) onChange(snapshot);
      }
      return next.available;
    })().finally(() => { if (pending.get(id) === task) pending.delete(id); if (controllers.get(id) === controller) controllers.delete(id); });
    pending.set(id, task);
    return task;
  }

  async function refresh(force = false) {
    if (closed) return Promise.resolve(snapshot);
    await Promise.all(PROVIDERS.map((provider) => probeProvider(provider.id, force)));
    return snapshot;
  }

  // Discovery starts independently of HTTP requests. A failed probe remains a
  // normal unavailable result and is retried by the bounded timer.
  queueMicrotask(() => { if (!closed) refresh(); });
  // The timer is a display deadline measured from startup. A probe that
  // finishes just after a tick must not make the next tick skip discovery.
  const timer = schedule(() => { refresh(true); }, refreshMs);
  timer.unref?.();

  return {
    list() { return snapshot; },
    refresh,
    async available(id) {
      const entry = snapshot.find((provider) => provider.id === id);
      if (!entry) return false;
      // The snapshot is display state, never authorization. A CLI may have
      // been removed since a positive result or installed during a probe.
      const sharedProbe = pending.get(id);
      if (sharedProbe) {
        const available = await sharedProbe;
        if (closed) return false;
        // A successful probe already in flight is the freshest possible
        // authorization result. A failed one may have started before install.
        if (available) return true;
      }
      if (closed) return false;
      return probeProvider(id, true);
    },
    async close() {
      closed = true;
      cancel(timer);
      for (const controller of controllers.values()) controller.abort();
      await Promise.allSettled([...pending.values()]);
    },
  };
}

export async function defaultProbe(id, { signal } = {}) {
  return new Promise((resolve, reject) => {
    let outcome;
    let closed = false;
    let settled = false;
    let terminationError;
    let escalation;
    const cleanup = () => {
      clearTimeout(timeout);
      clearTimeout(deadline);
      clearTimeout(escalation);
      signal?.removeEventListener("abort", abort);
    };
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const finish = () => {
      if (!closed || !outcome) return;
      settle(terminationError ?? outcome.error, outcome.stdout || outcome.stderr || "");
    };
    const child = execFile(id, ["--version"], { encoding: "utf8", maxBuffer: 16 * 1024, windowsHide: true },
      (error, stdout, stderr) => { outcome = { error, stdout, stderr }; finish(); });
    child.once("close", () => { closed = true; finish(); });
    const terminate = (reason) => {
      if (settled) return;
      terminationError ??= reason;
      try { child.kill("SIGTERM"); } catch { /* Already exited. */ }
      escalation = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* Already exited. */ } }, 100);
    };
    const abort = () => terminate(new Error(`Provider version check aborted: ${id}`));
    const timeout = setTimeout(() => terminate(new Error(`Provider version check timed out: ${id}`)), 2500);
    // A child that never reports close cannot retain discovery shutdown.
    // SIGKILL is attempted before this deadline; unresolved cleanup is an
    // error rather than a successful version check.
    const deadline = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* Already exited. */ }
      settle(new Error(`Provider version check did not close: ${id}`));
    }, 3500);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
