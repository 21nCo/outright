import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { FILE_BROWSER_LIMITS, createFileBrowser } from "./file-browser.mjs";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a70000000049454e44ae426082", "hex");
const posixOnly = { skip: process.platform === "win32" && "symlinks and FIFOs need POSIX semantics" };

function fixture(t) {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "outright-files-")));
  const root = path.join(base, "worktree");
  mkdirSync(root);
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const write = (relative, content) => {
    const target = path.join(root, ...relative.split("/"));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
    return target;
  };
  return { base, root, write };
}

async function refusal(promise) {
  try { await promise; } catch (error) { return { status: error.statusCode, code: error.details?.code, message: error.message }; }
  assert.fail("the request was not refused");
}

function capture(headers = { "sec-fetch-site": "same-origin" }) {
  const chunks = [];
  const response = new Writable({ write(chunk, _encoding, done) { chunks.push(chunk); done(); } });
  response.headers = {};
  response.setHeader = (name, value) => { response.headers[name.toLowerCase()] = value; };
  return { request: { headers }, response, body: () => Buffer.concat(chunks) };
}

test("a folder lists only its own entries, folders first, hiding dotfiles and never Git metadata", async (t) => {
  const { root, write } = fixture(t);
  write("README.md", "# Hello\n");
  write("b.txt", "b");
  write("A.txt", "a");
  write("src/deep/inner.js", "x");
  write(".env", "SECRET=1");
  write(".config/settings.json", "{}");
  write(".git/config", "[core]");
  const files = createFileBrowser();
  const shown = await files.list(root);
  assert.deepEqual(shown.entries.map((entry) => [entry.name, entry.kind]), [["src", "directory"], ["A.txt", "file"], ["b.txt", "file"], ["README.md", "file"]]);
  // Lazy: a nested folder's entries are not part of its parent's listing.
  assert.equal(shown.entries.some((entry) => entry.path.startsWith("src/")), false);
  assert.deepEqual([shown.hiddenCount, shown.total, shown.nextCursor, shown.truncated], [2, 4, null, false]);
  const all = await files.list(root, { showHidden: true });
  assert.deepEqual(all.entries.map((entry) => entry.name), [".config", "src", ".env", "A.txt", "b.txt", "README.md"]);
  assert.deepEqual((await files.list(root, { directory: "src" })).entries.map((entry) => entry.path), ["src/deep"]);
  for (const target of [".git", ".git/config", ".GIT/config", "src/.git"]) {
    assert.equal((await refusal(files.preview(root, target))).code, "EXCLUDED", target);
  }
  // Any parent segment is refused, even one that would land back inside.
  assert.equal((await refusal(files.preview(root, "src/../README.md"))).code, "OUTSIDE_WORKTREE");
  assert.equal((await refusal(files.list(root, { directory: ".git" }))).code, "EXCLUDED");
});

test("a large folder pages without repeats or gaps while it changes, and stops scanning at its bound", async (t) => {
  const { root, write } = fixture(t);
  for (let index = 0; index < 450; index += 1) write(`many/file-${String(index).padStart(3, "0")}.txt`, "");
  const files = createFileBrowser();
  const first = await files.list(root, { directory: "many" });
  assert.equal(first.entries.length, FILE_BROWSER_LIMITS.pageSize);
  assert.equal(first.total, 450);
  // Entries added before the cursor and removed after it change only what is left to page.
  write("many/file-000a.txt", "");
  rmSync(path.join(root, "many", "file-449.txt"));
  const names = first.entries.map((entry) => entry.name);
  let cursor = first.nextCursor;
  while (cursor) {
    const page = await files.list(root, { directory: "many", cursor });
    names.push(...page.entries.map((entry) => entry.name));
    cursor = page.nextCursor;
  }
  const expected = Array.from({ length: 449 }, (_, index) => `file-${String(index).padStart(3, "0")}.txt`);
  assert.deepEqual(names, expected);
  assert.equal((await refusal(files.list(root, { directory: "many", cursor: "not-a-cursor" }))).code, "CURSOR_INVALID");
  assert.equal((await refusal(files.list(root, { directory: "many", limit: "0" }))).code, "PAGE_INVALID");
  const bounded = createFileBrowser({ limits: { ...FILE_BROWSER_LIMITS, maxScanEntries: 100 } });
  const capped = await bounded.list(root, { directory: "many" });
  assert.deepEqual([capped.truncated, capped.total, capped.entries.length], [true, 100, 100]);
});

