import { createHash, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "./child-process.mjs";
import { hardenWindowsLaunchDirectory } from "./agent-manager.mjs";

export const TERMINAL_HISTORY_LIMITS = Object.freeze({
  terminalBytes: 2 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  retentionMs: 7 * 24 * 60 * 60 * 1000,
  maxEnded: 128,
});

const RECORD_HEADER = 16;
const MAGIC = 0x4f54;
const VERSION = 1;
const META = 1;
const OUTPUT = 2;
const META_LIMIT = 16 * 1024;
const FLUSH_CHARS = 64 * 1024;
const FLUSH_DELAY_MS = 250;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const SCAN_LIMIT = 4096;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FILE = /^([0-9a-f-]{36})\.(?:meta|(\d{1,15})\.log)$/;
const TEMP = /^[0-9a-f-]{36}\.meta\.[0-9a-f]{16}\.tmp$/;
const UNSAFE_WARNING = "Terminal history is not saved because its storage directory is not private to this user. Terminal output stays in memory only.";
// Principals the hardened launch directory already grants full control.
const SYSTEM = "S-1-5-18";
const ADMINISTRATORS = "S-1-5-32-544";
const CREATOR_OWNER = "S-1-3-0";
const OWNER_RIGHTS = "S-1-3-4";
const WINDOWS_ACL_SCRIPT = `$ErrorActionPreference = 'Stop'
$sid = [Security.Principal.SecurityIdentifier]
$me = [Security.Principal.WindowsIdentity]::GetCurrent()
$dir = $env:OUTRIGHT_HISTORY_DIRECTORY
$items = @(Get-Item -LiteralPath $dir -Force) + @(Get-ChildItem -LiteralPath $dir -Force)
$entries = @(foreach ($item in $items) {
  $acl = Get-Acl -LiteralPath $item.FullName
  [pscustomobject]@{
    name = $item.Name
    owner = $acl.GetOwner($sid).Value
    reparse = [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
    allow = @($acl.GetAccessRules($true, $true, $sid) | Where-Object { $_.AccessControlType -eq 'Allow' } | ForEach-Object { $_.IdentityReference.Value })
  }
})
[pscustomobject]@{ user = $me.User.Value; groups = @($me.Groups | ForEach-Object { $_.Value }); entries = $entries } | ConvertTo-Json -Depth 4 -Compress`;

function checksum(header, payload) {
  return createHash("sha256").update(header).update(payload).digest().subarray(0, 8);
}

// Frame: magic(2) type(1) version(1) length(4) sha256-prefix(8) payload.
export function encodeRecord(type, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  const record = Buffer.allocUnsafe(RECORD_HEADER + body.length);
  record.writeUInt16BE(MAGIC, 0);
  record[2] = type;
  record[3] = VERSION;
  record.writeUInt32BE(body.length, 4);
  checksum(record.subarray(0, 8), body).copy(record, 8);
  body.copy(record, RECORD_HEADER);
  return record;
}

// A crash can tear the final append. Keep every verified record before the
// first frame that is truncated or fails its checksum, and drop the rest.
export function decodeRecords(buffer, maxPayload = TERMINAL_HISTORY_LIMITS.terminalBytes) {
  const records = [];
  let offset = 0;
  while (offset + RECORD_HEADER <= buffer.length) {
    if (buffer.readUInt16BE(offset) !== MAGIC || buffer[offset + 3] !== VERSION) break;
    const length = buffer.readUInt32BE(offset + 4);
    const end = offset + RECORD_HEADER + length;
    if (length > maxPayload || end > buffer.length) break;
    const payload = buffer.subarray(offset + RECORD_HEADER, end);
    if (!checksum(buffer.subarray(offset, offset + 8), payload).equals(buffer.subarray(offset + 8, offset + RECORD_HEADER))) break;
    records.push({ type: buffer[offset + 2], payload });
    offset = end;
  }
  return { records, validBytes: offset, torn: offset !== buffer.length };
}

export function probeWindowsHistoryAcl(directory, run = spawnSync) {
  const result = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_ACL_SCRIPT], {
    encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, OUTRIGHT_HISTORY_DIRECTORY: directory },
  });
  if (result.error || result.status !== 0) throw new Error("Unable to read the terminal history ACL", { cause: result.error });
  return JSON.parse(result.stdout);
}

