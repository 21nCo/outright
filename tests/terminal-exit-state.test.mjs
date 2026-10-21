import assert from "node:assert/strict";
import test from "node:test";
import xterm from "@xterm/xterm";
import { escapeSpans, preferredTerminal, pruneExitedIds, terminalEndLabel, terminalTabLabel, savedOutputRows, savedPageText, savedRowPages } from "../src/lib/terminal-exit-state.js";
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

const { Terminal } = xterm;
const SIZE = { cols: 80, rows: 24 };
const written = (term, data) => new Promise((resolve) => term.write(data, resolve));

// Each cell as the terminal draws it: glyph, colours and attributes, and
// whether its row wraps from the one before. Blank default cells at a row end
// are not drawn.
function drawnRow(line, cell) {
  let text = line.isWrapped ? "~" : "";
  let kept = text.length;
  for (let x = 0; x < SIZE.cols; x += 1) {
    line.getCell(x, cell);
    if (cell.getWidth() === 0) continue;
    const chars = cell.getChars() || " ";
    text += cell.isAttributeDefault() ? chars : `${chars}{${[cell.getFgColorMode(), cell.getFgColor(), cell.getBgColorMode(), cell.getBgColor(),
      cell.isBold(), cell.isDim(), cell.isItalic(), cell.isUnderline(), cell.isInverse(), cell.isInvisible(), cell.isStrikethrough()].join()}}`;
    if (chars !== " " || !cell.isAttributeDefault()) kept = text.length;
  }
  return text.slice(0, kept);
}

// The normal screen's rows: its scrollback and the screen up to its last
// drawn row, or the first count rows.
function drawnRows(term, count = -1) {
  const normal = term.buffer.normal;
  const cell = normal.getNullCell();
  const rows = [];
  for (let y = 0; y < normal.length; y += 1) rows.push(drawnRow(normal.getLine(y), cell));
  let end = count >= 0 ? count : rows.length;
  while (count < 0 && end > normal.baseY && !rows[end - 1].replace("~", "")) end -= 1;
  return rows.slice(0, end);
}

// The oracle: one continuous render of saved output in a terminal with the
// view's options, each full reset starting a fresh terminal below the rows
// read before it, and no scrollback erase.
async function continuous(segments) {
  // A character adds at most a screen of rows, when it erases one.
  const longest = Math.max(...segments.map((segment) => segment.length));
  const term = new Terminal({ ...SIZE, scrollback: Math.min(1_000_000, longest * SIZE.rows), convertEol: true, scrollOnEraseInDisplay: true });
  let rows = [];
  await new Promise((resolve) => segments.forEach((segment, index) => term.write(`${index ? "\x1bc" : ""}${segment}`, () => {
    rows = rows.concat(drawnRows(term));
    if (index === segments.length - 1) resolve();
  })));
  term.dispose();
  return rows;
}

// The read-only view as the pane writes it: one terminal, each page drawn
// alone after a full reset.
async function viewed(buffer, pageRows) {
  const rows = await savedOutputRows(buffer, SIZE, Terminal);
  const pages = savedRowPages(rows, pageRows);
  const term = new Terminal({ ...SIZE, scrollback: 10_000, convertEol: true });
  let shown = [];
  await new Promise((resolve) => pages.forEach(([start, end], index) => term.write(`\x1bc${savedPageText(rows, [start, end])}`, () => {
    shown = shown.concat(drawnRows(term, end - start));
    if (index === pages.length - 1) resolve();
  })));
  term.dispose();
  return { shown, pages };
}

// The oracle's rows as the pages show them. A page opens inside a wrapped
// line only when that line is longer than a page; there, the row cannot show
// that it wraps from the row before.
function paged(whole, pages, pageRows) {
  const expected = [...whole];
  for (const [start] of pages) {
    if (!whole[start]?.startsWith("~")) continue;
    let first = start;
    let last = start;
    while (first > 0 && whole[first].startsWith("~")) first -= 1;
    while (whole[last + 1]?.startsWith("~")) last += 1;
    assert.ok(last - first + 1 > pageRows, `a page opened inside a line of ${last - first + 1} rows`);
    expected[start] = whole[start].slice(1);
  }
  return expected;
}