test("paths that leave the worktree are refused, and links are listed with where they lead", posixOnly, async (t) => {
  const { base, root, write } = fixture(t);
  write("docs/guide.md", "# Guide\n");
  writeFileSync(path.join(base, "outside.txt"), "private");
  mkdirSync(path.join(base, "outside-dir"));
  symlinkSync("docs/guide.md", path.join(root, "guide-link.md"));
  symlinkSync("docs", path.join(root, "docs-link"));
  symlinkSync(path.join(base, "outside.txt"), path.join(root, "escape.txt"));
  symlinkSync(path.join(base, "outside-dir"), path.join(root, "escape-dir"));
  symlinkSync("gone.txt", path.join(root, "broken.txt"));
  symlinkSync("loop-b", path.join(root, "loop-a"));
  symlinkSync("loop-a", path.join(root, "loop-b"));
  const files = createFileBrowser();
  const listed = Object.fromEntries((await files.list(root)).entries.map((entry) => [entry.name, entry.target ?? entry.kind]));
  assert.deepEqual(listed["guide-link.md"], { state: "file", path: "docs/guide.md" });
  assert.deepEqual(listed["docs-link"], { state: "directory", path: "docs" });
  assert.deepEqual([listed["escape.txt"], listed["escape-dir"], listed["broken.txt"], listed["loop-a"]],
    [{ state: "outside" }, { state: "outside" }, { state: "missing" }, { state: "missing" }]);
  const followed = await files.preview(root, "guide-link.md");
  assert.deepEqual([followed.previewType, followed.text, followed.link], ["markdown", "# Guide\n", { target: "docs/guide.md" }]);
  assert.deepEqual((await files.list(root, { directory: "docs-link" })).entries.map((entry) => entry.path), ["docs-link/guide.md"]);
  for (const [request, code] of [[() => files.preview(root, "escape.txt"), "OUTSIDE_WORKTREE"], [() => files.list(root, { directory: "escape-dir" }), "OUTSIDE_WORKTREE"],
    [() => files.preview(root, "../outside.txt"), "OUTSIDE_WORKTREE"], [() => files.preview(root, path.join(base, "outside.txt")), "OUTSIDE_WORKTREE"],
    [() => files.preview(root, "broken.txt"), "MISSING"], [() => files.preview(root, "loop-a"), "LINK_LOOP"], [() => files.preview(root, "docs\0x"), "PATH_INVALID"],
    [() => files.preview(root, ""), "PATH_INVALID"], [() => files.preview(root, "docs"), "IS_DIRECTORY"], [() => files.list(root, { directory: "docs/guide.md" }), "NOT_DIRECTORY"],
    [() => files.preview(root, "docs/missing.md"), "MISSING"], [() => files.list(root, { directory: "gone" }), "MISSING"]]) {
    assert.equal((await refusal(request())).code, code, request.toString());
  }
});

