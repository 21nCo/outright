import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, stat } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

// Repository setup and teardown for worktrees. A repository describes its
// commands in one JSON file at the worktree root; nothing in it runs until
// the user trusts the exact bytes for that project. Each step runs as a
// utility process, so the native owner terminates its whole descendant tree
// on cancel, timeout or shutdown, and only the newest output is retained.
// Steps draw on their own process budget, so long setups never take the
// capacity Git, project scans and removal need.
export const LIFECYCLE_CONFIG_FILE = "outright.worktree.json";
export const LIFECYCLE_LIMITS = Object.freeze({
  configBytes: 64 * 1024,
  steps: 16,
  nameCharacters: 80,
  arguments: 64,
  argumentBytes: 4096,
  defaultTimeoutSeconds: 600,
  maxTimeoutSeconds: 3600,
  // Output kept in memory for the live view, and with a state that needs
  // attention (failed, cancelled, interrupted).
  outputCharacters: 32 * 1024,
  // One output event carries at most this much; a client that misses part
  // of the stream reloads the retained tail.
  outputEventCharacters: 16 * 1024,
  outputEventIntervalMs: 200,
  // Finished runs whose live output stays in memory.
  retainedLogs: 32,
  states: 512,
  // Waits before each attempt to save a run's outcome.
  persistRetryDelaysMs: Object.freeze([0, 250, 1000]),
});
const PHASES = new Set(["setup", "teardown"]);
const STATUSES = new Set(["needs-trust", "invalid", "running", "ready", "complete", "failed", "cancelled", "interrupted"]);
// States the user must act on keep their output.
const RESUMABLE = new Set(["failed", "cancelled", "interrupted"]);
const CONFIG_KEYS = new Set(["version", "setup", "teardown"]);
const STEP_KEYS = new Set(["name", "command", "timeoutSeconds"]);
const ESCAPE_SEQUENCE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g;
const COMPLETE_ESCAPE = /^\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
// Characters that render invisibly or reorder the text around them (bidi
// controls, zero-width and other format characters, line separators, and
// spaces that look like an argument break). A reviewed command must look
// exactly like the one that runs, so the configuration may not contain them.
const DECEPTIVE_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}]|(?! )\p{Zs}/u;
const DECEPTIVE_ARGUMENT_CHARACTER = /(?![\t\n])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}]|(?! )\p{Zs}/u;

function configError(message) {
  return Object.assign(new Error(message), { lifecycleConfig: true });
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseStep(value, phase, index) {
  const label = `${phase}[${index}]`;
  if (!plainObject(value)) throw configError(`${label} must be an object`);
  const unknown = Object.keys(value).find((key) => !STEP_KEYS.has(key));
  if (unknown) throw configError(`${label} has an unknown field "${unknown}"`);
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name || name.length > LIFECYCLE_LIMITS.nameCharacters || !name.isWellFormed() || DECEPTIVE_CHARACTER.test(name)) {
    throw configError(`${label}.name must be 1 to ${LIFECYCLE_LIMITS.nameCharacters} printable characters`);
  }
  const { command } = value;
  if (!Array.isArray(command) || !command.length || command.length > LIFECYCLE_LIMITS.arguments
    || command.some((argument) => typeof argument !== "string" || argument.includes("\0")
      || Buffer.byteLength(argument) > LIFECYCLE_LIMITS.argumentBytes) || !command[0].trim()) {
    throw configError(`${label}.command must be an array of 1 to ${LIFECYCLE_LIMITS.arguments} strings, starting with a program`);
  }
  const hidden = command.findIndex((argument) => !argument.isWellFormed() || DECEPTIVE_ARGUMENT_CHARACTER.test(argument));
  if (hidden >= 0) {
    throw configError(`${label}.command[${hidden}] contains an invisible, reordering or control character, so it would not look like what runs`);
  }
  const timeoutSeconds = value.timeoutSeconds ?? LIFECYCLE_LIMITS.defaultTimeoutSeconds;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > LIFECYCLE_LIMITS.maxTimeoutSeconds) {
    throw configError(`${label}.timeoutSeconds must be a whole number from 1 to ${LIFECYCLE_LIMITS.maxTimeoutSeconds}`);
  }
  return { name, command: [...command], timeoutSeconds };
}

function parseSteps(value, phase) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > LIFECYCLE_LIMITS.steps) {
    throw configError(`${phase} must be an array of at most ${LIFECYCLE_LIMITS.steps} steps`);
  }
  return value.map((step, index) => parseStep(step, phase, index));
}

