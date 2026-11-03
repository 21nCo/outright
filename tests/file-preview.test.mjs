import assert from "node:assert/strict";
import test from "node:test";
import { MARKDOWN_NODE_BUDGET, linkTarget, parseInline, parseMarkdown, parseMarkdownPreview } from "../src/lib/markdown.js";
import { PDF_CANVAS_LIMITS, pdfCanvasSize } from "../src/lib/pdf-canvas.js";
import { ancestorsOf, isExpandable, normalizeTypedPath, treeKeyTarget, visibleRows } from "../src/lib/file-tree.js";

const types = (nodes) => nodes.map((node) => node.type);
function collect(blocks, found = []) {
  for (const block of blocks) {
    found.push(block);
    for (const child of [...(block.blocks ?? []), ...(block.items?.flatMap((item) => item.blocks) ?? [])]) collect([child], found);
  }
  return found;
}

test("Markdown structure parses into plain nodes, and raw HTML stays literal text", () => {
  const blocks = parseMarkdown([
    "# Title", "", "Intro with **bold**, *em*, `code` and ~~gone~~.", "", "<script>alert(1)</script>", "<img src=x onerror=alert(1)>", "",
    "- [x] done", "- [ ] todo", "  - nested", "", "1. one", "2. two", "", "> quoted", "", "```js", "const a = '<b>';", "```", "",
    "| a | b |", "|:--|--:|", "| 1 | 2 |", "", "Setext", "===", "", "---",
  ].join("\n"));
  assert.deepEqual(types(blocks), ["heading", "paragraph", "paragraph", "list", "list", "quote", "code", "table", "heading", "rule"]);
  assert.deepEqual(types(blocks[1].children), ["text", "strong", "text", "emphasis", "text", "code", "text", "delete", "text"]);
  // The would-be HTML is one text node a renderer escapes.
  assert.deepEqual(blocks[2].children, [{ type: "text", value: "<script>alert(1)</script> <img src=x onerror=alert(1)>" }]);
  assert.deepEqual(blocks[3].items.map((item) => item.checked), [true, false]);
  assert.equal(collect(blocks[3].items[1].blocks).some((block) => block.type === "list"), true);
  assert.deepEqual([blocks[4].ordered, blocks[4].items.length], [true, 2]);
  assert.deepEqual([blocks[6].language, blocks[6].text], ["js", "const a = '<b>';"]);
  assert.deepEqual(blocks[7].align, ["left", "right"]);
  assert.deepEqual([blocks[8].level, blocks[8].children], [1, [{ type: "text", value: "Setext" }]]);
});

test("only http(s) and mailto links leave a preview; relative links stay inside the worktree", () => {
  for (const url of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "java\tscript:alert(1)", " javascript:x", "data:text/html,<b>", "vbscript:x", "file:///etc/passwd", "//evil.example/x", "\\\\server\\share"]) {
    assert.equal(linkTarget(url, "docs/a.md").kind, "unsafe", url);
  }
  assert.deepEqual(linkTarget("https://example.com/a?b#c", "a.md"), { kind: "external", href: "https://example.com/a?b#c" });
  assert.deepEqual(linkTarget("mailto:a@example.com", "a.md"), { kind: "external", href: "mailto:a@example.com" });
  assert.deepEqual(linkTarget("../src/main.js#L3", "docs/guide/a.md"), { kind: "file", path: "docs/src/main.js" });
  assert.deepEqual(linkTarget("/README.md", "docs/a.md"), { kind: "file", path: "README.md" });
  assert.deepEqual(linkTarget("img%20one.png", "docs/a.md"), { kind: "file", path: "docs/img one.png" });
  assert.equal(linkTarget("../../outside.md", "docs/a.md").kind, "unsafe");
  assert.equal(linkTarget("#section", "a.md").kind, "anchor");
  const [link, , image] = parseInline("[site](https://example.com) ![logo](https://tracker.example/p.png)");
  assert.deepEqual([link.type, link.url, image.type, image.url], ["link", "https://example.com", "image", "https://tracker.example/p.png"]);
});

