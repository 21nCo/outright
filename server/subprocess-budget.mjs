import { execFile, spawn } from "node:child_process";

// Git, scanner and editor requests share one admission point. Command permits
// stay charged until close; detached editor permits cover process creation.
export function createSubprocessBudget({ limit = 8, execute = execFile, launch = spawn } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("Utility process limit must be a non-negative integer");
  let active = 0;
  function admit() {
    if (active >= limit) {
      const error = new Error("Utility process capacity is full; retry when a process finishes");
      error.statusCode = 429;
      error.code = "SUBPROCESS_CAPACITY";
      throw error;
    }
    active += 1;
  }
  function run(file, args, options = {}) {
    try { admit(); } catch (error) { return Promise.reject(error); }
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
  // Editors are external GUI applications. Charge their launch admission,
  // then release the utility permit when the OS confirms process creation;
  // waiting for the window to close would strand a long-running editor slot.
  function launchDetached(file, args, options = {}) {
    try { admit(); } catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      let settled = false;
      let child;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        active -= 1;
        if (error) reject(error);
        else { child.unref?.(); resolve({ pid: child.pid }); }
      };
      try {
        child = launch(file, args, { ...options, stdio: "ignore", detached: process.platform !== "win32" });
        child.once("error", finish);
        child.once("spawn", () => finish(null));
      } catch (error) { finish(error); }
    });
  }
  return { run, launchDetached, capacity: () => ({ active, limit }) };
}

export const utilityProcesses = createSubprocessBudget();
