import assert from "node:assert/strict";
import test from "node:test";
import { preferredTerminal, pruneExitedIds, terminalEndLabel, terminalTabLabel, savedOutputPages } from "../src/lib/terminal-exit-state.js";
import { createTerminalCommandFence } from "../src/lib/terminal-command-fence.js";

test("audit failure fences terminal commands before a later runtime event or React commit", () => {
  const fence = createTerminalCommandFence();
  const input = { type: "terminal.input", terminalId: "one", data: "x" };
  const resize = { type: "terminal.resize", terminalId: "one", cols: 80, rows: 24 };
  assert.equal(fence.allows(input), true);
  assert.equal(fence.observe({ type: "terminal.audit-failed", terminalId: "one" }), true);
  fence.observe({ type: "capacity.changed", payload: {} });
  assert.equal(fence.allows(input), false);
  assert.equal(fence.allows(resize), false);
  assert.deepEqual([...fence.snapshot()], ["one"]);
  assert.equal(fence.allows({ ...input, terminalId: "other" }), true);
  for (let index = 0; index < 300; index += 1) fence.observe({ type: "terminal.audit-failed", terminalId: `old-${index}` });
  assert.equal(fence.snapshot().size, 256, "long sessions must not retain unbounded old terminal IDs");
});

test("exited identities are pruned across repeated closes without dropping a pending exit", () => {
  const exited = new Set(["pending-exit"]);
  for (let index = 0; index < 50; index += 1) exited.add(`closed-${index}`);
  exited.add("still-open");
  pruneExitedIds(exited, [{ id: "active" }, { id: "still-open" }], { id: "pending-exit", exit: { exitCode: 7 } });
  assert.deepEqual([...exited].sort(), ["pending-exit", "still-open"], "Stale exited terminal identities accumulated or a pending exit was lost");

  for (let index = 50; index < 100; index += 1) {
    exited.add(`closed-${index}`);
    pruneExitedIds(exited, [{ id: "active" }, { id: "still-open" }], { id: "pending-exit", exit: { exitCode: 7 } });
    assert.equal(exited.size, 2, `Closed terminal ${index} retained its exit identity`);
  }
  pruneExitedIds(exited, [{ id: "active" }], null);
  assert.equal(exited.size, 0, "Closed or finished pending terminals retained their exit identities");
});

test("saved sessions are labelled by how they ended and never as running", () => {
  const restarted = { id: "a", name: "Server", status: "ended", endReason: "restart", exitCode: null };
  const exited = { id: "b", name: "Build", status: "ended", endReason: "exit", exitCode: 7 };
  assert.equal(terminalEndLabel(restarted), "ended when Outright restarted");
  assert.equal(terminalEndLabel(exited), "process exited 7");
  assert.equal(terminalEndLabel({ ...exited, endReason: "closed", exitCode: null }), "closed; its saved output could not be deleted");
  assert.equal(terminalTabLabel(restarted), "Server, saved output, ended when Outright restarted");
  assert.equal(terminalTabLabel(exited), "Build, saved output, process exited 7");
  for (const label of [terminalTabLabel(restarted), terminalTabLabel(exited)]) assert.doesNotMatch(label, /running|resum/i);
  const relaunched = { id: "c", name: "Server", status: "running", relaunchedFrom: "a" };
  assert.equal(terminalTabLabel(relaunched), "Server, new shell");
  assert.equal(terminalTabLabel({ ...relaunched, status: "exited", exitCode: 0 }), "Server, new shell, process exited 0");
  assert.equal(terminalTabLabel({ id: "d", name: "Shell", status: "running" }), "Shell");
});

test("reopening a worktree shows live work first and otherwise the newest saved session without starting a shell", () => {
  const older = { id: "old", status: "ended", endedAt: "2026-10-20T00:00:00.000Z" };
  const newer = { id: "new", status: "ended", endedAt: "2026-10-21T00:00:00.000Z" };
  const unknown = { id: "unknown", status: "unknown" };
  const running = { id: "running", status: "running" };
  assert.equal(preferredTerminal([older, newer]), newer);
  assert.equal(preferredTerminal([newer, older]), newer);
  assert.equal(preferredTerminal([older, unknown]), unknown, "a saved session hid an unverified prior-run owner");
  assert.equal(preferredTerminal([older, unknown, running]), running);
  assert.equal(preferredTerminal([older, running], "old"), older, "a selected saved session was replaced on refresh");
  assert.equal(preferredTerminal([{ id: "gone", status: "exited" }]), null);
  assert.equal(preferredTerminal([]), null);
});

test("saved output pages cover every character in order within the view's bounds", () => {
  const cases = ["", "a\nb", "x".repeat(300_000), "\n".repeat(10_000), Array.from({ length: 30_000 }, (_, index) => `line ${index}\r\n`).join(""), `${"é😀".repeat(40_000)}\n`];
  for (const buffer of cases) {
    const pages = savedOutputPages(buffer, 64_000, 2_000);
    assert.equal(pages.map(([start, end]) => buffer.slice(start, end)).join(""), buffer);
    for (const [start, end] of pages) {
      assert.ok(end > start && end - start <= 64_000);
      assert.ok((buffer.slice(start, end).match(/\n/g) ?? []).length <= 2_000);
      const code = buffer.charCodeAt(start);
      assert.ok(!(code >= 0xdc00 && code <= 0xdfff), "a page split a surrogate pair");
    }
  }
});
