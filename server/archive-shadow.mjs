import Database from "better-sqlite3";
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

// The runtime lease is held by the caller for every transition. The source
// database is closed before the first rename; all large SQLite work happens
// in the disposable shadow, never on the live writer connection.
export function archiveShadowPaths(filename) {
  return { next: `${filename}.archive-next`, old: `${filename}.archive-old`, state: `${filename}.archive-state` };
}

function privateRegularFile(filename) {
  if (!existsSync(filename)) return false;
  const info = lstatSync(filename);
  if (!info.isFile() || info.nlink !== 1) throw new Error(`Unsafe archive maintenance file: ${filename}`);
  return true;
}

function durableFile(filename) {
  const fd = openSync(filename, "r");
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
  if (existsSync(state) || existsSync(archiveShadowPaths(filename).next)
    || existsSync(archiveShadowPaths(filename).old)) throw new Error("Archive maintenance state already exists");
  if (existsSync(temporary)) rmSync(temporary);
  writeFileSync(temporary, JSON.stringify({ version: 1, source: filename }), { mode: 0o600, flag: "wx" });
  durableFile(temporary);
  renameSync(temporary, state);
  durableFile(state);
  durableDirectory(state);
}

function validDatabase(filename) {
  if (!privateRegularFile(filename)) return false;
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
  return existsSync(`${filename}-wal`) && statSync(`${filename}-wal`).size > 0;
}

function removeCheckpointedSidecars(filename) {
  if (hasNonemptyWal(filename)) throw new Error(`Uncheckpointed archive database WAL: ${filename}`);
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(`${filename}${suffix}`)) rmSync(`${filename}${suffix}`);
  }
}

function discardShadowCandidate(filename) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(`${filename}${suffix}`)) rmSync(`${filename}${suffix}`);
  }
}

export function recoverArchiveShadow(filename) {
  const { next, old, state } = archiveShadowPaths(filename);
  const temporary = `${state}.tmp`;
  if (privateRegularFile(temporary)) rmSync(temporary);
  if (!existsSync(state)) {
    if (existsSync(next) || existsSync(old)) throw new Error("Unowned archive maintenance files require inspection");
    return;
  }
  privateRegularFile(state);
  const marker = JSON.parse(readFileSync(state, "utf8"));
  if (marker.version !== 1 || marker.source !== filename) throw new Error("Archive maintenance marker does not match the database");
  privateRegularFile(next);
  privateRegularFile(old);
  if (existsSync(old)) {
    if (!existsSync(filename)) {
      if (!hasNonemptyWal(next) && validDatabase(next)) renameSync(next, filename);
      else renameSync(old, filename);
    }
    if (!validDatabase(filename)) {
      if (!validDatabase(old)) throw new Error("Neither archive maintenance database is valid");
      rmSync(filename);
      renameSync(old, filename);
    }
    if (existsSync(old)) rmSync(old);
  } else if (!validDatabase(filename)) {
    throw new Error("Archive maintenance source is missing or invalid");
  }
  // A discarded candidate may have an uncheckpointed WAL. It is safe to
  // remove its sidecars only after the original or promoted source is valid.
  discardShadowCandidate(next);
  rmSync(state);
  durableDirectory(filename);
}

export function cutoverArchiveShadow(filename) {
  const { next, old, state } = archiveShadowPaths(filename);
  if (!privateRegularFile(next) || !validDatabase(next)) throw new Error("Archive shadow failed validation");
  if (existsSync(old) || !privateRegularFile(state)) throw new Error("Archive cutover state is missing or conflicting");
  // The worker checkpoints and closes the source before publishing `ready`.
  // A nonempty WAL would be left behind by a file rename and is unsafe.
  if (hasNonemptyWal(filename)) throw new Error("Archive source WAL was not checkpointed");
  if (hasNonemptyWal(next)) throw new Error("Archive shadow WAL was not checkpointed");
  durableFile(next);
  removeCheckpointedSidecars(filename);
  removeCheckpointedSidecars(next);
  renameSync(filename, old);
  durableDirectory(filename);
  try { renameSync(next, filename); durableDirectory(filename); }
  catch (error) {
    renameSync(old, filename);
    discardShadowCandidate(next);
    rmSync(state);
    durableDirectory(filename);
    throw error;
  }
  if (!validDatabase(filename)) {
    rmSync(filename);
    renameSync(old, filename);
    rmSync(state);
    durableDirectory(filename);
    throw new Error("Archive cutover failed verification");
  }
  rmSync(old);
  rmSync(state);
  durableDirectory(filename);
}

export function allocatedDatabaseBytes(filename) {
  if (filename === ":memory:") return 0;
  const { next, old, state } = archiveShadowPaths(filename);
  const sqliteFiles = [filename, next, old].flatMap((name) => [name, `${name}-wal`, `${name}-shm`, `${name}-journal`]);
  return [...sqliteFiles, state, `${state}.tmp`]
    .reduce((total, part) => {
      try {
        const info = lstatSync(part);
        if (!info.isFile()) throw new Error(`Unsafe database storage file: ${part}`);
        return total + (typeof info.blocks === "number" ? info.blocks * 512 : info.size);
      } catch (error) { if (error.code === "ENOENT") return total; throw error; }
    }, 0);
}
