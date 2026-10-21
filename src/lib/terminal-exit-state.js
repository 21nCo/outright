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
const CLEAR_SCROLLBACK = `${ESC}[3J`;
const SHIFT_OUT = "\u000e";
const SHIFT_IN = "\u000f";
const DESIGNATORS = "()*+";
const SHIFTS = ["", SHIFT_OUT, `${ESC}n`, `${ESC}o`];
// Text written after saved output reads as plain text: no insert mode, line
// wrapping on, ASCII in every character set and the default rendition.
export const PLAIN_TEXT = `${ESC}[4l${ESC}[?7h${ESC}(B${ESC})B${ESC}*B${ESC}+B${SHIFT_IN}${ESC}[0m`;
// A full reset in saved output resets every mode the view tracks, as the
// reset did, and clears the screen, which the read-only view scrolls into its
// scrollback, so the output before it stays readable.
const RESET_VIEW = `${ESC}[r${ESC}[?6l${PLAIN_TEXT}${ESC}[H${ESC}[2J`;
const ALT_SCREEN_MODES = new Set(["47", "1047", "1049"]);
const SGR_OFF = { 22: ["1", "2"], 23: ["3"], 24: ["4"], 25: ["5"], 27: ["7"], 28: ["8"], 29: ["9"], 39: ["fg"], 49: ["bg"], 55: ["53"], 59: ["ul"] };
const SGR_COLOR = { 38: "fg", 48: "bg", 58: "ul" };

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

// Every escape sequence in buffer as [start, end, ...], in order. Page
// boundaries and the read-only projection both read this one tokenizer.
export function escapeSpans(buffer) {
  const spans = [];
  for (let index = buffer.indexOf(ESC); index >= 0;) {
    const end = escapeEnd(buffer, index);
    if (end > index) spans.push(index, end);
    index = buffer.indexOf(ESC, Math.max(end, index + 1));
  }
  return spans;
}

function applySgr(state, params) {
  const list = params ? params.split(";") : ["0"];
  for (let index = 0; index < list.length; index += 1) {
    const value = list[index];
    const code = Number(value.split(":")[0] || 0);
    if (code === 0) state.clear();
    else if (SGR_OFF[code]) for (const key of SGR_OFF[code]) state.delete(key);
    else if (SGR_COLOR[code]) {
      let take = 0;
      if (!value.includes(":")) take = { 5: 2, 2: 4 }[list[index + 1]] ?? 0;
      state.set(SGR_COLOR[code], list.slice(index, index + take + 1).join(";"));
      index += take;
    } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) state.set("fg", value);
    else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) state.set("bg", value);
    else state.set(String({ 6: 5, 21: 4 }[code] ?? code), value);
  }
}

const freshModes = () => ({ margins: "", origin: false, insert: false, nowrap: false, charsets: ["B", "B", "B", "B"], shift: 0 });
const freshContext = () => ({ state: new Map(), saved: null, alternate: false, modes: freshModes() });
const copyContext = ({ state, saved, alternate, modes }) => ({ state: new Map(state), saved: saved && new Map(saved), alternate, modes: { ...modes, charsets: [...modes.charsets] } });
const sgr = (rendition) => rendition.size ? `${ESC}[${[...rendition.values()].join(";")}m` : "";

// The sequences that restore the modes a page opens with after the view's
// own full reset: character sets and shift, then scroll margins, origin,
// insert and wrap modes.
function modesText({ margins, origin, insert, nowrap, charsets, shift }) {
  let text = charsets.map((set, slot) => set === "B" ? "" : `${ESC}${DESIGNATORS[slot]}${set}`).join("") + SHIFTS[shift];
  if (margins) text += `${ESC}[${margins}r`;
  if (origin) text += `${ESC}[?6h`;
  if (insert) text += `${ESC}[4h`;
  return nowrap ? `${text}${ESC}[?7l` : text;
}

// Scroll margins as set, or "" for the whole screen. Margins the terminal
// refuses leave the previous ones in effect.
function setMargins(modes, params) {
  const [top = 0, bottom = 0] = params.split(";").map(Number);
  if (bottom && Math.max(top, 1) >= bottom) return;
  modes.margins = top > 1 || bottom ? params : "";
}

function setMode(modes, mode, on) {
  if (mode === "?6") modes.origin = on;
  else if (mode === "4") modes.insert = on;
  else if (mode === "?7") modes.nowrap = !on;
}

// The alternate screen with mode 1049 restores the rendition it saved.
function switchScreen(context, mode, enter) {
  if (mode === "1049" && enter) context.saved = new Map(context.state);
  else if (mode === "1049" && context.saved) Object.assign(context, { state: context.saved, saved: null });
  context.alternate = enter;
}

function trackCsi(context, body) {
  if (body === "!p") {
    context.state.clear();
    if (!context.alternate) context.modes = freshModes();
    return "";
  }
  const csi = /^(\??)([0-9:;]*)([hlmr])$/.exec(body);
  if (!csi) return "";
  const [, prefix, params, final] = csi;
  if (final === "m" || final === "r") {
    if (!prefix && final === "m") applySgr(context.state, params);
    else if (!prefix && !context.alternate) setMargins(context.modes, params);
    return "";
  }
  let kind = "";
  for (const mode of params.split(";")) {
    if (prefix && ALT_SCREEN_MODES.has(mode)) {
      switchScreen(context, mode, final === "h");
      kind = "screen";
    } else if (!context.alternate) setMode(context.modes, prefix + mode, final === "h");
  }
  return kind;
}