const lines = (name, count) => Array.from({ length: count }, (_, index) => `${name} ${index}${index % 2 ? "" : ` ${"=".repeat(90)}`}\r\n`).join("");

test("saved output reads as one continuous terminal, whole and a page at a time", async () => {
  const modes = ["\x1b[5;20r", "\x1b[?6h", "\x1b[4h", "\x1b[?7l", "\x1b(0", "\x1b)0\x0e", "\x1b*0\x1bn", "\x1b[31;44m"];
  const cases = [
    // Emulator state a page boundary must not change: character sets ended by
    // DECANM, cursor saves holding a rendition or character set, the cursor
    // moving between rows, tab stops and wide characters.
    ["\x1b(0\x1b[?2h", "qqqq\r\n".repeat(3_000)],
    ["\x1b7\x1b(0\x1b8qqqq\r\n\x1b7\x1b[31m\x1b8plain\r\n\x1b[s\x1b[32m\x1b[uplain\r\n\x1b[?1048h\x1b(0\x1b[?1048lqq\r\n", lines("x", 40)],
    [`\x1b7${lines("between", 30)}\x1b8OVER\x1b[10;5HMOVED\r\n\x1bH\tTAB\x1b[3g\tafter\r\n`],
    [`${"é😀漢".repeat(4_000)}\r\n`, `\x1b]52;c;${"Q".repeat(70_000)}\x07tail\r\n`],
    // A full-screen program's screen is not the saved view's.
    ["before\r\n\x1b[34m\x1b[?1049h\x1b[2J\x1b[HFULLSCREEN", "frame\r\n".repeat(2_500), "\x1b[?1049lafter\r\n"],
    // Erasing the screen keeps the rows before it, at most a screen at a time.
    ["\x1b[24;1Hx\x1b[2J".repeat(5_000)],
  ];
  for (const parts of cases) {
    const buffer = parts.join("");
    const whole = await continuous([buffer]);
    for (const pageRows of whole.length > 4_000 ? [2_000, 997] : [2_000, 7, 2]) {
      const { shown, pages } = await viewed(buffer, pageRows);
      assert.deepEqual(shown, paged(whole, pages, pageRows), `${JSON.stringify(buffer.slice(0, 40))} in pages of ${pageRows}`);
    }
  }
  for (const mode of modes) {
    // A mode on before a full reset ends there; one on through the output
    // stays on where every page opens.
    const pre = `${lines("pre", 30)}${mode}`;
    const reset = `${pre}\x1bc${lines("post", 60)}`;
    assert.deepEqual((await viewed(reset, 13)).shown, await continuous([pre, lines("post", 60)]), `${JSON.stringify(mode)} before a reset`);
    const on = `${mode}${lines("mid", 40)}`;
    assert.deepEqual((await viewed(on, 9)).shown, await continuous([on]), `${JSON.stringify(mode)} on through the output`);
  }
  const { shown, pages } = await viewed(`\x1b(0\x1b[?2h${"qqqq\r\n".repeat(3_000)}`, 2_000);
  assert.ok(pages.length > 1 && shown.at(-1) === "qqqq", "the last page drew ASCII as line drawing");
});

