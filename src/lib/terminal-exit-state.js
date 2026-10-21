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

// An escape sequence: CSI, a string (OSC, DCS, SOS, PM, APC) ended by BEL, ST
// or the next ESC, or a short ESC form. A trailing lone ESC is one too.
const ESCAPE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|[\]PX^_][^\x07\x1b]*(?:\x07|\x1b\\)?|[ -/]*[0-~]|$)/g;
const ALT_SCREEN_MODES = new Set(["47", "1047", "1049"]);
const SGR_OFF = { 22: ["1", "2"], 23: ["3"], 24: ["4"], 25: ["5"], 27: ["7"], 28: ["8"], 29: ["9"], 39: ["fg"], 49: ["bg"], 55: ["53"], 59: ["ul"] };
const SGR_COLOR = { 38: "fg", 48: "bg", 58: "ul" };

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

// Follows the rendition and screen a sequence leaves in effect. The
// alternate screen with mode 1049 restores the rendition it saved.
function trackSequence(context, sequence) {
  if (sequence === "\x1bc") Object.assign(context, { state: new Map(), saved: null, alternate: false });
  const csi = /^\x1b\[(\??)([0-9:;]*)([hlm])$/.exec(sequence);
  if (!csi) return;
  const modes = csi[2].split(";");
  if (!csi[1] && csi[3] === "m") applySgr(context.state, csi[2]);
  else if (csi[1] && csi[3] !== "m" && modes.some((mode) => ALT_SCREEN_MODES.has(mode))) {
    const enter = csi[3] === "h";
    if (modes.includes("1049") && enter) context.saved = new Map(context.state);
    else if (modes.includes("1049") && context.saved) Object.assign(context, { state: context.saved, saved: null });
    context.alternate = enter;
  }
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

// Saved output can hold up to the 2 MiB history cap, more than one terminal
// view keeps. It is shown in pages, newest last, each small enough that its
// first line stays in the view's scrollback: at most maxLines line breaks and
// maxChars characters, starting on a line boundary where one exists and never
// inside an escape sequence. Each page is [start, end, prefix, alternate]:
// the rendition and screen the output before it leaves in effect.
export function savedOutputPages(buffer, maxChars = 64_000, maxLines = 2_000) {
  const spans = [];
  for (const match of buffer.matchAll(ESCAPE)) spans.push(match.index, match.index + match[0].length);
  const pages = [];
  let end = buffer.length;
  while (end > 0) {
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
    // Never split a surrogate pair.
    const code = buffer.charCodeAt(start);
    if (start > 0 && start < end - 1 && code >= 0xdc00 && code <= 0xdfff) start += 1;
    start = outsideEscape(spans, start, end);
    pages.push([start, end]);
    end = start;
  }
  pages.reverse();
  const context = { state: new Map(), saved: null, alternate: false };
  let span = 0;
  for (const page of pages) {
    for (; span < spans.length && spans[span] < page[0]; span += 2) trackSequence(context, buffer.slice(spans[span], spans[span + 1]));
    const rendition = context.alternate && context.saved ? context.saved : context.state;
    page.push(rendition.size ? `\x1b[${[...rendition.values()].join(";")}m` : "", context.alternate);
  }
  return pages;
}

// The text a read-only page writes. A full-screen program's alternate screen
// is left out, as it is from a terminal once the program exits; output it
// would erase from the scrollback, or a full reset, stays readable.
export function savedPageText(buffer, [start, end, prefix = "", alternate = false]) {
  let text = "";
  let from = start;
  let hidden = alternate;
  const toggle = /\x1b\[\?([0-9;]*)([hl])/g;
  toggle.lastIndex = start;
  for (let match = toggle.exec(buffer); match && match.index < end; match = toggle.exec(buffer)) {
    if (!match[1].split(";").some((mode) => ALT_SCREEN_MODES.has(mode))) continue;
    if (!hidden) text += buffer.slice(from, match.index);
    hidden = match[2] === "h";
    from = match.index + match[0].length;
  }
  if (!hidden) text += buffer.slice(from, end);
  return prefix + text.replaceAll("\x1b[3J", "").replaceAll("\x1bc", "\x1b[0m\x1b[H\x1b[2J");
}
