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
// The offscreen terminal's scrollback. A character adds at most a screen of
// rows (when it erases one), so a chunk of PARSE_SCROLLBACK / (4 * rows)
// characters adds at most a quarter of it, and rows are read before any is
// trimmed. A repeat (CSI b) can add more, as it can on the live view.
const PARSE_SCROLLBACK = 10_000;
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

// Saved output in chunks of about size characters, cut only between escape
// sequences and never inside a surrogate pair. A full reset is a chunk of its
// own and a scrollback erase is left out, so the view keeps earlier output.
function savedChunks(buffer, size) {
  const chunks = [];
  const spans = escapeSpans(buffer);
  let chunk = "";
  let from = 0;
  const flush = () => { if (chunk) chunks.push(chunk); chunk = ""; };
  const text = (end) => {
    while (from < end) {
      let cut = Math.min(end, from + Math.max(1, size - chunk.length));
      if (cut < end && inRange(buffer.charCodeAt(cut), 0xdc00, 0xdfff)) cut += 1;
      chunk += buffer.slice(from, cut);
      from = cut;
      if (chunk.length >= size) flush();
    }
  };
  for (let index = 0; index <= spans.length; index += 2) {
    text(index < spans.length ? spans[index] : buffer.length);
    if (index === spans.length) break;
    const sequence = buffer.slice(spans[index], spans[index + 1]);
    from = spans[index + 1];
    if (sequence === FULL_RESET) { flush(); chunks.push(FULL_RESET); }
    else if (!clearsScrollback(sequence)) chunk += sequence;
    if (chunk.length >= size) flush();
  }
  flush();
  return chunks;
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

// Saved output as the terminal showed it: parsed once by xterm at the view's
// size, then read back as the normal screen's rows, each drawn by its glyphs
// and attributes alone. A page of rows therefore needs no state from the
// output before it. A full-screen program's alternate screen is left out, as
// a terminal leaves it out once the program exits. A full reset starts a
// fresh terminal below the rows before it. Resolves with the rows, each
// starting with the line break that ends the row before unless it wraps.
export function savedOutputRows(buffer, { cols, rows }, Terminal) {
  const term = new Terminal({ cols, rows, scrollback: PARSE_SCROLLBACK, convertEol: true, scrollOnEraseInDisplay: true });
  const chunks = savedChunks(buffer, Math.max(16, Math.floor(PARSE_SCROLLBACK / (4 * rows))));
  const cell = term.buffer.normal.getNullCell();
  const out = [];
  let marker = null;
  // Rows that left the normal screen are final; at a full reset or the end,
  // the screen's rows up to the last one drawn are too.
  const read = (whole) => {
    const normal = term.buffer.normal;
    if (!whole && term.buffer.active.type !== "normal") return;
    let end = normal.baseY;
    if (whole) {
      end = normal.length;
      while (end > normal.baseY && ["", "\r\n"].includes(rowText(normal.getLine(end - 1), cols, cell, false))) end -= 1;
    }
    for (let y = marker && !marker.isDisposed ? marker.line + 1 : 0; y < end; y += 1) {
      out.push(rowText(normal.getLine(y), cols, cell, Boolean(normal.getLine(y + 1)?.isWrapped)));
    }
    marker?.dispose();
    marker = !whole && end > 0 ? term.registerMarker(end - 1 - normal.baseY - normal.cursorY) : null;
  };
  return new Promise((resolve, reject) => {
    let index = 0;
    const next = () => {
      try {
        if (index >= chunks.length || chunks[index] === FULL_RESET) read(true);
        else read(false);
        if (index >= chunks.length) {
          term.dispose();
          resolve(out);
          return;
        }
        term.write(chunks[index++], next);
      } catch (error) {
        term.dispose();
        reject(error);
      }
    };
    next();
  });
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
