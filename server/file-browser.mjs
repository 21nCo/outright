import { constants } from "node:fs";
import { lstat, open, opendir, readlink, stat, statfs } from "node:fs/promises";
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
  // Listed links whose targets are resolved at once; each holds at most two
  // folder descriptors, so a listing's descriptor use stays bounded.
  linkLookups: 8,
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
// A folder that is only passed through is opened for search alone (Linux
// O_PATH, macOS O_EXEC, which with O_DIRECTORY is O_SEARCH), so a folder the
// user may enter but not list still leads to its readable files.
const SEARCH_ONLY = { linux: 0o10000000, darwin: 0x40000000 }[process.platform] ?? constants.O_RDONLY;
// A path that needs more links than this is treated as a loop, as the kernel does.
const MAX_LINKS = 40;
// How many times a proof is made again when a folder on its chain was
// written to while it was made (proveHeld), before PATH_CHANGED.
const PROOF_ATTEMPTS = 3;
function openFlags(directory, search = false) {
  const nofollow = NOFOLLOW_ANY || (constants.O_NOFOLLOW ?? 0);
  const access = search ? SEARCH_ONLY : constants.O_RDONLY;
  return access | nofollow | (directory ? constants.O_DIRECTORY ?? 0 : constants.O_NONBLOCK ?? 0);
}

// `hooks.beforeRoot(root)` runs before the root handle is opened,
// `hooks.beforeOpen(real)` and `hooks.afterOpen(real)` around opening any
// folder or file below it (each folder a path passes through is opened),
// `hooks.beforeInspect(real)` after a file is resolved and before it is opened,
// and `hooks.beforeRead` and `hooks.afterRead` around reading a folder's
// entries, and `hooks.duringProof(step)` between the checks of a proof (after
// each walked name on macOS, between the two readlinks on Linux); they exist
// so tests can replace a path component at exactly those moments.
// `hooks.statfs(path)` stands in for the volume probe (provableVolume).
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
      // Without a root anchor nothing below the root is looked at (OUT-144).
      if (!binding.anchor) throw listingUnavailable();
      const target = relative ? await resolveContained(binding, relative, hooks, "Folder") : null;
      let folder = rootFolder(binding);
      try {
        if (target && !target.info.isDirectory()) throw fileSystemError({ code: "ENOTDIR" }, relative, "Folder");
        if (target?.name) folder = await openUnder(binding, target.parent, target.name, target.info, relative, { directory: true }, hooks);
      } finally { await target?.close(); }
      try { return await listOpened(binding, relative, folder, { pageSize, after, showHidden }); }
      finally { await folder.handle?.close(); }
    } finally { await binding.close(); }
  }

  async function listOpened(binding, relative, folder, { pageSize, after, showHidden }) {
    let entries;
    await hooks.beforeRead?.(folder.readPath);
    try { entries = await opendir(folder.readPath, { encoding: "buffer", bufferSize: 256 }); }
    catch (error) { await proveHeld(binding, folder); throw fileSystemError(error, relative, "Folder"); }
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
    } catch (error) { await proveHeld(binding, folder); throw fileSystemError(error, relative, "Folder"); }
    await hooks.afterRead?.(folder.readPath);
    visible.sort(compareEntries);
    const remaining = after ? visible.filter((item) => compareEntries(item, after) > 0) : visible;
    const page = remaining.slice(0, pageSize);
    const listed = await mapLimited(page, limits.linkLookups, async (item) => {
      const entryPath = relative ? `${relative}/${item.name}` : item.name;
      let { kind } = item;
      // Some file systems report no type with the name.
      if (kind === "unknown" && item.readable) kind = await lstat(path.join(folder.readPath, item.name)).then(statKind, () => "other");
      const result = { name: item.name, path: item.readable ? entryPath : null, kind, hidden: item.hidden };
      // An entry without a path is told apart by its raw name instead.
      if (!item.readable) result.nameKey = item.key;
      if (kind === "symlink" && item.readable) result.target = await linkTarget(binding, folder, item.name, hooks);
      return result;
    });
    // Everything above was read through the held folder, which may have moved
    // since it was opened: it is returned only if the folder is still at its
    // walked place inside the root.
    await proveHeld(binding, folder);
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
    try {
      const opened = await openFile(binding, relative, hooks);
      try {
        const kind = await classify(relative, opened, limits, true);
        // The bytes were read through a folder that may have moved since the open.
        await opened.prove();
        return describe(relative, opened, kind);
      } finally { await opened.close(); }
    } finally { await binding.close(); }
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
      let kind;
      try {
        opened = await openFile(binding, relative, hooks);
        kind = await classify(relative, opened, limits, false);
        // Proved once more before the headers. The stream that follows reads
        // the same opened file, which a writer outside could still change.
        await opened.prove();
      } finally {
        try { await opened?.release(); }
        finally { await binding.close(); }
      }
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

