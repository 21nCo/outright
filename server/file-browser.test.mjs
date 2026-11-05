import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, constants, existsSync, mkdirSync, openSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, unlinkSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { open, statfs } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { FILE_BROWSER_LIMITS, createFileBrowser, nanosecondVolume, noFollowAnyFlag, relativePath } from "./file-browser.mjs";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a70000000049454e44ae426082", "hex");
// ISO BMFF boxes, and an AVIF whose items declare these sizes (ispe).
function box(type, ...parts) {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, body]);
}
function u32(...values) { const bytes = Buffer.alloc(4 * values.length); values.forEach((value, index) => bytes.writeUInt32BE(value, 4 * index)); return bytes; }
function avif(ftyp, ...sizes) { return Buffer.concat([ftyp, box("meta", u32(0), box("iprp", box("ipco", ...sizes.map(([width, height]) => box("ispe", u32(0, width, height))))))]); }
function png(width, height, tail = Buffer.alloc(0)) { const bytes = Buffer.from(PNG); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20); return Buffer.concat([bytes, tail]); }

// Whether this host reads through a handle on the worktree root (Linux
// /proc, macOS 11+ /.vol): probed, not inferred from the platform name. A
// host that cannot refuses every folder and file instead (OUT-144), which
// the fail-closed test below checks, so success tests run only where it can.
const anchored = await (async () => {
  const probe = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "outright-anchor-")));
  try { return await createFileBrowser().list(probe).then(() => true, (error) => error.details?.code !== "LISTING_UNAVAILABLE"); }
  finally { rmSync(probe, { recursive: true, force: true }); }
})();
const unanchored = "this host cannot read through a root handle (OUT-144)";
const listable = { skip: !anchored && unanchored };
const previewable = listable;
const linkable = { skip: (process.platform === "win32" && "symlinks and FIFOs need POSIX semantics") || (!anchored && unanchored) };

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
  assert.deepEqual([first.total, first.remaining], [450, 250]);
  // After 199 listed entries are deleted, the next page still counts what
  // follows it exactly; the folder's total alone would say -149.
  for (let index = 1; index < 200; index += 1) rmSync(path.join(root, "many", `file-${String(index).padStart(3, "0")}.txt`));
  const after = await files.list(root, { directory: "many", cursor: first.nextCursor });
  assert.deepEqual([after.total, after.entries.length, after.remaining, first.entries.length + after.entries.length - after.total], [251, 200, 50, 149]);
  for (let index = 1; index < 200; index += 1) write(`many/file-${String(index).padStart(3, "0")}.txt`, "");
  // Entries added before the cursor and removed after it change only what is left to page.
  write("many/file-000a.txt", "");
  rmSync(path.join(root, "many", "file-449.txt"));
  const names = first.entries.map((entry) => entry.name);
  let cursor = first.nextCursor;
  while (cursor) {
    const page = await files.list(root, { directory: "many", cursor });
    names.push(...page.entries.map((entry) => entry.name));
    if (!page.nextCursor) assert.equal(page.remaining, 0);
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

test("paths that leave the worktree are refused, and links are listed with where they lead", linkable, async (t) => {
  const { base, root, write } = fixture(t);
  write("docs/guide.md", "# Guide\n");
  writeFileSync(path.join(base, "outside.txt"), "private");
  mkdirSync(path.join(base, "outside-dir"));
  symlinkSync("docs/guide.md", path.join(root, "guide-link.md"));
  symlinkSync("docs", path.join(root, "docs-link"));
  // Links to "." and ".." lead to the folder they are in and the one above it.
  symlinkSync(".", path.join(root, "docs", "here"));
  symlinkSync("..", path.join(root, "docs", "up"));
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
  assert.deepEqual((await files.list(root, { directory: "docs-link" })).entries.map((entry) => entry.path), ["docs-link/guide.md", "docs-link/here", "docs-link/up"]);
  const inDocs = Object.fromEntries((await files.list(root, { directory: "docs" })).entries.map((entry) => [entry.name, entry.target]));
  assert.deepEqual([inDocs.here, inDocs.up], [{ state: "directory", path: "docs" }, { state: "directory", path: "" }]);
  assert.equal((await files.preview(root, "docs/here/guide.md")).text, "# Guide\n");
  assert.equal((await files.preview(root, "docs/up/docs/guide.md")).text, "# Guide\n");
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
  // An SVG's first element may follow a prolog longer than the usual sample,
  // and an AVIF may name avif only among its compatible brands.
  for (const [name, content, type] of [
    ["long-prolog.svg", `<?xml version="1.0"?>\n<!-- ${"x".repeat(20_000)} -->\n<!DOCTYPE svg [ <!-- it's > here --> <!ENTITY a "]>"> ]>\n<svg:svg xmlns:svg="http://www.w3.org/2000/svg"/>`, "image"],
    ["bom.svg", "\uFEFF<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>", "image"],
    ["page.svg", "<!DOCTYPE html><html><body><svg></svg></body></html>", "unsupported"],
    ["unclosed.svg", `<!-- ${"x".repeat(20_000)}`, "unsupported"],
    ["mif1.avif", avif(Buffer.concat([Buffer.from([0, 0, 0, 28]), Buffer.from("ftypmif1\0\0\0\0mif1miafavif")]), [64, 48]), "image"],
    ["heic.avif", Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic\0\0\0\0mif1heic"), Buffer.alloc(16)]), "unsupported"],
    // A brand past the end of the ftyp box is not one of its brands.
    ["short-box.avif", Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from("ftypmif1\0\0\0\0mif1avif"), Buffer.alloc(16)]), "unsupported"],
  ]) {
    write(name, content);
    assert.equal((await preview(name)).previewType, type, name);
  }
  assert.equal((await preview("doc.pdf")).previewType, "pdf");
  assert.equal((await preview("fake.pdf")).previewType, "unsupported");
  assert.deepEqual([(await preview("app.bin")).previewType, (await preview("latin1.txt")).reason], ["unsupported", "The contents are not UTF-8 text"]);
  const huge = await preview("huge.log");
  assert.deepEqual([huge.previewType, huge.limit, huge.text, huge.size], ["oversized", FILE_BROWSER_LIMITS.textBytes, undefined, FILE_BROWSER_LIMITS.textBytes + 1]);
  const small = createFileBrowser({ limits: { ...FILE_BROWSER_LIMITS, imageBytes: 10 } });
  assert.deepEqual([(await small.preview(root, "logo.png")).previewType, (await small.preview(root, "logo.png")).limit], ["oversized", 10]);
});

