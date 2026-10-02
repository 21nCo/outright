import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  privateRegularFile(next);
  privateRegularFile(old);
  // An expected live conflict is reported only before either rename. The
  // runtime still has its original connection, so discarding this candidate
  // does not need a whole-database integrity scan on every normal deferral.
  if (sourceUnmoved && !fileInfo(old)) {
    if (!privateRegularFile(filename)) throw new Error("Archive maintenance source is missing or invalid");
    discardShadowCandidate(next);
    durableDirectory(filename);
    rmSync(state);
    durableDirectory(filename);
    return;
  }
  if (fileInfo(old)) {
    recoverInterruptedCutover(filename, next, old, marker);
  } else if (!validDatabase(filename)) {
    throw new Error("Archive maintenance source is missing or invalid");
  }
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
  durableFile(next);
  durableDirectory(next);
  const marker = JSON.parse(readFileSync(state, "utf8"));
  if (marker.version !== 2 || !markerOwnsDatabase(marker, filename)) throw new Error("Archive marker is not owned by this database");
  const candidate = candidateIdentity(next, true);
  const temporary = `${state}.tmp`;
  writeFileSync(temporary, JSON.stringify({ ...marker, candidate }), { mode: 0o600, flag: "wx" });
  durableFile(temporary);
  renameSync(temporary, state);
  durableDirectory(state);
}

export function cutoverArchiveShadow(filename) {
  const { next, old, state } = archiveShadowPaths(filename);
  if (!privateRegularFile(next)) throw new Error("Archive shadow is missing");
  if (fileInfo(old) || !privateRegularFile(state)) throw new Error("Archive cutover state is missing or conflicting");
  const marker = JSON.parse(readFileSync(state, "utf8"));
  if (!markerOwnsDatabase(marker, filename) || marker.version !== 2 || !matchesCandidate(next, marker.candidate)) {
    throw new Error("Archive cutover candidate changed after validation");
  }
  // The worker checkpoints and closes the source before publishing `ready`.
  // A nonempty WAL would be left behind by a file rename and is unsafe.
  if (hasNonemptyWal(filename)) throw new Error("Archive source WAL was not checkpointed");
  if (hasNonemptyWal(next)) throw new Error("Archive shadow WAL was not checkpointed");
  removeCheckpointedSidecars(filename);
  removeCheckpointedSidecars(next);
  renameSync(filename, old);
  durableDirectory(filename);
  // An interrupted promotion keeps both names and the durable marker. The
  // parent recovers it on a worker while HTTP can return bounded 503s.
  renameSync(next, filename);
  durableDirectory(filename);
  if (!matchesCandidate(filename, marker.candidate, false, true)) throw new Error("Archive cutover candidate changed during promotion");
  // The worker validated and flushed this same inode before the fence. A
  // full integrity scan here would make the service outage size-dependent.
  rmSync(old);
  durableDirectory(filename);
  rmSync(state);
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
