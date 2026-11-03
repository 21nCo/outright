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
  ".avif": ["image/avif", (bytes) => ascii(bytes, 4, 8) === "ftyp" && /^avi[fs]$/.test(ascii(bytes, 8, 12))],
  ".bmp": ["image/bmp", (bytes) => ascii(bytes, 0, 2) === "BM"],
  ".ico": ["image/x-icon", (bytes) => startsWith(bytes, [0x00, 0x00, 0x01, 0x00])],
  // SVG can carry script. It is only ever shown through <img>, which runs
  // none, and its raw response is sandboxed should it be opened directly.
  ".svg": ["image/svg+xml", (bytes) => !bytes.includes(0) && /<svg[\s>]/i.test(bytes.toString("utf8"))],
});
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
function openFlags(directory, anyComponent) {
  const nofollow = (anyComponent && NOFOLLOW_ANY) || (constants.O_NOFOLLOW ?? 0);
  return constants.O_RDONLY | nofollow | (directory ? constants.O_DIRECTORY ?? 0 : constants.O_NONBLOCK ?? 0);
}

// `hooks.beforeInspect(real)` runs before a resolved file is inspected,
// `hooks.beforeOpen(real)` and `hooks.afterOpen(real)` around opening it, and
// `hooks.beforeRead` and `hooks.afterRead` around reading a folder's entries;
// they exist so tests can replace a path component at exactly those moments.
// `handlePaths: false` simulates a system where an opened descriptor's
// location cannot be proven (no /proc/self/fd, /.vol or O_NOFOLLOW_ANY).
export function createFileBrowser({ limits = FILE_BROWSER_LIMITS, hooks = {}, handlePaths = true } = {}) {
  let rawStreams = 0;
  const waiting = [];

  async function list(root, { directory = "", cursor, limit, showHidden = false } = {}) {
    const relative = relativePath(directory, limits, true);
    const pageSize = pageLimit(limit, limits);
    const after = parseCursor(cursor);
    const real = relative ? (await resolveInside(root, relative)).real : root;
    const folder = await openVerified(root, real, relative, true, hooks, handlePaths);
    try { return await listOpened(root, relative, folder, { pageSize, after, showHidden }); }
    finally { await folder.handle.close(); }
  }

  async function listOpened(root, relative, folder, { pageSize, after, showHidden }) {
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
      if (kind === "symlink" && item.readable) result.target = await linkTarget(root, path.join(root, ...entryPath.split("/")));
      return result;
    }));
    const last = page.at(-1);
    return {
      directory: relative,
      entries: listed,
      nextCursor: remaining.length > page.length && last ? encodeCursor(last) : null,
      total: visible.length,
      hiddenCount,
      truncated,
      scanLimit: limits.maxScanEntries,
    };
  }

  async function preview(root, file) {
    const relative = relativePath(file, limits, false);
    const opened = await openFile(root, relative, hooks, handlePaths);
    try { return describe(relative, opened, await classify(relative, opened, limits, true)); }
    finally { await opened.handle?.close(); }
  }

  async function raw(root, file, version, request, response) {
    const site = request.headers?.["sec-fetch-site"];
    if (site && site !== "same-origin" && site !== "none") throw fileError(403, "File previews are only served to Outright", "CROSS_SITE");
    const relative = relativePath(file, limits, false);
    await acquireRawSlot(response);
    let opened;
    try {
      opened = await openFile(root, relative, hooks, handlePaths);
      const kind = await classify(relative, opened, limits, false);
      if (kind.previewType !== "image" && kind.previewType !== "pdf") {
        throw fileError(415, "Only verified image and PDF previews are served as files", "NOT_RAW_PREVIEW");
      }
      if (version && version !== fileVersion(opened.info)) throw fileError(409, "The file changed after it was previewed", "FILE_CHANGED");
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
      await opened?.handle?.close();
    }
  }

  // At most maxRawStreams files stream at once; later requests queue in
  // arrival order, leave the queue if their client goes away, and are
  // refused only when the queue is full.
  function acquireRawSlot(response) {
    if (rawStreams < limits.maxRawStreams) { rawStreams += 1; return Promise.resolve(); }
    if (waiting.length >= limits.maxRawQueue) return Promise.reject(fileError(429, "Too many previews are loading; retry shortly", "PREVIEW_BUSY"));
    return new Promise((resolve, reject) => {
      const entry = {
        resolve: () => { response.off?.("close", abandon); resolve(); },
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

  return { list, preview, raw, rawStats: () => ({ active: rawStreams, waiting: waiting.length }) };
}

function describe(relative, opened, kind) {
  const { info, link } = opened;
  return {
    path: relative,
    name: relative.split("/").at(-1),
    size: info.size,
    modifiedAt: info.mtime.toISOString(),
    version: fileVersion(info),
    link,
    ...kind,
  };
}

async function classify(relative, { handle, info }, limits, withText) {
  if (!handle) return { previewType: "unsupported", reason: "This is not a regular file" };
  const extension = path.extname(relative).toLowerCase();
  const sample = await readBytes(handle, Math.min(info.size, limits.sampleBytes));
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
async function openFile(root, relative, hooks, handlePaths) {
  const logical = path.join(root, ...relative.split("/"));
  let linkInfo;
  try { linkInfo = await lstat(logical); } catch (error) { throw fileSystemError(error, relative, "File"); }
  const { real } = await resolveInside(root, relative);
  let info;
  await hooks.beforeInspect?.(real);
  try { info = await lstat(real); } catch (error) { throw fileSystemError(error, relative, "File"); }
  const link = linkInfo.isSymbolicLink() ? { target: toPosix(path.relative(root, real)) } : null;
  if (info.isSymbolicLink()) throw pathChanged();
  if (info.isDirectory()) throw fileError(409, `${relative} is a folder`, "IS_DIRECTORY");
  if (!info.isFile()) return { handle: null, info, link };
  const { handle } = await openVerified(root, real, relative, false, hooks, handlePaths);
  const opened = await handle.stat();
  // The file at the canonical path must be the one that was checked.
  if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev) {
    await handle.close();
    throw fileError(409, "The file changed while it was being opened; retry", "FILE_CHANGED");
  }
  return { handle, info: opened, link };
}

// Opens `real`, a canonical path inside `root`, and proves that what was
// opened is inside the root even if a component was replaced by a link after
// it was resolved. macOS 11+ refuses a link anywhere in the path; Linux reads the
// descriptor's own location from /proc. A folder is then read through that
// descriptor (/proc/self/fd/N, or the volume's file-ID path /.vol/dev/ino on
// macOS), never by name again. Where the opened location cannot be proven
// (Windows, macOS 10.15, Linux without /proc) nothing is read: a name checked before and
// after opening or reading could still point elsewhere in between. So there
// folders are not listed and files are not previewed, and a macOS volume
// without /.vol lists no folders (owner decision: these platforms are
// deferred to OUT-144 and fail closed).
async function openVerified(root, real, relative, directory, hooks, handlePaths) {
  const noun = directory ? "Folder" : "File";
  await hooks.beforeOpen?.(real);
  let handle;
  try { handle = await open(real, openFlags(directory, handlePaths)); }
  catch (error) {
    // The path was resolved without links, so a link here is a replacement.
    if (error?.code === "ELOOP") throw pathChanged();
    throw fileSystemError(error, relative, noun);
  }
  try {
    await hooks.afterOpen?.(real);
    const procPath = `/proc/self/fd/${handle.fd}`;
    if (handlePaths && process.platform === "linux") {
      const location = await readlink(procPath).catch(() => null);
      if (location !== null) {
        if (!isWithin(root, location) || excludedSegments(path.relative(root, location).split(path.sep))) throw pathChanged();
        return { handle, readPath: procPath };
      }
    }
    if (handlePaths && NOFOLLOW_ANY && !directory) return { handle };
    if (handlePaths && NOFOLLOW_ANY) {
      const info = await handle.stat({ bigint: true });
      const volumePath = `/.vol/${info.dev}/${info.ino}`;
      const usable = await stat(volumePath, { bigint: true }).then((found) => found.ino === info.ino && found.dev === info.dev, () => false);
      if (usable) return { handle, readPath: volumePath };
    }
    if (directory) throw fileError(501, "Folder listing is unavailable on this file system, because a folder cannot be read through the handle Outright checked", "LISTING_UNAVAILABLE");
    throw fileError(501, "Previews are unavailable on this file system, because Outright cannot prove where an opened file is", "PREVIEW_UNAVAILABLE");
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function pathChanged() { return fileError(409, "The path changed while it was being opened; retry", "PATH_CHANGED"); }

async function resolveInside(root, relative) {
  let real;
  try { real = await realpath(path.join(root, ...relative.split("/"))); }
  catch (error) { throw fileSystemError(error, relative, "Path"); }
  if (!isWithin(root, real)) throw fileError(403, `${relative} links outside this worktree`, "OUTSIDE_WORKTREE");
  if (excludedSegments(path.relative(root, real).split(path.sep))) throw fileError(403, "Git metadata is not browsable", "EXCLUDED");
  return { real };
}

async function linkTarget(root, logical) {
  let real;
  try { real = await realpath(logical); }
  catch (error) { return { state: ["ENOENT", "ENOTDIR", "ELOOP"].includes(error.code) ? "missing" : "unreadable" }; }
  if (!isWithin(root, real) || excludedSegments(path.relative(root, real).split(path.sep))) return { state: "outside" };
  try {
    const info = await stat(real);
    return { state: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other", path: toPosix(path.relative(root, real)) };
  } catch { return { state: "missing" }; }
}

// Accepts a relative path with "/" separators ("\\" too on Windows). An
// absolute path, a parent segment, or Git's own metadata is refused before
// the file system is touched.
function relativePath(value, limits, allowRoot) {
  if (value === undefined || value === null || value === "") {
    if (allowRoot) return "";
    throw fileError(400, "A file path is required", "PATH_INVALID");
  }
  if (typeof value !== "string" || value.length > limits.maxPathLength || value.includes("\0")) {
    throw fileError(400, "The file path is invalid", "PATH_INVALID");
  }
  if (path.isAbsolute(value) || path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    throw fileError(403, "Paths must be relative to the worktree", "OUTSIDE_WORKTREE");
  }
  const segments = value.split(process.platform === "win32" ? /[\\/]/ : "/").filter((segment) => segment && segment !== ".");
  if (segments.includes("..")) throw fileError(403, "Paths must stay inside the worktree", "OUTSIDE_WORKTREE");
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
function statKind(info) { return info.isDirectory() ? "directory" : info.isFile() ? "file" : info.isSymbolicLink() ? "symlink" : "other"; }

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

function fileVersion(info) { return `${info.size.toString(36)}-${Math.trunc(info.mtimeMs).toString(36)}-${info.ino.toString(36)}`; }
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