test("a FIFO is described without being opened, so a preview never blocks on it", linkable, async (t) => {
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

test("an image's decoded size is read from its header and bounded in every raster format, for preview and raw", previewable, async (t) => {
  const { root, write } = fixture(t);
  const gif = ([screenWidth, screenHeight], [frameWidth, frameHeight]) => {
    const head = Buffer.alloc(13);
    head.write("GIF89a", 0, "latin1");
    head.writeUInt16LE(screenWidth, 6);
    head.writeUInt16LE(screenHeight, 8);
    const frame = Buffer.alloc(10);
    frame[0] = 0x2c;
    frame.writeUInt16LE(frameWidth, 5);
    frame.writeUInt16LE(frameHeight, 7);
    // A comment extension comes before the first frame.
    return Buffer.concat([head, Buffer.from([0x21, 0xfe, 3, 0x61, 0x62, 0x63, 0]), frame, Buffer.from([2, 0, 0x3b])]);
  };
  const bmp = (width, height) => { const bytes = Buffer.alloc(54); bytes.write("BM", 0, "latin1"); bytes.writeUInt32LE(40, 14); bytes.writeInt32LE(width, 18); bytes.writeInt32LE(height, 22); return bytes; };
  const webp = (width, height) => {
    const bytes = Buffer.alloc(30);
    bytes.write("RIFF", 0, "latin1"); bytes.writeUInt32LE(22, 4); bytes.write("WEBPVP8X", 8, "latin1"); bytes.writeUInt32LE(10, 16);
    bytes.writeUIntLE(width - 1, 24, 3); bytes.writeUIntLE(height - 1, 27, 3);
    return bytes;
  };
  // Two 64 KB APP1 segments put the frame header past the usual sample.
  const jpeg = (width, height) => {
    const app = Buffer.alloc(65_537, 0); app[0] = 0xff; app[1] = 0xe1; app.writeUInt16BE(65_535, 2);
    const frame = Buffer.from([0xff, 0xc0, 0, 17, 8, 0, 0, 0, 0, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]);
    frame.writeUInt16BE(height, 5); frame.writeUInt16BE(width, 7);
    return Buffer.concat([Buffer.from([0xff, 0xd8]), app, app, frame, Buffer.from([0xff, 0xd9])]);
  };
  const ico = (image) => { const head = Buffer.alloc(22); head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4); head.writeUInt32LE(image.length, 14); head.writeUInt32LE(22, 18); return Buffer.concat([head, image]); };
  const ftyp = Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from("ftypavif\0\0\0\0avif")]);
  const cases = [
    ["big.png", png(10_000, 10_000), [10_000, 10_000]],
    ["ok.png", png(4000, 3000), null],
    ["wide-frame.gif", gif([1, 1], [60_000, 60_000]), [60_000, 60_000]],
    ["ok.gif", gif([100, 80], [10, 10]), null],
    ["big.bmp", bmp(10_000, -10_000), [10_000, 10_000]],
    ["big.webp", webp(16_384, 16_384), [16_384, 16_384]],
    ["big.jpg", jpeg(20_000, 20_000), [20_000, 20_000]],
    ["ok.jpeg", jpeg(640, 480), null],
    ["big.ico", ico(png(9000, 9000)), [9000, 9000]],
    ["grid.avif", avif(ftyp, [512, 512], [8000, 8000]), [8000, 8000]],
  ];
  for (const [name, bytes] of cases) write(name, bytes);
  write("no-size.png", PNG.subarray(0, 20));
  const files = createFileBrowser();
  for (const [name, bytes, oversized] of cases) {
    const preview = await files.preview(root, name);
    const { request, response, body } = capture();
    if (!oversized) {
      assert.equal(preview.previewType, "image", name);
      await files.raw(root, name, preview.version, request, response);
      assert.deepEqual(body(), bytes, name);
      continue;
    }
    assert.deepEqual([preview.previewType, preview.width, preview.height, preview.pixelLimit], ["oversized", ...oversized, FILE_BROWSER_LIMITS.imagePixels], name);
    assert.match(preview.reason, /pixels/, name);
    // A Markdown image asks for raw bytes directly; none are sent.
    assert.deepEqual(await refusal(files.raw(root, name, null, request, response)).then((error) => [error.status, error.code]), [413, "OVERSIZED"], name);
    assert.equal(body().length, 0, name);
  }
  assert.deepEqual([(await files.preview(root, "ok.png")).width, (await files.preview(root, "ok.gif")).height], [4000, 80]);
  const unsized = await files.preview(root, "no-size.png");
  assert.deepEqual([unsized.previewType, unsized.reason], ["unsupported", "This PNG image's size cannot be read"]);
});

test("a raw body is the version that was checked: a write or a truncation while it streams never completes the response", previewable, async (t) => {
  const { root, write } = fixture(t);
  const original = png(64, 64, Buffer.alloc(300 * 1024, 1));
  write("big.png", original);
  const target = path.join(root, "big.png");
  const stream = async (change) => {
    let changed = false;
    const files = createFileBrowser({ hooks: { duringRaw: (offset) => { if (change && !changed && offset < original.length) { changed = true; change(); } } } });
    const { request, response, body } = capture();
    await files.raw(root, "big.png", null, request, response);
    return { changed, complete: response.writableFinished, destroyed: response.destroyed, body: body(), code: files.operations()[0].code ?? null };
  };
  const whole = await stream(null);
  assert.deepEqual([whole.complete, whole.body.equals(original), whole.code], [true, true, null]);
  // In place and the same size: the bytes still to come are the new version's.
  const rewritten = await stream(() => { const descriptor = openSync(target, "r+"); try { writeSync(descriptor, Buffer.alloc(1024, 2), 0, 1024, original.length - 1024); } finally { closeSync(descriptor); } });
  assert.deepEqual([rewritten.changed, rewritten.complete, rewritten.destroyed, rewritten.code], [true, false, true, "FILE_CHANGED"]);
  assert.ok(rewritten.body.length < original.length, "the whole rewritten body was sent");
  write("big.png", original);
  const truncated = await stream(() => truncateSync(target, 100 * 1024));
  assert.deepEqual([truncated.changed, truncated.complete, truncated.destroyed, truncated.code], [true, false, true, "FILE_CHANGED"]);
  assert.ok(truncated.body.length <= 100 * 1024);
});

test("a failed volume probe fails only the requests that waited for it, and later requests probe again", listable, async (t) => {
  const { root, write } = fixture(t);
  write("a.md", "# A\n");
  write("logo.png", PNG);
  let failing = true;
  const probed = [];
  const files = createFileBrowser({ hooks: { statfs: async (at) => {
    probed.push(at);
    if (!failing) return statfs(at);
    // Slow enough that the concurrent requests share one failing probe of "/".
    await new Promise((resolve) => setTimeout(resolve, 30));
    throw Object.assign(new Error("transient"), { code: "EIO" });
  } } });
  const { request, response } = capture();
  const refused = await Promise.all([refusal(files.list(root)), refusal(files.preview(root, "a.md")), refusal(files.raw(root, "logo.png", null, request, response))]);
  assert.deepEqual(refused.map((error) => [error.status, error.code]), [[501, "LISTING_UNAVAILABLE"], [501, "PREVIEW_UNAVAILABLE"], [501, "PREVIEW_UNAVAILABLE"]]);
  const failedProbes = probed.length;
  failing = false;
  assert.deepEqual((await files.list(root)).entries.map((entry) => entry.name), ["a.md", "logo.png"]);
  assert.equal((await files.preview(root, "a.md")).text, "# A\n");
  const served = capture();
  await files.raw(root, "logo.png", null, served.request, served.response);
  assert.deepEqual(served.body(), PNG);
  // macOS compares with "/", which is probed again once its probe failed.
  if (process.platform === "darwin") assert.ok(probed.slice(failedProbes).includes("/"), "the failed probe of / was kept");
});

test("a proof is trusted only on a volume that keeps nanosecond ctimes from this machine's clock", () => {
  const fine = 1_793_817_092_123_456_789n;
  const whole = 1_793_817_092_000_000_000n;
  // ext4, XFS, Btrfs (also as a signed 32-bit type), tmpfs and overlay.
  for (const type of [0xef53, 0x58465342, 0x9123683e, 0x9123683e | 0, 0x01021994, 0x794c7630]) assert.equal(nanosecondVolume(type, fine, null, "linux"), true, type.toString(16));
  // ext2, ext3 and small-inode ext4 keep whole seconds; NFS, SMB and FUSE use another clock.
  assert.equal(nanosecondVolume(0xef53, whole, null, "linux"), false);
  for (const type of [0x6969, 0xff534d42, 0x65735546, null]) assert.equal(nanosecondVolume(type, fine, null, "linux"), false, String(type));
  // macOS: the type of "/" (APFS), once it is known.
  assert.deepEqual([nanosecondVolume(26, fine, 26, "darwin"), nanosecondVolume(17, fine, 26, "darwin"), nanosecondVolume(26, fine, null, "darwin"), nanosecondVolume(26, whole, 26, "darwin")], [true, false, false, false]);
  assert.equal(nanosecondVolume(0xef53, fine, null, "win32"), false);
});