// The Windows equivalent of an owner-only 0700 directory with 0600 files:
// every item is owned by this user (or the elevated Administrators group the
// user belongs to) and grants access to no principal beyond the hardened set.
export function windowsAclPrivate(report, identity = null) {
  const list = (value) => (Array.isArray(value) ? value : value == null ? [] : [value]);
  const user = identity?.user ?? report?.user;
  const groups = list(identity?.groups ?? report?.groups);
  const entries = list(report?.entries);
  if (typeof user !== "string" || !entries.length) return false;
  const owners = new Set([user, ...(groups.includes(ADMINISTRATORS) ? [ADMINISTRATORS] : [])]);
  const allowed = new Set([user, SYSTEM, ADMINISTRATORS, CREATOR_OWNER, OWNER_RIGHTS]);
  return entries.every((entry) => entry && !entry.reparse && owners.has(entry.owner)
    && list(entry.allow).every((sid) => allowed.has(sid)));
}

function validMeta(meta, id) {
  if (!meta || typeof meta !== "object" || meta.version !== 1 || meta.id !== id) return false;
  if (typeof meta.name !== "string" || meta.name.length > 200 || typeof meta.cwd !== "string" || !meta.cwd
    || typeof meta.createdAt !== "string") return false;
  if (meta.relaunchedFrom !== undefined && !ID.test(meta.relaunchedFrom)) return false;
  if (meta.end === undefined) return true;
  const code = (value) => value === null || Number.isSafeInteger(value);
  return Boolean(meta.end) && code(meta.end.exitCode) && code(meta.end.signal) && Number.isFinite(meta.end.endedAt);
}

function utf8Tail(buffer, bytes) {
  if (buffer.length <= bytes) return buffer;
  let start = buffer.length - bytes;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start);
}

