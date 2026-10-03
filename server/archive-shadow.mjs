import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

// The runtime lease is held by the caller for every transition. The source
// database is closed only for the final rename. Large SQLite work happens in
// the disposable shadow while the source remains available.
export function archiveShadowPaths(filename) {
  return { next: `${filename}.archive-next`, old: `${filename}.archive-old`, state: `${filename}.archive-state` };
}

function fileInfo(filename) {
  try { return lstatSync(filename); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function privateRegularFile(filename) {
  const info = fileInfo(filename);
  if (!info) { return false; }
  if (!info.isFile() || info.nlink !== 1) { throw new Error(`Unsafe archive maintenance file: ${filename}`); }
  return true;
}

function durableFile(filename) {
  // FlushFileBuffers requires a write-capable handle on Windows.
  const fd = openSync(filename, "r+");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function durableDirectory(filename) {
  if (process.platform === "win32") return;
  const fd = openSync(path.dirname(filename), "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function beginArchiveShadow(filename) {
  const state = `${filename}.archive-state`;
  const temporary = `${state}.tmp`;
  if (fileInfo(state) || fileInfo(archiveShadowPaths(filename).next)
    || fileInfo(archiveShadowPaths(filename).old)) throw new Error("Archive maintenance state already exists");
  if (privateRegularFile(temporary)) rmSync(temporary);
  writeFileSync(temporary, JSON.stringify({ version: 2, source: filename }), { mode: 0o600, flag: "wx" });
  durableFile(temporary);
  renameSync(temporary, state);
  durableFile(state);
  durableDirectory(state);
}

function candidateIdentity(filename, hash = false) {
  if (!privateRegularFile(filename)) return null;
  const fd = openSync(filename, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  try {
    const info = fstatSync(fd, { bigint: true });
    const identity = [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String);
    if (!hash) return { identity };
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes;
    while ((bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, bytes));
    const after = fstatSync(fd, { bigint: true });
    const currentPath = statSync(filename, { bigint: true });
    if ([after, currentPath].some((item) => identity.some((value, index) => value !== [item.dev, item.ino, item.size, item.mtimeNs, item.ctimeNs][index].toString()))) {
      throw new Error("Archive candidate changed during validation");
    }
    return { identity, digest: digest.digest("hex") };
  } finally { closeSync(fd); }
}

function sourceSnapshot(filename) {
  const info = statSync(filename, { bigint: true });
  const fd = openSync(filename, "r");
  const header = Buffer.alloc(100);
  try {
    if (readSync(fd, header, 0, header.length, 0) !== header.length) {
      throw new Error("Archive source has an incomplete SQLite header");
    }
  } finally { closeSync(fd); }
  // A rename can change ctime, but a SQLite commit changes the header change
  // counter (or the file's mtime/size). This is a conflict detector, not a
  // substitute for the candidate's full digest and integrity check.
  return { dev: String(info.dev), ino: String(info.ino), size: String(info.size),
    mtimeNs: String(info.mtimeNs), header: header.toString("hex") };
}

function sourceMatchesSnapshot(filename, snapshot) {
  if (!snapshot) return true; // Older maintenance markers did not pin source state.
  const current = sourceSnapshot(filename);
  return Object.keys(current).every((key) => current[key] === snapshot[key]);
}

function writeArchiveMarker(state, marker) {
  const temporary = `${state}.tmp`;
  writeFileSync(temporary, JSON.stringify(marker), { mode: 0o600, flag: "wx" });
  durableFile(temporary);
  renameSync(temporary, state);
  durableDirectory(state);
}

function matchesCandidate(filename, candidate, hash = false, renamed = false) {
  if (!candidate) return false;
  const current = candidateIdentity(filename, hash);
  const identityLength = renamed ? 4 : 5; // rename can change ctime without changing file contents.
  return current && JSON.stringify(current.identity.slice(0, identityLength)) === JSON.stringify(candidate.identity.slice(0, identityLength))
    && (!hash || current.digest === candidate.digest);
}

function authenticatedCandidate(filename, marker, renamed = false) {
  // Preparation verified SQLite before recording the digest. Matching that
  // digest also detects corruption, so recovery need not run a second full
  // SQLite integrity scan on the same bytes during startup.
  return marker.version === 2 && !hasNonemptyWal(filename)
    && matchesCandidate(filename, marker.candidate, true, renamed);
}

function validDatabase(filename) {
  if (!privateRegularFile(filename)) return false;
  // SQLite treats an empty file as a valid empty database. A reserved but
  // unfilled candidate must never outrank the recoverable original.
  if (statSync(filename).size < 512) return false;
  const fd = openSync(filename, "r");
  const header = Buffer.alloc(16);
  try { if (readSync(fd, header, 0, header.length, 0) !== header.length
    || !header.equals(Buffer.from("SQLite format 3\0"))) return false; }
  finally { closeSync(fd); }
  let db;
  try {
    db = new Database(filename, { readonly: true, fileMustExist: true });
    return db.pragma("integrity_check")[0]?.integrity_check === "ok";
  } catch (error) {
    if (["SQLITE_NOTADB", "SQLITE_CORRUPT"].includes(error.code)) return false;
    throw error;
  } finally { db?.close(); }
}

function hasNonemptyWal(filename) {
  return privateRegularFile(`${filename}-wal`) && statSync(`${filename}-wal`).size > 0;
}

function removeCheckpointedSidecars(filename) {
  if (hasNonemptyWal(filename)) throw new Error(`Uncheckpointed archive database WAL: ${filename}`);
  for (const suffix of ["-wal", "-shm"]) {
    if (privateRegularFile(`${filename}${suffix}`)) { rmSync(`${filename}${suffix}`); }
  }
}

function discardShadowCandidate(filename) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (privateRegularFile(`${filename}${suffix}`)) { rmSync(`${filename}${suffix}`); }
  }
}

// A closed SQLite handle is required for a Windows rename. Keep the source
// write-protected across that close with durable triggers, so a direct SQLite
// connection cannot commit into the old file between comparison and rename.
// Fence both the source and the candidate before either can occupy the live
// pathname. Recovery removes the surviving fence only after choosing it.
export function fenceArchiveSource(db) {
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
    AND name NOT LIKE 'sqlite_%' AND name != 'archive_cutover_guard'`).all().map((row) => row.name);
  db.exec("CREATE TABLE archive_cutover_guard (active INTEGER PRIMARY KEY CHECK(active = 1))");
  for (const table of tables) {
    const quoted = `"${table.replaceAll('"', '""')}"`;
    for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
      const name = `archive_cutover_${operation.toLowerCase()}_${table}`.replaceAll('"', '""');
      db.exec(`CREATE TRIGGER "${name}" BEFORE ${operation} ON ${quoted}
        WHEN EXISTS (SELECT 1 FROM archive_cutover_guard)
        BEGIN SELECT RAISE(ABORT, 'Archive cutover is in progress'); END`);
    }
  }
  db.exec("INSERT INTO archive_cutover_guard (active) VALUES (1)");
  for (const operation of ["UPDATE", "DELETE"]) {
    db.exec(`CREATE TRIGGER archive_cutover_guard_${operation.toLowerCase()} BEFORE ${operation}
      ON archive_cutover_guard BEGIN SELECT RAISE(ABORT, 'Archive cutover is in progress'); END`);
  }
}

function releaseArchiveSourceFence(filename) {
  const db = new Database(filename);
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'archive_cutover_guard'").get()) return;
    db.transaction(() => {
      for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name GLOB 'archive_cutover_*'").all()) {
        db.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`);
      }
      db.exec("DROP TABLE archive_cutover_guard");
    }).immediate();
  } finally { db.close(); }
}

function markerOwnsDatabase(marker, filename) {
  if (![1, 2].includes(marker?.version) || typeof marker.source !== "string" || !path.isAbsolute(marker.source)) return false;
  if (marker.source === filename) return true;
  if (path.basename(marker.source) !== path.basename(filename)) return false;
  // Older runtimes wrote a lexical parent path into the marker. A restart
  // through its canonical parent still owns the same maintenance files.
  try { return realpathSync(path.dirname(marker.source)) === path.dirname(filename); }
  catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function recoverMissingSource(filename, next, old, marker) {
  // Legacy version-1 markers did not pin a candidate. Roll those back to
  // the original rather than trusting a database that could be substituted.
  let candidateVerified = authenticatedCandidate(next, marker);
  if (candidateVerified) {
    renameSync(next, filename);
    durableDirectory(filename);
    // Authentication covered the old pathname. Do not release the only
    // fallback until the promoted pathname still names those same bytes.
    if (!matchesCandidate(filename, marker.candidate, false, true) || hasNonemptyWal(filename)) {
      renameSync(filename, next);
      durableDirectory(filename);
      candidateVerified = false;
    }
  }
  if (!candidateVerified) {
    // Keep the marker and both names intact if the only fallback is
    // corrupt. Renaming first would erase the evidence of that failure.
    if (!validDatabase(old)) throw new Error("Neither archive maintenance database is valid");
    renameSync(old, filename);
  }
  durableDirectory(filename);
  return candidateVerified;
}

function recoverInterruptedCutover(filename, next, old, marker) {
  let candidateVerified = !fileInfo(filename) && recoverMissingSource(filename, next, old, marker);
  if (fileInfo(old) && !candidateVerified) {
    candidateVerified = authenticatedCandidate(filename, marker, true);
    if (!candidateVerified) {
      if (!validDatabase(old)) throw new Error("Neither archive maintenance database is valid");
      rmSync(filename);
      durableDirectory(filename);
      renameSync(old, filename);
      durableDirectory(filename);
    }
  }
  durableFile(filename);
  durableDirectory(filename);
  if (candidateVerified && !matchesCandidate(filename, marker.candidate, false, true)) {
    if (!validDatabase(old)) throw new Error("Neither archive maintenance database is valid");
    renameSync(filename, next);
    durableDirectory(filename);
    renameSync(old, filename);
    durableDirectory(filename);
  }
  if (privateRegularFile(old)) { rmSync(old); durableDirectory(filename); }
}

function lockArchiveDatabase(filename) {
  const db = new Database(filename);
  try {
    db.pragma("busy_timeout = 250");
    db.pragma("locking_mode = EXCLUSIVE");
    db.exec("BEGIN EXCLUSIVE; COMMIT;");
    return db;
  } catch (error) { db.close(); throw error; }
}

function finishLinkedCandidate(filename, next, old, marker) {
  const publicInfo = fileInfo(filename);
  const nextInfo = fileInfo(next);
  if (!publicInfo || !nextInfo || !fileInfo(old)) return;
  if (publicInfo.dev !== nextInfo.dev || publicInfo.ino !== nextInfo.ino || publicInfo.nlink !== 2
    || nextInfo.nlink !== 2 || !publicInfo.isFile() || !nextInfo.isFile()
    || String(publicInfo.dev) !== marker.candidate?.identity?.[0]
    || String(publicInfo.ino) !== marker.candidate?.identity?.[1]) return;
  // A crash between exclusive link creation and unlink leaves two names for
  // the same candidate inode. Lock it before dropping the redundant private
  // name; the public name and every committed byte remain available.
  const db = lockArchiveDatabase(filename);
  try { rmSync(next); durableDirectory(filename); }
  finally { db.close(); }
}

function finishLinkedSource(filename, next, old, marker) {
  const publicInfo = fileInfo(filename);
  const oldInfo = fileInfo(old);
  if (!publicInfo || !oldInfo || publicInfo.dev !== oldInfo.dev || publicInfo.ino !== oldInfo.ino
    || publicInfo.nlink !== 2 || oldInfo.nlink !== 2 || !publicInfo.isFile() || !oldInfo.isFile()
    || String(publicInfo.dev) !== marker.sourceSnapshot?.dev
    || String(publicInfo.ino) !== marker.sourceSnapshot?.ino) return;
  let sourceDb;
  let candidateDb;
  try {
    sourceDb = lockArchiveDatabase(filename);
    if (fileInfo(next)) {
      candidateDb = lockArchiveDatabase(next);
      if (!authenticatedCandidate(next, marker)) {
        throw new Error("Archive candidate changed after source restoration; preserve both databases");
      }
    }
    if (hasNonemptyWal(old)) {
      const checkpoint = sourceDb.pragma("wal_checkpoint(TRUNCATE)")[0];
      if (checkpoint?.busy || sourceDb.pragma("journal_mode = DELETE", { simple: true }).toLowerCase() !== "delete") {
        throw new Error("Restored archive source WAL could not be checkpointed");
      }
      removeCheckpointedSidecars(old);
    }
    discardShadowCandidate(next);
    rmSync(old);
    durableDirectory(filename);
  } finally {
    candidateDb?.close();
    sourceDb?.close();
  }
}

function recoverPinnedInterruptedCutover(filename, next, old, marker) {
  // Once a crashed process releases SQLite's locks, a direct sibling may
  // write either inode. Lock both before deciding, and keep those locks until
  // the rejected inode is removed. A snapshot-only check has a second race.
  const candidatePath = fileInfo(filename) ? filename : next;
  let oldDb;
  let candidateDb;
  try {
    oldDb = lockArchiveDatabase(old);
    if (fileInfo(candidatePath)) candidateDb = lockArchiveDatabase(candidatePath);
    const sourceHadWal = hasNonemptyWal(old);
    if (sourceHadWal) {
      const checkpoint = oldDb.pragma("wal_checkpoint(TRUNCATE)")[0];
      if (checkpoint?.busy || oldDb.pragma("journal_mode = DELETE", { simple: true }).toLowerCase() !== "delete") {
        throw new Error("Changed archive source WAL could not be checkpointed");
      }
      removeCheckpointedSidecars(old);
    }
    const sourceChanged = sourceHadWal || !sourceMatchesSnapshot(old, marker.sourceSnapshot);
    const candidateMatches = candidateDb && authenticatedCandidate(candidatePath, marker, candidatePath === filename);
    if (candidateDb && !candidateMatches) {
      throw new Error("Promoted archive database changed after interruption; preserve both databases");
    }
    if (sourceChanged || !candidateDb) {
      if (oldDb.pragma("integrity_check")[0]?.integrity_check !== "ok") {
        throw new Error("Changed archive source failed integrity validation");
      }
      if (candidatePath === filename && fileInfo(filename)) {
        linkSync(filename, next);
        durableDirectory(filename);
        rmSync(filename);
        durableDirectory(filename);
      }
      linkSync(old, filename);
      durableDirectory(filename);
      durableFile(filename);
      discardShadowCandidate(next);
      rmSync(old);
      durableDirectory(filename);
      return;
    }
    if (candidatePath === next) {
      linkSync(next, filename);
      durableDirectory(filename);
      rmSync(next);
      durableDirectory(filename);
      if (!matchesCandidate(filename, marker.candidate, false, true)) {
        throw new Error("Archive candidate changed during recovery promotion");
      }
    }
    durableFile(filename);
    durableDirectory(filename);
    rmSync(old);
    durableDirectory(filename);
  } finally {
    candidateDb?.close();
    oldDb?.close();
  }
}

export function recoverArchiveShadow(filename, { sourceUnmoved = false } = {}) {
  const { next, old, state } = archiveShadowPaths(filename);
  const temporary = `${state}.tmp`;
  if (privateRegularFile(temporary)) rmSync(temporary);
  if (!privateRegularFile(state)) {
    if (fileInfo(next) || fileInfo(old)) throw new Error("Unowned archive maintenance files require inspection");
    return;
  }
  const marker = JSON.parse(readFileSync(state, "utf8"));
  if (!markerOwnsDatabase(marker, filename)) throw new Error("Archive maintenance marker does not match the database");
  if (marker.sourceSnapshot) finishLinkedSource(filename, next, old, marker);
  if (marker.sourceSnapshot && fileInfo(old)) finishLinkedCandidate(filename, next, old, marker);
  privateRegularFile(next);
  privateRegularFile(old);
  // An expected live conflict is reported only before either rename. The
  // runtime still has its original connection, so discarding this candidate
  // does not need a whole-database integrity scan on every normal deferral.
  if (sourceUnmoved && !fileInfo(old)) {
    if (!privateRegularFile(filename)) throw new Error("Archive maintenance source is missing or invalid");
    releaseArchiveSourceFence(filename);
    discardShadowCandidate(next);
    durableDirectory(filename);
    rmSync(state);
    durableDirectory(filename);
    return;
  }
  if (fileInfo(old)) {
    if (marker.sourceSnapshot) recoverPinnedInterruptedCutover(filename, next, old, marker);
    else recoverInterruptedCutover(filename, next, old, marker);
  } else if (!validDatabase(filename)) {
    throw new Error("Archive maintenance source is missing or invalid");
  }
  releaseArchiveSourceFence(filename);
  // A discarded candidate may have an uncheckpointed WAL. It is safe to
  // remove its sidecars only after the original or promoted source is valid.
  discardShadowCandidate(next);
  durableDirectory(filename);
  rmSync(state);
  durableDirectory(filename);
}

export function prepareArchiveShadowCutover(filename) {
  const { next, state } = archiveShadowPaths(filename);
  if (!privateRegularFile(state) || !validDatabase(next) || hasNonemptyWal(next)) {
    throw new Error("Archive shadow is not ready for cutover");
  }
  // The candidate becomes publicly reachable at promotion. Fence it before
  // pinning its digest, so a direct SQLite writer cannot commit after a
  // crash and make recovery restore an older source. Platforms that cannot
  // promote an open SQLite file defer safely at cutover.
  const candidateDb = new Database(next);
  try {
    if (candidateDb.pragma("journal_mode = DELETE", { simple: true }).toLowerCase() !== "delete") {
      throw new Error("Archive shadow could not leave WAL mode");
    }
    candidateDb.pragma("synchronous = FULL");
    candidateDb.transaction(() => fenceArchiveSource(candidateDb)).immediate();
  } finally { candidateDb.close(); }
  if (hasNonemptyWal(next)) throw new Error("Archive shadow fence left an uncheckpointed WAL");
  durableFile(next);
  durableDirectory(next);
  const marker = JSON.parse(readFileSync(state, "utf8"));
  if (marker.version !== 2 || !markerOwnsDatabase(marker, filename)) throw new Error("Archive marker is not owned by this database");
  const candidate = candidateIdentity(next, true);
  writeArchiveMarker(state, { ...marker, candidate });
}

export function cutoverArchiveShadow(filename, { sourceInfo, cutoverStatGate } = {}) {
  const { next, old, state } = archiveShadowPaths(filename);
  if (!privateRegularFile(next)) throw new Error("Archive shadow is missing");
  if (fileInfo(old) || !privateRegularFile(state)) throw new Error("Archive cutover state is missing or conflicting");
  const marker = JSON.parse(readFileSync(state, "utf8"));
  if (!markerOwnsDatabase(marker, filename) || marker.version !== 2 || !matchesCandidate(next, marker.candidate)) {
    throw new Error("Archive cutover candidate changed after validation");
  }
  // Hold SQLite's exclusive locks on both inodes until the old source is
  // removed. Row triggers alone cannot fence CREATE TABLE, DROP TRIGGER or
  // PRAGMA writes from a direct sibling connection. If this platform cannot
  // rename an open SQLite file, defer before losing any committed write.
  let sourceDb;
  let candidateDb;
  let promoted = false;
  try {
    sourceDb = lockArchiveDatabase(filename);
    candidateDb = lockArchiveDatabase(next);
    cutoverArchiveShadowLocked(filename, { sourceInfo, cutoverStatGate, state, next, old, marker });
    promoted = true;
  } catch (error) {
    if (["SQLITE_BUSY", "SQLITE_LOCKED"].includes(error.code)) {
      throw Object.assign(new Error("Archive cutover database is busy; retry when idle", { cause: error }), { code: "ARCHIVE_SOURCE_BUSY" });
    }
    throw error;
  } finally {
    candidateDb?.close();
    sourceDb?.close();
  }
  if (promoted) {
    // The old inode is gone, so any subsequent public-path commit must stay
    // on the promoted source even if fence removal is interrupted.
    releaseArchiveSourceFence(filename);
    rmSync(state);
    durableDirectory(filename);
  }
}

function cutoverArchiveShadowLocked(filename, { sourceInfo, cutoverStatGate, state, next, old, marker }) {
  if (!matchesCandidate(next, marker.candidate)) {
    throw Object.assign(new Error("Archive candidate changed before exclusive cutover; retry when idle"), { code: "ARCHIVE_SOURCE_BUSY" });
  }
  // The worker checkpoints and closes its source before promotion. A
  // nonempty WAL would be left behind by a file rename and is unsafe.
  if (hasNonemptyWal(filename)) throw new Error("Archive source WAL was not checkpointed");
  if (hasNonemptyWal(next)) throw new Error("Archive shadow WAL was not checkpointed");
  removeCheckpointedSidecars(filename);
  removeCheckpointedSidecars(next);
  if (sourceInfo) {
    const current = statSync(filename, { bigint: true });
    if (["dev", "ino", "size", "mtimeNs", "ctimeNs"].some((key) => current[key] !== sourceInfo[key])) {
      throw Object.assign(new Error("Archive source changed under cutover fence; retry when idle"), { code: "ARCHIVE_SOURCE_BUSY" });
    }
  }
  // Pin the fenced source so a process crash followed by a direct schema
  // write to the old inode cannot silently promote an older shadow.
  writeArchiveMarker(state, { ...marker, sourceSnapshot: sourceSnapshot(filename) });
  // A test gate at the final comparison catches writes that older cutovers
  // silently replaced. Both SQLite handles remain exclusively locked here.
  if (cutoverStatGate instanceof SharedArrayBuffer) {
    const signal = new Int32Array(cutoverStatGate);
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0);
    if (Atomics.wait(signal, 0, 1, 5000) === "timed-out") throw new Error("Archive final stat probe timed out");
  }
  try { renameSync(filename, old); }
  catch (error) {
    // A separate open SQLite handle may still prohibit rename on Windows.
    // Leave the source untouched; recovery removes its fence before retry.
    if (["EPERM", "EACCES", "EBUSY"].includes(error.code) && privateRegularFile(filename) && !fileInfo(old)) {
      throw Object.assign(new Error("Archive source cannot be renamed while fenced; retry when idle"), { code: "ARCHIVE_SOURCE_BUSY", cause: error });
    }
    throw error;
  }
  durableDirectory(filename);
  // An interrupted promotion keeps both names and the durable marker. The
  // parent recovers it on a worker while HTTP can return bounded 503s.
  // link(2) is an exclusive create: an unrelated SQLite writer that creates
  // the public path during the rename gap cannot be overwritten. The two
  // names briefly refer to the same locked inode; recovery recognizes that
  // interrupted state before enforcing the normal single-link rule.
  linkSync(next, filename);
  durableDirectory(filename);
  rmSync(next);
  durableDirectory(filename);
  if (!matchesCandidate(filename, marker.candidate, false, true)) throw new Error("Archive cutover candidate changed during promotion");
  // The worker validated and flushed this same inode before the fence. A
  // full integrity scan here would make the service outage size-dependent.
  rmSync(old);
  durableDirectory(filename);
}

export function allocatedDatabaseUsage(filename) {
  if (filename === ":memory:") return { bytes: 0, status: "measured" };
  const { next, old, state } = archiveShadowPaths(filename);
  const sqliteFiles = [filename, next, old].flatMap((name) => [name, `${name}-wal`, `${name}-shm`, `${name}-journal`]);
  const inspect = (part) => {
    try { return fs.lstatSync(part); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  };
  try {
    const sourceBefore = inspect(filename);
    const markerBefore = inspect(state);
    let bytes = 0;
    let transition = false;
    for (const part of [...sqliteFiles, state, `${state}.tmp`]) {
      const info = inspect(part);
      if (!info) continue;
      if (!info.isFile()) throw new Error(`Unsafe database storage file: ${part}`);
      if (part === state || part === `${state}.tmp`) transition = true;
      const allocated = typeof info.blocks === "number" ? info.blocks * 512 : 0;
      bytes += allocated > 0 ? allocated : info.size;
    }
    const sourceAfter = inspect(filename);
    const markerAfter = inspect(state);
    if (!sourceBefore && !markerBefore && !markerAfter) return { bytes: null, status: "unknown" };
    // A cutover can rename the source during this scan. Compare both ends so
    // a transiently absent marker cannot make a moving sum look measured.
    if (sourceBefore?.dev !== sourceAfter?.dev || sourceBefore?.ino !== sourceAfter?.ino
      || sourceBefore?.size !== sourceAfter?.size || sourceBefore?.mtimeMs !== sourceAfter?.mtimeMs) transition = true;
    if (markerBefore || markerAfter) transition = true;
    let status = "measured";
    if (transition) status = "partial";
    else if (process.platform === "win32") status = "estimated";
    return { bytes, status };
  } catch (error) {
    // Windows can deny a stat while SQLite creates or removes a rollback
    // journal. A missing measurement must never become a plausible zero.
    if (["EPERM", "EACCES", "EBUSY"].includes(error.code)) return { bytes: null, status: "unknown" };
    throw error;
  }
}
