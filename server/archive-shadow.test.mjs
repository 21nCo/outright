import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { existsSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { allocatedDatabaseUsage, archiveShadowPaths, beginArchiveShadow, cutoverArchiveShadow, prepareArchiveShadowCutover, recoverArchiveShadow } from "./archive-shadow.mjs";
import { createOutrightDatabase, recoverArchiveBeforeStartup } from "./database.mjs";

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
    assert.ok(allocatedDatabaseUsage(item.filename).bytes > 0);
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
    prepareArchiveShadowCutover(item.filename);
    renameSync(item.filename, item.old);
    recoverArchiveShadow(item.filename);
    assert.equal(body(item.filename), "recoverable payload");
    const active = new Database(item.filename, { readonly: true });
    assert.equal(active.prepare("SELECT body FROM evidence WHERE id = 2").get().body, "committed shadow payload");
    active.close();
    assert.equal(existsSync(item.old), false);
  } finally { rmSync(item.directory, { recursive: true, force: true }); }
});

test("archive shadow cutover promotes a validated candidate and releases its fallback", () => {
  const item = fixture();
  try {
    beginArchiveShadow(item.filename);
    const source = new Database(item.filename);
    source.prepare("VACUUM INTO ?").run(item.next);
    source.close();
    const candidate = new Database(item.next);
    candidate.prepare("UPDATE evidence SET body = ? WHERE id = 1").run("retained after cutover");
    candidate.close();
    prepareArchiveShadowCutover(item.filename);
    cutoverArchiveShadow(item.filename);
    assert.equal(body(item.filename), "retained after cutover");
    assert.equal(existsSync(item.old), false);
    assert.equal(existsSync(item.next), false);
    assert.equal(existsSync(item.state), false);
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
    assert.equal(existsSync(item.next), false);
  } finally { rmSync(item.directory, { recursive: true, force: true }); }
});

test("recovery preserves an invalid fallback and marker when no database is usable", () => {
  const item = fixture();
  try {
    beginArchiveShadow(item.filename);
    writeFileSync(item.next, "invalid replacement");
    renameSync(item.filename, item.old);
    writeFileSync(item.old, "invalid fallback");
    assert.throws(() => recoverArchiveShadow(item.filename), /Neither archive maintenance database is valid/);
    assert.equal(existsSync(item.filename), false, "an invalid fallback became the active database");
    assert.equal(existsSync(item.old), true, "invalid backup was removed before inspection");
    assert.equal(existsSync(item.state), true, "recovery marker was removed before inspection");
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
    prepareArchiveShadowCutover(item.filename);
    renameSync(item.filename, item.old);
    renameSync(item.next, item.filename);
    const withOld = allocatedDatabaseUsage(item.filename).bytes;
    recoverArchiveShadow(item.filename);
    assert.equal(body(item.filename), "promoted payload");
    assert.equal(existsSync(item.old), false);
    assert.ok(allocatedDatabaseUsage(item.filename).bytes < withOld, "retained old file was omitted from disk accounting");
  } finally { rmSync(item.directory, { recursive: true, force: true }); }
});