// Follows the rendition, screen and modes a sequence leaves in effect, and
// says whether it reset the terminal or switched screens. Modes a full-screen
// program sets on the alternate screen are not the saved view's.
function trackSequence(context, sequence) {
  if (sequence === FULL_RESET) {
    Object.assign(context, freshContext());
    return "reset";
  }
  if (sequence[1] === "[") return trackCsi(context, sequence.slice(2));
  if (context.alternate) return "";
  const slot = DESIGNATORS.indexOf(sequence[1]);
  if (slot >= 0 && sequence.length > 2) context.modes.charsets[slot] = sequence.slice(2);
  else if (sequence === SHIFTS[2] || sequence === SHIFTS[3]) context.modes.shift = SHIFTS.indexOf(sequence);
  return "";
}

// Shift out and shift in are plain-text controls; the last one wins.
function trackText(context, text) {
  if (context.alternate) return;
  const out = text.lastIndexOf(SHIFT_OUT);
  const back = text.lastIndexOf(SHIFT_IN);
  if (out !== back) context.modes.shift = out > back ? 1 : 0;
}

// A page boundary inside an escape sequence moves past it, or to its start
// when the sequence reaches the page end. spans is [start, end, ...] sorted.
function outsideEscape(spans, index, end) {
  let low = 0;
  let high = spans.length / 2;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (spans[middle * 2] < index) low = middle + 1;
    else high = middle;
  }
  const span = (low - 1) * 2;
  if (span < 0 || spans[span + 1] <= index) return index;
  return spans[span + 1] < end ? spans[span + 1] : spans[span];
}

// The start of the page that ends at end: at most maxLines line breaks and
// maxChars characters, on a line boundary where one exists, never inside a
// surrogate pair.
function pageStart(buffer, end, maxChars, maxLines) {
  const floor = Math.max(0, end - maxChars);
  let start = floor;
  let lines = 0;
  for (let index = buffer.lastIndexOf("\n", end - 1); index >= floor; index = buffer.lastIndexOf("\n", index - 1)) {
    lines += 1;
    if (lines > maxLines) { start = index + 1; break; }
    if (index === 0) break;
  }
  if (start === floor && start > 0) {
    const lineStart = buffer.indexOf("\n", start) + 1;
    if (lineStart > 0 && lineStart < end) start = lineStart;
  }
  const code = buffer.codePointAt(start);
  if (start > 0 && start < end - 1 && code >= 0xdc00 && code <= 0xdfff) start += 1;
  return start;
}

// Saved output can hold up to the 2 MiB history cap, more than one terminal
// view keeps. It is shown in pages, newest last, each small enough that its
// first line stays in the view's scrollback, and never starting inside an
// escape sequence. Each page is [start, end, prefix, alternate, context]: the
// modes, rendition, screen and parser context the output before it leaves in
// effect.
export function savedOutputPages(buffer, maxChars = 64_000, maxLines = 2_000) {
  const spans = escapeSpans(buffer);
  const starts = [];
  for (let end = buffer.length; end > 0;) {
    const start = outsideEscape(spans, pageStart(buffer, end, maxChars, maxLines), end);
    starts.push(start);
    end = start;
  }
  return pagesFrom(buffer, spans, starts.reverse());
}

// Pages starting at the given ascending offsets, none inside an escape sequence.
export function savedPagesAt(buffer, starts) {
  return pagesFrom(buffer, escapeSpans(buffer), starts);
}

function pagesFrom(buffer, spans, starts) {
  const context = freshContext();
  let span = 0;
  let from = 0;
  return starts.map((start, index) => {
    for (; span < spans.length && spans[span] < start; span += 2) {
      trackText(context, buffer.slice(from, spans[span]));
      trackSequence(context, buffer.slice(spans[span], spans[span + 1]));
      from = spans[span + 1];
    }
    trackText(context, buffer.slice(from, start));
    from = start;
    const prefix = modesText(context.modes) + sgr(context.alternate && context.saved ? context.saved : context.state);
    return [start, starts[index + 1] ?? buffer.length, prefix, context.alternate, copyContext(context)];
  });
}

// What a sequence writes to the read-only view. Screen switches are dropped;
// leaving the alternate screen restores the rendition now in effect.
function viewSequence(sequence, kind, hidden, context) {
  if (kind === "reset") return RESET_VIEW;
  if (kind === "screen") return hidden && !context.alternate ? `${ESC}[0m${sgr(context.state)}` : "";
  return hidden || sequence === CLEAR_SCROLLBACK ? "" : sequence;
}

// The normal-screen output a page leaves readable, and the screen it ends on.
// A full-screen program's alternate screen is left out, as it is from a
// terminal once the program exits; it ends at a screen switch or full reset.
export function savedPageProjection(buffer, [start, end, , alternate = false, entry = null]) {
  const page = buffer.slice(start, end);
  const context = entry ? copyContext(entry) : { ...freshContext(), alternate };
  const spans = escapeSpans(page);
  let text = "";
  let from = 0;
  for (let index = 0; index < spans.length; index += 2) {
    text += visibleText(context, page.slice(from, spans[index]));
    const sequence = page.slice(spans[index], spans[index + 1]);
    const hidden = context.alternate;
    text += viewSequence(sequence, trackSequence(context, sequence), hidden, context);
    from = spans[index + 1];
  }
  text += visibleText(context, page.slice(from));
  return { text, alternate: context.alternate, context };
}

function visibleText(context, text) {
  if (context.alternate) return "";
  trackText(context, text);
  return text;
}

// The text a read-only page writes, its modes and rendition carried in.
export function savedPageText(buffer, page) {
  return (page[2] ?? "") + savedPageProjection(buffer, page).text;
}
