// A small CommonMark-like parser for previews. It produces plain nodes that
// React renders as escaped text: raw HTML stays literal, only http(s) and
// mailto links leave the preview, relative links stay inside the worktree,
// and nothing is fetched from another origin. Closer searches remember
// failures, so adversarial input stays linear rather than quadratic.

const MAX_DEPTH = 8;
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?/;
const ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])([ \t]+|$)(.*)$/;
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

export function parseMarkdown(source) { return parseBlocks(String(source ?? "").replace(/\r\n?/g, "\n").split("\n"), 0); }

function startsBlock(line) { return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || ITEM.test(line); }
const indentOf = (line) => line.match(/^ */)[0].length;

function parseBlocks(lines, depth) {
  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    const fence = FENCE.exec(line);
    if (fence) {
      const body = [];
      index += 1;
      while (index < lines.length && !new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`).test(lines[index])) body.push(lines[index++]);
      index += 1;
      blocks.push({ type: "code", language: fence[2], text: body.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) { blocks.push({ type: "heading", level: heading[1].length, children: parseInline(heading[2] ?? "") }); index += 1; continue; }
    if (RULE.test(line)) { blocks.push({ type: "rule" }); index += 1; continue; }
    if (QUOTE.test(line) && depth < MAX_DEPTH) {
      const body = [];
      while (index < lines.length && QUOTE.test(lines[index])) body.push(lines[index++].replace(QUOTE, ""));
      blocks.push({ type: "quote", blocks: parseBlocks(body, depth + 1) });
      continue;
    }
    const item = ITEM.exec(line);
    if (item && depth < MAX_DEPTH) { index = parseList(lines, index, depth, blocks); continue; }
    if (line.includes("|") && TABLE_DELIMITER.test(lines[index + 1] ?? "") && lines[index + 1].includes("-")) {
      const align = cells(lines[index + 1]).map((cell) => (cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : cell.startsWith(":") ? "left" : null));
      const head = cells(line).map(parseInline);
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].trim() && lines[index].includes("|")) rows.push(cells(lines[index++]).map(parseInline));
      blocks.push({ type: "table", align, head, rows });
      continue;
    }
    const body = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !startsBlock(lines[index])) {
      if (/^ {0,3}(=+|-+)\s*$/.test(lines[index])) break;
      body.push(lines[index++]);
    }
    const setext = /^ {0,3}(=+|-+)\s*$/.exec(lines[index] ?? "");
    if (setext && index < lines.length && lines[index].trim()) {
      blocks.push({ type: "heading", level: setext[1][0] === "=" ? 1 : 2, children: parseInline(body.join("\n")) });
      index += 1;
    } else blocks.push({ type: "paragraph", children: parseInline(body.join("\n")) });
  }
  return blocks;
}

function parseList(lines, start, depth, blocks) {
  const first = ITEM.exec(lines[start]);
  const ordered = /\d/.test(first[2]);
  const marker = ordered ? first[2].at(-1) : first[2];
  const list = { type: "list", ordered, start: ordered ? Number.parseInt(first[2], 10) : 1, items: [] };
  let index = start;
  while (index < lines.length) {
    const item = ITEM.exec(lines[index]);
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
    list.items.push({ checked: task ? task[1] !== " " : null, blocks: parseBlocks(body, depth + 1) });
    if (index < lines.length && !lines[index].trim()) {
      // A blank line ends the list unless another item follows it.
      const following = ITEM.exec(lines[index + 1] ?? "");
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
const WORD = /[\p{L}\p{N}]/u;

export function parseInline(text) {
  const missing = new Set();
  const find = (needle, from) => {
    if (missing.has(needle)) return -1;
    const at = text.indexOf(needle, from);
    if (at < 0) missing.add(needle);
    return at;
  };
  return inline(text, 0, text.length, find, 0);
}

function inline(text, start, end, find, depth) {
  const nodes = [];
  let buffer = "";
  const flush = () => { if (buffer) { nodes.push({ type: "text", value: buffer }); buffer = ""; } };
  const push = (node) => { flush(); nodes.push(node); };
  let index = start;
  while (index < end) {
    const character = text[index];
    if (character === "\\" && index + 1 < end) {
      if (text[index + 1] === "\n") { push({ type: "break" }); index += 2; continue; }
      if (PUNCTUATION.test(text[index + 1])) { buffer += text[index + 1]; index += 2; continue; }
    }
    if (character === "`") {
      const run = /^`+/.exec(text.slice(index, Math.min(end, index + 32)))[0];
      const close = find(run, index + run.length);
      if (close >= 0 && close < end) { push({ type: "code", value: text.slice(index + run.length, close).replace(/\n/g, " ").replace(/^ (.+) $/, "$1") }); index = close + run.length; continue; }
      buffer += run; index += run.length; continue;
    }
    if (character === "\n") {
      if (buffer.endsWith("  ")) { buffer = buffer.trimEnd(); push({ type: "break" }); } else buffer = `${buffer.trimEnd()} `;
      index += 1;
      continue;
    }
    if ((character === "[" || (character === "!" && text[index + 1] === "[")) && depth < MAX_DEPTH) {
      const image = character === "!";
      const labelStart = index + (image ? 2 : 1);
      const labelEnd = find("](", labelStart);
      if (labelEnd >= 0 && labelEnd < end) {
        const destination = /^\(\s*<?([^\s<>()]*)>?(?:\s+"([^"\n]*)")?\s*\)/.exec(text.slice(labelEnd + 1, Math.min(end, labelEnd + 2050)));
        if (destination && !text.slice(labelStart, labelEnd).includes("]")) {
          const label = { url: destination[1], title: destination[2] ?? "" };
          if (image) push({ type: "image", alt: text.slice(labelStart, labelEnd), ...label });
          else push({ type: "link", ...label, children: inline(text, labelStart, labelEnd, find, depth + 1) });
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
        close = tries < 16 ? text.indexOf(delimiter, close + 1) : -1;
      }
      if (close > index + delimiter.length && close < end) {
        push({ type: delimiter === "~~" ? "delete" : delimiter.length === 2 ? "strong" : "emphasis", children: inline(text, index + delimiter.length, close, find, depth + 1) });
        index = close + delimiter.length;
        continue;
      }
    }
    buffer += character;
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
