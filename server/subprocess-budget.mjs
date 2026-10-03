import { execFile } from "node:child_process";

// Git, scanner and editor requests share one admission point. A permit stays
// charged until the child closes, including timeout and spawn-error paths.
export function createSubprocessBudget({ limit = 8, execute = execFile } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("Utility process limit must be a non-negative integer");
  let active = 0;
  function run(file, args, options = {}) {
    if (active >= limit) {
      const error = new Error("Utility process capacity is full; retry when a process finishes");
      error.statusCode = 429;
      error.code = "SUBPROCESS_CAPACITY";
      return Promise.reject(error);
    }
    active += 1;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, stdout, stderr) => {
        if (settled) return;
        settled = true;
        active -= 1;
        if (error) reject(Object.assign(error, { stdout, stderr }));
        else resolve({ stdout, stderr });
      };
      try { execute(file, args, options, finish); }
      catch (error) { finish(error); }
    });
  }
  return { run, capacity: () => ({ active, limit }) };
}

export const utilityProcesses = createSubprocessBudget();
