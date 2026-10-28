import assert from "node:assert/strict";
import test from "node:test";
import { findTerminalMatches, terminalFindQuery } from "../src/lib/terminal-search.js";

// A buffer with xterm's public shape. Each row is a list of [chars, width]
// cells; a wide character is followed by its zero-width second cell.
function buffer(cols, rows) {
  const lines = rows.map(({ cells, wrapped = false }) => {
    const padded = [...cells];
    while (padded.length < cols) padded.push(["", 1]);
    return {
      isWrapped: wrapped,
      length: cols,
      getCell: (x) => padded[x] && { getChars: () => padded[x][0], getWidth: () => padded[x][1] },
      translateToString(trimRight) {
        let end = cols;
        if (trimRight) while (end > 0 && !padded[end - 1][0]) end -= 1;
        let text = "";
        for (let x = 0; x < end; x += padded[x][1] || 1) text += padded[x][0] || " ";
        return text;
      },
    };
  });
  return { length: lines.length, getLine: (row) => lines[row] };
}
const ascii = (text) => [...text].map((char) => [char, 1]);
const row = (text, wrapped = false) => ({ cells: ascii(text), wrapped });

test("queries are literal, trimmed and Unicode case folded", () => {
  assert.equal(terminalFindQuery("  STRASSE "), "strasse");
  assert.equal(terminalFindQuery("   "), "");
  const view = buffer(12, [row("abc"), row("a.c"), row("x(a.c)")]);
  assert.deepEqual(findTerminalMatches(view, terminalFindQuery("a.c"), 12).matches,
    [{ row: 1, col: 0, length: 3 }, { row: 2, col: 2, length: 3 }]);
  assert.deepEqual(findTerminalMatches(view, "", 12), { matches: [], capped: false });
});

test("a case-expanding character maps the match back to the cells that drew it", () => {
  // "ß" folds to "ss": the folded line is longer than the cells.
  const view = buffer(16, [row("ok Straße fail")]);
  assert.deepEqual(findTerminalMatches(view, terminalFindQuery("STRASSE"), 16).matches, [{ row: 0, col: 3, length: 6 }]);
  assert.deepEqual(findTerminalMatches(view, terminalFindQuery("FAIL"), 16).matches, [{ row: 0, col: 10, length: 4 }]);
});

test("wide characters and surrogate pairs keep cell columns and widths", () => {
  const cells = [["日", 2], ["", 0], ["本", 2], ["", 0], [" ", 1], ["😀", 2], ["", 0], ...ascii(" FAIL")];
  const view = buffer(16, [{ cells }]);
  assert.deepEqual(findTerminalMatches(view, terminalFindQuery("本"), 16).matches, [{ row: 0, col: 2, length: 2 }]);
  assert.deepEqual(findTerminalMatches(view, terminalFindQuery("😀 fail"), 16).matches, [{ row: 0, col: 5, length: 7 }]);
});

test("a match on a wrapped line spans its rows", () => {
  const view = buffer(8, [row("hello wo"), row("rld", true), row("world")]);
  assert.deepEqual(findTerminalMatches(view, "world", 8).matches,
    [{ row: 0, col: 6, length: 5 }, { row: 2, col: 0, length: 5 }]);
});

test("only the newest matches are kept and the count says when there are more", () => {
  const view = buffer(10, Array.from({ length: 6 }, (_, index) => row(`x ${index} x`)));
  const capped = findTerminalMatches(view, "x", 10, 5);
  assert.equal(capped.capped, true);
  assert.deepEqual(capped.matches.map(({ row: line, col }) => [line, col]), [[3, 4], [4, 0], [4, 4], [5, 0], [5, 4]]);
  const exact = findTerminalMatches(view, "x", 10, 12);
  assert.equal(exact.capped, false);
  assert.equal(exact.matches.length, 12);
});
