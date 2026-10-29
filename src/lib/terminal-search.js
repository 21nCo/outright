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
// translateToString does; the last row of a line is trimmed. A wide
// character that did not fit in the last column wrapped to the next row and
// left an empty cell behind: that cell is padding, not a space, and is left
// out as xterm's search addon does. Folding is per code point, so folding
// each row and joining equals folding the line.
function logicalLineRows(buffer, start, end, cell) {
  const folded = [];
  for (let row = start; row <= end; row += 1) {
    const line = buffer.getLine(row);
    let text = line?.translateToString(row === end) ?? "";
    if (row < end && text.endsWith(" ") && isWidePadding(line.getCell(line.length - 1, cell)) && buffer.getLine(row + 1)?.getCell(0, cell)?.getWidth() === 2) {
      text = text.slice(0, -1);
    }
    folded.push(foldFindText(text));
  }
  return folded;
}

function isWidePadding(cell) {
  return Boolean(cell) && !cell.getChars() && cell.getWidth() === 1;
}

// Maps each folded code unit of one row to the cell that drew it. A wide
// character's second cell has width 0 and draws nothing, as in
// translateToString. Folding can expand one character into several units
// (ß -> ss); every unit of the expansion maps to that character's cell.
function rowCells(buffer, row, length, cell) {
  const line = buffer.getLine(row);
  const cols = [];
  const widths = [];
  if (!line) return { cols, widths };
  for (let col = 0; col < line.length && cols.length < length; col += 1) {
    const current = line.getCell(col, cell);
    const width = current?.getWidth() ?? 1;
    if (width === 0) continue;
    const units = foldFindText(current?.getChars() || " ").length;
    for (let unit = 0; unit < units; unit += 1) { cols.push(col); widths.push(width); }
  }
  return { cols, widths };
}

// Finds a logical line's matches from its end backwards, the rightmost
// non-overlapping occurrence first, and stops once more than `budget`
// distinct matches are found. Only rows holding a returned match are mapped
// to cells, so a long, dense wrapped line costs no more than the matches
// kept. Matches inside one expanded character (s in ß) select the same
// cells and count once. Returns them newest first.
function lineMatches(buffer, start, rows, text, query, cols, cell, budget) {
  const starts = [];
  for (let offset = 0, index = 0; index < rows.length; index += 1) { starts.push(offset); offset += rows[index].length; }
  const mapped = new Map();
  const locate = (unit) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) { const middle = (low + high + 1) >>> 1; if (starts[middle] <= unit) low = middle; else high = middle - 1; }
    if (!mapped.has(low)) mapped.set(low, rowCells(buffer, start + low, rows[low].length, cell));
    const { cols: cellCols, widths } = mapped.get(low);
    const offset = unit - starts[low];
    return cellCols[offset] === undefined ? null : { row: start + low, col: cellCols[offset], width: widths[offset] };
  };
  const found = [];
  for (let index = text.lastIndexOf(query); index >= 0 && found.length <= budget; index = index < query.length ? -1 : text.lastIndexOf(query, index - query.length)) {
    const first = locate(index);
    const last = locate(index + query.length - 1);
    if (!first || !last) continue;
    const match = { row: first.row, col: first.col, length: (last.row - first.row) * cols + last.col + last.width - first.col };
    const previous = found.at(-1);
    if (!previous || !sameMatch(previous, match)) found.push(match);
  }
  return found;
}

// Scans the buffer from its newest line upwards and returns matches in
// buffer order: { row, col, length } in cells, the shape xterm's select()
// takes. Work stops once `limit` matches are kept and one more is seen.
export function findTerminalMatches(buffer, query, cols, limit = TERMINAL_MATCH_LIMIT) {
  const newestFirst = [];
  if (!query || !buffer || !(cols > 0)) return { matches: [], capped: false };
  const cell = buffer.getNullCell?.();
  let end = buffer.length - 1;
  while (end >= 0) {
    let start = end;
    while (start > 0 && buffer.getLine(start)?.isWrapped) start -= 1;
    const rows = logicalLineRows(buffer, start, end, cell);
    const text = rows.join("");
    if (text.includes(query)) {
      const budget = limit - newestFirst.length;
      const found = lineMatches(buffer, start, rows, text, query, cols, cell, budget);
      if (found.length > budget) return { matches: [...newestFirst, ...found.slice(0, budget)].reverse(), capped: true };
      newestFirst.push(...found);
    }
    end = start - 1;
  }
  return { matches: newestFirst.reverse(), capped: false };
}

