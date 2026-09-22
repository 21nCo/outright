import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_PROVIDER_LINE_BYTES = 1024 * 1024;
const MAX_ASSISTANT_BYTES = 1024 * 1024;
const MAX_PROCESS_EVENT_BYTES = 64 * 1024;
const MAX_ASSISTANT_EVENT_BYTES = 255 * 1024;
const ASSISTANT_TRUNCATION_MARKER = "\n\n[Output truncated by Outright at 1 MiB]";
// Assistant checkpoints are coalesced: a new durable checkpoint is written
// only after this many new stream bytes (or this much time) accumulate, so a
// long delta stream rewrites the growing transcript O(bytes/threshold) times
// instead of once per token, while crash exposure stays bounded.
const CHECKPOINT_MIN_BYTES = 4 * 1024;
const CHECKPOINT_INTERVAL_MS = 500;
export const AGENT_SUPERVISOR = process.env.OUTRIGHT_AGENT_SUPERVISOR_PATH
  || fileURLToPath(new URL(process.platform === "win32" ? "./bin/agent-supervisor.exe" : "./bin/agent-supervisor", import.meta.url));
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
      if (!expectedOwnershipToken) return null;
      const boot = execFileSync("/usr/sbin/sysctl", ["-n", "kern.boottime"], { encoding: "utf8" }).trim();
      const command = execFileSync("/bin/ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim();
      return boot && command === \`outright-agent-\${expectedOwnershipToken}\`
        ? \`darwin:\${boot}:\${expectedOwnershipToken}\`
        : null;
    }
    if (process.platform === "win32") {
      const script = "$boot=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().Ticks;"
        + "$start=(Get-Process -Id " + String(pid) + ").StartTime.ToUniversalTime().Ticks;"
        + "Write-Output ($boot.ToString() + ':' + $start.ToString())";
      const started = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true }).trim();
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
  try { fs.unlinkSync(handshakePath); } catch {}
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
  else try { provider.kill("SIGTERM"); } catch { /* Already gone. */ }
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
      authorized = true;
      // Authorization is durable before the provider can execute. If this
      // ownership rewrite fails, fail the launch without ever spawning the
      // provider; acknowledging an identity-less launch would make restart
      // recovery unable to signal or safely release it.
      try { writeHandshake(handshake(true)); }
      catch (error) {
        console.error(String((error && error.message) || error));
        try { fs.unlinkSync(handshakePath); } catch {}
        process.exit(127);
      }
      const { spawn } = require("node:child_process");
      provider = spawn(executable, commandArgs, { stdio: ["ignore", "inherit", "inherit"] });
      // Durable provider identity: escalation targets the provider alone so this
      // wrapper — the provider's parent — survives to reap it. Without this, a
      // group-wide SIGKILL kills the wrapper first and a killed-but-unreaped
      // provider lingers as a zombie in its process group on hosts whose PID 1
      // does not reap orphans.
      try { writeHandshake(handshake(true, provider.pid)); } catch { /* The durable wrapper identity still owns recovery; provider-only escalation becomes unavailable. */ }
      provider.on("error", (error) => { console.error(String((error && error.message) || error)); finish(127); });
      provider.on("close", (code, signal) => {
        providerGone = true;
        providerResult = { code, signal };
        finishWhenOwnedGroupIsEmpty();
      });
      // Keep launch ownership control off provider stdout. Providers may emit
      // arbitrary bytes (including unterminated prefixes or the control token
      // itself), so only the manager-owned fd 3 can acknowledge authorization.
      try { fs.writeSync(${LAUNCH_CONTROL_FD}, ${JSON.stringify(LAUNCH_AUTHORIZED_CONTROL)} + "\\n"); }
      catch { teardown(); }
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
process.stdin.on("end", () => { if (!authorized) { try { fs.unlinkSync(handshakePath); } catch {} process.exit(0); } });
`;

export function defaultLaunchCommand(command, run, launchDirectory) {
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

export function createAgentManager({ database, publish, spawnProcess = spawn, validateConversation = async () => {}, terminationGraceMs = 3500, terminationTimeoutMs = 8000, escalationGraceMs = 750, checkpointMinBytes = CHECKPOINT_MIN_BYTES, checkpointIntervalMs = CHECKPOINT_INTERVAL_MS, launchCommand = defaultLaunchCommand, launchDirectory }) {
  const resolvedLaunchDirectory = launchDirectory
    ?? database.launchDirectory;
  assertPrivateLaunchDirectory(resolvedLaunchDirectory);
  const active = new Map();
  const queue = [];
  let shuttingDown = false;
  let shutdownPromise;

  function providers() {
    return [
      detectProvider("codex", "Codex", ["--version"], ["gpt-5.4", "gpt-5.3-codex"]),
      detectProvider("claude", "Claude Code", ["--version"], ["sonnet", "opus", "haiku"]),
    ];
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

  async function start(state) {
    const { conversation, run } = state;
    const command = buildProviderCommand(conversation, run);
    const launch = launchCommand(command, run, resolvedLaunchDirectory);
    const startedAt = new Date().toISOString();
    // Crash-safe launch handshake, phase 1: this durable marker means "a spawn
    // may have been issued, but the provider was never authorized to run". A
    // crash from here on restarts as a run that provably never started side
    // effects (the wrapper records its identity durably but waits for
    // authorization), so recovery always has an explicit safe continuation
    // instead of being permanently gated on a missing pid.
    database.updateRun(run.id, { status: "launching", startedAt });
    database.audit("agent.run.started", { target: run.id, provider: run.provider, conversationId: conversation.id, worktreePath: conversation.worktreePath, approvalPolicy: run.approvalPolicy });
    emit(run.id, "run.started", { provider: run.provider, model: run.model, startedAt, command: launch.display ?? command.display });

    const child = spawnProcess(launch.executable, launch.args, {
      cwd: conversation.worktreePath,
      env: sanitizedEnvironment(process.env),
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
    consumeBoundedLines(child.stdout, {
      maxLineBytes: MAX_PROVIDER_LINE_BYTES,
      onLine: (line) => handleProviderLine(state, line),
      onOverflow: () => emit(run.id, "process.output_truncated", { stream: "stdout", maxBytes: MAX_PROVIDER_LINE_BYTES }),
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
      emit(run.id, "process.stderr", { text: truncateUtf8(text, MAX_PROCESS_EVENT_BYTES), truncated: Buffer.byteLength(text) > MAX_PROCESS_EVENT_BYTES });
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

  function handleProviderLine(state, line) {
    if (!line.trim()) return;
    let raw;
    try { raw = JSON.parse(line); }
    catch {
      emit(state.run.id, "process.stdout", { text: truncateUtf8(line, MAX_PROCESS_EVENT_BYTES), truncated: Buffer.byteLength(line) > MAX_PROCESS_EVENT_BYTES });
      return;
    }
    const events = state.run.provider === "claude" ? normalizeClaude(raw) : normalizeCodex(raw);
    for (const event of events) {
      let checkpointDelta = null;
      if (event.type === "session") {
        state.run.providerSessionId = event.payload.sessionId;
        database.updateRun(state.run.id, { providerSessionId: event.payload.sessionId });
        // A recovered run keeps its immutable provider, while the conversation
        // may have since switched providers. Preserve the run-local session but
        // never replace another provider's conversation-level resume token.
        const currentConversation = database.getConversation(state.conversation.id);
        if (currentConversation?.provider === state.run.provider) {
          database.updateConversation(state.conversation.id, { providerSessionId: event.payload.sessionId });
        }
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
      if (event.type === "usage") database.updateRun(state.run.id, event.payload);
      const emittedPayload = ["assistant.delta", "assistant.message"].includes(event.type)
        ? { ...event.payload, text: truncateUtf8(event.payload.text ?? "", MAX_ASSISTANT_EVENT_BYTES), truncated: Buffer.byteLength(event.payload.text ?? "") > MAX_ASSISTANT_EVENT_BYTES }
        : event.payload;
      if (checkpointDelta !== null && scheduleAssistantCheckpoint(state, checkpointDelta)) {
        emitAssistantDeltaWithCheckpoint(state, emittedPayload);
        continue;
      }
      const emitted = emit(state.run.id, event.type, emittedPayload);
      if (event.type === "assistant.delta") state.lastAssistantDeltaSeq = emitted.seq;
    }
  }

  function finish(state, exitCode, error) {
    if (!active.has(state.run.id) || state.finishing) return;
    state.finishing = true;
    clearCheckpointTimer(state);
    // The wrapper removes its own handshake record, but a hard kill (stop
    // timeout) can bypass it; never leave a stale record behind.
    try { if (state.launchHandshakePath) unlinkSync(state.launchHandshakePath); } catch { /* Already gone. */ }
    const successful = exitCode === 0 && !error && !state.stopped;
    const status = state.stopped ? "stopped" : successful ? "completed" : "failed";
    const message = error?.message || (!successful ? state.stderr.trim() || `Agent exited with code ${exitCode}` : "");
    const finishedAt = new Date().toISOString();
    const transcriptMessage = pendingAssistantMessage(state);
    // The last transcript checkpoint and terminal run state commit together.
    // A crash can therefore leave the run recoverable, but never terminal with
    // its final assistant segment missing.
    const finished = database.finishRun(state.run.id, { status, finishedAt, exitCode, error: message || null, pid: null }, transcriptMessage);
    if (finished.message) publish({ type: "message.created", conversationId: state.conversation.id, payload: finished.message });
    active.delete(state.run.id);
    clearAssistant(state);
    database.audit(`agent.run.${status}`, { target: state.run.id, exitCode, error: message || undefined });
    emit(state.run.id, `run.${status}`, { exitCode, error: message || null, finishedAt });
    drain();
  }

  async function stop(runId) {
    const state = active.get(runId);
    if (!state) {
      const index = queue.findIndex((entry) => entry.run.id === runId);
      if (index < 0) return false;
      queue.splice(index, 1);
      database.updateRun(runId, { status: "stopped", finishedAt: new Date().toISOString() });
      emit(runId, "run.stopped", { queued: true });
      return true;
    }
    if (state.stopping) return state.stopping;
    state.stopped = true;
    // Keep the capacity reservation until both validation and tree shutdown end.
    if (state.child) terminateTree(state.child, "SIGTERM");
    // Cancellation must not wait for an acknowledgement that may never arrive.
    // stdin ordering guarantees a post-authorization stop follows "go", while
    // an unauthorized owner treats stop/end as abandonment.
    if (state.child && state.ownsDescendants) requestWrapperTeardown(state);
    state.stopping = (async () => {
      if (state.child) {
        const started = Date.now();
        // Do not depend on the first process-group SIGTERM winning the spawn /
        // setsid race. The supervisor command is the authoritative teardown
        // request and is safe when cancellation kept it unauthorized. Generic
        // wrappers retain the configured graceful window below.
        let teardownRequested = Boolean(state.ownsDescendants);
        let escalated = false;
        let groupEscalated = false;
        while (state.ownsDescendants
          ? !state.closed || Boolean(state.launchHandshakePath && existsSync(state.launchHandshakePath))
          : !state.closed || processGroupAlive(state.child)) {
          const elapsed = Date.now() - started;
          if (!teardownRequested && elapsed >= terminationGraceMs) {
            // The platform supervisor owns teardown. Linux adopts escaped
            // descendants as a subreaper and does not remove its handshake
            // until the whole tree is gone; the non-Linux wrapper uses its
            // ordered descendant/provider fallback.
            requestWrapperTeardown(state);
            teardownRequested = true;
          } else if (!state.ownsDescendants && teardownRequested && !escalated && elapsed >= terminationGraceMs + escalationGraceMs) {
            // The wrapper never managed (or was never the launch wrapper):
            // fall back to killing the provider alone, so the wrapper — if
            // alive — still reaps it.
            escalateTree(state.child, state.launchHandshakePath);
            escalated = true;
          } else if (!state.ownsDescendants && escalated && !groupEscalated && elapsed >= terminationGraceMs + 2 * escalationGraceMs) {
            // Last resort: the wrapper had its chance to reap; anything still
            // executing in the group is killed outright. Liveness below
            // recognizes the resulting non-executing zombie members as gone.
            terminateTree(state.child, "SIGKILL");
            groupEscalated = true;
          }
          if (elapsed >= terminationTimeoutMs) {
            // A native supervisor is the only process that can adopt and reap
            // escaped descendants. If it hangs or is hard-killed, falling back
            // to a group kill would orphan zombies to PID 1 and recreate the
            // leak this ownership boundary prevents. Fail closed, retain the
            // durable handshake, and never claim the tree stopped.
            state.stopping = null;
            throw new Error(`Agent process tree did not terminate: ${runId}`);
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      finish(state, state.exitCode ?? null, null);
      return true;
    })();
    return state.stopping;
  }

  // Asks the launch wrapper to tear its provider tree down in reaping order
  // and retain ownership until cleanup is proven. Writing to a non-wrapper
  // child (an injected spawnProcess) is harmless — the command is ignored and
  // the escalation fallbacks in stop() still apply.
  function requestWrapperTeardown(state) {
    try { state.child?.stdin?.write?.("stop\n"); } catch { /* The wrapper already exited. */ }
  }


  function drain() {
    if (shuttingDown) return;
    const max = database.getSettings().maxConcurrentRuns;
    while (active.size < max && queue.length) {
      const index = queue.findIndex((entry) => ![...active.values()].some((state) => {
        const activeWorktree = state.run.worktreePath ?? state.conversation.worktreePath;
        const queuedWorktree = entry.run.worktreePath ?? entry.conversation.worktreePath;
        return state.conversation.id === entry.run.conversationId
          || (activeWorktree && queuedWorktree && activeWorktree === queuedWorktree);
      }));
      if (index < 0) return;
      const entry = queue.splice(index, 1)[0];
      const state = { ...entry, assistantSegments: [], assistantBytes: 0, assistantTruncated: false, assistantMessageId: null, assistantCreatedAt: null, transcriptSeq: 0, stderr: "", stopped: false, checkpointPendingBytes: 0, lastCheckpointAt: 0, checkpointTimer: null, checkpointHalted: false };
      active.set(entry.run.id, state);
      state.launch = entry.launch = (async () => {
        try {
          const fresh = database.getConversation(entry.run.conversationId);
          if (!fresh) throw new Error("Conversation no longer exists");
          if (entry.run.worktreePath && fresh.worktreePath !== entry.run.worktreePath) {
            throw new Error("Conversation target changed after this run was queued; submit again");
          }
          const authorize = await validateConversation(fresh);
          if (state.stopped || shuttingDown) return;
          const current = database.getConversation(fresh.id);
          if (!current || ["projectId", "worktreeId", "worktreePath"].some((key) => current[key] !== fresh[key])
            || (entry.run.worktreePath && current.worktreePath !== entry.run.worktreePath)) {
            throw new Error("Conversation target changed while preparing the run; submit again");
          }
          // Recheck mutable trust synchronously immediately before spawning.
          authorize?.();
          // A recovery retry explicitly asks for a new provider session even
          // when the conversation still advertises the interrupted one.
          state.conversation = entry.providerSessionId !== undefined
            ? { ...current, providerSessionId: entry.providerSessionId }
            : entry.forceFreshSession ? { ...current, providerSessionId: null } : current;
          await start(state);
        } catch (error) {
          if (!state.stopped && !error?.preserveActiveRun) finish(state, null, error);
        }
      })();
    }
  }

  // Persists one completed ordered transcript item immediately. Assistant
  // streams use a stable checkpoint id below so repeated delta writes update
  // one message rather than duplicating partial content.
  function persistTranscriptItem(state, item) {
    state.transcriptSeq = (state.transcriptSeq ?? 0) + 1;
    const payload = item.kind === "text"
      ? { runId: state.run.id, provider: state.run.provider, truncated: Boolean(item.payload?.truncated) }
      : { runId: state.run.id, item: item.payload?.item ?? null };
    const message = database.addMessage({ id: `${state.run.id}:${state.transcriptSeq}`, conversationId: state.conversation.id, role: "assistant", kind: item.kind, body: item.body, payload });
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
    const message = pendingAssistantMessage(state);
    if (!message) return null;
    // The capped body plus truncation marker is now durable; discarded deltas
    // beyond the cap must not schedule further rewrites of the same body.
    if (state.assistantTruncated) state.checkpointHalted = true;
    const stored = database.upsertMessage(message);
    if (publishEvent) publish({ type: "message.created", conversationId: state.conversation.id, payload: stored });
    return stored;
  }

  function emitAssistantDeltaWithCheckpoint(state, payload) {
    clearCheckpointTimer(state);
    state.checkpointPendingBytes = 0;
    state.lastCheckpointAt = Date.now();
    const message = pendingAssistantMessage(state);
    if (!message) return emit(state.run.id, "assistant.delta", payload);
    if (state.assistantTruncated) state.checkpointHalted = true;
    // The delta event and the transcript prefix that already contains it are
    // one SQLite commit. The message records the event cursor, so a page load
    // racing publication can discard that already-durable delta exactly once.
    const committed = database.appendRunEventWithMessage(state.run.id, "assistant.delta", payload, message);
    state.lastAssistantDeltaSeq = committed.event.seq;
    publish({ type: "run.event", conversationId: state.conversation.id, runId: state.run.id, payload: committed.event });
    return committed.event;
  }

  function emit(runId, type, payload) {
    const event = database.appendRunEvent(runId, type, payload);
    const run = database.getRun(runId);
    publish({ type: "run.event", conversationId: run?.conversationId, runId, payload: event });
    return event;
  }

  return {
    providers,
    schedule,
    stop,
    activeRuns: () => [...active.keys()],
    shutdown() {
      if (shutdownPromise) return shutdownPromise;
      shuttingDown = true;
      const ids = [...queue.map((entry) => entry.run.id), ...active.keys()];
      shutdownPromise = Promise.all(ids.map(stop));
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

export function buildProviderCommand(conversation, run) {
  if (run.provider === "claude") {
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-prompts", "none"];
    const mode = { "read-only": "plan", "workspace-write": "acceptEdits", "danger-full-access": "bypassPermissions" }[run.approvalPolicy] ?? "acceptEdits";
    args.push("--permission-mode", mode);
    if (run.model) args.push("--model", run.model);
    if (validReasoningEffort(run.reasoningEffort)) args.push("--effort", run.reasoningEffort);
    if (conversation.providerSessionId) args.push("--resume", conversation.providerSessionId);
    args.push(run.prompt);
    return { executable: "claude", args, display: ["claude", "-p", "…", "--permission-mode", mode].join(" ") };
  }

  if (conversation.providerSessionId) {
    const args = ["exec", "resume", "--json"];
    if (run.model) args.push("--model", run.model);
    if (validReasoningEffort(run.reasoningEffort)) args.push("-c", `model_reasoning_effort=${JSON.stringify(run.reasoningEffort)}`);
    if (run.approvalPolicy === "danger-full-access") args.push("--dangerously-bypass-approvals-and-sandbox");
    else args.push("-c", `sandbox_mode=${JSON.stringify(validSandbox(run.approvalPolicy))}`);
    args.push(conversation.providerSessionId, run.prompt);
    return { executable: "codex", args, display: "codex exec resume --json …" };
  }
  const sandbox = ["read-only", "workspace-write", "danger-full-access"].includes(run.approvalPolicy) ? run.approvalPolicy : "workspace-write";
  const args = ["exec", "--json", "-C", conversation.worktreePath, "--sandbox", sandbox];
  if (run.model) args.push("--model", run.model);
  if (validReasoningEffort(run.reasoningEffort)) args.push("-c", `model_reasoning_effort=${JSON.stringify(run.reasoningEffort)}`);
  args.push(run.prompt);
  return { executable: "codex", args, display: `codex exec --json --sandbox ${sandbox} …` };
}

export function normalizeCodex(raw) {
  const events = [];
  if (raw.type === "thread.started" && raw.thread_id) events.push({ type: "session", payload: { sessionId: raw.thread_id } });
  if (raw.type === "item.started") events.push({ type: "tool.started", payload: { item: raw.item } });
  if (raw.type === "item.completed") {
    const item = raw.item ?? {};
    if (item.type === "agent_message" && item.text) events.push({ type: "assistant.message", payload: { text: item.text } });
    else events.push({ type: "tool.completed", payload: { item } });
  }
  if (raw.type === "turn.completed" && raw.usage) events.push({ type: "usage", payload: { inputTokens: raw.usage.input_tokens, outputTokens: raw.usage.output_tokens } });
  if (!events.length) events.push({ type: "provider.event", payload: raw });
  return events;
}

export function normalizeClaude(raw) {
  const events = [];
  if (raw.type === "system" && raw.subtype === "init" && raw.session_id) events.push({ type: "session", payload: { sessionId: raw.session_id } });
  const delta = raw.event?.delta;
  if (raw.type === "stream_event" && delta?.type === "text_delta") events.push({ type: "assistant.delta", payload: { text: delta.text } });
  if (raw.type === "assistant") {
    for (const block of raw.message?.content ?? []) {
      if (block.type === "tool_use") events.push({ type: "tool.started", payload: { item: block } });
    }
  }
  if (raw.type === "user") {
    for (const block of raw.message?.content ?? []) {
      if (block.type === "tool_result") events.push({ type: "tool.completed", payload: { item: block } });
    }
  }
  if (raw.type === "result") {
    if (raw.result && !events.some((event) => event.type === "assistant.delta")) events.push({ type: "assistant.message", payload: { text: raw.result } });
    events.push({ type: "usage", payload: { costUsd: raw.total_cost_usd, inputTokens: raw.usage?.input_tokens, outputTokens: raw.usage?.output_tokens } });
  }
  if (!events.length && raw.type !== "stream_event") events.push({ type: "provider.event", payload: raw });
  return events;
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

function detectProvider(id, label, versionArgs, models) {
  const result = spawnSync(id, versionArgs, { encoding: "utf8", timeout: 2500 });
  return { id, label, available: result.status === 0, version: (result.stdout || result.stderr || "").trim(), models };
}

function sanitizedEnvironment(environment) {
  const blocked = /^(OUTRIGHT_|VITE_|npm_|NODE_OPTIONS$)/i;
  return Object.fromEntries(Object.entries(environment).filter(([key, value]) => value != null && !blocked.test(key)));
}

function validReasoningEffort(value) {
  return ["low", "medium", "high", "xhigh"].includes(value);
}

function validSandbox(value) {
  return ["read-only", "workspace-write"].includes(value) ? value : "workspace-write";
}
