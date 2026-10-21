import assert from "node:assert/strict";
import test from "node:test";
import { preferredTerminal, pruneExitedIds, terminalEndLabel, terminalTabLabel, savedOutputPages, savedPageText } from "../src/lib/terminal-exit-state.js";
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

test("saved output pages never split an escape sequence and carry the rendition and screen in effect", () => {
  const sgr = "\x1b[1;38;2;255;0;0mab\x1b[0m";
  const osc = `\x1b]52;c;${"Q".repeat(70_000)}\x07`;
  const cases = [sgr.repeat(20_000), `${"x".repeat(100_000)}${osc}tail`, `${"y\n".repeat(1_500)}${"\x1b]8;;https://example.test\x1b\\link\x1b]8;;\x1b\\".repeat(3_000)}`];
  for (const buffer of cases) {
    const sequences = [...buffer.matchAll(/\x1b(?:\[[0-9;]*m|\][^\x07\x1b]*(?:\x07|\x1b\\))/g)].map((match) => [match.index, match.index + match[0].length]);
    const pages = savedOutputPages(buffer, 64_000, 2_000);
    assert.equal(pages.map(([start, end]) => buffer.slice(start, end)).join(""), buffer);
    for (const [start] of pages) assert.ok(!sequences.some(([from, to]) => start > from && start < to), `a page starts inside an escape sequence at ${start}`);
  }

  const colored = `\x1b[1;38;5;196mred\n${"x\n".repeat(3_000)}`;
  assert.equal(savedOutputPages(colored).at(-1)[2], "\x1b[1;38;5;196m", "a later page lost the rendition set before it");
  assert.ok(savedPageText(colored, savedOutputPages(colored).at(-1)).startsWith("\x1b[1;38;5;196m"));
  for (const reset of ["\x1b[0m", "\x1b[m", "\x1bc", "\x1b[22;39m"]) {
    assert.equal(savedOutputPages(`${colored.slice(0, 15)}${reset}${colored.slice(15)}`).at(-1)[2], "", `${JSON.stringify(reset)} did not end the rendition`);
  }

  const app = `before\n\x1b[34m\x1b[?1049h\x1b[2J\x1b[HFULLSCREEN\x1b[31m${"frame\n".repeat(2_500)}\x1b[?1049lafter\x1b[3J\n`;
  const [first, second] = savedOutputPages(app);
  assert.deepEqual([first[3], second[3], second[2]], [false, true, "\x1b[34m"], "a page opened inside the alternate screen lost its saved rendition");
  const text = pages(app).join("");
  assert.ok(text.includes("before") && text.includes("after") && !/FULLSCREEN|frame|\x1b\[\?1049|\x1b\[3J/.test(text), "alternate-screen output or a scrollback erase reached the saved view");
  assert.equal(savedPageText("a\x1bcb", [0, 4]), "a\x1b[0m\x1b[H\x1b[2Jb", "a full reset inside saved output cleared the view's scrollback");
  function pages(buffer) { return savedOutputPages(buffer).map((page) => savedPageText(buffer, page)); }
});