// Strict: an unknown field is an error rather than ignored, so a reviewed
// configuration means exactly what the user saw.
export function parseLifecycleConfig(text) {
  let value;
  try { value = JSON.parse(text); }
  catch { throw configError("is not valid JSON"); }
  if (!plainObject(value)) throw configError("must be a JSON object");
  const unknown = Object.keys(value).find((key) => !CONFIG_KEYS.has(key));
  if (unknown) throw configError(`has an unknown field "${unknown}"`);
  if (value.version !== 1) throw configError("must declare \"version\": 1");
  return { version: 1, setup: parseSteps(value.setup, "setup"), teardown: parseSteps(value.teardown, "teardown") };
}

// Returns null when the worktree has no configuration, or the parsed
// configuration with the digest of its exact bytes. An unusable file is
// reported with `error` so the user can see why nothing runs.
export async function readLifecycleConfig(worktreePath) {
  const file = path.join(worktreePath, LIFECYCLE_CONFIG_FILE);
  let info;
  try { info = await lstat(file); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!info.isFile()) return { digest: null, error: "must be a regular file, not a link or directory" };
  let handle;
  try { handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    if (["ELOOP", "EISDIR", "EMLINK"].includes(error.code)) return { digest: null, error: "must be a regular file, not a link or directory" };
    throw error;
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) return { digest: null, error: "must be a regular file, not a link or directory" };
    const buffer = Buffer.alloc(LIFECYCLE_LIMITS.configBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > LIFECYCLE_LIMITS.configBytes) return { digest: null, error: `is larger than ${LIFECYCLE_LIMITS.configBytes / 1024} KiB` };
    const bytes = buffer.subarray(0, bytesRead);
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { return { digest, error: "is not valid UTF-8" }; }
    try { return { digest, ...parseLifecycleConfig(text) }; }
    catch (error) {
      if (!error.lifecycleConfig) throw error;
      return { digest, error: error.message };
    }
  } finally { await handle.close(); }
}

// Terminal control sequences and control characters are removed, and
// carriage returns become line breaks, so output is plain text.
export function sanitizeOutput(text) {
  return text.replace(ESCAPE_SEQUENCE, "").replaceAll("\r\n", "\n").replaceAll("\r", "\n").replace(CONTROL_CHARACTERS, "");
}

// Decodes one stream's UTF-8, holding back a sequence or line ending that a
// chunk boundary split, so neither leaks into the text half-removed.
function createOutputDecoder() {
  const decoder = new StringDecoder("utf8");
  let carry = "";
  const take = (text, final) => {
    let value = carry + text;
    carry = "";
    if (!final) {
      const escape = value.lastIndexOf("\u001b");
      if (escape >= 0 && value.length - escape < 64 && !COMPLETE_ESCAPE.test(value.slice(escape))) {
        carry = value.slice(escape);
        value = value.slice(0, escape);
      } else if (value.endsWith("\r")) {
        carry = "\r";
        value = value.slice(0, -1);
      }
    }
    return sanitizeOutput(value);
  };
  return { write: (chunk) => take(decoder.write(chunk), false), end: () => take(decoder.end(), true) };
}

function tail(text, limit) {
  if (text.length <= limit) return text;
  let start = text.length - limit;
  // Never start inside a surrogate pair.
  const code = text.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) start += 1;
  return text.slice(start);
}

export function displayCommand(command) {
  return command.map((argument) => /^[\w@%+=:,./-]+$/.test(argument) ? argument : JSON.stringify(argument)).join(" ");
}

function apiError(statusCode, message, details) {
  return Object.assign(new Error(message), { statusCode, details });
}

function storedState(value) {
  return plainObject(value) && typeof value.worktreePath === "string" && typeof value.projectId === "string"
    && PHASES.has(value.phase) && STATUSES.has(value.status);
}

function publicState(state) {
  if (!state) return null;
  const { output: _output, ...rest } = state;
  return rest;
}

// Identifies one worktree instance at a path: a worktree removed outside
// Outright and created again at the same path is a different instance, and
// none of the earlier one's progress applies to it.
export async function worktreeInstance(worktreePath) {
  try {
    const info = await stat(worktreePath, { bigint: true });
    return `${info.dev}:${info.ino}:${info.birthtimeNs}`;
  } catch { return null; }
}

