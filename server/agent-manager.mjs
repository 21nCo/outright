import { execFile, spawnExecution, spawnSync } from "./child-process.mjs";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExecutionEnvironment, buildExecutionLaunch, DIRECT_PROVIDER_VARIABLES, isProviderSessionId, requireExecutionAdapter, withoutDirectProviderCredentials } from "./execution-adapters/index.mjs";
import { createProviderDiscovery } from "./provider-discovery.mjs";
import { RESOURCE_BUDGETS, retainedTranscriptMessageBytes } from "./resource-budgets.mjs";

const MAX_PROVIDER_LINE_BYTES = 1024 * 1024;
const MAX_ASSISTANT_BYTES = 1024 * 1024;
const MAX_PROCESS_EVENT_BYTES = 64 * 1024;
const MAX_ASSISTANT_EVENT_BYTES = 255 * 1024;
const MAX_RUN_TRANSCRIPT_ITEMS = RESOURCE_BUDGETS.maxRunTranscriptItems;
const MAX_RUN_TRANSCRIPT_BYTES = RESOURCE_BUDGETS.maxRunTranscriptBytes;
const MAX_TOOL_TRANSCRIPT_PAYLOAD_BYTES = 16 * 1024;
const MAX_PROVIDER_FAILURE_BYTES = 4 * 1024;
const ASSISTANT_TRUNCATION_MARKER = "\n\n[Output truncated by Outright at 1 MiB]";
// Assistant checkpoints are coalesced: a new durable checkpoint is written
// only after this many new stream bytes (or this much time) accumulate, so a
// long delta stream rewrites the growing transcript O(bytes/threshold) times
// instead of once per token, while crash exposure stays bounded.
const CHECKPOINT_MIN_BYTES = 4 * 1024;
const CHECKPOINT_INTERVAL_MS = 500;
function defaultAgentSupervisorPath() {
  if (process.platform !== "win32") return fileURLToPath(new URL("./bin/agent-supervisor", import.meta.url));
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("./bin/agent-supervisor.json", import.meta.url)), "utf8"));
  if (typeof manifest.filename !== "string" || !/^agent-supervisor-[0-9a-f]{16}\.exe$/.test(manifest.filename)) {
    throw new Error("Windows agent supervisor manifest is invalid");
  }
  return fileURLToPath(new URL(`./bin/${manifest.filename}`, import.meta.url));
}

export const AGENT_SUPERVISOR = process.env.OUTRIGHT_AGENT_SUPERVISOR_PATH || defaultAgentSupervisorPath();
export const LAUNCH_AUTHORIZED_CONTROL = "__OUTRIGHT_LAUNCH_AUTHORIZED_V1__";
const LAUNCH_CONTROL_FD = 3;

// Crash-safe launch handshake. The provider is never spawned directly: this
// tiny wrapper records its own process identity durably, then waits for the
// runtime's authorization before starting the provider. Because authorization
// is only ever issued after the run row durably reaches 'running' with a pid,
// a hard crash can restart in one of exactly three provable states:
//   * no handshake record -> the provider was never started (never-started);
//   * handshake record, row still 'launching' -> never authorized, so the
//     wrapper exits on its own (its stdin closed with the runtime) without
//     ever starting the provider — never-started, with the pid preserved;
//   * row 'running' with a pid -> possibly started, probed conservatively.
// After authorization the wrapper also accepts a "stop" command, which makes
// it tear the provider tree down in reaping order (see teardown below).
export const LAUNCH_WRAPPER_SOURCE = `
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const [handshakePath, ownershipToken, rawPlatformOwnershipId, executable, ...commandArgs] = process.argv.slice(1);
const platformOwnershipId = rawPlatformOwnershipId === "-" ? null : rawPlatformOwnershipId;
fs.mkdirSync(path.dirname(handshakePath), { recursive: true });
// The wrapper holds its run's scoped environment, which for a direct provider
// includes its credential. Identity helpers are system tools started by
// absolute path, never looked up from the worktree, and never get it.
const directProviderVariables = new Set(${JSON.stringify(DIRECT_PROVIDER_VARIABLES)});
const utilityEnvironment = Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => !directProviderVariables.has(key.toUpperCase())));
const powershell = path.win32.join(process.env.SystemRoot || "C:\\\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const ownershipTitle = \`outright-agent-\${ownershipToken}\`;
process.title = ownershipTitle;
const processIdentityFor = (pid, expectedOwnershipToken = null) => {
  try {
    if (process.platform === "linux") {
      const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      const stat = fs.readFileSync(\`/proc/\${pid}/stat\`, "utf8");
      const close = stat.lastIndexOf(")");
      const startTicks = close >= 0 ? stat.slice(close + 2).split(" ")[19] : "";
      return bootId && startTicks ? \`linux:\${bootId}:\${startTicks}\` : null;
    }
    if (process.platform === "darwin") {
      const boot = execFileSync("/usr/sbin/sysctl", ["-n", "kern.boottime"], { encoding: "utf8", env: utilityEnvironment }).trim();
      if (!expectedOwnershipToken) {
        const started = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: utilityEnvironment }).trim();
        return boot && started ? \`darwin-process:\${boot}:\${started}\` : null;
      }
      const command = execFileSync("/bin/ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", env: utilityEnvironment }).trim();
      return boot && command === \`outright-agent-\${expectedOwnershipToken}\`
        ? \`darwin:\${boot}:\${expectedOwnershipToken}\`
        : null;
    }
    if (process.platform === "win32") {
      const script = "$boot=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().Ticks;"
        + "$start=(Get-Process -Id " + String(pid) + ").StartTime.ToUniversalTime().Ticks;"
        + "Write-Output ($boot.ToString() + ':' + $start.ToString())";
      const started = execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, env: utilityEnvironment }).trim();
      return started ? \`win32:\${started}\` : null;
    }
  } catch {}
  return null;
};
const processIdentity = processIdentityFor(process.pid, ownershipToken);
const handshake = (authorized, providerPid) => {
  const providerProcessIdentity = providerPid ? processIdentityFor(providerPid) : null;
  return {
    pid: process.pid,
    authorized,
    ownershipToken,
    ...(platformOwnershipId ? { platformOwnershipId } : {}),
    ...(providerPid ? { providerPid } : {}),
    ...(processIdentity ? { processIdentity } : {}),
    ...(providerProcessIdentity ? { providerProcessIdentity } : {}),
    createdAt: new Date().toISOString(),
  };
};
const writeHandshake = (record) => {
  const temporaryPath = \`\${handshakePath}.\${process.pid}.tmp\`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(temporaryPath, handshakePath);
  } catch (error) {
    try { fs.unlinkSync(temporaryPath); } catch {}
    throw error;
  }
};
// Durable process identity BEFORE anything can execute: if the runtime dies
// before recording this pid, the handshake file restores ownership after
// restart.
writeHandshake(handshake(false));
let authorized = false;
let provider = null;
let providerGone = false;
let providerResult = null;
let teardownStarted = false;
let completionTimer = null;
// Stay alive across group termination signals once authorized so this
// wrapper — the provider's parent — can reap it. On hosts whose PID 1 does
// not reap orphans, a killed-but-unreaped provider would remain a zombie in
// its process group and keep every liveness probe reporting alive. An
// unauthorized wrapper must still die on the first signal: it never started
// the provider, so nothing needs reaping.
const abandon = () => { try { fs.unlinkSync(handshakePath); } catch {} process.exit(0); };
process.on("SIGTERM", () => { if (!authorized) abandon(); });
process.on("SIGINT", () => { if (!authorized) abandon(); });
const finish = (code, signal) => {
  if (completionTimer) clearTimeout(completionTimer);
  if (process.platform === "win32" && !signal && code === 0) {
    // The Job Object is empty when its supervisor exits. Preserve that proof
    // until the runtime commits the terminal row, so a crash between those
    // events cannot strand a running row after every owned process is gone.
    try {
      const record = JSON.parse(fs.readFileSync(handshakePath, "utf8"));
      writeHandshake({ ...record, completed: true, completedAt: new Date().toISOString() });
    } catch {}
  } else {
    try { fs.unlinkSync(handshakePath); } catch {}
  }
  if (signal) {
    // Re-raise the provider's termination signal so the runtime reports the
    // accurate "stopped by signal" cause instead of a generic 137 — except
    // SIGUSR1, which Node reserves for its debugger.
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
    if (signal === "SIGUSR1") process.exit(137);
    try { process.kill(process.pid, signal); }
    catch { process.exit(137); }
  } else process.exit(code ?? 0);
};
const finishWhenOwnedGroupIsEmpty = () => {
  // The child is the platform supervisor. It closes only after its OS-owned
  // boundary (a launchd job or Windows Job Object) is empty.
  finish(providerResult?.code, providerResult?.signal);
};
// Runtime stop asks the platform supervisor to terminate its owned tree.
// The supervisor remains alive until the kernel boundary is empty, so this
// wrapper never guesses from sampled PIDs or process groups.
const teardown = () => {
  if (teardownStarted || !provider) return;
  teardownStarted = true;
  if (providerGone) finishWhenOwnedGroupIsEmpty();
  else {
    // Windows uses the supervisor's stdin as the Job Object control channel.
    // Killing that supervisor first would let the wrapper report completion
    // without observing its owned descendants leave the job.
    if (process.platform === "win32" && executable === ${JSON.stringify(AGENT_SUPERVISOR)}) {
      try { provider.stdin.end("stop\\n"); } catch { /* The owner already exited. */ }
    } else try { provider.kill("SIGTERM"); } catch { /* Already gone. */ }
    // The production supervisor owns its descendants and its own escalation:
    // never kill it before it has reaped them. For a direct child (including
    // the wrapper's coalesced go/stop fixture), retain this parent as the
    // reaper and bound a child that ignores SIGTERM.
    if (executable !== ${JSON.stringify(AGENT_SUPERVISOR)}) {
      completionTimer = setTimeout(() => {
        if (!providerGone) try { provider.kill("SIGKILL"); } catch { /* Already gone. */ }
      }, 750);
    }
  }
};
process.stdin.setEncoding("utf8");
let commandBuffer = "";
process.stdin.on("data", (chunk) => {
  commandBuffer += String(chunk);
  const commands = commandBuffer.split("\\n");
  commandBuffer = commands.pop() ?? "";
  for (const rawCommand of commands) {
    const command = rawCommand.trim();
    if (!authorized && command === "go") {
      // A direct child has no kernel-owned descendant boundary. Only the
      // supervisor may make a production ownership/cleanup claim; the opt-in
      // direct path exists solely for trusted, leaf-only wrapper fixtures.
      if (executable !== ${JSON.stringify(AGENT_SUPERVISOR)} && process.env.OUTRIGHT_TEST_DIRECT_WRAPPER !== "1") {
        console.error("Direct provider launch requires platform supervision");
        try { fs.unlinkSync(handshakePath); } catch {}
        process.exit(127);
      }
      authorized = true;
      const { spawn } = require("node:child_process");
      const darwinLaunch = process.platform === "darwin";
      if (!darwinLaunch) {
        // On platforms whose child is the provider itself, authorization must
        // be durable before spawn because execution begins immediately.
        try { writeHandshake(handshake(true)); }
        catch (error) {
          console.error(String((error && error.message) || error));
          try { fs.unlinkSync(handshakePath); } catch {}
          process.exit(127);
        }
      }
      // The macOS supervisor receives a private launch gate. It cannot submit
      // the launchd job until its pid and boot-scoped identity are durable, so
      // restart recovery never mistakes the pre-submit race for an exited run.
      provider = spawn(executable, commandArgs, darwinLaunch
        ? { stdio: ["ignore", "inherit", "inherit", "pipe"], env: { ...process.env, OUTRIGHT_LAUNCH_GATE_FD: "3" } }
        : { stdio: [process.platform === "win32" && executable === ${JSON.stringify(AGENT_SUPERVISOR)}
          ? "pipe" : "ignore", "inherit", "inherit"] });
      provider.stdin?.on?.("error", () => {});
      // Durable provider identity: escalation targets the provider alone so this
      // wrapper — the provider's parent — survives to reap it. Without this, a
      // group-wide SIGKILL kills the wrapper first and a killed-but-unreaped
      // provider lingers as a zombie in its process group on hosts whose PID 1
      // does not reap orphans.
      try { writeHandshake(handshake(true, provider.pid)); }
      catch (error) {
        if (darwinLaunch) {
          try { provider.stdio[3].destroy(); } catch {}
          try { provider.kill("SIGKILL"); } catch {}
          console.error(String((error && error.message) || error));
          try { fs.unlinkSync(handshakePath); } catch {}
          process.exit(127);
        }
        // Other platforms retain the durable wrapper identity even if the
        // optional provider-only escalation identity could not be persisted.
      }
      provider.on("error", (error) => { console.error(String((error && error.message) || error)); finish(127); });
      provider.on("close", (code, signal) => {
        providerGone = true;
        providerResult = { code, signal };
        finishWhenOwnedGroupIsEmpty();
      });
      const acknowledgeLaunch = () => {
        // Keep launch ownership control off provider stdout. Providers may
        // emit arbitrary bytes, so only the manager-owned fd 3 can acknowledge.
        try { fs.writeSync(${LAUNCH_CONTROL_FD}, ${JSON.stringify(LAUNCH_AUTHORIZED_CONTROL)} + "\\n"); }
        catch { teardown(); }
      };
      if (darwinLaunch) {
        const gate = provider.stdio[3];
        let gateFailed = false;
        gate.once("error", (error) => {
          gateFailed = true;
          console.error(String((error && error.message) || error));
          teardown();
        });
        gate.end("go\\n", () => { if (!gateFailed) acknowledgeLaunch(); });
      } else acknowledgeLaunch();
      continue;
    }
    if (command === "stop") {
      if (!authorized) abandon();
      teardown();
    }
  }
});
// The runtime went away before authorizing the launch: exit without ever
// starting the provider, so an abandoned handshake can never mutate the
// worktree.
process.stdin.on("end", () => {
  if (!authorized) { try { fs.unlinkSync(handshakePath); } catch {} process.exit(0); }
  teardown();
});
`;