test("a valid replacement after preparation cannot displace the recoverable source", () => {
  const item = fixture();
  try {
    beginArchiveShadow(item.filename);
    const source = new Database(item.filename);
    source.prepare("VACUUM INTO ?").run(item.next);
    source.close();
    prepareArchiveShadowCutover(item.filename);
    const substitute = `${item.filename}.substitute`;
    const other = new Database(substitute);
    other.exec("CREATE TABLE evidence (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
    other.prepare("INSERT INTO evidence (body) VALUES (?)").run("unvalidated payload");
    other.close();
    rmSync(item.next);
    renameSync(substitute, item.next);
    assert.throws(() => cutoverArchiveShadow(item.filename), /candidate changed/);
    recoverArchiveShadow(item.filename);
    assert.equal(body(item.filename), "recoverable payload");
    assert.equal(existsSync(item.next), false);
    assert.equal(existsSync(item.old), false);
    assert.equal(existsSync(item.state), false);
  } finally { rmSync(item.directory, { recursive: true, force: true }); }
});

test("recovery rejects a substituted candidate after the original is renamed", () => {
  const item = fixture();
  try {
    beginArchiveShadow(item.filename);
    const source = new Database(item.filename);
    source.prepare("VACUUM INTO ?").run(item.next);
    source.close();
    prepareArchiveShadowCutover(item.filename);
    renameSync(item.filename, item.old);
    const next = new Database(item.next);
    next.prepare("UPDATE evidence SET body = ? WHERE id = 1").run("changed after prepare");
    next.close();
    recoverArchiveShadow(item.filename);
    assert.equal(body(item.filename), "recoverable payload");
    assert.equal(existsSync(item.old), false);
    assert.equal(existsSync(item.next), false);
  } finally { rmSync(item.directory, { recursive: true, force: true }); }
});

test("recovery keeps the fallback when the authenticated candidate is replaced during promotion", () => {
  const item = fixture();
  const originalRename = fs.renameSync;
  try {
    beginArchiveShadow(item.filename);
    const source = new Database(item.filename);
    source.prepare("VACUUM INTO ?").run(item.next);
    source.close();
    prepareArchiveShadowCutover(item.filename);
    renameSync(item.filename, item.old);
    const substitute = `${item.filename}.substitute`;
    const other = new Database(substitute);
    other.exec("CREATE TABLE evidence (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
    other.prepare("INSERT INTO evidence (body) VALUES (?)").run("unvalidated payload");
    other.close();
    fs.renameSync = (from, to) => {
      originalRename(from, to);
      if (from === item.next && to === item.filename) {
        fs.rmSync(to);
        originalRename(substitute, to);
      }
    };
    syncBuiltinESMExports();
    recoverArchiveShadow(item.filename);
    assert.equal(body(item.filename), "recoverable payload");
    assert.equal(existsSync(item.state), false);
  } finally {
    fs.renameSync = originalRename;
    syncBuiltinESMExports();
    rmSync(item.directory, { recursive: true, force: true });
  }
});

test("recovery keeps the fallback when a previously promoted candidate changes before cleanup", () => {
  const item = fixture();
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  const originalRename = fs.renameSync;
  try {
    beginArchiveShadow(item.filename);
    const source = new Database(item.filename);
    source.prepare("VACUUM INTO ?").run(item.next);
    source.close();
    prepareArchiveShadowCutover(item.filename);
    renameSync(item.filename, item.old);
    renameSync(item.next, item.filename);
    const substitute = `${item.filename}.substitute`;
    const other = new Database(substitute);
    other.exec("CREATE TABLE evidence (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
    other.prepare("INSERT INTO evidence (body) VALUES (?)").run("unvalidated payload");
    other.close();
    let flushHandle;
    fs.openSync = (name, flags, ...rest) => {
      const fd = originalOpen(name, flags, ...rest);
      if (name === item.filename && flags === "r+") flushHandle = fd;
      return fd;
    };
    fs.closeSync = (fd) => {
      originalClose(fd);
      if (fd === flushHandle) {
        flushHandle = undefined;
        fs.rmSync(item.filename);
        originalRename(substitute, item.filename);
      }
    };
    syncBuiltinESMExports();
    recoverArchiveShadow(item.filename);
    assert.equal(body(item.filename), "recoverable payload");
    assert.equal(existsSync(item.state), false);
    assert.equal(existsSync(item.next), false);
    assert.equal(existsSync(item.old), false);
  } finally {
    fs.openSync = originalOpen;
    fs.closeSync = originalClose;
    syncBuiltinESMExports();
    rmSync(item.directory, { recursive: true, force: true });
  }
});

test("a leased startup recovery reports a retryable busy code without discarding evidence", async () => {
  const item = fixture();
  let lease;
  try {
    beginArchiveShadow(item.filename);
    lease = new Database(`${item.filename}.runtime-lease`);
    lease.pragma("locking_mode = EXCLUSIVE");
    lease.exec("BEGIN EXCLUSIVE; COMMIT;");
    await assert.rejects(recoverArchiveBeforeStartup({ filename: item.filename }),
      (error) => error.code === "SQLITE_BUSY");
    assert.equal(body(item.filename), "recoverable payload");
    assert.equal(existsSync(item.state), true);
    lease.close();
    lease = undefined;
    await recoverArchiveBeforeStartup({ filename: item.filename });
    assert.equal(body(item.filename), "recoverable payload");
    assert.equal(existsSync(item.state), false);
  } finally {
    lease?.close();
    rmSync(item.directory, { recursive: true, force: true });
  }
});

test("large interrupted startup recovery yields while authenticating the candidate", async () => {
  const item = fixture();
  try {
    beginArchiveShadow(item.filename);
    const source = new Database(item.filename);
    source.exec("CREATE TABLE bulk (body BLOB)");
    source.exec("INSERT INTO bulk (body) VALUES (zeroblob(67108864))");
    source.prepare("VACUUM INTO ?").run(item.next);
    source.close();
    prepareArchiveShadowCutover(item.filename);
    renameSync(item.filename, item.old);
    assert.throws(() => createOutrightDatabase({ filename: item.filename }), /asynchronous startup recovery/);
    let settled = false;
    const recovery = recoverArchiveBeforeStartup({ filename: item.filename }).finally(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "large candidate authentication blocked the event loop");
    await recovery;
    assert.equal(body(item.filename), "recoverable payload");
    assert.equal(existsSync(item.old), false);
    beginArchiveShadow(item.filename);
    let sourceSettled = false;
    const sourceRecovery = recoverArchiveBeforeStartup({ filename: item.filename }).finally(() => { sourceSettled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sourceSettled, false, "source integrity validation blocked the event loop");
    await sourceRecovery;
    assert.equal(existsSync(item.state), false);
  } finally { rmSync(item.directory, { recursive: true, force: true }); }
});

test("an unpinned legacy marker rolls back a valid but unauthenticated candidate", () => {
  const item = fixture();
  try {
    beginArchiveShadow(item.filename);
    writeFileSync(item.state, JSON.stringify({ version: 1, source: item.filename }));
    const source = new Database(item.filename);
    source.prepare("VACUUM INTO ?").run(item.next);
    source.close();
    const candidate = new Database(item.next);
    candidate.prepare("UPDATE evidence SET body = ? WHERE id = 1").run("unauthenticated payload");
    candidate.close();
    renameSync(item.filename, item.old);
    recoverArchiveShadow(item.filename);
    assert.equal(body(item.filename), "recoverable payload");
  } finally { rmSync(item.directory, { recursive: true, force: true }); }
});

test("dangling maintenance links are rejected before recovery can discard its marker", (t) => {
  const item = fixture();
  try {
    beginArchiveShadow(item.filename);
    try { symlinkSync(path.join(item.directory, "missing-candidate"), item.next); }
    catch (error) {
      if (process.platform !== "win32" || !["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error;
      t.skip(`Windows account cannot create file symlinks: ${error.code}`);
      return;
    }
    assert.throws(() => recoverArchiveShadow(item.filename), /Unsafe archive maintenance file/);
    assert.equal(existsSync(item.state), true, "recovery erased the only ownership marker");
    assert.equal(body(item.filename), "recoverable payload");
  } finally { rmSync(item.directory, { recursive: true, force: true }); }
});

test("physical usage includes candidate and marker bytes until each file is removed", () => {
  const item = fixture();
  try {
    const sourceBytes = allocatedDatabaseUsage(item.filename).bytes;
    assert.ok(sourceBytes > 0);
    beginArchiveShadow(item.filename);
    const withMarker = allocatedDatabaseUsage(item.filename).bytes;
    assert.equal(allocatedDatabaseUsage(item.filename).status, "partial");
    assert.ok(withMarker > sourceBytes, "marker was omitted from physical usage");
    writeFileSync(item.next, Buffer.alloc(128 * 1024, 1));
    assert.ok(allocatedDatabaseUsage(item.filename).bytes > withMarker, "candidate was omitted from physical usage");
    recoverArchiveShadow(item.filename);
    assert.equal(allocatedDatabaseUsage(item.filename).bytes, sourceBytes);
  } finally { rmSync(item.directory, { recursive: true, force: true }); }
});

test("inaccessible rollback journal reports unknown usage and pauses launch admission", () => {
  const item = fixture();
  const originalStat = fs.lstatSync;
  let database;
  try {
    database = createOutrightDatabase({ filename: path.join(item.directory, "runtime.db") });
    const journal = path.join(realpathSync(item.directory), "runtime.db.archive-next-journal");
    fs.lstatSync = (filename, ...args) => {
      if (filename === journal) throw Object.assign(new Error("sharing violation"), { code: "EPERM" });
      return originalStat(filename, ...args);
    };
    syncBuiltinESMExports();
    assert.deepEqual(database.capacity().diskAllocatedBytes, null);
    assert.equal(database.capacity().diskUsageStatus, "unknown");
    const conversation = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: item.directory, title: "sibling", provider: "codex" });
    const submitted = database.submitRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "queued" }, "queued");
    assert.equal(database.getRun(submitted.run.id).status, "queued", "journal access prevented durable queueing");
    assert.equal(database.canLaunchRun(), false, "unknown physical usage admitted a new process");
  } finally {
    fs.lstatSync = originalStat;
    syncBuiltinESMExports();
    assert.equal(database?.capacity().diskUsageStatus, process.platform === "win32" ? "estimated" : "measured");
    assert.equal(database?.canLaunchRun(), true, "journal access recovery did not reopen admission");
    database?.close();
    rmSync(item.directory, { recursive: true, force: true });
  }
});
