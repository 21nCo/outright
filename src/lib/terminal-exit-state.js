export function pruneExitedIds(exitedIds, terminals, pending) {
  const retained = new Set(terminals.map((item) => item.id));
  // Preserve an exit observed while its activation snapshot is still pending.
  if (pending?.exit) retained.add(pending.id);
  for (const id of exitedIds) {
    if (!retained.has(id)) exitedIds.delete(id);
  }
}

// A saved session never ran in this Outright process. Its label states how it
// ended and never implies the process is still running or can resume.
export function terminalEndLabel(terminal) {
  if (terminal?.status === "ended" && terminal.endReason === "restart") return "ended when Outright restarted";
  if (terminal?.status === "ended" && terminal.endReason === "closed") return "closed; its saved output could not be deleted";
  if (terminal?.status === "ended" || terminal?.status === "exited") return `process exited ${terminal.exitCode ?? "unknown"}`;
  return "";
}

export function terminalTabLabel(terminal) {
  if (terminal.status === "ended") return `${terminal.name}, saved output, ${terminalEndLabel(terminal)}`;
  if (terminal.status === "unknown") return `${terminal.name}, ownership unverified`;
  const name = terminal.relaunchedFrom ? `${terminal.name}, new shell` : terminal.name;
  return terminal.status === "exited" ? `${name}, ${terminalEndLabel(terminal)}` : name;
}

// Reopening a worktree shows a live or unverified terminal first, then its
// newest saved session. Only when none exists does the pane start a shell.
export function preferredTerminal(terminals, previousId = "") {
  const previous = terminals.find((item) => item.id === previousId && (item.status === "running" || item.status === "ended"));
  if (previous) return previous;
  const running = terminals.find((item) => item.status === "running") ?? terminals.find((item) => item.status === "unknown");
  if (running) return running;
  let saved = null;
  for (const item of terminals) {
    if (item.status === "ended" && (!saved || String(item.endedAt ?? "") >= String(saved.endedAt ?? ""))) saved = item;
  }
  return saved;
}

const ESC = "\u001b";
const STRING_INTRODUCERS = new Set(["]", "P", "X", "^", "_"]);
const FULL_RESET = `${ESC}c`;
// Saved output keeps at most its newest MAX_SAVED_ROWS rows at the view's
// size, drawn in at most MAX_SAVED_CHARS characters, whatever its escape
// sequences expand to. Older rows are left out and the view says so.
export const MAX_SAVED_ROWS = 20_000;
export const MAX_SAVED_CHARS = 4 * 1024 * 1024;
// Characters parsed between checks that the activation is still current.
const WRITE_SLICE = 65_536;
// Rows drawn between yields to the page.
const ROW_SLICE = 1_000;
// xterm's colour modes (Attributes.CM_P16, CM_P256 and CM_RGB).
const PALETTE_16 = 0x1000000;
const PALETTE_256 = 0x2000000;
const TRUE_COLOR = 0x3000000;

const inRange = (code, low, high) => code >= low && code <= high;

// The end of the escape sequence at index: a CSI, a string (OSC, DCS, SOS,
// PM, APC) ended by BEL, ST or the next ESC, a short ESC form, or a lone ESC
// that ends the output. -1 when this ESC starts none of them.
function escapeEnd(buffer, index) {
  const next = index + 1;
  if (next === buffer.length) return next;
  const lead = buffer[next];
  if (lead === "[") {
    let at = next + 1;
    while (inRange(buffer.codePointAt(at), 0x30, 0x3f)) at += 1;
    while (inRange(buffer.codePointAt(at), 0x20, 0x2f)) at += 1;
    // An unfinished CSI is the short form ESC [.
    return inRange(buffer.codePointAt(at), 0x40, 0x7e) ? at + 1 : next + 1;
  }
  if (STRING_INTRODUCERS.has(lead)) {
    for (let at = next + 1; at < buffer.length; at += 1) {
      const code = buffer.codePointAt(at);
      if (code === 0x07) return at + 1;
      if (code === 0x1b) return buffer[at + 1] === "\\" ? at + 2 : at;
    }
    return buffer.length;
  }
  let at = next;
  while (inRange(buffer.codePointAt(at), 0x20, 0x2f)) at += 1;
  return inRange(buffer.codePointAt(at), 0x30, 0x7e) ? at + 1 : -1;
}

