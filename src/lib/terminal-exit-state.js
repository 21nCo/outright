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

// A reattached terminal is the same live process that kept running across a
// restart; a relaunch is a new shell. The two are never shown alike.
export function terminalTabLabel(terminal) {
  if (terminal.status === "ended") return `${terminal.name}, saved output, ${terminalEndLabel(terminal)}`;
  if (terminal.status === "unknown") return `${terminal.name}, ownership unverified`;
  let name = terminal.name;
  if (terminal.reattached) name = `${terminal.name}, live process reattached`;
  else if (terminal.relaunchedFrom) name = `${terminal.name}, new shell`;
  return terminal.status === "exited" ? `${name}, ${terminalEndLabel(terminal)}` : name;
}

export function terminalTabBadge(terminal) {
  if (terminal.status === "ended") return "Saved";
  if (terminal.reattached) return "Reattached";
  return terminal.relaunchedFrom ? "New shell" : "";
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
// Saved output keeps at most its newest MAX_SAVED_ROWS rows at the view's
// size, drawn in at most MAX_SAVED_CHARS characters, whatever its escape
// sequences expand to. Older rows are left out and the view says so.
export const MAX_SAVED_ROWS = 20_000;
export const MAX_SAVED_CHARS = 4 * 1024 * 1024;
// Parse work written between checks that the activation is still current; a
// character weighs 1, a sequence about as long as xterm takes to run it.
const WORK_SLICE = 2 ** 19;
// The longest text written as one piece, and read between yields.
const TEXT_SLICE = 32_768;
const SCAN_SLICE = 2 ** 18;
// Rows drawn between yields to the page.
const ROW_SLICE = 1_000;
// xterm's colour modes (Attributes.CM_P16, CM_P256 and CM_RGB).
const PALETTE_16 = 0x1000000;
const PALETTE_256 = 0x2000000;
const TRUE_COLOR = 0x3000000;
// xterm keeps a parameter at most this large.
const MAX_PARAM = 0x7fffffff;
// An OSC xterm 6.0.0 leaves unhandled. Each shortened repeat is followed by
// one that says how many periods it left out.
const REPEAT_HOOK = 7357;
// Plain CSI finals whose work grows with their first parameter, and the count
// past which they end as that count does: scrolling, inserting or deleting
// more lines than the screen holds, or tabbing past every column.
const COUNT_LIMITS = { S: "rows", T: "rows", L: "rows", M: "rows", I: "cols", Z: "cols" };
// The parser states a sequence passes through, and the codes that start one
// anywhere.
const [GROUND, ESCAPE, ESCAPE_INTERMEDIATE, CSI, CSI_PARAM, CSI_INTERMEDIATE, CSI_IGNORE, OSC, STRING] = [0, 1, 2, 3, 4, 5, 6, 7, 8];
const STARTS = new Map([[0x1b, ESCAPE], [0x9b, CSI], [0x9d, OSC], [0x90, STRING], [0x98, STRING], [0x9e, STRING], [0x9f, STRING]]);
// ESC [ starts a CSI, ESC ] an OSC, and ESC P, X, ^ and _ the other strings.
const ESCAPE_STRINGS = new Map([[0x5b, CSI], [0x5d, OSC], [0x50, STRING], [0x58, STRING], [0x5e, STRING], [0x5f, STRING]]);

const written = (term, data) => new Promise((resolve) => term.write(data, resolve));
const yielded = () => new Promise((resolve) => setTimeout(resolve));
const inRange = (code, low, high) => code >= low && code <= high;
// The C0 controls xterm runs where it finds them outside a string.
const executed = (code) => code <= 0x17 || code === 0x19 || inRange(code, 0x1c, 0x1f);
// CAN, SUB, ST and the other C1 controls end any sequence.
const ending = (code) => code === 0x18 || code === 0x1a || inRange(code, 0x80, 0x8f) || inRange(code, 0x91, 0x97) || code === 0x99 || code === 0x9a || code === 0x9c;

// A reader that calls visit with each control sequence in buffer as xterm
// 6.0.0's VT500 parser reads it, in order: { start, end, kind, prefix,
// params, intermediates, final, controls }. kind is "csi" or "esc" once
// dispatched, "string" for an OSC, DCS, SOS, PM or APC, and "ignored" for one
// xterm drops. controls are the C0 controls xterm runs inside it. The text
// between them is printed. Each call reads on to index end.
function controlScanner(buffer, visit) {
  let state = GROUND;
  let token = null;
  let at = 0;
  const finish = (end, kind = state >= OSC ? "string" : "ignored", final = "") => {
    Object.assign(token, { end, kind, final });
    visit(token);
    state = GROUND;
  };
  const read = (index) => {
    const code = Math.min(buffer.charCodeAt(index), 0xa0);
    if (code === 0x1b && state >= OSC && buffer.charCodeAt(index + 1) === 0x5c) {
      // ESC \ ends a string as one terminator.
      finish(index + 2);
      at += 1;
    } else if (STARTS.has(code)) {
      if (state !== GROUND) finish(index);
      state = STARTS.get(code);
      token = { start: index, prefix: "", params: "", intermediates: "", controls: "" };
    } else if (ending(code)) {
      finish(index + 1);
    } else if (state === OSC) {
      if (code === 0x07) finish(index + 1);
    } else if (state === STRING || code === 0x7f) {
      // DCS, SOS, PM and APC end only where any sequence ends; DEL is ignored.
    } else if (executed(code)) {
      token.controls += buffer[index];
    } else if (state === CSI_IGNORE) {
      if (inRange(code, 0x40, 0x7e)) finish(index + 1);
    } else if (code === 0xa0) {
      const pair = inRange(buffer.charCodeAt(index), 0xd800, 0xdbff) ? 1 : 0;
      at += pair;
      finish(index + 1 + pair);
    } else if (state <= ESCAPE_INTERMEDIATE) {
      state = escapeStep(state, code, index, buffer, token, finish);
    } else {
      state = csiStep(state, code, index, buffer, token, finish);
    }
  };
  return (end) => {
    for (; at < end; at += 1) {
      // Printed text runs on to the next code that starts a sequence.
      const code = buffer.charCodeAt(at);
      if (state !== GROUND || code === 0x1b || (code >= 0x90 && STARTS.has(code))) read(at);
    }
    if (end >= buffer.length && state !== GROUND) finish(buffer.length);
  };
}

// The state after code in an ESC sequence.
function escapeStep(state, code, at, buffer, token, finish) {
  if (state === ESCAPE && ESCAPE_STRINGS.has(code)) return ESCAPE_STRINGS.get(code);
  if (inRange(code, 0x20, 0x2f)) {
    token.intermediates += buffer[at];
    return ESCAPE_INTERMEDIATE;
  }
  finish(at + 1, "esc", buffer[at]);
  return GROUND;
}

// The state after code, 0x20 to 0x7e, in a CSI.
function csiStep(state, code, at, buffer, token, finish) {
  if (inRange(code, 0x40, 0x7e)) {
    finish(at + 1, "csi", buffer[at]);
    return GROUND;
  }
  if (inRange(code, 0x20, 0x2f)) {
    token.intermediates += buffer[at];
    return CSI_INTERMEDIATE;
  }
  if (state === CSI_INTERMEDIATE || (state === CSI_PARAM && code >= 0x3c)) return CSI_IGNORE;
  if (code >= 0x3c) token.prefix = buffer[at];
  else token.params += buffer[at];
  return CSI_PARAM;
}

// Every control sequence in buffer as [start, end, ...], in order.
export function escapeSpans(buffer) {
  const spans = [];
  controlScanner(buffer, ({ start, end }) => spans.push(start, end))(buffer.length);
  return spans;
}

// The first parameter as xterm reads it, 0 when it is left out, and the
// parameters after it.
function firstParam(params) {
  const end = params.search(/[:;]/);
  const digits = end < 0 ? params : params.slice(0, end);
  return [digits ? Math.min(Number(digits), MAX_PARAM) : 0, end < 0 ? "" : params.slice(end)];
}

// A repeat longer than settled characters is shortened by whole periods. Once
// it has filled the screen with the repeated character, each period, whole
// rows of 1- or 2-column characters, writes the same rows again and leaves
// the cursor where it was.
function repeatRule(cols, rows) {
  const half = Math.max(1, Math.floor(cols / 2));
  const period = (cols / divisor(cols, half)) * half;
  return { period, settled: (2 * rows + 1) * cols + period };
}

const divisor = (a, b) => (b ? divisor(b, a % b) : a);

// Saved output split at each full reset, oldest first, since a full reset
// starts a fresh terminal, each segment as its writes of about WORK_SLICE
// work. Scrollback erases are left out, so the view keeps earlier output. A
// count that does more than the screen can show is cut to the count with the
// same result. A long repeat is shortened by whole periods and followed by
// the REPEAT_HOOK that says how many it left out; repeats of one character
// with only that character between them join first. A repeat after a
// control repeats nothing, so it is left out.
async function savedSegments(buffer, cols, rows, isCurrent) {
  const { period, settled } = repeatRule(cols, rows);
  const segments = [];
  let writes = [];
  let data = "";
  let work = 0;
  let from = 0;
  let previous = null;
  let held = null;
  const emit = (text, weight = text.length) => {
    data += text;
    work += weight;
    if (work < WORK_SLICE) return;
    writes.push(data);
    data = "";
    work = 0;
  };
  const emitText = (text) => {
    for (let at = 0; at < text.length;) {
      let end = Math.min(text.length, at + TEXT_SLICE);
      if (inRange(text.charCodeAt(end - 1), 0xd800, 0xdbff)) end += 1;
      const piece = text.slice(at, end);
      emit(piece, piece.length + (piece.split("\n").length - 1) * (cols >> 3));
      at = end;
    }
  };
  // A repeat reads only its first parameter, so a repeat with more than one
  // is only ever a shortened one.
  const emitRepeat = (count, verbatim) => {
    if (count <= settled) {
      emit(verbatim ?? `${ESC}[${count}b`, count);
      return;
    }
    const kept = settled + ((count - settled) % period);
    emit(`${ESC}[${kept};1b${ESC}]${REPEAT_HOOK};${(count - kept) / period}\u0007`, kept);
  };
  const release = () => {
    if (held) emitRepeat(held.count, held.verbatim);
    held = null;
  };
  const close = () => {
    release();
    if (data) writes.push(data);
    segments.push(writes);
    writes = [];
    data = "";
    work = 0;
  };
  const repeat = (token, gap, count) => {
    if (held && !token.controls && gap && gap === held.char.repeat(gap.length)) {
      held = { ...held, count: held.count + gap.length + count, verbatim: null };
      return;
    }
    release();
    emitText(gap);
    const last = gap.charCodeAt(gap.length - 1);
    if (token.controls || (!gap && previous?.kind === "csi") || executed(last)) {
      emit(token.controls);
      return;
    }
    const verbatim = /^\d*$/.test(token.params) ? buffer.slice(token.start, token.end) : null;
    if (inRange(last, 0x20, 0x7e)) held = { char: gap.at(-1), count, verbatim };
    else emitRepeat(count, verbatim);
  };
  const scan = controlScanner(buffer, (token) => {
    const gap = buffer.slice(from, token.start);
    const { kind, prefix, intermediates, final, controls } = token;
    const plain = kind === "csi" && !prefix && !intermediates;
    const [first, rest] = firstParam(token.params);
    const count = first || 1;
    from = token.end;
    if (plain && final === "b") {
      repeat(token, gap, count);
    } else {
      release();
      emitText(gap);
      if (kind === "esc" && final === "c" && !intermediates) {
        emit(controls);
        close();
      } else if (kind === "csi" && final === "J" && !intermediates && (!prefix || prefix === "?") && first === 3) {
        emit(controls);
      } else if (plain && COUNT_LIMITS[final]) {
        const lines = COUNT_LIMITS[final] === "rows";
        const limit = lines ? rows : cols;
        const weight = Math.min(count, limit) * (lines ? cols >> 2 : 1);
        emit(count > limit ? `${controls}${ESC}[${limit}${rest}${final}` : buffer.slice(token.start, token.end), weight);
      } else {
        emit(buffer.slice(token.start, token.end), final === "J" ? (rows * cols) >> 3 : undefined);
      }
    }
    previous = token;
  });
  for (let end = 0; end < buffer.length;) {
    end = Math.min(buffer.length, end + SCAN_SLICE);
    scan(end);
    if (end === buffer.length) break;
    await yielded();
    if (!isCurrent()) return null;
  }
  release();
  emitText(buffer.slice(from));
  close();
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

// The rows shortened repeats left out, read from the REPEAT_HOOK after each.
// A repeat that pushed rows into the scrollback would have pushed one copy of
// the full row at the top of the screen it ended with for each row the left
// out periods hold, just above that screen. Each run of copies is kept as
// { at, count, whole, last }: the absolute row it follows, counting the rows
// trimmed since the terminal started, and the copy drawn where the next row
// wraps from it or not. Runs past the row budget are let go.
function leftOutRepeats(term, cols, period, budget) {
  const runs = [];
  let before = null;
  // A scrollback row, which moves only as older rows are trimmed.
  let gauge = null;
  let placed = 0;
  let trimmed = 0;
  const trims = () => (gauge?.isDisposed ? Infinity : trimmed + placed - (gauge?.line ?? placed));
  term.parser.registerCsiHandler({ final: "b" }, (params) => {
    if (params.length < 2) return false;
    before?.dispose();
    const active = term.buffer.active;
    before = active.type === "normal" ? term.registerMarker(-active.cursorY) : null;
    return false;
  });
  term.parser.registerOscHandler(REPEAT_HOOK, (data) => {
    if (!before) return false;
    const normal = term.buffer.normal;
    const pushed = before.isDisposed || before.line < normal.baseY;
    before.dispose();
    before = null;
    if (!pushed) return true;
    const cell = normal.getNullCell();
    const top = normal.getLine(normal.baseY);
    const count = (Number(data) * period) / Math.floor(cols / (top.getCell(0, cell).getWidth() || 1));
    const total = trims();
    if (total === Infinity || count > budget) runs.length = 0;
    trimmed = total === Infinity ? 0 : total;
    placed = normal.baseY - 1;
    gauge?.dispose();
    gauge = term.registerMarker(-term.buffer.active.cursorY - 1);
    while (runs.length && normal.length - (runs[0].at - trimmed) > budget + 1) runs.shift();
    runs.push({ at: placed + trimmed, count, whole: rowText(top, cols, cell, true), last: rowText(top, cols, cell, false) });
    return true;
  });
  return { runs, trims };
}

// The newest rows of a parsed segment's normal screen, at most budget of them
// in at most chars characters, newest first, with the copies shortened
// repeats left out in their place, and whether rows before them were left
// out; null once the activation is no longer current.
async function newestRows(term, cols, { budget, chars, isCurrent }, repeats) {
  const normal = term.buffer.normal;
  const cell = normal.getNullCell();
  let end = normal.length;
  while (end > normal.baseY && ["", "\r\n"].includes(rowText(normal.getLine(end - 1), cols, cell, false))) end -= 1;
  const kept = [];
  let size = 0;
  // Keeps text as the next older row: false once the budget is full, null
  // once the activation is superseded. The terminal keeps budget + 1 rows,
  // so one it trimmed is never kept.
  const keep = async (text) => {
    if (kept.length >= budget || size + text.length > chars) return false;
    kept.push(text);
    size += text.length;
    if (kept.length % ROW_SLICE === 0) {
      await yielded();
      if (!isCurrent()) return null;
    }
    return true;
  };
  const stop = (status) => (status === null ? null : { kept, size, dropped: true });
  const { runs } = repeats;
  const trims = repeats.trims();
  let run = runs.length - 1;
  for (let y = end - 1; y >= 0; y -= 1) {
    let full = Boolean(normal.getLine(y + 1)?.isWrapped);
    for (; run >= 0 && runs[run].at - trims >= y; run -= 1) {
      if (runs[run].at - trims > y) continue;
      const { count, whole, last } = runs[run];
      for (let copy = 0; copy < count; copy += 1) {
        const status = await keep(full ? whole : last);
        if (status !== true) return stop(status);
        full = true;
      }
    }
    const status = await keep(rowText(normal.getLine(y), cols, cell, full));
    if (status !== true) return stop(status);
  }
  return { kept, size, dropped: false };
}

// One segment parsed at the view's size in a terminal that keeps only the
// newest budget + 1 rows, a write at a time while the activation is current.
async function segmentRows(writes, { cols, rows }, Terminal, limits) {
  const term = new Terminal({ cols, rows, scrollback: limits.budget + 1, convertEol: true, scrollOnEraseInDisplay: true });
  try {
    const repeats = leftOutRepeats(term, cols, repeatRule(cols, rows).period, limits.budget);
    for (const data of writes) {
      await written(term, data);
      if (!limits.isCurrent()) return null;
    }
    return await newestRows(term, cols, limits, repeats);
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
// newest first, and parsing stops once the newest rows fill the budget. The
// work any sequence adds is bounded by the screen, whatever its count.
// Resolves with the rows, each starting with the line break that ends the
// row before unless it wraps, and whether earlier rows were left out; or with
// null, without parsing further, once isCurrent returns false.
export async function savedOutputRows(buffer, { cols, rows }, Terminal, isCurrent = () => true) {
  const segments = await savedSegments(buffer, cols, rows, isCurrent);
  if (!segments) return null;
  const kept = [];
  let budget = MAX_SAVED_ROWS;
  let chars = MAX_SAVED_CHARS;
  let dropped = false;
  for (let index = segments.length - 1; index >= 0 && !dropped; index -= 1) {
    if (!segments[index].length) continue;
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
