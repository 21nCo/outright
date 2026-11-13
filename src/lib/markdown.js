// A small CommonMark-like parser for previews. It produces plain nodes that
// React renders as escaped text: raw HTML stays literal, only http(s) and
// mailto links leave the preview, relative links stay inside the worktree,
// and nothing is fetched from another origin.
//
// Parsing is linear in the input: no pattern has two adjacent quantifiers
// that can match the same text, each closer search remembers where the next
// closer is, and pending text is kept as ranges of the source, copied once.
// Rendering is bounded too: a document that would produce more than
// MARKDOWN_NODE_BUDGET elements (a wide table repeated over many rows, say)
// is reported as over budget rather than parsed further.

const MAX_DEPTH = 8;
export const MARKDOWN_NODE_BUDGET = 60_000;
const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)/;
const HEADING_OPEN = /^ {0,3}(#{1,6})(?=[ \t]|$)/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?/;
const ITEM_OPEN = /^( {0,3})([-*+]|\d{1,9}[.)])(?=[ \t]|$)/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const DELIMITER_CELL = /^:?-+:?$/;

class OverBudget extends Error {}

// Blocks for the preview. A document over the node budget returns no blocks
// and `overBudget`, and is shown as source instead. `stats`, if given, has
// `steps`, `scanned` and `pieces` counts added to it, measuring the work done.
export function parseMarkdownPreview(source, budget = MARKDOWN_NODE_BUDGET, stats = null) {
  const counter = { left: budget, stats };
  try { return { blocks: parseBlocks(splitLines(source), 0, counter), overBudget: false }; }
  catch (error) {
    if (error instanceof OverBudget) return { blocks: [], overBudget: true };
    throw error;
  }
}

export function parseMarkdown(source) { return parseBlocks(splitLines(source), 0, { left: Infinity }); }

function splitLines(source) { return String(source ?? "").replace(/\r\n?/g, "\n").split("\n"); }
function spend(counter, count) {
  counter.left -= count;
  if (counter.left < 0) throw new OverBudget();
}

function headingOf(line) {
  const open = HEADING_OPEN.exec(line);
  if (!open) return null;
  let text = line.slice(open[0].length).trim();
  // An optional closing run of "#" after a space is not part of the text.
  let end = text.length;
  while (end > 0 && text[end - 1] === "#") end -= 1;
  if (end === 0) text = "";
  else if (end < text.length && (text[end - 1] === " " || text[end - 1] === "\t")) text = text.slice(0, end).trimEnd();
  return { level: open[1].length, text };
}

function itemOf(line) {
  const open = ITEM_OPEN.exec(line);
  if (!open) return null;
  let at = open[0].length;
  while (at < line.length && (line[at] === " " || line[at] === "\t")) at += 1;
  return [open[0], open[1], open[2], line.slice(open[0].length, at), line.slice(at)];
}

// A GFM delimiter row ("| :-- | --: |") with one cell per header cell.
function tableAlignment(line, columns) {
  if (!line?.includes("-")) return null;
  const parts = cells(line);
  if (parts.length !== columns || !parts.every((cell) => DELIMITER_CELL.test(cell))) return null;
  return parts.map((cell) => (cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : cell.startsWith(":") ? "left" : null));
}

function startsBlock(line) { return FENCE.test(line) || HEADING_OPEN.test(line) || RULE.test(line) || QUOTE.test(line) || ITEM_OPEN.test(line); }
const indentOf = (line) => line.match(/^ */)[0].length;

