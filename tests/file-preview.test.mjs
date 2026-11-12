import assert from "node:assert/strict";
import test from "node:test";
import { MARKDOWN_NODE_BUDGET, linkTarget, parseInline, parseMarkdown, parseMarkdownPreview } from "../src/lib/markdown.js";
import { failedModuleUrl, retryingImport } from "../src/lib/module-retry.js";
import { PDF_CANVAS_LIMITS, pdfCanvasSize } from "../src/lib/pdf-canvas.js";
import { pdfWorkerStarter } from "../src/lib/pdf-worker.js";
import { HIDDEN_FILES_KEY, MAX_REVEAL_ENTRIES, ancestorsOf, entryRowId, failedPreview, isExpandable, loadingPreview, needsPage, normalizeTypedPath, openedPath, readHiddenPreference, rendersAfresh, revealable, revealPath, revealReads, samePreview, saveHiddenPreference, shownPreview, treeKeyTarget, viewerFailure, visibleRows, worktreeOwnsChat } from "../src/lib/file-tree.js";

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
    // A link label may hold images, so each "[![" scans past the image it opens and no further.
    "image openers in link labels": fill("[!["), "badges without a link target": fill("[![a](b)"), "badges before a rejected link": fill("[![a](b) x", "](t"),
    "escaped brackets in labels": fill("[\\[ ![a](b) ", "](t)"),
    // Link destinations are scanned once per label: a long space or tab run
    // after "(" was quadratic in the old pattern's overlapping quantifiers.
    "empty labels before spaces": fill(`[](${" ".repeat(2000)}`),
    "empty labels before spaces and a newline": fill(`[](${" ".repeat(1000)}\n${" ".repeat(1000)}`),
    "labels before spaces": fill(`[x](${" ".repeat(1000)}`),
    "labels before tabs": fill(`[x](${"\t".repeat(2000)}`),
    "labels before an unclosed title": fill(`[x]( "${"a".repeat(2000)}`),
    "labels before a title without a closing parenthesis": fill(`[x](a "t"${" ".repeat(1000)}`),
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
    // The work is counted, including every link destination scan, so the
    // bound holds however loaded the machine is. The clock only catches a
    // pattern that backtracks outside the count; no pattern left in the
    // parser has adjacent quantifiers that can match the same text.
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

test("the Markdown budget counts every element the preview renders", () => {
  // An empty fenced block renders pre and code: 30,000 of them render the
  // full budget, and one more is over it rather than mounting past the limit.
  const fences = (count) => parseMarkdownPreview("```\n```\n".repeat(count));
  assert.deepEqual([fences(MARKDOWN_NODE_BUDGET / 2).overBudget, fences(MARKDOWN_NODE_BUDGET / 2).blocks.length], [false, MARKDOWN_NODE_BUDGET / 2]);
  assert.equal(fences(MARKDOWN_NODE_BUDGET / 2 + 1).overBudget, true);
  // A task item renders ul, li and its checkbox, then the paragraph and text.
  assert.deepEqual([4, 5].map((budget) => parseMarkdownPreview("- [x] a", budget).overBudget), [true, false]);
  // A one-cell table renders a wrapper, table, thead, tr, th, tbody, tr and td, plus two texts.
  assert.deepEqual([9, 10].map((budget) => parseMarkdownPreview("| h |\n| - |\n| d |", budget).overBudget), [true, false]);
  // An autolink renders the link and its text inside the paragraph.
  assert.deepEqual([2, 3].map((budget) => parseMarkdownPreview("<https://a.b>", budget).overBudget), [true, false]);
  // An image is charged as it renders once it fails: a note and its Retry button.
  assert.deepEqual([2, 3].map((budget) => parseMarkdownPreview("![](x)", budget).overBudget), [true, false]);
  assert.equal(parseMarkdownPreview("![](x)".repeat(MARKDOWN_NODE_BUDGET / 2)).overBudget, true);
});

