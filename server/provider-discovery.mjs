import { execFile, spawn } from "node:child_process";
import { constants, readFileSync, rmSync } from "node:fs";
import { access } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describeAdapter, EXECUTION_ADAPTERS, versionCompatibility, withoutDirectProviderCredentials } from "./execution-adapters/index.mjs";

const MAX_VERSION_BYTES = 16 * 1024;
const execFileAsync = promisify(execFile);
const pendingAccess = new Map();

function executableAccess(candidate) {
  let task = pendingAccess.get(candidate);
  if (!task) {
    task = access(candidate, constants.X_OK).finally(() => {
      if (pendingAccess.get(candidate) === task) pendingAccess.delete(candidate);
    });
    pendingAccess.set(candidate, task);
  }
  return task;
}

async function providerExecutable(id, signal) {
  if (id.includes("/")) return resolve(id);
  for (const directory of (process.env.PATH || "").split(delimiter)) {
    if (signal?.aborted) throw signal.reason;
    const candidate = resolve(directory || ".", id);
    try { await executableAccess(candidate); return candidate; }
    catch { /* Keep searching the caller's PATH. */ }
  }
  if (signal?.aborted) throw signal.reason;
  return id;
}

export function probeCommand(id, providerPath) {
  if (process.platform === "win32" && !EXECUTION_ADAPTERS.some((adapter) => adapter.executable === id)) throw new Error(`Unknown provider: ${id}`);
  let supervisor = process.env.OUTRIGHT_AGENT_SUPERVISOR_PATH;
  if (!supervisor && process.platform === "win32") {
    const manifest = JSON.parse(readFileSync(new URL("./bin/agent-supervisor.json", import.meta.url), "utf8"));
    if (typeof manifest.filename !== "string" || !/^agent-supervisor-[0-9a-f]{16}\.exe$/.test(manifest.filename)) {
      throw new Error("Windows agent supervisor manifest is invalid");
    }
    supervisor = fileURLToPath(new URL(`./bin/${manifest.filename}`, import.meta.url));
  }
  supervisor ??= fileURLToPath(new URL("./bin/agent-supervisor", import.meta.url));
  // A harness CLI never sees a direct provider's credential, even to print
  // its version.
  const env = withoutDirectProviderCredentials(process.env);
  if (process.platform === "win32") return { executable: supervisor, args: [process.env.ComSpec || "cmd.exe", "/d", "/s", "/c", `${id} --version`], stdio: ["ignore", "pipe", "pipe"], env };
  // The platform supervisor owns descendants even after setsid/reparenting.
  // The Linux handshake and macOS launch gate are private to this one probe.
  const token = randomUUID();
  if (process.platform === "darwin") {
    const ownershipLabel = `com.21n.outright.probe.${token}`;
    return { executable: supervisor, args: [ownershipLabel, providerPath, "--version"], ownershipLabel,
      stdio: ["ignore", "pipe", "pipe", "pipe"], env: { ...env, OUTRIGHT_LAUNCH_GATE_FD: "3" } };
  }
  const handshakePath = join(tmpdir(), `outright-probe-${token}.json`);
  return { executable: supervisor, args: [handshakePath, providerPath, "--version"], cleanupPath: handshakePath, stdio: ["pipe", "pipe", "pipe", "pipe"], env };
}

// A detached child leaves its parent's process group but remains in the
// parent's tree. Inspect that tree while the owner is still alive, then kill
// descendants before the owner so a forced shutdown cannot orphan a helper.
async function probeDescendants(ownerPid) {
  const { stdout } = await execFileAsync("/bin/ps", ["-A", "-o", "pid=,ppid=,stat="],
    { encoding: "utf8", timeout: 1_000, maxBuffer: 4 * 1024 * 1024, env: withoutDirectProviderCredentials(process.env) });
  const children = new Map();
  let ownerState;
  for (const line of stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)/);
    if (!match) continue;
    const pid = Number(match[1]);
    const parent = Number(match[2]);
    if (pid === ownerPid) ownerState = match[3];
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push({ pid, state: match[3] });
  }
  if (!ownerState || ownerState.startsWith("Z")) throw new Error("Probe owner exited before descendant inspection");
  const descendants = [];
  const visit = (parent, depth) => {
    if (depth > 256) throw new Error("Probe tree exceeded inspection depth");
    for (const child of children.get(parent) ?? []) {
      visit(child.pid, depth + 1);
      if (!child.state.startsWith("Z")) descendants.push(child.pid);
    }
  };
  visit(ownerPid, 0);
  return descendants;
}

