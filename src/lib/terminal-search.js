import { foldFindText } from "./find-text.js";

// A common query in a long log can match in most rows. Only the newest
// matches are kept and navigable; the count says when there are more.
export const TERMINAL_MATCH_LIMIT = 1000;
// Output that keeps arriving recounts at most this often while Find is open.
const RECOUNT_MS = 200;

// Terminal Find is literal and uses the same Unicode case folding as the
// conversation and diff Find, so "STRASSE" finds "Straße".
export function terminalFindQuery(value) {
  return foldFindText(String(value ?? "").trim());
}

// Logical lines join the rows a long line wrapped onto, so a match can span
// rows. A row continued on the next keeps its trailing blank cells, as
// translateToString does; the last row of a line is trimmed.
function logicalLineText(buffer, start, end) {
  let text = "";
  for (let row = start; row <= end; row += 1) text += buffer.getLine(row)?.translateToString(row === end) ?? "";
  return text;
}

// Each source code unit maps to the cell that drew it. A wide character's
// second cell has width 0 and draws nothing, as in translateToString.
function lineCells(buffer, start, end, cell) {
  let text = "";
  const cells = [];
  for (let row = start; row <= end; row += 1) {
    const line = buffer.getLine(row);
    if (!line) continue;
    const kept = row === end ? line.translateToString(true).length : Infinity;
    let rowText = "";
    for (let col = 0; col < line.length && rowText.length < kept; col += 1) {
      const current = line.getCell(col, cell);
      const width = current?.getWidth() ?? 1;
      if (width === 0) continue;
      const chars = current?.getChars() || " ";
      for (let unit = 0; unit < chars.length; unit += 1) cells.push({ row, col, width });
      rowText += chars;
    }
    text += rowText;
  }
  return { text, cells };
}

// Folding can expand one character into several (ß -> ss), so each folded
// code unit records the source code unit its character started at.
function foldWithOffsets(text) {
  let folded = "";
  const sources = [];
  let offset = 0;
  for (const point of text) {
    const foldedPoint = foldFindText(point);
    for (let unit = 0; unit < foldedPoint.length; unit += 1) sources.push(offset);
    folded += foldedPoint;
    offset += point.length;
  }
  return { folded, sources };
}

function lineMatches(buffer, start, end, query, cols, cell) {
  const { text, cells } = lineCells(buffer, start, end, cell);
  const { folded, sources } = foldWithOffsets(text);
  const found = [];
  for (let index = folded.indexOf(query); index >= 0; index = folded.indexOf(query, index + query.length)) {
    const first = cells[sources[index]];
    const last = cells[sources[index + query.length - 1]];
    if (!first || !last) continue;
    found.push({ row: first.row, col: first.col, length: (last.row - first.row) * cols + last.col + last.width - first.col });
  }
  return found;
}

// Scans the buffer from its newest line upwards and returns matches in
// buffer order: { row, col, length } in cells, the shape xterm's select()
// takes. A line is mapped to cells only when its text contains the query.
export function findTerminalMatches(buffer, query, cols, limit = TERMINAL_MATCH_LIMIT) {
  const newestFirst = [];
  if (!query || !buffer || !(cols > 0)) return { matches: [], capped: false };
  const cell = buffer.getNullCell?.();
  let end = buffer.length - 1;
  while (end >= 0) {
    let start = end;
    while (start > 0 && buffer.getLine(start)?.isWrapped) start -= 1;
    if (foldFindText(logicalLineText(buffer, start, end)).includes(query)) {
      const found = lineMatches(buffer, start, end, query, cols, cell);
      for (let index = found.length - 1; index >= 0; index -= 1) {
        if (newestFirst.length === limit) return { matches: newestFirst.reverse(), capped: true };
        newestFirst.push(found[index]);
      }
    }
    end = start - 1;
  }
  return { matches: newestFirst.reverse(), capped: false };
}

function sameMatch(left, right) {
  return left.row === right.row && left.col === right.col && left.length === right.length;
}

