import assert from "node:assert/strict";
import test from "node:test";
import { linkTarget, parseInline, parseMarkdown } from "../src/lib/markdown.js";
import { ancestorsOf, normalizeTypedPath, treeKeyTarget, visibleRows } from "../src/lib/file-tree.js";

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

test("adversarial Markdown parses in bounded time", () => {
  const started = performance.now();
  for (const source of ["*a ".repeat(40_000), "[".repeat(80_000), "`".repeat(80_000), "_a ".repeat(40_000), "**".repeat(40_000), "> ".repeat(20_000)]) parseMarkdown(source);
  assert.ok(performance.now() - started < 3000, `parsing took ${Math.round(performance.now() - started)}ms`);
});

test("tree rows follow open folders lazily and keyboard moves stay within them", () => {
  const folders = {
    "": { status: "loaded", entries: [{ name: "src", path: "src", kind: "directory" }, { name: "link", path: "link", kind: "symlink", target: { state: "directory", path: "src" } }, { name: "a.md", path: "a.md", kind: "file" }], total: 3, nextCursor: null },
    src: { status: "loaded", entries: [{ name: "b.js", path: "src/b.js", kind: "file" }], total: 450, nextCursor: "next" },
    link: { status: "error", error: { message: "gone", code: "MISSING" } },
  };
  const rows = visibleRows(folders, new Set(["src", "link"]));
  assert.deepEqual(rows.map((row) => row.id), ["entry:src", "entry:src/b.js", "more:src", "entry:link", "error:link", "entry:a.md"]);
  assert.deepEqual([rows[1].level, rows[1].setSize, rows[2].remaining, rows[3].expandable], [2, 450, 449, true]);
  assert.deepEqual(visibleRows(folders, new Set()).map((row) => row.id), ["entry:src", "entry:link", "entry:a.md"]);
  assert.deepEqual(visibleRows({}, new Set()).map((row) => row.type), ["loading"]);
  assert.equal(treeKeyTarget(rows, 1, "ArrowLeft"), 0);
  assert.equal(treeKeyTarget(rows, 0, "ArrowRight"), 1);
  assert.equal(treeKeyTarget(rows, 5, "ArrowRight"), -1);
  assert.equal(treeKeyTarget(rows, 0, "End"), 5);
  assert.equal(treeKeyTarget(rows, 0, "a"), 5);
  assert.equal(treeKeyTarget(rows, 5, "ArrowDown"), 5);
  assert.deepEqual([normalizeTypedPath(" ./src//b.js/ "), normalizeTypedPath("/README.md"), ancestorsOf("a/b/c.md")], ["src/b.js", "README.md", ["a", "a/b"]]);
});
