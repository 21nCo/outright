import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { existsSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { allocatedDatabaseUsage, archiveShadowPaths, beginArchiveShadow, cutoverArchiveShadow, fenceArchiveSource, prepareArchiveShadowCutover, recoverArchiveShadow } from "./archive-shadow.mjs";
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
    const writer = new Database(item.filename);
    try { writer.prepare("UPDATE evidence SET body = ? WHERE id = 1").run("writes resumed"); }
    finally { writer.close(); }
    assert.equal(body(item.filename), "writes resumed");
  } finally { rmSync(item.directory, { recursive: true, force: true }); }
});

test("a direct SQLite writer cannot commit after candidate promotion", () => {
  const item = fixture();
  const originalLink = fs.linkSync;
  let probed = false;
  try {
    beginArchiveShadow(item.filename);
    const source = new Database(item.filename);
    source.pragma("journal_mode = WAL");
    source.prepare("VACUUM INTO ?").run(item.next);
    source.close();
    prepareArchiveShadowCutover(item.filename);
    const fencedSource = new Database(item.filename);
    fencedSource.pragma("wal_checkpoint(TRUNCATE)");
    fencedSource.pragma("journal_mode = DELETE");
    fencedSource.exec("BEGIN EXCLUSIVE");
    fenceArchiveSource(fencedSource);
    fencedSource.exec("COMMIT");
    fencedSource.close();
    fs.linkSync = (from, to) => {
      originalLink(from, to);
      if (from === item.next && to === item.filename) {
        probed = true;
        const writer = new Database(to);
        try {
          writer.pragma("busy_timeout = 50");
          assert.throws(() => writer.prepare("UPDATE evidence SET body = ? WHERE id = 1").run("lost after promotion"),
            (error) => error.code === "SQLITE_BUSY" || /Archive cutover is in progress/.test(error.message));
        } finally { writer.close(); }
      }
    };
    syncBuiltinESMExports();
    cutoverArchiveShadow(item.filename);
    assert.equal(probed, true);
    assert.equal(body(item.filename), "recoverable payload");
    assert.equal(existsSync(item.old), false);
    assert.equal(existsSync(item.state), false);
    const writer = new Database(item.filename);
    try { writer.prepare("UPDATE evidence SET body = ? WHERE id = 1").run("committed after cutover"); }
    finally { writer.close(); }
    assert.equal(body(item.filename), "committed after cutover");
  } finally {
    fs.linkSync = originalLink;
    syncBuiltinESMExports();
    rmSync(item.directory, { recursive: true, force: true });
  }
});

test("schema and header writes cannot bypass the source or promoted candidate cutover locks", () => {
  const item = fixture();
  const originalRename = fs.renameSync;
  const originalLink = fs.linkSync;
  const stages = [];
  try {
    beginArchiveShadow(item.filename);
    const source = new Database(item.filename);
    source.prepare("VACUUM INTO ?").run(item.next);
    source.close();
    prepareArchiveShadowCutover(item.filename);
    const probe = (filename, stage) => {
      const writer = new Database(filename);
      try {
        writer.pragma("busy_timeout = 50");
        assert.throws(() => writer.exec("CREATE TABLE late_schema (value TEXT)"),
          (error) => error.code === "SQLITE_BUSY");
        assert.throws(() => writer.pragma("user_version = 42"),
          (error) => error.code === "SQLITE_BUSY");
        assert.throws(() => writer.exec("DROP TRIGGER archive_cutover_update_evidence"),
          (error) => error.code === "SQLITE_BUSY");
        stages.push(stage);
      } finally { writer.close(); }
    };
    fs.renameSync = (from, to) => {
      if (from === item.filename && to === item.old) probe(from, "source");
      originalRename(from, to);
    };
    fs.linkSync = (from, to) => {
      originalLink(from, to);
      if (from === item.next && to === item.filename) probe(to, "candidate");
    };
    syncBuiltinESMExports();
    cutoverArchiveShadow(item.filename);
    assert.deepEqual(stages, ["source", "candidate"]);
    const proof = new Database(item.filename);
    try {
      assert.equal(proof.prepare("SELECT name FROM sqlite_master WHERE name = 'late_schema'").get(), undefined);
      assert.equal(proof.pragma("user_version", { simple: true }), 0);
      assert.equal(proof.prepare("SELECT body FROM evidence WHERE id = 1").get().body, "recoverable payload");
    } finally { proof.close(); }
  } finally {
    fs.renameSync = originalRename;
    fs.linkSync = originalLink;
    syncBuiltinESMExports();
    rmSync(item.directory, { recursive: true, force: true });
  }
});