// Each phase keeps its own checkpoint, `checkpoints[phase]`: the steps of
// that configuration already finished in this worktree instance. Every state
// carries both phases' checkpoints forward, so a refusal or a run of one
// phase never erases the other's. A teardown checkpoint at its last step means
// only Git removal is left.
function finishedCheckpoints(checkpoints, phase, configDigest, outcome, stepCount) {
  if (outcome.status === "ready") return {};
  if (outcome.status === "complete") return { teardown: { configDigest, stepIndex: stepCount } };
  return { ...checkpoints, [phase]: { configDigest, stepIndex: outcome.stepIndex } };
}

function stepFailure(error, step, signal, capacity) {
  const unknown = error?.code === "SUBPROCESS_OWNERSHIP_UNKNOWN";
  // Unconfirmed ownership wraps what stopped the step, such as its timeout.
  let cause = error;
  while (cause?.code === "SUBPROCESS_OWNERSHIP_UNKNOWN" && cause.cause) cause = cause.cause;
  const suffix = unknown ? " Its processes could not be confirmed stopped; Outright keeps their capacity reserved until they are." : "";
  if (signal.aborted) {
    const shutdown = signal.reason === "shutdown";
    return { status: shutdown ? "interrupted" : "cancelled", outcomeUnknown: unknown,
      error: `${shutdown ? "Outright stopped during" : "Cancelled during"} "${step.name}"; its effects may be partial.${suffix}` };
  }
  let message = `"${step.name}" could not run: ${String(cause?.message ?? cause).slice(0, 512)}`;
  if (cause?.code === "SUBPROCESS_CAPACITY") {
    message = `Setup and teardown capacity is full${capacity ? ` (${capacity.active} of ${capacity.limit} steps running or unconfirmed)` : ""}; retry when one finishes.`;
  }
  else if (cause?.killed && /timed out/i.test(cause.message ?? "")) message = `"${step.name}" timed out after ${step.timeoutSeconds} seconds.`;
  else if (Number.isInteger(cause?.code)) message = `"${step.name}" exited with status ${cause.code}.`;
  else if (cause?.signal) message = `"${step.name}" was stopped by ${cause.signal}.`;
  return { status: "failed", outcomeUnknown: unknown, error: `${message}${suffix}` };
}