// Each input is close to the 1 MiB text preview limit. A quadratic step
// takes tens of seconds on any of them; linear parsing takes milliseconds.
test("adversarial Markdown near the preview size limit parses with linear work and well within a frame budget", () => {
  const size = 1024 * 1024 - 64;
  const fill = (unit, tail = "") => unit.repeat(Math.floor((size - tail.length) / unit.length)) + tail;
  const inputs = {
    "unclosed emphasis": fill("*a "), "open brackets": fill("["), "backticks": fill("`"), "underscores": fill("_a "), "strong runs": fill("**"), "quotes": fill("> "),
    "unclosed strikethrough": fill("~~a "), "mixed openers": fill("*a _b ~~c `d [e **f "), "escapes": fill("\\*"), "hard breaks": fill("a  \n"),
    "autolink openers": fill("<http:"), "angle brackets": fill("<"),
    "brackets before a rejected link": `${fill("[", "]x](t)")}`,
    "brackets before an unclosed destination": `${fill("[", `](${"a".repeat(2000)} x`)}`,
    "rejected closers": fill("[a]x](t) "),
    "heading with trailing spaces": `# a${fill(" ", "b")}`,
    "heading closing run": `# a ${fill("#", "x")}`,
    "table delimiter with spaces": `| a |\n-${fill(" ", "x")}`,
    "list item with spaces": `- ${fill(" ", "\u2028")}`,
    "rule with spaces": `-${fill(" ", "- x")}`,
    "fence with spaces": `\`\`\`\n\`\`\`${fill(" ", "x")}`,
    "setext with spaces": `a\n=${fill(" ", "x")}`,
    "many short lines": fill("# h\n| a |\n- b\n> c\n"),
  };
  for (const [name, source] of Object.entries(inputs)) {
    const stats = { steps: 0, scanned: 0, pieces: 0 };
    const started = performance.now();
    parseMarkdownPreview(source, undefined, stats);
    const elapsed = performance.now() - started;
    // The work is counted, so the bound holds however loaded the machine is;
    // the clock only catches a pattern that backtracks outside the count.
    assert.ok(stats.steps > 0 && stats.steps + stats.scanned <= 8 * source.length, `${name}: ${stats.steps} steps and ${stats.scanned} characters searched for ${source.length}`);
    // Text is copied in runs, not a piece per character that starts nothing.
    assert.ok(stats.pieces <= source.length / 2, `${name}: ${stats.pieces} text pieces for ${source.length} characters`);
    assert.ok(elapsed < 4000, `${name} took ${Math.round(elapsed)}ms`);
  }
});

test("a wide table repeated over many rows is reported over budget instead of rendered", () => {
  const header = `|${"h|".repeat(1000)}`;
  const delimiter = `|${"-|".repeat(1000)}`;
  const amplified = [header, delimiter, ...Array(10_000).fill("|x|")].join("\n");
  assert.ok(amplified.length < 60_000);
  const started = performance.now();
  const limited = parseMarkdownPreview(amplified);
  assert.deepEqual([limited.overBudget, limited.blocks.length], [true, 0]);
  assert.ok(performance.now() - started < 500);
  // An ordinary table is rendered with one cell per header column.
  const table = parseMarkdownPreview("| a | b |\n| - | - |\n| 1 | 2 | 3 |\n| 4 |");
  assert.equal(table.overBudget, false);
  assert.deepEqual(table.blocks[0].rows.map((row) => row.length), [2, 1]);
  // A delimiter row with a different number of cells is not a table.
  assert.equal(parseMarkdown("| a | b |\n| - |").at(0).type, "paragraph");
  assert.equal(parseMarkdownPreview("word ".repeat(10)).overBudget, false);
  assert.equal(parseMarkdownPreview("- a\n".repeat(MARKDOWN_NODE_BUDGET)).overBudget, true);
});