test("on macOS a worktree on an HFS+ volume, or one mounted inside a worktree, is never read", { skip: (process.platform !== "darwin" && "hdiutil is macOS's") || linkable.skip }, async (t) => {
  const { base, root, write } = fixture(t);
  write("a.md", "# A\n");
  const image = path.join(base, "hfs.dmg");
  const mounted = path.join(root, "mnt");
  mkdirSync(mounted);
  try {
    execFileSync("hdiutil", ["create", "-quiet", "-size", "4m", "-fs", "HFS+", "-volname", "outright-hfs", image]);
    execFileSync("hdiutil", ["attach", "-quiet", "-nobrowse", "-mountpoint", mounted, image]);
  } catch (error) { t.skip(`no HFS+ image could be mounted: ${error.message}`); return; }
  try {
    mkdirSync(path.join(mounted, "inner"));
    writeFileSync(path.join(mounted, "b.md"), "# B\n");
    writeFileSync(path.join(mounted, "inner", "c.md"), "# C\n");
    const files = createFileBrowser();
    assert.deepEqual((await files.list(root)).entries.map((entry) => [entry.name, entry.kind]), [["mnt", "directory"], ["a.md", "file"]]);
    assert.equal((await refusal(files.list(root, { directory: "mnt" }))).code, "LISTING_UNAVAILABLE");
    assert.equal((await refusal(files.preview(root, "mnt/b.md"))).code, "PREVIEW_UNAVAILABLE");
    assert.equal((await refusal(files.list(path.join(mounted, "inner")))).code, "LISTING_UNAVAILABLE");
    assert.equal((await refusal(files.preview(path.join(mounted, "inner"), "c.md"))).code, "PREVIEW_UNAVAILABLE");
    assert.equal((await files.preview(root, "a.md")).text, "# A\n");
  } finally { execFileSync("hdiutil", ["detach", "-quiet", "-force", mounted]); }
});

test("a folder on a proof's chain, or a file, changed within the settle margin is waited out, so a write in the same clock tick is still seen", previewable, async (t) => {
  const { root, write } = fixture(t);
  write("d/logo.png", PNG);
  const age = (target) => BigInt(Date.now()) * 1_000_000n - statSync(target, { bigint: true }).ctimeNs;
  const ages = { chain: [], file: [] };
  const files = createFileBrowser({ hooks: {
    duringProof: (step) => { if (step === "chain") ages.chain.push(age(root), age(path.join(root, "d"))); },
    duringRaw: () => { ages.file.push(age(path.join(root, "d", "logo.png"))); },
  } });
  // Both were written just now.
  writeFileSync(path.join(root, "fresh.md"), "");
  writeFileSync(path.join(root, "d", "logo.png"), PNG);
  await files.list(root, { directory: "d" });
  const { request, response, body } = capture();
  await files.raw(root, "d/logo.png", null, request, response);
  assert.deepEqual(body(), PNG);
  assert.ok(ages.chain.length >= 2 && ages.file.length === 1, "the checks ran");
  for (const value of [...ages.chain, ...ages.file]) assert.ok(value >= 25_000_000n, `a ctime ${value} ns old was trusted`);
});

test("each request leaves one bounded operation record, named by its id, without contents, for success, failure and cancellation", previewable, async (t) => {
  const { root, write } = fixture(t);
  write("secret.md", "SECRET-CONTENT\n");
  write("logo.png", png(64, 64, Buffer.alloc(300 * 1024)));
  const seen = [];
  const files = createFileBrowser({ limits: { ...FILE_BROWSER_LIMITS, operationRecords: 3 }, hooks: { onOperation: (record) => seen.push(record) } });
  await files.list(root, { operationId: "op-list" });
  await files.preview(root, "secret.md", { operationId: "op-preview" });
  await refusal(files.preview(root, "gone.md", { operationId: "op-missing" }));
  // A client that stops reading, then goes away, mid-stream.
  const { request, response } = capture(undefined, new Promise(() => {}));
  const streaming = files.raw(root, "logo.png", null, request, response, { operationId: "op-raw" });
  while (!response.headers["content-type"]) await new Promise((resolve) => setTimeout(resolve, 5));
  response.destroy();
  await streaming;
  assert.deepEqual(seen.map((record) => [record.operationId, record.operation, record.path, record.outcome, record.status ?? null, record.code ?? null]), [
    ["op-list", "list", "", "ok", null, null],
    ["op-preview", "preview", "secret.md", "ok", null, null],
    ["op-missing", "preview", "gone.md", "failed", 404, "MISSING"],
    ["op-raw", "raw", "logo.png", "cancelled", null, "CLIENT_CLOSED"],
  ]);
  for (const record of seen) assert.ok(record.root === root && Number.isInteger(record.elapsedMs) && record.elapsedMs >= 0, JSON.stringify(record));
  assert.ok(!JSON.stringify(seen).includes("SECRET"), "a record holds contents");
  assert.deepEqual(files.operations().map((record) => record.operationId), ["op-preview", "op-missing", "op-raw"]);
  await files.list(root);
  assert.match(files.operations().at(-1).operationId, /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/);
});

test("a raw body whose file fails to read mid-stream is recorded as a failed stream, not a client that left", previewable, async (t) => {
  const { root, write } = fixture(t);
  write("logo.png", png(64, 64, Buffer.alloc(300 * 1024)));
  const probe = await open(path.join(root, "logo.png"), "r");
  const FileHandle = probe.constructor;
  await probe.close();
  const { read: original } = FileHandle.prototype;
  let failing = false;
  t.after(() => { FileHandle.prototype.read = original; });
  FileHandle.prototype.read = function read(...args) {
    return failing ? Promise.reject(Object.assign(new Error("injected"), { code: "EIO" })) : original.apply(this, args);
  };
  // The read after the first chunk fails.
  const files = createFileBrowser({ hooks: { duringRaw: () => { failing = true; } } });
  const { request, response } = capture();
  await files.raw(root, "logo.png", null, request, response, { operationId: "op-eio" });
  failing = false;
  assert.equal(response.writableFinished, false, "a body cut short completed");
  const record = files.operations().at(-1);
  assert.deepEqual([record.operationId, record.outcome, record.code], ["op-eio", "failed", "STREAM_FAILED"]);
});

