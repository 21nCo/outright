import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

// Repository setup and teardown for worktrees. A repository describes its
// commands in one JSON file at the worktree root; nothing in it runs until
// the user trusts the exact bytes for that project. Each step runs as a
// utility process, so the native owner terminates its whole descendant tree
// on cancel, timeout or shutdown, and only the newest output is retained.
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
});
const PHASES = new Set(["setup", "teardown"]);
const STATUSES = new Set(["needs-trust", "invalid", "running", "ready", "complete", "failed", "cancelled", "interrupted"]);
// A retry resumes at the step that did not finish; finished steps never run
// twice for the same configuration.
const RESUMABLE = new Set(["failed", "cancelled", "interrupted"]);
const CONFIG_KEYS = new Set(["version", "setup", "teardown"]);
const STEP_KEYS = new Set(["name", "command", "timeoutSeconds"]);
const ESCAPE_SEQUENCE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g;
const COMPLETE_ESCAPE = /^\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

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
  if (!name || name.length > LIFECYCLE_LIMITS.nameCharacters || CONTROL_CHARACTER.test(name)) {
    throw configError(`${label}.name must be 1 to ${LIFECYCLE_LIMITS.nameCharacters} printable characters`);
  }
  const { command } = value;
  if (!Array.isArray(command) || !command.length || command.length > LIFECYCLE_LIMITS.arguments
    || command.some((argument) => typeof argument !== "string" || argument.includes("\0")
      || Buffer.byteLength(argument) > LIFECYCLE_LIMITS.argumentBytes) || !command[0].trim()) {
    throw configError(`${label}.command must be an array of 1 to ${LIFECYCLE_LIMITS.arguments} strings, starting with a program`);
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

function stepFailure(error, step, signal) {
  const unknown = error?.code === "SUBPROCESS_OWNERSHIP_UNKNOWN";
  const cause = unknown && error.cause ? error.cause : error;
  const suffix = unknown ? " Its processes could not be confirmed stopped; Outright keeps their capacity reserved until they are." : "";
  if (signal.aborted) {
    const shutdown = signal.reason === "shutdown";
    return { status: shutdown ? "interrupted" : "cancelled", outcomeUnknown: unknown,
      error: `${shutdown ? "Outright stopped during" : "Cancelled during"} "${step.name}"; its effects may be partial.${suffix}` };
  }
  let message = `"${step.name}" could not run: ${String(cause?.message ?? cause).slice(0, 512)}`;
  if (cause?.code === "SUBPROCESS_CAPACITY") message = "Utility process capacity is full; retry when a process finishes.";
  else if (cause?.killed && /timed out/i.test(cause.message ?? "")) message = `"${step.name}" timed out after ${step.timeoutSeconds} seconds.`;
  else if (Number.isInteger(cause?.code)) message = `"${step.name}" exited with status ${cause.code}.`;
  else if (cause?.signal) message = `"${step.name}" was stopped by ${cause.signal}.`;
  return { status: "failed", outcomeUnknown: unknown, error: `${message}${suffix}` };
}

export function createWorktreeLifecycle({ database, subprocesses, publish = () => {}, readConfig = readLifecycleConfig,
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

  function remember(state) {
    states.delete(state.worktreePath);
    states.set(state.worktreePath, state);
    for (const key of states.keys()) {
      if (states.size <= limits.states) break;
      if (!active.has(key)) states.delete(key);
    }
  }

  function commit(state, { strict = false } = {}) {
    persist(state, strict);
    remember(state);
    publish({ type: "worktree.lifecycle", payload: publicState(state) });
    return state;
  }

  // A run that was going when the previous runtime stopped did not finish.
  // Its native owner is ended by utility ownership recovery.
  for (const stored of database.listWorktreeLifecycle?.() ?? []) {
    if (!storedState(stored)) continue;
    let state = stored;
    if (state.status === "running") {
      state = { ...state, status: "interrupted", updatedAt: now(),
        error: `Outright stopped during step ${state.stepIndex + 1}; its effects may be partial.` };
      persist(state);
    }
    states.set(state.worktreePath, state);
  }

  function claim(worktreePath, phase) {
    if (stopping) throw apiError(503, "Runtime is shutting down");
    const current = active.get(worktreePath);
    if (current) throw apiError(409, `Worktree ${current.phase} is already running`, { code: "WORKTREE_LIFECYCLE_BUSY", phase: current.phase });
    let resolveDone;
    const entry = { phase, controller: new AbortController(), done: new Promise((resolve) => { resolveDone = resolve; }) };
    entry.release = () => {
      if (active.get(worktreePath) !== entry) return;
      active.delete(worktreePath);
      resolveDone();
    };
    active.set(worktreePath, entry);
    return entry;
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

  function baseState(target, phase, config) {
    return { worktreePath: target.worktreePath, worktreeId: target.worktree?.id ?? null, projectId: target.project.id, phase,
      configDigest: config?.digest ?? null, steps: (config?.[phase] ?? []).map((step) => step.name), stepIndex: 0,
      runId: null, error: null, outcomeUnknown: false, updatedAt: now() };
  }

  // Decides what a phase would run. Null means nothing to run; a state that
  // needs the user (an invalid or untrusted configuration) is recorded and
  // refused.
  function prepare(target, phase, config, { acknowledgeUnconfirmed = false } = {}) {
    if (!config) return null;
    if (config.error) {
      commit({ ...baseState(target, phase, null), status: "invalid", configDigest: config.digest, error: `${LIFECYCLE_CONFIG_FILE} ${config.error}` });
      throw apiError(422, `${LIFECYCLE_CONFIG_FILE} ${config.error}`, { code: "LIFECYCLE_CONFIG_INVALID" });
    }
    const steps = config[phase];
    if (!steps.length) return null;
    if (!database.isLifecycleConfigTrusted(target.project.id, target.project.path, config.digest)) {
      commit({ ...baseState(target, phase, config), status: "needs-trust" });
      throw apiError(409, `Review and trust ${LIFECYCLE_CONFIG_FILE} before its ${phase} commands run`, { code: "LIFECYCLE_TRUST_REQUIRED" });
    }
    const previous = states.get(target.worktreePath);
    if (previous?.outcomeUnknown && !acknowledgeUnconfirmed) {
      throw apiError(409, "Processes from the last attempt could not be confirmed stopped; acknowledge that before running again",
        { code: "LIFECYCLE_OUTCOME_UNKNOWN" });
    }
    const resumeAt = previous?.phase === phase && previous.configDigest === config.digest && RESUMABLE.has(previous.status)
      ? Math.min(previous.stepIndex, steps.length) : 0;
    return { config, steps, resumeAt };
  }

  // Admits one phase run under the caller's claim. The admission audit and
  // the running state commit before any command starts; a refusal throws
  // and leaves nothing running.
  function begin(entry, target, phase, { config, steps, resumeAt }) {
    const { worktreePath } = target;
    const runId = randomUUID();
    database.auditAdmission(`worktree.lifecycle.${phase}.requested`, { target: worktreePath, projectId: target.project.id,
      operationId: runId, digest: config.digest, steps: steps.map((step) => step.name), resumeAt });
    const state = commit({ ...baseState(target, phase, config), status: "running", runId, stepIndex: resumeAt, startedAt: now() }, { strict: true });
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
        outcome = { ...stepFailure(null, step, signal), stepIndex: index };
        break;
      }
      append(worktreePath, log, `\n▸ Step ${index + 1} of ${steps.length}: ${step.name}\n$ ${displayCommand(step.command)}\n`);
      state = commit({ ...state, stepIndex: index, output: log.text, outputTruncated: log.truncated, updatedAt: now() });
      const decoders = { stdout: createOutputDecoder(), stderr: createOutputDecoder() };
      try {
        await subprocesses.run(step.command[0], step.command.slice(1), { // NOSONAR S9382: steps run in their declared order
          cwd: worktreePath, signal, timeout: step.timeoutSeconds * 1000,
          env: { ...process.env, OUTRIGHT_LIFECYCLE_PHASE: phase, OUTRIGHT_WORKTREE_PATH: worktreePath, OUTRIGHT_ROOT_PATH: target.project.path },
          onOutput: (stream, chunk) => append(worktreePath, log, decoders[stream].write(chunk)),
        });
      } catch (error) {
        outcome = { ...stepFailure(error, step, signal), stepIndex: index };
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
    state = commit({ ...state, error: null, outcomeUnknown: false, ...outcome, output: keepOutput ? log.text : undefined,
      outputTruncated: keepOutput ? log.truncated : undefined, finishedAt: now(), updatedAt: now() });
    try { database.auditCritical(`worktree.lifecycle.${phase}.${outcome.status}`, { target: worktreePath, operationId: runId, stepIndex: state.stepIndex, outcomeUnknown: state.outcomeUnknown }); }
    catch (error) { onPersistError(error); }
    return state;
  }

  async function setup(target, { acknowledgeUnconfirmed = false, automatic = false } = {}) {
    const entry = claim(target.worktreePath, "setup");
    let run;
    try {
      const prepared = prepare(target, "setup", await readConfig(target.worktreePath), { acknowledgeUnconfirmed });
      if (!prepared) {
        // Nothing to set up: no earlier setup state can describe this worktree.
        if (states.get(target.worktreePath)?.phase === "setup") forget(target.worktreePath);
        entry.release();
        return null;
      }
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
  // before Git removes anything; a failed teardown keeps the worktree.
  async function removeWorktree(target, { remove, skipTeardown = false, acknowledgeUnconfirmed = false }) {
    const entry = claim(target.worktreePath, "teardown");
    let finished = null;
    try {
      const result = await remove(async () => {
        if (skipTeardown) {
          database.auditAdmission("worktree.lifecycle.teardown.skipped", { target: target.worktreePath, projectId: target.project.id });
          return;
        }
        const prepared = prepare(target, "teardown", await readConfig(target.worktreePath), { acknowledgeUnconfirmed });
        if (!prepared) return;
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
        // Teardown finished but Git kept the worktree. A retry goes straight
        // to removal instead of running the teardown again.
        commit({ ...finished, status: "failed", stepIndex: finished.steps.length, updatedAt: now(),
          error: `Teardown finished, but the worktree could not be removed: ${String(error.message ?? error).slice(0, 512)}` });
      }
      throw error;
    } finally { entry.release(); }
  }

  function cancel(target) {
    const entry = active.get(target.worktreePath);
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
    return {
      file: LIFECYCLE_CONFIG_FILE,
      state: withOutput(states.get(target.worktreePath) ?? null),
      running: active.get(target.worktreePath)?.phase ?? null,
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
    setup, removeWorktree, cancel, trust, describe, shutdown,
    busy: (worktreePath) => active.has(worktreePath),
    list: () => [...states.values()].map(publicState),
  };
}