// `agentWork(paths)` reports whether an agent run is queued, launching or
// running in a worktree, and `interruptedRun(paths)` an interrupted run there
// whose outcome the user has not resolved; `onRelease` is called when a
// worktree is no longer held, so runs that waited for it can launch.
export function createWorktreeLifecycle({ database, subprocesses, publish = () => {}, readConfig = readLifecycleConfig,
  identify = worktreeInstance, agentWork = () => false, interruptedRun = () => null, onRelease = () => {},
  now = () => new Date().toISOString(), limits = LIFECYCLE_LIMITS, onPersistError = () => {} }) {
  // worktree path -> latest state; path -> claim of the running operation;
  // path -> live output of the latest run.
  const states = new Map();
  const active = new Map();
  const logs = new Map();
  let stopping = false;

  function persist(state, strict = false) {
    try { database.saveWorktreeLifecycle({ ...state, output: state.output ? tail(state.output, limits.outputCharacters) : undefined }); }
    catch (error) {
      if (strict) throw error;
      // The in-memory state stays authoritative for this runtime.
      onPersistError(error);
    }
  }

  // A run's outcome is saved before it is reported: a few attempts while the
  // run still holds its worktree. When none succeeds the run is reported as
  // failed with what it reached, never as ready, and a retry in this runtime
  // records it; after a restart the durable running state is interrupted.
  async function commitOutcome(state) {
    let failure;
    for (const delay of limits.persistRetryDelaysMs ?? LIFECYCLE_LIMITS.persistRetryDelaysMs) {
      if (delay) await new Promise((resolve) => { setTimeout(resolve, delay); });
      try { return commit(state, { strict: true }); }
      catch (error) { failure = error; }
    }
    onPersistError(failure);
    const finished = state.status === "ready" || state.status === "complete";
    return commit({ ...state, status: finished ? "failed" : state.status, unsaved: true,
      checkpoints: { ...state.checkpoints, [state.phase]: { configDigest: state.configDigest, stepIndex: state.stepIndex } },
      error: `${state.error ? `${state.error} ` : ""}The ${state.phase} ${finished ? "finished" : "stopped"}, but Outright could not save that outcome (${String(failure?.message ?? failure).slice(0, 200)}). Run it again to record it.` }, { memoryOnly: true });
  }

  // A state with unconfirmed processes is never evicted: it holds its worktree.
  function remember(state) {
    states.delete(state.worktreePath);
    states.set(state.worktreePath, state);
    for (const [key, value] of states) {
      if (states.size <= limits.states) break;
      if (!active.has(key) && !value.outcomeUnknown) states.delete(key);
    }
  }

  function commit(state, { strict = false, memoryOnly = false } = {}) {
    if (!memoryOnly) persist(state, strict);
    remember(state);
    publish({ type: "worktree.lifecycle", payload: publicState(state) });
    return state;
  }

  // A run that was going when the previous runtime stopped did not finish,
  // and its processes are unconfirmed until lifecycle ownership recovery
  // proves them gone or the user acknowledges them.
  for (const stored of database.listWorktreeLifecycle?.() ?? []) {
    if (!storedState(stored)) continue;
    let state = stored;
    if (state.status === "running") {
      state = { ...state, status: "interrupted", outcomeUnknown: true, updatedAt: now(),
        checkpoints: { ...state.checkpoints, [state.phase]: { configDigest: state.configDigest, stepIndex: state.stepIndex } },
        error: `Outright stopped during step ${state.stepIndex + 1}; its effects may be partial, and its processes are not yet confirmed stopped.` };
      persist(state);
    }
    states.set(state.worktreePath, state);
  }

  function holding(worktreePath) {
    return active.get(worktreePath) ?? [...active.values()].find((entry) => entry.paths.has(worktreePath)) ?? null;
  }

  // The state whose processes are not confirmed stopped at this canonical or
  // discovered path. It belongs to the path, whatever worktree instance is
  // there now: the processes may still be running in it.
  function unconfirmed(worktreePath) {
    const state = states.get(worktreePath);
    if (state) return state.outcomeUnknown ? state : null;
    return [...states.values()].find((value) => value.outcomeUnknown && value.discoveredPath === worktreePath) ?? null;
  }

  // Why agent work may not start in a worktree now, or null.
  function hold(worktreePath) {
    if (holding(worktreePath)) return "WORKTREE_LIFECYCLE_BUSY";
    return unconfirmed(worktreePath) ? "WORKTREE_LIFECYCLE_UNCONFIRMED" : null;
  }

  // One operation per worktree, never beside agent work there. The check
  // and the claim are synchronous, as the agent manager's launch fence is,
  // so neither side can start between them.
  function claim(target, phase) {
    const { worktreePath } = target;
    if (stopping) throw apiError(503, "Runtime is shutting down");
    const paths = new Set([worktreePath, target.worktree?.path].filter(Boolean));
    const current = [...paths].map(holding).find(Boolean);
    if (current) throw apiError(409, `Worktree ${current.phase} is already running`, { code: "WORKTREE_LIFECYCLE_BUSY", phase: current.phase });
    if (agentWork([...paths])) {
      throw apiError(409, `An agent run is queued or running in this worktree; ${phase} waits until it finishes`, { code: "WORKTREE_AGENT_ACTIVE", phase });
    }
    // An interrupted run's processes are as unconfirmed as a step's.
    const interrupted = interruptedRun([...paths]);
    if (interrupted) {
      throw apiError(409, `Resolve the interrupted agent run in this worktree before its ${phase} runs`, { code: "RUN_RECOVERY_REQUIRED", runId: interrupted.id, phase });
    }
    let resolveDone;
    const entry = { phase, paths, controller: new AbortController(), done: new Promise((resolve) => { resolveDone = resolve; }) };
    entry.release = () => {
      if (active.get(worktreePath) !== entry) return;
      active.delete(worktreePath);
      resolveDone();
      releaseHold(worktreePath);
    };
    active.set(worktreePath, entry);
    return entry;
  }

  // The latest state of this worktree instance, or null when the state
  // belongs to an earlier worktree at the same path.
  function current(worktreePath, instance) {
    const state = states.get(worktreePath);
    return state && state.instance === instance ? state : null;
  }

  function openLog(worktreePath, runId) {
    const previous = logs.get(worktreePath);
    if (previous) clearTimeout(previous.timer);
    logs.delete(worktreePath);
    const log = { runId, text: "", end: 0, pending: "", timer: null, truncated: false };
    logs.set(worktreePath, log);
    for (const [key, entry] of logs) {
      if (logs.size <= limits.retainedLogs) break;
      if (!active.has(key)) { clearTimeout(entry.timer); logs.delete(key); }
    }
    return log;
  }

  function flushLog(worktreePath, log) {
    clearTimeout(log.timer);
    log.timer = null;
    if (!log.pending) return;
    const text = log.pending;
    log.pending = "";
    publish({ type: "worktree.lifecycle.output", payload: { worktreePath, runId: log.runId, start: log.end - text.length, text } });
  }

  function append(worktreePath, log, text) {
    if (!text) return;
    log.text += text;
    if (log.text.length > limits.outputCharacters) {
      log.text = tail(log.text, limits.outputCharacters);
      log.truncated = true;
    }
    log.end += text.length;
    log.pending = tail(log.pending + text, limits.outputEventCharacters);
    log.timer ??= setTimeout(() => flushLog(worktreePath, log), limits.outputEventIntervalMs);
  }

  function withOutput(state) {
    if (!state) return null;
    const log = logs.get(state.worktreePath);
    if (log?.runId === state.runId) return { ...publicState(state), output: log.text, outputEnd: log.end, outputTruncated: log.truncated };
    const output = state.output ?? "";
    return { ...publicState(state), output, outputEnd: output.length, outputTruncated: Boolean(state.outputTruncated) };
  }

  // `discoveredPath` is the path the project scan reports, which clients
  // match; `worktreePath` is its canonical form. `previous` is this worktree
  // instance's latest state, whose checkpoints carry forward.
  function baseState(target, phase, config, instance, previous) {
    return { worktreePath: target.worktreePath, discoveredPath: target.worktree?.path ?? target.worktreePath,
      worktreeId: target.worktree?.id ?? null, projectId: target.project.id, instance, phase,
      configDigest: config?.digest ?? null, steps: (config?.[phase] ?? []).map((step) => step.name), stepIndex: 0,
      checkpoints: previous?.checkpoints ?? {}, runId: null, error: null, outcomeUnknown: false, updatedAt: now() };
  }

  function unconfirmedAt(target) {
    return [target.worktreePath, target.worktree?.path].filter(Boolean).map(unconfirmed).find(Boolean) ?? null;
  }

  // Anything that proceeds beside processes that could not be confirmed
  // stopped needs the user's acknowledgement of that attempt: `acknowledged`
  // is the run id they were shown, so a stale one never covers a newer
  // attempt. Every acknowledgement is audited before anything proceeds.
  function requireAcknowledged(target, acknowledged, action, details = {}) {
    const pending = unconfirmedAt(target);
    if (!pending) return null;
    if (acknowledged === undefined || acknowledged === null || acknowledged === false) {
      throw apiError(409, "Processes from the last attempt could not be confirmed stopped; acknowledge that before going on",
        { code: "LIFECYCLE_OUTCOME_UNKNOWN", phase: pending.phase, runId: pending.runId, ...details });
    }
    if (acknowledged !== pending.runId) {
      throw apiError(409, "That acknowledgement was for an earlier attempt; check the latest attempt's processes and acknowledge again",
        { code: "LIFECYCLE_ACKNOWLEDGEMENT_STALE", phase: pending.phase, runId: pending.runId, ...details });
    }
    database.auditCritical("worktree.lifecycle.unconfirmed.acknowledged", { target: pending.worktreePath, phase: pending.phase,
      operationId: pending.runId, stepIndex: pending.stepIndex, action });
    return pending;
  }

  // Decides what a phase would run. Null means nothing to run; a state that
  // needs the user (an invalid or untrusted configuration) is recorded and
  // refused, keeping both checkpoints and any unconfirmed processes, with the
  // run id to acknowledge, for the retry that follows.
  function prepare(target, phase, config, { previous, instance }) {
    if (!config) return null;
    const pending = unconfirmedAt(target);
    const refusal = pending ? { outcomeUnknown: true, runId: pending.runId } : {};
    const refused = (state, statusCode, message, code) => {
      const recorded = commit(state);
      throw apiError(statusCode, message, { code, lifecycle: publicState(recorded) });
    };
    if (config.error) {
      refused({ ...baseState(target, phase, null, instance, previous), ...refusal, status: "invalid", configDigest: config.digest,
        error: `${LIFECYCLE_CONFIG_FILE} ${config.error}` }, 422, `${LIFECYCLE_CONFIG_FILE} ${config.error}`, "LIFECYCLE_CONFIG_INVALID");
    }
    const steps = config[phase];
    if (!steps.length) return null;
    if (!database.isLifecycleConfigTrusted(target.project.id, target.project.path, config.digest)) {
      refused({ ...baseState(target, phase, config, instance, previous), ...refusal, status: "needs-trust" }, 409,
        `Review and trust ${LIFECYCLE_CONFIG_FILE} before its ${phase} commands run`, "LIFECYCLE_TRUST_REQUIRED");
    }
    const checkpoint = previous?.checkpoints?.[phase];
    const resumeAt = checkpoint?.configDigest === config.digest ? Math.min(checkpoint.stepIndex, steps.length) : 0;
    return { config, steps, resumeAt, instance, previous };
  }

  // Admits one phase run under the caller's claim. The admission audit and
  // the running state commit before any command starts; a refusal throws
  // and leaves nothing running. Setup provisions again, so a teardown that
  // had finished must run again before removal.
  function begin(entry, target, phase, { config, steps, resumeAt, instance, previous }) {
    const { worktreePath } = target;
    const runId = randomUUID();
    database.auditAdmission(`worktree.lifecycle.${phase}.requested`, { target: worktreePath, projectId: target.project.id,
      operationId: runId, digest: config.digest, steps: steps.map((step) => step.name), resumeAt });
    const base = baseState(target, phase, config, instance, previous);
    const { teardown: _finishedTeardown, ...kept } = base.checkpoints;
    const state = commit({ ...base, checkpoints: phase === "setup" ? kept : base.checkpoints, status: "running", runId,
      stepIndex: resumeAt, startedAt: now() }, { strict: true });
    const log = openLog(worktreePath, runId);
    if (resumeAt) append(worktreePath, log, `Resuming at step ${resumeAt + 1}; earlier steps already finished.\n`);
    return { entry, target, phase, steps, resumeAt, runId, log, state };
  }

  // Runs the admitted steps in order. Resolves with the final state.
  async function runSteps({ entry, target, phase, steps, resumeAt, runId, log, state: initial }) {
    const { worktreePath } = target;
    const { signal } = entry.controller;
    let state = initial;
    let outcome = { status: phase === "setup" ? "ready" : "complete", stepIndex: steps.length };
    for (let index = resumeAt; index < steps.length; index += 1) {
      const step = steps[index];
      if (signal.aborted) {
        outcome = { ...stepFailure(null, step, signal, null), stepIndex: index };
        break;
      }
      append(worktreePath, log, `\n▸ Step ${index + 1} of ${steps.length}: ${step.name}\n$ ${displayCommand(step.command)}\n`);
      // A step starts only once the checkpoint saying earlier steps finished
      // is durable, so a retry after a restart never repeats them.
      try { state = commit({ ...state, stepIndex: index, output: log.text, outputTruncated: log.truncated, updatedAt: now() }, { strict: true }); }
      catch (error) {
        outcome = { status: "failed", stepIndex: index, outcomeUnknown: false,
          error: `Outright could not save progress before "${step.name}", so it did not run: ${String(error?.message ?? error).slice(0, 512)}` };
        break;
      }
      const decoders = { stdout: createOutputDecoder(), stderr: createOutputDecoder() };
      try {
        await subprocesses.run(step.command[0], step.command.slice(1), { // NOSONAR S9382: steps run in their declared order
          cwd: worktreePath, signal, timeout: step.timeoutSeconds * 1000,
          env: { ...process.env, OUTRIGHT_LIFECYCLE_PHASE: phase, OUTRIGHT_WORKTREE_PATH: worktreePath, OUTRIGHT_ROOT_PATH: target.project.path },
          onOutput: (stream, chunk) => append(worktreePath, log, decoders[stream].write(chunk)),
        });
      } catch (error) {
        outcome = { ...stepFailure(error, step, signal, subprocesses.capacity?.()), stepIndex: index };
        break;
      } finally {
        append(worktreePath, log, decoders.stdout.end() + decoders.stderr.end());
      }
    }
    append(worktreePath, log, outcome.error ? `\n${outcome.error}\n` : `\n${phase === "setup" ? "Setup" : "Teardown"} finished.\n`);
    flushLog(worktreePath, log);
    // Output is kept with a state the user must act on; a finished run's
    // output stays only in memory.
    const keepOutput = RESUMABLE.has(outcome.status);
    const checkpoints = finishedCheckpoints(state.checkpoints, phase, state.configDigest, outcome, steps.length);
    state = await commitOutcome({ ...state, error: null, outcomeUnknown: false, ...outcome, checkpoints, output: keepOutput ? log.text : undefined,
      outputTruncated: keepOutput ? log.truncated : undefined, finishedAt: now(), updatedAt: now() });
    try { database.auditCritical(`worktree.lifecycle.${phase}.${outcome.status}`, { target: worktreePath, operationId: runId, stepIndex: state.stepIndex, outcomeUnknown: state.outcomeUnknown }); }
    catch (error) { onPersistError(error); }
    return state;
  }

  // `created` marks a worktree Outright just created: whatever was recorded
  // at its path before describes another worktree.
  async function setup(target, { acknowledgeUnconfirmed, automatic = false, created = false } = {}) {
    const entry = claim(target, "setup");
    let run;
    try {
      const instance = await identify(target.worktreePath);
      const previous = created ? null : current(target.worktreePath, instance);
      const prepared = prepare(target, "setup", await readConfig(target.worktreePath), { previous, instance });
      if (!prepared) {
        // Nothing to set up: no earlier setup state can describe this worktree.
        const stale = states.get(target.worktreePath);
        if (stale && !stale.outcomeUnknown && (stale.phase === "setup" || stale !== previous)) forget(target.worktreePath);
        entry.release();
        return null;
      }
      requireAcknowledged(target, acknowledgeUnconfirmed, "setup");
      run = begin(entry, target, "setup", prepared);
    } catch (error) {
      entry.release();
      if (automatic && ["LIFECYCLE_TRUST_REQUIRED", "LIFECYCLE_CONFIG_INVALID"].includes(error.details?.code)) {
        return publicState(states.get(target.worktreePath));
      }
      throw error;
    }
    void runSteps(run).catch(onPersistError).finally(() => entry.release());
    return publicState(run.state);
  }

  // Removes a worktree after its teardown. `remove(prepareRemoval)` performs
  // the guarded removal and calls `prepareRemoval` after its own checks and
  // before Git removes anything; a failed teardown keeps the worktree. Every
  // removal, with or without teardown commands, refuses beside unconfirmed
  // processes until the user acknowledges them, and keeps their state.
  async function removeWorktree(target, { remove, skipTeardown = false, acknowledgeUnconfirmed }) {
    const entry = claim(target, "teardown");
    let finished = null;
    try {
      const result = await remove(async () => {
        const instance = await identify(target.worktreePath);
        const prepared = skipTeardown ? null : prepare(target, "teardown", await readConfig(target.worktreePath),
          { previous: current(target.worktreePath, instance), instance });
        // `teardown` tells the removal dialog whether acknowledging would run
        // teardown steps or only remove.
        const acknowledged = requireAcknowledged(target, acknowledgeUnconfirmed, skipTeardown ? "teardown-skipped" : "removal",
          skipTeardown ? {} : { teardown: Boolean(prepared) });
        if (skipTeardown) {
          database.auditAdmission("worktree.lifecycle.teardown.skipped", { target: target.worktreePath, projectId: target.project.id,
            acknowledgedUnconfirmed: Boolean(acknowledged) });
          return;
        }
        if (!prepared) return;
        if (prepared.resumeAt >= prepared.steps.length) {
          // Teardown already finished, here or before a restart: only Git
          // removal is left.
          finished = { ...baseState(target, "teardown", prepared.config, instance, prepared.previous), status: "complete",
            stepIndex: prepared.steps.length };
          return;
        }
        finished = await runSteps(begin(entry, target, "teardown", prepared));
        if (finished.status !== "complete") {
          throw apiError(409, `Teardown did not finish, so the worktree was kept. ${finished.error ?? ""}`.trim(),
            { code: "WORKTREE_TEARDOWN_FAILED", lifecycle: publicState(finished) });
        }
      });
      forget(target.worktreePath);
      return result;
    } catch (error) {
      if (finished?.status === "complete") {
        // Teardown finished but Git kept the worktree. Its checkpoint sends a
        // retry straight to removal.
        commit({ ...finished, status: "failed", stepIndex: finished.steps.length, updatedAt: now(),
          error: `Teardown finished, but the worktree could not be removed: ${String(error.message ?? error).slice(0, 512)}` });
      }
      throw error;
    } finally { entry.release(); }
  }

  // The user checked processes that could not be confirmed stopped. Agent
  // work may start again, and a retry resumes at its checkpoint.
  function acknowledge(target, runId) {
    const paths = [target.worktreePath, target.worktree?.path].filter(Boolean);
    if (paths.some(holding)) throw apiError(409, "Worktree setup or teardown is running", { code: "WORKTREE_LIFECYCLE_BUSY" });
    if (!unconfirmedAt(target)) return publicState(states.get(target.worktreePath) ?? null);
    const pending = requireAcknowledged(target, runId, "acknowledge");
    const state = commit({ ...pending, outcomeUnknown: false, acknowledgedAt: now(), updatedAt: now() });
    releaseHold(pending.worktreePath);
    return publicState(state);
  }

  // Lifecycle ownership recovery proved every earlier step's processes gone,
  // so no state is unconfirmed any longer.
  async function reconcile() {
    await subprocesses.reconcileUnknown?.();
    if (stopping || subprocesses.capacity?.().unknown !== 0) return 0;
    let confirmed = 0;
    for (const state of [...states.values()]) {
      if (!state.outcomeUnknown || holding(state.worktreePath)) continue;
      commit({ ...state, outcomeUnknown: false, updatedAt: now() });
      try { database.auditCritical("worktree.lifecycle.unconfirmed.proven", { target: state.worktreePath, operationId: state.runId }); }
      catch (error) { onPersistError(error); }
      releaseHold(state.worktreePath);
      confirmed += 1;
    }
    return confirmed;
  }

  function releaseHold(worktreePath) {
    try { onRelease(worktreePath); }
    catch (error) { onPersistError(error); }
  }

  function cancel(target) {
    const entry = holding(target.worktreePath);
    if (!entry) throw apiError(409, "No setup or teardown is running in this worktree", { code: "WORKTREE_LIFECYCLE_IDLE" });
    entry.controller.abort("cancel");
    return publicState(states.get(target.worktreePath));
  }

  async function trust(target, digest) {
    const config = await readConfig(target.worktreePath);
    if (!config) throw apiError(404, `This worktree has no ${LIFECYCLE_CONFIG_FILE}`, { code: "LIFECYCLE_CONFIG_MISSING" });
    if (config.error) throw apiError(422, `${LIFECYCLE_CONFIG_FILE} ${config.error}`, { code: "LIFECYCLE_CONFIG_INVALID" });
    // The digest is what the user reviewed. A file changed since then is a
    // different configuration and needs its own review.
    if (typeof digest !== "string" || digest !== config.digest) {
      throw apiError(409, `${LIFECYCLE_CONFIG_FILE} changed after it was shown; review it again`, { code: "LIFECYCLE_CONFIG_CHANGED" });
    }
    database.trustLifecycleConfig(target.project.id, target.project.path, digest);
    return describe(target);
  }

  async function describe(target) {
    const config = await readConfig(target.worktreePath);
    const trusted = Boolean(config?.digest && !config.error
      && database.isLifecycleConfigTrusted(target.project.id, target.project.path, config.digest));
    const running = holding(target.worktreePath)?.phase ?? null;
    // A running state is this instance's by construction. Unconfirmed
    // processes at this path concern whatever worktree is there now, but an
    // earlier worktree's progress does not.
    const earlier = unconfirmed(target.worktreePath);
    const state = running ? states.get(target.worktreePath)
      : current(target.worktreePath, await identify(target.worktreePath)) ?? (earlier && { ...earlier, checkpoints: {} });
    return {
      file: LIFECYCLE_CONFIG_FILE,
      worktreePath: target.worktreePath,
      state: withOutput(state ?? null),
      running,
      config: config && { digest: config.digest, error: config.error ? `${LIFECYCLE_CONFIG_FILE} ${config.error}` : null, trusted,
        setup: config.setup ?? [], teardown: config.teardown ?? [] },
    };
  }

  function forget(worktreePath) {
    const log = logs.get(worktreePath);
    if (log) clearTimeout(log.timer);
    logs.delete(worktreePath);
    const known = states.delete(worktreePath);
    try { database.deleteWorktreeLifecycle(worktreePath); }
    catch (error) { onPersistError(error); }
    if (known) publish({ type: "worktree.lifecycle", payload: { worktreePath, removed: true } });
  }

  async function shutdown() {
    stopping = true;
    const running = [...active.values()];
    for (const entry of running) entry.controller.abort("shutdown");
    await Promise.allSettled(running.map((entry) => entry.done));
    for (const log of logs.values()) clearTimeout(log.timer);
  }

  return {
    setup, removeWorktree, cancel, trust, describe, acknowledge, reconcile, shutdown, hold,
    busy: (worktreePath) => Boolean(holding(worktreePath)),
    list: () => [...states.values()].map(publicState),
  };
}
