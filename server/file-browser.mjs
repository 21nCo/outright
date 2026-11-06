import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, readlink, stat, statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";

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
  // Decoded pixels (about 160 MB as RGBA), read from the image's header.
  imagePixels: 40_000_000,
  pdfBytes: 50 * 1024 * 1024,
  // Above a browser's six connections per host, so one preview's images all
  // load; further requests wait their turn, and only a full queue is refused.
  maxRawStreams: 8,
  maxRawQueue: 64,
  // Listed links whose targets are resolved at once; each holds at most two
  // folder descriptors, so a listing's descriptor use stays bounded.
  linkLookups: 8,
  // Recent requests kept as operation records.
  operationRecords: 256,
});

const MARKDOWN = new Set([".md", ".markdown", ".mdown", ".mkd"]);
const IMAGES = Object.freeze({
  ".png": ["image/png", (bytes) => startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  ".jpg": ["image/jpeg", (bytes) => startsWith(bytes, [0xff, 0xd8, 0xff])],
  ".jpeg": ["image/jpeg", (bytes) => startsWith(bytes, [0xff, 0xd8, 0xff])],
  ".gif": ["image/gif", (bytes) => ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a"],
  ".webp": ["image/webp", (bytes) => ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP"],
  ".bmp": ["image/bmp", (bytes) => ascii(bytes, 0, 2) === "BM"],
  ".ico": ["image/x-icon", (bytes) => startsWith(bytes, [0x00, 0x00, 0x01, 0x00])],
  // SVG can carry script. It is only ever shown through <img>, which runs
  // none, and its raw response is sandboxed should it be opened directly.
  ".svg": ["image/svg+xml", isSvg],
});
// The first element of an SVG may follow a long prolog (comments, a DOCTYPE
// with its own declarations), and an image's size may follow long metadata
// (EXIF, ICC profiles), so more of an image is read to find them. Every frame
// of a GIF can widen what it decodes to, so a GIF is read whole.
const SVG_SAMPLE_BYTES = 1024 * 1024;
// A raw response cannot run script, load anything, or be embedded by
// another site, even if it is opened as a top-level page.
const RAW_HEADERS = Object.freeze({
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
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
// A ctime older than this changes on the next write. Linux takes ctimes from
// a clock that moves once a timer tick (up to 10 ms), so a write in the same
// tick as the one before could leave it equal; a newer one is waited out.
const SETTLE_NS = 25_000_000n;
const RAW_CHUNK_BYTES = 64 * 1024;
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
// entries, `hooks.duringProof(step)` between the checks of a proof ("chain"
// once its chain was read, then after each walked name on macOS or after the
// held folder's location on Linux), and `hooks.duringRaw(offset)` after each
// chunk a raw response reads; they exist so tests can replace a path
// component or rewrite a file at exactly those moments.
// `hooks.statfs(path)` stands in for the volume probes (provableVolume), and
// `hooks.onOperation(record)` receives each request's operation record.
// `handlePaths: false` simulates a system where an opened descriptor's
// location cannot be proven (no /proc/self/fd, /.vol or O_NOFOLLOW_ANY).
export function createFileBrowser({ limits = FILE_BROWSER_LIMITS, hooks = {}, handlePaths = true } = {}) {
  // Volume types. The macOS reference ("/") is probed once; a failed probe
  // fails the requests that waited for it, and the next request probes again.
  let rootType;
  const volumeType = (at) => Promise.resolve().then(() => (hooks.statfs ?? statfs)(at)).then((found) => found.type, () => null);
  const probes = { volumeType, referenceType: () => {
    if (process.platform !== "darwin") return null;
    const probe = rootType ??= volumeType("/").then((type) => { if (type === null && rootType === probe) rootType = undefined; return type; });
    return probe;
  } };
  const bind = (root, unavailable = previewUnavailable) => bindRoot(root, hooks, handlePaths, { ...probes, unavailable });
  // One record per request, kept for the last operationRecords requests:
  // which worktree and path, how long, and how it ended. Never contents.
  const operations = [];
  async function track(operation, root, file, operationId, work) {
    const record = { operationId: operationId ?? randomUUID(), operation, root, path: typeof file === "string" ? file.slice(0, 512) : "" };
    const started = performance.now();
    try { return await work(record); }
    catch (error) { record.status = error?.statusCode ?? 500; record.code ??= error?.details?.code ?? (/^E[A-Z\d]+$/.test(error?.code) ? "READ_FAILED" : "INTERNAL"); throw error; }
    finally {
      record.outcome = record.code === "CLIENT_CLOSED" ? "cancelled" : record.code ? "failed" : "ok";
      record.elapsedMs = Math.round(performance.now() - started);
      operations.push(record);
      if (operations.length > limits.operationRecords) operations.shift();
      if (process.env.OUTRIGHT_DEBUG === "1") console.info("[outright:files]", JSON.stringify(record));
      hooks.onOperation?.(record);
    }
  }
  let rawStreams = 0;
  const waiting = [];
  // Raw responses being streamed, and whether shutdown has begun.
  const streaming = new Map();
  let closed = false;

  const list = (root, options = {}) => track("list", root, options.directory ?? "", options.operationId, () => listing(root, options));
  async function listing(root, { directory = "", cursor, limit, showHidden = false }) {
    const relative = relativePath(directory, limits, true);
    const pageSize = pageLimit(limit, limits);
    const after = parseCursor(cursor);
    const binding = await bind(root, listingUnavailable);
    try {
      // Without a root anchor nothing below the root is looked at (OUT-144).
      if (!binding.anchor) throw listingUnavailable();
      const target = relative ? await resolveContained(binding, relative, hooks, "Folder") : null;
      let folder = rootFolder(binding);
      try {
        try {
          if (target && !target.info.isDirectory()) throw fileSystemError({ code: "ENOTDIR" }, relative, "Folder");
          if (target?.name) folder = await openUnder(binding, target.parent, target.name, target.info, relative, { directory: true }, hooks);
        } finally { await target?.close(); }
        return await listOpened(binding, relative, folder, { pageSize, after, showHidden });
      } finally { await folder.handle?.close(); }
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

  const preview = (root, file, { operationId } = {}) => track("preview", root, file, operationId, () => previewing(root, file));
  async function previewing(root, file) {
    const relative = relativePath(file, limits, false);
    const binding = await bind(root);
    try {
      const opened = await openFile(binding, relative, hooks);
      try {
        const kind = await classify(relative, opened, limits, true);
        // The bytes were read through a folder that may have moved since the
        // open, and are of the version described only if no write came since.
        await opened.prove();
        await opened.unchanged();
        return describe(relative, opened, kind);
      } finally { await opened.close(); }
    } finally { await binding.close(); }
  }

  const raw = (root, file, version, request, response, { operationId } = {}) => track("raw", root, file, operationId, (record) => serve(root, file, version, request, response, record));
  async function serve(root, file, version, request, response, record) {
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
      const binding = await bind(root);
      let kind;
      try {
        opened = await openFile(binding, relative, hooks);
        kind = await classify(relative, opened, limits, false);
        // Proved once more before the headers. The stream that follows reads
        // the same opened file, and sends its end only if it is still unchanged.
        await opened.prove();
        await opened.unchanged();
      } finally {
        try { await opened?.release(); }
        finally { await binding.close(); }
      }
      if (kind.previewType === "oversized") throw fileError(413, "The file is over its preview limit", "OVERSIZED");
      if (kind.previewType !== "image" && kind.previewType !== "pdf") {
        throw fileError(415, "Only verified image and PDF previews are served as files", "NOT_RAW_PREVIEW");
      }
      if (version && version !== opened.info.version) throw fileError(409, "The file changed after it was previewed", "FILE_CHANGED");
      response.statusCode = 200;
      for (const [name, value] of Object.entries(RAW_HEADERS)) response.setHeader(name, value);
      response.setHeader("Content-Type", kind.mimeType);
      response.setHeader("Content-Length", String(opened.info.size));
      // Headers are sent; a failure now can only end the response, short.
      // A read or write error is the stream's, an end by shutdown is shutdown's;
      // only a response that closed without either was the client's.
      try { await pipeline(rawBody(opened, hooks), response); record.bytes = opened.info.size; }
      catch (error) {
        record.code = error?.details?.code ?? (closed ? "SHUTTING_DOWN" : error?.code === "ERR_STREAM_PREMATURE_CLOSE" ? "CLIENT_CLOSED" : "STREAM_FAILED");
        if (!response.destroyed) response.destroy(error);
      }
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

  // Records a request refused before it reached the browser, then rethrows its error.
  const refuse = (operation, root, file, operationId, error) => track(operation, root, file, operationId, () => { throw error; });
  return { list, preview, raw, refuse, shutdown, operations: () => [...operations], rawStats: () => ({ active: rawStreams, waiting: waiting.length }) };
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
  const image = IMAGES[extension];
  const sample = await readBytes(handle, Math.min(info.size, image ? Math.max(limits.sampleBytes, SVG_SAMPLE_BYTES) : limits.sampleBytes));
  if (image) {
    const format = extension.slice(1).toUpperCase();
    if (!image[1](sample)) return { previewType: "unsupported", reason: `The contents are not a ${format} image` };
    if (info.size > limits.imageBytes) return { previewType: "oversized", limit: limits.imageBytes };
    // An SVG is drawn at the size it is shown, but a raster it embeds decodes
    // at its own. Only a data: URL can bring one (an SVG image loads nothing,
    // a raw SVG only bounded same-origin files), so an SVG must be read whole
    // with nothing that could spell one (URLs drop tabs and newlines).
    if (extension === ".svg") {
      if (sample.length < info.size) return { previewType: "oversized", limit: sample.length };
      if (/[Dd][Aa][Tt][Aa]:|&(?!(?:amp|lt|gt|quot|apos);)|\\|[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(sample.toString("latin1").replace(/[\t\n\r]/g, ""))) return { previewType: "unsupported", reason: "This SVG may embed an image whose size cannot be checked" };
      return { previewType: "image", mimeType: image[0] };
    }
    const [width, height] = (extension === ".gif" ? await gifSize(handle, info.size, sample) : imageSize(extension, sample)) ?? [];
    if (!(width > 0 && height > 0)) return { previewType: "unsupported", reason: `This ${format} image's size cannot be read` };
    if (width * height > limits.imagePixels) return { previewType: "oversized", width, height, pixelLimit: limits.imagePixels, reason: `The image is ${width} × ${height} pixels, over the preview limit of ${limits.imagePixels} pixels` };
    return { previewType: "image", mimeType: image[0], width, height };
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
      ({ handle } = await openUnder(binding, target.parent, target.name, info, relative, { directory: false }, hooks));
      facts = await settledStat(handle);
    }
    const release = () => target.close();
    const version = fileVersion(facts);
    return {
      handle, info: fileFacts(facts), link, release,
      prove: () => proveHeld(binding, target.parent),
      // Any write since the settled status gave the file a new version.
      unchanged: async () => { if (handle && fileVersion(await handle.stat({ bigint: true })) !== version) throw fileChanged(); },
      close: async () => { try { await handle?.close(); } finally { await release(); } },
    };
  } catch (error) {
    // A file opened before a later check failed is closed with its folder.
    try { await handle?.close(); } finally { await target.close(); }
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
        try { destination = utf8(await readlink(at, { encoding: "buffer" })); }
        catch (error) { failure = ["ENOENT", "EINVAL"].includes(error?.code) ? pathChanged() : fileSystemError(error, relative, noun); }
        if (destination === null) failure = fileError(403, `${relative} is a link whose destination is not UTF-8`, "UNREADABLE");
      }
      if (failure) throw failure;
      if (step.expect && !sameObject(info, step.expect)) throw pathChanged();
      // A folder on another volume (one mounted inside the worktree) must be provable too.
      // So must a file (a file bind mount), whose version is its ctime.
      if (info.dev !== binding.identity.dev && !(await provableVolume(binding, info, at))) throw binding.unavailable();
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

// A file's status once its ctime is older than SETTLE_NS, so that any write
// after it gives the file a new version (see proveHeld); a file written too
// often to settle is FILE_CHANGED, one with a whole-second ctime unavailable.
async function settledStat(handle) {
  for (let waits = 0; ; waits += 1) {
    const started = nowNs();
    const info = await handle.stat({ bigint: true });
    if (wholeSecond(info.ctimeNs)) throw previewUnavailable();
    if (info.ctimeNs <= started - SETTLE_NS) return info;
    if (waits >= PROOF_ATTEMPTS) throw fileChanged();
    await sleep(Number(SETTLE_NS / 1_000_000n));
  }
}

// A raw body is the version that was checked: it is read in chunks, and each
// chunk is sent only if the file still has that version after it was read,
// so no byte of another version is sent, and a body a write changed or cut
// short ends before the change instead of completing.
async function* rawBody({ handle, info, unchanged }, hooks) {
  for (let offset = 0; offset < info.size;) {
    const length = Math.min(RAW_CHUNK_BYTES, info.size - offset);
    const { bytesRead, buffer } = await handle.read(Buffer.allocUnsafe(length), 0, length, offset);
    if (!bytesRead) throw fileChanged();
    offset += bytesRead;
    await hooks.duringRaw?.(offset);
    await unchanged();
    yield buffer.subarray(0, bytesRead);
  }
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
async function bindRoot(root, hooks, handlePaths, probes) {
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
      const location = await readlink(procPath, { encoding: "buffer" }).catch(() => null);
      if (location !== null && !location.equals(Buffer.from(root))) throw pathChanged();
      if (location !== null) anchor = procPath;
    } else {
      const volumePath = `/.vol/${info.dev}/${info.ino}`;
      if (await stat(volumePath, { bigint: true }).then((found) => sameObject(found, info), () => false)) anchor = volumePath;
    }
    const binding = { root, anchor, handle, identity: info, hooks, ...probes, volumes: new Map(), close: () => handle.close() };
    if (!anchor || !(await provableVolume(binding, info, anchor))) { await handle.close(); return unbound; }
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
// Those checks are made one after another, so they are bracketed: the root
// and every folder walked to the held one are read before and after them,
// each by identity (never by a path of names), and must be the folders
// walked, with the same ctimes. Renaming a folder changes its ctime and that
// of the folders it leaves and enters, and so does adding or removing a name
// in a folder (utimes cannot set a ctime back), so equal brackets mean the
// checks saw one unchanging chain, not pieces of different ones. That holds
// only on a volume with nanosecond ctimes (provableVolume), and only for
// ctimes older than SETTLE_NS, so a newer one is waited out first. A folder
// written to during the proof is proved again, at most PROOF_ATTEMPTS times
// in all (and waited for at most as often). Anything else is PATH_CHANGED at
// once. A folder moved out and back before this call is inside again, and
// is not told apart.
async function proveHeld(binding, held) {
  const { hooks } = binding;
  for (let attempt = 1, waits = 0; ;) {
    const started = nowNs();
    const before = await chainTimes(binding, held);
    if (before.some((time) => time > started - SETTLE_NS)) {
      if (++waits > PROOF_ATTEMPTS) throw pathChanged();
      await sleep(Number(SETTLE_NS / 1_000_000n));
      continue;
    }
    await hooks.duringProof?.("chain");
    if (process.platform === "linux") {
      // One kernel snapshot of where the held folder is; inside the bracket,
      // its chain is the root's, so this also names where the root was.
      const location = await readlink(held.readPath, { encoding: "buffer" }).catch(() => null);
      await hooks.duringProof?.("readlink");
      if (!location?.equals(Buffer.from(path.join(binding.root, ...held.canonical)))) throw pathChanged();
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
    if (++attempt > PROOF_ATTEMPTS) throw pathChanged();
  }
}

// The ctimes of the root and of each folder walked to the held one, each
// required to be the folder walked, and to have a fraction of a second (an
// old inode may not). macOS reads each by identity (/.vol). Linux goes down
// from the root's descriptor: each folder is opened by its one walked name
// inside the descriptor of the one above it, never following a link, so no
// link or name above it can redirect the lookup, and a folder no longer at
// its walked place is PATH_CHANGED here too. Only folders the walk passed
// through are searched, and one descriptor more is held.
async function chainTimes(binding, held) {
  let infos;
  if (process.platform !== "linux") {
    infos = await Promise.all(held.chain.map((walked) => stat(`/.vol/${walked.dev}/${walked.ino}`, { bigint: true }).catch(() => null)));
  } else {
    infos = [await stat(binding.anchor, { bigint: true }).catch(() => null)];
    let above = null;
    try {
      for (let depth = 1, at = binding.anchor; depth < held.chain.length && infos[depth - 1] && sameObject(infos[depth - 1], held.chain[depth - 1]); depth += 1) {
        const previous = above;
        above = await open(`${at}/${held.canonical[depth - 1]}`, openFlags(true, true)).catch(() => null);
        await previous?.close();
        if (!above) break;
        at = `/proc/self/fd/${above.fd}`;
        infos[depth] = await above.stat({ bigint: true }).catch(() => null);
      }
    } finally { await above?.close(); }
  }
  if (held.chain.some((walked, depth) => !infos[depth] || !sameObject(infos[depth], walked))) throw pathChanged();
  if (infos.some((info) => wholeSecond(info.ctimeNs))) throw binding.unavailable();
  return infos.map((info) => info.ctimeNs);
}

// A proof compares ctimes, so a folder is provable only on a volume that
// keeps them to the nanosecond from this machine's clock: on macOS, APFS,
// the type of "/" (where every macOS 11+ starts); on Linux, ext4, XFS,
// Btrfs, tmpfs, overlay, F2FS, ZFS or bcachefs, and only when the folder's
// own ctime has a fraction of a second (ext2, ext3 and ext4 with small
// inodes keep whole seconds). Nothing is read through a folder on any other
// volume (HFS+, FAT, exFAT, SMB, NFS, FUSE), as on a host without a root
// handle (OUT-144). Checked once per volume and request.
const LINUX_NANOSECOND_TYPES = new Set([0xef53, 0x58465342, 0x9123683e, 0x01021994, 0x794c7630, 0xf2f52010, 0x2fc12fc1, 0xca451a4e]);
export function nanosecondVolume(type, ctimeNs, reference, platform = process.platform) {
  if (type === null || wholeSecond(ctimeNs)) return false;
  if (platform === "darwin") return reference !== null && type === reference;
  return platform === "linux" && LINUX_NANOSECOND_TYPES.has(Number(type) >>> 0);
}
function wholeSecond(ctimeNs) { return ctimeNs % 1_000_000_000n === 0n; }
async function provableVolume(binding, info, at) {
  if (!binding.volumes.has(info.dev)) {
    const [type, reference] = await Promise.all([binding.volumeType(process.platform === "darwin" ? `/.vol/${info.dev}/${info.ino}` : at), binding.referenceType()]);
    binding.volumes.set(info.dev, nanosecondVolume(type, info.ctimeNs, reference));
  }
  return binding.volumes.get(info.dev);
}

// The root's path must still name the root handle's directory. On macOS it is
// opened with O_NOFOLLOW_ANY, so an ancestor moved and replaced by a link fails.
async function requireRoot(binding) {
  const handle = await open(binding.root, openFlags(true, true)).catch(() => null);
  const named = await handle?.stat({ bigint: true }).finally(() => handle.close()).catch(() => null);
  if (!named || !sameObject(named, binding.identity)) throw pathChanged();
}

function sameObject(left, right) { return left.ino === right.ino && left.dev === right.dev; }

function listingUnavailable() { return fileError(501, "Folder listing is unavailable on this file system, because a folder cannot be read through the handle Outright checked", "LISTING_UNAVAILABLE"); }
function previewUnavailable() { return fileError(501, "Previews are unavailable on this file system, because Outright cannot prove where an opened file is", "PREVIEW_UNAVAILABLE"); }
function pathChanged() { return fileError(409, "The path changed while it was being opened; retry", "PATH_CHANGED"); }
function fileChanged() { return fileError(409, "The file changed while it was being read; retry", "FILE_CHANGED"); }
function nowNs() { return BigInt(Date.now()) * 1_000_000n; }

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

async function readBytes(handle, length, position = 0) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

function fileVersion(info) { return [info.size, info.mtimeNs, info.ctimeNs, info.ino, info.dev].map((value) => value.toString(36)).join("-"); }
// Link bytes as text, or null when they are not UTF-8: decoding them would
// name another file (each invalid byte becomes U+FFFD).
function utf8(bytes) { const text = bytes.toString("utf8"); return Buffer.from(text, "utf8").equals(bytes) ? text : null; }
// The pixel size an image decodes to, read from the headers a decoder sizes
// its buffers by; null when they are not there. The decoder's canvas counts:
// any GIF frame widens it, an ICO entry may be the largest, and a BMP inside
// an ICO counts at full height. A decoder refuses a WebP or APNG frame outside
// the canvas its header declares, and a second JPEG frame header, before
// decoding them. AVIF is not served: its decoder allocates by the AV1 frame
// size, which only its coded payload states.
function imageSize(extension, b) {
  if (extension === ".png") return b.length >= 24 && ascii(b, 12, 16) === "IHDR" ? [b.readUInt32BE(16), b.readUInt32BE(20)] : null;
  if (extension === ".bmp") return bmpSize(b, 14);
  if (extension === ".webp") return webpSize(b);
  if (extension === ".ico") return icoSize(b);
  return jpegSize(b);
}
function larger(left, right) { return !left || (right && right[0] * right[1] > left[0] * left[1]) ? right : left; }
function bmpSize(b, at) {
  if (b.length < at + 12) return null;
  return b.readUInt32LE(at) === 12 ? [b.readUInt16LE(at + 4), b.readUInt16LE(at + 6)] : [Math.abs(b.readInt32LE(at + 4)), Math.abs(b.readInt32LE(at + 8))];
}
// Every block to the trailer, read past the sample 64 KB at a time; each frame
// widens the canvas. No decoder may read a block differently, so only a 4-byte
// graphic control, 3-byte loop and 5-byte buffering NETSCAPE2.0/ANIMEXTS1.0
// sub-blocks, a 12-byte plain text header and code sizes 2 to 8 are accepted.
async function gifSize(handle, size, sample) {
  let [base, window] = [0, sample];
  const bytes = async (at, length) => {
    if (at < base || at + length > base + window.length) [base, window] = [at, await readBytes(handle, Math.max(0, Math.min(65_536, size - at)), at)];
    return window.length >= at - base + length ? window.subarray(at - base, at - base + length) : null;
  };
  // Past the sub-blocks at `at` and their terminator, or -1.
  const subBlocks = async (at, animation) => {
    for (let block; (block = await bytes(at, 2)); at += block[0] + 1) {
      if (!block[0]) return at + 1;
      if (animation && !(block[0] === 3 && block[1] === 1) && !(block[0] === 5 && block[1] === 2)) return -1;
    }
    return -1;
  };
  const table = (flags) => (flags & 0x80 ? 3 * 2 ** ((flags & 7) + 1) : 0);
  const screen = await bytes(0, 13);
  let canvas = screen && [screen.readUInt16LE(6), screen.readUInt16LE(8)];
  for (let at = screen ? 13 + table(screen[10]) : -1; at >= 0;) {
    const block = await bytes(at, 3) ?? await bytes(at, 1);
    if (block?.[0] === 0x3b) return canvas;
    const frame = block?.[0] === 0x2c && await bytes(at, 10);
    if (frame) {
      canvas = [Math.max(canvas[0], frame.readUInt16LE(1) + frame.readUInt16LE(5)), Math.max(canvas[1], frame.readUInt16LE(3) + frame.readUInt16LE(7))];
      at += 10 + table(frame[9]);
      const code = (await bytes(at, 1))?.[0];
      at = code >= 2 && code <= 8 ? await subBlocks(at + 1) : -1;
    } else if (block?.[0] !== 0x21 || block.length < 3) return null;
    else if (block[1] === 0xf9) at = block[2] === 4 && (await bytes(at + 7, 1))?.[0] === 0 ? at + 8 : -1;
    else if (block[1] === 0xff && block[2] === 11) at = await subBlocks(at + 14, ["NETSCAPE2.0", "ANIMEXTS1.0"].includes((await bytes(at + 3, 11))?.toString("latin1")));
    else if (block[1] === 0x01 && block[2] === 12) at = await subBlocks(at + 15);
    else at = block[1] === 0xfe ? await subBlocks(at + 2) : -1;
  }
  return null;
}
function webpSize(b) {
  if (b.length < 30) return null;
  const chunk = ascii(b, 12, 16);
  if (chunk === "VP8 ") return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
  if (chunk === "VP8L") return [1 + (b.readUInt32LE(21) & 0x3fff), 1 + ((b.readUInt32LE(21) >>> 14) & 0x3fff)];
  return chunk === "VP8X" ? [1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)] : null;
}
function jpegSize(b) {
  for (let at = 2; at + 9 <= b.length;) {
    const marker = b[at + 1];
    if (b[at] !== 0xff || marker === 0xd9 || marker === 0xda) return null;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return [b.readUInt16BE(at + 7), b.readUInt16BE(at + 5)];
    if (marker === 0xff) at += 1;
    else at += marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) ? 2 : 2 + b.readUInt16BE(at + 2);
  }
  return null;
}
function icoSize(b) {
  let largest = null;
  for (let entry = 6; entry < 6 + 16 * (b.length >= 6 ? b.readUInt16LE(4) : 0); entry += 16) {
    if (b.length < entry + 16) return null;
    const image = b.subarray(b.readUInt32LE(entry + 12));
    const size = IMAGES[".png"][1](image) ? imageSize(".png", image) : bmpSize(image, 0);
    if (!size) return null;
    largest = larger(largest, size);
  }
  return largest;
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