test("a code span closes only on a backtick run of the opener's exact length", () => {
  const code = (text) => parseInline(text).map((node) => node.type === "code" ? `<${node.value}>` : node.value).join("");
  assert.deepEqual(["`a `` b`", "``a ` b``", "`` `x` ``", "```a``b```", "`a``", "``a`"].map(code),
    ["<a `` b>", "<a ` b>", "<`x`>", "<a``b>", "`a``", "``a`"]);
  // A run longer than 32 backticks stays text, and scanning stays linear.
  const long = "`".repeat(40);
  assert.equal(code(`x ${long} y ${long}`), `x ${long} y ${long}`);
  const started = performance.now();
  parseInline(`${"`".repeat(31)} a `.repeat(3000));
  parseInline(`${"`a".repeat(50_000)}\`\``);
  assert.ok(performance.now() - started < 500, `took ${Math.round(performance.now() - started)} ms`);
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

test("entries without a path keep distinct row ids when their names decode alike", () => {
  const entries = [
    { name: "a\uFFFD", path: "odd/a\uFFFD", kind: "file" },
    { name: "a\uFFFD", path: null, nameKey: "Yf4", kind: "directory" },
    { name: "a\uFFFD", path: null, nameKey: "Yf8", kind: "directory" },
  ];
  const folders = new Map([["", { status: "loaded", entries: [{ name: "odd", path: "odd", kind: "directory" }], total: 1 }], ["odd", { status: "loaded", entries, total: 3 }]]);
  const ids = visibleRows(folders, new Set(["odd"])).map((row) => row.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(entries.map((entry) => entryRowId("odd", entry)), ["entry:odd/a\uFFFD", 'raw:["odd","Yf4"]', 'raw:["odd","Yf8"]']);
  // A row id is a DOM attribute value, so it holds no NUL or control character.
  assert.ok(ids.every((id) => !/[\u0000-\u001f]/.test(id)), JSON.stringify(ids));
  // A folder path and a name key cannot combine into another row's id.
  assert.notEqual(entryRowId("a", { path: null, nameKey: "b" }), entryRowId("a\",\"b", { path: null, nameKey: "" }));
  assert.deepEqual(visibleRows(folders, new Set(["odd"])).filter((row) => row.type === "entry").map((row) => row.expandable), [true, false, false, false]);
});

test("tree rows follow open folders lazily and keyboard moves stay within them", () => {
  const folders = new Map(Object.entries({
    "": { status: "loaded", entries: [{ name: "src", path: "src", kind: "directory" }, { name: "link", path: "link", kind: "symlink", target: { state: "directory", path: "src" } }, { name: "a.md", path: "a.md", kind: "file" }], total: 3, nextCursor: null },
    src: { status: "loaded", entries: [{ name: "b.js", path: "src/b.js", kind: "file" }], total: 450, remaining: 449, nextCursor: "next" },
    link: { status: "error", error: { message: "gone", code: "MISSING" } },
  }));
  const rows = visibleRows(folders, new Set(["src", "link"]));
  assert.deepEqual(rows.map((row) => row.id), ["entry:src", "entry:src/b.js", "more:src", "entry:link", "error:link", "entry:a.md"]);
  assert.deepEqual([rows[1].level, rows[1].setSize, rows[2].remaining, rows[3].expandable], [2, 450, 449, true]);
  assert.deepEqual(visibleRows(folders, new Set()).map((row) => row.id), ["entry:src", "entry:link", "entry:a.md"]);
  // 200 entries listed, 199 of them since deleted, then the next page of a
  // folder now 251 long: what is left is the server's count after that page,
  // never the fresh total minus entries kept from the older listing.
  const mixed = (extra) => new Map([["", { status: "loaded", entries: Array.from({ length: 400 }, (_, index) => ({ name: `f${index}`, path: `f${index}`, kind: "file" })), total: 251, nextCursor: "next", ...extra }]]);
  const mixedRows = visibleRows(mixed({ remaining: 50 }));
  assert.deepEqual([mixedRows.at(-1).remaining, mixedRows[0].setSize], [50, 450]);
  // Without the server's count, nothing negative or invented is offered.
  const uncounted = visibleRows(mixed({}));
  assert.deepEqual([uncounted.at(-1).remaining, uncounted[0].setSize], [null, 400]);
  assert.deepEqual(visibleRows(new Map(), new Set()).map((row) => row.type), ["loading"]);
  assert.equal(treeKeyTarget(rows, 1, "ArrowLeft"), 0);
  assert.equal(treeKeyTarget(rows, 0, "ArrowRight"), 1);
  assert.equal(treeKeyTarget(rows, 5, "ArrowRight"), -1);
  assert.equal(treeKeyTarget(rows, 0, "End"), 5);
  assert.equal(treeKeyTarget(rows, 0, "a"), 5);
  assert.equal(treeKeyTarget(rows, 5, "ArrowDown"), 5);
  assert.deepEqual([normalizeTypedPath("./src//b.js/"), normalizeTypedPath("/README.md"), ancestorsOf("a/b/c.md")], ["src/b.js", "README.md", ["a", "a/b"]]);
  // Spaces and backslashes belong to POSIX names: a typed path keeps them, so
  // it never opens a different sibling ("a\\b.md" is not "a/b.md").
  assert.deepEqual([" notes.md", "report.md ", "a\\b.md", "docs/ x .md"].map(normalizeTypedPath), [" notes.md", "report.md ", "a\\b.md", "docs/ x .md"]);
  assert.deepEqual(["", "   ", null].map(normalizeTypedPath), ["", "", ""]);
  // "." segments name nothing, as the runtime drops them, so the tree finds the file the preview opens.
  assert.deepEqual(["docs/./guide.md", "./docs/././guide.md", "docs/.hidden/./a.md"].map(normalizeTypedPath), ["docs/guide.md", "docs/guide.md", "docs/.hidden/a.md"]);
  // Long runs of "/" are linear: 40,000 inside a path normalize at once.
  const slashes = "/".repeat(40_000);
  const started = performance.now();
  assert.deepEqual([normalizeTypedPath(`a${slashes}b`), normalizeTypedPath(`a${slashes}b${slashes}`)], ["a/b", "a/b"]);
  assert.ok(performance.now() - started < 200, `normalizing took ${Math.round(performance.now() - started)} ms`);
  // A Markdown link resolves to the exact name it encodes.
  assert.deepEqual(["a%5Cb.md", "%20notes.md", "report.md%20"].map((url) => linkTarget(url, "README.md")),
    [{ kind: "file", path: "a\\b.md" }, { kind: "file", path: " notes.md" }, { kind: "file", path: "report.md " }]);
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
  assert.deepEqual(visibleRows(folders, new Set(["src"])).map((row) => [row.id, row.open ?? null]), [['raw:["","caf\uFFFD"]', false], ["entry:src", true], ["entry:src", false]]);
});

test("a folder's next page waits while its first page reloads, and listing unavailable is its own state", () => {
  const folder = (status) => ({ status, entries: [{ name: "a", path: "a", kind: "file" }], total: 300, nextCursor: "page-2" });
  assert.equal(visibleRows(new Map([["", folder("loaded")]]), new Set()).at(-1).loading, false);
  assert.equal(visibleRows(new Map([["", folder("loading")]]), new Set()).at(-1).loading, true);
  const unavailable = visibleRows(new Map([["", { status: "error", error: { message: "Folder listing is unavailable", code: "LISTING_UNAVAILABLE" } }]]), new Set());
  assert.deepEqual(unavailable.map((row) => [row.id, row.type]), [["unavailable:", "unavailable"]]);
});

test("a fully open chain as deep as the deepest revealable path lists every row without overflowing", () => {
  const depth = 2047;
  const folders = new Map();
  let directory = "";
  for (let level = 1; level <= depth; level += 1) {
    const path = directory ? `${directory}/a` : "a";
    folders.set(directory, { status: "loaded", entries: [{ name: "a", path, kind: "directory" }], total: 1, nextCursor: level === 1 ? "next" : null, remaining: 4, truncated: level === 2, scanLimit: 10 });
    directory = path;
  }
  folders.set(directory, { status: "loaded", entries: [{ name: "b", path: `${directory}/b`, kind: "file" }], total: 1, nextCursor: null });
  const rows = visibleRows(folders, new Set(folders.keys()));
  // Depth first: each folder, then its subtree, then the deepest file; the
  // truncated and "load more" rows close their folders' subtrees afterwards.
  assert.equal(rows.length, depth + 3);
  assert.deepEqual(rows.slice(0, depth + 1).map((row) => row.level), Array.from({ length: depth + 1 }, (_, index) => index + 1));
  assert.deepEqual([rows[depth].entry.path, rows[depth].position, rows[depth].setSize], [`${"a/".repeat(depth)}b`, 1, 1]);
  assert.deepEqual(rows.slice(-2).map((row) => [row.id, row.level]), [["truncated:a", 2], ["more:", 1]]);
  assert.deepEqual([rows[0].setSize, rows.at(-1).remaining], [5, 4]);
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

test("a refresh keeps text only when the text is the same, and an image or PDF only on the same version", () => {
  const markdown = { previewType: "markdown", text: "# Old\n", size: 6, version: "v1", link: null };
  assert.equal(samePreview(markdown, { ...markdown }), true);
  // The same version with other text is a change the version could not see.
  assert.equal(samePreview(markdown, { ...markdown, text: "# New\n" }), false);
  assert.equal(samePreview(markdown, { ...markdown, version: "v2" }), true);
  // A byte order mark added or removed decodes to the same text at a new size.
  assert.equal(samePreview(markdown, { ...markdown, size: markdown.size + 3, version: "v2" }), false);
  assert.equal(samePreview({ ...markdown, size: markdown.size + 3 }, markdown), false);
  assert.equal(samePreview(markdown, { ...markdown, link: { target: "docs/notes.md" } }), false);
  assert.equal(samePreview(markdown, { ...markdown, previewType: "text" }), false);
  const pdf = { previewType: "pdf", mimeType: "application/pdf", size: 900, version: "v1", link: null };
  assert.equal(samePreview(pdf, { ...pdf }), true);
  assert.equal(samePreview(pdf, { ...pdf, version: "v2" }), false);
  assert.equal(samePreview({ previewType: "oversized", size: 9, limit: 4, version: "v1" }, { previewType: "oversized", size: 9, limit: 8, version: "v1" }), false);
});

test("a module that failed to load is loaded again at a fresh address, and a loaded module is kept", async () => {
  const origin = "http://app.test";
  const failure = (url) => new TypeError(`Failed to fetch dynamically imported module: ${url}`);
  assert.equal(failedModuleUrl(failure("https://cdn.test/pdf.js"), origin), null);
  assert.equal(failedModuleUrl(new TypeError("Importing a module script failed."), origin), null);
  const imported = [];
  const probed = [];
  let loads = 0;
  const load = retryingImport(() => { loads += 1; return Promise.reject(failure(`${origin}/assets/pdf-abc.js`)); }, {
    origin,
    probe: async (href) => { probed.push(href); return "unreachable"; },
    importUrl: (href) => { imported.push(href); return imported.length === 1 ? Promise.reject(failure(href)) : Promise.resolve({ default: href }); },
  });
  await assert.rejects(load(), /pdf-abc/);
  // The browser would fail the same address again without a request.
  await assert.rejects(load(), /retry=/);
  const module = await load();
  assert.equal(loads, 1);
  assert.equal(imported.length, 2);
  assert.notEqual(new URL(imported[0]).searchParams.get("retry"), new URL(imported[1]).searchParams.get("retry"));
  assert.deepEqual(imported.map((href) => new URL(href).pathname), ["/assets/pdf-abc.js", "/assets/pdf-abc.js"]);
  assert.equal(await load(), module);
  assert.equal(imported.length, 2);
  assert.deepEqual(probed.map((href) => new URL(href).pathname), ["/assets/pdf-abc.js", "/assets/pdf-abc.js"]);
  // Without an address in the error (Safari), the original import is tried again.
  let plain = 0;
  const unnamed = retryingImport(() => (plain += 1) === 1 ? Promise.reject(new TypeError("Importing a module script failed.")) : Promise.resolve({ ok: true }), { origin, importUrl: () => assert.fail("no address to retry"), probe: () => assert.fail("no address to probe") });
  await assert.rejects(unnamed());
  assert.deepEqual(await unnamed(), { ok: true });
});

test("a pdf.js worker that fails before it is ready fails its document and is started afresh next time", async () => {
  const created = [];
  class FakeWorker extends EventTarget {
    constructor(url) { super(); this.url = url; this.terminated = false; created.push(this); }
    terminate() { this.terminated = true; }
  }
  const start = pdfWorkerStarter({ createWorker: (url) => new FakeWorker(url), base: () => "http://app.test/files", startupMs: 1000, probe: async () => "unreachable" });
  const message = (data) => Object.assign(new Event("message"), { data });
  const first = start("/assets/pdf.worker.mjs");
  first.worker.dispatchEvent(new Event("error"));
  await assert.rejects(first.ready, /The PDF reader did not start/);
  assert.equal(first.worker.terminated, true);
  // After a failure the script is asked for at a new address, again after each one.
  const second = start("/assets/pdf.worker.mjs");
  second.worker.dispatchEvent(new Event("error"));
  await assert.rejects(second.ready);
  const third = start("/assets/pdf.worker.mjs");
  assert.deepEqual(created.map((worker) => worker.url), ["http://app.test/assets/pdf.worker.mjs", "http://app.test/assets/pdf.worker.mjs?retry=1", "http://app.test/assets/pdf.worker.mjs?retry=2"]);
  // Only pdf.js's own "ready" starts the document; other messages do not.
  let ready = false;
  void third.ready.then(() => { ready = true; });
  third.worker.dispatchEvent(message({ sourceName: "main", action: "ready" }));
  third.worker.dispatchEvent(message({ sourceName: "worker", action: "configure" }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ready, false);
  third.worker.dispatchEvent(message({ sourceName: "worker", targetName: "main", action: "ready", data: null }));
  await third.ready;
  // An error after it is ready is pdf.js's to report, and the worker stays its own.
  third.worker.dispatchEvent(new Event("error"));
  assert.equal(third.worker.terminated, false);
  // A worker that started clears the failure: the next start uses the plain address.
  const last = start("/assets/pdf.worker.mjs");
  last.ready.catch(() => {});
  assert.equal(last.worker.url, "http://app.test/assets/pdf.worker.mjs");
});

test("a pdf.js worker that stays silent past its startup deadline is ended and fails its document", async () => {
  const created = [];
  class SilentWorker extends EventTarget {
    constructor(url) { super(); this.url = url; this.terminated = false; created.push(this); }
    terminate() { this.terminated = true; }
  }
  const start = pdfWorkerStarter({ createWorker: (url) => new SilentWorker(url), base: () => "http://app.test/files", startupMs: 30, probe: async () => "unreachable" });
  const silent = start("/assets/pdf.worker.mjs");
  await assert.rejects(silent.ready, /The PDF reader did not start in time/);
  assert.equal(silent.worker.terminated, true);
  // The next start asks for the script afresh and, once ready, is not ended later.
  const next = start("/assets/pdf.worker.mjs");
  assert.equal(next.worker.url, "http://app.test/assets/pdf.worker.mjs?retry=1");
  next.worker.dispatchEvent(Object.assign(new Event("message"), { data: { sourceName: "worker", action: "ready" } }));
  await next.ready;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(next.worker.terminated, false);
});

test("the hidden-files choice is saved when storage allows it, and storage that refuses never throws", () => {
  const saved = new Map();
  const working = () => ({ getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => { saved.set(key, value); } });
  assert.equal(readHiddenPreference(working), false);
  assert.equal(saveHiddenPreference(working, true), true);
  assert.equal(saved.get(HIDDEN_FILES_KEY), "true");
  assert.equal(readHiddenPreference(working), true);
  const quota = Object.assign(new Error("The quota has been exceeded."), { name: "QuotaExceededError" });
  const security = Object.assign(new Error("Access is denied for this document."), { name: "SecurityError" });
  const full = () => ({ getItem: () => { throw security; }, setItem: () => { throw quota; } });
  assert.equal(readHiddenPreference(full), false);
  assert.equal(saveHiddenPreference(full, true), false);
  // A browser can refuse the localStorage property itself.
  const refused = () => { throw security; };
  assert.equal(readHiddenPreference(refused), false);
  assert.equal(saveHiddenPreference(refused, false), false);
});

const listed = (directory, names, extra = {}) => ({ status: "loaded", entries: names.map((name) => ({ name, path: directory ? `${directory}/${name}` : name, kind: name.includes(".") ? "file" : "directory" })), ...extra });

test("Go to file reads every folder on its way until the next step is listed, including folders already shown without it", () => {
  const page = Array.from({ length: 200 }, (_, index) => `f${String(index).padStart(3, "0")}.txt`);
  const folders = new Map([["", listed("", ["src", ...page], { nextCursor: "c1" })], ["src", listed("src", page, { nextCursor: "c2" })]]);
  // src is listed at the root, so only src itself, whose first page lacks
  // the file, is read again, from its shown entries on until the file appears.
  assert.deepEqual(revealReads(folders, "src/z.txt"), [{ directory: "src", find: "src/z.txt", keep: 200, depth: 1 }]);
  assert.deepEqual(revealReads(folders, "src/f001.txt"), []);
  // A folder not loaded yet, or one that failed, is read with the step to find.
  assert.deepEqual(revealReads(folders, "lib/deep/a.md"), [{ directory: "", find: "lib", keep: 201, depth: 0 },
    { directory: "lib", find: "lib/deep", keep: 0, depth: 1 }, { directory: "lib/deep", find: "lib/deep/a.md", keep: 0, depth: 2 }]);
  folders.set("src", { status: "error", error: { message: "gone" } });
  assert.deepEqual(revealReads(folders, "src/f001.txt"), [{ directory: "src", find: "src/f001.txt", keep: 0, depth: 1 }]);
});

test("Go to file reads one folder at a time and stops at the first folder that does not list its next step", async () => {
  const listings = new Map([["", listed("", ["a", "refused", "z.md"])], ["a", listed("a", ["a", "b"])], ["a/a", listed("a/a", ["x.md"])], ["a/b", listed("a/b", ["c.md"])]]);
  let reads = [];
  let inFlight = 0;
  let most = 0;
  const read = async ({ directory }) => {
    reads.push(directory);
    most = Math.max(most, ++inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight -= 1;
    // A refused or missing folder lists nothing.
    return listings.get(directory)?.entries;
  };
  const always = () => true;
  assert.equal(await revealPath(new Map(), "a/b/c.md", read, always), true);
  assert.deepEqual([reads, most], [["", "a", "a/b"], 1]);
  // A path far deeper than what exists costs one read per folder that does
  // exist on its way, never one per typed step.
  for (const [path, expected] of [[`${"a/".repeat(1000)}x.md`, ["", "a", "a/a"]], [`${"q/".repeat(1000)}x.md`, [""]], ["refused/deep/x.md", ["", "refused"]]]) {
    reads = [];
    assert.equal(await revealPath(new Map(), path, read, always), false, path);
    assert.deepEqual(reads, expected, path);
  }
  // Folders that already list their next step are not read again.
  reads = [];
  assert.equal(await revealPath(listings, "a/b/c.md", read, always), true);
  assert.deepEqual(reads, []);
  // A newer reveal stops this one after the read in flight.
  reads = [];
  let current = true;
  const superseding = (step) => { const result = read(step); current = false; return result; };
  assert.equal(await revealPath(new Map(), "a/b/c.md", superseding, () => current), false);
  assert.deepEqual(reads, [""]);
});

test("a path the runtime refuses is never planned or read, and one within its limit is planned in linear time", async () => {
  let reads = 0;
  const read = async () => { reads += 1; return []; };
  const huge = "a/".repeat(500_000);
  let started = performance.now();
  for (const path of [huge, `${"a".repeat(4096)}/x`, "a/\0/b.md"]) {
    assert.equal(revealable(path), false);
    assert.equal(await revealPath(new Map(), path, read, () => true), false);
  }
  assert.equal(reads, 0);
  assert.ok(performance.now() - started < 100, `refusing took ${Math.round(performance.now() - started)} ms`);
  // The deepest path the runtime accepts: 2,047 folders, each prefix sliced once.
  const deepest = `${"a/".repeat(2047)}b`;
  started = performance.now();
  const chain = ancestorsOf(deepest);
  const steps = revealReads(new Map(), deepest, chain);
  assert.deepEqual([revealable(deepest), chain.length, chain.at(-1).length, steps.length, steps.at(-1).depth], [true, 2047, 4093, 2048, 2047]);
  assert.ok(performance.now() - started < 200, `planning took ${Math.round(performance.now() - started)} ms`);
});

test("a folder read pages on to keep its shown entries or reach the target, and stops at the reveal bound", () => {
  const entries = (count, from = 0) => Array.from({ length: count }, (_, index) => ({ path: `d/${from + index}` }));
  // Refresh: the shown count is listed again, and nothing more.
  assert.equal(needsPage(entries(200), { keep: 450 }), true);
  assert.equal(needsPage(entries(500), { keep: 450 }), false);
  // Go to file: pages continue until the target is listed.
  assert.equal(needsPage(entries(500), { find: "d/1200" }), true);
  assert.equal(needsPage(entries(1500), { find: "d/1200" }), false);
  // A target past the bound, or absent, ends the read at the bound.
  assert.equal(needsPage(entries(MAX_REVEAL_ENTRIES - 1), { find: "d/missing" }), true);
  assert.equal(needsPage(entries(MAX_REVEAL_ENTRIES), { find: "d/missing" }), false);
  assert.equal(needsPage(entries(10)), false);
});

test("a run that ends in an open or archived chat of the shown worktree refreshes Files; one elsewhere does not, and no lookup reads a chat list", async () => {
  const shown = { projectId: "p", worktreeId: "w" };
  const stored = new Map([["archived-1", { id: "archived-1", projectId: "p", worktreeId: "w", archived: true }], ["elsewhere", { id: "elsewhere", projectId: "p", worktreeId: "other" }],
    ["other-project", { id: "other-project", projectId: "q", worktreeId: "w" }]]);
  const read = [];
  // One chat is read by its id: the cost is the same however many chats were archived.
  const readChat = (id) => { read.push(id); return stored.has(id) ? Promise.resolve(stored.get(id)) : Promise.reject(Object.assign(new Error("Conversation not found"), { status: 404 })); };
  const known = [{ id: "open-1", projectId: "p", worktreeId: "w" }, { id: "open-elsewhere", projectId: "p", worktreeId: "other" }];
  // A listed chat is known without asking, in this worktree or another.
  assert.equal(await worktreeOwnsChat("open-1", shown, known, readChat), true);
  assert.equal(await worktreeOwnsChat("open-elsewhere", shown, known, readChat), false);
  assert.deepEqual(read, []);
  // A chat archived while its run finished is not listed, and is read alone.
  assert.equal(await worktreeOwnsChat("archived-1", shown, known, readChat), true);
  assert.equal(await worktreeOwnsChat("elsewhere", shown, known, readChat), false);
  assert.equal(await worktreeOwnsChat("other-project", shown, known, readChat), false);
  assert.deepEqual(read, ["archived-1", "elsewhere", "other-project"]);
  // A chat that cannot be read, or no longer exists, is no evidence of ownership.
  assert.equal(await worktreeOwnsChat("gone", shown, known, readChat), false);
  assert.equal(await worktreeOwnsChat("archived-1", shown, [], () => Promise.reject(new Error("offline"))), false);
});

test("a run of three emphasis delimiters nests strong and emphasis either way round", () => {
  assert.deepEqual(parseInline("***x***"), [{ type: "strong", children: [{ type: "emphasis", children: [{ type: "text", value: "x" }] }] }]);
  assert.deepEqual(parseInline("___x___"), [{ type: "strong", children: [{ type: "emphasis", children: [{ type: "text", value: "x" }] }] }]);
  assert.deepEqual(parseInline("***x** y*"), [{ type: "emphasis", children: [{ type: "strong", children: [{ type: "text", value: "x" }] }, { type: "text", value: " y" }] }]);
  // A run of two is unchanged: its closer takes the first two of a longer run.
  assert.deepEqual(parseInline("**a***"), [{ type: "strong", children: [{ type: "text", value: "a" }] }, { type: "text", value: "*" }]);
  assert.deepEqual(parseInline("a ***b*** c **d**").map((node) => node.type), ["text", "strong", "text", "strong"]);
});

// FilePreview names its file (loading text, aria-label, MISSING and
// BROKEN_LINK text, Refresh folder and editor targets) by openedPath, and
// keeps a shown preview on refresh only when shownPreview returns it.
test("a preview's resolved path and kept state never carry over to another file or another worktree's file of the same name", () => {
  const a = { projectId: "p1", worktreePath: "/w/main", file: "docs/link.md" };
  const ready = { status: "ready", target: a, path: "docs/real.md", preview: { previewType: "text", text: "a", size: 1 } };
  assert.equal(openedPath(ready, a), "docs/real.md");
  assert.equal(shownPreview(ready, a, false), ready);
  assert.equal(shownPreview(ready, a, true), null);
  const missing = Object.assign(new Error("gone"), { payload: { code: "MISSING" } });
  // A new selection that is missing names itself, not the file shown before.
  const b = { ...a, file: "notes/b.md" };
  const loadingB = loadingPreview(ready, b);
  assert.equal(openedPath(loadingB, b), "notes/b.md");
  const errorB = failedPreview(loadingB, b, missing);
  assert.deepEqual([errorB.code, openedPath(errorB, b)], ["MISSING", "notes/b.md"]);
  assert.equal(openedPath(failedPreview(ready, b, missing), b), "notes/b.md");
  // Another worktree's file of the same name is a new target: nothing is kept.
  const other = { ...a, worktreePath: "/w/feature" };
  assert.equal(shownPreview(ready, other, false), null);
  assert.equal(openedPath(ready, other), "docs/link.md");
  assert.equal(openedPath(failedPreview(ready, other, missing), other), "docs/link.md");
  assert.equal(shownPreview(ready, { ...a, projectId: "p2" }, false), null);
  // Retrying the same target keeps the path the runtime resolved.
  const errorA = failedPreview(loadingPreview(ready, a), a, missing);
  assert.equal(openedPath(errorA, a), "docs/real.md");
  assert.equal(openedPath(loadingPreview(errorA, a), a), "docs/real.md");
});

test("ArrowLeft from an index outside the rows is not a move", () => {
  const rows = [{ id: "entry:a", type: "entry", entry: { path: "a", name: "a" }, directory: "" }];
  assert.equal(treeKeyTarget(rows, 5, "ArrowLeft"), -1);
  assert.equal(treeKeyTarget(rows, -1, "ArrowLeft"), -1);
});

test("type-ahead from an index outside the rows searches from the top", () => {
  const entry = (name) => ({ id: `entry:${name}`, type: "entry", entry: { path: name, name }, directory: "" });
  const rows = [entry("a"), entry("b")];
  for (const index of [-3, rows.length + 2, Number.NaN]) assert.equal(treeKeyTarget(rows, index, "b"), 1);
  assert.equal(treeKeyTarget(rows, -3, "a"), 0);
  assert.equal(treeKeyTarget(rows, -1, "a"), 0);
  assert.equal(treeKeyTarget(rows, 0, "a"), 0);
});

test("every key from any index moves to a row or nowhere, and an index outside the rows is no row", () => {
  const rows = [
    { id: "entry:d", type: "entry", entry: { path: "d", name: "d" }, directory: "", open: true },
    { id: "entry:d/b", type: "entry", entry: { path: "d/b", name: "b" }, directory: "d" },
    { id: "entry:c", type: "entry", entry: { path: "c", name: "c" }, directory: "" },
  ];
  const last = rows.length - 1;
  for (const key of ["ArrowDown", "ArrowUp", "Home", "End", "ArrowLeft", "ArrowRight", "b"]) {
    for (const index of [-3, -1, 0, last, rows.length, rows.length + 2, Number.NaN, 1.5]) {
      const target = treeKeyTarget(rows, index, key);
      assert.ok(target === -1 || (Number.isInteger(target) && target >= 0 && target <= last), `${key} from ${index} gave ${target}`);
      // An index that names no row moves as no row (-1) does.
      if (!(Number.isInteger(index) && index >= 0 && index <= last)) assert.equal(target, treeKeyTarget(rows, -1, key), `${key} from ${index}`);
    }
  }
  assert.deepEqual(["ArrowDown", "ArrowUp", "Home", "End", "ArrowLeft", "ArrowRight", "b"].map((key) => treeKeyTarget(rows, -1, key)), [0, 0, 0, last, -1, -1, 1]);
  assert.deepEqual([treeKeyTarget(rows, last, "ArrowDown"), treeKeyTarget(rows, 0, "ArrowUp"), treeKeyTarget(rows, 1, "ArrowLeft"), treeKeyTarget(rows, 0, "ArrowRight")], [last, 0, 0, 1]);
});

test("a viewer error is cleared when the preview it rendered is replaced, not when an unchanged one is kept", () => {
  const shown = { previewType: "pdf", version: "v1", size: 10 };
  const props = { resetKey: 1, preview: shown };
  // A background answer samePreview accepts keeps the shown preview object.
  assert.equal(samePreview(shown, { ...shown }), true);
  assert.equal(rendersAfresh(props, { resetKey: 1, preview: shown }), false);
  // A changed answer (unsupported, oversized or a new version) replaces it, as does a refresh.
  for (const next of [{ previewType: "unsupported", reason: "x" }, { previewType: "oversized", size: 10, limit: 5 }, { ...shown, version: "v2" }]) {
    assert.equal(samePreview(shown, next), false);
    assert.equal(rendersAfresh(props, { resetKey: 1, preview: next }), true);
  }
  assert.equal(rendersAfresh(props, { resetKey: 2, preview: shown }), true);
});

test("a link whose label holds an image links to its own target, and unresolved brackets stay text", () => {
  const show = (text) => parseInline(text).map((node) => node.type === "link" ? `<a ${node.url}>${show.children(node.children)}</a>` : node.type === "image" ? `<img ${node.url} ${node.alt}>` : node.value).join("");
  show.children = (nodes) => nodes.map((node) => node.type === "image" ? `<img ${node.url} ${node.alt}>` : node.value).join("");
  assert.equal(show("[![CI](badge.svg)](https://ci.example/run)"), "<a https://ci.example/run><img badge.svg CI></a>");
  assert.equal(show("[Build ![CI](badge.svg) status](run.md) after"), "<a run.md>Build <img badge.svg CI> status</a> after");
  assert.equal(show("[![a](x) ![b](y)](t)"), "<a t><img x a> <img y b></a>");
  assert.equal(show("[a [b] c](x)"), "[a [b] c](x)");
  // An unclosed label is text before the image, with no link to the image.
  assert.equal(show("[![a](b)"), "[<img b a>");
  assert.equal(show("[![a](b)](c"), "[<img b a>](c");
  assert.equal(show("[[x](y)"), "[<a y>x</a>");
  // An escaped "[" in a label is text, as before.
  assert.equal(show("[a \\[ ![b](c) d](x)"), "<a x>a [ <img c b> d</a>");
  const links = (text) => parseInline(text).filter((node) => node.type === "link").map((node) => node.url);
  for (const text of ["[![CI](badge.svg)](https://ci.example/run)", "[![a](b)", "[![a](b)](c", "[x [![a](b)](c)"]) assert.ok(!links(text).includes("badge.svg") && !links(text).includes("b"), text);
  // The link, its image (a note and Retry once failed) and the paragraph are charged as before.
  assert.deepEqual([3, 4].map((budget) => parseMarkdownPreview("[![CI](badge.svg)](run)", budget).overBudget), [true, false]);
});

test("a viewer that did not load offers a page reload when only a reload repairs it, and a retry only when one can help", async () => {
  assert.deepEqual(viewerFailure(Object.assign(new Error("gone"), { reloadRequired: true })), { reload: true, retry: false });
  assert.deepEqual(viewerFailure(Object.assign(new Error("late"), { reloadRequired: true, retryable: true })), { reload: true, retry: true });
  assert.deepEqual(viewerFailure(new Error("offline")), { reload: false, retry: true });
  assert.deepEqual(viewerFailure(undefined), { reload: false, retry: true });
  // A chunk gone after an update: the first failure only retries, the retried address probed gone asks for the reload.
  const origin = "http://app.test";
  const failure = (url) => new TypeError(`Failed to fetch dynamically imported module: ${url}`);
  const probes = ["unreachable", "gone"];
  const load = retryingImport(() => Promise.reject(failure(`${origin}/assets/PdfPreview-abc.js`)), {
    origin, exports: ["default"], probe: async () => probes.shift(), importUrl: (href) => Promise.reject(failure(href)),
  });
  const first = await load().catch((error) => error);
  assert.deepEqual(viewerFailure(first), { reload: false, retry: true });
  const second = await load().catch((error) => error);
  assert.equal(second.reloadRequired, true);
  assert.deepEqual(viewerFailure(second), { reload: true, retry: false });
  assert.deepEqual(probes, []);
});