function supervisorCommand(args, timeout) {
  return new Promise((resolve) => {
    execFile(AGENT_SUPERVISOR, args, { encoding: "utf8", timeout, killSignal: "SIGKILL", maxBuffer: 4096, env: withoutDirectProviderCredentials(process.env) },
      (error, stdout, stderr) => {
        if (process.env.CI && stderr) console.error(stderr.trimEnd());
        resolve({ error, stdout });
      });
  });
}

export async function defaultLaunchCommand(command, run, launchDirectory) {
  const handshakePath = path.join(launchDirectory, `${run.id}.json`);
  if (process.platform === "linux") {
    if (!existsSync(AGENT_SUPERVISOR)) {
      throw new Error("Linux agent supervision is unavailable; install a C compiler and run npm run build:supervisor");
    }
    return {
      executable: AGENT_SUPERVISOR,
      args: [handshakePath, command.executable, ...command.args],
      display: command.display,
      handshakePath,
      ownsDescendants: true,
    };
  }
  if (!["darwin", "win32"].includes(process.platform) || !existsSync(AGENT_SUPERVISOR)) {
    throw new Error(`${process.platform} agent supervision is unavailable; install a C compiler and run npm run build:supervisor`);
  }
  const ownershipToken = randomUUID();
  const platformOwnershipId = process.platform === "darwin" ? `com.21n.outright.${ownershipToken}` : "-";
  if (process.platform === "darwin") {
    const capability = await supervisorCommand(["--self-test", platformOwnershipId], 5000);
    if (capability.error || capability.stdout?.trim() !== "supported") {
      await supervisorCommand(["--terminate", platformOwnershipId], 1000);
      throw new Error("macOS agent supervision is unavailable because its kernel ownership contract could not be verified");
    }
  }
  const supervisorArgs = process.platform === "darwin"
    ? [platformOwnershipId, command.executable, ...command.args]
    : [command.executable, ...command.args];
  return {
    executable: process.execPath,
    args: ["-e", LAUNCH_WRAPPER_SOURCE, handshakePath, ownershipToken, platformOwnershipId, AGENT_SUPERVISOR, ...supervisorArgs],
    display: command.display,
    handshakePath,
    ownsDescendants: true,
  };
}

function storageAdmissionFailure(error) {
  return error?.statusCode === 507
    || /^(?:SQLITE_(?:FULL|IOERR|READONLY|BUSY|LOCKED)(?:_|$)|E(?:IO|PERM|ACCES|BUSY|NFILE|MFILE|STALE|NOSPC|ROFS)$)/.test(error?.code ?? "");
}

function persistentStorageFailure(error) {
  return error?.statusCode === 507
    || /^(?:SQLITE_(?:FULL|READONLY)(?:_|$)|E(?:PERM|ACCES|NOSPC|ROFS)$)/.test(error?.code ?? "");
}

function deferredAdmissionForStorage(error) {
  if (!storageAdmissionFailure(error)) return null;
  return persistentStorageFailure(error) ? "persistent-deferred" : "retry-deferred";
}

function nativeOwnershipPending(state) {
  if (!state.launchHandshakePath || !existsSync(state.launchHandshakePath)) return false;
  // Only the Windows wrapper writes this marker after its supervisor exits
  // with an empty Job Object. It remains until the terminal database commit.
  if (process.platform !== "win32") return true;
  try {
    const record = JSON.parse(readFileSync(state.launchHandshakePath, "utf8"));
    return record.completed !== true || record.pid !== state.child?.pid;
  } catch { return true; }
}

function freezeTerminalOutcome(state, exitCode, error) {
  if (state.terminalOutcome) return;
  // A provider that reported a terminal failure did not succeed, whatever
  // its exit code.
  const successful = exitCode === 0 && !error && !state.stopped && !state.providerFailed;
  let status = "failed";
  if (state.stopped) status = "stopped";
  else if (successful) status = "completed";
  state.terminalOutcome = {
    status,
    message: error?.message || (!successful ? state.providerFailure || state.stderr.trim() || `Agent exited with code ${exitCode}` : ""),
    finishedAt: new Date().toISOString(),
    exitCode,
  };
}

function unresolvedOutcomeUnavailable() {
  const unavailable = new Error("Run outcome storage is unavailable; retry shortly");
  unavailable.statusCode = 503;
  return unavailable;
}