// Every escape sequence in buffer as [start, end, ...], in order. Saved
// output is cut into chunks only between them.
export function escapeSpans(buffer) {
  const spans = [];
  for (let index = buffer.indexOf(ESC); index >= 0;) {
    const end = escapeEnd(buffer, index);
    if (end > index) spans.push(index, end);
    index = buffer.indexOf(ESC, Math.max(end, index + 1));
  }
  return spans;
}

// Erase in display 3 (also selective, CSI ? 3 J) deletes the scrollback.
function clearsScrollback(sequence) {
  if (sequence[1] !== "[" || !sequence.endsWith("J")) return false;
  const params = sequence.slice(2, -1);
  return Number((params.startsWith("?") ? params.slice(1) : params).split(/[;:]/)[0]) === 3;
}

// A repeat (CSI Ps b) of more than limit characters repeats limit times:
// more would only scroll out rows that are left out anyway.
function clampRepeat(sequence, limit) {
  if (sequence[1] !== "[" || !sequence.endsWith("b") || !/^\d+$/.test(sequence.slice(2, -1))) return sequence;
  return Number(sequence.slice(2, -1)) > limit ? `${ESC}[${limit}b` : sequence;
}

// Saved output split at each full reset, oldest first, since a full reset
// starts a fresh terminal. Scrollback erases are left out, so the view keeps
// earlier output.
function savedSegments(buffer, repeatLimit) {
  const segments = [];
  const spans = escapeSpans(buffer);
  let segment = "";
  let from = 0;
  for (let index = 0; index < spans.length; index += 2) {
    segment += buffer.slice(from, spans[index]);
    const sequence = buffer.slice(spans[index], spans[index + 1]);
    from = spans[index + 1];
    if (sequence === FULL_RESET) {
      segments.push(segment);
      segment = "";
    } else if (!clearsScrollback(sequence)) {
      segment += clampRepeat(sequence, repeatLimit);
    }
  }
  segments.push(segment + buffer.slice(from));
  return segments;
}

function colorCodes(mode, value, base, bright, extended) {
  if (mode === PALETTE_16) return `;${value < 8 ? base + value : bright + value - 8}`;
  if (mode === PALETTE_256) return `;${extended};5;${value}`;
  if (mode === TRUE_COLOR) return `;${extended};2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}`;
  return "";
}

const FLAGS = [["isBold", 1], ["isDim", 2], ["isItalic", 3], ["isUnderline", 4], ["isBlink", 5], ["isInverse", 7], ["isInvisible", 8], ["isStrikethrough", 9], ["isOverline", 53]];

// The SGR parameters that draw a cell as the terminal drew it.
function cellStyle(cell) {
  if (cell.isAttributeDefault()) return "";
  let codes = "";
  for (const [flag, code] of FLAGS) if (cell[flag]()) codes += `;${code}`;
  codes += colorCodes(cell.getFgColorMode(), cell.getFgColor(), 30, 90, 38) + colorCodes(cell.getBgColorMode(), cell.getBgColor(), 40, 100, 48);
  return codes.slice(1);
}

const blankCell = (cell) => (cell.getChars() || " ") === " " && cell.isAttributeDefault();

// One rendered row as text and SGR, ending in the default rendition. Blank
// cells at its end are left out, unless the next row wraps from it: then it
// keeps its full width, so it wraps there again.
function rowText(line, cols, cell, full) {
  let end = cols;
  if (!full) while (end > 0 && blankCell(line.getCell(end - 1, cell))) end -= 1;
  let text = line.isWrapped ? "" : "\r\n";
  let style = "";
  for (let x = 0; x < end; x += 1) {
    line.getCell(x, cell);
    if (cell.getWidth() === 0) continue;
    const next = cellStyle(cell);
    if (next !== style) text += `${ESC}[${next ? `0;${next}` : "0"}m`;
    style = next;
    text += cell.getChars() || " ";
  }
  return style ? `${text}${ESC}[0m` : text;
}

const written = (term, data) => new Promise((resolve) => term.write(data, resolve));
const yielded = () => new Promise((resolve) => setTimeout(resolve));