test("previews return text only for UTF-8 text, verify image and PDF contents, and state their limits", async (t) => {
  const { root, write } = fixture(t);
  write("notes.md", "# Notes\n<script>alert(1)</script>\n");
  write("page.html", "<html><script>alert(1)</script></html>");
  write("logo.png", PNG);
  write("fake.png", "<script>alert(1)</script>");
  write("icon.svg", '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  write("doc.pdf", "%PDF-1.4\n%%EOF\n");
  write("fake.pdf", "not a pdf");
  write("app.bin", Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2]));
  write("latin1.txt", Buffer.from([0x63, 0x61, 0x66, 0xe9]));
  write("huge.log", "x".repeat(FILE_BROWSER_LIMITS.textBytes + 1));
  const files = createFileBrowser();
  const preview = async (name) => files.preview(root, name);
  const markdown = await preview("notes.md");
  assert.deepEqual([markdown.previewType, markdown.text], ["markdown", "# Notes\n<script>alert(1)</script>\n"]);
  // HTML is source text; nothing renders it.
  assert.equal((await preview("page.html")).previewType, "text");
  assert.deepEqual([(await preview("logo.png")).previewType, (await preview("logo.png")).mimeType, (await preview("logo.png")).text], ["image", "image/png", undefined]);
  assert.deepEqual([(await preview("fake.png")).previewType, (await preview("fake.png")).reason], ["unsupported", "The contents are not a PNG image"]);
  assert.equal((await preview("icon.svg")).previewType, "image");
  assert.equal((await preview("doc.pdf")).previewType, "pdf");
  assert.equal((await preview("fake.pdf")).previewType, "unsupported");
  assert.deepEqual([(await preview("app.bin")).previewType, (await preview("latin1.txt")).reason], ["unsupported", "The contents are not UTF-8 text"]);
  const huge = await preview("huge.log");
  assert.deepEqual([huge.previewType, huge.limit, huge.text, huge.size], ["oversized", FILE_BROWSER_LIMITS.textBytes, undefined, FILE_BROWSER_LIMITS.textBytes + 1]);
  const small = createFileBrowser({ limits: { ...FILE_BROWSER_LIMITS, imageBytes: 10 } });
  assert.deepEqual([(await small.preview(root, "logo.png")).previewType, (await small.preview(root, "logo.png")).limit], ["oversized", 10]);
});

test("a FIFO is described without being opened, so a preview never blocks on it", posixOnly, async (t) => {
  const { root } = fixture(t);
  execFileSync("mkfifo", [path.join(root, "pipe")]);
  const files = createFileBrowser();
  assert.equal((await files.list(root)).entries[0].kind, "other");
  const described = await Promise.race([files.preview(root, "pipe"), new Promise((resolve) => setTimeout(() => resolve("blocked"), 2000))]);
  assert.equal(described.previewType, "unsupported");
});

test("raw bytes are served only for verified images and PDFs, sandboxed, same-site, and for the previewed version", async (t) => {
  const { root, write } = fixture(t);
  write("logo.png", PNG);
  write("notes.md", "# Notes\n");
  write("icon.svg", '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const files = createFileBrowser();
  const { version } = await files.preview(root, "logo.png");
  const served = capture();
  await files.raw(root, "logo.png", version, served.request, served.response);
  assert.deepEqual(served.body(), PNG);
  assert.equal(served.response.headers["content-type"], "image/png");
  assert.equal(served.response.headers["x-content-type-options"], "nosniff");
  assert.match(served.response.headers["content-security-policy"], /default-src 'none'.*sandbox/);
  assert.equal(served.response.headers["cross-origin-resource-policy"], "same-origin");
  const svg = capture({});
  await files.raw(root, "icon.svg", null, svg.request, svg.response);
  assert.equal(svg.response.headers["content-type"], "image/svg+xml");
  assert.match(svg.response.headers["content-security-policy"], /sandbox/);
  const refused = async (file, fileVersion, headers) => {
    const { request, response } = capture(headers);
    return (await refusal(files.raw(root, file, fileVersion, request, response))).code;
  };
  assert.equal(await refused("notes.md", null), "NOT_RAW_PREVIEW");
  assert.equal(await refused("logo.png", version, { "sec-fetch-site": "cross-site" }), "CROSS_SITE");
  write("logo.png", Buffer.concat([PNG, Buffer.from([0])]));
  assert.equal(await refused("logo.png", version), "FILE_CHANGED");
});
