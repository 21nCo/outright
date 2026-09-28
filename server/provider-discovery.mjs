import { spawn } from "node:child_process";
import { constants, readFileSync, rmSync } from "node:fs";
import { access } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const PROVIDERS = [
  { id: "codex", label: "Codex", models: ["gpt-5.4", "gpt-5.3-codex"] },
  { id: "claude", label: "Claude Code", models: ["sonnet", "opus", "haiku"] },
];
const MAX_VERSION_BYTES = 16 * 1024;

async function providerExecutable(id) {
  if (id.includes("/")) return resolve(id);
  for (const directory of (process.env.PATH || "").split(delimiter)) {
    const candidate = resolve(directory || ".", id);
    try { await access(candidate, constants.X_OK); return candidate; }
    catch { /* Keep searching the caller's PATH. */ }
  }
  return id;
}

function probeCommand(id, providerPath) {
  if (process.platform === "win32" && !PROVIDERS.some((provider) => provider.id === id)) throw new Error(`Unknown provider: ${id}`);
  let supervisor = process.env.OUTRIGHT_AGENT_SUPERVISOR_PATH;
  if (!supervisor && process.platform === "win32") {
    const manifest = JSON.parse(readFileSync(new URL("./bin/agent-supervisor.json", import.meta.url), "utf8"));
    if (typeof manifest.filename !== "string" || !/^agent-supervisor-[0-9a-f]{16}\.exe$/.test(manifest.filename)) {
      throw new Error("Windows agent supervisor manifest is invalid");
    }
    supervisor = fileURLToPath(new URL(`./bin/${manifest.filename}`, import.meta.url));
  }
  supervisor ??= fileURLToPath(new URL("./bin/agent-supervisor", import.meta.url));
  if (process.platform === "win32") return { executable: supervisor, args: [process.env.ComSpec || "cmd.exe", "/d", "/s", "/c", `${id} --version`], stdio: ["ignore", "pipe", "pipe"] };
  // The platform supervisor owns descendants even after setsid/reparenting.
  // The Linux handshake and macOS launch gate are private to this one probe.
  const token = randomUUID();
  if (process.platform === "darwin") return { executable: supervisor, args: [`com.21n.outright.probe.${token}`, providerPath, "--version"], stdio: ["ignore", "pipe", "pipe", "pipe"], env: { ...process.env, OUTRIGHT_LAUNCH_GATE_FD: "3" } };
  return { executable: supervisor, args: [join(tmpdir(), `outright-probe-${token}.json`), providerPath, "--version"], stdio: ["pipe", "pipe", "pipe", "pipe"] };
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
  const executable = process.platform === "win32" ? id : await providerExecutable(id);
  if (signal?.aborted) throw new Error(`Provider version check aborted: ${id}`);
  return new Promise((resolve, reject) => {
    let settled = false;
    let terminationError;
    const cleanup = () => {
      clearTimeout(timeout);
      clearTimeout(deadline);
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
    // Every platform supervisor owns descendants beyond the direct CLI's
    // process group. A version is valid only after that owner exits cleanly.
    const command = probeCommand(id, executable);
    const child = spawn(command.executable, command.args, {
      stdio: command.stdio, env: command.env, windowsHide: true, detached: process.platform !== "win32",
    });
    if (process.platform === "darwin") child.stdio[3]?.end("go\n");
    if (process.platform === "linux") child.stdin?.end("go\n");
    child.stdio[3]?.resume();
    child.stdin?.on("error", () => {});
    child.stdio[3]?.on("error", () => {});
    // A failed spawn can emit again if shutdown races its close callback.
    // Keep ownership of the error channel until this child is fully closed.
    child.on("error", (error) => { spawnError ??= error; });
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
      if (process.platform === "linux") rmSync(command.args[0], { force: true });
      settle(terminationError ?? spawnError ?? (code === 0 ? null : new Error(`Provider version check exited ${code ?? childSignal}: ${id}`)), (stdout.length ? stdout : stderr).toString("utf8"));
    });
    const terminateTree = () => {
      // Let the native owner reap its tree. Killing the owner first can leave
      // an escaped helper alive, especially after its direct CLI exits.
      try { child.kill("SIGTERM"); } catch { /* Already exited. */ }
    };
    const terminate = (reason) => {
      if (settled) return;
      terminationError ??= reason;
      terminateTree();
    };
    const abort = () => terminate(new Error(`Provider version check aborted: ${id}`));
    const timeout = setTimeout(() => terminate(new Error(`Provider version check timed out: ${id}`)), 2500);
    // A child that never reports close cannot retain discovery shutdown.
    // The owner gets a bounded cleanup interval; unresolved cleanup is an
    // error rather than a successful version check.
    const deadline = setTimeout(() => {
      terminateTree();
      settle(new Error(`Provider version check did not close: ${id}`));
    }, 8_000);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