test("headings, list items and links parse as before after the linear rewrite", () => {
  const blocks = parseMarkdown(["# foo #", "## bar#", "### ###", "#", "#nope", "-   spaced item", "1)  numbered", "[a [b] c](x) [ok](y \"T\")"].join("\n\n"));
  assert.deepEqual(blocks.slice(0, 4).map((block) => [block.type, block.level, block.children.map((node) => node.value).join("")]),
    [["heading", 1, "foo"], ["heading", 2, "bar#"], ["heading", 3, ""], ["heading", 1, ""]]);
  assert.equal(blocks[4].type, "paragraph");
  assert.deepEqual([blocks[5].items[0].blocks[0].children[0].value, blocks[6].ordered, blocks[6].items[0].blocks[0].children[0].value], ["spaced item", true, "numbered"]);
  const inline = blocks[7].children;
  assert.deepEqual(inline.filter((node) => node.type === "link").map((node) => [node.url, node.title]), [["y", "T"]]);
});

test("tree rows follow open folders lazily and keyboard moves stay within them", () => {
  const folders = new Map(Object.entries({
    "": { status: "loaded", entries: [{ name: "src", path: "src", kind: "directory" }, { name: "link", path: "link", kind: "symlink", target: { state: "directory", path: "src" } }, { name: "a.md", path: "a.md", kind: "file" }], total: 3, nextCursor: null },
    src: { status: "loaded", entries: [{ name: "b.js", path: "src/b.js", kind: "file" }], total: 450, nextCursor: "next" },
    link: { status: "error", error: { message: "gone", code: "MISSING" } },
  }));
  const rows = visibleRows(folders, new Set(["src", "link"]));
  assert.deepEqual(rows.map((row) => row.id), ["entry:src", "entry:src/b.js", "more:src", "entry:link", "error:link", "entry:a.md"]);
  assert.deepEqual([rows[1].level, rows[1].setSize, rows[2].remaining, rows[3].expandable], [2, 450, 449, true]);
  assert.deepEqual(visibleRows(folders, new Set()).map((row) => row.id), ["entry:src", "entry:link", "entry:a.md"]);
  assert.deepEqual(visibleRows(new Map(), new Set()).map((row) => row.type), ["loading"]);
  assert.equal(treeKeyTarget(rows, 1, "ArrowLeft"), 0);
  assert.equal(treeKeyTarget(rows, 0, "ArrowRight"), 1);
  assert.equal(treeKeyTarget(rows, 5, "ArrowRight"), -1);
  assert.equal(treeKeyTarget(rows, 0, "End"), 5);
  assert.equal(treeKeyTarget(rows, 0, "a"), 5);
  assert.equal(treeKeyTarget(rows, 5, "ArrowDown"), 5);
  assert.deepEqual([normalizeTypedPath(" ./src//b.js/ "), normalizeTypedPath("/README.md"), ancestorsOf("a/b/c.md")], ["src/b.js", "README.md", ["a", "a/b"]]);
});

test("folders named like object properties are ordinary folders", () => {
  const names = ["constructor", "__proto__", "hasOwnProperty", "toString"];
  const folders = new Map([["", { status: "loaded", entries: names.map((name) => ({ name, path: name, kind: "directory" })), total: names.length, nextCursor: null }]]);
  // Opened but not loaded yet: each shows a loading row, not an inherited value.
  assert.deepEqual(visibleRows(folders, new Set(names)).map((row) => row.type), names.flatMap(() => ["entry", "loading"]));
  for (const name of names) folders.set(name, { status: "loaded", entries: [{ name: "inner.txt", path: `${name}/inner.txt`, kind: "file" }], total: 1, nextCursor: null });
  assert.deepEqual(visibleRows(folders, new Set(names)).filter((row) => row.level === 2).map((row) => row.entry.path), names.map((name) => `${name}/inner.txt`));
});

test("a folder without an addressable path never expands, and no folder is shown twice", () => {
  // A non-UTF-8 folder name has no path. Before this rule, expanding it put
  // null in the open set and the root, listed again under null, recursed.
  const unnamed = { name: "caf\uFFFD", path: null, kind: "directory" };
  const folders = new Map([["", { status: "loaded", entries: [unnamed, { name: "src", path: "src", kind: "directory" }], total: 2, nextCursor: null }]]);
  folders.set(null, folders.get(""));
  const rows = visibleRows(folders, new Set([null, "src"]));
  assert.deepEqual(rows.map((row) => [row.type, row.expandable ?? null, row.open ?? null]), [["entry", false, false], ["entry", true, true], ["loading", null, null]]);
  assert.equal(isExpandable(unnamed), false);
  assert.equal(isExpandable({ name: "x", path: "", kind: "directory" }), false);
  // A folder whose listing names an already-open ancestor is shown closed there.
  folders.set("src", { status: "loaded", entries: [{ name: "loop", path: "src", kind: "symlink", target: { state: "directory", path: "src" } }], total: 1, nextCursor: null });
  assert.deepEqual(visibleRows(folders, new Set(["src"])).map((row) => [row.id, row.open ?? null]), [["entry:\u0000caf\uFFFD", false], ["entry:src", true], ["entry:src", false]]);
});