function parseBlocks(lines, depth, counter) {
  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (counter.stats) counter.stats.steps += 1;
    if (!line.trim()) { index += 1; continue; }
    spend(counter, 1);
    const fence = FENCE.exec(line);
    if (fence) {
      spend(counter, 1); // rendered as pre and code
      const closer = fence[1][0];
      const closes = (candidate) => {
        const trimmed = candidate.trimEnd();
        const indent = indentOf(trimmed);
        if (indent > 3 || trimmed.length - indent < fence[1].length) return false;
        for (let at = indent; at < trimmed.length; at += 1) if (trimmed[at] !== closer) return false;
        return true;
      };
      const body = [];
      index += 1;
      while (index < lines.length && !closes(lines[index])) body.push(lines[index++]);
      index += 1;
      blocks.push({ type: "code", language: fence[2], text: body.join("\n") });
      continue;
    }
    const heading = headingOf(line);
    if (heading) { blocks.push({ type: "heading", level: heading.level, children: parseInline(heading.text, counter) }); index += 1; continue; }
    if (RULE.test(line)) { blocks.push({ type: "rule" }); index += 1; continue; }
    if (QUOTE.test(line) && depth < MAX_DEPTH) {
      const body = [];
      while (index < lines.length && QUOTE.test(lines[index])) body.push(lines[index++].replace(QUOTE, ""));
      blocks.push({ type: "quote", blocks: parseBlocks(body, depth + 1, counter) });
      continue;
    }
    if (ITEM_OPEN.test(line) && depth < MAX_DEPTH) { index = parseList(lines, index, depth, blocks, counter); continue; }
    const align = line.includes("|") ? tableAlignment(lines[index + 1], cells(line).length) : null;
    if (align) {
      // Every row renders one cell per column, whatever it was written with.
      spend(counter, align.length + 4); // and a wrapper, table, thead, its row and tbody
      const head = cells(line).map((cell) => parseInline(cell, counter));
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].trim() && lines[index].includes("|")) {
        spend(counter, align.length + 1);
        rows.push(cells(lines[index++]).slice(0, align.length).map((cell) => parseInline(cell, counter)));
      }
      blocks.push({ type: "table", align, head, rows });
      continue;
    }
    const body = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !startsBlock(lines[index])) {
      if (SETEXT.test(lines[index])) break;
      body.push(lines[index++]);
    }
    const setext = SETEXT.exec(lines[index] ?? "");
    if (setext && index < lines.length && lines[index].trim()) {
      blocks.push({ type: "heading", level: setext[1][0] === "=" ? 1 : 2, children: parseInline(body.join("\n"), counter) });
      index += 1;
    } else blocks.push({ type: "paragraph", children: parseInline(body.join("\n"), counter) });
  }
  return blocks;
}

function parseList(lines, start, depth, blocks, counter) {
  const first = itemOf(lines[start]);
  const ordered = /\d/.test(first[2]);
  const marker = ordered ? first[2].at(-1) : first[2];
  const list = { type: "list", ordered, start: ordered ? Number.parseInt(first[2], 10) : 1, items: [] };
  let index = start;
  while (index < lines.length) {
    const item = itemOf(lines[index]);
    if (!item || /\d/.test(item[2]) !== ordered || (ordered ? item[2].at(-1) : item[2]) !== marker || item[1].length > first[1].length + 1) break;
    const contentIndent = item[1].length + item[2].length + Math.max(1, Math.min(item[3].length, 4));
    const body = [item[4]];
    index += 1;
    while (index < lines.length) {
      const next = lines[index];
      if (!next.trim()) {
        if (index + 1 < lines.length && indentOf(lines[index + 1]) >= contentIndent && lines[index + 1].trim()) { body.push(""); index += 1; continue; }
        break;
      }
      if (indentOf(next) >= contentIndent) { body.push(next.slice(contentIndent)); index += 1; continue; }
      if (startsBlock(next)) break;
      body.push(next.trim());
      index += 1;
    }
    const task = /^\[([ xX])\][ \t]+/.exec(body[0]);
    if (task) body[0] = body[0].slice(task[0].length);
    spend(counter, task ? 2 : 1); // the item, and its checkbox
    list.items.push({ checked: task ? task[1] !== " " : null, blocks: parseBlocks(body, depth + 1, counter) });
    if (index < lines.length && !lines[index].trim()) {
      // A blank line ends the list unless another item follows it.
      const following = itemOf(lines[index + 1] ?? "");
      if (following && /\d/.test(following[2]) === ordered) { index += 1; continue; }
      break;
    }
  }
  blocks.push(list);
  return index;
}

function cells(line) {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  return text.split(/(?<!\\)\|/).map((cell) => cell.trim().replaceAll("\\|", "|"));
}

