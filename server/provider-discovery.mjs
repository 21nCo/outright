import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const PROVIDERS = [
  { id: "codex", label: "Codex", models: ["gpt-5.4", "gpt-5.3-codex"] },
  { id: "claude", label: "Claude Code", models: ["sonnet", "opus", "haiku"] },
];
const MAX_VERSION_BYTES = 16 * 1024;

function windowsProbeCommand(id) {
  if (!PROVIDERS.some((provider) => provider.id === id)) throw new Error(`Unknown provider: ${id}`);
  let executable = process.env.OUTRIGHT_AGENT_SUPERVISOR_PATH;
  if (!executable) {
    const manifest = JSON.parse(readFileSync(new URL("./bin/agent-supervisor.json", import.meta.url), "utf8"));
    if (typeof manifest.filename !== "string" || !/^agent-supervisor-[0-9a-f]{16}\.exe$/.test(manifest.filename)) {
      throw new Error("Windows agent supervisor manifest is invalid");
    }
    executable = fileURLToPath(new URL(`./bin/${manifest.filename}`, import.meta.url));
  }
  return {
    executable,
    args: [process.env.ComSpec || "cmd.exe", "/d", "/s", "/c", `${id} --version`],
  };
}

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
    let spawnError;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    // The Windows supervisor owns a Job Object. Its handle closing kills even
    // detached descendants of a .cmd shim; a numeric taskkill of cmd.exe alone
    // cannot prove that cleanup once the shim has exited.
    const command = process.platform === "win32" ? windowsProbeCommand(id) : { executable: id, args: ["--version"] };
    const child = spawn(command.executable, command.args, {
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32",
    });
    child.once("error", (error) => { spawnError = error; });
    child.stdout?.on("data", (chunk) => {
      const length = stdout.length + chunk.length;
      stdout = Buffer.concat([stdout, chunk], Math.min(length, MAX_VERSION_BYTES + 1));
      if (length > MAX_VERSION_BYTES) terminate(new Error(`Provider version output exceeded limit: ${id}`));
    });
    child.stderr?.on("data", (chunk) => {
      const length = stderr.length + chunk.length;
      stderr = Buffer.concat([stderr, chunk], Math.min(length, MAX_VERSION_BYTES + 1));
      if (length > MAX_VERSION_BYTES) terminate(new Error(`Provider version output exceeded limit: ${id}`));
    });
    child.once("close", (code, childSignal) => {
      // A successful CLI may have forked a helper with redirected stdio, so
      // close of the direct child alone is not proof the probe tree is gone.
      // The detached group is still ours until this version check settles.
      if (process.platform !== "win32" && child.pid) terminateTree(true);
      settle(terminationError ?? spawnError ?? (code === 0 ? null : new Error(`Provider version check exited ${code ?? childSignal}: ${id}`)), (stdout.length ? stdout : stderr).toString("utf8"));
    });
    const terminateTree = (force = false) => {
      if (process.platform === "win32") {
        try { child.kill("SIGKILL"); } catch { /* Supervisor already exited. */ }
      } else if (child.pid) {
        // The detached probe owns its process group, including pipe-holding
        // descendants after the direct CLI exits.
        try { process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM"); } catch { /* Group already exited. */ }
      } else {
        try { child.kill(force ? "SIGKILL" : "SIGTERM"); } catch { /* Already exited. */ }
      }
    };
    const terminate = (reason) => {
      if (settled) return;
      terminationError ??= reason;
      terminateTree();
      if (!escalation) escalation = setTimeout(() => terminateTree(true), 100);
    };
    const abort = () => terminate(new Error(`Provider version check aborted: ${id}`));
    const timeout = setTimeout(() => terminate(new Error(`Provider version check timed out: ${id}`)), 2500);
    // A child that never reports close cannot retain discovery shutdown.
    // SIGKILL is attempted before this deadline; unresolved cleanup is an
    // error rather than a successful version check.
    const deadline = setTimeout(() => {
      terminateTree(true);
      settle(new Error(`Provider version check did not close: ${id}`));
    }, 3500);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
