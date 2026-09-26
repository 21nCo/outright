import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PROVIDERS = [
  { id: "codex", label: "Codex", models: ["gpt-5.4", "gpt-5.3-codex"] },
  { id: "claude", label: "Claude Code", models: ["sonnet", "opus", "haiku"] },
];

export function createProviderDiscovery({ probe = defaultProbe, onChange = () => {}, refreshMs = 30_000 } = {}) {
  let snapshot = PROVIDERS.map((provider) => ({ ...provider, available: false, version: "", checking: true }));
  const pending = new Map();
  const lastChecked = new Map();
  let closed = false;

  function probeProvider(id, force = false) {
    const provider = PROVIDERS.find((item) => item.id === id);
    if (!provider) return Promise.resolve(false);
    if (pending.has(id)) return pending.get(id);
    if (!force && lastChecked.has(id) && Date.now() - lastChecked.get(id) < refreshMs) return Promise.resolve(snapshot.find((item) => item.id === id)?.available === true);
    const task = (async () => {
      let next;
      try {
        const version = await probe(id);
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
    })().finally(() => { if (pending.get(id) === task) pending.delete(id); });
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
  const timer = setInterval(() => { refresh(); }, refreshMs);
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
      if (sharedProbe) await sharedProbe;
      if (closed) return false;
      return probeProvider(id, true);
    },
    close() { closed = true; clearInterval(timer); },
  };
}

async function defaultProbe(id) {
  const { stdout, stderr } = await execFileAsync(id, ["--version"], { encoding: "utf8", timeout: 2500, maxBuffer: 16 * 1024, windowsHide: true });
  return stdout || stderr || "";
}