async function forceProbeCleanup(child, command) {
  if (!child.pid) { child.kill("SIGKILL"); return; }
  if (process.platform === "darwin" && command.ownershipLabel) {
    // The launchd resource coalition survives setsid and reparenting. Its
    // control command proves that every member has left before returning.
    await execFileAsync(command.executable, ["--terminate", command.ownershipLabel],
      { timeout: 5_000, maxBuffer: MAX_VERSION_BYTES, env: command.env });
  } else if (process.platform !== "win32") {
    // Linux's native supervisor is a subreaper, so double-forked helpers are
    // adopted back into this tree. Stop the owner before the final snapshot so
    // it cannot fork a new helper between inspection and termination. This
    // also covers a stuck test supervisor without a launchd job.
    // If the owner already exited, its former descendants may have been
    // reparented and this ancestry snapshot cannot prove their absence.
    process.kill(child.pid, "SIGSTOP");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const descendants = await probeDescendants(child.pid);
      if (descendants.length === 0) break;
      for (const pid of descendants) {
        try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if ((await probeDescendants(child.pid)).length) throw new Error("Probe descendants survived hard shutdown");
  }
  child.kill("SIGKILL");
}

// A provider is ready only when it is both available and compatible. Each
// snapshot entry carries the adapter's versioned capabilities so the UI can
// explain an unavailable or incompatible provider before anything is queued.
export function createProviderDiscovery({ probe = defaultProbe, onChange = () => {}, refreshMs = 30_000, schedule = setInterval, cancel = clearInterval, adapters = EXECUTION_ADAPTERS, environment = process.env } = {}) {
  const providerEntries = adapters.map((adapter) => ({ adapter, description: describeAdapter(adapter), id: adapter.id }));
  const ready = (entry) => entry?.available === true && entry.compatible === true;
  let snapshot = providerEntries.map(({ description }) => ({ ...description, available: false, compatible: false, version: "", reason: "", checking: true }));
  const pending = new Map();
  const controllers = new Map();
  const lastChecked = new Map();
  // An uncertain owner cannot safely be replaced by another probe. Quarantine
  // that provider until restart, retaining at most one error per provider.
  const cleanupErrors = new Map();
  let closed = false;

  function probeProvider(id, force = false) {
    const provider = providerEntries.find((item) => item.id === id);
    if (!provider) return Promise.resolve(false);
    if (pending.has(id)) return pending.get(id);
    if (cleanupErrors.has(id)) return Promise.resolve(false);
    if (!force && lastChecked.has(id) && Date.now() - lastChecked.get(id) < refreshMs) return Promise.resolve(ready(snapshot.find((item) => item.id === id)));
    const controller = new AbortController();
    controllers.set(id, controller);
    const { adapter, description } = provider;
    const task = (async () => {
      let next;
      try {
        let version;
        if (adapter.kind === "harness") {
          version = adapter.parseVersion(await probe(adapter.executable, { signal: controller.signal }));
        } else {
          // A direct provider is detected from its own credential reference,
          // never from a harness login or subprocess.
          const detected = adapter.detect(environment);
          if (!detected.available) throw Object.assign(new Error(detected.reason), { reason: detected.reason });
          version = detected.version;
        }
        next = { ...description, available: true, ...versionCompatibility(adapter, version), checking: false };
      } catch (error) {
        if (error?.code === "OUTRIGHT_PROBE_CLEANUP_UNCERTAIN") cleanupErrors.set(id, error);
        next = { ...description, available: false, compatible: false, version: "",
          reason: error?.reason ?? `${adapter.label} CLI is not available`, checking: false };
      }
      if (!closed) {
        const index = snapshot.findIndex((item) => item.id === id);
        const changed = JSON.stringify(snapshot[index]) !== JSON.stringify(next);
        snapshot = snapshot.map((item) => item.id === id ? next : item);
        lastChecked.set(id, Date.now());
        if (changed) onChange(snapshot);
      }
      return ready(next);
    })().finally(() => { if (pending.get(id) === task) pending.delete(id); if (controllers.get(id) === controller) controllers.delete(id); });
    pending.set(id, task);
    return task;
  }

  async function refresh(force = false) {
    if (closed) return Promise.resolve(snapshot);
    await Promise.all(providerEntries.map((provider) => probeProvider(provider.id, force)));
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
      if (cleanupErrors.size) throw new AggregateError([...cleanupErrors.values()], "Provider probe cleanup could not be verified");
    },
  };
}