test("a schema commit before lock acquisition defers promotion and survives rollback", () => {
  const item = fixture();
  try {
    beginArchiveShadow(item.filename);
    const source = new Database(item.filename);
    source.prepare("VACUUM INTO ?").run(item.next);
    source.transaction(() => fenceArchiveSource(source)).immediate();
    source.close();
    prepareArchiveShadowCutover(item.filename);
    const sourceInfo = fs.statSync(item.filename, { bigint: true });
    const writer = new Database(item.filename);
    try {
      writer.exec("CREATE TABLE late_schema (value TEXT)");
      writer.pragma("user_version = 42");
      writer.exec("DROP TRIGGER archive_cutover_update_evidence");
      writer.prepare("UPDATE evidence SET body = ? WHERE id = 1").run("committed before lock");
    } finally { writer.close(); }
    assert.throws(() => cutoverArchiveShadow(item.filename, { sourceInfo }),
      (error) => error.code === "ARCHIVE_SOURCE_BUSY");
    recoverArchiveShadow(item.filename, { sourceUnmoved: true });
    const proof = new Database(item.filename);
    try {
      assert.equal(proof.prepare("SELECT body FROM evidence").get().body, "committed before lock");
      assert.equal(proof.prepare("SELECT name FROM sqlite_master WHERE name = 'late_schema'").get().name, "late_schema");
      assert.equal(proof.pragma("user_version", { simple: true }), 42);
    } finally { proof.close(); }
  } finally { rmSync(item.directory, { recursive: true, force: true }); }
});

test("recovery keeps a direct schema and row commit on the old source after first rename", () => {
  const item = fixture();
  const originalRename = fs.renameSync;
  try {
    beginArchiveShadow(item.filename);
    const source = new Database(item.filename);
    source.prepare("VACUUM INTO ?").run(item.next);
    source.transaction(() => fenceArchiveSource(source)).immediate();
    source.close();
    prepareArchiveShadowCutover(item.filename);
    fs.renameSync = (from, to) => {
      originalRename(from, to);
      if (from === item.filename && to === item.old) throw new Error("simulated first rename crash");
    };
    syncBuiltinESMExports();
    assert.throws(() => cutoverArchiveShadow(item.filename), /simulated first rename crash/);
    fs.renameSync = originalRename;
    syncBuiltinESMExports();
    const writer = new Database(item.old);
    try {
      writer.exec("CREATE TABLE late_schema (value TEXT)");
      writer.pragma("user_version = 42");
      writer.exec("DROP TRIGGER archive_cutover_update_evidence");
      writer.prepare("UPDATE evidence SET body = ? WHERE id = 1").run("late committed row");
    } finally { writer.close(); }
    recoverArchiveShadow(item.filename);
    const proof = new Database(item.filename);
    try {
      assert.equal(proof.prepare("SELECT name FROM sqlite_master WHERE name = 'late_schema'").get().name, "late_schema");
      assert.equal(proof.pragma("user_version", { simple: true }), 42);
      assert.equal(proof.prepare("SELECT body FROM evidence WHERE id = 1").get().body, "late committed row");
    } finally { proof.close(); }
  } finally {
    fs.renameSync = originalRename;
    syncBuiltinESMExports();
    rmSync(item.directory, { recursive: true, force: true });
  }
});

test("recovery preserves both databases when the promoted candidate receives a post-crash schema write", () => {
  const item = fixture();
  const originalLink = fs.linkSync;
  try {
    beginArchiveShadow(item.filename);
    const source = new Database(item.filename);
    source.prepare("VACUUM INTO ?").run(item.next);
    source.close();
    prepareArchiveShadowCutover(item.filename);
    fs.linkSync = (from, to) => {
      originalLink(from, to);
      if (from === item.next && to === item.filename) throw new Error("simulated promotion link crash");
    };
    syncBuiltinESMExports();
    assert.throws(() => cutoverArchiveShadow(item.filename), /simulated promotion link crash/);
    fs.linkSync = originalLink;
    syncBuiltinESMExports();
    const writer = new Database(item.filename);
    try { writer.exec("CREATE TABLE late_candidate (value TEXT)"); }
    finally { writer.close(); }
    assert.throws(() => recoverArchiveShadow(item.filename), /Promoted archive database changed/);
    assert.equal(existsSync(item.old), true);
    assert.equal(existsSync(item.filename), true);
    assert.equal(existsSync(item.state), true);
    const proof = new Database(item.filename, { readonly: true });
    try { assert.equal(proof.prepare("SELECT name FROM sqlite_master WHERE name = 'late_candidate'").get().name, "late_candidate"); }
    finally { proof.close(); }
  } finally {
    fs.linkSync = originalLink;
    syncBuiltinESMExports();
    rmSync(item.directory, { recursive: true, force: true });
  }
});