const PUNCTUATION = /[!-/:-@[-`{-~]/;
const SPECIAL = /[\\`\n[!<*_~]/g;
const WORD = /[\p{L}\p{N}]/u;
const SPACE = /\s/;
const AUTOLINK = /<((?:https?|mailto):[^\s<>]{1,2048})>/iy;
const DOUBLE = { "*": "**", _: "__", "~": "~~" };

// `find(needle, from)` is text.indexOf(needle, from), remembering the last
// answer per needle: a later search that starts between the remembered start
// and its result has the same result. `closerAt(delimiter, from)` is the
// first position at or after `from` where the delimiter can close, cached
// the same way. Text is visited in order, so the total scanning per needle
// is linear. A counter's `stats`, when given, counts the characters
// searched, the scanner's steps and the text pieces copied.
export function parseInline(text, counter = { left: Infinity }) {
  const stats = counter.stats ?? null;
  const found = new Map();
  const find = (needle, from) => {
    let last = found.get(needle);
    if (last && from >= last.from && (last.at < 0 || from <= last.at)) return last.at;
    const at = text.indexOf(needle, from);
    if (stats) stats.scanned += (at < 0 ? text.length : at + needle.length) - from;
    if (!last) found.set(needle, last = { from, at });
    last.from = from;
    last.at = at;
    return at;
  };
  const closers = new Map();
  const closerAt = (delimiter, from) => {
    let last = closers.get(delimiter);
    if (last && from >= last.from && (last.at < 0 || from <= last.at)) return last.at;
    let at = find(delimiter, from);
    while (at >= 0 && !canClose(text, delimiter, at)) at = find(delimiter, at + 1);
    if (!last) closers.set(delimiter, last = { from, at });
    last.from = from;
    last.at = at;
    return at;
  };
  // A code span closes on a backtick run of exactly the opener's length,
  // never on part of a longer run; cached like closerAt.
  const codeClosers = new Map();
  const codeCloserAt = (run, from) => {
    let last = codeClosers.get(run);
    if (last && from >= last.from && (last.at < 0 || from <= last.at)) return last.at;
    let at = find(run, from);
    while (at >= 0 && (text[at - 1] === "`" || text[at + run.length] === "`")) at = find(run, at + 1);
    if (!last) codeClosers.set(run, last = { from, at });
    last.from = from;
    last.at = at;
    return at;
  };
  const destinations = new Map();
  const destinationAt = (labelEnd) => {
    if (!destinations.has(labelEnd)) destinations.set(labelEnd, scanDestination(text, labelEnd + 1, stats));
    return destinations.get(labelEnd);
  };
  return inline(text, 0, text.length, { find, closerAt, codeCloserAt, destinationAt, counter, stats }, 0);
}

const DESTINATION_WINDOW = 2049;
const DESTINATION_STOP = /[\s<>()]/;

// The link destination starting at `open`, read in one pass over at most
// DESTINATION_WINDOW characters: "(", spaces, then "<address>" (spaces and parentheses allowed; no newline, "<" or ">") or a bare address (no spaces, "<" or ">"; parentheses only balanced), with a backslash making punctuation literal and dropped, then optionally spaces
// and a "title" in double quotes (no newline), spaces and ")". A title needs
// a space before its quote, which may be the one after "(" when there is no
// address. Returns { length, url, title } or null.
function scanDestination(text, open, stats) {
  const limit = Math.min(text.length, open + DESTINATION_WINDOW);
  if (text[open] !== "(") return null;
  let at = open + 1;
  let found = null;
  const skipSpaces = () => { while (at < limit && SPACE.test(text[at])) at += 1; };
  // Reads up to the first character `stops` accepts; an escaped one is passed to it as escaped and kept without its backslash.
  const read = (stops, value = "") => { for (let escaped; at < limit && !stops(text[(escaped = text[at] === "\\" && at + 1 < limit && PUNCTUATION.test(text[at + 1])) ? at + 1 : at], escaped); at += 1) value += text[escaped ? ++at : at]; return value; };
  // Up to 32 nested; any "]" inside them, even an escaped one, ends the address, so a scan crosses at most one other label's end and stays linear.
  let depth = 0;
  const bare = (c, escaped) => (depth > 0 && c === "]") || (!escaped && (c === "(" && depth < 32 ? (depth += 1, false) : c === ")" && depth > 0 ? (depth -= 1, false) : DESTINATION_STOP.test(c)));
  skipSpaces();
  const angle = at < limit && text[at] === "<";
  if (angle) at += 1;
  const url = read(angle ? (c, escaped) => !escaped && (c === "<" || c === ">" || c === "\n") : bare);
  const closed = angle ? at < limit && text[at] === ">" : !depth; // "<address" needs its ">", a bare one balanced parentheses
  if (angle && closed) at += 1;
  skipSpaces();
  if (closed && at < limit && text[at] === "\"" && at - 1 > open && SPACE.test(text[at - 1])) {
    at += 1;
    const title = read((c, escaped) => !escaped && (c === "\"" || c === "\n"));
    if (at < limit && text[at] === "\"") {
      at += 1;
      skipSpaces();
      if (at < limit && text[at] === ")") found = { length: at + 1 - open, url, title };
    }
  } else if (closed && at < limit && text[at] === ")") found = { length: at + 1 - open, url, title: undefined };
  // Every character looked at, including the one that ended the scan.
  if (stats) stats.scanned += Math.min(at + 1, limit) - open;
  return found;
}

// A closing delimiter follows a non-space; a closing "_" is not followed by
// a letter or digit.
function canClose(text, delimiter, at) {
  return !SPACE.test(text[at - 1]) && !(delimiter[0] === "_" && WORD.test(text[at + delimiter.length] ?? "")) && !escapedAt(text, at); // an escaped one is text
}

const escapedAt = (text, at) => { let slashes = 0; while (text[at - 1 - slashes] === "\\") slashes += 1; return slashes % 2 === 1; }; // by an odd run of backslashes

function inline(text, start, end, context, depth) {
  const { find, closerAt, codeCloserAt, destinationAt, counter, stats, inLink } = context; // in a link label, links and autolinks stay text: a link holds nothing interactive
  const nodes = [];
  // Pending text: pieces already taken, then the run from `runStart` to
  // `index`, which is copied only when something else interrupts it.
  const parts = [];
  let index = start;
  let runStart = start;
  const take = () => {
    if (index > runStart) { parts.push(text.slice(runStart, index)); if (stats) stats.pieces += 1; }
    runStart = index;
  };
  const flush = () => {
    take();
    if (!parts.length) return;
    spend(counter, 1);
    nodes.push({ type: "text", value: parts.length === 1 ? parts[0] : parts.join("") });
    parts.length = 0;
  };
  // Emits a node in place of the text up to `next`.
  const push = (node, next, cost = 1) => { flush(); spend(counter, cost); nodes.push(node); index = next; runStart = next; }; // cost: the elements it renders at most
  // Removes trailing spaces and tabs from the pending text; returns how many
  // trailing spaces there were (two or more make a hard line break).
  const trimPending = () => {
    take();
    let spaces = 0;
    while (parts.length) {
      const last = parts[parts.length - 1];
      let keep = last.length;
      while (keep > 0 && (last[keep - 1] === " " || last[keep - 1] === "\t")) keep -= 1;
      spaces += last.length - keep;
      if (keep) { parts[parts.length - 1] = last.slice(0, keep); break; }
      parts.pop();
    }
    return spaces;
  };
  while (index < end) {
    if (stats) stats.steps += 1;
    // Plain text up to the next character that can start something stays in the run.
    SPECIAL.lastIndex = index;
    const next = SPECIAL.exec(text);
    const plainEnd = next ? Math.min(next.index, end) : end;
    if (plainEnd > index) { index = plainEnd; continue; }
    const character = text[index];
    if (character === "\\" && index + 1 < end) {
      if (text[index + 1] === "\n") { push({ type: "break" }, index + 2); continue; }
      // The backslash is dropped and the punctuation it escapes is text.
      if (PUNCTUATION.test(text[index + 1])) { take(); runStart = index + 1; index += 2; continue; }
    }
    if (character === "`") {
      let runEnd = index + 1;
      while (runEnd < end && text[runEnd] === "`") runEnd += 1;
      // A run longer than 32 backticks opens nothing and stays text.
      if (runEnd - index > 32) { index = runEnd; continue; }
      const run = text.slice(index, runEnd);
      const close = codeCloserAt(run, runEnd);
      if (close >= 0 && close < end) { push({ type: "code", value: text.slice(runEnd, close).replace(/\n/g, " ").replace(/^ (.+) $/, "$1") }, close + run.length); continue; }
      index = runEnd;
      continue;
    }
    if (character === "\n") {
      if (trimPending() >= 2) { push({ type: "break" }, index + 1); continue; }
      if (parts.length || nodes.length) parts.push(" ");
      index += 1;
      runStart = index;
      continue;
    }
    if (((character === "[" && !inLink) || (character === "!" && text[index + 1] === "[")) && depth < MAX_DEPTH) {
      const image = character === "!";
      const labelStart = index + (image ? 2 : 1);
      // An image's label is the text up to its first "]". A link's may hold whole images ("[![CI](b.svg)](run)") and
      // ends at the first "]" after them; any other "[" leaves it text. Scanning stops there, so it stays linear.
      let labelEnd = find("]", labelStart);
      for (let from = labelStart, bracket; !image && labelEnd >= 0 && labelEnd < end && (bracket = find("[", from)) >= 0 && bracket < labelEnd;) {
        if (escapedAt(text, bracket)) { from = bracket + 1; continue; } // an escaped "[" is text
        const inner = bracket > from && text[bracket - 1] === "!" && !escapedAt(text, bracket - 1) ? destinationAt(labelEnd) : null;
        if (!inner) { labelEnd = -1; break; }
        from = labelEnd + 1 + inner.length;
        labelEnd = find("]", from);
      }
      if (labelEnd >= 0 && labelEnd < end) {
        const destination = destinationAt(labelEnd);
        if (destination && labelEnd + 1 + destination.length <= end) {
          const label = { url: destination.url, title: destination.title ?? "" };
          const after = labelEnd + 1 + destination.length;
          if (image) push({ type: "image", alt: text.slice(labelStart, labelEnd), ...label }, after, 2); // a failed image is a note and its Retry button
          else push({ type: "link", ...label, children: inline(text, labelStart, labelEnd, { ...context, inLink: true }, depth + 1) }, after);
          continue;
        }
      }
    }
    if (character === "<" && !inLink) {
      AUTOLINK.lastIndex = index;
      const auto = AUTOLINK.exec(text);
      if (auto && index + auto[0].length <= end) { push({ type: "link", url: auto[1], title: "", children: [{ type: "text", value: auto[1] }] }, index + auto[0].length, 2); continue; } // the link and its text
    }
    if ((character === "*" || character === "_" || character === "~") && depth < MAX_DEPTH) {
      const delimiter = text[index + 1] === character ? DOUBLE[character] : character === "~" ? null : character;
      const opens = delimiter && text[index + delimiter.length] && !SPACE.test(text[index + delimiter.length])
        && !(character === "_" && WORD.test(text[index - 1] ?? ""));
      let close = opens ? closerAt(delimiter, index + delimiter.length) : -1;
      let width = delimiter?.length;
      // A run of three opens both: "***x***" is strong around emphasis, "***x** y*" emphasis around strong.
      if (width === 2 && character !== "~" && text[index + 2] === character && close > 0) {
        const outer = text[close + 2] === character ? -1 : closerAt(character, close + 2);
        if (outer < 0) close += text[close + 2] === character ? 1 : 0; else { close = outer; width = 1; }
      }
      if (close > index + width && close < end) {
        const type = delimiter === "~~" ? "delete" : width === 2 ? "strong" : "emphasis";
        push({ type, children: inline(text, index + width, close, context, depth + 1) }, close + width);
        continue;
      }
    }
    index += 1;
  }
  flush();
  return nodes;
}

// Where a link may go. External links open outside Outright; a relative
// link names a worktree file; anything else (javascript:, data:, file:,
// protocol-relative) is shown as text.
export function linkTarget(url, fromFile) {
  const spelled = String(url ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim(); // an <address> may hold spaces; its target keeps them, while a scheme is spotted without them
  const cleaned = String(url ?? "").replace(/[\u0000- \u007f]/g, "");
  if (!cleaned) return { kind: "none" };
  if (/^(?:https?|mailto):/i.test(cleaned)) return /^(?:https?|mailto):/i.test(spelled) ? { kind: "external", href: spelled.replaceAll(" ", "%20") } : { kind: "unsafe" };
  if (cleaned.startsWith("#")) return { kind: "anchor" };
  if (/^[a-z][a-z0-9+.-]*:/i.test(cleaned) || cleaned.startsWith("//") || cleaned.startsWith("\\")) return { kind: "unsafe" };
  const target = spelled.split(/[?#]/, 1)[0];
  let decoded;
  try { decoded = decodeURIComponent(target); } catch { return { kind: "unsafe" }; }
  const parts = target.startsWith("/") ? [] : String(fromFile ?? "").split("/").slice(0, -1);
  for (const segment of decoded.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") { if (!parts.length) return { kind: "unsafe" }; parts.pop(); } else parts.push(segment);
  }
  return parts.length ? { kind: "file", path: parts.join("/") } : { kind: "none" };
}