export async function defaultProbe(id, { signal, resolveExecutable = providerExecutable, commandForProbe = probeCommand, cleanupMs = 8_000 } = {}) {
  const started = Date.now();
  const lookupDeadline = new AbortController();
  const lookupTimer = setTimeout(() => lookupDeadline.abort(), 2_500);
  const lookupSignal = signal ? AbortSignal.any([signal, lookupDeadline.signal]) : lookupDeadline.signal;
  let executable;
  try {
    executable = process.platform === "win32" ? id : await new Promise((resolveLookup, rejectLookup) => {
      let finished = false;
      const finish = (callback, value) => {
        if (finished) return;
        finished = true;
        lookupSignal.removeEventListener("abort", abortLookup);
        callback(value);
      };
      const abortLookup = () => finish(rejectLookup, new Error(`Provider version check ${signal?.aborted ? "aborted" : "timed out"}: ${id}`));
      lookupSignal.addEventListener("abort", abortLookup, { once: true });
      Promise.resolve().then(() => resolveExecutable(id, lookupSignal))
        .then((value) => finish(resolveLookup, value), (error) => finish(rejectLookup, error));
      if (lookupSignal.aborted) abortLookup();
    });
  } finally { clearTimeout(lookupTimer); }
  if (lookupSignal.aborted) throw new Error(`Provider version check ${signal?.aborted ? "aborted" : "timed out"}: ${id}`);
  return new Promise((resolve, reject) => {
    let settled = false;
    let terminationError;
    let forcedCleanup;
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
    const command = commandForProbe(id, executable);
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
    child.once("close", async (code, childSignal) => {
      if (forcedCleanup) {
        try { await forcedCleanup; }
        catch (error) { terminationError = new Error("Provider probe forced cleanup failed", { cause: error }); terminationError.code = "OUTRIGHT_PROBE_CLEANUP_UNCERTAIN"; }
      }
      let artifactError;
      try { if (command.cleanupPath && terminationError?.code !== "OUTRIGHT_PROBE_CLEANUP_UNCERTAIN") rmSync(command.cleanupPath, { force: true }); }
      catch (error) { artifactError = error; }
      settle(terminationError ?? spawnError ?? artifactError ?? (code === 0 ? null : new Error(`Provider version check exited ${code ?? childSignal}: ${id}`)), (stdout.length ? stdout : stderr).toString("utf8"));
    });
    const terminateTree = (hard = false) => {
      // Let the native owner reap its tree. Killing the owner first can leave
      // an escaped helper alive, especially after its direct CLI exits.
      try { child.kill(hard ? "SIGKILL" : "SIGTERM"); } catch { /* Already exited. */ }
    };
    const terminate = (reason) => {
      if (settled) return;
      terminationError ??= reason;
      terminateTree();
    };
    const abort = () => terminate(new Error(`Provider version check aborted: ${id}`));
    const timeout = setTimeout(() => terminate(new Error(`Provider version check timed out: ${id}`)), Math.max(0, 2_500 - (Date.now() - started)));
    // Keep the promise owned until the supervisor has actually exited. A
    // deadline may escalate its signal, but must never report cleanup while
    // an OS-visible owner can still be running.
    const deadline = setTimeout(() => {
      terminationError ??= new Error(`Provider version check exceeded its cleanup deadline: ${id}`);
      forcedCleanup = forceProbeCleanup(child, command).catch((error) => {
        // Still stop the owner and close its pipes; discovery quarantines this
        // provider because descendant cleanup could not be proven.
        try { child.kill("SIGKILL"); } catch { /* Already exited. */ }
        throw error;
      });
      forcedCleanup.finally(() => {
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.stdio[3]?.destroy();
      }).catch(() => {});
    }, cleanupMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