test("recovery keeps the old source locked through its final removal", () => {
  const item = fixture();
  const originalLink = fs.linkSync;
  const originalRemove = fs.rmSync;
  let probed = false;
  try {
    beginArchiveShadow(item.filename);
    const source = new Database(item.filename);
    source.prepare("VACUUM INTO ?").run(item.next);
    source.close();
    prepareArchiveShadowCutover(item.filename);
    fs.linkSync = (from, to) => {
      originalLink(from, to);
      if (from === item.next && to === item.filename) throw new Error("simulated promotion crash");
    };
    syncBuiltinESMExports();
    assert.throws(() => cutoverArchiveShadow(item.filename), /simulated promotion crash/);
    fs.linkSync = originalLink;
    fs.rmSync = (name, ...args) => {
      if (name === item.old) {
        probed = true;
        const writer = new Database(name);
        try {
          writer.pragma("busy_timeout = 50");
          assert.throws(() => writer.exec("CREATE TABLE lost_after_recovery_check (value TEXT)"),
            (error) => error.code === "SQLITE_BUSY");
        } finally { writer.close(); }
      }
      return originalRemove(name, ...args);
    };
    syncBuiltinESMExports();
    recoverArchiveShadow(item.filename);
    assert.equal(probed, true);
    assert.equal(body(item.filename), "recoverable payload");
    assert.equal(existsSync(item.state), false);
  } finally {
    fs.linkSync = originalLink;
    fs.rmSync = originalRemove;
    syncBuiltinESMExports();
    rmSync(item.directory, { recursive: true, force: true });
  }
});

test("a database created in the public-path gap is preserved instead of overwritten", () => {
  const item = fixture();
  const originalLink = fs.linkSync;
  try {
    beginArchiveShadow(item.filename);
    const source = new Database(item.filename);
    source.prepare("VACUUM INTO ?").run(item.next);
    source.close();
    prepareArchiveShadowCutover(item.filename);
    fs.linkSync = (from, to) => {
      if (from === item.next && to === item.filename) {
        const writer = new Database(to);
        try {
          writer.exec("CREATE TABLE late_public (value TEXT)");
          writer.prepare("INSERT INTO late_public (value) VALUES (?)").run("committed in gap");
        } finally { writer.close(); }
      }
      return originalLink(from, to);
    };
    syncBuiltinESMExports();
    assert.throws(() => cutoverArchiveShadow(item.filename), (error) => error.code === "EEXIST");
    fs.linkSync = originalLink;
    syncBuiltinESMExports();
    assert.throws(() => recoverArchiveShadow(item.filename), /Promoted archive database changed/);
    assert.equal(existsSync(item.old), true);
    assert.equal(existsSync(item.next), true);
    assert.equal(existsSync(item.state), true);
    const proof = new Database(item.filename, { readonly: true });
    try { assert.equal(proof.prepare("SELECT value FROM late_public").get().value, "committed in gap"); }
    finally { proof.close(); }
  } finally {
    fs.linkSync = originalLink;
    syncBuiltinESMExports();
    rmSync(item.directory, { recursive: true, force: true });
  }
});

test("restart finishes an interrupted source hard link without losing its late commit", () => {
  const item = fixture();
  const originalRename = fs.renameSync;
  const originalLink = fs.linkSync;
  try {
    beginArchiveShadow(item.filename);
    const source = new Database(item.filename);
    source.prepare("VACUUM INTO ?").run(item.next);
    source.close();
    prepareArchiveShadowCutover(item.filename);
    fs.renameSync = (from, to) => {
      originalRename(from, to);
      if (from === item.filename && to === item.old) throw new Error("simulated first rename crash");
    };
    syncBuiltinESMExports();
    assert.throws(() => cutoverArchiveShadow(item.filename), /simulated first rename crash/);
    fs.renameSync = originalRename;
    syncBuiltinESMExports();
    const writer = new Database(item.old);
    try { writer.exec("CREATE TABLE late_source (value TEXT)"); }
    finally { writer.close(); }
    fs.linkSync = (from, to) => {
      originalLink(from, to);
      if (from === item.old && to === item.filename) throw new Error("simulated source restoration crash");
    };
    syncBuiltinESMExports();
    assert.throws(() => recoverArchiveShadow(item.filename), /simulated source restoration crash/);
    fs.linkSync = originalLink;
    syncBuiltinESMExports();
    recoverArchiveShadow(item.filename);
    const proof = new Database(item.filename);
    try { assert.equal(proof.prepare("SELECT name FROM sqlite_master WHERE name = 'late_source'").get().name, "late_source"); }
    finally { proof.close(); }
    assert.equal(existsSync(item.old), false);
    assert.equal(existsSync(item.state), false);
  } finally {
    fs.renameSync = originalRename;
    fs.linkSync = originalLink;
    syncBuiltinESMExports();
    rmSync(item.directory, { recursive: true, force: true });
  }
});