// Owns Find for one xterm view. It reads only the buffer the view shows,
// never writes to the terminal, and reports { total, capped, index } where
// index is -1 when no match is current. A new query selects the newest match
// at or above the bottom of the view. Later output recounts without moving
// the view: a current match keeps its place by a buffer marker, and is
// dropped when its line leaves the buffer or the buffer is reset or switched.
// A match in the top coveredRows of the view, under the Find bar, is
// scrolled into the open like one outside the view.
export function createTerminalSearch(xterm, onChange, { limit = TERMINAL_MATCH_LIMIT, recountMs = RECOUNT_MS, coveredRows = 0 } = {}) {
  let query = "";
  let matches = [];
  let capped = false;
  let current = null;
  let ownSelection = false;
  let selecting = false;
  let timer = 0;

  const publish = () => onChange({ total: matches.length, capped, index: current ? matches.indexOf(current.match) : -1 });
  const scan = () => ({ matches, capped } = findTerminalMatches(xterm.buffer.active, query, xterm.cols, limit));

  function releaseSelection() {
    if (ownSelection && xterm.hasSelection()) xterm.clearSelection();
    ownSelection = false;
  }

  function drop() {
    current?.marker?.dispose();
    current = null;
    releaseSelection();
  }

  function select(index) {
    const match = matches[index];
    if (!match) return;
    current?.marker?.dispose();
    const buffer = xterm.buffer.active;
    // A marker follows its line as older lines are trimmed off the top.
    const marker = xterm.registerMarker(match.row - (buffer.baseY + buffer.cursorY));
    current = { match, marker };
    selecting = true;
    try { xterm.select(match.col, match.row, match.length); } finally { selecting = false; }
    ownSelection = true;
    if (match.row < buffer.viewportY + coveredRows || match.row >= buffer.viewportY + xterm.rows) {
      xterm.scrollToLine(Math.max(0, match.row - Math.floor(xterm.rows / 2)));
    }
  }

  function recount() {
    timer = 0;
    if (!query) return;
    const kept = current;
    scan();
    if (kept) {
      const { marker } = kept;
      const moved = marker && !marker.isDisposed && marker.line >= 0 ? { ...kept.match, row: marker.line } : null;
      const match = moved && matches.find((candidate) => sameMatch(candidate, moved));
      if (match) current = { match, marker };
      else drop();
    }
    publish();
  }

  function schedule() {
    if (!query || timer) return;
    timer = setTimeout(recount, recountMs);
  }

  const subscriptions = [
    xterm.onWriteParsed(schedule),
    xterm.onResize(schedule),
    // A full reset (RIS) or a switch to or from the alternate screen gives
    // the view another buffer: no earlier match is current in it.
    xterm.buffer.onBufferChange(() => { drop(); schedule(); }),
    xterm.onSelectionChange(() => { if (!selecting) ownSelection = false; }),
  ];

  return {
    // Typing a query searches at once and selects its newest visible match.
    setQuery(value) {
      const next = terminalFindQuery(value);
      clearTimeout(timer);
      timer = 0;
      drop();
      query = next;
      matches = [];
      capped = false;
      if (query) {
        scan();
        const buffer = xterm.buffer.active;
        const bottom = buffer.viewportY + xterm.rows - 1;
        let index = -1;
        for (let candidate = matches.length - 1; candidate >= 0 && index < 0; candidate -= 1) {
          if (matches[candidate].row <= bottom) index = candidate;
        }
        select(index < 0 ? 0 : index);
      }
      publish();
    },
    // Next moves down to newer output and Previous up to older output, each
    // wrapping. With no current match they start from the view.
    step(direction) {
      if (!query) return;
      if (timer) { clearTimeout(timer); recount(); }
      if (!matches.length) { publish(); return; }
      let index = current ? matches.indexOf(current.match) : -1;
      if (index >= 0) index = (index + direction + matches.length) % matches.length;
      else {
        const buffer = xterm.buffer.active;
        const top = buffer.viewportY;
        const bottom = top + xterm.rows - 1;
        index = direction > 0 ? matches.findIndex((match) => match.row >= top) : matches.findLastIndex((match) => match.row <= bottom);
        if (index < 0) index = direction > 0 ? 0 : matches.length - 1;
      }
      select(index);
      publish();
    },
    // Closing Find stops recounting and removes its selection.
    clear() {
      clearTimeout(timer);
      timer = 0;
      drop();
      query = "";
      matches = [];
      capped = false;
      publish();
    },
    dispose() {
      clearTimeout(timer);
      timer = 0;
      current?.marker?.dispose();
      current = null;
      for (const subscription of subscriptions) subscription.dispose();
    },
  };
}