// Opens what the path leads to, never a link. A target that is not a
// regular file is described without being opened, so a FIFO cannot block a
// read. The file is opened by its last name inside the folder handle the
// resolver holds, must be the object it looked up, and is kept only if that
// folder is still at its walked place afterwards. Its bytes are then its own.
// The folder stays held, so the caller proves it again after reading
// (prove), then releases it (release) or it and the file (close).
// Without a root anchor nothing below the root is looked at, so every name
// gives the same answer.
async function openFile(binding, relative, hooks) {
  if (!binding.anchor) throw previewUnavailable();
  const target = await resolveContained(binding, relative, hooks, "File");
  let handle = null;
  try {
    const { info } = target;
    const link = target.requestedLink ? { target: toPosix(path.relative(binding.root, target.real)) } : null;
    if (info.isDirectory()) throw fileError(409, `${relative} is a folder`, "IS_DIRECTORY");
    let facts = info;
    if (info.isFile()) {
      await hooks.beforeInspect?.(target.real);
      ({ handle, info: facts } = await openUnder(binding, target.parent, target.name, info, relative, { directory: false }, hooks));
    }
    const release = () => target.close();
    return {
      handle, info: fileFacts(facts), link, release,
      prove: () => proveHeld(binding, target.parent),
      close: async () => { try { await handle?.close(); } finally { await release(); } },
    };
  } catch (error) {
    await target.close();
    throw error;
  }
}

