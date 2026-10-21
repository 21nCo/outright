import assert from "node:assert/strict";
import test from "node:test";
import { escapeSpans, preferredTerminal, pruneExitedIds, terminalEndLabel, terminalTabLabel, savedOutputPages, savedPageProjection, savedPageText } from "../src/lib/terminal-exit-state.js";
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

test("one escape tokenizer finds every sequence class the saved view knows", () => {
  // Each case's spans are those the round-2 regular expression found.
  const osc = `\x1b]52;c;${"Q".repeat(70_000)}\x07`;
  const cases = [
    ["a\x1b[1;38;5;196mb", [1, 14]],
    ["\x1b[?1049h\x1b[2 q", [0, 8, 8, 13]],
    ["\x1b]0;title\x07x\x1b]8;;u\x1b\\y", [0, 10, 11, 19]],
    ["\x1bP1$r\x1b\\\x1b_apc", [0, 7, 7, 12]],
    ["\x1b]open\x1bcz", [0, 6, 6, 8]],
    ["\x1bc\x1b(B\x1b7\x1b=", [0, 2, 2, 5, 5, 7, 7, 9]],
    ["\x1b[12\x01", [0, 2]],
    ["\x1b\x01\x1b \x01x\x1b", [6, 7]],
    [`x${osc}y`, [1, 1 + osc.length]],
    [`x\x1b]52;c;${"Q".repeat(70_000)}`, [1, 70_008]],
  ];
  for (const [buffer, spans] of cases) assert.deepEqual(escapeSpans(buffer), spans, JSON.stringify(buffer.slice(0, 40)));
});

test("a full reset ends a full-screen program's hidden screen in the saved view", () => {
  const text = savedPageText("a\x1b[?1049hX\x1bcb", [0, 15]);
  assert.ok(text.includes("b") && !text.includes("X"), JSON.stringify(text));
  const probe = "before\r\n\x1b[?1049hFULLSCREEN\x1bcnormal-after-reset\r\nmore\r\n";
  const shown = savedOutputPages(probe).map((page) => savedPageText(probe, page)).join("");
  assert.ok(shown.includes("before") && shown.includes("normal-after-reset") && shown.includes("more") && !shown.includes("FULLSCREEN"));
  const app = `before\n\x1b[?1049h${"frame\n".repeat(2_500)}\x1bcnormal after\n`;
  const pages = savedOutputPages(app);
  const opened = pages.findIndex((page) => page[3]);
  assert.ok(opened > 0, "no page opened inside the alternate screen");
  assert.match(savedPageText(app, pages[opened]), /normal after/, "a page opened inside the alternate screen hid output after a full reset");
});

test("saved pages project a generated stream exactly as one continuous view", () => {
  let seed = 7;
  const random = (count) => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed % count; };
  for (let round = 0; round < 300; round += 1) {
    // The generator is the oracle: it knows which output a full-screen
    // program owns (H) and which the normal screen keeps (V).
    let alternate = false;
    let buffer = "";
    const visible = [];
    for (let step = 0; step < 60; step += 1) {
      const choice = random(9);
      if (choice === 0) { buffer += `\x1b[?${["47", "1047", "1049"][random(3)]}h`; alternate = true; }
      else if (choice === 1) { buffer += `\x1b[?${["47", "1047", "1049"][random(3)]}l`; alternate = false; }
      else if (choice === 2) { buffer += "\x1bc"; alternate = false; }
      else if (choice === 3) buffer += ["\x1b[31m", "\x1b[0m", "\x1b]0;t\x07", "\x1b[3J"][random(4)];
      else {
        const token = `${alternate ? "H" : "V"}${step}.${round}${random(2) ? "\n" : " "}`;
        if (!alternate) visible.push(token.trim());
        buffer += token;
      }
    }
    const pages = savedOutputPages(buffer, 1 + random(40), 1 + random(4));
    const projections = pages.map((page) => savedPageProjection(buffer, page));
    projections.slice(0, -1).forEach((projection, index) => assert.equal(projection.alternate, pages[index + 1][3], `round ${round}: page ${index} ends on another screen than the next starts`));
    const joined = projections.map((projection) => projection.text).join("");
    assert.equal(joined, savedPageProjection(buffer, [0, buffer.length]).text, `round ${round}: pages differ from one continuous projection`);
    const plain = joined.replace(/\[[0-9;]*[mHJ]|\]0;t/g, " ");
    assert.ok(!/H\d/.test(plain), `round ${round}: full-screen output reached the saved view`);
    let at = 0;
    for (const token of visible) {
      at = plain.indexOf(token, at);
      assert.ok(at >= 0, `round ${round}: kept output ${token} is missing`);
    }
  }
});