test("saved output keeps every row up to the history cap, in pages the view's scrollback holds", async () => {
  const buffer = Array.from({ length: 60_000 }, (_, index) => `\x1b[3${index % 8}mline ${index}\x1b[0m\r\n`).join("");
  const rows = await savedOutputRows(buffer, SIZE, Terminal);
  assert.equal(rows.length, 60_000);
  const pages = savedRowPages(rows);
  assert.deepEqual(pages.flatMap(([start, end]) => Array.from({ length: end - start }, (_, index) => start + index)), rows.map((_, index) => index), "pages skip or repeat rows");
  assert.ok(pages.every(([start, end]) => end - start <= 2_000 && end > start));
  assert.match(savedPageText(rows, pages[0]), /^\x1b\[0;30mline 0\x1b\[0m\r\n/);
  assert.match(savedPageText(rows, pages.at(-1)), /line 59999\x1b\[0m$/);
  assert.deepEqual(savedRowPages([]), [[0, 0]]);
  assert.deepEqual(savedRowPages(rows.slice(0, 2_500)), [[0, 1_250], [1_250, 2_500]], "the earliest page holds only what the others left");
  // A page opens at the start of a wrapped line, unless the line fills it.
  assert.deepEqual(savedRowPages(["a", "b", "\r\nc", "d", "\r\ne", "f"], 3), [[0, 2], [2, 4], [4, 6]]);
  assert.deepEqual(savedRowPages(["a", "b", "c", "d"], 2), [[0, 2], [2, 4]]);
  assert.deepEqual(await savedOutputRows("", SIZE, Terminal), []);
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

test("a full reset or scrollback erase in saved output keeps the rows before it", async () => {
  const probe = "before\r\n\x1b[?1049hFULLSCREEN\x1bcnormal-after-reset\r\nmore\r\n";
  assert.deepEqual((await viewed(probe, 2_000)).shown, ["before", "normal-after-reset", "more"]);
  for (const erase of ["\x1b[3J", "\x1b[?3J", "\x1b[3;1J"]) {
    assert.deepEqual((await viewed(`${lines("a", 40)}${erase}b\r\n`, 9)).shown, await continuous([`${lines("a", 40)}b\r\n`]), `${JSON.stringify(erase)} erased saved rows`);
  }
  const app = `before\r\n\x1b[?1049h${"frame\r\n".repeat(2_500)}\x1bcnormal after\r\n`;
  assert.deepEqual((await viewed(app, 2_000)).shown, ["before", "normal after"]);
});

test("generated saved output reads the same paged as in one continuous terminal", async () => {
  let seed = 7;
  const random = (count) => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed % count; };
  const sequences = ["\x1b[31m", "\x1b[0m", "\x1b[1;7m", "\x1b[38;5;200m", "\x1b[48;2;1;2;3m", "\x1b]0;t\x07", "\x1b[2;5r", "\x1b[r", "\x1b[?6h", "\x1b[?6l",
    "\x1b[4h", "\x1b[4l", "\x1b[?7l", "\x1b[?7h", "\x1b(0", "\x1b(B", "\x1b)0", "\x0e", "\x0f", "\x1b[?2h", "\x1b[!p", "\x1b7", "\x1b8", "\x1b[s", "\x1b[u",
    "\x1b[?1048h", "\x1b[?1048l", "\x1b[?47h", "\x1b[?47l", "\x1b[?1049h", "\x1b[?1049l", "\x1b[H", "\x1b[5;9H", "\x1b[2J", "\x1b[K", "\x1b[2A", "\t", "\x1bM"];
  for (let round = 0; round < 300; round += 1) {
    // The generator knows where each full reset starts a fresh terminal and
    // leaves scrollback erases out of the oracle's stream.
    const segments = [""];
    let buffer = "";
    for (let step = 0; step < 60; step += 1) {
      const choice = random(12);
      if (choice === 0) { buffer += "\x1bc"; segments.push(""); }
      else if (choice === 1) buffer += "\x1b[3J";
      else if (choice < 5) { const sequence = sequences[random(sequences.length)]; buffer += sequence; segments[segments.length - 1] += sequence; }
      else {
        const text = `${"qx漢"[random(3)]}${step}.${round}${"=".repeat(random(3) * 40)}${random(2) ? "\r\n" : " "}`;
        buffer += text;
        segments[segments.length - 1] += text;
      }
    }
    const whole = await continuous(segments);
    const pageRows = 1 + random(12);
    const { shown, pages } = await viewed(buffer, pageRows);
    assert.deepEqual(shown, paged(whole, pages, pageRows), `round ${round}: pages differ from one continuous terminal`);
  }
});
