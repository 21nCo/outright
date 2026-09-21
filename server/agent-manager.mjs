import { spawn, spawnSync } from "node:child_process";
import { unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";

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
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (authorized || !String(chunk).includes("go")) return;
  authorized = true;
  const { spawn } = require("node:child_process");
  const provider = spawn(executable, commandArgs, { stdio: ["ignore", "inherit", "inherit"] });
  const finish = (code) => { try { fs.unlinkSync(handshakePath); } catch {} process.exit(code); };
  provider.on("error", (error) => { console.error(String((error && error.message) || error)); finish(127); });
  provider.on("close", (code, signal) => finish(code ?? (signal ? 137 : 0)));
});
// The runtime went away before authorizing the launch: exit without ever
// starting the provider, so an abandoned handshake can never mutate the
// worktree.
process.stdin.on("end", () => { if (!authorized) { try { fs.unlinkSync(handshakePath); } catch {} process.exit(0); } });
`;

export function defaultLaunchCommand(command, run, launchDirectory) {
  const handshakePath = path.join(launchDirectory, `${run.id}.json`);
  return {
    executable: process.execPath,
    args: ["-e", LAUNCH_WRAPPER_SOURCE, handshakePath, command.executable, ...command.args],
    display: command.display,
    handshakePath,
  };
}

export function createAgentManager({ database, publish, spawnProcess = spawn, validateConversation = async () => {}, terminationGraceMs = 3500, terminationTimeoutMs = 8000, checkpointMinBytes = CHECKPOINT_MIN_BYTES, checkpointIntervalMs = CHECKPOINT_INTERVAL_MS, launchCommand = defaultLaunchCommand, launchDirectory }) {
  const resolvedLaunchDirectory = launchDirectory
    ?? database.launchDirectory
    ?? (database.filename ? path.join(path.dirname(database.filename), "launches") : path.join(os.tmpdir(), "outright-launches"));
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

  async function schedule({ conversation, run, forceFreshSession = false }) {
    if (shuttingDown) throw new Error("Agent manager is shutting down");
    const entry = { conversation, run, forceFreshSession };
    queue.push(entry);
    emit(run.id, "run.queued", { position: queue.length });
    drain();
    if (entry.launch) await entry.launch;
    return database.getRun(run.id);
  }

  function start(state) {
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
    // Phase 2: durable process ownership BEFORE the provider is authorized.
    // If the runtime dies before this commit, the wrapper's handshake file
    // still carries the pid and the row is provably unauthorized.
    database.updateRun(run.id, { pid: child.pid ?? null, status: "running" });

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
      if (!child.pid) { state.closed = true; finish(state, null, error); }
    });
    child.on("close", (code, signal) => {
      state.closed = true;
      state.exitCode = code;
      state.processError ??= signal ? new Error(`Process stopped by ${signal}`) : null;
      if (!state.stopped) finish(state, code, state.processError);
    });
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
        let escalated = false;
        while (!state.closed || processGroupAlive(state.child)) {
          const elapsed = Date.now() - started;
          if (!escalated && elapsed >= terminationGraceMs) {
            terminateTree(state.child, "SIGKILL");
            escalated = true;
          }
          if (elapsed >= terminationTimeoutMs) {
            // Preserve ownership and report failure; never claim a live tree stopped.
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
          state.conversation = entry.forceFreshSession ? { ...current, providerSessionId: null } : current;
          start(state);
        } catch (error) {
          if (!state.stopped) finish(state, null, error);
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
    return database.upsertMessage(message);
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

function terminateTree(child, signal) {
  try {
    // Descendants spawned by the provider share its process group on POSIX,
    // so signaling the group terminates the whole tree, not just the PID.
    // On Windows the tree is not owned; only the leader can be signaled, so
    // restart recovery must never trust a gone Windows leader (see
    // defaultProbeRun/defaultRecoveryProcessAlive conservative handling).
    if (child?.pid && process.platform !== "win32") process.kill(-child.pid, signal);
    else child?.kill?.(signal);
  } catch { /* The process group already exited. */ }
}

function processGroupAlive(child) {
  if (!child?.pid) return false;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, 0);
    else process.kill(child.pid, 0);
    return true;
  } catch (error) { return error.code !== "ESRCH"; }
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
  // newline from the preserved output. Only a genuinely empty body suppresses
  // the message.
  const body = assistantBody(state);
  if (!body) return null;
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