test("a folder's next page waits while its first page reloads, and listing unavailable is its own state", () => {
  const folder = (status) => ({ status, entries: [{ name: "a", path: "a", kind: "file" }], total: 300, nextCursor: "page-2" });
  assert.equal(visibleRows(new Map([["", folder("loaded")]]), new Set()).at(-1).loading, false);
  assert.equal(visibleRows(new Map([["", folder("loading")]]), new Set()).at(-1).loading, true);
  const unavailable = visibleRows(new Map([["", { status: "error", error: { message: "Folder listing is unavailable", code: "LISTING_UNAVAILABLE" } }]]), new Set());
  assert.deepEqual(unavailable.map((row) => [row.id, row.type]), [["unavailable:", "unavailable"]]);
});

test("a PDF page canvas stays within its per-side and total pixel budget, or the page is reported too large", () => {
  const within = (size, label) => {
    assert(!size.tooLarge, `${label} was refused`);
    assert(size.canvasWidth <= PDF_CANVAS_LIMITS.maxSide && size.canvasHeight <= PDF_CANVAS_LIMITS.maxSide, `${label} is ${size.canvasWidth}x${size.canvasHeight}`);
    assert(size.canvasWidth * size.canvasHeight <= PDF_CANVAS_LIMITS.maxPixels, `${label} has ${size.canvasWidth * size.canvasHeight} pixels`);
    assert(size.canvasWidth >= 1 && size.canvasHeight >= 1);
    return size;
  };
  // An ordinary page fits the pane at the display's density.
  const letter = within(pdfCanvasSize({ width: 612, height: 792 }, 802, 2), "a letter page");
  assert.deepEqual([letter.cssWidth, letter.canvasWidth], [800, 1600]);
  // The largest page (14,400 pt) shrinks below a quarter to fit the pane,
  // where a 0.25 floor drew 7,200 px a side.
  const huge = within(pdfCanvasSize({ width: 14_400, height: 14_400 }, 800, 2), "a 14,400 pt page");
  assert(huge.cssWidth <= 800 && huge.scale < 0.25, `a huge page drew at ${huge.scale}`);
  // UserUnit 2 doubles the page size pdf.js reports at scale 1.
  within(pdfCanvasSize({ width: 28_800, height: 28_800 }, 800, 2), "a UserUnit 2 page");
  // A tall, narrow page no longer passes the per-side canvas limit.
  const tall = within(pdfCanvasSize({ width: 200, height: 14_400 }, 800, 2), "a tall, narrow page");
  assert(tall.cssHeight <= PDF_CANVAS_LIMITS.maxSide, `a tall page is ${tall.cssHeight} CSS px high`);
  // A very high density display and a wide pane lower the drawing density,
  // not the size on screen.
  const dense = within(pdfCanvasSize({ width: 612, height: 792 }, 6000, 8), "a page at density 8");
  assert(dense.cssWidth === 2448 && dense.canvasWidth < 2448 * 8, `density 8 gave ${JSON.stringify(dense)}`);
  // Pages that cannot be drawn legibly in any budget are refused, not drawn.
  assert.deepEqual(pdfCanvasSize({ width: 1, height: 14_400 * 75_000 }, 800, 2), { tooLarge: true });
  assert.deepEqual(pdfCanvasSize({ width: 0, height: 792 }, 800, 2), { tooLarge: true });
  assert.deepEqual(pdfCanvasSize({ width: Number.NaN, height: 792 }, 800, 2), { tooLarge: true });
});