test("post-promotion writer cannot lose sibling run, audit, setting or retained evidence", async () => {
  const item = fixture();
  const originalLink = fs.linkSync;
  try {
    const runtime = createOutrightDatabase({ filename: item.filename });
    const chat = runtime.createConversation({ projectId: "p", worktreeId: "w", worktreePath: item.directory,
      title: "retained sibling", provider: "codex" });
    const message = runtime.addMessage({ conversationId: chat.id, role: "assistant", body: "original sibling" });
    const queued = runtime.createRun({ conversationId: chat.id, worktreePath: item.directory,
      provider: "codex", approvalPolicy: "read-only", prompt: "queued prompt" });
    const interrupted = runtime.createRun({ conversationId: chat.id, worktreePath: item.directory,
      provider: "codex", approvalPolicy: "read-only", prompt: "recovery prompt" });
    runtime.updateRun(interrupted.id, { status: "interrupted" });
    await runtime.close();
    const baseline = new Database(item.filename, { readonly: true });
    const retainedBytes = baseline.prepare("SELECT bytes FROM retained_usage WHERE id = 1").get().bytes;
    baseline.close();
    beginArchiveShadow(item.filename);
    const source = new Database(item.filename);
    source.prepare("VACUUM INTO ?").run(item.next);
    source.close();
    prepareArchiveShadowCutover(item.filename);
    const fencedSource = new Database(item.filename);
    fencedSource.exec("BEGIN EXCLUSIVE");
    fenceArchiveSource(fencedSource);
    fencedSource.exec("COMMIT");
    fencedSource.close();
    let probed = false;
    fs.linkSync = (from, to) => {
      originalLink(from, to);
      if (from === item.next && to === item.filename) {
        probed = true;
        const writer = new Database(to);
        try {
          writer.pragma("busy_timeout = 50");
          assert.throws(() => writer.transaction(() => {
            writer.prepare("UPDATE messages SET body = ? WHERE id = ?").run("lost sibling", message.id);
            writer.prepare("UPDATE runs SET prompt = ? WHERE id = ?").run("lost run", queued.id);
            writer.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("cutover.probe", '"lost"');
            writer.prepare("INSERT INTO audit_log (action, target, details, created_at) VALUES (?, ?, ?, ?)")
              .run("cutover.probe", chat.id, "{}", new Date().toISOString());
          }).immediate(), (error) => error.code === "SQLITE_BUSY" || /Archive cutover is in progress/.test(error.message));
        } finally { writer.close(); }
      }
    };
    syncBuiltinESMExports();
    cutoverArchiveShadow(item.filename);
    assert.equal(probed, true);
    const proof = new Database(item.filename, { readonly: true });
    try {
      assert.equal(proof.prepare("SELECT body FROM messages WHERE id = ?").get(message.id).body, "original sibling");
      assert.equal(proof.prepare("SELECT prompt FROM runs WHERE id = ?").get(queued.id).prompt, "queued prompt");
      assert.equal(proof.prepare("SELECT status FROM runs WHERE id = ?").get(queued.id).status, "queued");
      assert.equal(proof.prepare("SELECT status FROM runs WHERE id = ?").get(interrupted.id).status, "interrupted");
      assert.equal(proof.prepare("SELECT value FROM settings WHERE key = 'cutover.probe'").get(), undefined);
      assert.equal(proof.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'cutover.probe'").get().count, 0);
      assert.equal(proof.prepare("SELECT bytes FROM retained_usage WHERE id = 1").get().bytes, retainedBytes);
    } finally { proof.close(); }
    const restarted = createOutrightDatabase({ filename: item.filename });
    try {
      assert.equal(restarted.getRun(queued.id).status, "queued");
      assert.equal(restarted.getRun(interrupted.id).status, "interrupted");
    } finally { await restarted.close(); }
  } finally {
    fs.linkSync = originalLink;
    syncBuiltinESMExports();
    rmSync(item.directory, { recursive: true, force: true });
  }
});

test("interruption after promotion validation keeps candidate fenced through recovery", () => {
  const item = fixture();
  const originalRemove = fs.rmSync;
  let probed = false;
  try {
    beginArchiveShadow(item.filename);
    const source = new Database(item.filename);
    source.prepare("VACUUM INTO ?").run(item.next);
    source.close();
    prepareArchiveShadowCutover(item.filename);
    fs.rmSync = (name, ...args) => {
      if (name === item.old) {
        probed = true;
        const writer = new Database(item.filename);
        try { writer.pragma("busy_timeout = 50");
          assert.throws(() => writer.prepare("INSERT INTO evidence (body) VALUES (?)").run("lost before cleanup"),
            (error) => error.code === "SQLITE_BUSY" || /Archive cutover is in progress/.test(error.message)); }
        finally { writer.close(); }
        throw new Error("simulated interruption after validation");
      }
      return originalRemove(name, ...args);
    };
    syncBuiltinESMExports();
    assert.throws(() => cutoverArchiveShadow(item.filename), /simulated interruption/);
    assert.equal(probed, true);
    assert.equal(existsSync(item.old), true);
    fs.rmSync = originalRemove;
    syncBuiltinESMExports();
    recoverArchiveShadow(item.filename);
    assert.equal(body(item.filename), "recoverable payload");
    const writer = new Database(item.filename);
    try { writer.prepare("INSERT INTO evidence (body) VALUES (?)").run("recovered write"); }
    finally { writer.close(); }
    assert.equal(existsSync(item.state), false);
  } finally {
    fs.rmSync = originalRemove;
    syncBuiltinESMExports();
    rmSync(item.directory, { recursive: true, force: true });
  }
});

test("an interrupted closed-source cutover retains its write fence until rollback", () => {
  const item = fixture();
  try {
    beginArchiveShadow(item.filename);
    const source = new Database(item.filename);
    source.prepare("VACUUM INTO ?").run(item.next);
    source.exec("BEGIN EXCLUSIVE");
    fenceArchiveSource(source);
    source.exec("COMMIT");
    source.close();
    const writer = new Database(item.filename);
    try {
      assert.throws(() => writer.prepare("UPDATE evidence SET body = ? WHERE id = 1").run("lost write"),
        /Archive cutover is in progress/);
    } finally { writer.close(); }
    // A crash before the first rename leaves the original and candidate.
    recoverArchiveShadow(item.filename, { sourceUnmoved: true });
    assert.equal(body(item.filename), "recoverable payload");
    const resumed = new Database(item.filename);
    try {
      resumed.prepare("UPDATE evidence SET body = ? WHERE id = 1").run("writes resumed");
    } finally { resumed.close(); }
    assert.equal(body(item.filename), "writes resumed");
    assert.equal(existsSync(item.state), false);
  } finally { rmSync(item.directory, { recursive: true, force: true }); }
});

test("rollback after the first rename releases the recovered source fence", () => {
  const item = fixture();
  try {
    beginArchiveShadow(item.filename);
    const source = new Database(item.filename);
    source.prepare("VACUUM INTO ?").run(item.next);
    source.exec("BEGIN EXCLUSIVE");
    fenceArchiveSource(source);
    source.exec("COMMIT");
    source.close();
    // Without a prepared candidate, recovery must choose the original.
    renameSync(item.filename, item.old);
    recoverArchiveShadow(item.filename);
    assert.equal(body(item.filename), "recoverable payload");
    const writer = new Database(item.filename);
    try {
      writer.prepare("UPDATE evidence SET body = ? WHERE id = 1").run("recovered write");
    } finally { writer.close(); }
    assert.equal(body(item.filename), "recovered write");
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
    // File replacement remains detectable even though ordinary SQLite DML
    // against the candidate is fenced after preparation.
    const substitute = `${item.filename}.substitute`;
    const next = new Database(substitute);
    next.exec("CREATE TABLE evidence (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
    next.prepare("INSERT INTO evidence (body) VALUES (?)").run("changed after prepare");
    next.close();
    rmSync(item.next);
    renameSync(substitute, item.next);
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
