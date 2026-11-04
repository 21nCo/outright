import { constants } from "node:fs";
import { lstat, open, opendir, readlink, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

// Read-only browsing of one discovered worktree. Every path is relative to
// the worktree's canonical root, and is resolved on each request. A path or
// link that resolves outside the root, or into Git's own metadata, is refused.
// Listings are lazy (one directory per request), scan a bounded number of
// entries, and page by the last returned sort key, so a directory that
// changes between pages neither repeats nor skips the entries that remain.
// Previews never render active content: text and Markdown return as text,
// and only verified image and PDF bytes are served raw, sandboxed.
export const FILE_BROWSER_LIMITS = Object.freeze({
  pageSize: 200,
  maxPageSize: 500,
  maxScanEntries: 10_000,
  maxPathLength: 4096,
  sampleBytes: 8192,
  textBytes: 1024 * 1024,
  imageBytes: 20 * 1024 * 1024,
  pdfBytes: 50 * 1024 * 1024,
  // Above a browser's six connections per host, so one preview's images all
  // load; further requests wait their turn, and only a full queue is refused.
  maxRawStreams: 8,
  maxRawQueue: 64,
});

const MARKDOWN = new Set([".md", ".markdown", ".mdown", ".mkd"]);
const IMAGES = Object.freeze({
  ".png": ["image/png", (bytes) => startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  ".jpg": ["image/jpeg", (bytes) => startsWith(bytes, [0xff, 0xd8, 0xff])],
  ".jpeg": ["image/jpeg", (bytes) => startsWith(bytes, [0xff, 0xd8, 0xff])],
  ".gif": ["image/gif", (bytes) => ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a"],
  ".webp": ["image/webp", (bytes) => ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP"],
  ".avif": ["image/avif", isAvif],
  ".bmp": ["image/bmp", (bytes) => ascii(bytes, 0, 2) === "BM"],
  ".ico": ["image/x-icon", (bytes) => startsWith(bytes, [0x00, 0x00, 0x01, 0x00])],
  // SVG can carry script. It is only ever shown through <img>, which runs
  // none, and its raw response is sandboxed should it be opened directly.
  ".svg": ["image/svg+xml", isSvg],
});
// The first element of an SVG may follow a long prolog (comments, a DOCTYPE
// with its own declarations), so more of an .svg file is read to find it.
const SVG_SAMPLE_BYTES = 1024 * 1024;
// A raw response cannot run script, load anything, or be embedded by
// another site, even if it is opened as a top-level page.
const RAW_HEADERS = Object.freeze({
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Disposition": "inline",
});
// macOS refuses a link in any component of the path (O_NOFOLLOW_ANY). The
// flag exists from macOS 11 (Darwin 20); an older kernel ignores the unknown
// bit and would follow a link, so there it proves nothing and is not used.
// Elsewhere only the last component is guarded by O_NOFOLLOW, so the opened
// descriptor's location is checked afterwards. O_NOFOLLOW_ANY covers the
// last component too, and macOS rejects it combined with O_NOFOLLOW.
export function noFollowAnyFlag(platform = process.platform, release = os.release()) {
  return platform === "darwin" && Number.parseInt(release, 10) >= 20 ? 0x20000000 : 0;
}
const NOFOLLOW_ANY = noFollowAnyFlag();
// Platforms where a request can descend from one handle on the worktree
// root: Linux through /proc/self/fd/N, macOS 11+ through /.vol/dev/ino.
const ANCHORABLE = process.platform === "linux" || Boolean(NOFOLLOW_ANY);
function openFlags(directory, anyComponent) {
  const nofollow = (anyComponent && NOFOLLOW_ANY) || (constants.O_NOFOLLOW ?? 0);
  return constants.O_RDONLY | nofollow | (directory ? constants.O_DIRECTORY ?? 0 : constants.O_NONBLOCK ?? 0);
}

// `hooks.beforeRoot(root)` runs before the root handle is opened,
// `hooks.beforeInspect(real)` after a file or a listed link's target is
// resolved and before it is inspected,
// `hooks.beforeOpen(real)` and `hooks.afterOpen(real)` around opening it, and
// `hooks.beforeRead` and `hooks.afterRead` around reading a folder's entries;
// they exist so tests can replace a path component at exactly those moments.
// `handlePaths: false` simulates a system where an opened descriptor's
// location cannot be proven (no /proc/self/fd, /.vol or O_NOFOLLOW_ANY).
export function createFileBrowser({ limits = FILE_BROWSER_LIMITS, hooks = {}, handlePaths = true } = {}) {
  let rawStreams = 0;
  const waiting = [];
  // Raw responses being streamed, and whether shutdown has begun.
  const streaming = new Map();
  let closed = false;

  async function list(root, { directory = "", cursor, limit, showHidden = false } = {}) {
    const relative = relativePath(directory, limits, true);
    const pageSize = pageLimit(limit, limits);
    const after = parseCursor(cursor);
    const binding = await bindRoot(root, hooks, handlePaths);
    try {
      const real = relative ? (await resolveInside(root, relative)).real : root;
      const folder = await openVerified(binding, real, relative, true, hooks);
      try { return await listOpened(binding, relative, folder, { pageSize, after, showHidden }); }
      finally { await folder.handle.close(); }
    } finally { await binding.close(); }
  }

  async function listOpened(binding, relative, folder, { pageSize, after, showHidden }) {
    let entries;
    await hooks.beforeRead?.(folder.readPath);
    try { entries = await opendir(folder.readPath, { encoding: "buffer", bufferSize: 256 }); }
    catch (error) { throw fileSystemError(error, relative, "Folder"); }
    const visible = [];
    let hiddenCount = 0;
    let scanned = 0;
    let truncated = false;
    try {
      for await (const entry of entries) {
        if (++scanned > limits.maxScanEntries) { truncated = true; break; }
        const name = entry.name.toString("utf8");
        if (name.toLowerCase() === ".git") continue;
        const hidden = name.startsWith(".");
        if (hidden) hiddenCount += 1;
        if (hidden && !showHidden) continue;
        // A name that is not UTF-8 cannot be named again in a request.
        const readable = Buffer.from(name, "utf8").equals(entry.name);
        // The raw bytes keep two names that decode alike apart.
        visible.push({ name, key: entry.name.toString("base64url"), bytes: entry.name, hidden, readable, kind: direntKind(entry), group: entry.isDirectory() ? 0 : 1 });
      }
    } catch (error) { throw fileSystemError(error, relative, "Folder"); }
    await hooks.afterRead?.(folder.readPath);
    visible.sort(compareEntries);
    const remaining = after ? visible.filter((item) => compareEntries(item, after) > 0) : visible;
    const page = remaining.slice(0, pageSize);
    const listed = await Promise.all(page.map(async (item) => {
      const entryPath = relative ? `${relative}/${item.name}` : item.name;
      let { kind } = item;
      // Some file systems report no type with the name.
      if (kind === "unknown" && item.readable) kind = await lstat(path.join(folder.readPath, item.name)).then(statKind, () => "other");
      const result = { name: item.name, path: item.readable ? entryPath : null, kind, hidden: item.hidden };
      // An entry without a path is told apart by its raw name instead.
      if (!item.readable) result.nameKey = item.key;
      if (kind === "symlink" && item.readable) result.target = await linkTarget(binding, entryPath, hooks);
      return result;
    }));
    const last = page.at(-1);
    return {
      directory: relative,
      entries: listed,
      nextCursor: remaining.length > page.length && last ? encodeCursor(last) : null,
      total: visible.length,
      // How many entries follow this page in the folder as it is now. A
      // client adding this page to earlier ones counts what is left from
      // this, not from a total its earlier pages may no longer match.
      remaining: remaining.length - page.length,
      hiddenCount,
      truncated,
      scanLimit: limits.maxScanEntries,
    };
  }

  async function preview(root, file) {
    const relative = relativePath(file, limits, false);
    const binding = await bindRoot(root, hooks, handlePaths);
    let opened;
    try { opened = await openFile(binding, relative, hooks); }
    finally { await binding.close(); }
    try { return describe(relative, opened, await classify(relative, opened, limits, true)); }
    finally { await opened.handle?.close(); }
  }

  async function raw(root, file, version, request, response) {
    const site = request.headers?.["sec-fetch-site"];
    if (site && site !== "same-origin" && site !== "none") throw fileError(403, "File previews are only served to Outright", "CROSS_SITE");
    const relative = relativePath(file, limits, false);
    await acquireRawSlot(response);
    // A queued turn that arrived as shutdown began is given back.
    if (closed) { releaseRawSlot(); throw fileError(503, "Outright is shutting down", "SHUTTING_DOWN"); }
    let opened;
    let finished;
    streaming.set(response, new Promise((resolve) => { finished = resolve; }));
    try {
      const binding = await bindRoot(root, hooks, handlePaths);
      try { opened = await openFile(binding, relative, hooks); }
      finally { await binding.close(); }
      const kind = await classify(relative, opened, limits, false);
      if (kind.previewType !== "image" && kind.previewType !== "pdf") {
        throw fileError(415, "Only verified image and PDF previews are served as files", "NOT_RAW_PREVIEW");
      }
      if (version && version !== opened.info.version) throw fileError(409, "The file changed after it was previewed", "FILE_CHANGED");
      response.statusCode = 200;
      for (const [name, value] of Object.entries(RAW_HEADERS)) response.setHeader(name, value);
      response.setHeader("Content-Type", kind.mimeType);
      response.setHeader("Content-Length", String(opened.info.size));
      const stream = opened.handle.createReadStream({ start: 0, end: opened.info.size - 1, autoClose: false });
      // Headers are sent; a failure now can only end the response.
      try { await pipeline(stream, response); }
      catch (error) { if (!response.destroyed) response.destroy(error); }
    } finally {
      releaseRawSlot();
      try { await opened?.handle?.close(); }
      finally { streaming.delete(response); finished(); }
    }
  }

  // At most maxRawStreams files stream at once; later requests queue in
  // arrival order, leave the queue if their client goes away, and are
  // refused only when the queue is full.
  function acquireRawSlot(response) {
    // A client that left during the checks above takes neither a slot nor a place.
    if (closed) return Promise.reject(fileError(503, "Outright is shutting down", "SHUTTING_DOWN"));
    if (response.destroyed || response.closed) return Promise.reject(fileError(499, "The preview request was closed", "CLIENT_CLOSED"));
    if (rawStreams < limits.maxRawStreams) { rawStreams += 1; return Promise.resolve(); }
    if (waiting.length >= limits.maxRawQueue) return Promise.reject(fileError(429, "Too many previews are loading; retry shortly", "PREVIEW_BUSY"));
    return new Promise((resolve, reject) => {
      const entry = {
        resolve: () => { response.off?.("close", abandon); resolve(); },
        cancel: (error) => { response.off?.("close", abandon); reject(error); response.destroy?.(); },
      };
      function abandon() {
        const index = waiting.indexOf(entry);
        if (index < 0) return;
        waiting.splice(index, 1);
        reject(fileError(499, "The preview request was closed", "CLIENT_CLOSED"));
      }
      response.once?.("close", abandon);
      waiting.push(entry);
    });
  }
  // A finished stream hands its slot straight to the next waiting request.
  function releaseRawSlot() {
    const next = waiting.shift();
    if (next) next.resolve(); else rawStreams -= 1;
  }

  // Shutdown refuses new raw requests, drops queued ones, and ends every
  // stream, so a client that stopped reading cannot hold the server open.
  // It settles once each streamed file's handle is closed.
  function shutdown() {
    closed = true;
    for (const entry of waiting.splice(0)) entry.cancel(fileError(503, "Outright is shutting down", "SHUTTING_DOWN"));
    for (const response of streaming.keys()) if (!response.destroyed) response.destroy();
    return Promise.all(streaming.values()).then(() => {});
  }

  return { list, preview, raw, shutdown, rawStats: () => ({ active: rawStreams, waiting: waiting.length }) };
}

function describe(relative, opened, kind) {
  const { info, link } = opened;
  return {
    path: relative,
    name: relative.split("/").at(-1),
    size: info.size,
    modifiedAt: info.mtime.toISOString(),
    version: info.version,
    link,
    ...kind,
  };
}

async function classify(relative, { handle, info }, limits, withText) {
  if (!handle) return { previewType: "unsupported", reason: "This is not a regular file" };
  const extension = path.extname(relative).toLowerCase();
  const sample = await readBytes(handle, Math.min(info.size, extension === ".svg" ? Math.max(limits.sampleBytes, SVG_SAMPLE_BYTES) : limits.sampleBytes));
  const image = IMAGES[extension];
  if (image) {
    if (!image[1](sample)) return { previewType: "unsupported", reason: `The contents are not a ${extension.slice(1).toUpperCase()} image` };
    if (info.size > limits.imageBytes) return { previewType: "oversized", limit: limits.imageBytes };
    return { previewType: "image", mimeType: image[0] };
  }
  if (extension === ".pdf") {
    if (!sample.subarray(0, 1024).includes("%PDF-")) return { previewType: "unsupported", reason: "The contents are not a PDF document" };
    if (info.size > limits.pdfBytes) return { previewType: "oversized", limit: limits.pdfBytes };
    return { previewType: "pdf", mimeType: "application/pdf" };
  }
  if (sample.includes(0)) return { previewType: "unsupported", reason: "Binary files have no preview" };
  if (info.size > limits.textBytes) return { previewType: "oversized", limit: limits.textBytes };
  const previewType = MARKDOWN.has(extension) ? "markdown" : "text";
  if (!withText) return { previewType };
  const bytes = info.size > sample.length ? await readBytes(handle, info.size) : sample;
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return { previewType: "unsupported", reason: "The contents are not UTF-8 text" }; }
  if (text.includes("\0")) return { previewType: "unsupported", reason: "Binary files have no preview" };
  return { previewType, text };
}

// Opens the canonical target, never a link. A target that is not a regular
// file is described without being opened, so a FIFO cannot block a read.
// Every look at the file goes through the request's root handle, and names
// only its last component inside a folder opened and proved inside the root.
// Without a root anchor nothing past the name's existence is looked at.
async function openFile(binding, relative, hooks) {
  const name = relative.split("/").at(-1);
  const parent = relative.slice(0, -name.length - 1);
  let linkInfo;
  try {
    if (!binding.anchor) await lstat(binding.at(relative));
    else linkInfo = await lookupName(binding, parent ? (await resolveInside(binding.root, parent)).real : binding.root, name, hooks);
  } catch (error) { throw fileSystemError(parentGone(error) ? { code: "ENOENT" } : error, relative, "File"); }
  if (!binding.anchor) throw previewUnavailable();
  let real;
  try { ({ real } = await resolveInside(binding.root, relative)); }
  catch (error) {
    // The name exists, so a missing target means the link itself is broken.
    if (error.details?.code === "MISSING" && linkInfo.isSymbolicLink()) throw fileError(404, `${relative} is a link to a file that does not exist`, "BROKEN_LINK");
    throw error;
  }
  const target = toPosix(path.relative(binding.root, real));
  let info;
  await hooks.beforeInspect?.(real);
  try { info = await inspectResolved(binding, real, hooks); } catch (error) { throw fileSystemError(error, relative, "File"); }
  const link = linkInfo.isSymbolicLink() ? { target } : null;
  if (info.isSymbolicLink()) throw pathChanged();
  if (info.isDirectory()) throw fileError(409, `${relative} is a folder`, "IS_DIRECTORY");
  if (!info.isFile()) return { handle: null, info: fileFacts(info), link };
  const { handle } = await openVerified(binding, real, relative, false, hooks);
  let opened;
  try { opened = await handle.stat({ bigint: true }); }
  catch (error) { await handle.close(); throw fileSystemError(error, relative, "File"); }
  // The file at the canonical path must be the one that was checked.
  if (!opened.isFile() || !sameObject(opened, info)) {
    await handle.close();
    throw fileError(409, "The file changed while it was being opened; retry", "FILE_CHANGED");
  }
  return { handle, info: fileFacts(opened), link };
}

// Looks up one name in a canonical folder inside the root. The folder is
// opened through the root handle and proved inside it (openVerified), and
// only the last name is looked up under that folder's handle path, so a link
// swapped into any earlier component is never followed: such a swap is
// PATH_CHANGED, never the other object's kind, size or existence.
async function lookupName(binding, folder, name, hooks) {
  const opened = await openVerified(binding, folder, toPosix(path.relative(binding.root, folder)), true, hooks);
  try { return await lstat(`${opened.readPath}/${name}`, { bigint: true }); }
  finally { await opened.handle.close(); }
}
// The same for a canonical path; the root itself is the root handle. Its
// folder was resolved as a folder, so one that no longer is (Linux reports a
// link opened with O_DIRECTORY | O_NOFOLLOW so) was replaced.
async function inspectResolved(binding, real, hooks) {
  if (real === binding.root) return binding.handle.stat({ bigint: true });
  try { return await lookupName(binding, path.dirname(real), path.basename(real), hooks); }
  catch (error) { throw error?.details?.code === "NOT_DIRECTORY" ? pathChanged() : error; }
}

// What a preview needs from a bigint stat: plain numbers, and a version that
// changes on any write. A write sets ctime, which utimes cannot set back, so
// restoring mtime or a same-size rewrite within one millisecond still gives
// a new version (to the file system's timestamp resolution).
function fileFacts(info) {
  return { size: Number(info.size), mtime: info.mtime, version: fileVersion(info) };
}

// One handle on the worktree root per request. Its identity must be the
// one the root's path named when the request began, and every later open
// descends from it: /.vol/<dev>/<ino>/<relative> on macOS 11+ (with
// O_NOFOLLOW_ANY, so no link anywhere is followed), /proc/self/fd/<fd>/<relative>
// on Linux. Renaming or replacing the root or any ancestor therefore cannot
// lead a read into another directory; the root's path is checked again after
// each open, so such a change is reported as PATH_CHANGED. Where no handle
// path exists (Windows, macOS 10.15, Linux without /proc, a macOS volume
// without /.vol) there is no anchor and nothing is read (owner decision:
// deferred to OUT-144, failing closed). A hard link to a file is the same
// file wherever it is named, so no path check can tell one apart.
async function bindRoot(root, hooks, handlePaths) {
  const unbound = { root, anchor: null, at: (relative) => path.join(root, ...relative.split("/")), close: async () => {} };
  if (!handlePaths || !ANCHORABLE) return unbound;
  let expected;
  try { expected = await lstat(root, { bigint: true }); } catch (error) { throw fileSystemError(error, "", "Folder"); }
  if (!expected.isDirectory()) throw pathChanged();
  await hooks.beforeRoot?.(root);
  let handle;
  try { handle = await open(root, openFlags(true, true)); }
  catch (error) {
    if (error?.code === "ELOOP") throw pathChanged();
    throw fileSystemError(error, "", "Folder");
  }
  try {
    const info = await handle.stat({ bigint: true });
    if (!sameObject(info, expected)) throw pathChanged();
    let anchor = null;
    if (process.platform === "linux") {
      const procPath = `/proc/self/fd/${handle.fd}`;
      const location = await readlink(procPath).catch(() => null);
      if (location !== null && location !== root) throw pathChanged();
      if (location !== null) anchor = procPath;
    } else {
      const volumePath = `/.vol/${info.dev}/${info.ino}`;
      if (await stat(volumePath, { bigint: true }).then((found) => sameObject(found, info), () => false)) anchor = volumePath;
    }
    if (!anchor) { await handle.close(); return unbound; }
    return {
      root, anchor, handle, identity: info,
      at: (relative) => `${anchor}/${relative || "."}`,
      close: () => handle.close(),
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

// Opens `real`, a canonical path inside the root, through the request's
// root handle, and proves that what was opened is inside the root even if a
// component was replaced by a link after it was resolved. macOS 11+ refuses
// a link anywhere in the path; Linux reads the descriptor's own location
// from /proc and compares it with the root handle's current location. A
// folder is then read through that descriptor (/proc/self/fd/N, or the
// volume's file-ID path /.vol/dev/ino on macOS), never by name again. Without
// a root anchor nothing is read: a name checked before and after opening or
// reading could still point elsewhere in between, so folders are not listed
// and files are not previewed.
async function openVerified(binding, real, relative, directory, hooks) {
  const noun = directory ? "Folder" : "File";
  const target = toPosix(path.relative(binding.root, real));
  await hooks.beforeOpen?.(real);
  let handle;
  try { handle = await open(binding.at(target), openFlags(directory, Boolean(binding.anchor))); }
  catch (error) {
    // The path was resolved without links, so a link here is a replacement.
    if (error?.code === "ELOOP") throw pathChanged();
    throw fileSystemError(error, relative, noun);
  }
  try {
    await hooks.afterOpen?.(real);
    if (!binding.anchor) {
      if (directory) throw fileError(501, "Folder listing is unavailable on this file system, because a folder cannot be read through the handle Outright checked", "LISTING_UNAVAILABLE");
      throw previewUnavailable();
    }
    let readPath;
    if (process.platform === "linux") {
      readPath = `/proc/self/fd/${handle.fd}`;
      const [location, rootNow] = await Promise.all([readlink(readPath), readlink(binding.anchor)].map((read) => read.catch(() => null)));
      if (location === null || rootNow === null || !isWithin(rootNow, location) || excludedSegments(path.relative(rootNow, location).split(path.sep))) throw pathChanged();
    } else if (directory) {
      const info = await handle.stat({ bigint: true });
      readPath = `/.vol/${info.dev}/${info.ino}`;
    }
    await requireRoot(binding);
    return { handle, readPath };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

// The root's path must still name the root handle's directory.
async function requireRoot(binding) {
  const named = await lstat(binding.root, { bigint: true }).catch(() => null);
  if (!named || !sameObject(named, binding.identity)) throw pathChanged();
}

function sameObject(left, right) { return left.ino === right.ino && left.dev === right.dev; }

function previewUnavailable() { return fileError(501, "Previews are unavailable on this file system, because Outright cannot prove where an opened file is", "PREVIEW_UNAVAILABLE"); }
function pathChanged() { return fileError(409, "The path changed while it was being opened; retry", "PATH_CHANGED"); }

async function resolveInside(root, relative) {
  let real;
  try { real = await realpath(path.join(root, ...relative.split("/"))); }
  catch (error) { throw fileSystemError(error, relative, "Path"); }
  if (!isWithin(root, real)) throw fileError(403, `${relative} links outside this worktree`, "OUTSIDE_WORKTREE");
  if (excludedSegments(path.relative(root, real).split(path.sep))) throw fileError(403, "Git metadata is not browsable", "EXCLUDED");
  return { real };
}

// Where a listed link leads. The link is resolved by name, but what is
// reported comes from looking up its canonical target's last name inside its
// folder, opened through the root handle, so a swapped ancestor or
// intermediate folder cannot reveal another directory's state: the target is
// then unreadable.
async function linkTarget(binding, entryPath, hooks) {
  const { root } = binding;
  let real;
  try { real = await realpath(path.join(root, ...entryPath.split("/"))); }
  catch (error) { return { state: missingCode(error) ? "missing" : "unreadable" }; }
  if (!isWithin(root, real) || excludedSegments(path.relative(root, real).split(path.sep))) return { state: "outside" };
  const target = toPosix(path.relative(root, real));
  await hooks.beforeInspect?.(real);
  let info;
  try { info = await inspectResolved(binding, real, hooks); }
  catch (error) { return { state: missingCode(error) ? "missing" : "unreadable" }; }
  const state = statKind(info);
  if (state === "symlink") return { state: "unreadable" };
  return { state, path: target };
}
// A folder on the way to a file that is gone, or is a file, means the file is missing.
function parentGone(error) { return ["MISSING", "NOT_DIRECTORY"].includes(error?.details?.code); }
function missingCode(error) { return ["ENOENT", "ENOTDIR", "ELOOP"].includes(error?.code); }

// Accepts a relative path with "/" separators ("\\" too on Windows). An
// absolute path, a parent segment, or Git's own metadata is refused before
// the file system is touched. A drive prefix ("C:x" is drive-relative) is
// refused only on Windows; elsewhere "C:docs" is an ordinary name.
// A refused path is PATH_OUTSIDE; OUTSIDE_WORKTREE means a link leads out.
export function relativePath(value, limits = FILE_BROWSER_LIMITS, allowRoot = false, platform = process.platform) {
  const windows = platform === "win32";
  if (value === undefined || value === null || value === "") {
    if (allowRoot) return "";
    throw fileError(400, "A file path is required", "PATH_INVALID");
  }
  if (typeof value !== "string" || value.length > limits.maxPathLength || value.includes("\0")) {
    throw fileError(400, "The file path is invalid", "PATH_INVALID");
  }
  if (path.posix.isAbsolute(value) || (windows && (path.win32.isAbsolute(value) || /^[A-Za-z]:/.test(value)))) {
    throw fileError(403, "Paths must be relative to the worktree", "PATH_OUTSIDE");
  }
  const segments = value.split(windows ? /[\\/]/ : "/").filter((segment) => segment && segment !== ".");
  if (segments.includes("..")) throw fileError(403, "Paths must stay inside the worktree", "PATH_OUTSIDE");
  if (excludedSegments(segments)) throw fileError(403, "Git metadata is not browsable", "EXCLUDED");
  if (!segments.length && !allowRoot) throw fileError(400, "A file path is required", "PATH_INVALID");
  return segments.join("/");
}

function excludedSegments(segments) { return segments.some((segment) => segment.toLowerCase() === ".git"); }

function pageLimit(value, limits) {
  if (value === undefined || value === null || value === "") return limits.pageSize;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw fileError(400, "The page size is invalid", "PAGE_INVALID");
  return Math.min(parsed, limits.maxPageSize);
}

function encodeCursor(entry) { return Buffer.from(JSON.stringify([entry.group, entry.name, entry.key]), "utf8").toString("base64url"); }
function parseCursor(value) {
  if (!value) return null;
  try {
    const [group, name, key] = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    if ((group === 0 || group === 1) && typeof name === "string" && typeof key === "string" && /^[\w-]*$/.test(key)) {
      return { group, name, bytes: Buffer.from(key, "base64url") };
    }
  } catch { /* Reported below. */ }
  throw fileError(400, "The folder page cursor is invalid", "CURSOR_INVALID");
}

// Folders first, then a case-insensitive name order with an exact tie-break,
// then the raw name bytes (names that are not UTF-8 can decode alike), so the
// order is total over the folder's entries and a cursor names one position.
function compareEntries(left, right) {
  if (left.group !== right.group) return left.group - right.group;
  const a = left.name.toLowerCase();
  const b = right.name.toLowerCase();
  if (a !== b) return a < b ? -1 : 1;
  if (left.name !== right.name) return left.name < right.name ? -1 : 1;
  return Buffer.compare(left.bytes, right.bytes);
}

function direntKind(entry) {
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  if (entry.isSymbolicLink()) return "symlink";
  return entry.isFIFO() || entry.isSocket() || entry.isCharacterDevice() || entry.isBlockDevice() ? "other" : "unknown";
}
function statKind(info) {
  if (info.isDirectory()) return "directory";
  if (info.isFile()) return "file";
  return info.isSymbolicLink() ? "symlink" : "other";
}

async function readBytes(handle, length) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

function fileVersion(info) { return [info.size, info.mtimeNs, info.ctimeNs, info.ino, info.dev].map((value) => value.toString(36)).join("-"); }
// An AVIF file starts with an ftyp box naming avif or avis as its major
// brand or as one of its compatible brands (a major brand may be mif1).
function isAvif(bytes) {
  if (ascii(bytes, 4, 8) !== "ftyp") return false;
  const size = Math.min(bytes.readUInt32BE(0), bytes.length);
  const brands = [ascii(bytes, 8, 12)];
  for (let offset = 16; offset + 4 <= size; offset += 4) brands.push(ascii(bytes, offset, offset + 4));
  return brands.some((brand) => brand === "avif" || brand === "avis");
}
// An SVG's first element is <svg> (or a prefixed svg element), after only
// a byte order mark, an XML declaration, processing instructions, comments,
// a DOCTYPE and white space. Text whose first element is anything else, or
// whose prolog runs past what was read, is not taken for an SVG.
function isSvg(bytes) {
  if (bytes.includes(0)) return false;
  const text = bytes.toString("utf8");
  let at = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const skip = (pattern) => {
    pattern.lastIndex = at;
    const match = pattern.exec(text);
    if (!match) return false;
    at = pattern.lastIndex;
    return true;
  };
  for (;;) {
    if (skip(/\s+/y)) continue;
    if (text.startsWith("<?", at)) { if (!skip(/<\?[\s\S]*?\?>/y)) return false; continue; }
    if (text.startsWith("<!--", at)) { if (!skip(/<!--[\s\S]*?-->/y)) return false; continue; }
    if (/^<!DOCTYPE/i.test(text.slice(at, at + 9))) { at = doctypeEnd(text, at + 9); if (at < 0) return false; continue; }
    return /^<(?:[A-Za-z_][\w.-]*:)?svg[\s/>]/.test(text.slice(at, at + 256));
  }
}
// Where a DOCTYPE ends: its first ">" outside quotes and outside its
// internal subset ("[...]", whose comments are skipped), or -1 when the
// text ends first. One pass.
function doctypeEnd(text, from) {
  let quote = "";
  let subset = false;
  for (let index = from; index < text.length; index += 1) {
    const char = text[index];
    if (quote) { if (char === quote) quote = ""; }
    else if (subset && text.startsWith("<!--", index)) {
      const end = text.indexOf("-->", index + 4);
      if (end < 0) return -1;
      index = end + 2;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "[" && !subset) subset = true;
    else if (char === "]" && subset) subset = false;
    else if (char === ">" && !subset) return index + 1;
  }
  return -1;
}
function startsWith(bytes, prefix) { return bytes.length >= prefix.length && prefix.every((value, index) => bytes[index] === value); }
function ascii(bytes, start, end) { return bytes.length >= end ? bytes.toString("latin1", start, end) : ""; }
function toPosix(value) { return value.split(path.sep).join("/"); }
// Inside means no ".." segment leads out; a name such as "..notes.md" is inside.
function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function fileSystemError(error, relative, noun) {
  const name = relative || "The worktree root";
  if (error?.statusCode) return error;
  if (error?.code === "ENOENT") return fileError(404, `${name} no longer exists`, "MISSING");
  if (error?.code === "ENOTDIR") return fileError(noun === "Folder" ? 409 : 404, noun === "Folder" ? `${name} is not a folder` : `${name} no longer exists`, noun === "Folder" ? "NOT_DIRECTORY" : "MISSING");
  if (error?.code === "ELOOP") return fileError(409, `${name} is a link that loops`, "LINK_LOOP");
  if (error?.code === "EACCES" || error?.code === "EPERM") return fileError(403, `${name} cannot be read`, "UNREADABLE");
  return fileError(500, `${noun} ${name} could not be read`, "READ_FAILED");
}

function fileError(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.details = { code };
  return error;
}