export function createAgentManager({ database, publish, onProvidersChanged = () => {}, onShutdownRecovery = () => {}, onDiskRetry = () => {}, providerDiscoveryFactory = createProviderDiscovery, spawnProcess = spawnExecution, validateConversation = async () => {}, terminationGraceMs = 3500, terminationTimeoutMs = 8000, escalationGraceMs = 750, checkpointMinBytes = CHECKPOINT_MIN_BYTES, checkpointIntervalMs = CHECKPOINT_INTERVAL_MS, launchCommand = defaultLaunchCommand, launchDirectory, environment = process.env }) {
  const resolvedLaunchDirectory = launchDirectory
    ?? database.launchDirectory;
  assertPrivateLaunchDirectory(resolvedLaunchDirectory);
  const active = new Map();
  // Exited providers no longer consume a process slot, but their uncommitted
  // outcome and launch proof must remain owned until SQLite accepts it.
  const pendingOutcomes = new Map();
  const queue = [];
  const launches = new Set();
  const maintenanceWaiters = new Set();
  let shuttingDown = false;
  let shutdownPromise;
  let diskRetryTimer;
  let diskRetryDueAt = 0;
  let diskRetryDelayMs = 100;
  let hardRetryProbed = false;
  const admissionRetryRuns = new Set();
  let queueReadRetryPending = false;
  const providerDiscovery = providerDiscoveryFactory({ onChange: onProvidersChanged, environment });

  function wakeMaintenanceWaiters() {
    for (const resolve of maintenanceWaiters) resolve();
    maintenanceWaiters.clear();
  }

  function waitForMaintenance() {
    if (!database.maintenanceActive || shuttingDown) return Promise.resolve();
    return new Promise((resolve) => maintenanceWaiters.add(resolve));
  }

  function providers() {
    return providerDiscovery.list();
  }

  async function schedule({ conversation, run, forceFreshSession = false, providerSessionId }) {
    if (shuttingDown) throw new Error("Agent manager is shutting down");
    const entry = { conversation, run, forceFreshSession, providerSessionId };
    queue.push(entry);
    emit(run.id, "run.queued", { position: queue.length });
    drain();
    if (entry.launch) await entry.launch;
    return database.getRun(run.id);
  }

  function preflightAgentAdmission(state, authorize) {
    const { conversation, run } = state;
    // The asynchronous capability check is a retry boundary: trust and the
    // selected durable target may have changed while it was in flight.
    const current = database.getConversation(run.conversationId);
    if (!current || ["projectId", "worktreeId", "worktreePath"].some((key) => current[key] !== conversation[key])) {
      throw new Error("Conversation target changed while preparing the run; submit again");
    }
    authorize?.();
    // Validation and capability setup can yield while a sibling spends the
    // remaining retained budget. Defer before the durable launch transition.
    try {
      if (database.canLaunchRun?.() === false) return "deferred";
    } catch (error) {
      const deferred = deferredAdmissionForStorage(error);
      if (deferred) return deferred;
      throw error;
    }
    try {
      database.auditAdmission("agent.run.start.requested", { target: run.id, provider: run.provider, conversationId: conversation.id, worktreePath: conversation.worktreePath });
    } catch (error) {
      // No process has been spawned yet. A transient SQLite lock or I/O
      // failure must leave the run queued for a fresh admission attempt;
      // terminalizing it can itself fail under the same storage fault.
      const deferred = deferredAdmissionForStorage(error);
      if (deferred) return deferred;
      if (error.statusCode === 503 && database.maintenanceActive) return "deferred";
      throw error;
    }
    admissionRetryRuns.delete(run.id);
    clearDiskRetry();
    return null;
  }

  async function start(state, authorize) {
    const { conversation, run } = state;
    const command = buildProviderCommand(conversation, run);
    const launch = await launchCommand(command, run, resolvedLaunchDirectory);
    if (state.stopped || shuttingDown) return;
    const admission = preflightAgentAdmission(state, authorize);
    if (admission) return admission;
    const startedAt = new Date().toISOString();
    // Crash-safe launch handshake, phase 1: this durable marker means "a spawn
    // may have been issued, but the provider was never authorized to run". A
    // crash from here on restarts as a run that provably never started side
    // effects (the wrapper records its identity durably but waits for
    // authorization), so recovery always has an explicit safe continuation
    // instead of being permanently gated on a missing pid.
    database.updateRun(run.id, { status: "launching", startedAt });
    database.auditCritical("agent.run.started", { target: run.id, provider: run.provider, conversationId: conversation.id, worktreePath: conversation.worktreePath, approvalPolicy: run.approvalPolicy });
    emit(run.id, "run.started", { provider: run.provider, model: run.model, startedAt, command: launch.display ?? command.display });

    const child = spawnProcess(launch.executable, launch.args, {
      cwd: conversation.worktreePath,
      // Each adapter gets a scoped environment: direct-provider credentials
      // reach only the adapter that declares them.
      env: buildExecutionEnvironment(run.provider, environment, sanitizedEnvironment(environment)),
      // fd 3 is a manager-only launch-control channel. The provider inherits
      // stdout/stderr from its owner but never inherits this descriptor.
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      // Own process group on POSIX so descendants can be terminated together.
      detached: process.platform !== "win32",
    });
    state.child = child;
    // A broken authorization pipe reports EPIPE asynchronously. Consume that
    // stream error so a wrapper that exits during the persistence window fails
    // through the ordinary child close/error path instead of crashing Node.
    child.stdin?.on?.("error", (error) => { state.processError ??= error; });
    state.launchHandshakePath = launch.handshakePath;
    state.ownsDescendants = Boolean(launch.ownsDescendants);
    let resolveChildClosed;
    const childClosed = new Promise((resolve) => { resolveChildClosed = resolve; });
    let resolveLaunchAuthorized;
    const launchAuthorized = new Promise((resolve) => { resolveLaunchAuthorized = resolve; });
    // A SQLite fault in a provider's metadata or checkpoint callback must
    // become this run's owned failure. An exception escaping EventEmitter's
    // data listener would instead terminate supervision of every run.
    const failProviderOutput = (error) => {
      if (state.processError) return;
      state.processError = error;
      state.checkpointHalted = true;
      terminateTree(child, "SIGTERM");
    };
    consumeBoundedLines(child.stdout, {
      maxLineBytes: MAX_PROVIDER_LINE_BYTES,
      onLine: (line) => {
        if (state.processError) return;
        try { handleProviderLine(state, line); }
        catch (error) { failProviderOutput(error); }
      },
      onOverflow: () => {
        try { emit(run.id, "process.output_truncated", { stream: "stdout", maxBytes: MAX_PROVIDER_LINE_BYTES }); }
        catch (error) { failProviderOutput(error); }
      },
    });
    const control = child.stdio?.[LAUNCH_CONTROL_FD];
    if (!control) {
      state.processError = new Error("Launch owner control channel is unavailable");
    } else {
      consumeBoundedLines(control, {
        maxLineBytes: 256,
        onLine: (line) => {
          if (line !== LAUNCH_AUTHORIZED_CONTROL) return;
          state.launchAuthorized = true;
          resolveLaunchAuthorized();
        },
        onOverflow: () => { state.processError ??= new Error("Launch owner control message was malformed"); },
      });
      control.on?.("error", (error) => { state.processError ??= error; });
    }
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      state.stderr = `${state.stderr}${text}`.slice(-16_000);
      try { emit(run.id, "process.stderr", { text: truncateUtf8(text, MAX_PROCESS_EVENT_BYTES), truncated: Buffer.byteLength(text) > MAX_PROCESS_EVENT_BYTES }); }
      catch (error) { failProviderOutput(error); }
    });
    child.on("error", (error) => {
      state.processError = error;
      if (!child.pid) {
        state.closed = true;
        resolveChildClosed();
        if (!state.launchPersistenceError) finish(state, null, error);
      }
    });
    child.on("close", (code, signal) => {
      state.closed = true;
      state.exitCode = code;
      state.processError ??= signal ? new Error(`Process stopped by ${signal}`) : null;
      resolveChildClosed();
      if (!state.launchPersistenceError && !state.stopped) finish(state, code, state.processError);
    });
    // Phase 2: durable process ownership BEFORE the provider is authorized.
    // If the runtime dies before this commit, the wrapper's handshake file
    // still carries the pid and the row is provably unauthorized.
    try {
      database.updateRun(run.id, { pid: child.pid ?? null, status: "running" });
    } catch (error) {
      // The provider is still unauthorized. Tear down and verify the wrapper
      // before terminalizing the run, otherwise a failed SQLite write could
      // release the slot while an untracked OS process remains alive.
      state.launchPersistenceError = error;
      try { child.stdin?.end?.(); } catch { /* The wrapper already exited. */ }
      terminateTree(child, "SIGKILL");
      const closed = await Promise.race([
        childClosed.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), terminationTimeoutMs)),
      ]);
      if (!closed) error.preserveActiveRun = true;
      throw error;
    }
    // shutdown/stop can race with the synchronous running-state commit after
    // the earlier pre-spawn check. Never authorize new side effects once the
    // run has been cancelled; the unauthorized supervisor will exit when its
    // stdin closes (and stop() has already signalled it as a fallback).
    if (state.stopped || shuttingDown) {
      try { child.stdin?.end?.(); } catch { /* The wrapper already exited. */ }
      return;
    }
    // Phase 3: authorize. Only now may the provider start side effects.
    authorizeLaunch(child);
    // A successful pipe write proves only that the command reached the OS,
    // not that the platform owner consumed it or durably recorded the provider
    // identity. Keep schedule() pending until the owner acknowledges that
    // boundary, or until the child closes and finish() records the outcome.
    await Promise.race([launchAuthorized, childClosed]);
  }

  function authorizeLaunch(child) {
    try { child?.stdin?.write?.("go\n"); } catch { /* The wrapper already exited; its close event finishes the run. */ }
  }

  function persistSessionMetadata(state) {
    const sessionId = state.pendingSessionId;
    if (!sessionId) return true;
    try {
      database.updateRun(state.run.id, { providerSessionId: sessionId });
      // A recovered run retains its immutable provider even when its chat
      // changes providers; never replace another provider's resume token.
      const current = database.getConversation(state.conversation.id);
      if (current?.provider === state.run.provider) {
        database.updateConversation(state.conversation.id, { providerSessionId: sessionId });
      }
      if (state.pendingSessionId === sessionId) state.pendingSessionId = null;
      return true;
    } catch (error) {
      if (!storageAdmissionFailure(error) && !(error.statusCode === 503 && database.maintenanceActive)) throw error;
      state.sessionStorageError = error;
      // A retained-budget refusal is a policy outcome, not a storage fault.
      // The run row keeps its token and finishRun makes one budgeted copy;
      // never re-arm a disk probe for the rest of the run.
      if (error.statusCode === 507) {
        if (state.pendingSessionId === sessionId) state.pendingSessionId = null;
        return false;
      }
      if (!database.maintenanceActive) retryUnknownDiskUsage(persistentStorageFailure(error));
      return false;
    }
  }

  function handleProviderLine(state, line) {
    if (!line.trim()) return;
    let raw;
    try { raw = JSON.parse(line); }
    catch { raw = null; }
    // Adapters normalize JSON records only; any other line is plain output.
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      emit(state.run.id, "process.stdout", { text: truncateUtf8(line, MAX_PROCESS_EVENT_BYTES), truncated: Buffer.byteLength(line) > MAX_PROCESS_EVENT_BYTES });
      return;
    }
    state.adapter ??= requireExecutionAdapter(state.run.provider);
    for (const event of state.adapter.normalize(raw)) {
      let checkpointDelta = null;
      if (event.type === "session") {
        // An id that could never be resumed is not stored.
        if (!isProviderSessionId(event.payload.sessionId)) continue;
        state.run.providerSessionId = event.payload.sessionId;
        state.pendingSessionId = event.payload.sessionId;
        persistSessionMetadata(state);
      }
      if (event.type === "assistant.delta") {
        appendAssistantText(state, event.payload.text, emit);
        checkpointDelta = event.payload.text;
      }
      if (event.type === "assistant.message") {
        const text = event.payload.text ?? "";
        if (state.assistantBytes && !text.startsWith(assistantBody(state))) {
          // A completed message that does not extend the accumulated deltas
          // starts a new segment; archive the prior one first.
          archiveAssistant(state, (current) => persistAssistantCheckpoint(current, { publishEvent: true }));
        }
        replaceAssistantText(state, text, emit);
        archiveAssistant(state, (current) => persistAssistantCheckpoint(current, { publishEvent: true }));
      }
      if (["tool.started", "tool.completed"].includes(event.type)) {
        archiveAssistant(state, (current) => persistAssistantCheckpoint(current, { publishEvent: true }));
        persistTranscriptItem(state, { kind: "tool", body: toolTranscriptLabel(event), payload: { item: event.payload.item ?? null } });
      }
      if (event.type === "usage") {
        // Provider usage is optional telemetry. A quota refusal must not
        // escape the stdout listener and terminate supervision of every run.
        // Native details stay in the emitted event, not in run columns.
        const usage = Object.fromEntries(["inputTokens", "outputTokens", "costUsd"]
          .filter((key) => Number.isFinite(event.payload[key])).map((key) => [key, event.payload[key]]));
        try { if (Object.keys(usage).length) database.updateRun(state.run.id, usage); }
        catch (error) { if (error.statusCode !== 507) throw error; }
      }
      // A provider-reported failure explains a nonzero exit better than
      // stderr noise. Only a terminal one fails a run that exits 0.
      if (event.type === "provider.failure" && (event.payload.terminal === true || !state.providerFailed)) {
        state.providerFailure = truncateUtf8(event.payload.message ?? "", MAX_PROVIDER_FAILURE_BYTES);
        if (event.payload.terminal === true) state.providerFailed = true;
      }
      const emittedPayload = ["assistant.delta", "assistant.message"].includes(event.type)
        ? { ...event.payload, text: truncateUtf8(event.payload.text ?? "", MAX_ASSISTANT_EVENT_BYTES), truncated: Buffer.byteLength(event.payload.text ?? "") > MAX_ASSISTANT_EVENT_BYTES }
        : event.payload;
      if (checkpointDelta !== null && scheduleAssistantCheckpoint(state, checkpointDelta)) {
        emitAssistantDeltaWithCheckpoint(state, emittedPayload);
        continue;
      }
      const emitted = emit(state.run.id, event.type, emittedPayload);
      if (event.type === "assistant.delta" && emitted) state.lastAssistantDeltaSeq = emitted.seq;
    }
  }

  function persistTerminalOutcome(state, result) {
    const { status, message, finishedAt, exitCode: terminalExitCode } = state.terminalOutcome;
    // Journal the frozen provider exit before SQLite so a BUSY/FULL failure
    // during shutdown can still recover its true outcome after restart.
    const pendingMessage = pendingAssistantMessage(state);
    result.transcriptMessage = budgetTranscript(state, pendingMessage, { terminal: true });
    if (!state.outcomeJournaled && database.savePendingRunOutcome) {
      try {
        database.savePendingRunOutcome(state.run.id, {
          ...state.terminalOutcome, transcriptMessage: result.transcriptMessage,
          transcriptOmitted: Boolean(state.transcriptOmitted || (pendingMessage && !result.transcriptMessage)),
        });
        state.outcomeJournaled = true;
        state.outcomeJournalError = null;
        result.journalBecameDurable = true;
      } catch (journalError) { state.outcomeJournalError = journalError; }
    }
    // The final checkpoint and terminal row commit together.
    result.finished = database.finishRun(state.run.id, {
      status, finishedAt, exitCode: terminalExitCode, error: message || null, pid: null,
      ...(state.run.providerSessionId ? { providerSessionId: state.run.providerSessionId } : {}),
      ...(state.transcriptOmitted ? { transcriptOmitted: true } : {}),
    }, result.transcriptMessage);
  }

  function deferFailedTerminalOutcome(state, exitCode, error, writeError, journalBecameDurable) {
    state.finishing = false;
    if (!storageAdmissionFailure(writeError) && !(writeError.statusCode === 503 && database.maintenanceActive)) throw writeError;
    state.pendingFinish = { exitCode, error };
    state.finishFailureCount = (state.finishFailureCount ?? 0) + 1;
    const persistent = persistentStorageFailure(writeError) || state.finishFailureCount >= 2;
    if (shuttingDown && journalBecameDurable) setTimeout(onShutdownRecovery, 0);
    if (persistent && (!state.child || state.closed)) {
      active.delete(state.run.id);
      pendingOutcomes.set(state.run.id, state);
      publish({ type: "run.outcome_pending", runId: state.run.id, conversationId: state.conversation.id, reason: "storage-unavailable" });
      publish({ type: "capacity.changed" });
      if (!database.maintenanceActive) drain();
    }
    if (!database.maintenanceActive) retryUnknownDiskUsage(persistent);
    return false;
  }

  function completeTerminalOutcome(state, { finished, transcriptMessage }) {
    const { status, message, finishedAt, exitCode: terminalExitCode } = state.terminalOutcome;
    state.pendingFinish = null;
    state.terminalOutcome = null;
    state.pendingSessionId = null;
    if (state.outcomeJournaled) {
      try { database.removePendingRunOutcome(state.run.id); }
      catch { /* The committed row makes a stale record safe to sweep on restart. */ }
      state.outcomeJournaled = false;
    }
    if (transcriptMessage && !finished.message) {
      // finishRun committed the terminal state, omission flag and audit in one
      // transaction. A failure to write the optional notice cannot retry that
      // transaction or duplicate its audit after a process restart.
      try { markTranscriptOmitted(state); }
      catch (noticeError) {
        state.transcriptOmitted = true;
        if (!storageAdmissionFailure(noticeError)) console.warn("Run transcript omission notice failed after terminal commit", noticeError);
      }
    } else if (finished.run?.transcriptOmitted) state.transcriptOmitted = true;
    // A Windows wrapper leaves a completed Job Object proof until this
    // terminal transaction succeeds. Other platforms may leave a record only
    // after a hard kill; both are safe to remove after the durable commit.
    try { if (state.launchHandshakePath) unlinkSync(state.launchHandshakePath); } catch { /* Already gone. */ }
    active.delete(state.run.id);
    pendingOutcomes.delete(state.run.id);
    admissionRetryRuns.delete(state.run.id);
    clearAssistant(state);
    if (shuttingDown) setTimeout(onShutdownRecovery, 0);
    // The freed slot reaches the queue even if a client notification fails.
    try {
      if (finished.message) publish({ type: "message.created", conversationId: state.conversation.id, payload: finished.message });
      publish({ type: "capacity.changed" });
      emitTerminal(state.run.id, state.conversation.id, `run.${status}`, { exitCode: terminalExitCode, error: message || null, finishedAt });
    } finally { drain(); }
  }

  function finish(state, exitCode, error) {
    if ((!active.has(state.run.id) && !pendingOutcomes.has(state.run.id)) || state.finishing) return;
    if (state.child && !state.closed) return false;
    state.finishing = true;
    clearCheckpointTimer(state);
    freezeTerminalOutcome(state, exitCode, error);
    const result = { finished: null, transcriptMessage: null, journalBecameDurable: false };
    try { persistTerminalOutcome(state, result); }
    catch (writeError) { return deferFailedTerminalOutcome(state, exitCode, error, writeError, result.journalBecameDurable); }
    completeTerminalOutcome(state, result);
    return true;
  }

  function stopQueuedRun(runId, preserveOnMaintenance) {
    const index = queue.findIndex((entry) => entry.run.id === runId);
    if (index < 0) return false;
    try { database.finishRun(runId, { status: "stopped", finishedAt: new Date().toISOString() }); }
    catch (error) {
      if (preserveOnMaintenance && database.maintenanceActive && error.statusCode === 503) return false;
      throw error;
    }
    const [stopped] = queue.splice(index, 1);
    admissionRetryRuns.delete(runId);
    if (!queue.length) { queueReadRetryPending = false; clearDiskRetry(); }
    emitTerminal(runId, stopped.conversation.id, "run.stopped", { queued: true });
    return true;
  }

  function settleFrozenOutcome(state, preserveOnMaintenance) {
    if (finish(state, state.terminalOutcome.exitCode, state.pendingFinish?.error)) return true;
    if (preserveOnMaintenance) return false;
    throw unresolvedOutcomeUnavailable();
  }

  async function waitForOwnedAgentTree(state, runId) {
    if (!state.child) return;
    const started = Date.now();
    let teardownRequested = Boolean(state.ownsDescendants);
    let escalated = false;
    let groupEscalated = false;
    while (state.ownsDescendants
      ? !state.closed || nativeOwnershipPending(state)
      : !state.closed || processGroupAlive(state.child)) {
      const elapsed = Date.now() - started;
      if (!teardownRequested && elapsed >= terminationGraceMs) {
        requestWrapperTeardown(state);
        teardownRequested = true;
      } else if (!state.ownsDescendants && teardownRequested && !escalated && elapsed >= terminationGraceMs + escalationGraceMs) {
        escalateTree(state.child, state.launchHandshakePath);
        escalated = true;
      } else if (!state.ownsDescendants && escalated && !groupEscalated && elapsed >= terminationGraceMs + 2 * escalationGraceMs) {
        terminateTree(state.child, "SIGKILL");
        groupEscalated = true;
      }
      // Killing a native subreaper would escape its descendants. Keep its
      // durable owner charged and report the timeout instead.
      if (elapsed >= terminationTimeoutMs) throw new Error(`Agent process tree did not terminate: ${runId}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  function finishStoppedAgentState(state, preserveOnMaintenance) {
    try {
      if (finish(state, state.exitCode ?? null, null) === false) {
        if (preserveOnMaintenance && !state.child) return false;
        throw unresolvedOutcomeUnavailable();
      }
    } catch (error) {
      // A childless validation can race archive cutover; its queued row then
      // remains protected for the successor instead of claiming cancellation.
      if (preserveOnMaintenance && !state.child && database.maintenanceActive && error.statusCode === 503) return false;
      throw error;
    }
    return true;
  }

  async function stop(runId, preserveOnMaintenance = false) {
    const pending = pendingOutcomes.get(runId);
    if (pending) {
      if (finish(pending, pending.pendingFinish.exitCode, pending.pendingFinish.error)) return true;
      if (preserveOnMaintenance) return false;
      throw unresolvedOutcomeUnavailable();
    }
    const state = active.get(runId);
    if (!state) return stopQueuedRun(runId, preserveOnMaintenance);
    if (state.terminalOutcome && (!state.child || state.closed)) {
      return settleFrozenOutcome(state, preserveOnMaintenance);
    }
    if (state.stopping) return state.stopping;
    state.stopped = true;
    // Keep the capacity reservation until both validation and tree shutdown end.
    // On Windows the supervisor's control pipe owns Job Object teardown.
    // taskkill /T /F here kills the verifier before it can report an empty job.
    // An injected or legacy leaf has no native Job Object to ask for cleanup.
    // Its ordinary child signal remains necessary on Windows too.
    if (state.child && (process.platform !== "win32" || !state.ownsDescendants || !state.child.pid)) terminateTree(state.child, "SIGTERM");
    // Cancellation must not wait for an acknowledgement that may never arrive.
    // stdin ordering guarantees a post-authorization stop follows "go", while
    // an unauthorized owner treats stop/end as abandonment.
    if (state.child && (state.ownsDescendants || process.platform === "win32")) requestWrapperTeardown(state);
    state.stopping = (async () => {
      await waitForOwnedAgentTree(state, runId);
      return finishStoppedAgentState(state, preserveOnMaintenance);
    })();
    const stopping = state.stopping;
    try { return await stopping; }
    finally {
      // A failed durable write or tree teardown must remain retryable. The
      // async body above can settle before its promise is assigned to state.
      if (state.stopping === stopping && active.has(runId)) state.stopping = null;
    }
  }

  // Asks the launch wrapper to tear its provider tree down in reaping order
  // and retain ownership until cleanup is proven. Writing to a non-wrapper
  // child (an injected spawnProcess) is harmless — the command is ignored and
  // the escalation fallbacks in stop() still apply.
  function requestWrapperTeardown(state) {
    try { state.child?.stdin?.write?.("stop\n"); } catch { /* The wrapper already exited. */ }
  }

  function conflictsWithActiveRun(entry) {
    return [...active.values(), ...pendingOutcomes.values()].some((state) => {
      const activeWorktree = state.run.worktreePath ?? state.conversation.worktreePath;
      const queuedWorktree = entry.run.worktreePath ?? entry.conversation.worktreePath;
      return state.conversation.id === entry.run.conversationId
        || (activeWorktree && queuedWorktree && activeWorktree === queuedWorktree);
    });
  }

  async function prepareQueuedLaunch(state, entry) {
    const fresh = database.getConversation(entry.run.conversationId);
    if (!fresh) throw new Error("Conversation no longer exists");
    if (entry.run.worktreePath && fresh.worktreePath !== entry.run.worktreePath) {
      throw new Error("Conversation target changed after this run was queued; submit again");
    }
    const authorize = await validateConversation(fresh);
    if (state.stopped || shuttingDown) return null;
    const current = database.getConversation(fresh.id);
    if (!current || ["projectId", "worktreeId", "worktreePath"].some((key) => current[key] !== fresh[key])
      || (entry.run.worktreePath && current.worktreePath !== entry.run.worktreePath)) {
      throw new Error("Conversation target changed while preparing the run; submit again");
    }
    // Recheck mutable trust synchronously immediately before spawning.
    authorize?.();
    // Recovery retry explicitly asks for a new provider session even when
    // the conversation still advertises the interrupted one.
    // A native session belongs to the provider that created it. Never hand
    // another provider's resume token to this run's adapter.
    if (entry.providerSessionId !== undefined) state.conversation = { ...current, providerSessionId: entry.providerSessionId };
    else if (entry.forceFreshSession || current.provider !== entry.run.provider) state.conversation = { ...current, providerSessionId: null };
    else state.conversation = current;
    return { authorize };
  }

  async function handleQueuedLaunchError(state, error) {
    if (error.statusCode === 503 && database.maintenanceActive && !state.child && !state.stopped) {
      // Revalidate the target after the archive worker reopens SQLite.
      await waitForMaintenance();
      return "retry";
    }
    if (!state.stopped && !error?.preserveActiveRun) {
      // A refused terminal transaction keeps its slot and a bounded retry.
      if (finish(state, null, error) === false && database.maintenanceActive) await waitForMaintenance();
    }
    return "finished";
  }

  async function launchQueued(state, entry) {
    while (!state.stopped && !shuttingDown) {
      try {
        const prepared = await prepareQueuedLaunch(state, entry);
        if (!prepared) return;
        const admission = await start(state, prepared.authorize);
        if (["deferred", "retry-deferred", "persistent-deferred"].includes(admission)) {
          active.delete(entry.run.id);
          queue.unshift(entry);
          retryDeferredAdmission(admission !== "deferred", entry.run.id, admission === "persistent-deferred");
          // The archive worker closes SQLite while promoting its snapshot.
          // Keep schedule's readback pending until the reopened connection is
          // available, even though this run is safely queued again.
          if (database.maintenanceActive) await waitForMaintenance();
        }
        return;
      } catch (error) {
        if (await handleQueuedLaunchError(state, error) === "retry") continue;
        return;
      }
    }
  }

  function retryUnknownDiskUsage(persistent = false) {
    if (shuttingDown && ![...active.values(), ...pendingOutcomes.values()].some((state) => state.pendingFinish && !state.outcomeJournaled)) return;
    // Probe a newly observed hard fault once promptly; a continuing refusal
    // then backs off to a maintenance-rate probe instead of a busy loop.
    let delay = diskRetryDelayMs;
    if (persistent) delay = hardRetryProbed ? 30_000 : 100;
    if (diskRetryTimer) {
      // The earliest owner wins. A newly exited result must never wait behind
      // an unrelated admission's long backoff, regardless of fault class.
      if (diskRetryDueAt <= Date.now() + delay) return;
      clearTimeout(diskRetryTimer);
    }
    if (persistent) hardRetryProbed = true;
    else diskRetryDelayMs = Math.min(30_000, diskRetryDelayMs * 2);
    diskRetryDueAt = Date.now() + delay;
    diskRetryTimer = setTimeout(() => {
      diskRetryTimer = null;
      diskRetryDueAt = 0;
      retryPendingSessionMetadata();
      retryPendingFinishes();
      drain();
      onDiskRetry();
    }, delay);
    diskRetryTimer.unref?.();
  }

  function clearDiskRetry() {
    // A sibling may free a slot and drain the queue while another completed
    // run still awaits its terminal commit. Keep that retry armed until every
    // such owner has durable outcome evidence.
    if (!shuttingDown && (queueReadRetryPending || admissionRetryRuns.size
      || [...active.values(), ...pendingOutcomes.values()].some((state) => state.pendingFinish || state.pendingSessionId))) return;
    if (diskRetryTimer) clearTimeout(diskRetryTimer);
    diskRetryTimer = null;
    diskRetryDueAt = 0;
    diskRetryDelayMs = 100;
    hardRetryProbed = false;
  }

  function retryPendingSessionMetadata() {
    if (database.maintenanceActive) return;
    for (const state of [...active.values(), ...pendingOutcomes.values()]) {
      if (!state.pendingSessionId) continue;
      try { persistSessionMetadata(state); }
      catch (error) {
        // A non-storage contract failure still belongs to this run. Do not
        // let a timer callback terminate the runtime's event loop.
        state.processError ??= error;
        state.checkpointHalted = true;
        if (state.child && !state.closed) terminateTree(state.child, "SIGTERM");
      }
    }
  }

  function retryPendingFinishes() {
    if (database.maintenanceActive) return;
    for (const state of [...active.values(), ...pendingOutcomes.values()]) {
      if (!state.pendingFinish || (state.child && !state.closed)) continue;
      const { exitCode, error } = state.pendingFinish;
      finish(state, exitCode, error);
    }
  }

  function retryDeferredAdmission(storageFault = false, runId = null, persistent = false) {
    if (database.maintenanceActive) return;
    if (storageFault && runId) admissionRetryRuns.add(runId);
    // A failed SQLite write/read needs its own retry owner even if the last
    // measured capacity was below the ordinary launch threshold. Capacity
    // alone cannot tell whether the fault has cleared.
    if (admissionRetryRuns.size) { retryUnknownDiskUsage(persistent); return; }
    let observed;
    try { observed = database.capacity?.(); }
    catch (error) {
      if (!storageAdmissionFailure(error)) throw error;
      retryUnknownDiskUsage(persistentStorageFailure(error));
      return;
    }
    // Unknown physical usage may recover without another capacity event. A
    // measured budget with room can also race the admission check. A genuinely
    // full budget waits for an explicit release instead of polling forever.
    if (observed?.diskUsageStatus === "unknown"
      || observed?.availableForNewWorkBytes >= 64 * 1024) retryUnknownDiskUsage();
  }

  function launchNextQueuedRun() {
    let admissible;
    try { admissible = database.canLaunchRun?.(); }
    catch (error) {
      if (!storageAdmissionFailure(error)) throw error;
      queueReadRetryPending = true;
      retryUnknownDiskUsage(persistentStorageFailure(error));
      return false;
    }
    queueReadRetryPending = false;
    if (admissible === false) { retryDeferredAdmission(); return false; }
    clearDiskRetry();
    const index = queue.findIndex((entry) => !conflictsWithActiveRun(entry));
    if (index < 0) return false;
    const entry = queue.splice(index, 1)[0];
    const state = { ...entry, assistantSegments: [], assistantBytes: 0, assistantTruncated: false,
      assistantMessageId: null, assistantCreatedAt: null, transcriptSeq: 0, transcriptSizes: new Map(),
      transcriptBytes: 0, transcriptOmitted: false, stderr: "", stopped: false,
      checkpointPendingBytes: 0, lastCheckpointAt: 0, checkpointTimer: null, checkpointHalted: false };
    active.set(entry.run.id, state);
    state.launch = entry.launch = launchQueued(state, entry);
    launches.add(state.launch);
    state.launch.then(() => launches.delete(state.launch), () => launches.delete(state.launch));
    return true;
  }

  function drain() {
    // Every entry point, including the disk retry timer, reaches this guard.
    // During the archive cutover getSettings cannot read the closed SQLite
    // connection. onDeletionWorkerExit calls resumeQueued after it reopens.
    if (shuttingDown || database.maintenanceActive) return;
    if (!queue.length) {
      queueReadRetryPending = false;
      admissionRetryRuns.clear();
      clearDiskRetry();
      return;
    }
    let max;
    try { max = database.getSettings().maxConcurrentRuns; }
    catch (error) {
      if (!storageAdmissionFailure(error)) throw error;
      queueReadRetryPending = true;
      retryUnknownDiskUsage(persistentStorageFailure(error));
      return;
    }
    // A successful settings read resolves its fault. If every slot is already
    // occupied, a finish/cancellation will re-enter drain when capacity frees.
    if (active.size >= max) {
      queueReadRetryPending = false;
      clearDiskRetry();
    }
    // Bound unresolved outcomes by the same configured concurrency budget.
    // This leaves room for independent work while preventing a failed store
    // from accumulating an unlimited set of finished run snapshots in RAM.
    // Each preparing/running provider may become an exited pending outcome.
    // Keep that reservation until its terminal row commits, even if it stops
    // consuming a process slot before SQLite recovers.
    while (active.size < max && active.size + pendingOutcomes.size < RESOURCE_BUDGETS.maxPendingRunOutcomes && queue.length) {
      if (!launchNextQueuedRun()) return;
    }
  }

  // Persists one completed ordered transcript item immediately. Assistant
  // streams use a stable checkpoint id below so repeated delta writes update
  // one message rather than duplicating partial content.
  function persistTranscriptItem(state, item) {
    state.transcriptSeq = (state.transcriptSeq ?? 0) + 1;
    const toolItem = item.payload?.item ?? null;
    const payload = item.kind === "text"
      ? { runId: state.run.id, provider: state.run.provider, truncated: Boolean(item.payload?.truncated) }
      : boundedToolPayload(state.run.id, toolItem);
    const body = item.kind === "tool" ? truncateUtf8(item.body, MAX_TOOL_TRANSCRIPT_PAYLOAD_BYTES) : item.body;
    const input = budgetTranscript(state, { id: `${state.run.id}:${state.transcriptSeq}`, createdAt: new Date().toISOString(), conversationId: state.conversation.id, role: "assistant", kind: item.kind, body, payload });
    if (!input) return;
    let message;
    try { message = database.addMessage(input, { omissionRunId: state.run.id }); }
    catch (error) {
      if (error.statusCode !== 507) { throw error; }
      markTranscriptOmitted(state);
      return;
    }
    if (!message) { markTranscriptOmitted(state); return; }
    publish({ type: "message.created", conversationId: state.conversation.id, payload: message });
  }

  // Coalesces Claude delta output into bounded durable checkpoints: a
  // checkpoint is flushed once enough new bytes (or time) have accumulated
  // since the last one. The time bound is enforced by a real timer, so a
  // stalled sub-threshold tail is still flushed within the interval even if no
  // further delta ever arrives. Message/tool boundaries and run finalization
  // always flush, so the final transcript stays exact-once. Once the transcript
  // cap is hit and the truncated body is durably flushed, later (discarded)
  // deltas no longer trigger rewrites — write amplification stays bounded even
  // past the cap.
  function scheduleAssistantCheckpoint(state, deltaText) {
    if (state.checkpointHalted) return false;
    if (!state.assistantBytes) return false;
    state.checkpointPendingBytes = (state.checkpointPendingBytes ?? 0) + Buffer.byteLength(deltaText ?? "");
    if (state.assistantTruncated || state.checkpointPendingBytes >= checkpointMinBytes || Date.now() - (state.lastCheckpointAt ?? 0) >= checkpointIntervalMs) {
      return true;
    }
    armCheckpointTimer(state);
    return false;
  }

  function armCheckpointTimer(state) {
    if (state.checkpointTimer) return;
    const elapsed = Date.now() - (state.lastCheckpointAt ?? 0);
    const delay = Math.max(0, checkpointIntervalMs - elapsed);
    state.checkpointTimer = setTimeout(() => {
      state.checkpointTimer = null;
      // The timer is cleared at every flush boundary; if it fires, the pending
      // tail has never been durably written, so flush it now.
      if (!state.assistantBytes || state.checkpointHalted) return;
      persistAssistantCheckpoint(state);
    }, delay);
    // Never hold the process open for a pending checkpoint alone.
    state.checkpointTimer.unref?.();
  }

  function clearCheckpointTimer(state) {
    if (!state.checkpointTimer) return;
    clearTimeout(state.checkpointTimer);
    state.checkpointTimer = null;
  }

  function persistAssistantCheckpoint(state, { publishEvent = false } = {}) {
    clearCheckpointTimer(state);
    state.checkpointPendingBytes = 0;
    state.lastCheckpointAt = Date.now();
    const message = budgetTranscript(state, pendingAssistantMessage(state));
    if (!message) return null;
    // The capped body plus truncation marker is now durable; discarded deltas
    // beyond the cap must not schedule further rewrites of the same body.
    if (state.assistantTruncated) state.checkpointHalted = true;
    let stored;
    try { stored = database.upsertMessage(message, { omissionRunId: state.run.id }); }
    catch (error) {
      if (error.statusCode !== 507) { throw error; }
      markTranscriptOmitted(state);
      state.checkpointHalted = true;
      return null;
    }
    if (!stored) { markTranscriptOmitted(state); state.checkpointHalted = true; return null; }
    if (publishEvent) publish({ type: "message.created", conversationId: state.conversation.id, payload: stored });
    return stored;
  }

  function emitAssistantDeltaWithCheckpoint(state, payload) {
    clearCheckpointTimer(state);
    state.checkpointPendingBytes = 0;
    state.lastCheckpointAt = Date.now();
    const message = budgetTranscript(state, pendingAssistantMessage(state));
    if (!message) return emit(state.run.id, "assistant.delta", payload);
    if (state.assistantTruncated) state.checkpointHalted = true;
    // The delta event and the transcript prefix that already contains it are
    // one SQLite commit. The message records the event cursor, so a page load
    // racing publication can discard that already-durable delta exactly once.
    const committed = database.appendRunEventWithMessage(state.run.id, "assistant.delta", payload, message);
    if (!committed.message) { markTranscriptOmitted(state); state.checkpointHalted = true; }
    if (committed.event) state.lastAssistantDeltaSeq = committed.event.seq;
    if (committed.event) publish({ type: "run.event", conversationId: state.conversation.id, runId: state.run.id, payload: committed.event });
    return committed.event;
  }

  // A terminal row is committed before its event. Even when the event log is
  // full or unwritable, a bounded transient notification makes connected
  // clients refresh that durable state. The fault never reaches the close
  // listener, retry timer or stop request that committed it, nor retries
  // that transaction.
  function emitTerminal(runId, conversationId, type, payload) {
    let event = null;
    try { event = database.appendRunEvent(runId, type, payload); }
    catch (error) {
      if (!storageAdmissionFailure(error)) console.warn("Run terminal event failed after terminal commit", error);
    }
    publish({ type: "run.event", conversationId, runId,
      payload: event ?? { runId, type, payload, seq: null, transient: true, createdAt: new Date().toISOString() } });
    return event;
  }

  function emit(runId, type, payload) {
    const event = database.appendRunEvent(runId, type, payload);
    // Event replay and transcript persistence have separate quotas. A dropped
    // replay event does not imply that the visible transcript lost a message.
    if (event) publish({ type: "run.event", conversationId: database.getRun(runId)?.conversationId, runId, payload: event });
    return event;
  }

  function budgetTranscript(state, message, { terminal = false } = {}) {
    if (!message) return null;
    const prior = state.transcriptSizes.get(message.id) ?? 0;
    // Leave room for both the omission notice and a final assistant segment.
    if (!prior && state.transcriptSizes.size >= MAX_RUN_TRANSCRIPT_ITEMS - (terminal ? 0 : 2)) {
      markTranscriptOmitted(state, { terminal });
      return null;
    }
    const ceiling = MAX_RUN_TRANSCRIPT_BYTES - (terminal ? 512 : 4096);
    const metadataBytes = retainedTranscriptMessageBytes({ ...message, body: "" });
    const allowance = ceiling - state.transcriptBytes + prior - metadataBytes;
    if (allowance <= 0) { markTranscriptOmitted(state, { terminal }); return null; }
    const originalBytes = Buffer.byteLength(message.body ?? "");
    const body = originalBytes > allowance ? truncateUtf8(message.body, Math.max(0, allowance - 64)) : message.body;
    const bounded = originalBytes > allowance
      ? { ...message, body: `${body}\n[Further output omitted: transcript budget reached]`, payload: { ...message.payload, truncated: true } }
      : message;
    const size = retainedTranscriptMessageBytes(bounded);
    if (state.transcriptBytes - prior + size > ceiling) { markTranscriptOmitted(state, { terminal }); return null; }
    state.transcriptSizes.set(message.id, size);
    state.transcriptBytes += size - prior;
    if (originalBytes > allowance) markTranscriptOmitted(state, { terminal });
    return bounded;
  }

  function markTranscriptOmitted(state, { terminal = false } = {}) {
    if (state.transcriptOmitted) return;
    if (terminal) {
      state.transcriptOmitted = true;
      return;
    }
    // The optional message can itself be refused at the aggregate cap. The
    // run row uses reserved transition space, so it remains a durable marker
    // through cancellation, finalization and restart.
    database.updateRun(state.run.id, { transcriptOmitted: true });
    state.transcriptOmitted = true;
    try {
      const message = database.addMessage({ id: `${state.run.id}:budget`, conversationId: state.conversation.id,
        role: "assistant", kind: "text", body: "Further run transcript items omitted because the retention budget was reached.",
        payload: { runId: state.run.id, provider: state.run.provider, truncated: true } });
      publish({ type: "message.created", conversationId: state.conversation.id, payload: message });
    } catch (error) { if (error.statusCode !== 507) throw error; }
  }

  return {
    providers,
    providerAvailable: providerDiscovery.available,
    schedule,
    resumeQueued() {
      if (database.maintenanceActive) return;
      wakeMaintenanceWaiters();
      retryPendingFinishes();
      drain();
    },
    stop,
    activeRuns: () => [...active.keys(), ...pendingOutcomes.keys()],
    activeProcessCount: () => active.size,
    pendingOutcomeCount: () => pendingOutcomes.size,
    hasPendingFinishes: () => [...active.values(), ...pendingOutcomes.values()].some((state) => Boolean(state.pendingFinish)),
    isOutcomePending: (runId) => pendingOutcomes.has(runId),
    shutdown() {
      if (shutdownPromise) return shutdownPromise;
      shuttingDown = true;
      clearDiskRetry();
      wakeMaintenanceWaiters();
      const ids = [...queue.map((entry) => entry.run.id), ...active.keys(), ...pendingOutcomes.keys()];
      shutdownPromise = Promise.allSettled([
        ...ids.map((id) => stop(id, true)),
        ...launches,
        providerDiscovery.close(),
      ]).then((results) => {
        const failure = results.find((result) => result.status === "rejected");
        if (failure) throw failure.reason;
        // A database refusal may leave an exited owner in memory. Resolving
        // shutdown is safe only when restart has an independently durable
        // terminal result; otherwise report the hold instead of silently
        // handing an unknown row to interruption reconciliation.
        if (database.savePendingRunOutcome) {
          const unjournaled = [...active.values(), ...pendingOutcomes.values()].find((state) =>
            state.terminalOutcome && !state.outcomeJournaled && (!state.child || state.closed));
          if (unjournaled) throw new Error(`Run outcome could not be made durable before shutdown: ${unjournaled.run.id}`,
            { cause: unjournaled.outcomeJournalError });
        }
      }).catch((error) => {
        // A failed shutdown still owns the SQLite lease. Keep one retry owner
        // for an unjournaled exited result, and permit a later shutdown call
        // to complete once storage is writable again.
        shutdownPromise = null;
        if ([...active.values(), ...pendingOutcomes.values()].some((state) => state.pendingFinish)) retryUnknownDiskUsage(true);
        throw error;
      });
      return shutdownPromise;
    },
  };
}

// Terminates the provider's whole process tree. On POSIX the provider runs in
// the wrapper's process group, so signaling the group terminates everything.
// On Windows there is no owned process group: taskkill /T /F tears down the
// wrapper's entire tree, which is the only portable tree-aware mechanism; if
// it is unavailable the conservative recovery probes never trust a gone
// Windows leader (see defaultProbeRun/defaultRecoveryProcessAlive).
export function terminateTree(child, signal, platform = process.platform, run = spawnSync, kill = process.kill) {
  try {
    if (!child?.pid) { child?.kill?.(signal); return; }
    if (platform === "win32") {
      run("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    }
    kill(-child.pid, signal);
  } catch { /* The process group already exited. */ }
}

// Escalation after the graceful SIGTERM window. The provider is killed alone
// only when its pid and immutable process identity are durably known and the
// identity still matches immediately before signaling, so the
// wrapper — the provider's parent — survives to reap it. A group-wide
// SIGKILL would kill the wrapper first and leave a killed-but-unreaped
// provider as a zombie in its process group on hosts whose PID 1 does not
// reap orphans, which would keep every liveness probe reporting alive until
// the termination timeout. Without a usable provider pid (an injected child
// spawned outside the launch wrapper, or an unreadable record) the whole
// owned group is killed as before. Darwin currently has no immutable provider
// identity (the wrapper token identifies the wrapper, not the provider), so it
// deliberately fails closed to the still-owned process group.
export function escalateTree(child, handshakePath, platform = process.platform, run = spawnSync, kill = process.kill, providerProcessIdentity = (pid) => defaultProviderProcessIdentity(pid, platform)) {
  if (platform === "win32") {
    terminateTree(child, "SIGKILL", platform, run, kill);
    return "group";
  }
  if (!child?.pid) {
    try { child?.kill?.("SIGKILL"); } catch { /* Already gone. */ }
    return "group";
  }
  let providerPid = null;
  try {
    const record = JSON.parse(readFileSync(handshakePath, "utf8"));
    const recorded = Number(record?.providerPid);
    // A malformed or tampered record must never reach POSIX kill: kill(-1,
    // "SIGKILL") would terminate every process the runtime user owns. Only a
    // safe positive pid is usable; anything else falls back to the owned
    // process group. The recorded birth identity must also revalidate at the
    // last possible moment so PID reuse can never redirect SIGKILL.
    const recordedIdentity = typeof record?.providerProcessIdentity === "string" && record.providerProcessIdentity
      ? record.providerProcessIdentity
      : null;
    const liveIdentity = recordedIdentity ? providerProcessIdentity(recorded) : null;
    if (record?.authorized === true
      && Number(record?.pid) === child.pid
      && Number.isSafeInteger(recorded)
      && recorded > 0
      && recordedIdentity
      && liveIdentity === recordedIdentity) providerPid = recorded;
  } catch { /* No (or unreadable) handshake record. */ }
  if (providerPid) {
    try {
      kill(providerPid, "SIGKILL");
      return "provider";
    } catch (error) {
      if (error?.code === "EPERM") return "provider";
      // ESRCH: the provider is already gone; the wrapper is exiting on its own.
    }
  }
  try { kill(-child.pid, "SIGKILL"); } catch { /* The process group already exited. */ }
  return "group";
}

export function defaultProviderProcessIdentity(pid, platform = process.platform, readFile = readFileSync) {
  try {
    if (platform !== "linux") return null;
    const bootId = readFile("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const stat = readFile(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return null;
    const startTicks = stat.slice(close + 2).split(" ")[19];
    return bootId && startTicks ? `linux:${bootId}:${startTicks}` : null;
  } catch { return null; }
}

// Liveness of the provider tree: the wrapper's process group on POSIX, the
// wrapper leader on Windows (only meaningful after a Windows taskkill /T,
// which tears down the whole tree).
export function processGroupAlive(child, platform = process.platform, groupMembers = defaultGroupMembers) {
  if (!child?.pid) return false;
  try {
    if (platform !== "win32") process.kill(-child.pid, 0);
    else process.kill(child.pid, 0);
  } catch (error) { return error.code !== "ESRCH"; }
  if (platform === "win32") return true;
  // On hosts whose PID 1 does not reap orphans, a killed-but-unreaped member
  // lingers as a zombie inside the group and keeps the signal probe
  // succeeding. A zombie cannot execute side effects, so a group whose every
  // member is a zombie is not alive.
  const members = groupMembers(child.pid);
  if (members == null) return true;
  return members.some((member) => member.state !== "Z");
}

// Enumerates the members of a process group from /proc, or returns null when
// member enumeration is unavailable (non-/proc platforms); the caller then
// keeps the conservative kill-probe verdict.
export function defaultGroupMembers(pgid) {
  let entries;
  try { entries = readdirSync("/proc"); } catch { return null; }
  const members = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let stat;
    try { stat = readFileSync(`/proc/${entry}/stat`, "utf8"); } catch { continue; }
    const close = stat.lastIndexOf(")");
    if (close < 0) continue;
    // After the comm field: state, ppid, pgrp, ...
    const fields = stat.slice(close + 2).split(" ");
    if (Number(fields[2]) === pgid) members.push({ pid: Number(entry), state: fields[0] });
  }
  return members;
}

function toolTranscriptLabel(event) {
  const item = event.payload?.item ?? {};
  const label = item.command || item.name || item.type || (event.type === "tool.started" ? "Tool started" : "Tool completed");
  return `${event.type === "tool.started" ? "Tool started" : "Tool completed"}: ${label}`;
}

export function consumeBoundedLines(stream, { maxLineBytes = MAX_PROVIDER_LINE_BYTES, onLine, onOverflow = () => {} }) {
  let buffered = Buffer.alloc(0);
  let discarding = false;
  stream.on("data", (chunk) => {
    const source = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < source.length) {
      const newline = source.indexOf(10, offset);
      const end = newline === -1 ? source.length : newline;
      const segment = source.subarray(offset, end);
      if (discarding) {
        if (newline === -1) return;
        discarding = false;
        offset = newline + 1;
        continue;
      }
      if (buffered.length + segment.length > maxLineBytes) {
        buffered = Buffer.alloc(0);
        onOverflow();
        if (newline === -1) { discarding = true; return; }
        offset = newline + 1;
        continue;
      }
      if (segment.length) buffered = buffered.length ? Buffer.concat([buffered, segment]) : Buffer.from(segment);
      if (newline === -1) return;
      const line = buffered.at(-1) === 13 ? buffered.subarray(0, -1) : buffered;
      onLine(line.toString("utf8"));
      buffered = Buffer.alloc(0);
      offset = newline + 1;
    }
  });
  stream.on("end", () => {
    if (!discarding && buffered.length) onLine(buffered.toString("utf8"));
    buffered = Buffer.alloc(0);
  });
}

// Assistant text is buffered as segments and only materialized at flush or
// boundary, so appending a delta costs O(delta), not O(transcript so far).
function appendAssistantText(state, text, emit) {
  if (state.assistantTruncated) return;
  const segment = String(text ?? "");
  if (!segment) return;
  state.assistantSegments.push(segment);
  state.assistantBytes += Buffer.byteLength(segment);
  if (state.assistantBytes > MAX_ASSISTANT_BYTES) {
    const bounded = boundUtf8(assistantBody(state), MAX_ASSISTANT_BYTES);
    state.assistantSegments = bounded.text ? [bounded.text] : [];
    state.assistantBytes = Buffer.byteLength(bounded.text);
    markAssistantTruncated(state, bounded.truncated, emit);
  }
}

function replaceAssistantText(state, text, emit) {
  const bounded = boundUtf8(String(text ?? ""), MAX_ASSISTANT_BYTES);
  state.assistantSegments = bounded.text ? [bounded.text] : [];
  state.assistantBytes = Buffer.byteLength(bounded.text);
  markAssistantTruncated(state, bounded.truncated, emit);
}

function assistantBody(state) {
  return state.assistantSegments.join("");
}

function archiveAssistant(state, persist) {
  persist(state);
  clearAssistant(state);
}

function pendingAssistantMessage(state) {
  // The body is persisted exactly as streamed: no trimming. A crash after a
  // timed or byte-bounded checkpoint recovers the stored text, so trimming
  // here would irreversibly drop leading indentation or a partial trailing
  // newline from the preserved output. Only a body that is entirely
  // whitespace (e.g. stray "\n\n" deltas between tool calls) is suppressed;
  // text-bearing content is stored byte-for-byte.
  const body = assistantBody(state);
  if (!body.trim()) return null;
  if (!state.assistantMessageId) {
    state.transcriptSeq = (state.transcriptSeq ?? 0) + 1;
    state.assistantMessageId = `${state.run.id}:${state.transcriptSeq}`;
    state.assistantCreatedAt = new Date().toISOString();
  }
  return {
    id: state.assistantMessageId,
    createdAt: state.assistantCreatedAt,
    conversationId: state.conversation.id,
    role: "assistant",
    kind: "text",
    body: `${body}${state.assistantTruncated ? ASSISTANT_TRUNCATION_MARKER : ""}`,
    payload: {
      runId: state.run.id,
      provider: state.run.provider,
      truncated: state.assistantTruncated,
      ...(Number.isSafeInteger(state.lastAssistantDeltaSeq) ? { checkpointEventSeq: state.lastAssistantDeltaSeq } : {}),
    },
  };
}

function clearAssistant(state) {
  if (state.checkpointTimer) {
    clearTimeout(state.checkpointTimer);
    state.checkpointTimer = null;
  }
  state.assistantSegments = [];
  state.assistantBytes = 0;
  state.assistantTruncated = false;
  state.assistantMessageId = null;
  state.assistantCreatedAt = null;
  // A new assistant segment starts fresh checkpoint scheduling.
  state.checkpointHalted = false;
  state.checkpointPendingBytes = 0;
}

function markAssistantTruncated(state, truncated, emit) {
  if (!truncated || state.assistantTruncated) return;
  state.assistantTruncated = true;
  emit(state.run.id, "assistant.truncated", { maxBytes: MAX_ASSISTANT_BYTES });
}

function boundUtf8(value, maxBytes) {
  const buffer = Buffer.from(String(value));
  if (buffer.length <= maxBytes) return { text: String(value), truncated: false };
  let end = maxBytes;
  let text = buffer.subarray(0, end).toString("utf8");
  while (Buffer.byteLength(text) > maxBytes && end > 0) text = buffer.subarray(0, --end).toString("utf8");
  return { text, truncated: true };
}

function truncateUtf8(value, maxBytes) { return boundUtf8(value, maxBytes).text; }

function boundedToolPayload(runId, item) {
  const payload = { runId, item };
  if (Buffer.byteLength(JSON.stringify(payload)) <= MAX_TOOL_TRANSCRIPT_PAYLOAD_BYTES) return payload;
  const source = JSON.stringify(item);
  let low = 0;
  let high = Math.min(Buffer.byteLength(source), MAX_TOOL_TRANSCRIPT_PAYLOAD_BYTES);
  let bounded = { runId, item: { truncated: true, preview: "" } };
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = { runId, item: { truncated: true, preview: truncateUtf8(source, middle) } };
    if (Buffer.byteLength(JSON.stringify(candidate)) <= MAX_TOOL_TRANSCRIPT_PAYLOAD_BYTES) {
      bounded = candidate;
      low = middle + 1;
    } else high = middle - 1;
  }
  return bounded;
}

export function buildProviderCommand(conversation, run) {
  return buildExecutionLaunch({ conversation, run, sessionId: conversation.providerSessionId });
}

function assertPrivateLaunchDirectory(directory) {
  if (!directory || !path.isAbsolute(directory)) throw new Error("A private absolute launch directory is required");
  try { mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if (error?.code !== "EEXIST") throw error; }
  let stat = lstatSync(directory);
  const wrongOwner = typeof process.getuid === "function" && stat.uid !== process.getuid();
  if (stat.isSymbolicLink() || !stat.isDirectory() || wrongOwner) {
    throw new Error("Launch directory must be a private, non-symlink directory owned by the runtime user");
  }
  if (process.platform === "win32") {
    hardenWindowsLaunchDirectory(directory);
    return;
  }
  if ((stat.mode & 0o077) !== 0) {
    chmodSync(directory, 0o700);
    stat = lstatSync(directory);
  }
  if ((stat.mode & 0o077) !== 0) throw new Error("Launch directory must not grant group or other permissions");
}

export function hardenWindowsLaunchDirectory(directory, run = spawnSync, environment = process.env) {
  const account = environment.USERNAME
    ? [environment.USERDOMAIN, environment.USERNAME].filter(Boolean).join("\\")
    : null;
  if (!account) throw new Error("A Windows account is required to secure the launch directory");
  const fullControl = "(OI)(CI)F";
  const result = run("icacls", [
    directory,
    "/inheritance:r",
    "/grant:r",
    `${account}:${fullControl}`,
    `*S-1-5-18:${fullControl}`,
    `*S-1-5-32-544:${fullControl}`,
    "/remove:g",
    "*S-1-1-0",
    "*S-1-5-11",
    "*S-1-5-32-545",
    "/C",
    "/Q",
  ], { stdio: "ignore" });
  if (result.error || result.status !== 0) {
    throw new Error("Unable to secure the Windows launch directory ACL", { cause: result.error });
  }
}

function sanitizedEnvironment(environment) {
  const blocked = /^(OUTRIGHT_|VITE_|npm_|NODE_OPTIONS$)/i;
  return Object.fromEntries(Object.entries(environment).filter(([key, value]) => value != null && !blocked.test(key)));
}