// The newest rows of a parsed segment's normal screen, at most budget of them
// in at most chars characters, newest first, and whether rows before them
// were left out; null once the activation is no longer current.
async function newestRows(term, cols, { budget, chars, isCurrent }) {
  const normal = term.buffer.normal;
  const cell = normal.getNullCell();
  let end = normal.length;
  while (end > normal.baseY && ["", "\r\n"].includes(rowText(normal.getLine(end - 1), cols, cell, false))) end -= 1;
  const kept = [];
  let size = 0;
  for (let y = end - 1; y >= 0; y -= 1) {
    const text = rowText(normal.getLine(y), cols, cell, Boolean(normal.getLine(y + 1)?.isWrapped));
    // The terminal keeps budget + 1 rows, so one it trimmed is never kept.
    if (kept.length >= budget || size + text.length > chars) return { kept, size, dropped: true };
    kept.push(text);
    size += text.length;
    if (kept.length % ROW_SLICE === 0) {
      await yielded();
      if (!isCurrent()) return null;
    }
  }
  return { kept, size, dropped: false };
}

// One segment parsed at the view's size in a terminal that keeps only the
// newest budget + 1 rows, a slice at a time while the activation is current.
async function segmentRows(segment, { cols, rows }, Terminal, limits) {
  const term = new Terminal({ cols, rows, scrollback: limits.budget + 1, convertEol: true, scrollOnEraseInDisplay: true });
  try {
    for (let at = 0; at < segment.length;) {
      let cut = Math.min(segment.length, at + WRITE_SLICE);
      if (inRange(segment.codePointAt(cut), 0xdc00, 0xdfff)) cut += 1;
      await written(term, segment.slice(at, cut));
      at = cut;
      if (!limits.isCurrent()) return null;
    }
    return await newestRows(term, cols, limits);
  } finally {
    term.dispose();
  }
}

// Saved output as the terminal showed it: parsed by xterm at the view's size,
// then read back as the normal screen's rows, each drawn by its glyphs and
// attributes alone. A page of rows therefore needs no state from the output
// before it. A full-screen program's alternate screen is left out, as a
// terminal leaves it out once the program exits. A full reset starts a fresh
// terminal below the rows before it. Segments between full resets are parsed
// newest first, and parsing stops once the newest rows fill the budget.
// Resolves with the rows, each starting with the line break that ends the
// row before unless it wraps, and whether earlier rows were left out; or with
// null, without parsing further, once isCurrent returns false.
export async function savedOutputRows(buffer, { cols, rows }, Terminal, isCurrent = () => true) {
  const segments = savedSegments(buffer, (MAX_SAVED_ROWS + rows + 1) * cols);
  const kept = [];
  let budget = MAX_SAVED_ROWS;
  let chars = MAX_SAVED_CHARS;
  let dropped = false;
  for (let index = segments.length - 1; index >= 0 && !dropped; index -= 1) {
    if (!segments[index]) continue;
    if (budget <= 0 || chars <= 0) { dropped = true; break; }
    const read = await segmentRows(segments[index], { cols, rows }, Terminal, { budget, chars, isCurrent });
    if (!read) return null;
    kept.push(...read.kept);
    budget -= read.kept.length;
    chars -= read.size;
    dropped = read.dropped;
  }
  return { rows: kept.reverse(), dropped };
}

// Pages of at most size rows, about equal, newest last, each small enough
// that its first row stays in the view's scrollback. A page opens where a
// line starts, unless one wrapped line fills it.
export function savedRowPages(rows, size = 2_000) {
  const even = Math.ceil(rows.length / Math.max(1, Math.ceil(rows.length / size)));
  const opens = (index) => index === 0 || rows[index].startsWith("\r\n");
  const pages = [];
  for (let end = rows.length; end > 0 || !pages.length;) {
    let start = Math.max(0, end - even);
    let open = start;
    while (open < end && !opens(open)) open += 1;
    if (open === end) for (open = start; open > Math.max(0, end - size) && !opens(open);) open -= 1;
    if (opens(open)) start = open;
    pages.unshift([start, end]);
    end = start;
  }
  return pages;
}

// The text a read-only page writes after the view's own full reset.
export function savedPageText(rows, [start, end]) {
  const text = rows.slice(start, end).join("");
  return text.startsWith("\r\n") ? text.slice(2) : text;
}
