// The only server module that starts processes. Every primitive here removes
// the direct-provider credentials the execution adapters declare, whether the
// caller passes an environment or inherits the runtime's. A test enforces
// that no other server module imports node:child_process or node-pty except
// the reviewed exceptions it lists.
import * as childProcess from "node:child_process";
import { promisify } from "node:util";
import { withoutDirectProviderCredentials } from "./execution-adapters/index.mjs";

function scoped(options) {
  return { ...options, env: withoutDirectProviderCredentials(options?.env ?? process.env) };
}

// Node's optional-args overloads: nullish args means no arguments and keeps
// the options and callback in place; only an object in the args slot is the
// options, and a function in either slot is the callback.
function overload(args, options, callback) {
  if (typeof args === "function") return [[], undefined, args];
  if (args == null) args = [];
  else if (!Array.isArray(args) && typeof args === "object") [args, options, callback] = [[], args, options];
  if (typeof options === "function") [options, callback] = [undefined, options];
  return [args, options, callback];
}

export function spawn(file, args, options) {
  [args, options] = overload(args, options);
  return childProcess.spawn(file, args, scoped(options));
}

export function spawnSync(file, args, options) {
  [args, options] = overload(args, options);
  return childProcess.spawnSync(file, args, scoped(options));
}

export function execFile(file, args, options, callback) {
  [args, options, callback] = overload(args, options, callback);
  return childProcess.execFile(file, args, scoped(options), callback);
}
// Keeps promisify(execFile) resolving { stdout, stderr } like Node's.
const execFileAsync = promisify(childProcess.execFile);
execFile[promisify.custom] = (file, args, options) => {
  [args, options] = overload(args, options);
  return execFileAsync(file, args, scoped(options));
};

export function execFileSync(file, args, options) {
  [args, options] = overload(args, options);
  return childProcess.execFileSync(file, args, scoped(options));
}

// The single exception: the launch of an adapter run, whose environment
// buildExecutionEnvironment() has already scoped to that adapter.
export function spawnExecution(file, args, options) {
  return childProcess.spawn(file, args, options);
}
