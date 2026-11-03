import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { closeSync, constants, existsSync, mkdirSync, openSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { FILE_BROWSER_LIMITS, createFileBrowser, noFollowAnyFlag } from "./file-browser.mjs";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a70000000049454e44ae426082", "hex");
const posixOnly = { skip: process.platform === "win32" && "symlinks and FIFOs need POSIX semantics" };
// Windows cannot prove where an opened descriptor is, so folders and files
// are refused there (see the fail-closed tests below; OUT-144).
const listable = { skip: process.platform === "win32" && "folders are not listed without a handle-bound path" };
const previewable = { skip: process.platform === "win32" && "files are not previewed without a descriptor-bound location" };

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

function capture(headers = { "sec-fetch-site": "same-origin" }, gate = Promise.resolve()) {
  const chunks = [];
  const response = new Writable({ write(chunk, _encoding, done) { chunks.push(chunk); void gate.then(() => done()); } });
  response.headers = {};
  response.setHeader = (name, value) => { response.headers[name.toLowerCase()] = value; };
  return { request: { headers }, response, body: () => Buffer.concat(chunks) };
}

test("a folder lists only its own entries, folders first, hiding dotfiles and never Git metadata", listable, async (t) => {
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
  assert.equal((await refusal(files.preview(root, "src/../README.md"))).code, "PATH_OUTSIDE");
  assert.equal((await refusal(files.list(root, { directory: ".git" }))).code, "EXCLUDED");
});

test("a large folder pages without repeats or gaps while it changes, and stops scanning at its bound", listable, async (t) => {
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
    // A typed path that leaves the root is not a link that leads out, and a
    // broken link is not a file that was deleted.
    [() => files.preview(root, "../outside.txt"), "PATH_OUTSIDE"], [() => files.preview(root, path.join(base, "outside.txt")), "PATH_OUTSIDE"],
    [() => files.preview(root, "broken.txt"), "BROKEN_LINK"], [() => files.preview(root, "loop-a"), "LINK_LOOP"], [() => files.preview(root, "docs\0x"), "PATH_INVALID"],
    [() => files.preview(root, ""), "PATH_INVALID"], [() => files.preview(root, "docs"), "IS_DIRECTORY"], [() => files.list(root, { directory: "docs/guide.md" }), "NOT_DIRECTORY"],
    [() => files.preview(root, "docs/missing.md"), "MISSING"], [() => files.list(root, { directory: "gone" }), "MISSING"]]) {
    assert.equal((await refusal(request())).code, code, request.toString());
  }
});

