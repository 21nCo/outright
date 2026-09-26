import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PROVIDERS = [
  { id: "codex", label: "Codex", models: ["gpt-5.4", "gpt-5.3-codex"] },
  { id: "claude", label: "Claude Code", models: ["sonnet", "opus", "haiku"] },
];

export function createProviderDiscovery({ probe = defaultProbe, onChange = () => {}, refreshMs = 30_000 } = {}) {
  let snapshot = PROVIDERS.map((provider) => ({ ...provider, available: false, version: "", checking: true }));
  let pending = null;
  let lastChecked = 0;
  let closed = false;

  function refresh(force = false) {
    if (closed) return Promise.resolve(snapshot);
    if (pending) return pending;
    if (!force && lastChecked && Date.now() - lastChecked < refreshMs) return Promise.resolve(snapshot);
    pending = Promise.all(PROVIDERS.map(async (provider) => {
      try {
        const version = await probe(provider.id);
        return { ...provider, available: true, version: String(version).trim(), checking: false };
      } catch {
        return { ...provider, available: false, version: "", checking: false };
      }
    })).then((next) => {
      if (!closed) {
        const changed = JSON.stringify(next) !== JSON.stringify(snapshot);
        snapshot = next;
        lastChecked = Date.now();
        if (changed) onChange(snapshot);
      }
      return snapshot;
    }).finally(() => { pending = null; });
    return pending;
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
      // A negative snapshot is only display state. Authorization must retry a
      // newly installed CLI or a transient probe failure on this attempt.
      const sharedProbe = pending;
      if (entry.checking || !entry.available) {
        await refresh(!entry.checking);
        if (sharedProbe && !snapshot.find((provider) => provider.id === id)?.available) await refresh(true);
      }
      else if (Date.now() - lastChecked >= refreshMs) refresh();
      return snapshot.find((provider) => provider.id === id)?.available === true;
    },
    close() { closed = true; clearInterval(timer); },
  };
}

async function defaultProbe(id) {
  const { stdout, stderr } = await execFileAsync(id, ["--version"], { encoding: "utf8", timeout: 2500, maxBuffer: 16 * 1024, windowsHide: true });
  return stdout || stderr || "";
}