// Resolves `relative` one name at a time from a folder proved inside the
// root (the root handle, or a listed folder's handle): each name is looked up
// only inside the handle of the folder before it, never through a path of
// several names, and each folder passed through is opened from its parent's
// handle without following a link. Whatever a lookup saw (an entry, its kind,
// a link's destination, or that it is absent) is answered, and a folder is
// left for the root, only after the folder it was made in is proved still at
// its walked place (proveHeld); that proof covers every folder above it, so a
// folder moved away after it was opened answers PATH_CHANGED. A link's
// destination is resolved lexically against that canonical folder; when it
// leaves the root (an absolute path not under the root, or ".." above it), or
// names Git's metadata, the answer is OUTSIDE_WORKTREE or EXCLUDED with
// nothing looked up, so an outside name that exists and one that does not
// answer alike. ".." goes back by the walked names, each of which must still
// be the folder walked through. A destination ending in "/" or "/." needs a
// folder, as the kernel does. An absent name is MISSING (BROKEN_LINK when a
// link named it). At most two folder descriptors are held at once. The result
// keeps the last folder open for the caller, who must call close().
async function resolveContained(binding, relative, hooks, noun, from = rootFolder(binding)) {
  const root = rootFolder(binding);
  let parent = { ...from, handle: null };
  const names = relative.split("/");
  const queue = names.map((name, index) => ({ name, link: false, last: index === names.length - 1 }));
  let links = 0;
  let requestedLink = false;
  let kept = false;
  const release = async (next) => { const held = parent.handle; parent = next; await held?.close(); };
  const outside = () => fileError(403, `${relative} links outside this worktree`, "OUTSIDE_WORKTREE");
  // Leaving the held folder for the root drops it from the proof at the end, so it is proved now.
  const restart = async () => { await proveHeld(binding, parent); await release(root); };
  // The first `depth` walked folders, looked up again from the root.
  const rewalk = async (depth) => {
    const { canonical, chain } = parent;
    await restart();
    queue.unshift(...canonical.slice(0, depth).map((name, index) => ({ name, link: true, last: false, expect: chain[index + 1] })));
  };
  try {
    for (;;) {
      const step = queue.shift();
      if (!step) {
        // A link to "." or ".." ends on a folder without looking it up.
        if (parent.canonical.length) { await rewalk(parent.canonical.length); continue; }
        await proveHeld(binding, parent);
        kept = true;
        return { real: binding.root, parent, name: null, info: await binding.handle.stat({ bigint: true }), requestedLink, close: () => release(null) };
      }
      const { name } = step;
      if (name === "..") {
        if (!parent.canonical.length) throw outside();
        await rewalk(parent.canonical.length - 1);
        continue;
      }
      if (name.toLowerCase() === ".git") throw fileError(403, "Git metadata is not browsable", "EXCLUDED");
      const real = path.join(binding.root, ...parent.canonical, name);
      const at = `${parent.readPath}/${name}`;
      let info;
      let destination;
      let failure;
      try { info = await lstat(at, { bigint: true }); }
      catch (error) {
        // The folder handle is a folder, so ENOTDIR means the lookup went elsewhere.
        if (step.expect || error?.code === "ENOTDIR") failure = pathChanged();
        else failure = error?.code === "ENOENT" && step.link ? fileError(404, `${relative} is a link to a file that does not exist`, "BROKEN_LINK") : fileSystemError(error, relative, noun);
      }
      if (info?.isSymbolicLink()) {
        try { destination = await readlink(at); }
        catch (error) { failure = ["ENOENT", "EINVAL"].includes(error?.code) ? pathChanged() : fileSystemError(error, relative, noun); }
      }
      if (failure) throw failure;
      if (step.expect && !sameObject(info, step.expect)) throw pathChanged();
      // A folder on another volume (one mounted inside the worktree) must be provable too.
      if (info.isDirectory() && info.dev !== binding.identity.dev && !(await provableVolume(binding, info))) {
        throw noun === "Folder" ? listingUnavailable() : previewUnavailable();
      }
      if (destination !== undefined) {
        if (step.last) requestedLink = true;
        if (++links > MAX_LINKS) throw fileError(409, `${relative} is a link that loops`, "LINK_LOOP");
        let parts = destination.split("/");
        if (destination.startsWith("/")) {
          parts = underRoot(binding.root, parts);
          if (!parts) throw outside();
          await restart();
        }
        queue.unshift(...linkSteps(parts, step.directory));
        continue;
      }
      if ((step.directory || queue.length) && !info.isDirectory()) throw fileSystemError({ code: "ENOTDIR" }, relative, noun);
      if (!queue.length) {
        await proveHeld(binding, parent);
        kept = true;
        return { real, parent, name, info, requestedLink, close: () => release(null) };
      }
      await release(await openUnder(binding, parent, name, info, relative, { directory: true, search: true }, hooks));
    }
  } catch (error) {
    // A refusal is reported only once the folder its lookup was made in is
    // proved in place; PATH_CHANGED (a failed proof included) is the answer either way.
    if (error?.details?.code !== "PATH_CHANGED") await proveHeld(binding, parent);
    throw error;
  } finally { if (!kept) await release(null); }
}

// The steps a link's destination adds. A name followed by "/" or "/." must
// be a folder, and the last name inherits that need from the link itself.
function linkSteps(parts, directory) {
  const steps = [];
  for (const part of parts) {
    if (part && part !== ".") steps.push({ name: part, link: true, last: false });
    else if (steps.length) steps.at(-1).directory = true;
  }
  if (directory && steps.length) steps.at(-1).directory = true;
  return steps;
}

