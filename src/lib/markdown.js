// A small CommonMark-like parser for previews. It produces plain nodes that
// React renders as escaped text: raw HTML stays literal, only http(s) and
// mailto links leave the preview, relative links stay inside the worktree,
// and nothing is fetched from another origin.
//
// Parsing is linear in the input: no pattern has two adjacent quantifiers
// that can match the same text, each closer search remembers where the next
// closer is, and pending text is joined once rather than copied per line.
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
// and `overBudget`, and is shown as source instead.
export function parseMarkdownPreview(source, budget = MARKDOWN_NODE_BUDGET) {
  const counter = { left: budget };
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
    if (!line.trim()) { index += 1; continue; }
    spend(counter, 1);
    const fence = FENCE.exec(line);
    if (fence) {
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
      spend(counter, align.length);
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
    spend(counter, 1);
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

// `find(needle, from)` is text.indexOf(needle, from), remembering the last
// answer per needle: a later search that starts between the remembered start
// and its result has the same result. Searches move forward, so the total
// scanning per needle is linear.
export function parseInline(text, counter = { left: Infinity }) {
  const found = new Map();
  const find = (needle, from) => {
    const last = found.get(needle);
    if (last && from >= last.from && (last.at < 0 || from <= last.at)) return last.at;
    const at = text.indexOf(needle, from);
    found.set(needle, { from, at });
    return at;
  };
  const destinations = new Map();
  const destinationAt = (labelEnd) => {
    if (!destinations.has(labelEnd)) destinations.set(labelEnd, /^\(\s*<?([^\s<>()]*)>?(?:\s+"([^"\n]*)")?\s*\)/.exec(text.slice(labelEnd + 1, labelEnd + 2050)));
    return destinations.get(labelEnd);
  };
  return inline(text, 0, text.length, { find, destinationAt, counter }, 0);
}

function inline(text, start, end, context, depth) {
  const { find, destinationAt, counter } = context;
  const nodes = [];
  // Pending text, as pieces joined once, so long paragraphs stay linear.
  const parts = [];
  const flush = () => { if (parts.length) { spend(counter, 1); nodes.push({ type: "text", value: parts.join("") }); parts.length = 0; } };
  const push = (node) => { flush(); spend(counter, 1); nodes.push(node); };
  // Removes trailing spaces and tabs from the pending text; returns how many
  // trailing spaces there were (two or more make a hard line break).
  const trimPending = () => {
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
  let index = start;
  while (index < end) {
    // Plain text up to the next character that can start something is copied at once.
    SPECIAL.lastIndex = index;
    const next = SPECIAL.exec(text);
    const plainEnd = next ? Math.min(next.index, end) : end;
    if (plainEnd > index) { parts.push(text.slice(index, plainEnd)); index = plainEnd; continue; }
    const character = text[index];
    if (character === "\\" && index + 1 < end) {
      if (text[index + 1] === "\n") { push({ type: "break" }); index += 2; continue; }
      if (PUNCTUATION.test(text[index + 1])) { parts.push(text[index + 1]); index += 2; continue; }
    }
    if (character === "`") {
      const run = /^`+/.exec(text.slice(index, Math.min(end, index + 32)))[0];
      const close = find(run, index + run.length);
      if (close >= 0 && close < end) { push({ type: "code", value: text.slice(index + run.length, close).replace(/\n/g, " ").replace(/^ (.+) $/, "$1") }); index = close + run.length; continue; }
      parts.push(run); index += run.length; continue;
    }
    if (character === "\n") {
      if (trimPending() >= 2) push({ type: "break" }); else if (parts.length || nodes.length) parts.push(" ");
      index += 1;
      continue;
    }
    if ((character === "[" || (character === "!" && text[index + 1] === "[")) && depth < MAX_DEPTH) {
      const image = character === "!";
      const labelStart = index + (image ? 2 : 1);
      const labelEnd = find("](", labelStart);
      // The label is the text up to the first "]", which must open the destination.
      if (labelEnd >= 0 && labelEnd < end && find("]", labelStart) === labelEnd) {
        const destination = destinationAt(labelEnd);
        if (destination && labelEnd + 1 + destination[0].length <= end) {
          const label = { url: destination[1], title: destination[2] ?? "" };
          if (image) push({ type: "image", alt: text.slice(labelStart, labelEnd), ...label });
          else push({ type: "link", ...label, children: inline(text, labelStart, labelEnd, context, depth + 1) });
          index = labelEnd + 1 + destination[0].length;
          continue;
        }
      }
    }
    if (character === "<") {
      const auto = /^<((?:https?|mailto):[^\s<>]+)>/i.exec(text.slice(index, Math.min(end, index + 2050)));
      if (auto) { push({ type: "link", url: auto[1], title: "", children: [{ type: "text", value: auto[1] }] }); index += auto[0].length; continue; }
    }
    const delimiter = ["**", "__", "~~"].find((value) => text.startsWith(value, index)) ?? (character === "*" || character === "_" ? character : null);
    if (delimiter && depth < MAX_DEPTH && text[index + delimiter.length] && !/\s/.test(text[index + delimiter.length])
      && !(delimiter[0] === "_" && WORD.test(text[index - 1] ?? ""))) {
      let close = find(delimiter, index + delimiter.length);
      // A bounded number of rejected closers keeps "*a *a *a…" linear.
      for (let tries = 0; close >= 0 && close < end && (/\s/.test(text[close - 1]) || (delimiter[0] === "_" && WORD.test(text[close + delimiter.length] ?? ""))); tries += 1) {
        close = tries < 16 ? find(delimiter, close + 1) : -1;
      }
      if (close > index + delimiter.length && close < end) {
        push({ type: delimiter === "~~" ? "delete" : delimiter.length === 2 ? "strong" : "emphasis", children: inline(text, index + delimiter.length, close, context, depth + 1) });
        index = close + delimiter.length;
        continue;
      }
    }
    parts.push(character);
    index += 1;
  }
  flush();
  return nodes;
}

// Where a link may go. External links open outside Outright; a relative
// link names a worktree file; anything else (javascript:, data:, file:,
// protocol-relative) is shown as text.
export function linkTarget(url, fromFile) {
  const cleaned = String(url ?? "").replace(/[\u0000- \u007f]/g, "");
  if (!cleaned) return { kind: "none" };
  if (/^(?:https?|mailto):/i.test(cleaned)) return { kind: "external", href: cleaned };
  if (cleaned.startsWith("#")) return { kind: "anchor" };
  if (/^[a-z][a-z0-9+.-]*:/i.test(cleaned) || cleaned.startsWith("//") || cleaned.startsWith("\\")) return { kind: "unsafe" };
  const target = cleaned.split(/[?#]/, 1)[0];
  let decoded;
  try { decoded = decodeURIComponent(target); } catch { return { kind: "unsafe" }; }
  const parts = target.startsWith("/") ? [] : String(fromFile ?? "").split("/").slice(0, -1);
  for (const segment of decoded.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") { if (!parts.length) return { kind: "unsafe" }; parts.pop(); } else parts.push(segment);
  }
  return parts.length ? { kind: "file", path: parts.join("/") } : { kind: "none" };
}