test("previews return text only for UTF-8 text, verify image and PDF contents, and state their limits", previewable, async (t) => {
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

test("raw bytes are served only for verified images and PDFs, sandboxed, same-site, and for the previewed version", previewable, async (t) => {
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

test("an in-place rewrite of the same size with its mtime put back is a new version, and raw refuses the old one", previewable, async (t) => {
  const { root, write } = fixture(t);
  const when = new Date("2026-01-02T03:04:05Z");
  const rewrite = (name, bytes) => {
    // The same inode and size; only the contents and ctime change.
    const descriptor = openSync(path.join(root, name), "r+");
    try { writeSync(descriptor, bytes, 0, bytes.length, 0); } finally { closeSync(descriptor); }
    utimesSync(path.join(root, name), when, when);
  };
  write("notes.md", "# Old\n");
  write("logo.png", PNG);
  for (const name of ["notes.md", "logo.png"]) utimesSync(path.join(root, name), when, when);
  const files = createFileBrowser();
  const [notes, logo] = [await files.preview(root, "notes.md"), await files.preview(root, "logo.png")];
  // Past a coarse timestamp tick, so the rewrite's ctime differs.
  await new Promise((resolve) => setTimeout(resolve, 20));
  rewrite("notes.md", Buffer.from("# New\n"));
  const changed = Buffer.from(PNG);
  changed[changed.length - 1] ^= 0xff;
  rewrite("logo.png", changed);
  const [notesAfter, logoAfter] = [await files.preview(root, "notes.md"), await files.preview(root, "logo.png")];
  assert.deepEqual([notesAfter.text, notesAfter.size, notesAfter.modifiedAt], ["# New\n", notes.size, notes.modifiedAt]);
  assert.notEqual(notesAfter.version, notes.version, "a same-size rewrite with the mtime put back kept its version");
  assert.deepEqual([logoAfter.size, logoAfter.modifiedAt], [logo.size, logo.modifiedAt]);
  assert.notEqual(logoAfter.version, logo.version, "an image rewritten in place kept its version");
  const stale = capture();
  assert.equal((await refusal(files.raw(root, "logo.png", logo.version, stale.request, stale.response))).code, "FILE_CHANGED");
  const fresh = capture();
  await files.raw(root, "logo.png", logoAfter.version, fresh.request, fresh.response);
  assert.deepEqual(fresh.body(), changed);
});

test("a folder replaced by a link after it was resolved is never read through, for listing, preview or raw", posixOnly, async (t) => {
  const { base, root, write } = fixture(t);
  write("docs/inner/guide.md", "# Inside\n");
  write("docs/inner/logo.png", PNG);
  // The outside tree has the same shape, so following the link would succeed.
  mkdirSync(path.join(base, "outside", "inner"), { recursive: true });
  writeFileSync(path.join(base, "outside", "inner", "guide.md"), "# Private\n");
  writeFileSync(path.join(base, "outside", "inner", "logo.png"), PNG);
  writeFileSync(path.join(base, "outside", "inner", "secret-name.txt"), "");
  let swaps = 0;
  const swapAncestor = () => {
    swaps += 1;
    renameSync(path.join(root, "docs"), path.join(root, "docs-moved"));
    symlinkSync(path.join(base, "outside"), path.join(root, "docs"));
  };
  const restore = () => {
    unlinkSync(path.join(root, "docs"));
    renameSync(path.join(root, "docs-moved"), path.join(root, "docs"));
  };
  const files = createFileBrowser({ hooks: { beforeOpen: swapAncestor } });
  const operations = {
    list: () => files.list(root, { directory: "docs/inner" }),
    preview: () => files.preview(root, "docs/inner/guide.md"),
    raw: () => { const { request, response } = capture(); return files.raw(root, "docs/inner/logo.png", null, request, response); },
  };
  for (const [name, operation] of Object.entries(operations)) {
    const refused = await refusal(operation());
    restore();
    assert.deepEqual([refused.status, refused.code], [409, "PATH_CHANGED"], name);
  }
  assert.equal(swaps, 3);
  // Without a replacement the same requests succeed.
  const plain = createFileBrowser();
  assert.deepEqual((await plain.list(root, { directory: "docs/inner" })).entries.map((entry) => entry.name), ["guide.md", "logo.png"]);
  assert.equal((await plain.preview(root, "docs/inner/guide.md")).text, "# Inside\n");
});

test("a folder swapped for a link after it was checked is read through its handle, and without a handle-bound path is never listed", posixOnly, async (t) => {
  const { base, root, write } = fixture(t);
  write("docs/inner/guide.md", "# Inside\n");
  mkdirSync(path.join(base, "outside", "inner"), { recursive: true });
  writeFileSync(path.join(base, "outside", "inner", "secret-name.txt"), "");
  let swapped = 0;
  // Replaces the checked folder's parent with a link to an outside tree of
  // the same shape just before the entries are read; the restore puts it back
  // before any later check by name.
  const swap = () => {
    swapped += 1;
    renameSync(path.join(root, "docs"), path.join(root, "docs-moved"));
    symlinkSync(path.join(base, "outside"), path.join(root, "docs"));
  };
  const restore = () => {
    if (!existsSync(path.join(root, "docs-moved"))) return;
    unlinkSync(path.join(root, "docs"));
    renameSync(path.join(root, "docs-moved"), path.join(root, "docs"));
  };
  const names = (listing) => listing.entries.map((entry) => entry.name);
  // Through /proc/self/fd (Linux) or /.vol (macOS) the opened folder is read.
  const bound = createFileBrowser({ hooks: { beforeRead: swap, afterRead: restore } });
  assert.deepEqual(names(await bound.list(root, { directory: "docs/inner" })), ["guide.md"]);
  assert.equal(swapped, 1);
  // Without one the folder could only be read by name, and a name checked
  // before and after reading passes while the swap is undone in between; so
  // the folder is not listed at all.
  const byName = createFileBrowser({ handlePaths: false, hooks: { beforeRead: swap, afterRead: restore } });
  const outcome = await byName.list(root, { directory: "docs/inner" }).then(names, (error) => [error.statusCode, error.details?.code, error.message]);
  restore();
  assert.deepEqual(outcome.slice(0, 2), [501, "LISTING_UNAVAILABLE"], `listed by name: ${outcome}`);
  assert.match(outcome[2], /Folder listing is unavailable on this file system/);
  assert.equal(swapped, 1);
  assert.equal((await refusal(byName.list(root))).code, "LISTING_UNAVAILABLE");
});

test("a file whose ancestor is swapped around each check by name is refused, and without a descriptor-bound location is never read", posixOnly, async (t) => {
  const { base, root, write } = fixture(t);
  write("docs/inner/guide.md", "# Inside\n");
  write("docs/inner/logo.png", PNG);
  const privatePng = Buffer.concat([PNG, Buffer.from("private")]);
  mkdirSync(path.join(base, "outside", "inner"), { recursive: true });
  writeFileSync(path.join(base, "outside", "inner", "guide.md"), "# Private\n");
  writeFileSync(path.join(base, "outside", "inner", "logo.png"), privatePng);
  const docs = path.join(root, "docs");
  const moved = path.join(root, "docs-moved");
  const swap = () => { if (existsSync(moved)) return; renameSync(docs, moved); symlinkSync(path.join(base, "outside"), docs); };
  const restore = () => { if (!existsSync(moved)) return; unlinkSync(docs); renameSync(moved, docs); };
  // The ancestor is a link to the outside tree when the file is inspected
  // and opened, and is put back for any later look by name.
  const hooks = { beforeInspect: swap, afterOpen: restore };
  const run = async (files) => {
    const outcomes = {};
    const { request, response, body } = capture();
    for (const [name, operation] of [["preview", () => files.preview(root, "docs/inner/guide.md")], ["raw", () => files.raw(root, "docs/inner/logo.png", null, request, response)]]) {
      outcomes[name] = await operation().then((value) => ({ served: name === "raw" ? body().toString("latin1") : value.text }), (error) => ({ status: error.statusCode, code: error.details?.code }));
      restore();
    }
    return outcomes;
  };
  // Where the opened descriptor's location is proven, the outside file is refused.
  const bound = await run(createFileBrowser({ hooks }));
  for (const name of ["preview", "raw"]) assert.deepEqual(bound[name], { status: 409, code: "PATH_CHANGED" }, `${name}: ${JSON.stringify(bound[name])}`);
  // Where it cannot be proven, nothing is read at all.
  const unbound = await run(createFileBrowser({ handlePaths: false, hooks }));
  for (const name of ["preview", "raw"]) assert.deepEqual(unbound[name], { status: 501, code: "PREVIEW_UNAVAILABLE" }, `${name}: ${JSON.stringify(unbound[name])}`);
  const plain = createFileBrowser({ handlePaths: false });
  assert.equal((await refusal(plain.preview(root, "docs/inner/guide.md"))).code, "PREVIEW_UNAVAILABLE");
  // With nothing swapped, a proven location previews normally.
  assert.equal((await createFileBrowser().preview(root, "docs/inner/guide.md")).text, "# Inside\n");
});

test("O_NOFOLLOW_ANY is trusted only on macOS kernels that enforce it", (t) => {
  // macOS 10.15 is Darwin 19, whose kernel ignores the flag; macOS 11 is Darwin 20.
  assert.equal(noFollowAnyFlag("darwin", "19.6.0"), 0);
  assert.equal(noFollowAnyFlag("darwin", "20.1.0"), 0x20000000);
  assert.equal(noFollowAnyFlag("darwin", "25.0.0"), 0x20000000);
  assert.equal(noFollowAnyFlag("darwin", "unknown"), 0);
  assert.equal(noFollowAnyFlag("linux", "6.8.0"), 0);
  assert.equal(noFollowAnyFlag("win32", "10.0.22631"), 0);
  // Where it is trusted, this kernel refuses a link in an ancestor.
  const flag = noFollowAnyFlag();
  if (!flag) return;
  const { base, root, write } = fixture(t);
  write("docs/guide.md", "# Inside\n");
  symlinkSync(path.join(root, "docs"), path.join(base, "via"));
  assert.throws(() => closeSync(openSync(path.join(base, "via", "guide.md"), constants.O_RDONLY | flag)), { code: "ELOOP" });
  closeSync(openSync(path.join(root, "docs", "guide.md"), constants.O_RDONLY | flag));
});

test("names that decode alike are distinct entries: paging never drops or repeats one", listable, async (t) => {
  const { root } = fixture(t);
  const folder = path.join(root, "odd");
  mkdirSync(folder);
  // 61 ff and 61 fe are not UTF-8 and both decode to "a\uFFFD", as does the
  // valid name "a\uFFFD" itself.
  try {
    for (const bytes of [[0x61, 0xff], [0x61, 0xfe]]) writeFileSync(Buffer.concat([Buffer.from(`${folder}${path.sep}`), Buffer.from(bytes)]), "x");
  } catch (error) {
    t.skip(`this file system rejects names that are not UTF-8 (${error.code})`);
    return;
  }
  writeFileSync(path.join(folder, "a\uFFFD"), "valid");
  writeFileSync(path.join(folder, "b.txt"), "b");
  const files = createFileBrowser();
  const describe = (entry) => [entry.name, entry.path, entry.nameKey ?? null];
  const whole = (await files.list(root, { directory: "odd" })).entries.map(describe);
  const paged = [];
  let cursor = null;
  do {
    const page = await files.list(root, { directory: "odd", limit: 1, cursor });
    paged.push(...page.entries.map(describe));
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(paged.length, whole.length, "paging one entry at a time dropped or repeated an entry");
  assert.deepEqual(whole, [
    ["a\uFFFD", "odd/a\uFFFD", null],
    ["a\uFFFD", null, Buffer.from([0x61, 0xfe]).toString("base64url")],
    ["a\uFFFD", null, Buffer.from([0x61, 0xff]).toString("base64url")],
    ["b.txt", "odd/b.txt", null],
  ]);
  assert.deepEqual(paged, whole);
});

test("names that merely begin with two dots are inside the worktree", listable, async (t) => {
  const { root, write } = fixture(t);
  write("..notes.md", "# Dots\n");
  write("..cache/entry.txt", "cached");
  const files = createFileBrowser();
  assert.deepEqual((await files.list(root, { showHidden: true })).entries.map((entry) => entry.path), ["..cache", "..notes.md"]);
  assert.equal((await files.preview(root, "..notes.md")).text, "# Dots\n");
  assert.deepEqual((await files.list(root, { directory: "..cache" })).entries.map((entry) => entry.path), ["..cache/entry.txt"]);
});

test("raw requests beyond the stream limit wait their turn, and only a full queue is refused", previewable, async (t) => {
  const { root, write } = fixture(t);
  write("logo.png", PNG);
  const files = createFileBrowser({ limits: { ...FILE_BROWSER_LIMITS, maxRawStreams: 2, maxRawQueue: 3 } });
  // Responses that accept no bytes until released hold their stream slot.
  const gates = [];
  const held = () => {
    const release = new Promise((resolve) => gates.push(resolve));
    return capture(undefined, release);
  };
  const requests = Array.from({ length: 5 }, () => held());
  const settled = Promise.allSettled(requests.map(({ request, response }) => files.raw(root, "logo.png", null, request, response)));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(files.rawStats(), { active: 2, waiting: 3 });
  const extra = capture();
  assert.equal((await refusal(files.raw(root, "logo.png", null, extra.request, extra.response))).code, "PREVIEW_BUSY");
  // A queued request whose client leaves gives up its place.
  requests[4].response.destroy();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(files.rawStats(), { active: 2, waiting: 2 });
  while (gates.length) gates.shift()();
  for (let round = 0; round < 10 && files.rawStats().active; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    while (gates.length) gates.shift()();
  }
  const results = await settled;
  assert.deepEqual(results.map((result) => result.status), ["fulfilled", "fulfilled", "fulfilled", "fulfilled", "rejected"]);
  assert.deepEqual(requests.slice(0, 4).map(({ body }) => body().equals(PNG)), [true, true, true, true]);
  assert.deepEqual(files.rawStats(), { active: 0, waiting: 0 });
});

test("a raw request whose client left before its turn takes no slot and no place in the queue", previewable, async (t) => {
  const { root, write } = fixture(t);
  write("logo.png", PNG);
  const files = createFileBrowser({ limits: { ...FILE_BROWSER_LIMITS, maxRawStreams: 1, maxRawQueue: 1 } });
  let release;
  const holder = capture(undefined, new Promise((resolve) => { release = resolve; }));
  const held = files.raw(root, "logo.png", null, holder.request, holder.response);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(files.rawStats(), { active: 1, waiting: 0 });
  // Gone while it was being authorized: refused before it can queue.
  const gone = capture();
  gone.response.destroy();
  assert.equal((await refusal(files.raw(root, "logo.png", null, gone.request, gone.response))).code, "CLIENT_CLOSED");
  assert.deepEqual(files.rawStats(), { active: 1, waiting: 0 });
  // So a live request still gets the one queue place.
  const live = capture();
  const queued = files.raw(root, "logo.png", null, live.request, live.response);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(files.rawStats(), { active: 1, waiting: 1 });
  release();
  await Promise.all([held, queued]);
  assert.equal(live.body().equals(PNG), true);
  // A free slot is not taken by a closed response either.
  const late = capture();
  late.response.destroy();
  assert.equal((await refusal(files.raw(root, "logo.png", null, late.request, late.response))).code, "CLIENT_CLOSED");
  assert.deepEqual(files.rawStats(), { active: 0, waiting: 0 });
});