export function openTerminalHistory({ directory, limits = TERMINAL_HISTORY_LIMITS, now = Date.now, platform = process.platform,
  identity = null, probeWindowsAcl = probeWindowsHistoryAcl, hardenWindowsDirectory = hardenWindowsLaunchDirectory } = {}) {
  const entries = new Map();
  const segmentLimit = Math.floor((limits.terminalBytes - META_LIMIT) / 2);
  if (!directory || !path.isAbsolute(directory) || segmentLimit < 4096) throw new Error("Terminal history needs an absolute directory and a cap above 24 KiB");
  let trusted = false;
  let writable = false;
  let closed = false;
  let warning = null;
  let total = 0;
  let flushTimer = null;
  const file = (name) => path.join(directory, name);
  const segmentName = (id, seq) => `${id}.${seq}.log`;
  const entryBytes = (entry) => entry.metaBytes + entry.segments.reduce((sum, segment) => sum + segment.bytes, 0);

  function privateItem(stat, isDirectory) {
    if (stat.isSymbolicLink() || (isDirectory ? !stat.isDirectory() : !stat.isFile())) return false;
    if (platform === "win32") return true;
    const uid = identity?.uid ?? process.getuid();
    return stat.uid === uid && (stat.mode & 0o077) === 0;
  }

  function scanNames() {
    const names = [];
    const handle = opendirSync(directory);
    try {
      let item;
      while (names.length < SCAN_LIMIT && (item = handle.readSync())) names.push(item.name);
    } finally { handle.closeSync(); }
    return names;
  }

  function writeAll(fd, buffer) {
    let offset = 0;
    while (offset < buffer.length) offset += writeSync(fd, buffer, offset, buffer.length - offset);
  }

  function writeMeta(entry) {
    const record = encodeRecord(META, JSON.stringify(entry.meta));
    if (record.length > META_LIMIT) throw new Error("Terminal history metadata exceeds 16 KiB");
    const temp = file(`${entry.id}.meta.${randomBytes(8).toString("hex")}.tmp`);
    const fd = openSync(temp, "wx", 0o600);
    try {
      try { writeAll(fd, record); fsyncSync(fd); }
      finally { closeSync(fd); }
      renameSync(temp, file(`${entry.id}.meta`));
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
    total += record.length - entry.metaBytes;
    entry.metaBytes = record.length;
  }

  function removeSegment(entry, index) {
    const [segment] = entry.segments.splice(index, 1);
    rmSync(file(segmentName(entry.id, segment.seq)), { force: true });
    total -= segment.bytes;
  }

  function openSegment(entry) {
    if (entry.fd !== null) { closeSync(entry.fd); entry.fd = null; }
    const seq = (entry.segments.at(-1)?.seq ?? 0) + 1;
    entry.fd = openSync(file(segmentName(entry.id, seq)), "wx", 0o600);
    entry.segments.push({ seq, bytes: 0 });
    // Two segments bound each history to its cap and drop the oldest output.
    while (entry.segments.length > 2) removeSegment(entry, 0);
  }

  function flush(entry) {
    if (!entry.pending) return;
    const data = entry.pending;
    entry.pending = "";
    if (entry.fd === null) return;
    const record = encodeRecord(OUTPUT, utf8Tail(Buffer.from(data, "utf8"), segmentLimit - RECORD_HEADER));
    if (entry.segments.at(-1).bytes > 0 && entry.segments.at(-1).bytes + record.length > segmentLimit) openSegment(entry);
    writeAll(entry.fd, record);
    entry.segments.at(-1).bytes += record.length;
    total += record.length;
  }

  function closeEntry(entry) {
    if (entry.fd === null) return;
    const fd = entry.fd;
    entry.fd = null;
    closeSync(fd);
  }

  function discard(entry) {
    entries.delete(entry.id);
    entry.pending = "";
    try { closeEntry(entry); } catch { /* The descriptor is gone either way. */ }
    total -= entryBytes(entry);
    // Metadata goes first: an interrupted removal leaves only an orphan
    // segment, which the next load deletes instead of restoring.
    rmSync(file(`${entry.id}.meta`), { force: true });
    for (const segment of entry.segments) rmSync(file(segmentName(entry.id, segment.seq)), { force: true });
  }

  function fail(error) {
    writable = false;
    warning = `Terminal history could not be saved (${error?.code ?? "write failed"}). Terminal output stays in memory only.`;
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    for (const entry of entries.values()) {
      entry.pending = "";
      try { closeEntry(entry); } catch { /* Persistence is already disabled. */ }
    }
  }

  function guarded(operation) {
    if (!writable || closed) return false;
    try { operation(); return true; }
    catch (error) { fail(error); return false; }
  }

  // Oldest ended sessions are evicted first, by count and then by bytes.
  // Only running sessions left over the global cap lose their oldest output.
  function enforce() {
    const ended = [...entries.values()].filter((entry) => entry.endedAt !== null).sort((a, b) => a.endedAt - b.endedAt);
    let excess = ended.length - limits.maxEnded;
    for (const entry of ended) {
      if (excess <= 0 && total <= limits.totalBytes) break;
      discard(entry);
      excess -= 1;
    }
    while (total > limits.totalBytes) {
      let largest = null;
      for (const entry of entries.values()) {
        const output = entry.segments.reduce((sum, segment) => sum + segment.bytes, 0);
        if (output > 0 && (!largest || output > largest.output)) largest = { entry, output };
      }
      if (!largest) break;
      const { entry } = largest;
      if (entry.segments.length > 1) removeSegment(entry, 0);
      else if (entry.fd !== null) { openSegment(entry); removeSegment(entry, 0); }
      else break;
    }
  }

  function sweep() {
    if (!trusted || closed) return;
    const cutoff = now() - limits.retentionMs;
    try {
      for (const entry of [...entries.values()]) if (entry.endedAt !== null && entry.endedAt <= cutoff) discard(entry);
    } catch (error) { fail(error); }
  }

  function loadEntry(id, names) {
    let meta = null;
    let metaBytes = 0;
    if (names.meta) {
      try {
        const buffer = readFileSync(file(`${id}.meta`));
        const { records, torn } = decodeRecords(buffer, META_LIMIT);
        if (records.length === 1 && !torn && records[0].type === META) {
          meta = JSON.parse(records[0].payload.toString("utf8"));
          metaBytes = buffer.length;
        }
      } catch { meta = null; }
    }
    const segments = names.segments.sort((a, b) => a.seq - b.seq);
    if (!validMeta(meta, id)) {
      // Metadata is written before any output, so this is an orphan.
      for (const segment of segments) rmSync(file(segmentName(id, segment.seq)), { force: true });
      if (names.meta) rmSync(file(`${id}.meta`), { force: true });
      return;
    }
    while (segments.length > 2) {
      const [segment] = segments.splice(0, 1);
      rmSync(file(segmentName(id, segment.seq)), { force: true });
    }
    const entry = { id, meta, metaBytes, segments: segments.map(({ seq, bytes }) => ({ seq, bytes })), fd: null, pending: "",
      // A prior run that recorded no exit ended when that run stopped writing.
      endedAt: meta.end?.endedAt ?? Math.max(names.mtimeMs, ...segments.map((segment) => segment.mtimeMs)) };
    entries.set(id, entry);
    total += entryBytes(entry);
  }

  function load() {
    let created = false;
    try { mkdirSync(directory, { mode: 0o700 }); created = true; }
    catch (error) { if (error?.code !== "EEXIST") throw error; }
    // A new directory inherits the hardened launch ACL; restate it privately.
    if (platform === "win32" && created) hardenWindowsDirectory(directory);
    if (!privateItem(lstatSync(directory), true)) return false;
    // Only Outright's own names are trusted or touched in this directory.
    const owned = scanNames().filter((name) => FILE.test(name) || TEMP.test(name));
    const stats = new Map();
    for (const name of owned) {
      const stat = lstatSync(file(name));
      if (!privateItem(stat, false)) return false;
      stats.set(name, stat);
    }
    if (platform === "win32" && !created) {
      let report;
      try { report = probeWindowsAcl(directory); } catch { return false; }
      const items = Array.isArray(report?.entries) ? report.entries : [report?.entries];
      const relevant = items.filter((item, index) => index === 0 || owned.includes(item?.name));
      if (!windowsAclPrivate({ ...report, entries: relevant }, identity)) return false;
    }
    const groups = new Map();
    for (const name of owned) {
      if (TEMP.test(name)) { rmSync(file(name), { force: true }); continue; }
      const match = FILE.exec(name);
      if (!ID.test(match[1])) continue;
      const group = groups.get(match[1]) ?? { meta: false, mtimeMs: 0, segments: [] };
      const stat = stats.get(name);
      if (match[2] === undefined) { group.meta = true; group.mtimeMs = stat.mtimeMs; }
      else group.segments.push({ seq: Number(match[2]), bytes: stat.size, mtimeMs: stat.mtimeMs });
      groups.set(match[1], group);
    }
    for (const [id, group] of groups) loadEntry(id, group);
    return true;
  }

  try {
    trusted = load();
    if (!trusted) warning = UNSAFE_WARNING;
  } catch {
    trusted = false;
    warning = UNSAFE_WARNING;
  }
  writable = trusted;
  if (trusted) {
    sweep();
    guarded(enforce);
  }
  const sweepTimer = trusted ? setInterval(sweep, SWEEP_INTERVAL_MS) : null;
  sweepTimer?.unref?.();

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      guarded(() => { for (const entry of entries.values()) flush(entry); enforce(); });
    }, FLUSH_DELAY_MS);
    flushTimer.unref?.();
  }

  function savedTerminal(entry) {
    const { meta } = entry;
    return { id: entry.id, cwd: meta.cwd, name: meta.name, createdAt: meta.createdAt,
      ...(meta.relaunchedFrom ? { relaunchedFrom: meta.relaunchedFrom } : {}),
      endReason: meta.end ? "exit" : "restart", exitCode: meta.end?.exitCode ?? null, signal: meta.end?.signal ?? null,
      endedAt: entry.endedAt === null ? null : new Date(entry.endedAt).toISOString() };
  }

  return {
    status() { return { persistent: writable && !closed, warning }; },
    has(id) { return entries.has(id); },
    // Saved sessions, newest last. The terminal manager hides live ones.
    saved() {
      // A closed store belongs to a stopped runtime; the next start restores it.
      if (closed) return [];
      sweep();
      return [...entries.values()].sort((a, b) => (a.endedAt ?? Infinity) - (b.endedAt ?? Infinity)).map(savedTerminal);
    },
    begin({ id, name, cwd, createdAt, relaunchedFrom }, initial = "") {
      if (!ID.test(id) || entries.has(id)) return false;
      const entry = { id, meta: { version: 1, id, name, cwd, createdAt, ...(relaunchedFrom ? { relaunchedFrom } : {}) },
        metaBytes: 0, segments: [], fd: null, pending: initial, endedAt: null };
      return guarded(() => {
        entries.set(id, entry);
        try {
          writeMeta(entry);
          openSegment(entry);
          flush(entry);
        } catch (error) {
          try { discard(entry); } catch { /* Persistence is disabled below. */ }
          throw error;
        }
        enforce();
      });
    },
    append(id, data) {
      const entry = entries.get(id);
      if (!writable || closed || entry?.fd == null || typeof data !== "string" || !data) return;
      entry.pending += data;
      if (entry.pending.length >= FLUSH_CHARS) guarded(() => { flush(entry); enforce(); });
      else scheduleFlush();
    },
    end(id, { exitCode = null, signal = null } = {}) {
      const entry = entries.get(id);
      if (!entry) return false;
      const endedAt = now();
      // Memory stays truthful even when the exit cannot be written.
      entry.meta = { ...entry.meta, end: { exitCode: Number.isSafeInteger(exitCode) ? exitCode : null,
        signal: Number.isSafeInteger(signal) ? signal : null, endedAt } };
      entry.endedAt = endedAt;
      return guarded(() => {
        flush(entry);
        closeEntry(entry);
        writeMeta(entry);
        enforce();
      });
    },
    // Runtime shutdown: keep the record. It restores as ended by restart.
    finish(id) {
      const entry = entries.get(id);
      if (!entry) return;
      guarded(() => { flush(entry); closeEntry(entry); });
      entry.endedAt ??= now();
    },
    read(id) {
      const entry = entries.get(id);
      if (!entry || closed) return "";
      guarded(() => flush(entry));
      const chunks = [];
      for (const segment of entry.segments) {
        let buffer;
        try { buffer = readFileSync(file(segmentName(id, segment.seq))); } catch { continue; }
        for (const record of decodeRecords(buffer, segmentLimit).records) if (record.type === OUTPUT) chunks.push(record.payload);
      }
      return Buffer.concat(chunks).toString("utf8");
    },
    remove(id) {
      const entry = entries.get(id);
      if (!entry) return false;
      try { discard(entry); } catch (error) { fail(error); }
      return true;
    },
    sweep,
    usage() { return { totalBytes: total, terminals: entries.size }; },
    close() {
      if (closed) return;
      guarded(() => { for (const entry of entries.values()) flush(entry); });
      closed = true;
      if (flushTimer) clearTimeout(flushTimer);
      if (sweepTimer) clearInterval(sweepTimer);
      for (const entry of entries.values()) {
        try { closeEntry(entry); } catch { /* Shutdown continues. */ }
      }
    },
  };
}
