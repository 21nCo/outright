import { spawn, spawnSync } from "node:child_process";

const MAX_PROVIDER_LINE_BYTES = 1024 * 1024;
const MAX_ASSISTANT_BYTES = 1024 * 1024;
const MAX_PROCESS_EVENT_BYTES = 64 * 1024;
const MAX_ASSISTANT_EVENT_BYTES = 255 * 1024;
const ASSISTANT_TRUNCATION_MARKER = "\n\n[Output truncated by Outright at 1 MiB]";

export function createAgentManager({ database, publish, spawnProcess = spawn, validateConversation = async () => {}, terminationGraceMs = 3500, terminationTimeoutMs = 8000 }) {
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

  async function schedule({ conversation, run }) {
    if (shuttingDown) throw new Error("Agent manager is shutting down");
    const entry = { conversation, run };
    queue.push(entry);
    emit(run.id, "run.queued", { position: queue.length });
    drain();
    if (entry.launch) await entry.launch;
    return database.getRun(run.id);
  }

  function start(state) {
    const { conversation, run } = state;
    const command = buildProviderCommand(conversation, run);
    const startedAt = new Date().toISOString();
    database.updateRun(run.id, { status: "running", startedAt });
    database.audit("agent.run.started", { target: run.id, provider: run.provider, conversationId: conversation.id, worktreePath: conversation.worktreePath, approvalPolicy: run.approvalPolicy });
    emit(run.id, "run.started", { provider: run.provider, model: run.model, startedAt, command: command.display });

    const child = spawnProcess(command.executable, command.args, {
      cwd: conversation.worktreePath,
      env: sanitizedEnvironment(process.env),
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group on POSIX so descendants can be terminated together.
      detached: process.platform !== "win32",
    });
    state.child = child;

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
      if (event.type === "assistant.delta") appendAssistantText(state, event.payload.text, emit);
      if (event.type === "assistant.message") {
        const text = event.payload.text ?? "";
        if (!state.assistantText || !text.startsWith(state.assistantText)) {
          // A completed message that does not extend the accumulated deltas
          // starts a new segment; archive the prior one first.
          archiveAssistant(state);
          replaceAssistantText(state, text, emit);
        }
        // Completed segments are archived at completion time so interleaved
        // tool events keep their arrival order in the saved transcript.
        archiveAssistant(state);
      }
      if (["tool.started", "tool.completed"].includes(event.type)) {
        state.transcript.push({ kind: "tool", body: toolTranscriptLabel(event), payload: { item: event.payload.item ?? null } });
      }
      if (event.type === "usage") database.updateRun(state.run.id, event.payload);
      const emittedPayload = ["assistant.delta", "assistant.message"].includes(event.type)
        ? { ...event.payload, text: truncateUtf8(event.payload.text ?? "", MAX_ASSISTANT_EVENT_BYTES), truncated: Buffer.byteLength(event.payload.text ?? "") > MAX_ASSISTANT_EVENT_BYTES }
        : event.payload;
      emit(state.run.id, event.type, emittedPayload);
    }
  }

  function finish(state, exitCode, error) {
    if (!active.has(state.run.id)) return;
    active.delete(state.run.id);
    const successful = exitCode === 0 && !error && !state.stopped;
    const status = state.stopped ? "stopped" : successful ? "completed" : "failed";
    const message = error?.message || (!successful ? state.stderr.trim() || `Agent exited with code ${exitCode}` : "");
    const finishedAt = new Date().toISOString();
    database.updateRun(state.run.id, { status, finishedAt, exitCode, error: message || null });
    // Persist every ordered transcript segment rather than one accumulated string.
    archiveAssistant(state);
    for (const item of state.transcript) {
      const payload = item.kind === "text"
        ? { runId: state.run.id, provider: state.run.provider, truncated: Boolean(item.payload?.truncated) }
        : { runId: state.run.id, item: item.payload?.item ?? null };
      persistTranscriptMessage(state, item, payload);
    }
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
      const state = { ...entry, assistantText: "", assistantTruncated: false, transcript: [], stderr: "", stopped: false };
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
          state.conversation = current;
          start(state);
        } catch (error) {
          if (!state.stopped) finish(state, null, error);
        }
      })();
    }
  }

  function persistTranscriptMessage(state, item, payload) {
    const message = database.addMessage({ conversationId: state.conversation.id, role: "assistant", kind: item.kind, body: item.body, payload });
    publish({ type: "message.created", conversationId: state.conversation.id, payload: message });
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

function appendAssistantText(state, text, emit) {
  if (state.assistantTruncated) return;
  const next = boundUtf8(`${state.assistantText}${text ?? ""}`, MAX_ASSISTANT_BYTES);
  state.assistantText = next.text;
  markAssistantTruncated(state, next.truncated, emit);
}

function replaceAssistantText(state, text, emit) {
  const next = boundUtf8(text ?? "", MAX_ASSISTANT_BYTES);
  state.assistantText = next.text;
  markAssistantTruncated(state, next.truncated, emit);
}

function archiveAssistant(state) {
  const body = state.assistantText.trim();
  if (body) state.transcript.push({ kind: "text", body: `${body}${state.assistantTruncated ? ASSISTANT_TRUNCATION_MARKER : ""}`, payload: { truncated: state.assistantTruncated } });
  state.assistantText = "";
  state.assistantTruncated = false;
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
