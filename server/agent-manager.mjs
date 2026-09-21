import { spawn, spawnSync } from "node:child_process";
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
const LINUX_AGENT_SUPERVISOR = process.env.OUTRIGHT_AGENT_SUPERVISOR_PATH
  || fileURLToPath(new URL("./bin/agent-supervisor", import.meta.url));

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
const [handshakePath, executable, ...commandArgs] = process.argv.slice(1);
fs.mkdirSync(path.dirname(handshakePath), { recursive: true });
// Durable process identity BEFORE anything can execute: if the runtime dies
// before recording this pid, the handshake file restores ownership after
// restart.
fs.writeFileSync(handshakePath, JSON.stringify({ pid: process.pid, authorized: false, createdAt: new Date().toISOString() }));
let authorized = false;
let provider = null;
let providerGone = false;
let teardownStarted = false;
// Stay alive across group termination signals once authorized so this
// wrapper — the provider's parent — can reap it. On hosts whose PID 1 does
// not reap orphans, a killed-but-unreaped provider would remain a zombie in
// its process group and keep every liveness probe reporting alive. An
// unauthorized wrapper must still die on the first signal: it never started
// the provider, so nothing needs reaping.
const abandon = () => { try { fs.unlinkSync(handshakePath); } catch {} process.exit(0); };
process.on("SIGTERM", () => { if (!authorized) abandon(); });
process.on("SIGINT", () => { if (!authorized) abandon(); });
// Enumerates the members of this wrapper's process group from /proc, or
// returns null when /proc is unavailable (non-Linux hosts); teardown then
// degrades to killing the provider alone.
const groupMembers = (pgid) => {
  let entries;
  try { entries = fs.readdirSync("/proc"); } catch { return null; }
  const members = [];
  for (const entry of entries) {
    if (!/^\\d+$/.test(entry)) continue;
    let stat;
    try { stat = fs.readFileSync(\`/proc/\${entry}/stat\`, "utf8"); } catch { continue; }
    const close = stat.lastIndexOf(")");
    if (close < 0) continue;
    const fields = stat.slice(close + 2).split(" ");
    if (Number(fields[2]) === pgid) members.push({ pid: Number(entry), state: fields[0] });
  }
  return members;
};
// Ordered teardown (runtime "stop" command). The provider's descendants are
// SIGKILLed FIRST, while their parent — the provider — is still alive to reap
// them; only once the group holds no other member is the provider itself
// killed, and this wrapper — its parent — reaps it. Any other order leaks:
// killing the provider first orphans its descendants, and on a host whose
// PID 1 does not reap they linger forever as unreaped zombies holding the
// process group, accumulating one process-table entry per stop. The sweep is
// bounded: if a member never disappears, the provider is killed anyway and
// the runtime's group-wide fallback applies.
const teardownBudgetMs = 750;
const teardown = () => {
  if (teardownStarted || !provider || providerGone) return;
  teardownStarted = true;
  const deadline = Date.now() + teardownBudgetMs;
  const killProvider = () => { if (!providerGone) { try { process.kill(provider.pid, "SIGKILL"); } catch { /* Already gone. */ } } };
  const sweep = () => {
    if (providerGone) return;
    const members = groupMembers(process.pid);
    if (members == null) { killProvider(); return; }
    const outstanding = members.filter((member) => member.pid !== process.pid && member.pid !== provider.pid);
    if (outstanding.length === 0 || Date.now() >= deadline) { killProvider(); return; }
    for (const member of outstanding) {
      // A zombie is already dead; its parent simply has not reaped it yet.
      if (member.state === "Z") continue;
      try { process.kill(member.pid, "SIGKILL"); } catch { /* Already gone. */ }
    }
    setTimeout(sweep, 50);
  };
  sweep();
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
      const { spawn } = require("node:child_process");
      provider = spawn(executable, commandArgs, { stdio: ["ignore", "inherit", "inherit"] });
      // Durable provider identity: escalation targets the provider alone so this
      // wrapper — the provider's parent — survives to reap it. Without this, a
      // group-wide SIGKILL kills the wrapper first and a killed-but-unreaped
      // provider lingers as a zombie in its process group on hosts whose PID 1
      // does not reap orphans.
      try { fs.writeFileSync(handshakePath, JSON.stringify({ pid: process.pid, authorized: true, providerPid: provider.pid, createdAt: new Date().toISOString() })); } catch { /* The record was swept; nothing needs escalation identity. */ }
      const finish = (code) => { try { fs.unlinkSync(handshakePath); } catch {} process.exit(code); };
      provider.on("error", (error) => { console.error(String((error && error.message) || error)); finish(127); });
      provider.on("close", (code, signal) => {
        providerGone = true;
        try { fs.unlinkSync(handshakePath); } catch {}
        if (signal) {
          // Re-raise the provider's termination signal so the runtime reports
          // the accurate "stopped by signal" cause instead of a generic 137 —
          // except SIGUSR1, which Node reserves for its debugger: re-raising it
          // would start the inspector instead of terminating this wrapper.
          process.removeAllListeners("SIGTERM");
          process.removeAllListeners("SIGINT");
          if (signal === "SIGUSR1") process.exit(137);
          try { process.kill(process.pid, signal); }
          catch { process.exit(137); }
        } else process.exit(code ?? 0);
      });
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
    if (!existsSync(LINUX_AGENT_SUPERVISOR)) {
      throw new Error("Linux agent supervision is unavailable; install a C compiler and run npm run build:supervisor");
    }
    return {
      executable: LINUX_AGENT_SUPERVISOR,
      args: [handshakePath, command.executable, ...command.args],
      display: command.display,
      handshakePath,
      ownsDescendants: true,
    };
  }
  return {
    executable: process.execPath,
    args: ["-e", LAUNCH_WRAPPER_SOURCE, handshakePath, command.executable, ...command.args],
    display: command.display,
    handshakePath,
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
      stdio: ["pipe", "pipe", "pipe"],
      // Own process group on POSIX so descendants can be terminated together.
      detached: process.platform !== "win32",
    });
    state.child = child;
    state.launchHandshakePath = launch.handshakePath;
    state.ownsDescendants = Boolean(launch.ownsDescendants);
    let resolveChildClosed;
    const childClosed = new Promise((resolve) => { resolveChildClosed = resolve; });
    consumeBoundedLines(child.stdout, {
      maxLineBytes: MAX_PROVIDER_LINE_BYTES,
      onLine: (line) => handleProviderLine(state, line),
      onOverflow: () => emit(run.id, "process.output_truncated", { stream: "stdout", maxBytes: MAX_PROVIDER_LINE_BYTES }),
    });
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
      if (event.type === "session") {
        state.run.providerSessionId = event.payload.sessionId;
        database.updateRun(state.run.id, { providerSessionId: event.payload.sessionId });
        database.updateConversation(state.conversation.id, { providerSessionId: event.payload.sessionId });
      }
      if (event.type === "assistant.delta") {
        appendAssistantText(state, event.payload.text, emit);
        scheduleAssistantCheckpoint(state, event.payload.text);
      }
      if (event.type === "assistant.message") {
        const text = event.payload.text ?? "";
        if (state.assistantBytes && !text.startsWith(assistantBody(state))) {
          // A completed message that does not extend the accumulated deltas
          // starts a new segment; archive the prior one first.
          archiveAssistant(state, persistAssistantCheckpoint);
        }
        replaceAssistantText(state, text, emit);
        archiveAssistant(state, persistAssistantCheckpoint);
      }
      if (["tool.started", "tool.completed"].includes(event.type)) {
        archiveAssistant(state, persistAssistantCheckpoint);
        persistTranscriptItem(state, { kind: "tool", body: toolTranscriptLabel(event), payload: { item: event.payload.item ?? null } });
      }
      if (event.type === "usage") database.updateRun(state.run.id, event.payload);
      const emittedPayload = ["assistant.delta", "assistant.message"].includes(event.type)
        ? { ...event.payload, text: truncateUtf8(event.payload.text ?? "", MAX_ASSISTANT_EVENT_BYTES), truncated: Buffer.byteLength(event.payload.text ?? "") > MAX_ASSISTANT_EVENT_BYTES }
        : event.payload;
      emit(state.run.id, event.type, emittedPayload);
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
    state.stopping = (async () => {
      await state.launch;
      if (state.child) {
        const started = Date.now();
        let teardownRequested = false;
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
      const index = queue.findIndex((entry) => ![...active.values()].some((state) => state.conversation.id === entry.run.conversationId));
      if (index < 0) return;
      const entry = queue.splice(index, 1)[0];
      const state = { ...entry, assistantSegments: [], assistantBytes: 0, assistantTruncated: false, assistantMessageId: null, assistantCreatedAt: null, transcriptSeq: 0, stderr: "", stopped: false, checkpointPendingBytes: 0, lastCheckpointAt: 0, checkpointTimer: null, checkpointHalted: false };
      active.set(entry.run.id, state);
      state.launch = entry.launch = (async () => {
        try {
          const fresh = database.getConversation(entry.run.conversationId);
          if (!fresh) throw new Error("Conversation no longer exists");
          const authorize = await validateConversation(fresh);
          if (state.stopped || shuttingDown) return;
          const current = database.getConversation(fresh.id);
          if (!current || ["projectId", "worktreeId", "worktreePath"].some((key) => current[key] !== fresh[key])) {
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
    if (state.checkpointHalted) return;
    if (!state.assistantBytes) return;
    state.checkpointPendingBytes = (state.checkpointPendingBytes ?? 0) + Buffer.byteLength(deltaText ?? "");
    if (state.assistantTruncated || state.checkpointPendingBytes >= checkpointMinBytes || Date.now() - (state.lastCheckpointAt ?? 0) >= checkpointIntervalMs) {
      persistAssistantCheckpoint(state);
      return;
    }
    armCheckpointTimer(state);
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

  function persistAssistantCheckpoint(state) {
    clearCheckpointTimer(state);
    state.checkpointPendingBytes = 0;
    state.lastCheckpointAt = Date.now();
    const message = pendingAssistantMessage(state);
    if (!message) return null;
    // The capped body plus truncation marker is now durable; discarded deltas
    // beyond the cap must not schedule further rewrites of the same body.
    if (state.assistantTruncated) state.checkpointHalted = true;
    const stored = database.upsertMessage(message);
    publish({ type: "message.created", conversationId: state.conversation.id, payload: stored });
    return stored;
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
// whenever its pid is durably known (the launch wrapper records it), so the
// wrapper — the provider's parent — survives to reap it. A group-wide
// SIGKILL would kill the wrapper first and leave a killed-but-unreaped
// provider as a zombie in its process group on hosts whose PID 1 does not
// reap orphans, which would keep every liveness probe reporting alive until
// the termination timeout. Without a usable provider pid (an injected child
// spawned outside the launch wrapper, or an unreadable record) the whole
// owned group is killed as before.
export function escalateTree(child, handshakePath, platform = process.platform, run = spawnSync, kill = process.kill) {
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
    // process group.
    if (record?.authorized === true && Number(record?.pid) === child.pid && Number.isSafeInteger(recorded) && recorded > 0) providerPid = recorded;
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
    payload: { runId: state.run.id, provider: state.run.provider, truncated: state.assistantTruncated },
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
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    chmodSync(directory, 0o700);
    stat = lstatSync(directory);
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("Launch directory must not grant group or other permissions");
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