function sameMatch(left, right) {
  return left.row === right.row && left.col === right.col && left.length === right.length;
}

// Whether xterm's selection is exactly a match's cells at the current width.
// select(col, row, length) ends where xterm's SelectionModel puts it: a
// selection that ends on the right edge keeps that row's last column.
function selectionCovers(xterm, match) {
  const range = xterm.getSelectionPosition();
  if (!range) return false;
  const { cols } = xterm;
  const end = match.col + match.length;
  const last = end <= cols ? { x: end, y: match.row }
    : end % cols === 0 ? { x: cols, y: match.row + end / cols - 1 }
      : { x: end % cols, y: match.row + Math.floor(end / cols) };
  return range.start.x === match.col && range.start.y === match.row && range.end.x === last.x && range.end.y === last.y;
}

// Owns Find for one xterm view. It reads only the buffer the view shows,
// never writes to the terminal, and reports { total, capped, index, covered,
// selected } where index is -1 when no match is current and selected says
// xterm's selection is Find's highlight. A new query selects the newest match
// at or above the bottom of the view. Later output recounts without moving
// the view: a current match keeps its place by a buffer marker, and is
// dropped when its line leaves the buffer or the newest `limit` matches, a
// reflow moves it within its own line, or the buffer is reset or switched.
// The Find bar covers the top coveredRows of the view from the column
// coveredColumn() returns to the right edge. A match with a cell there is
// scrolled into the open like one outside the view. Near the top of the
// buffer the view cannot scroll that far, so covered says the current match
// is still under the bar, which then moves out of its way.
export function createTerminalSearch(xterm, onChange, { limit = TERMINAL_MATCH_LIMIT, recountMs = RECOUNT_MS, coveredRows = 0, coveredColumn = () => 0 } = {}) {
  let query = "";
  let matches = [];
  let capped = false;
  let current = null;
  // Who holds xterm's selection: "find" while it is the highlight Find drew,
  // null once the user selected, typed, pasted or cleared it.
  let selection = null;
  let selecting = false;
  let viewRows = xterm.rows;
  let heightChanged = false;
  let timer = 0;

  // The last row a match wraps onto.
  const lastRow = (match) => match.row + Math.ceil((match.col + match.length) / xterm.cols) - 1;
  // Whether any cell of a match, on each row it wraps onto, is under the bar
  // when the view's top row is `top`. The bar is measured only for a match
  // in its rows.
  const underBar = (match, top) => {
    const { cols } = xterm;
    const end = match.col + match.length;
    const first = Math.max(match.row, top);
    const last = Math.min(lastRow(match), top + coveredRows - 1);
    if (first > last) return false;
    const from = coveredColumn();
    for (let row = first; row <= last; row += 1) {
      const offset = (row - match.row) * cols;
      if (Math.min(end - offset, cols) > Math.max(from, match.col - offset)) return true;
    }
    return false;
  };
  const isCovered = () => Boolean(current) && underBar(current.match, xterm.buffer.active.viewportY);
  let covered = false;
  const publish = () => {
    covered = isCovered();
    onChange({ total: matches.length, capped, index: current ? matches.indexOf(current.match) : -1, covered, selected: selection !== null });
  };
  const scan = () => ({ matches, capped } = findTerminalMatches(xterm.buffer.active, query, xterm.cols, limit));

  function releaseSelection() {
    const own = selection === "find";
    selection = null;
    if (own && xterm.hasSelection()) xterm.clearSelection();
  }

  function drop() {
    current?.marker?.dispose();
    current = null;
    releaseSelection();
  }

  function highlight(match) {
    selecting = true;
    try { xterm.select(match.col, match.row, match.length); } finally { selecting = false; }
    selection = "find";
  }

  function select(index) {
    const match = matches[index];
    if (!match) return;
    current?.marker?.dispose();
    const buffer = xterm.buffer.active;
    // A marker follows its line as older lines are trimmed off the top,
    // lines are inserted or deleted above it, or the buffer reflows.
    const marker = xterm.registerMarker(match.row - (buffer.baseY + buffer.cursorY));
    current = { match, marker };
    highlight(match);
    // A match wrapped onto more rows is shown whole when it fits: its first
    // row goes to the middle of the view, or higher so its last row fits.
    const rows = lastRow(match) - match.row + 1;
    if (match.row < buffer.viewportY || match.row + rows > buffer.viewportY + xterm.rows || underBar(match, buffer.viewportY)) {
      const above = Math.max(0, Math.min(Math.floor(xterm.rows / 2), xterm.rows - rows));
      xterm.scrollToLine(Math.max(0, match.row - above));
    }
  }

  // xterm keeps a selection at its buffer cells when lines are inserted or
  // deleted above it or a width change reflows earlier lines, and moves it
  // with its text when older lines are trimmed. Whenever a highlight Find
  // still holds is no longer on the current match's cells, it is drawn there
  // again, without moving the view; a user's selection is left alone.
  function recount() {
    timer = 0;
    if (!query) return;
    const kept = current;
    scan();
    if (kept) {
      const { marker } = kept;
      const moved = marker && !marker.isDisposed && marker.line >= 0 ? { ...kept.match, row: marker.line } : null;
      const match = moved && matches.find((candidate) => sameMatch(candidate, moved));
      if (!match) drop();
      else {
        current = { match, marker };
        if (selection && !selectionCovers(xterm, match)) highlight(match);
      }
    }
    publish();
  }

  function schedule() {
    if (!query || timer) return;
    timer = setTimeout(recount, recountMs);
  }

  // xterm starts the user's selection when the primary button goes down but
  // reports it only on release, and a click begins with an empty selection
  // that getSelectionPosition cannot see. So the selection becomes the
  // user's on any press xterm selects with, under the conditions of its
  // SelectionService.handleMouseDown; a recount during the drag then leaves
  // it alone. A press xterm does not select with (another button, a click a
  // program tracking the mouse receives) leaves Find's highlight Find's.
  const forcesSelection = (event) => (/Mac/.test(globalThis.navigator?.platform ?? "")
    ? event.altKey && Boolean(xterm.options.macOptionClickForcesSelection)
    : event.shiftKey);
  const press = (event) => {
    if (!selection || event.button !== 0) return;
    if (xterm.modes.mouseTrackingMode !== "none" && !forcesSelection(event)) return;
    selection = null;
    publish();
  };
  xterm.element?.addEventListener("mousedown", press, true);

  const subscriptions = [
    {
      dispose: () => xterm.element?.removeEventListener("mousedown", press, true),
    },
    xterm.onWriteParsed(schedule),
    // xterm clears the selection for a change of height right after this,
    // before the resize returns.
    xterm.onResize((size) => {
      heightChanged = size.rows !== viewRows;
      viewRows = size.rows;
      queueMicrotask(() => { heightChanged = false; });
      schedule();
    }),
    // A full reset (RIS) or a switch to or from the alternate screen gives
    // the view another buffer: no earlier match is current in it.
    xterm.buffer.onBufferChange(() => { drop(); schedule(); }),
    // xterm clears the selection for typed, composed or pasted input as it
    // sends it, so that input ends Find's hold. The highlight xterm clears
    // for a change of height is drawn again at once, on its marker's row, so
    // no input or press can come before it and find nothing to clear; the
    // recount that follows the resize checks its cells as after a reflow.
    xterm.onSelectionChange(() => {
      if (selecting || !selection) return;
      const line = current?.marker?.isDisposed === false ? current.marker.line : -1;
      if (heightChanged && !xterm.hasSelection() && line >= 0) {
        heightChanged = false;
        highlight({ ...current.match, row: line });
      } else {
        selection = null;
        publish();
      }
    }),
    xterm.onScroll(() => { if (isCovered() !== covered) publish(); }),
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
