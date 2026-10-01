import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { existsSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { allocatedDatabaseBytes, archiveShadowPaths, beginArchiveShadow, recoverArchiveShadow } from "./archive-shadow.mjs";

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-shadow-recover-"));
  const filename = path.join(directory, "outright.db");
  const db = new Database(filename);
  db.exec("CREATE TABLE evidence (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
  db.prepare("INSERT INTO evidence (body) VALUES (?)").run("recoverable payload");
  db.close();
  return { directory, filename, ...archiveShadowPaths(filename) };
}

function body(filename) {
  const db = new Database(filename, { readonly: true, fileMustExist: true });
  try { return db.prepare("SELECT body FROM evidence WHERE id = 1").get()?.body; }
  finally { db.close(); }
}

test("archive shadow recovery discards an interrupted copy without touching source evidence", () => {
  const item = fixture();
  try {
    beginArchiveShadow(item.filename);
    writeFileSync(item.next, "incomplete copy");
    assert.ok(allocatedDatabaseBytes(item.filename) > 0);
    recoverArchiveShadow(item.filename);
    assert.equal(body(item.filename), "recoverable payload");
    assert.equal(existsSync(item.next), false);
    assert.equal(existsSync(item.state), false);
  } finally { rmSync(item.directory, { recursive: true, force: true }); }
});

test("archive shadow recovery finishes a cutover gap and retains the verified replacement", () => {
  const item = fixture();
  try {
    beginArchiveShadow(item.filename);
    const source = new Database(item.filename);
    source.prepare("VACUUM INTO ?").run(item.next);
    source.close();
    const next = new Database(item.next);
    next.prepare("INSERT INTO evidence (body) VALUES (?)").run("committed shadow payload");
    next.close();
    renameSync(item.filename, item.old);
    recoverArchiveShadow(item.filename);
    assert.equal(body(item.filename), "recoverable payload");
    const active = new Database(item.filename, { readonly: true });
    assert.equal(active.prepare("SELECT body FROM evidence WHERE id = 2").get().body, "committed shadow payload");
    active.close();
    assert.equal(existsSync(item.old), false);
  } finally { rmSync(item.directory, { recursive: true, force: true }); }
});

test("archive shadow recovery restores the source when the replacement is invalid", () => {
  const item = fixture();
  try {
    beginArchiveShadow(item.filename);
    writeFileSync(item.next, "invalid replacement");
    renameSync(item.filename, item.old);
    recoverArchiveShadow(item.filename);
    assert.equal(body(item.filename), "recoverable payload");
    assert.equal(existsSync(item.old), false);
    assert.equal(existsSync(item.state), false);
  } finally { rmSync(item.directory, { recursive: true, force: true }); }
});

test("an empty reserved shadow never replaces the recoverable source", () => {
  const item = fixture();
  try {
    beginArchiveShadow(item.filename);
    writeFileSync(item.next, "");
    renameSync(item.filename, item.old);
    recoverArchiveShadow(item.filename);
    assert.equal(body(item.filename), "recoverable payload");
    assert.equal(existsSync(item.old), false);
    assert.equal(existsSync(item.next), false);
  } finally { rmSync(item.directory, { recursive: true, force: true }); }
});

test("a lexical parent marker recovers through the canonical database path", () => {
  const item = fixture();
  const alias = path.join(item.directory, "parent-alias");
  try {
    symlinkSync(item.directory, alias, process.platform === "win32" ? "junction" : "dir");
    const lexical = path.join(alias, path.basename(item.filename));
    beginArchiveShadow(lexical);
    writeFileSync(`${lexical}.archive-next`, "incomplete copy");
    const canonical = path.join(realpathSync(item.directory), path.basename(item.filename));
    recoverArchiveShadow(canonical);
    assert.equal(body(canonical), "recoverable payload");
    assert.equal(existsSync(`${canonical}.archive-state`), false);
  } finally { rmSync(item.directory, { recursive: true, force: true }); }
});

test("archive shadow recovery discards an uncheckpointed candidate with its sidecars", () => {
  const item = fixture();
  try {
    beginArchiveShadow(item.filename);
    writeFileSync(item.next, "interrupted replacement");
    writeFileSync(`${item.next}-wal`, "uncheckpointed candidate");
    renameSync(item.filename, item.old);
    recoverArchiveShadow(item.filename);
    assert.equal(body(item.filename), "recoverable payload");
    assert.equal(existsSync(item.next), false);
    assert.equal(existsSync(`${item.next}-wal`), false);
    assert.equal(existsSync(item.state), false);
  } finally { rmSync(item.directory, { recursive: true, force: true }); }
});

test("archive shadow recovery keeps the promoted database and releases its old physical copy", () => {
  const item = fixture();
  try {
    beginArchiveShadow(item.filename);
    const source = new Database(item.filename);
    source.prepare("VACUUM INTO ?").run(item.next);
    source.close();
    const replacement = new Database(item.next);
    replacement.prepare("UPDATE evidence SET body = ? WHERE id = 1").run("promoted payload");
    replacement.close();
    renameSync(item.filename, item.old);
    renameSync(item.next, item.filename);
    const withOld = allocatedDatabaseBytes(item.filename);
    recoverArchiveShadow(item.filename);
    assert.equal(body(item.filename), "promoted payload");
    assert.equal(existsSync(item.old), false);
    assert.ok(allocatedDatabaseBytes(item.filename) < withOld, "retained old file was omitted from disk accounting");
  } finally { rmSync(item.directory, { recursive: true, force: true }); }
});

test("dangling maintenance links are rejected before recovery can discard its marker", () => {
  const item = fixture();
  try {
    beginArchiveShadow(item.filename);
    symlinkSync(path.join(item.directory, "missing-candidate"), item.next);
    assert.throws(() => recoverArchiveShadow(item.filename), /Unsafe archive maintenance file/);
    assert.equal(existsSync(item.state), true, "recovery erased the only ownership marker");
    assert.equal(body(item.filename), "recoverable payload");
  } finally { rmSync(item.directory, { recursive: true, force: true }); }
});

test("physical usage includes candidate and marker bytes until each file is removed", () => {
  const item = fixture();
  try {
    const sourceBytes = allocatedDatabaseBytes(item.filename);
    assert.ok(sourceBytes > 0);
    beginArchiveShadow(item.filename);
    const withMarker = allocatedDatabaseBytes(item.filename);
    assert.ok(withMarker > sourceBytes, "marker was omitted from physical usage");
    writeFileSync(item.next, Buffer.alloc(128 * 1024, 1));
    assert.ok(allocatedDatabaseBytes(item.filename) > withMarker, "candidate was omitted from physical usage");
    recoverArchiveShadow(item.filename);
    assert.equal(allocatedDatabaseBytes(item.filename), sourceBytes);
  } finally { rmSync(item.directory, { recursive: true, force: true }); }
});