// The parts of an absolute link destination after the canonical root, or
// null when it does not name the root or a place under it by that spelling.
// They are resolved by the walk like any other, so a ".." in them is applied
// to canonical folders, and a trailing "/" still needs a folder.
function underRoot(root, parts) {
  let index = 0;
  for (const name of root.split("/").filter(Boolean)) {
    while (index < parts.length && (!parts[index] || parts[index] === ".")) index += 1;
    if (parts[index] !== name) return null;
    index += 1;
  }
  return parts.slice(index);
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
// descends from it one name at a time (resolveContained): /.vol/<dev>/<ino>
// on macOS 11+ (opens with O_NOFOLLOW_ANY), /proc/self/fd/<fd> on Linux
// (opens with O_NOFOLLOW). Renaming or replacing the root or any ancestor therefore cannot
// lead a read into another directory; the root's path is checked again after
// each open, so such a change is reported as PATH_CHANGED. Where no handle
// path exists (Windows, macOS 10.15, Linux without /proc, a macOS volume
// without /.vol or not APFS) there is no anchor and nothing is read (owner
// decision: deferred to OUT-144, failing closed). A hard link to a file is the same
// file wherever it is named, so no path check can tell one apart.
async function bindRoot(root, hooks, handlePaths) {
  const unbound = { root, anchor: null, close: async () => {} };
  if (!handlePaths || !ANCHORABLE) return unbound;
  let expected;
  try { expected = await lstat(root, { bigint: true }); } catch (error) { throw fileSystemError(error, "", "Folder"); }
  if (!expected.isDirectory()) throw pathChanged();
  await hooks.beforeRoot?.(root);
  let handle;
  // Search access only: a root the user may enter but not list still leads
  // to its readable files; listing it opens it for reading through this handle.
  try { handle = await open(root, openFlags(true, true)); }
  catch (error) {
    if (error?.code === "ELOOP" || error?.code === "ENOTDIR") throw pathChanged();
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
    const binding = { root, anchor, handle, identity: info, hooks, volumes: new Map(), close: () => handle.close() };
    if (!anchor || !(await provableVolume(binding, info))) { await handle.close(); return unbound; }
    return binding;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

// Opens `name` inside the held folder `parent`, never following a link, and
// proves it is the object looked up there as `expected`. A link or another
// kind of object put there instead is PATH_CHANGED (FILE_CHANGED for a file).
// A file is kept only if `parent` is still at its walked place after the
// open. A folder is returned held: read through its own descriptor
// (/proc/self/fd/N on Linux, /.vol/dev/ino on macOS), never by name again,
// with its walked names and the identity of each folder from the root down;
// its user proves it (proveHeld) after reading through it. A failed open is
// reported once `parent` is proved in place.
async function openUnder(binding, parent, name, expected, relative, { directory, search = false }, hooks) {
  const noun = directory ? "Folder" : "File";
  const real = path.join(binding.root, ...parent.canonical, name);
  await hooks.beforeOpen?.(real);
  let handle;
  try { handle = await open(`${parent.readPath}/${name}`, openFlags(directory, search)); }
  catch (error) {
    await proveHeld(binding, parent);
    // It was looked up as this kind without following a link, so a link here is a replacement.
    if (error?.code === "ELOOP" || error?.code === "ENOTDIR") throw pathChanged();
    throw fileSystemError(error, relative, noun);
  }
  try {
    await hooks.afterOpen?.(real);
    let info;
    try { info = await handle.stat({ bigint: true }); }
    catch (error) { throw fileSystemError(error, relative, noun); }
    if (!sameObject(info, expected) || (directory ? !info.isDirectory() : !info.isFile())) {
      throw directory ? pathChanged() : fileError(409, "The file changed while it was being opened; retry", "FILE_CHANGED");
    }
    if (!directory) { await proveHeld(binding, parent); return { handle, info }; }
    return {
      readPath: process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : `/.vol/${info.dev}/${info.ino}`,
      handle,
      canonical: [...parent.canonical, name],
      chain: [...parent.chain, info],
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

// The root as a held folder; its handle belongs to the binding.
function rootFolder(binding) { return { readPath: binding.anchor, handle: null, canonical: [], chain: [binding.identity] }; }

// Proves that a held folder is, now, at its walked canonical place inside
// the root, so what was read through it before this call came from inside.
// Linux: the kernel's path of its descriptor equals the root's plus its
// walked names. macOS: from the root's identity down, each walked name looked
// up in the folder above (by /.vol identity) is the folder walked through.
// Those checks are made one after another, so they are bracketed: the ctime
// of the root and of every folder walked to the held one is read before and
// after them, and must not change. Renaming a folder changes its ctime and
// that of the folders it leaves and enters, and so does adding or removing a
// name in a folder (utimes cannot set a ctime back), so equal brackets mean
// the checks saw one unchanging chain, not pieces of different ones. A folder
// written to during the proof is proved again, at most PROOF_ATTEMPTS times
// in all. Anything else is PATH_CHANGED at once. A folder moved out and back
// before this call is inside again, and is not told apart.
async function proveHeld(binding, held) {
  const { hooks } = binding;
  for (let attempt = 1; ; attempt += 1) {
    const before = await chainTimes(binding, held);
    if (process.platform === "linux") {
      const location = await readlink(held.readPath).catch(() => null);
      await hooks.duringProof?.("readlink");
      const rootNow = await readlink(binding.anchor).catch(() => null);
      if (rootNow !== binding.root || location !== path.join(binding.root, ...held.canonical)) throw pathChanged();
    } else {
      for (let depth = 1; depth < held.chain.length; depth += 1) {
        const above = held.chain[depth - 1];
        const found = await lstat(`/.vol/${above.dev}/${above.ino}/${held.canonical[depth - 1]}`, { bigint: true }).catch(() => null);
        if (!found?.isDirectory() || !sameObject(found, held.chain[depth])) throw pathChanged();
        await hooks.duringProof?.(depth);
      }
    }
    await requireRoot(binding);
    const after = await chainTimes(binding, held);
    if (after.every((time, index) => time === before[index])) return;
    if (attempt >= PROOF_ATTEMPTS) throw pathChanged();
  }
}

// The ctime of the root and of each folder walked to the held one, each
// required to be the one walked: by identity on macOS (/.vol); on Linux the
// root's descriptor, and each folder looked up by its walked names from it
// (without following a last link), so a folder no longer at its walked place
// under the root is PATH_CHANGED here too. Only folders the walk passed
// through are searched. They are read together; the bracket only needs all
// of them read before the checks begin, and again after.
async function chainTimes(binding, held) {
  const infos = await Promise.all(held.chain.map((walked, depth) => {
    if (process.platform !== "linux") return stat(`/.vol/${walked.dev}/${walked.ino}`, { bigint: true }).catch(() => null);
    if (!depth) return stat(binding.anchor, { bigint: true }).catch(() => null);
    return lstat(path.join(binding.anchor, ...held.canonical.slice(0, depth)), { bigint: true }).catch(() => null);
  }));
  if (infos.some((info, depth) => !info || !sameObject(info, held.chain[depth]))) throw pathChanged();
  return infos.map((info) => info.ctimeNs);
}

// A proof compares nanosecond ctimes. On macOS only APFS keeps them, and
// macOS 11 and later (the only ones with an anchor) start from an APFS
// volume, so a folder is provable when its volume is of the same type as
// "/". Elsewhere (HFS+, FAT, exFAT, SMB) it is not, and nothing is read
// through it, as on a host without a root handle (OUT-144). Checked once per
// volume and request.
let apfsType;
async function provableVolume(binding, info) {
  if (process.platform !== "darwin") return true;
  if (!binding.volumes.has(info.dev)) {
    apfsType ??= statfs("/").then((found) => found.type, () => null);
    const found = await (binding.hooks.statfs ?? statfs)(`/.vol/${info.dev}/${info.ino}`).catch(() => null);
    const apfs = await apfsType;
    binding.volumes.set(info.dev, apfs !== null && found !== null && found.type === apfs);
  }
  return binding.volumes.get(info.dev);
}

// The root's path must still name the root handle's directory.
async function requireRoot(binding) {
  const named = await lstat(binding.root, { bigint: true }).catch(() => null);
  if (!named || !sameObject(named, binding.identity)) throw pathChanged();
}

function sameObject(left, right) { return left.ino === right.ino && left.dev === right.dev; }

function listingUnavailable() { return fileError(501, "Folder listing is unavailable on this file system, because a folder cannot be read through the handle Outright checked", "LISTING_UNAVAILABLE"); }
function previewUnavailable() { return fileError(501, "Previews are unavailable on this file system, because Outright cannot prove where an opened file is", "PREVIEW_UNAVAILABLE"); }
function pathChanged() { return fileError(409, "The path changed while it was being opened; retry", "PATH_CHANGED"); }

// Where a listed link leads, resolved from the listed folder's handle by the
// same walk as a request, so an outside target is "outside" whether or not it
// exists, and a target replaced while it was looked up is "unreadable".
async function linkTarget(binding, folder, name, hooks) {
  let target;
  try { target = await resolveContained(binding, name, hooks, "Path", folder); }
  catch (error) {
    const code = error?.details?.code;
    if (code === "OUTSIDE_WORKTREE" || code === "EXCLUDED") return { state: "outside" };
    return { state: ["MISSING", "BROKEN_LINK", "LINK_LOOP"].includes(code) ? "missing" : "unreadable" };
  }
  await target.close();
  return { state: statKind(target.info), path: toPosix(path.relative(binding.root, target.real)) };
}

// Runs `work` over `items` with at most `limit` running at once, in order.
async function mapLimited(items, limit, work) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const index = next++; results[index] = await work(items[index]); } };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return results;
}

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
