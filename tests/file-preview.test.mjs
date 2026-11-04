import assert from "node:assert/strict";
import test from "node:test";
import { MARKDOWN_NODE_BUDGET, linkTarget, parseInline, parseMarkdown, parseMarkdownPreview } from "../src/lib/markdown.js";
import { failedModuleUrl, retryingImport } from "../src/lib/module-retry.js";
import { PDF_CANVAS_LIMITS, pdfCanvasSize } from "../src/lib/pdf-canvas.js";
import { pdfWorkerStarter } from "../src/lib/pdf-worker.js";
import { HIDDEN_FILES_KEY, ancestorsOf, entryRowId, isExpandable, normalizeTypedPath, readHiddenPreference, samePreview, saveHiddenPreference, treeKeyTarget, visibleRows } from "../src/lib/file-tree.js";

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
  let loads = 0;
  const load = retryingImport(() => { loads += 1; return Promise.reject(failure(`${origin}/assets/pdf-abc.js`)); }, {
    origin,
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
  // Without an address in the error (Safari), the original import is tried again.
  let plain = 0;
  const unnamed = retryingImport(() => (plain += 1) === 1 ? Promise.reject(new TypeError("Importing a module script failed.")) : Promise.resolve({ ok: true }), { origin, importUrl: () => assert.fail("no address to retry") });
  await assert.rejects(unnamed());
  assert.deepEqual(await unnamed(), { ok: true });
});

test("a retried module without the names its import gives is a failure and is never kept", async () => {
  const origin = "http://app.test";
  const failure = (url) => new TypeError(`Failed to fetch dynamically imported module: ${url}`);
  let loads = 0;
  const imported = [];
  // A shared chunk's own namespace (short names), as a retry of its address
  // gets when the original import picked pdf.js out of it.
  const answers = [{ a: "worker.mjs", p: {} }, { getDocument() {}, PDFWorker: class {} }];
  const load = retryingImport(() => { loads += 1; return Promise.reject(failure(`${origin}/assets/pdf-abc.js`)); }, {
    origin, exports: ["getDocument", "PDFWorker"],
    importUrl: (href) => { imported.push(href); return Promise.resolve(answers[imported.length - 1]); },
  });
  await assert.rejects(load(), /pdf-abc/);
  await assert.rejects(load(), /The loaded module has no getDocument, PDFWorker/);
  // Not kept: the next attempt starts again from the original import.
  await assert.rejects(load(), /pdf-abc/);
  assert.equal(loads, 2);
  const module = await load();
  assert.equal(module, answers[1]);
  assert.equal(await load(), module);
  assert.equal(imported.length, 2);
  // A module the original import gives is checked the same way.
  const direct = retryingImport(() => Promise.resolve({}), { exports: ["default"] });
  await assert.rejects(direct(), /no default/);
});

test("a pdf.js worker that fails before it is ready fails its document and is started afresh next time", async () => {
  const created = [];
  class FakeWorker extends EventTarget {
    constructor(url) { super(); this.url = url; this.terminated = false; created.push(this); }
    terminate() { this.terminated = true; }
  }
  const start = pdfWorkerStarter({ createWorker: (url) => new FakeWorker(url), base: () => "http://app.test/files", startupMs: 1000 });
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
  const start = pdfWorkerStarter({ createWorker: (url) => new SilentWorker(url), base: () => "http://app.test/files", startupMs: 30 });
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