test("a raw stream's record names who ended it: a write error is a failed stream, a peer that hung up is a cancellation", previewable, async (t) => {
  const { root, write } = fixture(t);
  write("logo.png", png(64, 64, Buffer.alloc(300 * 1024)));
  const files = createFileBrowser();
  // The response fails to write its second chunk.
  let writes = 0;
  const failing = new Writable({ write(_chunk, _encoding, done) { done(++writes > 1 ? Object.assign(new Error("injected"), { code: "EIO" }) : null); } });
  failing.setHeader = () => {};
  await files.raw(root, "logo.png", null, { headers: {} }, failing, { operationId: "op-write-eio" });
  // A real HTTP client that reads the first bytes, then closes its socket.
  const server = http.createServer((request, response) => { void files.raw(root, "logo.png", null, request, response, { operationId: "op-peer" }); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const client = http.get({ host: "127.0.0.1", port: server.address().port, agent: false }, (response) => response.once("data", () => client.destroy()));
  client.on("error", () => {});
  while (!files.operations().some((record) => record.operationId === "op-peer")) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(files.operations().map((record) => [record.operationId, record.outcome, record.code]), [["op-write-eio", "failed", "STREAM_FAILED"], ["op-peer", "cancelled", "CLIENT_CLOSED"]]);
});

test("a root whose ancestor is moved and replaced by a link to its new place is PATH_CHANGED, for listing, preview and raw", linkable, async (t) => {
  const { base, root, write } = fixture(t);
  write("a.md", "# A\n");
  write("logo.png", PNG);
  // The fixture's root is base/worktree; its ancestor here is base itself, moved under a sibling.
  const top = path.join(path.dirname(base), `${path.basename(base)}-top`);
  mkdirSync(top);
  t.after(() => rmSync(top, { recursive: true, force: true }));
  const away = path.join(top, "moved");
  let moves = 0;
  const relocate = () => { if (existsSync(away)) return; renameSync(base, away); symlinkSync(away, base); moves += 1; };
  const restore = () => { if (!existsSync(away)) return; unlinkSync(base); renameSync(away, base); };
  const operations = {
    "list": () => createFileBrowser({ hooks: { beforeRead: relocate } }).list(root),
    preview: () => createFileBrowser({ hooks: { beforeInspect: relocate } }).preview(root, "a.md"),
    raw: async () => { const { request, response, body } = capture(); await createFileBrowser({ hooks: { beforeInspect: relocate } }).raw(root, "logo.png", null, request, response); return body().length; },
  };
  for (const [name, operation] of Object.entries(operations)) {
    const outcome = await operation().then((value) => ({ served: value }), (error) => error.details?.code);
    restore();
    assert.equal(outcome, "PATH_CHANGED", `${name}: ${JSON.stringify(outcome)}`);
  }
  assert.equal(moves, 3);
  assert.equal((await createFileBrowser().preview(root, "a.md")).text, "# A\n");
});

test("a file bind-mounted into the worktree from a volume without nanosecond ctimes is never previewed or served", { skip: ((process.platform !== "linux" || process.getuid?.() !== 0) && "a file bind mount needs Linux and root") || linkable.skip }, async (t) => {
  const { base, root, write } = fixture(t);
  write("a.md", "# A\n");
  write("logo.png", PNG);
  const other = path.join(base, "other");
  mkdirSync(other);
  try { execFileSync("mount", ["-t", "tmpfs", "tmpfs", other], { stdio: "ignore" }); } catch { t.skip("mounting is not permitted"); return; }
  try {
    writeFileSync(path.join(other, "a.md"), "# Mounted\n");
    writeFileSync(path.join(other, "logo.png"), PNG);
    for (const name of ["a.md", "logo.png"]) execFileSync("mount", ["--bind", path.join(other, name), path.join(root, name)]);
    // The mounted files' volume answers as for ext3, FAT or NFS; the worktree's does not.
    const coarse = createFileBrowser({ hooks: { statfs: async (at) => (at.endsWith(".md") || at.endsWith(".png") ? { type: 0x6969 } : statfs(at)) } });
    assert.equal((await refusal(coarse.preview(root, "a.md"))).code, "PREVIEW_UNAVAILABLE");
    const { request, response, body } = capture();
    assert.equal((await refusal(coarse.raw(root, "logo.png", null, request, response))).code, "PREVIEW_UNAVAILABLE");
    assert.equal(body().length, 0);
    // A mounted file on a volume with nanosecond ctimes (tmpfs) is previewed.
    assert.equal((await createFileBrowser().preview(root, "a.md")).text, "# Mounted\n");
  } finally {
    for (const name of ["a.md", "logo.png"]) try { execFileSync("umount", [path.join(root, name)], { stdio: "ignore" }); } catch {}
    execFileSync("umount", [other]);
  }
});

test("an AVIF is sized only from metadata it read whole, and never when a decoder would show a track instead", previewable, async (t) => {
  const { root, write } = fixture(t);
  const ftyp = (major, ...compatible) => box("ftyp", Buffer.from(major), u32(0), ...compatible.map((brand) => Buffer.from(brand)));
  const ispe = (width, height) => box("ispe", u32(0, width, height));
  // pitm names the primary item, which a decoder shows for an avif major brand.
  const meta = (...properties) => box("meta", u32(0), box("pitm", u32(0), Buffer.from([0, 1])), box("iprp", box("ipco", ...properties)));
  // Its frame size is not read: a decoder showing it could draw any size.
  const moov = box("moov", box("trak", box("tkhd", Buffer.alloc(84))));
  const mdat = box("mdat", Buffer.alloc(1100 * 1024));
  const cases = [
    // Its image data runs past the sample; its metadata does not.
    ["large.avif", Buffer.concat([ftyp("avif", "mif1", "avif"), meta(ispe(64, 48)), mdat]), "image"],
    // A later item past the sample may be larger than the ones read.
    ["late-item.avif", Buffer.concat([ftyp("avif", "mif1", "avif"), meta(ispe(64, 64), box("free", Buffer.alloc(1100 * 1024)), ispe(10_000, 10_000))]), "unsupported"],
    ["sequence.avif", Buffer.concat([ftyp("avis", "avif", "msf1"), meta(ispe(64, 48)), moov]), "unsupported"],
    ["track.avif", Buffer.concat([ftyp("mif1", "avif"), meta(ispe(64, 48)), moov]), "unsupported"],
    // Past the sample there may be a track.
    ["late-track.avif", Buffer.concat([ftyp("mif1", "avif"), meta(ispe(64, 48)), mdat, moov]), "unsupported"],
  ];
  const files = createFileBrowser();
  for (const [name, bytes, type] of cases) {
    write(name, bytes);
    const preview = await files.preview(root, name);
    assert.equal(preview.previewType, type, name);
    const { request, response, body } = capture();
    if (type === "image") {
      await files.raw(root, name, preview.version, request, response);
      assert.equal(body().length, bytes.length, name);
      continue;
    }
    assert.equal(preview.reason, "This AVIF image's size cannot be read", name);
    assert.deepEqual(await refusal(files.raw(root, name, null, request, response)).then((error) => [error.status, error.code]), [415, "NOT_RAW_PREVIEW"], name);
    assert.equal(body().length, 0, name);
  }
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

test("a folder replaced by a link after it was resolved is never read through, for listing, preview or raw", linkable, async (t) => {
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

test("a folder swapped for a link after it was checked is read through its handle, and without a handle-bound path is never listed", linkable, async (t) => {
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

test("a file whose ancestor is swapped for a link after it was resolved is read through the held folder, and without a descriptor-bound location is never read", linkable, async (t) => {
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
  // The file is opened by its last name inside the folder handle the walk
  // holds, so the swapped ancestor's name is never used again: the inside
  // file is served, never the outside one.
  const bound = await run(createFileBrowser({ hooks }));
  assert.deepEqual(bound, { preview: { served: "# Inside\n" }, raw: { served: PNG.toString("latin1") } });
  // Where it cannot be proven, nothing is read at all.
  const unbound = await run(createFileBrowser({ handlePaths: false, hooks }));
  for (const name of ["preview", "raw"]) assert.deepEqual(unbound[name], { status: 501, code: "PREVIEW_UNAVAILABLE" }, `${name}: ${JSON.stringify(unbound[name])}`);
  const plain = createFileBrowser({ handlePaths: false });
  assert.equal((await refusal(plain.preview(root, "docs/inner/guide.md"))).code, "PREVIEW_UNAVAILABLE");
  // With nothing swapped, a proven location previews normally.
  assert.equal((await createFileBrowser().preview(root, "docs/inner/guide.md")).text, "# Inside\n");
});

// Open descriptors as the operating system lists them for this process.
function openDescriptors() { return readdirSync(process.platform === "linux" ? "/proc/self/fd" : "/dev/fd").length; }

test("a host that cannot read through a root handle lists no folder and previews no file", { skip: anchored && "this host reads through a root handle" }, async (t) => {
  const { root, write } = fixture(t);
  write("a.md", "# A\n");
  assert.equal((await refusal(createFileBrowser().list(root))).code, "LISTING_UNAVAILABLE");
  assert.equal((await refusal(createFileBrowser().preview(root, "a.md"))).code, "PREVIEW_UNAVAILABLE");
  // Nothing below the root is looked at, so a missing name answers alike.
  assert.equal((await refusal(createFileBrowser().preview(root, "gone.md"))).code, "PREVIEW_UNAVAILABLE");
});

test("a root whose parent is renamed and replaced, without links, never serves another directory's names or bytes", linkable, async (t) => {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "outright-root-swap-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const parent = path.join(base, "p");
  const root = path.join(parent, "wt");
  const put = (top, relative, content) => { const target = path.join(base, top, "wt", ...relative.split("/")); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, content); };
  put("p", "a.md", "# Inside\n");
  put("p", "docs/guide.md", "# Guide\n");
  put("p", "logo.png", PNG);
  put("impostor", "a.md", "# PRIVATE\n");
  put("impostor", "secret.txt", "PRIVATE");
  put("impostor", "docs/guide.md", "# PRIVATE\n");
  put("impostor", "docs/secret-name.txt", "PRIVATE");
  put("impostor", "logo.png", Buffer.concat([PNG, Buffer.from("PRIVATE")]));
  let moved = false;
  let swaps = 0;
  const swap = () => { if (moved) return; renameSync(parent, path.join(base, "p-old")); renameSync(path.join(base, "impostor"), parent); moved = true; swaps += 1; };
  const restore = () => { if (!moved) return; renameSync(parent, path.join(base, "impostor")); renameSync(path.join(base, "p-old"), parent); moved = false; };
  const before = openDescriptors();
  for (const hook of ["beforeRoot", "beforeOpen", "beforeInspect"]) {
    const files = createFileBrowser({ hooks: { [hook]: swap } });
    const operations = {
      "list root": () => files.list(root, { showHidden: true }),
      "list docs": () => files.list(root, { directory: "docs" }),
      preview: () => files.preview(root, "a.md"),
      raw: async () => { const { request, response, body } = capture(); await files.raw(root, "logo.png", null, request, response); return body().toString("latin1"); },
    };
    for (const [name, operation] of Object.entries(operations)) {
      const counted = swaps;
      const outcome = await operation().then((value) => ({ served: JSON.stringify(value) }), (error) => ({ status: error.statusCode, code: error.details?.code }));
      const swapped = swaps > counted;
      restore();
      if (swapped) assert.deepEqual(outcome, { status: 409, code: "PATH_CHANGED" }, `${hook} ${name}: ${JSON.stringify(outcome)}`);
      assert.doesNotMatch(JSON.stringify(outcome), /PRIVATE|secret/, `${hook} ${name}`);
    }
  }
  // The root itself is listed through the root handle, so beforeOpen runs
  // for the other three; beforeInspect runs only for files (preview, raw).
  assert.equal(swaps, 4 + 3 + 2);
  assert.equal(openDescriptors(), before, "a refused request left a descriptor open");
  // A folder inside the root renamed away and replaced by another folder is
  // either refused or read from the root as it now is, never from elsewhere.
  mkdirSync(path.join(base, "elsewhere"));
  writeFileSync(path.join(base, "elsewhere", "moved-in.md"), "# Moved in\n");
  const docs = path.join(root, "docs");
  const replaceDocs = () => { renameSync(docs, path.join(base, "docs-away")); renameSync(path.join(base, "elsewhere"), docs); };
  const listing = await createFileBrowser({ hooks: { beforeOpen: replaceDocs } }).list(root, { directory: "docs" }).then((value) => value.entries.map((entry) => entry.name), (error) => error.details?.code);
  assert.ok(listing === "PATH_CHANGED" || JSON.stringify(listing) === JSON.stringify(["moved-in.md"]), `intermediate swap: ${JSON.stringify(listing)}`);
  // Unswapped, the same requests serve the worktree as before.
  const plain = createFileBrowser();
  assert.deepEqual((await plain.list(root)).entries.map((entry) => entry.name), ["docs", "a.md", "logo.png"]);
  assert.equal((await plain.preview(root, "a.md")).text, "# Inside\n");
  assert.equal(openDescriptors(), before);
});

test("an intermediate folder swapped for an outside link after it was looked up never reveals the outside object's kind", linkable, async (t) => {
  const { base, root, write } = fixture(t);
  write("d/x", "inside file\n");
  write("d/x.png", PNG);
  symlinkSync("d/x", path.join(root, "l"));
  symlinkSync("d/x.png", path.join(root, "image.png"));
  // One link per listed folder, so each listing's lookup is the swapped one.
  mkdirSync(path.join(root, "one"));
  mkdirSync(path.join(root, "two"));
  symlinkSync("../d/x", path.join(root, "one", "l"));
  symlinkSync("../d/x.png", path.join(root, "two", "image.png"));
  // Outside, the same names are folders: following the swap would report one.
  mkdirSync(path.join(base, "outside", "x"), { recursive: true });
  mkdirSync(path.join(base, "outside", "x.png"));
  const d = path.join(root, "d");
  let swaps = 0;
  // d was looked up as a folder; it is swapped just before it is opened.
  const swap = (real) => { if (real !== d || existsSync(`${d}-old`)) return; swaps += 1; renameSync(d, `${d}-old`); symlinkSync(path.join(base, "outside"), d); };
  const restore = () => { if (!existsSync(`${d}-old`)) return; unlinkSync(d); renameSync(`${d}-old`, d); };
  const before = openDescriptors();
  const files = createFileBrowser({ hooks: { beforeOpen: swap } });
  for (const [name, operation] of [["preview", () => files.preview(root, "l")], ["raw", () => { const { request, response } = capture(); return files.raw(root, "image.png", null, request, response); }]]) {
    const outcome = await refusal(operation());
    restore();
    assert.deepEqual([outcome.status, outcome.code], [409, "PATH_CHANGED"], `${name}: ${JSON.stringify(outcome)}`);
  }
  for (const folder of ["one", "two"]) {
    const { entries } = await files.list(root, { directory: folder });
    restore();
    assert.deepEqual(entries.map((entry) => entry.target), [{ state: "unreadable" }], folder);
  }
  assert.equal(swaps, 4, "each request swapped d once");
  assert.equal(openDescriptors(), before, "a refused lookup left a descriptor open");
  // Unswapped, the links lead to the inside files.
  const plain = createFileBrowser();
  assert.deepEqual((await plain.list(root, { directory: "one" })).entries[0].target, { state: "file", path: "d/x" });
  assert.equal((await plain.preview(root, "l")).text, "inside file\n");
});

test("an outside name answers the same whether or not it exists, with or without a root handle", linkable, async (t) => {
  const { base, root } = fixture(t);
  mkdirSync(path.join(base, "outside", "sub"), { recursive: true });
  writeFileSync(path.join(base, "outside", "secret.txt"), "private");
  writeFileSync(path.join(base, "outside", "logo.png"), PNG);
  writeFileSync(path.join(base, "outside", "sub", "x"), "private");
  // An absolute and a relative link to the same outside folder, and links
  // straight to an outside file that exists and to one that does not.
  symlinkSync(path.join(base, "outside"), path.join(root, "out"));
  symlinkSync("../outside", path.join(root, "rel-out"));
  for (const [name, target] of [["to-present", "secret.txt"], ["to-absent", "nope.txt"]]) {
    symlinkSync(path.join(base, "outside", target), path.join(root, name));
    symlinkSync(`../outside/${target}`, path.join(root, `rel-${name}`));
  }
  const outcome = (promise) => promise.then((value) => (value?.entries ? "listed" : value?.previewType ?? "served"), (error) => `${error.statusCode} ${error.details?.code}`);
  for (const handlePaths of [true, false]) {
    const files = createFileBrowser({ handlePaths });
    const raw = (file) => { const { request, response } = capture(); return files.raw(root, file, null, request, response); };
    for (const out of ["out", "rel-out"]) {
      for (const [label, present, absent] of [
        ["preview", () => files.preview(root, `${out}/secret.txt`), () => files.preview(root, `${out}/nope.txt`)],
        ["list", () => files.list(root, { directory: `${out}/sub` }), () => files.list(root, { directory: `${out}/nosub` })],
        ["preview under a folder", () => files.preview(root, `${out}/sub/x`), () => files.preview(root, `${out}/nosub/x`)],
        ["raw", () => raw(`${out}/logo.png`), () => raw(`${out}/nologo.png`)],
      ]) {
        const answers = [await outcome(present()), await outcome(absent())];
        const expected = handlePaths ? "403 OUTSIDE_WORKTREE" : label === "list" ? "501 LISTING_UNAVAILABLE" : "501 PREVIEW_UNAVAILABLE";
        assert.deepEqual(answers, [expected, expected], `handlePaths ${handlePaths}, ${out}, ${label}`);
      }
    }
    if (!handlePaths) continue;
    const targets = Object.fromEntries((await files.list(root)).entries.map((entry) => [entry.name, entry.target]));
    for (const name of ["out", "rel-out", "to-present", "to-absent", "rel-to-present", "rel-to-absent"]) assert.deepEqual(targets[name], { state: "outside" }, name);
  }
});

test("a link whose target's folder disappears while it is resolved is missing, not unreadable", linkable, async (t) => {
  const { base, root, write } = fixture(t);
  write("d/x", "inside\n");
  symlinkSync("d/x", path.join(root, "l"));
  const d = path.join(root, "d");
  const remove = (real) => { if (real === d && existsSync(d)) renameSync(d, path.join(base, "away")); };
  const listed = (await createFileBrowser({ hooks: { beforeOpen: remove } }).list(root)).entries.find((entry) => entry.name === "l");
  assert.deepEqual(listed.target, { state: "missing" });
});

test("a readable file in a folder that can be entered but not listed previews and streams", { skip: linkable.skip || (process.getuid?.() === 0 && "root ignores folder permissions") }, async (t) => {
  const { root, write } = fixture(t);
  write("private/guide.md", "# Guide\n");
  write("private/logo.png", PNG);
  const folder = path.join(root, "private");
  chmodSync(folder, 0o111);
  try {
    const files = createFileBrowser();
    assert.equal((await files.preview(root, "private/guide.md")).text, "# Guide\n");
    const { request, response, body } = capture();
    await files.raw(root, "private/logo.png", null, request, response);
    assert.deepEqual(body(), PNG);
    // Its own entries stay unlisted.
    assert.equal((await refusal(files.list(root, { directory: "private" }))).code, "UNREADABLE");
  } finally { chmodSync(folder, 0o755); }
});

test("a folder moved away after it was opened serves nothing read through it, for listing, preview and raw", linkable, async (t) => {
  const { base, root, write } = fixture(t);
  write("d/y.md", "# inside y\n");
  write("d/logo.png", PNG);
  write("a/b/x.md", "# inside x\n");
  mkdirSync(path.join(base, "outside"));
  const d = path.join(root, "d");
  const away = path.join(base, "outside", "d");
  let moves = 0;
  // d leaves the worktree (or moves within it); then private content is
  // written in it, in place, so an opened file sees it too.
  const move = (to = away) => () => {
    if (!existsSync(d)) return;
    moves += 1;
    renameSync(d, to);
    writeFileSync(path.join(to, "z-private.md"), "PRIVATE");
    writeFileSync(path.join(to, "y.md"), "# PRIVATE\n");
    writeFileSync(path.join(to, "logo.png"), Buffer.concat([PNG, Buffer.from("PRIVATE")]));
  };
  const restore = () => {
    for (const from of [away, path.join(root, "e")]) if (existsSync(from)) renameSync(from, d);
    if (existsSync(path.join(base, "outside", "a"))) renameSync(path.join(base, "outside", "a"), path.join(root, "a"));
    rmSync(path.join(d, "z-private.md"), { force: true });
    writeFileSync(path.join(d, "y.md"), "# inside y\n");
    writeFileSync(path.join(d, "logo.png"), PNG);
  };
  const at = (target, act) => (real) => { if (real === target) act(); };
  const raw = (files, file) => { const { request, response, body } = capture(); return files.raw(root, file, null, request, response).then(() => body().toString("latin1")); };
  const list = (directory) => (files) => files.list(root, { directory });
  const cases = [
    ["list, moved out after open", { afterOpen: at(d, move()) }, list("d")],
    ["list, moved out before read", { beforeRead: move() }, list("d")],
    ["list, moved out after read", { afterRead: move() }, list("d")],
    ["list, moved within the worktree after open", { afterOpen: at(d, move(path.join(root, "e"))) }, list("d")],
    ["list, its parent moved out after open", { afterOpen: at(path.join(root, "a", "b"), () => { moves += 1; renameSync(path.join(root, "a"), path.join(base, "outside", "a")); }) }, list("a/b")],
    ["preview, moved out before inspect", { beforeInspect: move() }, (files) => files.preview(root, "d/y.md")],
    ["preview, moved out after the file opened", { afterOpen: at(path.join(d, "y.md"), move()) }, (files) => files.preview(root, "d/y.md")],
    ["raw, moved out before inspect", { beforeInspect: move() }, (files) => raw(files, "d/logo.png")],
  ];
  const before = openDescriptors();
  for (const [label, hooks, operation] of cases) {
    const counted = moves;
    const outcome = await operation(createFileBrowser({ hooks })).then((value) => ({ served: JSON.stringify(value) }), (error) => ({ status: error.statusCode, code: error.details?.code }));
    restore();
    assert.equal(moves, counted + 1, `${label}: the move ran`);
    assert.deepEqual(outcome, { status: 409, code: "PATH_CHANGED" }, `${label}: ${JSON.stringify(outcome)}`);
  }
  assert.equal(openDescriptors(), before, "a refused request left a descriptor open");
  // Unmoved, the same requests serve the worktree.
  const plain = createFileBrowser();
  assert.deepEqual((await plain.list(root, { directory: "d" })).entries.map((entry) => entry.name), ["logo.png", "y.md"]);
  assert.equal((await plain.preview(root, "d/y.md")).text, "# inside y\n");
  assert.equal(await raw(plain, "d/logo.png"), PNG.toString("latin1"));
});

test("a \"..\" link whose folder moved within the worktree is PATH_CHANGED, never resolved by the stale names", linkable, async (t) => {
  const { root, write } = fixture(t);
  write("a/x.md", "# a x\n");
  mkdirSync(path.join(root, "a", "b"));
  symlinkSync("../x.md", path.join(root, "a", "b", "l"));
  const b = path.join(root, "a", "b");
  // After b is opened, a is renamed and a new a takes its name. The kernel
  // follows l from b's real parent (a2/x.md); the stale names lead to a/x.md.
  const relocate = (real) => { if (real !== b || existsSync(path.join(root, "a2"))) return; renameSync(path.join(root, "a"), path.join(root, "a2")); write("a/x.md", "# stale place\n"); };
  const files = createFileBrowser({ hooks: { afterOpen: relocate } });
  const outcome = await files.preview(root, "a/b/l").then((value) => value.text, (error) => error.details?.code);
  assert.equal(outcome, "PATH_CHANGED");
  rmSync(path.join(root, "a"), { recursive: true });
  renameSync(path.join(root, "a2"), path.join(root, "a"));
  const plain = await createFileBrowser().preview(root, "a/b/l");
  assert.deepEqual([plain.text, plain.link], ["# a x\n", { target: "a/x.md" }]);
});

test("a link destination ending in \"/\" or \"/.\" needs a folder, as the kernel does, also through other links", linkable, async (t) => {
  const { root, write } = fixture(t);
  write("f.txt", "plain\n");
  write("d/in.md", "# in\n");
  const links = {
    slash: "f.txt/", slashdot: "f.txt/.", absolute: `${root}/f.txt/`, alias: "f.txt", chained: "alias/", "via-slash": "slash",
    "dir-slash": "d/", "dir-absolute": `${root}/d/.`,
  };
  for (const [name, destination] of Object.entries(links)) symlinkSync(destination, path.join(root, name));
  const files = createFileBrowser();
  const targets = Object.fromEntries((await files.list(root)).entries.map((entry) => [entry.name, entry.target]));
  for (const name of ["slash", "slashdot", "absolute", "chained", "via-slash"]) {
    // The independent oracle: the kernel refuses each of them.
    assert.throws(() => statSync(path.join(root, name)), { code: "ENOTDIR" }, name);
    assert.deepEqual((await refusal(files.preview(root, name))).code, "MISSING", name);
    assert.deepEqual((await refusal(files.list(root, { directory: name }))).code, "NOT_DIRECTORY", name);
    assert.deepEqual(targets[name], { state: "missing" }, name);
  }
  assert.deepEqual(targets.alias, { state: "file", path: "f.txt" });
  for (const name of ["dir-slash", "dir-absolute"]) {
    assert.ok(statSync(path.join(root, name)).isDirectory(), name);
    assert.deepEqual((await files.list(root, { directory: name })).entries.map((entry) => entry.name), ["in.md"], name);
    assert.equal((await files.preview(root, `${name}/in.md`)).text, "# in\n", name);
    assert.deepEqual(targets[name], { state: "directory", path: "d" }, name);
  }
});

test("a worktree root that can be entered but not listed still previews and streams its readable files", { skip: linkable.skip || (process.getuid?.() === 0 && "root ignores folder permissions") }, async (t) => {
  const { root, write } = fixture(t);
  write("a.md", "# root file\n");
  write("logo.png", PNG);
  write("d/b.md", "# nested\n");
  chmodSync(path.join(root, "d"), 0o111);
  chmodSync(root, 0o111);
  try {
    const files = createFileBrowser();
    assert.equal((await files.preview(root, "a.md")).text, "# root file\n");
    assert.equal((await files.preview(root, "d/b.md")).text, "# nested\n");
    const { request, response, body } = capture();
    await files.raw(root, "logo.png", null, request, response);
    assert.deepEqual(body(), PNG);
    // Neither folder's own entries are listed.
    assert.equal((await refusal(files.list(root))).code, "UNREADABLE");
    assert.equal((await refusal(files.list(root, { directory: "d" }))).code, "UNREADABLE");
  } finally {
    chmodSync(root, 0o755);
    chmodSync(path.join(root, "d"), 0o755);
  }
});

test("a proof is one observation: a chain put back together outside while it is checked is PATH_CHANGED", linkable, async (t) => {
  const { base, root, write } = fixture(t);
  write("a/b/inside.md", "inside\n");
  const outside = path.join(base, "outside");
  mkdirSync(outside);
  let armed = false;
  let fired = false;
  // After b is opened it moves outside and gains a private file. Then, in
  // the middle of the last proof (after the walked name "a" was checked), a
  // moves outside too and b goes under it, so each name checked later still
  // matches what was walked although b never came back (pullfrog's schedule).
  const files = createFileBrowser({ hooks: {
    afterOpen: (real) => {
      if (real !== path.join(root, "a", "b")) return;
      renameSync(real, path.join(outside, "b"));
      writeFileSync(path.join(outside, "b", "PRIVATE.md"), "secret\n");
    },
    afterRead: () => { armed = true; },
    duringProof: (step) => {
      if (!armed || fired || step !== 1) return;
      fired = true;
      renameSync(path.join(root, "a"), path.join(outside, "a"));
      renameSync(path.join(outside, "b"), path.join(outside, "a", "b"));
    },
  } });
  const outcome = await files.list(root, { directory: "a/b" }).then((value) => value.entries.map((entry) => entry.name), (error) => [error.statusCode, error.details?.code]);
  // On Linux the bracket's reading of b's ancestors already finds b outside.
  if (process.platform === "darwin") assert.ok(fired, "the proof ran its checks");
  assert.deepEqual(outcome, [409, "PATH_CHANGED"]);
});

test("on Linux, a held folder moved under an impostor at the root's path while its location is read is PATH_CHANGED", { skip: (process.platform !== "linux" && "the location read is Linux's proof") || linkable.skip }, async (t) => {
  const { base, root, write } = fixture(t);
  write("a/d/x.md", "inside\n");
  const real = path.join(base, "real");
  let stage = 0;
  let outcomeAtReadlink = null;
  const files = createFileBrowser({ hooks: {
    // Once the chain was read in place, the real root leaves, an impostor
    // takes its path, and d moves into the impostor under the same names,
    // with a private file: d's location now reads as the walked one.
    duringProof: (step) => {
      if (step === "chain" && stage === 0) {
        stage = 1;
        renameSync(root, real);
        mkdirSync(path.join(root, "a"), { recursive: true });
        renameSync(path.join(real, "a", "d"), path.join(root, "a", "d"));
        writeFileSync(path.join(root, "a", "d", "PRIVATE.md"), "secret\n");
      } else if (step === "readlink" && stage === 1) {
        // Then the real root comes back, and d stays in the impostor.
        stage = 2;
        outcomeAtReadlink = readdirSync(path.join(root, "a", "d")).sort();
        renameSync(root, path.join(base, "impostor"));
        renameSync(real, root);
      }
    },
  } });
  const outcome = await files.list(root, { directory: "a/d" }).then((value) => value.entries.map((entry) => entry.name), (error) => [error.statusCode, error.details?.code]);
  // The schedule ran in full: d's location was read while it was in the impostor.
  assert.equal(stage, 2);
  assert.deepEqual(outcomeAtReadlink, ["PRIVATE.md", "x.md"]);
  assert.deepEqual(outcome, [409, "PATH_CHANGED"]);
});

test("a proof is made again when a folder on its chain is written to during it, and churn ends in PATH_CHANGED", linkable, async (t) => {
  const { root, write } = fixture(t);
  write("a/x.md", "x");
  let created = 0;
  let names = 0;
  // Each write adds a new name to the root, a folder on every proof's chain.
  const writer = (always) => (step) => { if (step === "chain" && (always || !created)) { created += 1; writeFileSync(path.join(root, `new-${names++}.md`), ""); } };
  const once = await createFileBrowser({ hooks: { duringProof: writer(false) } }).list(root, { directory: "a" });
  assert.equal(created, 1);
  assert.deepEqual(once.entries.map((entry) => entry.name), ["x.md"]);
  created = 0;
  const started = Date.now();
  assert.deepEqual(await refusal(createFileBrowser({ hooks: { duringProof: writer(true) } }).list(root, { directory: "a" })).then((error) => [error.status, error.code]), [409, "PATH_CHANGED"]);
  // One proof, three attempts, each changing the root once.
  assert.equal(created, 3);
  assert.ok(Date.now() - started < 5000, "churn is given up on promptly");
});

test("a worktree or a folder on a volume without nanosecond ctimes is never read", linkable, async (t) => {
  const { root, write } = fixture(t);
  write("a.md", "# A\n");
  write("d/logo.png", PNG);
  const opened = [];
  // The volume probe answers as for HFS+, FAT, SMB or NFS; "/" is still APFS on macOS.
  const files = createFileBrowser({ hooks: { statfs: async (at) => (at === "/" ? statfs("/") : { type: 0x6969 }), beforeOpen: (real) => { opened.push(real); } } });
  assert.equal((await refusal(files.list(root))).code, "LISTING_UNAVAILABLE");
  assert.equal((await refusal(files.list(root, { directory: "d" }))).code, "LISTING_UNAVAILABLE");
  assert.equal((await refusal(files.preview(root, "a.md"))).code, "PREVIEW_UNAVAILABLE");
  const { request, response } = capture();
  assert.equal((await refusal(files.raw(root, "d/logo.png", null, request, response))).code, "PREVIEW_UNAVAILABLE");
  assert.deepEqual(opened, [], "something below the root was opened");
  // A volume of the same type as "/" (APFS) is read on macOS, as is one of a Linux type with nanosecond ctimes.
  const provable = createFileBrowser({ hooks: { statfs: async (at) => (process.platform === "darwin" ? statfs("/") : { type: 0xef53, at }) } });
  assert.equal((await provable.preview(root, "a.md")).text, "# A\n");
});

test("a file whose folder moves outside while its bytes are read is PATH_CHANGED, for preview and raw", linkable, async (t) => {
  const { base, root, write } = fixture(t);
  write("d/y.md", "# inside y\n");
  write("d/logo.png", PNG);
  mkdirSync(path.join(base, "outside"));
  const d = path.join(root, "d");
  const away = path.join(base, "outside", "d");
  const probe = await open(path.join(root, "d", "y.md"), "r");
  const FileHandle = probe.constructor;
  await probe.close();
  const { read: original } = FileHandle.prototype;
  t.after(() => { FileHandle.prototype.read = original; });
  let armed = false;
  let moves = 0;
  // The file's first read, after it was opened and its folder proved: d
  // moves outside and the opened file is rewritten there, in place.
  FileHandle.prototype.read = function read(...args) {
    if (armed) {
      armed = false;
      moves += 1;
      renameSync(d, away);
      for (const name of ["y.md", "logo.png"]) writeFileSync(path.join(away, name), name === "y.md" ? "# PRIVATE\n" : Buffer.concat([PNG, Buffer.from("PRIVATE")]));
    }
    return original.apply(this, args);
  };
  const arm = { hooks: { afterOpen: (real) => { armed = real.startsWith(`${d}${path.sep}`); } } };
  const preview = await refusal(createFileBrowser(arm).preview(root, "d/y.md"));
  renameSync(away, d);
  const { request, response, body } = capture();
  const raw = await refusal(createFileBrowser(arm).raw(root, "d/logo.png", null, request, response));
  assert.equal(moves, 2);
  assert.deepEqual([preview.status, preview.code, raw.status, raw.code], [409, "PATH_CHANGED", 409, "PATH_CHANGED"]);
  assert.equal(body().length, 0, "raw sent bytes");
});

test("a folder that can be read but not entered, below another folder, still lists its names", { skip: linkable.skip || (process.getuid?.() === 0 && "root ignores folder permissions") }, async (t) => {
  const { root, write } = fixture(t);
  write("a/d/x.md", "x");
  chmodSync(path.join(root, "a", "d"), 0o444);
  // A proof searches only the folders the walk passed through, not this one.
  try { assert.deepEqual((await createFileBrowser().list(root, { directory: "a/d" })).entries.map((entry) => entry.name), ["x.md"]); }
  finally { chmodSync(path.join(root, "a", "d"), 0o755); }
});

test("a folder of 500 links lists every target with a bounded number of descriptors, also twice at once", linkable, async (t) => {
  const { root, write } = fixture(t);
  mkdirSync(path.join(root, "links"));
  for (let index = 0; index < 500; index += 1) {
    write(`targets/t${index}/f.md`, "x");
    symlinkSync(`../targets/t${index}/f.md`, path.join(root, "links", `l${String(index).padStart(3, "0")}`));
  }
  const before = openDescriptors();
  let most = 0;
  const files = createFileBrowser({ hooks: { afterOpen: () => { most = Math.max(most, openDescriptors()); } } });
  const listings = await Promise.all([1, 2].map(() => files.list(root, { directory: "links", limit: 500 })));
  for (const { entries } of listings) {
    assert.equal(entries.length, 500);
    for (const entry of entries) assert.deepEqual(entry.target, { state: "file", path: `targets/t${Number(entry.name.slice(1))}/f.md` }, entry.name);
  }
  // Per listing: the root and listed folder, and per lookup in flight two
  // folders plus the one a proof opens while it walks the chain.
  const bound = 2 * (2 + 3 * FILE_BROWSER_LIMITS.linkLookups) + 2;
  assert.ok(most - before <= bound, `${most - before} descriptors were open at once (bound ${bound})`);
  assert.equal(openDescriptors(), before);
});

test("an opened file whose status cannot be read, or never settles, is closed before the error is reported, for preview and raw", previewable, async (t) => {
  const { root, write } = fixture(t);
  write("a.md", "# A\n");
  write("a.png", PNG);
  const probe = await open(path.join(root, "a.md"), "r");
  const FileHandle = probe.constructor;
  await probe.close();
  const { stat: original } = FileHandle.prototype;
  // From the given status read of the opened file on (the first is made as
  // it is opened, the next ones while it settles), each fails or reports a
  // write just now.
  let schedule = null;
  let file = null;
  let reads = 0;
  t.after(() => { FileHandle.prototype.stat = original; });
  FileHandle.prototype.stat = async function stat(...args) {
    if (schedule && args[0]?.bigint) file ??= this;
    if (!schedule || this !== file || ++reads < schedule.from) return original.apply(this, args);
    if (schedule.fail) throw Object.assign(new Error("injected"), { code: "EIO" });
    return Object.assign(await original.apply(this, args), { ctimeNs: BigInt(Date.now()) * 1_000_000n });
  };
  const before = openDescriptors();
  for (const [from, fail, expected] of [[1, true, [500, "READ_FAILED"]], [2, true, [500, "READ_FAILED"]], [2, false, [409, "FILE_CHANGED"]]]) {
    for (const name of ["a.md", "a.png"]) {
      // Only the file's own open arms the schedule, not its folder's.
      const files = createFileBrowser({ hooks: { afterOpen: (real) => { if (real.endsWith(name)) { schedule = { from, fail }; file = null; reads = 0; } } } });
      const { request, response } = capture();
      const request_ = name === "a.md" ? files.preview(root, name) : files.raw(root, name, null, request, response);
      await refusal(request_);
      const record = files.operations().at(-1);
      assert.deepEqual([record.status, record.code], expected, `${name} from status read ${from}`);
      schedule = null;
      assert.equal(openDescriptors(), before, `${name} from status read ${from}: the opened file was left open`);
    }
  }
});

test("a name with a drive-like prefix is browsable outside Windows, where only real outside paths are refused", { skip: (process.platform === "win32" && "a drive prefix is a real location on Windows") || listable.skip }, async (t) => {
  const { base, root, write } = fixture(t);
  write("a:notes.md", "# Colon\n");
  write("C:docs/inner.txt", "inside");
  write("README.md", "# Hello\n");
  writeFileSync(path.join(base, "outside.txt"), "outside");
  const files = createFileBrowser();
  const shown = await files.list(root);
  assert.deepEqual(shown.entries.map((entry) => [entry.path, entry.kind]), [["C:docs", "directory"], ["a:notes.md", "file"], ["README.md", "file"]]);
  // A listed entry can be previewed and expanded, as any other name.
  assert.equal((await files.preview(root, "a:notes.md")).text, "# Colon\n");
  assert.deepEqual((await files.list(root, { directory: "C:docs" })).entries.map((entry) => entry.path), ["C:docs/inner.txt"]);
  assert.equal((await files.preview(root, "C:docs/inner.txt")).text, "inside");
  // The real outside routes stay refused.
  for (const target of [path.join(base, "outside.txt"), "/etc/hosts", "../outside.txt", "C:docs/../../outside.txt"]) {
    assert.equal((await refusal(files.preview(root, target))).code, "PATH_OUTSIDE", target);
  }
  assert.equal((await refusal(files.preview(root, "C:docs/.git/config"))).code, "EXCLUDED");
});

test("a drive prefix or a Windows absolute path is refused only on Windows", () => {
  const outside = (value, platform) => assert.throws(() => relativePath(value, FILE_BROWSER_LIMITS, false, platform), (error) => error.details?.code === "PATH_OUTSIDE", `${platform}: ${value}`);
  for (const value of ["C:x", "c:docs/a.md", "C:\\x", "\\\\server\\share\\x", "\\x", "/x", "a\\..\\..\\x"]) outside(value, "win32");
  assert.equal(relativePath("docs\\a.md", FILE_BROWSER_LIMITS, false, "win32"), "docs/a.md");
  for (const value of ["/x", "../x", "a/../b"]) outside(value, "linux");
  for (const [value, expected] of [["C:x", "C:x"], ["a:notes.md", "a:notes.md"], ["C:docs/a.md", "C:docs/a.md"], ["a\\b", "a\\b"]]) {
    assert.equal(relativePath(value, FILE_BROWSER_LIMITS, false, "linux"), expected, value);
    assert.equal(relativePath(value, FILE_BROWSER_LIMITS, false, "darwin"), expected, value);
  }
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

test("shutdown ends a stalled raw stream and a queued request, closes the handle and refuses new ones", previewable, async (t) => {
  const { root, write } = fixture(t);
  write("report.pdf", Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(4 * 1024 * 1024, 32)]));
  const files = createFileBrowser({ limits: { ...FILE_BROWSER_LIMITS, maxRawStreams: 1, maxRawQueue: 1 } });
  const openDescriptors = () => readdirSync("/dev/fd").length;
  const before = openDescriptors();
  // A client that never reads: its first chunk is never acknowledged.
  const stalled = capture(undefined, new Promise(() => {}));
  const active = files.raw(root, "report.pdf", null, stalled.request, stalled.response);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const queued = capture();
  const waitingTurn = files.raw(root, "report.pdf", null, queued.request, queued.response);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(files.rawStats(), { active: 1, waiting: 1 });
  const closing = files.shutdown();
  assert.equal((await refusal(waitingTurn)).code, "SHUTTING_DOWN");
  await Promise.race([closing, new Promise((_, reject) => setTimeout(() => reject(new Error("shutdown waited on a stalled stream")), 2000))]);
  // The stalled stream settled, and its handle was closed before shutdown did.
  await active;
  assert.equal(openDescriptors(), before, "the stalled stream's file handle stayed open");
  assert.equal(stalled.response.destroyed && queued.response.destroyed, true);
  // Ending it was shutdown's doing, not the client's.
  assert.deepEqual(files.operations().map((record) => [record.outcome, record.code]), [["failed", "SHUTTING_DOWN"], ["failed", "SHUTTING_DOWN"]]);
  assert.deepEqual(files.rawStats(), { active: 0, waiting: 0 });
  const late = capture();
  assert.equal((await refusal(files.raw(root, "report.pdf", null, late.request, late.response))).code, "SHUTTING_DOWN");
  assert.deepEqual(files.rawStats(), { active: 0, waiting: 0 });
  await files.shutdown();
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
