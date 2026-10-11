// The only server module that starts processes. Every primitive here removes
// the direct-provider credentials the execution adapters declare, whether the
// caller passes an environment or inherits the runtime's. A test enforces
// that no other server module imports node:child_process or node-pty except
// the reviewed exceptions it lists.
import * as childProcess from "node:child_process";
import { promisify } from "node:util";
import { withoutDirectProviderCredentials } from "./execution-adapters/index.mjs";

// Only an options object, or none, gets the scoped environment. Anything
// else reaches Node unchanged, so Node throws its own error and nothing starts.
function scoped(options) {
  if (options !== undefined && (options === null || typeof options !== "object" || Array.isArray(options))) return options;
  return { ...options, env: withoutDirectProviderCredentials(options?.env ?? process.env) };
}

// spawn and spawnSync: nullish args means no arguments and any other object
// in the args slot is the options. There is no callback overload.
function spawnArguments(args, options) {
  if (args !== null && typeof args === "object" && !Array.isArray(args)) return [[], scoped(args)];
  return [args, scoped(options)];
}

// execFile and execFileSync: an object in the args slot is the options, a
// function there is the callback, and nullish options mean none. Only
// execFile takes a callback in the options slot; execFileSync passes it on
// for Node to reject.
function execFileArguments(args, options, callback, callbackOptions) {
  if (args !== null && typeof args === "object" && !Array.isArray(args)) [args, options, callback] = [[], args, options];
  else if (typeof args === "function") [args, options, callback] = [[], undefined, args];
  if (typeof options === "function" && callbackOptions) [options, callback] = [undefined, options];
  return [args, scoped(options ?? undefined), callback];
}

export function spawn(file, args, options) {
  return childProcess.spawn(file, ...spawnArguments(args, options));
}

export function spawnSync(file, args, options) {
  return childProcess.spawnSync(file, ...spawnArguments(args, options));
}

export function execFile(file, args, options, callback) {
  return childProcess.execFile(file, ...execFileArguments(args, options, callback, true));
}
// Keeps promisify(execFile) resolving { stdout, stderr } like Node's.
const execFileAsync = promisify(childProcess.execFile);
execFile[promisify.custom] = (file, args, options) => execFileAsync(file, ...execFileArguments(args, options, undefined, true).slice(0, 2));

export function execFileSync(file, args, options) {
  return childProcess.execFileSync(file, ...execFileArguments(args, options, undefined, false).slice(0, 2));
}

// The single exception: the launch of an adapter run, whose environment
// buildExecutionEnvironment() has already scoped to that adapter.
export function spawnExecution(file, args, options) {
  return childProcess.spawn(file, args, options);
}
