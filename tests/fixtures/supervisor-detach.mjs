import assert from "node:assert/strict";
import { reattachManagedTerminal, reattachToken } from "../../server/managed-terminal.mjs";

// Shared by the per-platform supervisor detach tests. Each platform supplies
// its own detach arguments, liveness check and release assertion.
export const ATTACHED = "__OUTRIGHT_BROKER_ATTACHED_V1__";
export const DETACHED = "__OUTRIGHT_BROKER_DETACHED_V1__";

// Stands in for the broker: records its pid, and prints a broker status line,
// runs the platform's escape command to start a descendant outside the
// supervised tree, or exits when the test drops a request file in its
// directory.
export const brokerStandIn = (escape) => `#!/bin/sh
dir="$1"
echo $$ > "$dir/provider.pid"
while :; do
  if [ -f "$dir/escape" ]; then rm -f "$dir/escape"
    ${escape}
  fi
  if [ -f "$dir/attach" ]; then rm -f "$dir/attach"; echo ${ATTACHED}; fi
  if [ -f "$dir/detach" ]; then rm -f "$dir/detach"; echo ${DETACHED}; fi
  if [ -f "$dir/exit" ]; then exit 0; fi
  sleep 0.05
done
`;

export async function waitUntil(predicate, message, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(typeof message === "function" ? message() : message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function assertReattachPausesWindow({ start, detach, alive, assertReleased }) {
  const run = await start("reattach", detach(500));
  run.owner.kill("SIGKILL");
  run.request("attach");
  // Far past the window and its grace: the reattached runtime keeps it.
  await delay(3000);
  assert.equal(alive(run.providerPid()), true, "the supervisor ended a reattached shell at the window");
  const detachedAgain = Date.now();
  run.request("detach");
  await assertReleased(run, 10_000);
  assert.ok(Date.now() - detachedAgain >= 500, "a fresh detach did not get its own window");
}

// terminate stands for a termination request to the supervisor; Windows has
// no SIGTERM, so its recovery's terminate request stands in.
const sigterm = (run) => process.kill(run.supervisorPid, "SIGTERM");

export async function assertStopEndsDetachedProvider({ start, detach, alive, assertReleased, terminate = sigterm }) {
  const stopped = await start("stop", detach(60_000));
  stopped.owner.stdin.write("stop\n");
  await waitUntil(() => stopped.supervisorExit(), "an explicit stop did not end the detach-mode provider");
  assert.deepEqual(stopped.supervisorExit(), ["137", "null"]);
  await assertReleased(stopped, 5000);

  const eof = await start("eof", detach(60_000));
  eof.owner.stdin.write("close\n");
  await delay(800);
  assert.equal(eof.supervisorExit(), null, "stdin EOF ended a detach-mode provider");
  assert.equal(alive(eof.providerPid()), true);
  terminate(eof);
  await waitUntil(() => eof.supervisorExit(), "a termination request did not end the detach-mode provider");
  assert.deepEqual(eof.supervisorExit(), ["137", "null"]);
  await assertReleased(eof, 5000);

  // The shell's own exit while detached settles it without the window.
  const exited = await start("exit", detach(60_000));
  exited.owner.kill("SIGKILL");
  await delay(300);
  exited.request("exit");
  await assertReleased(exited, 5000);
}

// The whole path: a managed terminal launched with a reattach session, whose
// owner the test kills to stand for a crashed runtime.
export const MANAGED_OWNER_SOURCE = `
const [managed, id, launchDirectory, cwd, windowMs] = process.argv.slice(1);
const { reattachToken, spawnManagedTerminal, terminalOwnership } = await import(managed);
const ownership = terminalOwnership(id, launchDirectory);
const token = reattachToken();
const adapter = await spawnManagedTerminal({ id, ownership, shell: process.execPath, cwd, cols: 80, rows: 24,
  env: process.env, session: { label: ownership.label, token, windowMs: Number(windowMs) } });
let output = "";
adapter.onData((data) => {
  output += data;
  if (output.includes("41")) console.log(JSON.stringify({ identity: adapter.sessionIdentity, token, pid: adapter.pid }));
  if (output.includes("41")) output = "";
});
adapter.write("globalThis.kept = 41\\r");`;

// The broker takes a reattach once it has seen its crashed peer close; a
// refused attempt before then spends nothing.
export async function reattachCrashedTerminal({ id, identity, token, verifyEmpty }) {
  let adapter = null;
  const reattachDeadline = Date.now() + 2000;
  const nextToken = reattachToken();
  while (!adapter && Date.now() < reattachDeadline) {
    adapter = await reattachManagedTerminal({ id, identity, token, nextToken, cols: 80, rows: 24, verifyEmpty });
    if (!adapter) await delay(50);
  }
  assert.ok(adapter, "the crashed runtime's terminal was not kept to reattach");
  return adapter;
}

// The reattached shell is the live process that ran before the crash.
export async function assertKeptShell(adapter) {
  let output = "";
  adapter.onData((data) => { output += data; });
  assert.equal(adapter.write("kept + 1\r"), true, "the reattached broker went away");
  await waitUntil(() => output.includes("42"), () => `the reattached shell is not the live process: ${JSON.stringify(output.slice(-400))}`);
}
