import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOutrightDatabase, defaultProbeRun } from "./database.mjs";

function cpuMilliseconds(since) {
  const used = process.cpuUsage(since);
  return (used.user + used.system) / 1000;
}

async function waitForSearchMigration(filename, kind) {
  const deadline = Date.now() + 5_000;
  while (true) {
    const probe = new Database(filename, { readonly: true });
    let pending;
    try { pending = probe.prepare("SELECT 1 FROM migration_progress WHERE kind = ?").get(kind); }
    finally { probe.close(); }
    if (!pending) return;
    assert.ok(Date.now() < deadline, `${kind} lookup migration did not resume after restart`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("persists settings, spaces, conversations, messages, runs, and search", () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    assert.equal(database.updateSettings({ provider: "claude", maxConcurrentRuns: 5 }).provider, "claude");
    const space = database.createSpace("Client work");
    database.setProjectSpace("project-1", space.id);
    assert.equal(database.listSpaces().memberships["project-1"], space.id);

    const conversation = database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Durable chat", provider: "codex" });
    const message = database.addMessage({ conversationId: conversation.id, role: "user", body: "Find the scanner boundary" });
    assert.equal(database.listMessages(conversation.id)[0].id, message.id);

    const run = database.createRun({ conversationId: conversation.id, provider: "codex", reasoningEffort: "high", approvalPolicy: "workspace-write", prompt: message.body });
    database.appendRunEvent(run.id, "run.started", { ok: true });
    database.updateRun(run.id, { status: "completed", inputTokens: 120, outputTokens: 45 });
    assert.equal(database.listRunEvents(run.id)[0].payload.ok, true);
    assert.equal(database.getRun(run.id).outputTokens, 45);
    assert.equal(database.getRun(run.id).reasoningEffort, "high");
    assert.equal(database.search("scanner").conversations[0].id, conversation.id);
    const moved = database.moveConversation(conversation.id, { projectId: "project-2", worktreeId: "tree-2", worktreePath: "/tmp/tree-2" });
    assert.equal(moved.worktreeId, "tree-2");
    assert.equal(database.listConversations({ projectId: "project-1" }).length, 0);
  } finally {
    database.close();
  }
});

test("global search bounds recent text and response bytes while keeping conversation Find available", async () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    const old = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "Old", provider: "codex" });
    database.addMessage({ conversationId: old.id, role: "assistant", body: "old-needle" });
    const current = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "Current", provider: "codex" });
    for (let index = 0; index < 260; index += 1) {
      database.addMessage({ conversationId: current.id, role: "assistant", body: `filler ${index}` });
    }
    const large = database.addMessage({ conversationId: current.id, role: "assistant", body: `large-needle ${"x".repeat(4 * 1024 * 1024)}` });
    database.addMessage({ conversationId: current.id, role: "assistant", body: "recent-needle" });
    for (let index = 0; index < 12; index += 1) {
      const result = database.search("recent-needle");
      assert.deepEqual(result.conversations.map((item) => item.id), [current.id]);
      assert.equal(result.partial, true);
      assert.ok(Buffer.byteLength(JSON.stringify(result)) < 4096, "search returned retained body text");
      assert.equal(database.search("old-needle").conversations.length, 0, "scan crossed the recent candidate budget");
      assert.equal(database.search("large-needle").conversations.length, 0, "large body entered the synchronous scan");
    }
    assert.equal((await database.findMessagePage(current.id, "large-needle", null)).matchId, large.id);
    assert.equal(database.search("Current").conversations[0].id, current.id);
    assert.equal(database.search("recent%needle").conversations.length, 0, "LIKE wildcard was treated as query syntax");
    database.addMessage({ conversationId: current.id, role: "assistant", body: "literal path\\needle and under_score" });
    const distractor = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "Distractor", provider: "codex" });
    database.addMessage({ conversationId: distractor.id, role: "assistant", body: "under-score" });
    assert.deepEqual(database.search("path\\needle").conversations.map((item) => item.id), [current.id]);
    assert.deepEqual(database.search("under_score").conversations.map((item) => item.id), [current.id],
      "an underscore must not match the recent hyphen distractor as a LIKE wildcard");
    assert.throws(() => database.search("x".repeat(257)), (error) => error.statusCode === 400);
  } finally { database.close(); }
});

test("global search reaches live siblings behind a deferred hidden archive across restart", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-visible-search-"));
  const filename = path.join(directory, "outright.db");
  let database = createOutrightDatabase({ filename });
  try {
    const live = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "visible-title-needle", provider: "codex" });
    database.addMessage({ conversationId: live.id, role: "assistant", body: "visible-message-needle" });
    const running = database.createRun({ conversationId: live.id, provider: "codex", approvalPolicy: "read-only", prompt: "keep archive deferred" });
    database.updateRun(running.id, { status: "running" });
    const archived = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "hidden-title-needle", provider: "codex" });
    database.addMessage({ conversationId: archived.id, role: "assistant", body: "hidden-message-needle " + "x".repeat(300 * 1024) });
    for (let index = 0; index < 300; index += 1) database.addMessage({ conversationId: archived.id, role: "assistant", body: `hidden filler ${index}` });
    database.updateConversation(archived.id, { archived: true });
    const deletion = await database.deleteArchivedConversation(archived.id, archived.id);
    assert.equal(deletion.deferred, true);
    for (let round = 0; round < 4; round += 1) {
      assert.deepEqual(database.search("visible-message-needle").conversations.map((row) => row.id), [live.id]);
      assert.deepEqual(database.search("visible-title-needle").conversations.map((row) => row.id), [live.id]);
      assert.deepEqual(database.search("hidden-message-needle").conversations, []);
    }
    await database.close();
    database = createOutrightDatabase({ filename });
    assert.equal(database.getConversation(live.id)?.id, live.id);
    assert.deepEqual(database.search("visible-message-needle").conversations.map((row) => row.id), [live.id]);
    assert.deepEqual(database.search("visible-title-needle").conversations.map((row) => row.id), [live.id]);
    assert.deepEqual(database.search("hidden-title-needle").conversations, []);
    database.updateRun(running.id, { status: "completed" });
    const deadline = Date.now() + 5_000;
    while (true) {
      let remains = true;
      if (!database.maintenanceActive) {
        try {
          const probe = new Database(filename, { readonly: true, fileMustExist: true });
          try { remains = Boolean(probe.prepare("SELECT 1 FROM conversations WHERE id = ?").get(archived.id)); }
          finally { probe.close(); }
        } catch (error) {
          if (error.code !== "SQLITE_CANTOPEN" || !database.maintenanceActive) throw error;
        }
      }
      if (!remains && !database.maintenanceActive) break;
      assert.ok(Date.now() < deadline, "deferred cleanup did not resume after the active run finished");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(database.search("visible-message-needle").conversations.map((row) => row.id), [live.id]);
  } finally { await database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("global search includes the newest message in an older visible conversation", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-recent-search-"));
  const filename = path.join(directory, "outright.db");
  let database = createOutrightDatabase({ filename });
  try {
    const oldest = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "old chat", provider: "codex" });
    for (let index = 0; index < 256; index += 1) {
      const newer = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: `new chat ${index}`, provider: "codex" });
      database.addMessage({ conversationId: newer.id, role: "assistant", body: `filler ${index}` });
    }
    database.addMessage({ conversationId: oldest.id, role: "assistant", body: "fallback-active-needle" });
    const fresh = database.addMessage({ conversationId: oldest.id, role: "assistant", body: "fresh-active-needle" });
    const durations = [];
    for (let round = 0; round < 8; round += 1) {
      const started = process.cpuUsage();
      const result = database.search("fresh-active-needle");
      durations.push(cpuMilliseconds(started));
      assert.deepEqual(result.conversations.map((row) => row.id), [oldest.id]);
      assert.ok(Buffer.byteLength(JSON.stringify(result)) < 4096);
    }
    assert.ok(durations.sort((a, b) => a - b)[4] < 250, "repeated global searches consumed too much CPU");
    await database.close();
    // Model an upgrade from a store that predates the global head lookup.
    // The backfill must resume after an interrupted, bounded first page.
    const oldStore = new Database(filename);
    oldStore.exec(`DROP TRIGGER search_heads_message_insert;
      DROP TRIGGER search_heads_message_delete;
      DROP TRIGGER search_heads_conversation_update;
      DROP TRIGGER search_heads_conversation_delete;
      DROP TABLE search_message_heads`);
    oldStore.close();
    database = createOutrightDatabase({ filename });
    await new Promise((resolve) => setImmediate(resolve));
    const partial = new Database(filename, { readonly: true });
    try {
      const cursor = partial.prepare("SELECT cursor_number AS cursor FROM migration_progress WHERE kind = 'search-heads'").get()?.cursor;
      assert.ok(cursor > 0 && cursor < 257, "head lookup migration did not advance in a bounded page");
    } finally { partial.close(); }
    await database.close();
    database = createOutrightDatabase({ filename });
    await waitForSearchMigration(filename, "search-heads");
    assert.deepEqual(database.search("fresh-active-needle").conversations.map((row) => row.id), [oldest.id]);
    const writer = new Database(filename);
    try { writer.prepare("DELETE FROM messages WHERE id = ?").run(fresh.id); }
    finally { writer.close(); }
    assert.deepEqual(database.search("fresh-active-needle").conversations, []);
    assert.deepEqual(database.search("fallback-active-needle").conversations.map((row) => row.id), [oldest.id]);
  } finally { await database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("title search follows recent activity in an old chat after an interrupted lookup migration", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-title-search-"));
  const filename = path.join(directory, "outright.db");
  let database = createOutrightDatabase({ filename });
  try {
    const oldest = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "old title", provider: "codex" });
    for (let index = 0; index < 256; index += 1) {
      database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: `new title ${index}`, provider: "codex" });
    }
    database.updateConversation(oldest.id, { title: "recent-renamed-needle" });
    assert.deepEqual(database.search("recent-renamed-needle").conversations.map((row) => row.id), [oldest.id]);
    await database.close();
    const legacy = new Database(filename);
    try {
      legacy.exec(`DROP TRIGGER search_titles_insert; DROP TRIGGER search_titles_update;
        DROP TRIGGER search_titles_delete; DROP TABLE search_recent_titles`);
    } finally { legacy.close(); }
    database = createOutrightDatabase({ filename });
    await new Promise((resolve) => setImmediate(resolve));
    const partial = new Database(filename, { readonly: true });
    try {
      const cursor = partial.prepare("SELECT cursor_number AS cursor FROM migration_progress WHERE kind = 'search-titles'").get()?.cursor;
      assert.ok(cursor > 0 && cursor < 257, "title lookup migration did not stop at a bounded cursor");
    } finally { partial.close(); }
    await database.close();
    database = createOutrightDatabase({ filename });
    await waitForSearchMigration(filename, "search-titles");
    for (let round = 0; round < 8; round += 1) {
      const result = database.search("recent-renamed-needle");
      assert.deepEqual(result.conversations.map((row) => row.id), [oldest.id]);
      assert.ok(Buffer.byteLength(JSON.stringify(result)) < 4096);
    }
  } finally { await database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("conversation find reaches old and new pages, wraps, and treats query text literally", async () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    const chat = database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Long", provider: "codex" });
    const other = database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Other", provider: "codex" });
    const ids = [];
    for (let index = 0; index < 240; index += 1) ids.push(database.addMessage({ conversationId: chat.id, role: "user", body: index === 0 ? "literal wildcard marker" : index === 2 || index === 238 ? "literal % marker" : `filler ${index}` }).id);
    database.addMessage({ conversationId: other.id, role: "user", body: "literal % marker" });
    const first = await database.findMessagePage(chat.id, "literal %", null);
    assert.equal(first.matchId, ids[2]);
    assert.ok(first.messages.some((message) => message.id === ids[2]));
    assert.ok(first.messages.length <= 200);
    const last = await database.findMessagePage(chat.id, "literal %", first.matchId);
    assert.equal(last.matchId, ids[238]);
    assert.equal((await database.findMessagePage(chat.id, "literal %", last.matchId)).matchId, ids[2], "next wraps across the full conversation");
    assert.equal((await database.findMessagePage(chat.id, "literal %", ids[2], -1)).matchId, ids[238], "previous wraps backwards");
    assert.equal((await database.findMessagePage(chat.id, "no such text", null)).matchId, null);
    await assert.rejects(database.findMessagePage(chat.id, "marker", "not-a-message"), /cursor/);
  } finally { database.close(); }
});

test("conversation Find folds final and medial sigma through persisted sections and wrap", async () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    const chat = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "Sigma", provider: "codex" });
    const final = database.addMessage({ conversationId: chat.id, role: "user", body: `prefix ${"x".repeat(65_528)}ΟΣ suffix` });
    const medial = database.addMessage({ conversationId: chat.id, role: "user", body: "ΑΣΑ" });
    const first = await database.findMessagePage(chat.id, "Σ", null);
    assert.equal(first.matchId, final.id);
    assert.ok(first.messages.find((message) => message.id === final.id).body.includes("ΟΣ"), "Find excerpt lost the matched final sigma");
    assert.equal((await database.findMessagePage(chat.id, "σ", final.id)).matchId, medial.id);
    assert.equal((await database.findMessagePage(chat.id, "ς", medial.id)).matchId, final.id, "forward Find did not wrap");
    assert.equal((await database.findMessagePage(chat.id, "Σ", final.id, -1)).matchId, medial.id, "reverse Find did not wrap");
    assert.equal((await database.findMessagePage(chat.id, "ΟΣ", medial.id)).matchId, final.id);
  } finally { database.close(); }
});

test("conversation Find preserves full-fold expansions across sections and wrap", async () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    const chat = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "Case fold", provider: "codex" });
    const first = database.addMessage({ conversationId: chat.id, role: "user", body: `${"x".repeat(65_532)}Straße marker` });
    const second = database.addMessage({ conversationId: chat.id, role: "user", body: "STRASSE marker" });
    const ligature = database.addMessage({ conversationId: chat.id, role: "user", body: "ﬃ ligature" });
    const found = await database.findMessagePage(chat.id, "STRASSE", null);
    assert.equal(found.matchId, first.id);
    assert.ok(found.messages.find((message) => message.id === first.id)?.body.includes("Straße"));
    assert.equal((await database.findMessagePage(chat.id, "straße", first.id)).matchId, second.id);
    assert.equal((await database.findMessagePage(chat.id, "STRASSE", second.id)).matchId, first.id);
    assert.equal((await database.findMessagePage(chat.id, "strasse", first.id, -1)).matchId, second.id);
    assert.equal((await database.findMessagePage(chat.id, "FFI", null)).matchId, ligature.id);
  } finally { database.close(); }
});

test("full-fold Find keeps its match across a bounded byte continuation", async () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    const chat = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "Case fold continuation", provider: "codex" });
    const row = database.addMessage({ conversationId: chat.id, role: "assistant", body: `${"x".repeat(8 * 1024 * 1024)}Straße` });
    const first = await database.findMessagePage(chat.id, "STRASSE", null);
    assert.equal(first.partial, true);
    assert.equal(first.nextAfterId, row.id);
    const continued = await database.findMessagePage(chat.id, "STRASSE", first.nextAfterId, 1, undefined,
      { originId: first.originId, wrapped: first.wrapped, byteOffset: first.nextByteOffset });
    assert.equal(continued.matchId, row.id);
    assert.ok(continued.messages.find((message) => message.id === row.id)?.body.includes("Straße"));
  } finally { database.close(); }
});

test("persisted Find uses deterministic Unicode keys across case variants", async () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    const chat = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "Locale", provider: "codex" });
    const first = database.addMessage({ conversationId: chat.id, role: "user", body: "I token" });
    const second = database.addMessage({ conversationId: chat.id, role: "user", body: "ΟΣ final" });
    assert.equal((await database.findMessagePage(chat.id, "i token", null)).matchId, first.id);
    assert.equal((await database.findMessagePage(chat.id, "Σ", first.id)).matchId, second.id);
    assert.equal((await database.findMessagePage(chat.id, "i token", second.id)).matchId, first.id);
  } finally { database.close(); }
});

test("conversation Find bounds hydrated neighbors and keeps page cursors exact", async () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    const chat = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "Large Find", provider: "codex" });
    const ids = Array.from({ length: 32 }, (_, index) => database.addMessage({ conversationId: chat.id,
      role: "assistant", body: `${index === 16 ? "unique needle " : ""}${"x".repeat(1024 * 1024)}`,
      payload: { runId: `run-${index}`, detail: "y".repeat(1024 * 1024) } }).id);
    const result = await database.findMessagePage(chat.id, "unique needle", ids[15]);
    assert.equal(result.matchId, ids[16]);
    assert.ok(result.messages.some((message) => message.id === ids[16]));
    assert.equal(result.messages.find((message) => message.id === ids[16]).payload.runId, "run-16",
      "Find dropped bounded run metadata while excerpting a large body");
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 8 * 1024 * 1024 + 1024, "Find hydrated too much context");
    assert.equal(result.messagePage.olderCount + result.messages.length + result.messagePage.newerCount, 32);
    assert.equal(result.messagePage.beforeId, result.messages[0].id);
    const older = database.listMessagePage(chat.id, { beforeId: result.messages[0].id });
    const newer = database.listMessagePage(chat.id, { afterId: result.messages.at(-1).id });
    assert.equal(older.page.total, 32);
    assert.equal(newer.page.total, 32);
    const hugeMatch = database.addMessage({ conversationId: chat.id, role: "assistant",
      body: `${"a".repeat(5 * 1024 * 1024)}unique huge needle${"b".repeat(5 * 1024 * 1024)}` });
    const huge = await database.findMessagePage(chat.id, "unique huge needle", ids.at(-1));
    assert.equal(huge.matchId, hugeMatch.id);
    assert.equal(huge.messages.find((message) => message.id === hugeMatch.id).findExcerpt, true);
    assert.ok(huge.messages.find((message) => message.id === hugeMatch.id).body.includes("unique huge needle"));
    assert.ok(huge.messages.find((message) => message.id === hugeMatch.id).body.length < 16_000,
      "Find transfers only the context that a bounded client row can retain");
    assert.ok(Buffer.byteLength(JSON.stringify(huge)) <= 8 * 1024 * 1024 + 1024);
    const firstChunk = database.getMessageBodyChunk(chat.id, hugeMatch.id, 0);
    assert.equal(firstChunk.body.length, 65536);
    assert.equal(firstChunk.hasMore, true);
    const lastChunk = database.getMessageBodyChunk(chat.id, hugeMatch.id, firstChunk.totalBytes - 100);
    assert.equal(lastChunk.body, "b".repeat(100));
    assert.equal(lastChunk.hasMore, false);
    const unicode = database.addMessage({ conversationId: chat.id, role: "assistant", body: "🙂".repeat(65537) });
    const unicodeFirst = database.getMessageBodyChunk(chat.id, unicode.id, 0);
    const unicodeLast = database.getMessageBodyChunk(chat.id, unicode.id, unicodeFirst.nextOffset);
    assert.equal(unicodeFirst.nextOffset, 65536);
    assert.equal(unicodeLast.body, "🙂".repeat(16384));
    let section = unicodeLast;
    let reconstructed = unicodeFirst.body + unicodeLast.body;
    while (section.hasMore) {
      section = database.getMessageBodyChunk(chat.id, unicode.id, section.nextOffset);
      reconstructed += section.body;
    }
    assert.equal(reconstructed, "🙂".repeat(65537));
    const nul = database.addMessage({ conversationId: chat.id, role: "assistant", body: `start\0${"🙂".repeat(20000)}\0end` });
    let cursor = 0;
    let complete = "";
    do {
      const part = database.getMessageBodyChunk(chat.id, nul.id, cursor);
      assert.ok(Buffer.byteLength(part.body) <= 65536);
      assert.ok(part.nextOffset > cursor);
      complete += part.body;
      cursor = part.nextOffset;
    } while (cursor < database.getMessageBodyChunk(chat.id, nul.id, 0).totalBytes);
    assert.equal(complete, `start\0${"🙂".repeat(20000)}\0end`);
    assert.equal(database.getMessageBodyChunk(chat.id, "foreign", 0), null);
  } finally { database.close(); }
});

test("oversized Find bodies resume by byte before a match or miss without blocking other work", async () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    const chat = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "Large body", provider: "codex" });
    const other = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "Other", provider: "codex" });
    const first = database.addMessage({ conversationId: chat.id, role: "user", body: "wrap target" });
    const body = `${"a".repeat(16 * 1024 * 1024 + 65_534)}CAFÉ\0tail needle${"z".repeat(1024 * 1024)}`;
    const huge = database.addMessage({ conversationId: chat.id, role: "assistant", body });
    database.addMessage({ conversationId: other.id, role: "assistant", body: "foreign token" });
    let timerTicks = 0;
    const timer = setInterval(() => { timerTicks += 1; }, 1);
    try {
      let competingWorkRan = false;
      setImmediate(() => { competingWorkRan = true; });
      let result = await database.findMessagePage(chat.id, "tail needle", first.id);
      assert.equal(competingWorkRan, true, "oversized Find did not yield to concurrent work before returning its first continuation");
      assert.equal(result.partial, true, "a matching oversized row must stop before hydrating its full body");
      assert.equal(result.nextAfterId, huge.id);
      assert.ok(result.nextByteOffset > 0 && result.nextByteOffset <= 8 * 1024 * 1024);
      let requests = 1;
      while (result.partial) {
        const prior = result.nextByteOffset;
        result = await database.findMessagePage(chat.id, "tail needle", result.nextAfterId, 1, undefined,
          { originId: result.originId, wrapped: result.wrapped, byteOffset: prior });
        requests += 1;
        assert.ok(requests <= 4, "oversized match continuation did not converge");
        if (result.partial) assert.ok(result.nextByteOffset > prior);
      }
      assert.equal(result.matchId, huge.id);
      assert.ok(result.messages.find((message) => message.id === huge.id).body.includes("CAFÉ\0tail needle"));
      assert.ok(Buffer.byteLength(JSON.stringify(result)) < 8 * 1024 * 1024);

      let miss = await database.findMessagePage(chat.id, "absent term", first.id);
      let missRequests = 1;
      while (miss.partial) {
        miss = await database.findMessagePage(chat.id, "absent term", miss.nextAfterId, 1, undefined,
          { originId: miss.originId, wrapped: miss.wrapped, byteOffset: miss.nextByteOffset ?? 0 });
        assert.ok(++missRequests <= 5, "oversized no-match continuation did not converge");
      }
      assert.equal(miss.matchId, null);
      let unicode = await database.findMessagePage(chat.id, "café", first.id);
      assert.equal(unicode.partial, true);
      while (unicode.partial) unicode = await database.findMessagePage(chat.id, "café", unicode.nextAfterId, 1, undefined,
        { originId: unicode.originId, wrapped: unicode.wrapped, byteOffset: unicode.nextByteOffset ?? 0 });
      assert.equal(unicode.matchId, huge.id, "a Unicode match crossing a byte section was skipped");
      let foreign = await database.findMessagePage(chat.id, "foreign token", null);
      while (foreign.partial) foreign = await database.findMessagePage(chat.id, "foreign token", foreign.nextAfterId, 1, undefined,
        { originId: foreign.originId, wrapped: foreign.wrapped, byteOffset: foreign.nextByteOffset ?? 0 });
      assert.equal(foreign.matchId, null);
      assert.equal((await database.findMessagePage(chat.id, "wrap target", huge.id)).matchId, first.id);
      const abort = new AbortController();
      const pending = database.findMessagePage(chat.id, "absent term", first.id, 1, abort.signal);
      abort.abort();
      assert.equal((await pending).matchId, null);
    } finally { clearInterval(timer); }
    assert.ok(timerTicks > 0, "large body scan held the event loop");
  } finally { database.close(); }
});

test("Find folds sigma variants across Unicode context, completes wrapped exact-budget rows, and returns readable excerpts", async () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    const chat = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "Unicode edges", provider: "codex" });
    const sigma = database.addMessage({ conversationId: chat.id, role: "assistant", body: `${"a".repeat(65534)}ΣA` });
    assert.equal((await database.findMessagePage(chat.id, "ς", null)).matchId, sigma.id);
    assert.equal((await database.findMessagePage(chat.id, "σ", null)).matchId, sigma.id);
    const markedSigma = database.addMessage({ conversationId: chat.id, role: "assistant",
      body: `${"a".repeat(65534)}Σ${"\u0301".repeat(12)}A` });
    assert.equal((await database.findMessagePage(chat.id, "ς", sigma.id)).matchId, markedSigma.id);
    assert.equal((await database.findMessagePage(chat.id, "σ", sigma.id)).matchId, markedSigma.id);
    const longMarks = database.addMessage({ conversationId: chat.id, role: "assistant",
      body: `${"a".repeat(65534)}Σ${"\u0301".repeat(600)}A` });
    assert.equal((await database.findMessagePage(chat.id, "ς", markedSigma.id)).matchId, longMarks.id);
    assert.equal((await database.findMessagePage(chat.id, "σ", markedSigma.id)).matchId, longMarks.id);
    const leftChat = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "Left context", provider: "codex" });
    const leftMarks = database.addMessage({ conversationId: leftChat.id, role: "assistant",
      body: `A${"\u0301".repeat(33_000)}Σ.` });
    assert.equal((await database.findMessagePage(leftChat.id, "σ", null)).matchId, leftMarks.id);
    assert.equal((await database.findMessagePage(leftChat.id, "ς", null)).matchId, leftMarks.id);

    const body = `${"x".repeat(10000)}🙂${"x".repeat(7499)}xneedle${"x".repeat(7499)}🙂${"x".repeat(100000)}`;
    const large = database.addMessage({ conversationId: chat.id, role: "assistant", body });
    const result = await database.findMessagePage(chat.id, "xneedle", longMarks.id);
    const excerpt = result.messages.find((message) => message.id === large.id);
    assert.equal(result.matchId, large.id);
    assert.equal(excerpt.findExcerpt, true);
    assert.ok(excerpt.body.includes("xneedle"));
    assert.equal(excerpt.body.includes("\uFFFD"), false, "the bounded excerpt split a UTF-8 code point");
    assert.ok(Buffer.byteLength(excerpt.body) < 16_000);
    assert.equal(database.getMessageBodyChunk(chat.id, large.id, 0).totalBytes, Buffer.byteLength(body),
      "the complete body remains available by identity");

    const exactChat = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "Exact budget", provider: "codex" });
    const exact = database.addMessage({ conversationId: exactChat.id, role: "assistant", body: "z".repeat(8 * 1024 * 1024) });
    for (const direction of [1, -1]) {
      const ended = await database.findMessagePage(exactChat.id, "missing", exact.id, direction);
      assert.equal(ended.matchId, null, "a wrapped origin ending at the exact byte budget must complete");
      assert.equal(ended.partial, undefined);
    }
  } finally { database.close(); }
});

test("Find continues Unicode context across a full byte budget", async () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    const chat = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "Long context", provider: "codex" });
    const row = database.addMessage({ conversationId: chat.id, role: "assistant",
      body: `${"a".repeat(65534)}Σ${"\u0301".repeat(4_300_000)}A` });
    for (const direction of [1, -1]) {
      for (const [needle, expected] of [["ς", row.id], ["σ", row.id]]) {
        let result = await database.findMessagePage(chat.id, needle, null, direction);
        let lastContext = 0;
        let lastByte = 0;
        let requests = 0;
        while (result.partial) {
          assert.ok((result.nextContextOffset ?? 0) > lastContext || (result.nextByteOffset ?? 0) > lastByte,
            "Unicode context continuation did not advance");
          lastContext = result.nextContextOffset ?? 0;
          lastByte = result.nextByteOffset ?? 0;
          result = await database.findMessagePage(chat.id, needle, result.nextAfterId, direction, undefined,
            { originId: result.originId, wrapped: result.wrapped, byteOffset: result.nextByteOffset, contextOffset: result.nextContextOffset });
          assert.ok(++requests < 5, "Unicode context continuation did not converge");
        }
        assert.equal(result.matchId, expected);
      }
    }
  } finally { database.close(); }
});

test("Find carries both Unicode contexts through separate bounded requests", async () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    const chat = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "Both contexts", provider: "codex" });
    const row = database.addMessage({ conversationId: chat.id, role: "assistant",
      body: `A${"\u0301".repeat(4_300_000)}Σ${"\u0301".repeat(4_300_000)}A` });
    let cursor = { nextAfterId: null, nextByteOffset: 0, nextContextOffset: 0, nextLeftContextOffset: 0 };
    let sawLeft = false;
    let sawRight = false;
    let result;
    for (let request = 0; request < 10; request += 1) {
      result = await database.findMessagePage(chat.id, "σ", cursor.nextAfterId, 1, undefined,
        cursor.nextAfterId ? { originId: null, wrapped: false, byteOffset: cursor.nextByteOffset,
          contextOffset: cursor.nextContextOffset, leftContextOffset: cursor.nextLeftContextOffset,
          leftContextCased: cursor.nextLeftContextCased ?? null } : undefined);
      if (!result.partial) break;
      assert.ok(result.nextAfterId !== cursor.nextAfterId || result.nextByteOffset > cursor.nextByteOffset
        || (result.nextContextOffset ?? 0) > (cursor.nextContextOffset ?? 0)
        || (result.nextLeftContextOffset > 0 && (!cursor.nextLeftContextOffset || result.nextLeftContextOffset < cursor.nextLeftContextOffset)),
      `combined Unicode context cursor did not advance: ${JSON.stringify({ cursor, result })}`);
      sawLeft ||= Boolean(result.nextLeftContextOffset);
      sawRight ||= Boolean(result.nextContextOffset);
      cursor = result;
    }
    assert.equal(result.matchId, row.id);
    assert.equal(sawLeft, true);
    assert.equal(sawRight, true);
  } finally { database.close(); }
});

test("conversation Find skips nullable legacy bodies and preserves NUL text", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-find-null-body-"));
  const filename = path.join(root, "messages.db");
  const legacy = new Database(filename);
  try { legacy.exec(`CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'text', body TEXT, payload TEXT, created_at TEXT NOT NULL)`); }
  finally { legacy.close(); }
  const database = createOutrightDatabase({ filename });
  try {
    const chat = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "Legacy body", provider: "codex" });
    const empty = database.addMessage({ conversationId: chat.id, role: "user", body: "old" });
    const nul = database.addMessage({ conversationId: chat.id, role: "user", body: "before\0CAFÉ after" });
    const raw = new Database(filename);
    try { raw.prepare("UPDATE messages SET body = NULL WHERE id = ?").run(empty.id); }
    finally { raw.close(); }
    assert.equal((await database.findMessagePage(chat.id, "café", null)).matchId, nul.id);
    assert.equal((await database.findMessagePage(chat.id, "missing", null)).matchId, null);
  } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
});

test("ordinary message pages bound bytes and preserve both cursor directions", () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    const chat = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "Large history", provider: "codex" });
    const body = `start\0${"🙂".repeat(270_000)}\0end`;
    const ids = Array.from({ length: 24 }, (_, index) => database.addMessage({ conversationId: chat.id,
      role: "assistant", body, payload: { runId: `run-${index}`, provider: "codex", checkpointEventSeq: index, detail: "x".repeat(1024 * 1024) } }).id);
    const latest = database.listMessagePage(chat.id);
    assert.ok(Buffer.byteLength(JSON.stringify(latest)) <= 8 * 1024 * 1024, "latest page exceeded the serialized byte budget");
    assert.equal(latest.page.total, ids.length);
    assert.equal(latest.page.olderCount + latest.messages.length + latest.page.newerCount, ids.length);
    assert.ok(latest.messages.length < ids.length, "stored bytes bypassed the pre-hydration page cap");
    assert.deepEqual(latest.messages.map((message) => message.id), ids.slice(-latest.messages.length));
    assert.equal(latest.messages[0].findExcerpt, true);
    assert.equal(latest.messages[0].payload.runId, `run-${ids.indexOf(latest.messages[0].id)}`);
    assert.equal(latest.messages[0].payloadOmitted, true);
    assert.equal(latest.messages[0].body.includes("\uFFFD"), false, "inline excerpt split a Unicode character");
    assert.equal(latest.messages[0].body.endsWith("\0end"), true, "inline excerpt hid the latest output tail");
    assert.equal(database.getMessageBodyChunk(chat.id, ids[0], 0).body.startsWith("start\0"), true);
    const backward = [];
    let beforeId;
    do {
      const page = database.listMessagePage(chat.id, { beforeId, limit: 3 });
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 8 * 1024 * 1024);
      backward.unshift(...page.messages.map((message) => message.id));
      beforeId = page.page.beforeId;
      if (!page.page.hasMore) break;
    } while (beforeId);
    assert.deepEqual(backward, ids, "backward paging skipped or repeated an id");
    const forward = [];
    let afterId = ids[0];
    while (afterId !== ids.at(-1)) {
      const page = database.listMessagePage(chat.id, { afterId, limit: 3 });
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 8 * 1024 * 1024);
      assert.ok(page.messages.length > 0, "forward cursor stopped early");
      forward.push(...page.messages.map((message) => message.id));
      afterId = page.messages.at(-1).id;
    }
    assert.deepEqual(forward, ids.slice(1), "forward paging skipped or repeated an id");

    const cumulative = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "Many medium rows", provider: "codex" });
    const mediumBody = "b".repeat(60_000);
    const mediumPayload = { detail: "p".repeat(60_000) };
    const mediumIds = Array.from({ length: 100 }, () => database.addMessage({ conversationId: cumulative.id,
      role: "assistant", body: mediumBody, payload: mediumPayload }).id);
    const boundedLatest = database.listMessagePage(cumulative.id);
    assert.ok(boundedLatest.messages.length < mediumIds.length, "the page ignored its cumulative byte cap");
    assert.ok(Buffer.byteLength(JSON.stringify(boundedLatest)) <= 8 * 1024 * 1024);
    assert.deepEqual(boundedLatest.messages.map((message) => message.id), mediumIds.slice(-boundedLatest.messages.length));
    const boundedOlder = database.listMessagePage(cumulative.id, { beforeId: boundedLatest.page.beforeId });
    assert.deepEqual([...boundedOlder.messages.map((message) => message.id), ...boundedLatest.messages.map((message) => message.id)], mediumIds);

    const huge = database.addMessage({ conversationId: cumulative.id, role: "assistant", body: "large payload body",
      payload: { runId: "too-large-to-parse-inline", detail: "q".repeat(9 * 1024 * 1024) } });
    const hugePage = database.listMessagePage(cumulative.id);
    assert.deepEqual(hugePage.messages.map((message) => message.id), [huge.id]);
    assert.equal(hugePage.messages[0].payloadOmitted, true);
    assert.ok(Buffer.byteLength(JSON.stringify(hugePage)) < 8 * 1024 * 1024);
  } finally { database.close(); }
});

test("nullable legacy payloads obey Find's byte cap and preserve both cursor edges", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-find-null-"));
  const filename = path.join(root, "messages.db");
  const database = createOutrightDatabase({ filename });
  try {
    const chat = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "Legacy", provider: "codex" });
    const ids = Array.from({ length: 20 }, (_, index) => database.addMessage({ conversationId: chat.id, role: "user",
      body: `${index === 10 ? "needle " : ""}${"x".repeat(1024 * 1024)}` }).id);
    const legacy = new Database(filename);
    try { legacy.prepare("UPDATE messages SET payload = NULL WHERE conversation_id = ?").run(chat.id); }
    finally { legacy.close(); }
    const found = await database.findMessagePage(chat.id, "needle", ids[9]);
    assert.equal(found.matchId, ids[10]);
    assert.ok(Buffer.byteLength(JSON.stringify(found)) <= 8 * 1024 * 1024 + 1024);
    const first = ids.indexOf(found.messages[0].id);
    const last = ids.indexOf(found.messages.at(-1).id);
    assert.deepEqual(found.messages.map((message) => message.id), ids.slice(first, last + 1));
    assert.equal(found.messagePage.olderCount, first);
    assert.equal(found.messagePage.newerCount, 19 - last);
    assert.equal(database.listMessagePage(chat.id, { beforeId: found.messages[0].id, limit: 1 }).messages[0]?.id, ids[first - 1]);
    assert.equal(database.listMessagePage(chat.id, { afterId: found.messages.at(-1).id, limit: 1 }).messages[0]?.id, ids[last + 1]);
  } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
});

test("forward message pages continue from a found page with exact persisted counts", () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    const chat = database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Long", provider: "codex" });
    const sibling = database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Sibling", provider: "codex" });
    const ids = Array.from({ length: 405 }, (_, index) => database.addMessage({ conversationId: chat.id, role: "user", body: `row ${index}` }).id);
    database.addMessage({ conversationId: sibling.id, role: "user", body: "sibling" });
    const first = database.listMessagePage(chat.id, { afterId: ids[4], limit: 200 });
    assert.deepEqual(first.messages.map((message) => message.id), ids.slice(5, 205));
    assert.deepEqual([first.page.olderCount, first.page.newerCount, first.page.total], [5, 200, 405]);
    const second = database.listMessagePage(chat.id, { afterId: first.messages.at(-1).id, limit: 200 });
    assert.deepEqual(second.messages.map((message) => message.id), ids.slice(205));
    assert.deepEqual([second.page.olderCount, second.page.newerCount], [205, 0]);
    const exhausted = database.listMessagePage(chat.id, { afterId: ids.at(-1), limit: 200 });
    assert.deepEqual(exhausted.messages, []);
    assert.deepEqual([exhausted.page.olderCount, exhausted.page.newerCount, exhausted.page.hasLater], [405, 0, false]);
    assert.equal(database.messageCount(chat.id), 405);
    assert.throws(() => database.listMessagePage(chat.id, { afterId: "foreign" }), /cursor/);
    assert.throws(() => database.listMessagePage(chat.id, { afterId: ids[0], beforeId: ids[2] }), /one message cursor/);
  } finally { database.close(); }
});

test("conversation find folds Unicode consistently across old and new pages", async () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    const chat = database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Unicode", provider: "codex" });
    const old = database.addMessage({ conversationId: chat.id, role: "user", body: "CAFÉ ÉTÉ" });
    for (let index = 0; index < 205; index += 1) database.addMessage({ conversationId: chat.id, role: "user", body: `filler ${index}` });
    const recent = database.addMessage({ conversationId: chat.id, role: "user", body: "Café été" });
    assert.equal((await database.findMessagePage(chat.id, "café", null)).matchId, old.id);
    assert.equal((await database.findMessagePage(chat.id, "CAFÉ", old.id)).matchId, recent.id);
    assert.equal((await database.findMessagePage(chat.id, "ÉTÉ", recent.id, -1)).matchId, old.id);
  } finally { database.close(); }
});

test("large no-match find yields to other requests and stays in its conversation", async () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    const chat = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "Large", provider: "codex" });
    const siblings = Array.from({ length: 24 }, (_, index) => database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: `Sibling ${index}`, provider: "codex" }));
    for (let index = 0; index < 512; index += 1) {
      database.addMessage({ conversationId: chat.id, role: "assistant", body: "A".repeat(64 * 1024) });
      if (index % 16 === 0) database.addMessage({ conversationId: siblings[index % siblings.length].id, role: "assistant", body: "unique sibling token" });
    }
    let ticks = 0;
    let maximumGapMs = 0;
    let lastTick = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      maximumGapMs = Math.max(maximumGapMs, now - lastTick);
      lastTick = now;
      ticks += 1;
    }, 1);
    try {
      let result = await database.findMessagePage(chat.id, "unique sibling token", null);
      assert.equal(result.partial, true, "one request must stop after its text budget");
      assert.ok(result.nextAfterId, "a partial result must provide a durable resume cursor");
      let requests = 1;
      while (result.partial && requests < 100) {
        const previousCursor = result.nextAfterId;
        result = await database.findMessagePage(chat.id, "unique sibling token", result.nextAfterId, 1, undefined, { originId: result.originId, wrapped: result.wrapped });
        requests += 1;
        assert.notEqual(result.nextAfterId, previousCursor, "continuation must advance when still partial");
      }
      assert.ok(requests < 100, "continuation must finish within a bounded number of requests");
      assert.equal(result.matchId, null);
    } finally { clearInterval(timer); }
    assert.ok(ticks >= 1, `Search blocked the event loop: ${ticks} timer ticks`);
    assert.ok(maximumGapMs < 100, `Search blocked event delivery for ${maximumGapMs.toFixed(1)}ms`);
    assert.ok((await database.findMessagePage(siblings[0].id, "unique sibling token", null)).matchId, "Find lost another conversation's match");
  } finally { database.close(); }
});

test("bounded find resumes across an end wrap without skipping an older match", async () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    const chat = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "Resume", provider: "codex" });
    const ids = [];
    for (let index = 0; index < 3_000; index += 1) ids.push(database.addMessage({ conversationId: chat.id, role: "user", body: index === 2_500 ? "far needle" : "filler" }).id);
    let result = await database.findMessagePage(chat.id, "needle", ids[2_600]);
    assert.equal(result.partial, true, "the first request scanned beyond its row budget");
    let requests = 1;
    while (result.partial) {
      result = await database.findMessagePage(chat.id, "needle", result.nextAfterId, 1, undefined, { originId: result.originId, wrapped: result.wrapped });
      requests += 1;
      assert.ok(requests <= 8, "continuation did not advance through the bounded scan");
    }
    assert.equal(result.matchId, ids[2_500]);
  } finally { database.close(); }
});

test("sparse conversation search stays responsive with a large sibling history", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-sparse-find-"));
  const filename = path.join(directory, "history.db");
  const database = createOutrightDatabase({ filename });
  try {
    const target = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "Target", provider: "codex" });
    const sibling = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "Sibling", provider: "codex" });
    const first = database.addMessage({ conversationId: target.id, role: "assistant", body: "needle first" });
    const bulk = new Database(filename);
    try {
      const insert = bulk.prepare("INSERT INTO messages (id, conversation_id, role, body, created_at) VALUES (?, ?, 'assistant', 'unrelated body', '2026-09-26')");
      bulk.transaction(() => { for (let index = 0; index < 500_000; index += 1) insert.run(`sibling-${index}`, sibling.id); })();
    } finally { bulk.close(); }
    const last = database.addMessage({ conversationId: target.id, role: "assistant", body: "needle last" });
    const durations = [];
    for (let index = 0; index < 3; index += 1) {
      const started = process.cpuUsage();
      assert.equal((await database.findMessagePage(target.id, "absent", null)).matchId, null);
      durations.push(cpuMilliseconds(started));
    }
    assert.ok(durations.sort((a, b) => a - b)[1] < 250, `Sparse search consumed too much CPU: ${durations.map((value) => value.toFixed(1)).join(", ")}ms`);
    const pageStarted = process.cpuUsage();
    assert.equal(database.listMessagePage(target.id, { beforeId: last.id, limit: 1 }).messages[0].id, first.id);
    assert.ok(cpuMilliseconds(pageStarted) < 250, "Sparse history pagination scanned sibling messages");
    assert.equal((await database.findMessagePage(target.id, "needle", first.id)).matchId, last.id);
    assert.equal((await database.findMessagePage(target.id, "needle", last.id)).matchId, first.id, "wrapped search crossed sibling history");
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("existing message rows gain indexed search order and new writes preserve it", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-search-migrate-"));
  const filename = path.join(directory, "legacy.db");
  const raw = new Database(filename);
  try {
    raw.exec(`CREATE TABLE conversations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, worktree_id TEXT NOT NULL, worktree_path TEXT NOT NULL,
      title TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', provider_session_id TEXT, tab_position INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'text', body TEXT NOT NULL DEFAULT '', payload TEXT, created_at TEXT NOT NULL);
      INSERT INTO conversations (id, project_id, worktree_id, worktree_path, title, provider, created_at, updated_at)
        VALUES ('old-chat', 'p', 'w', '/tmp/w', 'Old', 'codex', '2026-09-26', '2026-09-26');
      INSERT INTO messages (id, conversation_id, role, body, created_at) VALUES ('old-one', 'old-chat', 'user', 'needle', '2026-09-26');`);
  } finally { raw.close(); }
  const database = createOutrightDatabase({ filename });
  try {
    const newer = database.addMessage({ conversationId: "old-chat", role: "user", body: "needle again" });
    assert.equal((await database.findMessagePage("old-chat", "needle", null)).matchId, "old-one");
    assert.equal((await database.findMessagePage("old-chat", "needle", "old-one")).matchId, newer.id);
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("conversation find bounds concurrent scans and releases aborted work", async () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    const chat = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "Scans", provider: "codex" });
    for (let index = 0; index < 100; index += 1) database.addMessage({ conversationId: chat.id, role: "assistant", body: "unmatched body" });
    const controllers = Array.from({ length: 8 }, () => new AbortController());
    const scans = controllers.map((controller) => database.findMessagePage(chat.id, "absent", null, 1, controller.signal));
    await assert.rejects(database.findMessagePage(chat.id, "absent", null), /Too many conversation searches/);
    for (const controller of controllers) controller.abort();
    await Promise.all(scans);
    assert.equal((await database.findMessagePage(chat.id, "absent", null)).matchId, null, "Aborted scans retained a search slot");
  } finally { database.close(); }
});

test("database shutdown cancels a yielding conversation search", async () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  const chat = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "Shutdown", provider: "codex" });
  for (let index = 0; index < 100; index += 1) database.addMessage({ conversationId: chat.id, role: "assistant", body: "unmatched body" });
  const pending = database.findMessagePage(chat.id, "absent", null);
  database.close();
  assert.equal((await pending).matchId, null);
});

test("runs retain immutable worktree ownership and unresolved recovery blocks move or archive", () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    const conversation = database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/original", title: "Recovery owner", provider: "codex" });
    const run = database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "half done" });
    database.updateRun(run.id, { status: "interrupted", recoveryClass: "never-started" });

    assert.equal(database.getRun(run.id).worktreePath, "/tmp/original");
    assert.throws(
      () => database.moveConversation(conversation.id, { projectId: "project-2", worktreeId: "tree-2", worktreePath: "/tmp/destination" }),
      (error) => error?.statusCode === 409 && /before moving/.test(error.message),
    );
    assert.throws(
      () => database.updateConversation(conversation.id, { archived: true }),
      (error) => error?.statusCode === 409 && /before archiving/.test(error.message),
    );
    assert.throws(
      () => database.updateConversation(conversation.id, { archived: 1 }),
      (error) => error?.statusCode === 400 && /must be a boolean/.test(error.message),
    );
    assert.equal(database.getConversation(conversation.id).worktreePath, "/tmp/original");
    assert.equal(database.getConversation(conversation.id).archived, 0);
    assert.equal(database.findUnresolvedInterruptedRunForWorktree("/tmp/original").id, run.id);
    assert.equal(database.findUnresolvedInterruptedRunForWorktree("/tmp/destination"), undefined);

    database.resolveInterruptedRun(run.id, "discard");
    database.moveConversation(conversation.id, { projectId: "project-2", worktreeId: "tree-2", worktreePath: "/tmp/destination" });
    assert.equal(database.getRun(run.id).worktreePath, "/tmp/original", "moving the chat never rewrites the run's launch identity");

    const historicallyMoved = database.createConversation({ projectId: "project-2", worktreeId: "tree-2", worktreePath: "/tmp/destination", title: "Moved during execution", provider: "codex" });
    const originalRun = database.createRun({ conversationId: historicallyMoved.id, worktreePath: "/tmp/original", provider: "codex", approvalPolicy: "read-only", prompt: "started before move" });
    database.updateRun(originalRun.id, { status: "interrupted", recoveryClass: "never-started" });
    const restored = database.moveConversation(historicallyMoved.id, { projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/original" });
    assert.equal(restored.worktreePath, "/tmp/original", "an unresolved owner may move back to its immutable recovery target");
  } finally {
    database.close();
  }
});

test("legacy unresolved runs with unknown launch targets gate every worktree conservatively", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-legacy-run-target-"));
  const filename = path.join(root, "outright.db");
  const legacy = new Database(filename);
  legacy.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, worktree_id TEXT NOT NULL, worktree_path TEXT NOT NULL,
      title TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', provider_session_id TEXT, tab_position INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      provider TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', reasoning_effort TEXT NOT NULL DEFAULT 'medium', approval_policy TEXT NOT NULL, prompt TEXT NOT NULL,
      status TEXT NOT NULL, pid INTEGER, provider_session_id TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
      exit_code INTEGER, error TEXT, cost_usd REAL, input_tokens INTEGER, output_tokens INTEGER,
      recovery_class TEXT, recovery_decision TEXT
    );
    INSERT INTO conversations VALUES ('legacy-conversation', 'project-2', 'tree-2', '/tmp/current-target', 'Legacy recovery', 'codex', '', NULL, 0, 0, 0, '2026-09-21T00:00:00.000Z', '2026-09-21T00:00:00.000Z');
    INSERT INTO runs VALUES ('legacy-interrupted', 'legacy-conversation', 'codex', '', 'medium', 'read-only', 'half done', 'interrupted', NULL, NULL, '2026-09-21T00:00:00.000Z', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'never-started', NULL);
    INSERT INTO runs VALUES ('legacy-completed', 'legacy-conversation', 'codex', '', 'medium', 'read-only', 'done', 'completed', NULL, NULL, '2026-09-20T00:00:00.000Z', NULL, '2026-09-20T00:01:00.000Z', 0, NULL, NULL, NULL, NULL, NULL, NULL);
  `);
  legacy.close();

  let database;
  try {
    database = createOutrightDatabase({ filename });
    assert.equal(database.getRun("legacy-interrupted").worktreePath, null, "migration must not guess a mutable conversation target for unresolved work");
    assert.equal(database.getRun("legacy-completed").worktreePath, "/tmp/current-target", "terminal history may use the current conversation target");
    assert.equal(database.findUnresolvedInterruptedRunForWorktree("/tmp/original-unknown").id, "legacy-interrupted");
    assert.equal(database.findUnresolvedInterruptedRunForWorktree("/tmp/current-target").id, "legacy-interrupted");
  } finally {
    database?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolves a relative data directory to a stable absolute launch path", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-relative-data-"));
  const dataDirectory = path.relative(process.cwd(), path.join(root, "data"));
  let database;
  try {
    database = createOutrightDatabase({ dataDirectory });
    assert.equal(path.isAbsolute(database.filename), true);
    assert.equal(path.isAbsolute(database.launchDirectory), true);
    assert.equal(database.launchDirectory, path.join(realpathSync(path.join(root, "data")), "launches"));
  } finally {
    database?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("reconciles queued and running work as interrupted after a runtime restart", () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    const conversation = database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Recovery", provider: "codex" });
    const queued = database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "queued" });
    const running = database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "running" });
    database.updateRun(running.id, { status: "running", pid: 4242 });
    const result = database.reconcileInterruptedRuns({ probeAlive: () => false });
    assert.equal(result.count, 2);
    assert.equal(result.counts["never-started"], 1);
    assert.equal(result.counts.exited, 1);
    assert.equal(database.getRun(queued.id).status, "interrupted");
    assert.equal(database.getRun(running.id).recoveryClass, "exited");
  } finally {
    database.close();
  }
});

test("legacy interrupted runs reconcile in yielding batches while admission stays fenced", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-run-batches-"));
  const filename = path.join(root, "runtime.db");
  const database = createOutrightDatabase({ filename, runtimeLease: true });
  const raw = new Database(filename);
  try {
    const conversation = database.createConversation({ projectId: "project-1", worktreeId: "tree-1",
      worktreePath: root, title: "Legacy backlog", provider: "codex" });
    const insert = raw.prepare(`INSERT INTO runs (id, conversation_id, worktree_path, provider, approval_policy,
      prompt, status, created_at) VALUES (?, ?, ?, 'codex', 'read-only', '', 'queued', ?)`);
    raw.transaction(() => {
      for (let index = 0; index < 130; index += 1) insert.run(`legacy-${index}`, conversation.id, root, new Date().toISOString());
    })();
    const recovery = database.reconcileInterruptedRuns({ yieldBetweenBatches: true });
    assert.equal(database.canLaunchRun(), false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(raw.prepare("SELECT 1 FROM runs WHERE status = 'queued' LIMIT 1").get(),
      "the event loop did not get a turn between committed recovery batches");
    const result = await recovery;
    assert.equal(result.count, 130);
    assert.equal(raw.prepare("SELECT COUNT(*) AS count FROM runs WHERE status = 'queued'").get().count, 0);
    assert.equal(database.getRun("legacy-129").recoveryClass, "never-started");
  } finally { raw.close(); await database.close(); rmSync(root, { recursive: true, force: true }); }
});

test("malformed terminal recovery evidence is isolated while valid siblings settle", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-invalid-outcome-"));
  const database = createOutrightDatabase({ filename: path.join(root, "outright.db") });
  try {
    const conversation = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: root,
      title: "Recovery", provider: "codex" });
    const run = database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "run" });
    const misbound = database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "misbound" });
    const sibling = database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "sibling" });
    database.updateRun(run.id, { status: "running", pid: 4242 });
    const finishedAt = new Date().toISOString();
    database.savePendingRunOutcome(misbound.id, { status: "completed", finishedAt, exitCode: 0, message: "",
      transcriptMessage: { id: `${misbound.id}:1`, conversationId: "wrong-conversation", role: "assistant",
        kind: "text", body: "not for this chat", payload: { runId: misbound.id }, createdAt: finishedAt } });
    database.savePendingRunOutcome(sibling.id, { status: "completed", finishedAt: new Date().toISOString(), exitCode: 0, message: "" });
    writeFileSync(path.join(database.launchDirectory, `${run.id}.outcome.json`), "{broken");
    const result = database.reconcileInterruptedRuns({ probeAlive: () => false });
    assert.equal(result.counts.unknown, 1);
    assert.equal(result.counts["never-started"], 1);
    assert.equal(result.counts.completed, 1);
    assert.equal(database.getRun(run.id).status, "interrupted");
    assert.equal(database.getRun(run.id).recoveryClass, "unknown");
    assert.equal(database.getRun(misbound.id).recoveryClass, "never-started");
    assert.equal(database.getRun(sibling.id).status, "completed");
    assert.ok(existsSync(path.join(database.launchDirectory, `${run.id}.outcome.json`)));
    assert.ok(existsSync(path.join(database.launchDirectory, `${misbound.id}.outcome.json`)));
    assert.equal(database.listAudit(100).filter((entry) => entry.action === "agent.run.outcome.invalid").length, 2);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("restart quarantines legacy transcript fields and v2 message collisions without harming siblings", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-outcome-ownership-"));
  const filename = path.join(root, "outright.db");
  let database = createOutrightDatabase({ filename });
  try {
    const conversation = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: root,
      title: "Recovery", provider: "codex" });
    const create = (prompt) => database.createRun({ conversationId: conversation.id, provider: "codex",
      approvalPolicy: "read-only", prompt });
    const legacy = create("legacy collision");
    const current = create("v2 collision");
    const validLegacy = create("legacy terminal");
    const validCurrent = create("v2 checkpoint");
    const finishedAt = new Date().toISOString();
    const existing = database.addMessage({ id: `${current.id}:1`, conversationId: conversation.id,
      role: "user", kind: "text", body: "original", payload: { runId: "other" }, createdAt: finishedAt });
    const marker = (run) => path.join(database.launchDirectory, `${run.id}.outcome.json`);
    const terminal = (run, version) => ({ version, runId: run.id, status: "completed", finishedAt,
      exitCode: 0, message: "" });
    writeFileSync(marker(legacy), JSON.stringify({ ...terminal(legacy, 1),
      transcriptMessage: { ...existing, body: "replaced" } }));
    database.savePendingRunOutcome(current.id, { ...terminal(current, 2),
      transcriptMessage: { id: existing.id, conversationId: conversation.id, role: "assistant", kind: "text",
        body: "replaced", payload: { runId: current.id }, createdAt: finishedAt } });
    writeFileSync(marker(validLegacy), JSON.stringify(terminal(validLegacy, 1)));
    database.savePendingRunOutcome(validCurrent.id, { ...terminal(validCurrent, 2),
      transcriptMessage: { id: `${validCurrent.id}:1`, conversationId: conversation.id, role: "assistant",
        kind: "text", body: "valid", payload: { runId: validCurrent.id }, createdAt: finishedAt } });
    database.close();
    database = createOutrightDatabase({ filename });
    const result = database.reconcileInterruptedRuns();
    assert.equal(result.counts.completed, 2);
    assert.equal(result.counts["never-started"], 2);
    assert.equal(database.listMessages(conversation.id).find((message) => message.id === existing.id).body, "original");
    assert.equal(database.listMessages(conversation.id).find((message) => message.id === `${validCurrent.id}:1`).body, "valid");
    assert.equal(database.getRun(validLegacy.id).status, "completed");
    assert.equal(existsSync(marker(legacy)), true);
    assert.equal(existsSync(marker(current)), true);
    assert.equal(existsSync(marker(validLegacy)), false);
    assert.equal(existsSync(marker(validCurrent)), false);
    assert.equal(database.listAudit(100).filter((entry) => entry.action === "agent.run.outcome.invalid").length, 2);
    for (const run of [legacy, current]) {
      assert.equal(database.resolveInterruptedRun(run.id, "discard")?.recoveryDecision, "discard");
      assert.equal(existsSync(marker(run)), false);
    }
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("retrying unreadable outcome evidence rechecks message ownership before replay", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-outcome-retry-owner-"));
  const database = createOutrightDatabase({ filename: path.join(root, "outright.db") });
  try {
    const conversation = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: root,
      title: "Retry", provider: "codex" });
    const run = database.createRun({ conversationId: conversation.id, provider: "codex",
      approvalPolicy: "read-only", prompt: "retry" });
    const createdAt = new Date().toISOString();
    const existing = database.addMessage({ id: `${run.id}:1`, conversationId: conversation.id,
      role: "user", kind: "text", body: "protected", payload: { runId: "other" }, createdAt });
    database.updateRun(run.id, { status: "interrupted", recoveryClass: "outcome-unreadable-queued" });
    const marker = path.join(database.launchDirectory, `${run.id}.outcome.json`);
    database.savePendingRunOutcome(run.id, { status: "completed", finishedAt: createdAt, exitCode: 0,
      message: "", transcriptMessage: { id: existing.id, conversationId: conversation.id, role: "assistant",
        kind: "text", body: "replaced", payload: { runId: run.id }, createdAt } });
    const retried = database.retryUnreadableRunOutcome(run.id);
    assert.equal(retried.status, "interrupted");
    assert.equal(retried.recoveryClass, "never-started");
    assert.equal(database.listMessages(conversation.id).find((message) => message.id === existing.id).body, "protected");
    assert.equal(existsSync(marker), true, "invalid evidence remains inspectable until a durable decision");
    assert.equal(database.listAudit(100).filter((entry) => entry.action === "agent.run.outcome.invalid").length, 1);
    database.resolveInterruptedRun(run.id, "discard");
    assert.equal(existsSync(marker), false);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a malformed queued outcome stays inspectable across restart and clears after a durable decision", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-invalid-restart-"));
  const filename = path.join(root, "outright.db");
  let database = createOutrightDatabase({ filename });
  try {
    const conversation = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: root,
      title: "Recovery", provider: "codex" });
    const run = database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "queued" });
    const marker = path.join(database.launchDirectory, `${run.id}.outcome.json`);
    writeFileSync(marker, "{broken");
    assert.equal(database.reconcileInterruptedRuns().counts["never-started"], 1);
    database.close();
    database = createOutrightDatabase({ filename });
    assert.equal(database.getRun(run.id).recoveryClass, "never-started");
    assert.equal(existsSync(marker), true);
    assert.equal(database.resolveInterruptedRun(run.id, "discard")?.recoveryDecision, "discard");
    assert.equal(existsSync(marker), false);
    database.close();
    database = createOutrightDatabase({ filename });
    assert.equal(database.findUnresolvedInterruptedRunForWorktree(root), undefined);
    assert.equal(database.listAudit(100).filter((entry) => entry.action === "agent.run.outcome.invalid" && entry.target === run.id).length, 1);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an escape-heavy final checkpoint stays within the recovery journal budget and records omission", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-bounded-outcome-"));
  const database = createOutrightDatabase({ filename: path.join(root, "outright.db") });
  try {
    const conversation = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: root,
      title: "Recovery budget", provider: "codex" });
    const run = database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "run" });
    database.savePendingRunOutcome(run.id, {
      status: "completed", finishedAt: new Date().toISOString(), exitCode: 0, message: "", transcriptOmitted: false,
      transcriptMessage: { id: `${run.id}:1`, conversationId: conversation.id, role: "assistant", kind: "text",
        body: "\u0000".repeat(400_000), createdAt: new Date().toISOString(), payload: { runId: run.id } },
    });
    const marker = path.join(database.launchDirectory, `${run.id}.outcome.json`);
    assert.ok(statSync(marker).size <= 2 * 1024 * 1024);
    assert.equal(database.reconcileInterruptedRuns().counts.completed, 1);
    assert.equal(database.getRun(run.id).transcriptOmitted, 1);
    assert.deepEqual(database.listMessages(conversation.id), []);
    assert.equal(database.listAudit(100).filter((entry) => entry.target === run.id && entry.action === "agent.run.completed").length, 1);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("uses a durable wrapper completion marker after the owned tree exits", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-completed-launch-"));
  const database = createOutrightDatabase({ filename: path.join(root, "outright.db") });
  try {
    const conversation = database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Recovery", provider: "codex" });
    const run = database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "running" });
    database.updateRun(run.id, { status: "running", pid: 4242 });
    const handshakePath = path.join(database.launchDirectory, `${run.id}.json`);
    writeFileSync(handshakePath, JSON.stringify({ pid: 4242, authorized: true, completed: true, completedAt: "2026-09-23T00:00:00.000Z" }));
    let probes = 0;
    const result = database.reconcileInterruptedRuns({ probeAlive: () => { probes++; return "unknown"; } });
    assert.equal(result.counts.exited, 1);
    assert.equal(database.getRun(run.id).recoveryClass, "exited");
    assert.equal(probes, 0, "the kernel-owner completion proof does not fall back to an unverifiable PID sample");
    assert.equal(existsSync(handshakePath), false, "the consumed completion marker is swept after reconciliation");
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects unauthorized or mismatched completion markers", () => {
  for (const [name, marker] of [
    ["unauthorized", { pid: 4242, authorized: false, completed: true }],
    ["mismatched", { pid: 4343, authorized: true, completed: true }],
  ]) {
    const root = mkdtempSync(path.join(os.tmpdir(), `outright-${name}-completion-`));
    const database = createOutrightDatabase({ filename: path.join(root, "outright.db") });
    try {
      const conversation = database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Recovery", provider: "codex" });
      const run = database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "running" });
      database.updateRun(run.id, { status: "running", pid: 4242 });
      writeFileSync(path.join(database.launchDirectory, `${run.id}.json`), JSON.stringify(marker));
      let probes = 0;
      database.reconcileInterruptedRuns({ probeAlive: () => { probes++; return "unknown"; } });
      assert.equal(database.getRun(run.id).recoveryClass, "unknown", `${name} marker must fail closed`);
      assert.equal(probes, 1, `${name} marker falls through to the platform probe`);
    } finally {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("classifies a provider process still alive after the restart", () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    const conversation = database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Recovery", provider: "codex" });
    const run = database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "running" });
    database.updateRun(run.id, { status: "running", pid: process.pid });
    const result = database.reconcileInterruptedRuns();
    assert.equal(result.counts.alive, 1);
    assert.equal(database.getRun(run.id).recoveryClass, "alive");
  } finally {
    database.close();
  }
});

test("a running row without a recorded pid reconciles as unknown", () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    const conversation = database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Recovery", provider: "codex" });
    const run = database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "running" });
    database.updateRun(run.id, { status: "running" });
    database.reconcileInterruptedRuns();
    assert.equal(database.getRun(run.id).recoveryClass, "unknown");
  } finally {
    database.close();
  }
});

// Regression: reconciliation used to probe only the detached leader PID. A
// leader that exits while provider descendants still hold the process group
// was classified "exited" and could bypass the recovery process guard.
test("classifies an exited leader with a live descendant as alive", { skip: process.platform === "win32" }, async () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  let pid;
  try {
    const descendant = "setInterval(() => {}, 1000);";
    const leader = `const {spawn} = require("node:child_process"); spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], {stdio: "ignore"}); process.exit(0);`;
    const child = spawn(process.execPath, ["-e", leader], { detached: true, stdio: "ignore" });
    pid = child.pid;
    await new Promise((resolve) => child.once("exit", resolve));
    await new Promise((resolve) => {
      const started = Date.now();
      (function probe() {
        try { process.kill(pid, 0); }
        catch { return resolve(); }
        if (Date.now() - started > 5000) return resolve();
        setTimeout(probe, 25);
      })();
    });
    assert.doesNotThrow(() => process.kill(-pid, 0), "the descendant must hold the leader's process group");
    const conversation = database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Recovery", provider: "codex" });
    const run = database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "orphaned" });
    database.updateRun(run.id, { status: "running", pid });
    const result = database.reconcileInterruptedRuns();
    assert.equal(result.counts.alive, 1);
    assert.equal(database.getRun(run.id).recoveryClass, "alive");
  } finally {
    if (pid) { try { process.kill(-pid, "SIGKILL"); } catch { /* Already gone. */ } }
    database.close();
  }
});

// Regression (platform-injectable): on platforms without owned process trees
// (Windows), a gone leader cannot prove its descendants exited, so the
// persisted leader PID must classify conservatively as unknown, never exited.
test("classifies a gone leader as unknown on platforms without owned process trees", async () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  let pid;
  try {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore", detached: process.platform !== "win32" });
    pid = child.pid;
    await new Promise((resolve) => child.once("exit", resolve));
    assert.equal(defaultProbeRun(pid, "win32"), "unknown", "a gone leader is never verifiably exited on win32");
    if (process.platform !== "win32") assert.equal(defaultProbeRun(pid), "exited", "a fully dead detached group is exited on POSIX");

    const conversation = database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Recovery", provider: "codex" });
    const run = database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "orphaned" });
    database.updateRun(run.id, { status: "running", pid });
    const result = database.reconcileInterruptedRuns({ probeAlive: (candidate) => defaultProbeRun(candidate, "win32") });
    assert.equal(result.counts.unknown, 1);
    assert.equal(database.getRun(run.id).recoveryClass, "unknown");
  } finally {
    database.close();
  }
});

test("classifies a live leader as alive on platforms without owned process trees", () => {
  assert.equal(defaultProbeRun(process.pid, "win32"), "alive");
});

// Regression: reconciliation used to read pending rows before its transaction
// and update each row by identifier without rechecking status. A runtime that
// still owned the run could finish it between those operations, and the
// terminal state was then overwritten with "interrupted", forcing a bogus
// recovery decision on a completed run.
test("reconciliation never reopens a run that finished concurrently", () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    const conversation = database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Recovery", provider: "codex" });
    const run = database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "concurrently finished" });
    database.updateRun(run.id, { status: "running", pid: 4242 });
    const result = database.reconcileInterruptedRuns({
      probeAlive: () => {
        // The owning runtime finishes the run while the probe runs.
        database.updateRun(run.id, { status: "completed", finishedAt: "2026-09-21T00:00:00.000Z", exitCode: 0, pid: null });
        return "exited";
      },
    });
    assert.equal(result.count, 0, "a concurrently finished run is not reconciled");
    assert.equal(database.getRun(run.id).status, "completed");
    assert.equal(database.getRun(run.id).recoveryClass, null);
  } finally {
    database.close();
  }
});

// Regression: assistant checkpoints reuse one stable createdAt for the whole
// stream, so a plain overwrite regressed conversations.updated_at after a newer
// tool or user message advanced it, moving an active conversation down the
// sidebar and search ordering while it was still streaming.
test("message writes never move conversations.updated_at backwards", () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    // Future-offset timestamps keep every value above the conversation's real
    // creation time so MAX() comparisons are deterministic.
    const checkpointAt = new Date(Date.now() + 100_000).toISOString();
    const toolAt = new Date(Date.now() + 105_000).toISOString();
    const segmentAt = new Date(Date.now() + 110_000).toISOString();
    const conversation = database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Streaming", provider: "claude" });
    const base = { id: `${conversation.id}:1`, conversationId: conversation.id, role: "assistant", kind: "text", createdAt: checkpointAt, payload: null };
    database.upsertMessage({ ...base, body: "Partial" });
    assert.equal(database.getConversation(conversation.id).updatedAt, checkpointAt);

    // A newer tool message advances the conversation timestamp.
    database.addMessage({ id: `${conversation.id}:2`, conversationId: conversation.id, role: "assistant", kind: "tool", body: "Tool completed: run", createdAt: toolAt });
    assert.equal(database.getConversation(conversation.id).updatedAt, toolAt);

    // The next assistant checkpoint carries the older stable createdAt and
    // must not regress the newer timestamp.
    database.upsertMessage({ ...base, body: "Partial answer" });
    assert.equal(database.getConversation(conversation.id).updatedAt, toolAt, "the checkpoint must not regress updated_at");

    // A newer checkpoint still advances it.
    database.upsertMessage({ ...base, id: `${conversation.id}:3`, body: "New segment", createdAt: segmentAt });
    assert.equal(database.getConversation(conversation.id).updatedAt, segmentAt);
  } finally {
    database.close();
  }
});

// Regression (round 6 / PR convergence): the launch crash window between
// persisting 'running' state and recording the provider pid used to leave a
// no-pid interrupted run that blocked every recovery policy indefinitely. The
// crash-safe launch handshake splits this into a durable 'launching' phase
// whose rows provably never authorized the provider.
test("reconciles a launching row without a handshake record as never-started", () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    const conversation = database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Recovery", provider: "codex" });
    const run = database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "crashed while launching" });
    database.updateRun(run.id, { status: "launching", startedAt: "2026-09-21T00:00:00.000Z" });
    const result = database.reconcileInterruptedRuns();
    assert.equal(result.counts["never-started"], 1);
    const recovered = database.getRun(run.id);
    assert.equal(recovered.status, "interrupted");
    assert.equal(recovered.recoveryClass, "never-started");
    assert.equal(recovered.pid, null, "no handshake record means no process identity was ever recorded");
  } finally {
    database.close();
  }
});

test("reconciles a launching row by adopting the wrapper handshake pid as never-started", async () => {
  const launchDirectory = mkdtempSync(path.join(os.tmpdir(), "outright-launches-"));
  const database = createOutrightDatabase({ filename: ":memory:", launchDirectory });
  let pid;
  try {
    const conversation = database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Recovery", provider: "codex" });
    const run = database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "crashed before authorization" });
    database.updateRun(run.id, { status: "launching", startedAt: "2026-09-21T00:00:00.000Z" });
    // The wrapper durably recorded its identity, but the runtime died before
    // committing 'running' — so the provider was never authorized to run.
    const exited = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore", detached: process.platform !== "win32" });
    pid = exited.pid;
    await new Promise((resolve) => exited.once("exit", resolve));
    writeFileSync(path.join(launchDirectory, `${run.id}.json`), JSON.stringify({ pid, authorized: false, createdAt: "2026-09-21T00:00:00.000Z" }));

    const result = database.reconcileInterruptedRuns();
    assert.equal(result.counts["never-started"], 1);
    const recovered = database.getRun(run.id);
    assert.equal(recovered.status, "interrupted");
    assert.equal(recovered.recoveryClass, "never-started", "a launching row was provably never authorized, so it is never gated as an unverifiable tree");
    assert.equal(recovered.pid, pid, "the handshake pid is adopted so process ownership is not lost");
    assert.equal(existsSync(path.join(launchDirectory, `${run.id}.json`)), false, "the adopted handshake record is removed, not lingered on");
  } finally {
    database.close();
    rmSync(launchDirectory, { recursive: true, force: true });
  }
});

// Regression (PR remediation round 2): the launches directory must never
// accumulate one orphaned handshake record per hard-killed runtime. Adopted
// records are deleted and records for runs that were not pending are swept;
// records of rows that were actually running are kept for their still-live
// wrappers.
test("reconciliation sweeps stale handshake records but keeps live-wrapper records", () => {
  const launchDirectory = mkdtempSync(path.join(os.tmpdir(), "outright-launches-"));
  const database = createOutrightDatabase({ filename: ":memory:", launchDirectory });
  try {
    const conversation = database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Recovery", provider: "codex" });
    const launching = database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "crashed before authorization" });
    const running = database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "crashed while running" });
    const exited = database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "crashed after the tree died" });
    const finished = database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "done long ago" });
    database.updateRun(launching.id, { status: "launching" });
    database.updateRun(running.id, { status: "running", pid: 4242 });
    database.updateRun(exited.id, { status: "running", pid: 5353 });
    database.updateRun(finished.id, { status: "completed", finishedAt: "2026-09-21T00:00:00.000Z" });
    const record = (runId, pid, extra = {}) => writeFileSync(path.join(launchDirectory, `${runId}.json`), JSON.stringify({ pid, authorized: false, ...extra }));
    record(launching.id, 111);
    record(running.id, 222, { ownershipToken: "00000000-0000-4000-8000-000000000001", platformOwnershipId: "com.21n.outright.00000000-0000-4000-8000-000000000001" });
    record(exited.id, 555);
    record(finished.id, 333);
    const staleRun = "b0ed4709-3bd6-4eac-9ab4-f9365a82a7e1";
    const terminalId = "379634b7-8989-47c5-9174-c09529b206a1";
    const terminalMarker = path.join(launchDirectory, `terminal-${terminalId}.json`);
    record(staleRun, 444);
    writeFileSync(terminalMarker, JSON.stringify({ pid: 444, processIdentity: "owned-terminal" }));

    let runningHandshake;
    database.reconcileInterruptedRuns({ probeAlive: (pid, handshake) => {
      if (pid === 4242) runningHandshake = handshake;
      return pid === 4242;
    } });

    assert.equal(existsSync(path.join(launchDirectory, `${launching.id}.json`)), false, "the adopted launching record is removed");
    assert.equal(existsSync(path.join(launchDirectory, `${running.id}.json`)), true, "an alive tree's wrapper may still be live and removes its own record");
    assert.equal(runningHandshake.platformOwnershipId, "com.21n.outright.00000000-0000-4000-8000-000000000001", "restart probing receives the durable platform owner, not only its possibly-dead wrapper pid");
    assert.equal(existsSync(path.join(launchDirectory, `${exited.id}.json`)), false, "an exited tree is proven gone, so its hard-killed wrapper's record is swept instead of leaking");
    assert.equal(existsSync(path.join(launchDirectory, `${finished.id}.json`)), false, "a terminal run's stale record is swept");
    assert.equal(existsSync(path.join(launchDirectory, `${staleRun}.json`)), false, "a record for an unknown run is swept");
    assert.equal(existsSync(terminalMarker), true, "run cleanup preserves the terminal owner's recovery marker");
    database.reconcileInterruptedRuns();
    assert.equal(existsSync(path.join(launchDirectory, `${running.id}.json`)), true, "a second restart preserves unresolved ownership evidence");
    database.resolveInterruptedRun(running.id, "discard");
    database.reconcileInterruptedRuns();
    assert.equal(existsSync(path.join(launchDirectory, `${running.id}.json`)), false, "resolved ownership evidence is swept");
  } finally {
    database.close();
    rmSync(launchDirectory, { recursive: true, force: true });
  }
});

// Regression (PR remediation round 2): better-sqlite3's default deferred
// transaction let another runtime commit between reconciliation's SELECT and
// its first UPDATE, failing with SQLITE_BUSY_SNAPSHOT and aborting startup.
// The immediate variant acquires the write lock before reading pending rows,
// so no other writer can commit inside that window at all.
test("reconciliation holds the write lock across its whole read-modify-write window", () => {
  const dataDirectory = mkdtempSync(path.join(os.tmpdir(), "outright-db-"));
  const database = createOutrightDatabase({ dataDirectory, filename: path.join(dataDirectory, "outright.db") });
  const other = new Database(path.join(dataDirectory, "outright.db"));
  other.pragma("busy_timeout = 100");
  try {
    const conversation = database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Recovery", provider: "codex" });
    const run = database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "racing writer" });
    database.updateRun(run.id, { status: "running", pid: 4242 });

    let concurrentWrite = "never-attempted";
    const result = database.reconcileInterruptedRuns({
      probeAlive: () => {
        // A second runtime tries to commit while reconciliation is between
        // its SELECT and its UPDATE. With a deferred transaction this commit
        // would succeed and reconciliation would then abort with
        // SQLITE_BUSY_SNAPSHOT; with the immediate transaction the writer
        // cannot get in at all.
        try {
          other.prepare("UPDATE runs SET status = 'completed', finished_at = ?, exit_code = 0 WHERE id = ?").run("2026-09-21T00:00:00.000Z", run.id);
          concurrentWrite = "committed";
        } catch (error) {
          concurrentWrite = error.code;
        }
        return "exited";
      },
    });
    // The concurrent writer was locked out for the whole window, so
    // reconciliation itself never observes a snapshot conflict and completes.
    assert.equal(concurrentWrite, "SQLITE_BUSY", "the write lock must be held from the pending-row read through the final update");
    assert.equal(result.count, 1);
    assert.equal(database.getRun(run.id).status, "interrupted");
  } finally {
    other.close();
    database.close();
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

// Regression (PR remediation round 2): with an explicit filename outside the
// default data directory, handshake records must follow that file instead of
// landing in ~/.outright/launches.
test("the launch directory follows an explicit absolute database filename", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-db-"));
  const filename = path.join(root, "custom", "outright.db");
  try {
    const database = createOutrightDatabase({ filename });
    assert.equal(database.launchDirectory, path.join(realpathSync(path.join(root, "custom")), "launches"));
    database.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const memory = createOutrightDatabase({ filename: ":memory:", dataDirectory: root });
  try {
    // Non-filenames like ":memory:" keep the data-directory default.
    assert.equal(memory.launchDirectory, path.join(root, "launches"));
  } finally {
    memory.close();
  }
});

// Regression (PR remediation round 3): created_at alone does not order two
// runs created within the same millisecond; the recovery order gate needs a
// deterministic tie-breaker or a newer run could pass as the older one.
test("unresolved interrupted runs order deterministically with equal created_at", () => {
  const dataDirectory = mkdtempSync(path.join(os.tmpdir(), "outright-order-"));
  const database = createOutrightDatabase({ dataDirectory });
  const other = new Database(path.join(dataDirectory, "outright.db"));
  try {
    const conversation = database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Order", provider: "codex" });
    const first = database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "first" });
    const second = database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "second" });
    // Force identical timestamps: without the rowid tie-breaker the
    // oldest-unresolved selection is arbitrary.
    other.prepare("UPDATE runs SET created_at = ?").run("2026-09-21T00:00:00.000Z");
    database.updateRun(first.id, { status: "running", pid: 4242 });
    database.updateRun(second.id, { status: "running", pid: 5353 });
    database.reconcileInterruptedRuns({ probeAlive: () => false });

    assert.equal(database.findUnresolvedInterruptedRun(conversation.id).id, first.id, "the older run is surfaced first even with equal created_at");
    const unresolved = database.listUnresolvedInterruptedRuns(conversation.id);
    assert.deepEqual(unresolved.map((run) => run.id), [first.id, second.id]);
  } finally {
    other.close();
    database.close();
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test("records a recovery decision exactly once", () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    const conversation = database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Recovery", provider: "codex" });
    const run = database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "discarded" });
    database.reconcileInterruptedRuns();
    const discarded = database.resolveInterruptedRun(run.id, "discard");
    assert.equal(discarded.status, "failed");
    assert.match(discarded.error, /Discarded/);
    assert.equal(discarded.recoveryDecision, "discard");
    assert.equal(database.resolveInterruptedRun(run.id, "discard"), null, "the decision is final");
    assert.equal(database.resolveInterruptedRun(run.id, "resume-session"), null);
  } finally {
    database.close();
  }
});

test("recovery retry durably clears the provider session before the replacement run starts", () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    const conversation = database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Recovery", provider: "codex" });
    database.updateConversation(conversation.id, { providerSessionId: "session-old" });
    const interrupted = database.createRun({ conversationId: conversation.id, provider: "codex", model: "gpt", reasoningEffort: "high", approvalPolicy: "read-only", prompt: "retry me" });
    database.updateRun(interrupted.id, { status: "running", providerSessionId: "session-old", pid: 4242 });
    database.reconcileInterruptedRuns({ probeAlive: () => false });

    const recovery = database.beginInterruptedRunRecovery(interrupted.id, "retry");
    assert.equal(recovery.interrupted.recoveryDecision, "retry");
    assert.equal(recovery.conversation.providerSessionId, null);
    assert.equal(database.getConversation(conversation.id).providerSessionId, null);
    assert.equal(recovery.run.status, "queued");
    assert.equal(recovery.run.prompt, "retry me");
    assert.equal(database.beginInterruptedRunRecovery(interrupted.id, "retry"), null, "recovery is idempotent");
  } finally {
    database.close();
  }
});

test("recovery keeps sessions bound to their provider and persists the replacement session", () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    const conversation = database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Recovery", provider: "claude" });
    database.updateConversation(conversation.id, { providerSessionId: "claude-session" });

    const resumed = database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "resume" });
    database.updateRun(resumed.id, { status: "running", providerSessionId: "codex-session", pid: 4242 });
    database.reconcileInterruptedRuns({ probeAlive: () => false });
    const resumeRecovery = database.beginInterruptedRunRecovery(resumed.id, "resume-session", { providerSessionId: "codex-session" });
    assert.equal(resumeRecovery.run.providerSessionId, "codex-session", "the replacement run carries the immutable interrupted-run session");
    assert.equal(database.getConversation(conversation.id).providerSessionId, "claude-session", "a Codex recovery cannot overwrite the Claude conversation session");

    const retried = database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "retry" });
    database.updateRun(retried.id, { status: "running", providerSessionId: "codex-session-2", pid: 4343 });
    database.reconcileInterruptedRuns({ probeAlive: () => false });
    const retryRecovery = database.beginInterruptedRunRecovery(retried.id, "retry");
    assert.equal(retryRecovery.run.providerSessionId, null);
    assert.equal(database.getConversation(conversation.id).providerSessionId, "claude-session", "retry cannot clear an unrelated provider session");
  } finally {
    database.close();
  }
});

test("upserts partial transcript checkpoints and commits the final checkpoint with run state", () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    const conversation = database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Recovery", provider: "claude" });
    const run = database.createRun({ conversationId: conversation.id, provider: "claude", approvalPolicy: "read-only", prompt: "stream" });
    const base = { id: `${run.id}:1`, conversationId: conversation.id, role: "assistant", kind: "text", createdAt: "2026-09-21T00:00:00.000Z", payload: { runId: run.id, provider: "claude" } };
    database.upsertMessage({ ...base, body: "Partial" });
    database.upsertMessage({ ...base, body: "Partial answer" });
    assert.deepEqual(database.listMessages(conversation.id).map((message) => message.body), ["Partial answer"]);

    database.finishRun(run.id, { status: "completed", finishedAt: "2026-09-21T00:00:01.000Z", exitCode: 0, pid: null }, { ...base, body: "Partial answer complete" });
    assert.equal(database.getRun(run.id).status, "completed");
    assert.deepEqual(database.listMessages(conversation.id).map((message) => message.body), ["Partial answer complete"]);
  } finally {
    database.close();
  }
});

test("commits a streamed delta and its transcript cursor atomically", () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    const conversation = database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Atomic stream", provider: "claude" });
    const run = database.createRun({ conversationId: conversation.id, provider: "claude", approvalPolicy: "read-only", prompt: "stream" });
    const committed = database.appendRunEventWithMessage(run.id, "assistant.delta", { text: "Partial" }, {
      id: `${run.id}:1`,
      conversationId: conversation.id,
      role: "assistant",
      kind: "text",
      body: "Partial",
      payload: { runId: run.id, provider: "claude" },
    });
    assert.equal(committed.message.payload.checkpointEventSeq, committed.event.seq);
    assert.equal(database.listMessages(conversation.id)[0].payload.checkpointEventSeq, committed.event.seq);
    assert.equal(database.listRunEvents(run.id)[0].seq, committed.event.seq);
  } finally {
    database.close();
  }
});

test("tracks trust and audit records", () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    database.trustProject("project-1", "/tmp/project-1");
    assert.equal(database.isProjectTrusted("project-1", "/tmp/project-1"), true);
    assert.equal(database.isProjectTrusted("project-1", "/tmp/moved"), false);
    database.audit("git.stage", { target: "/tmp/project-1", files: ["README.md"] });
    assert.deepEqual(database.listAudit(1)[0].details.files, ["README.md"]);
  } finally {
    database.close();
  }
});

test("rejects unknown and unsafe settings without partially applying the patch", () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    assert.throws(() => database.updateSettings({ maxConcurrentRuns: 0 }), /Invalid value for setting: maxConcurrentRuns/);
    assert.throws(() => database.updateSettings({ provider: "unknown" }), /Invalid value for setting: provider/);
    assert.throws(() => database.updateSettings({ provider: "claude", unexpected: true }), /Unknown setting: unexpected/);
    assert.equal(database.getSettings().provider, "codex");
    assert.equal(database.getSettings().maxConcurrentRuns, 3);
  } finally {
    database.close();
  }
});

test("pages messages newest-first at the boundary while returning each page chronologically", () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    const conversation = database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "History", provider: "codex" });
    for (let index = 1; index <= 5; index += 1) {
      database.addMessage({ id: `message-${index}`, conversationId: conversation.id, role: index % 2 ? "user" : "assistant", body: `Message ${index}` });
    }

    const latest = database.listMessagePage(conversation.id, { limit: 2 });
    assert.deepEqual(latest.messages.map((message) => message.id), ["message-4", "message-5"]);
    assert.deepEqual(latest.page, { hasMore: true, olderCount: 3, hasLater: false, newerCount: 0, total: 5, beforeId: "message-4", limit: 2 });

    const middle = database.listMessagePage(conversation.id, { beforeId: latest.page.beforeId, limit: 2 });
    assert.deepEqual(middle.messages.map((message) => message.id), ["message-2", "message-3"]);
    assert.equal(middle.page.hasMore, true);
    assert.equal(middle.page.olderCount, 1);

    const oldest = database.listMessagePage(conversation.id, { beforeId: middle.page.beforeId, limit: 2 });
    assert.deepEqual(oldest.messages.map((message) => message.id), ["message-1"]);
    assert.equal(oldest.page.hasMore, false);
    assert.equal(oldest.page.olderCount, 0);
    assert.throws(() => database.listMessagePage(conversation.id, { beforeId: "missing" }), /Message cursor was not found/);
  } finally {
    database.close();
  }
});

test("bounds retained and returned run event history", () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    const conversation = database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Events", provider: "codex" });
    const run = database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "Observe" });
    for (let index = 1; index <= 2_005; index += 1) database.appendRunEvent(run.id, "provider.event", { index });
    const events = database.listRunEvents(run.id);
    assert.equal(events.length, 2_000);
    assert.equal(events[0].seq, 6);
    assert.equal(events.at(-1).seq, 2_005);
  } finally {
    database.close();
  }
});

test("bounds oversized run event payloads before storage and publication", () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    const conversation = database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Events", provider: "codex" });
    const run = database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "Observe" });
    const event = database.appendRunEvent(run.id, "provider.event", { text: "x".repeat(400 * 1024) });
    assert.equal(event.payload.truncated, true);
    assert.ok(event.payload.originalBytes > 400 * 1024);
    assert.ok(Buffer.byteLength(JSON.stringify(event.payload)) <= 256 * 1024);
    assert.deepEqual(database.listRunEvents(run.id)[0].payload, event.payload);
  } finally {
    database.close();
  }
});

// Rebuild the pre-spaces schema from a current store: the old table and
// column names, and retained triggers under their old names, exactly as the
// pre-rename runtime installed them.
function seedPreSpacesStore(filename) {
  createOutrightDatabase({ filename }).close();
  const legacy = new Database(filename);
  try {
    legacy.pragma("foreign_keys = ON");
    const triggers = legacy.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'retained_spaces_%'").all();
    legacy.transaction(() => {
      for (const { name } of triggers) legacy.exec(`DROP TRIGGER ${name}`);
      legacy.exec("ALTER TABLE spaces RENAME TO project_groups");
      legacy.exec("ALTER TABLE project_memberships RENAME COLUMN space_id TO group_id");
      for (const { sql } of triggers) {
        legacy.exec(sql.replace(/retained_spaces_/g, "retained_project_groups_").replace(" ON spaces", " ON project_groups")
          .replace(/table_name = 'spaces'/g, "table_name = 'project_groups'"));
      }
      legacy.prepare("INSERT INTO project_groups (id, name, position, created_at) VALUES (?, ?, ?, ?)").run("group-late", "Clients", 7, "2026-01-02T00:00:00.000Z");
      legacy.prepare("INSERT INTO project_groups (id, name, position, created_at) VALUES (?, ?, ?, ?)").run("group-early", "Core systems", 3, "2026-01-01T00:00:00.000Z");
      const member = legacy.prepare("INSERT INTO project_memberships (project_id, group_id) VALUES (?, ?)");
      member.run("project-a", "group-late");
      member.run("project-b", "group-early");
      member.run("project-c", "group-early");
      legacy.prepare("INSERT INTO settings (key, value) VALUES ('_defaultGroupsInitialized', 'true')").run();
    })();
    assert.ok(legacy.prepare("SELECT 1 FROM sqlite_master WHERE name = 'retained_project_groups_insert'").get());
  } finally { legacy.close(); }
}

function spaceSchema(filename) {
  const probe = new Database(filename, { readonly: true });
  try {
    return {
      tables: probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('project_groups', 'spaces') ORDER BY name").all().map((row) => row.name),
      columns: probe.pragma("table_info(project_memberships)").map((column) => column.name),
      foreignKeys: probe.pragma("foreign_key_list(project_memberships)").map(({ table, from, to, on_delete: onDelete }) => ({ table, from, to, onDelete })),
      triggers: probe.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND (tbl_name IN ('project_groups', 'spaces') OR name LIKE 'retained_project_groups_%') ORDER BY name").all().map((row) => row.name),
      retainedBytes: probe.prepare("SELECT bytes FROM retained_usage WHERE id = 1").get().bytes,
    };
  } finally { probe.close(); }
}

const MIGRATED_SPACES = [
  { id: "group-early", name: "Core systems", position: 3, createdAt: "2026-01-01T00:00:00.000Z" },
  { id: "group-late", name: "Clients", position: 7, createdAt: "2026-01-02T00:00:00.000Z" },
];
const MIGRATED_MEMBERSHIPS = { "project-a": "group-late", "project-b": "group-early", "project-c": "group-early" };

test("a pre-spaces store opens with identical spaces and memberships, once", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-spaces-upgrade-"));
  const filename = path.join(directory, "outright.db");
  try {
    seedPreSpacesStore(filename);
    const legacyBytes = spaceSchema(filename).retainedBytes;
    let database = createOutrightDatabase({ filename });
    try {
      assert.deepEqual(database.listSpaces(), { spaces: MIGRATED_SPACES, memberships: MIGRATED_MEMBERSHIPS });
      const schema = spaceSchema(filename);
      assert.deepEqual(schema.tables, ["spaces"]);
      assert.deepEqual(schema.columns, ["project_id", "space_id"]);
      assert.deepEqual(schema.foreignKeys, [{ table: "spaces", from: "space_id", to: "id", onDelete: "CASCADE" }]);
      assert.deepEqual(schema.triggers, ["retained_spaces_delete", "retained_spaces_insert", "retained_spaces_update"]);
      assert.equal(schema.retainedBytes, legacyBytes, "renaming must not change retained usage");
      // A trigger left behind under its old name would count this write twice.
      const added = database.createSpace("Added");
      const row = 128 + Buffer.byteLength(`${added.id}${added.name}${added.createdAt}`);
      assert.equal(spaceSchema(filename).retainedBytes, legacyBytes + row);
      assert.equal(added.position, 8);
      database.deleteSpace(added.id);
      assert.equal(spaceSchema(filename).retainedBytes, legacyBytes);
      database.ensureDefaultSpaces([{ id: "project-new", name: "Prototype", path: "/work/prototype" }]);
      assert.deepEqual(database.listSpaces(), { spaces: MIGRATED_SPACES, memberships: MIGRATED_MEMBERSHIPS }, "default spaces are not re-seeded");
      assert.equal("_defaultGroupsInitialized" in database.getSettings(), false);
    } finally { database.close(); }
    const migrated = spaceSchema(filename);
    database = createOutrightDatabase({ filename });
    try {
      assert.deepEqual(database.listSpaces(), { spaces: MIGRATED_SPACES, memberships: MIGRATED_MEMBERSHIPS });
      assert.deepEqual(spaceSchema(filename), migrated, "a second open is a no-op");
      database.deleteSpace("group-early");
      assert.deepEqual(database.listSpaces().memberships, { "project-a": "group-late" }, "memberships still cascade");
    } finally { database.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("an interrupted spaces migration leaves the old schema, and the next open completes it", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-spaces-atomic-"));
  const filename = path.join(directory, "outright.db");
  try {
    seedPreSpacesStore(filename);
    const before = spaceSchema(filename);
    assert.throws(() => createOutrightDatabase({ filename, spacesMigrationStep: (step) => {
      if (step === "table-renamed") throw new Error("injected spaces migration failure");
    } }), /injected spaces migration failure/);
    assert.deepEqual(spaceSchema(filename), before, "a failed rename must not leave a mixed schema");
    const raw = new Database(filename, { readonly: true });
    try {
      assert.equal(raw.prepare("SELECT COUNT(*) AS count FROM project_groups").get().count, 2);
      assert.equal(raw.prepare("SELECT COUNT(*) AS count FROM project_memberships WHERE group_id IS NOT NULL").get().count, 3);
    } finally { raw.close(); }
    const database = createOutrightDatabase({ filename });
    try {
      assert.deepEqual(database.listSpaces(), { spaces: MIGRATED_SPACES, memberships: MIGRATED_MEMBERSHIPS });
      assert.deepEqual(spaceSchema(filename).tables, ["spaces"]);
    } finally { database.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("an unfinished retained scan of project groups resumes under spaces", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-spaces-scan-"));
  const filename = path.join(directory, "outright.db");
  try {
    seedPreSpacesStore(filename);
    const measuredBytes = spaceSchema(filename).retainedBytes;
    const legacy = new Database(filename);
    try {
      legacy.transaction(() => {
        legacy.prepare("UPDATE retained_usage SET bytes = 0, measured = 0 WHERE id = 1").run();
        const insert = legacy.prepare("INSERT INTO retained_scans (table_name) VALUES (?)");
        for (const { name } of legacy.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'retained_%_insert'").all()) {
          insert.run(name.slice("retained_".length, -"_insert".length));
        }
      })();
      assert.ok(legacy.prepare("SELECT 1 FROM retained_scans WHERE table_name = 'project_groups'").get());
    } finally { legacy.close(); }
    const database = createOutrightDatabase({ filename });
    try {
      const deadline = Date.now() + 5_000;
      while (database.capacity().migrationStatus !== "ready" || spaceSchema(filename).retainedBytes !== measuredBytes) {
        assert.ok(Date.now() < deadline, `retained scan did not finish: ${JSON.stringify(database.capacity())}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const probe = new Database(filename, { readonly: true });
      try { assert.equal(probe.prepare("SELECT COUNT(*) AS count FROM retained_scans").get().count, 0); }
      finally { probe.close(); }
    } finally { await database.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

const LEGACY_CONVERSATION_COLUMNS = "id, project_id, worktree_id, worktree_path, title, provider, model, provider_session_id, tab_position, archived, pinned, deleting, created_at, updated_at";
const TASK_RETAINED_SIZE = "128 + COALESCE(octet_length(id), 0) + COALESCE(octet_length(space_id), 0) + COALESCE(octet_length(project_id), 0) + COALESCE(octet_length(worktree_id), 0) + COALESCE(octet_length(worktree_path), 0) + COALESCE(octet_length(title), 0) + COALESCE(octet_length(objective), 0)";

// Rebuild the pre-task schema from a current store: the legacy conversations
// definition without task_id, with every row, rowid, index and trigger kept,
// and no tasks table. Task bytes leave the retained counter with the table.
function seedPreTaskStore(filename, { sessionEpoch = false } = {}) {
  const legacy = new Database(filename);
  try {
    legacy.pragma("foreign_keys = OFF");
    legacy.transaction(() => {
      const dependents = legacy.prepare(`SELECT sql FROM sqlite_master WHERE tbl_name = 'conversations'
        AND type IN ('index', 'trigger') AND sql IS NOT NULL AND name != 'conversations_task'`).all();
      legacy.exec(`CREATE TABLE legacy_conversations (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, worktree_id TEXT NOT NULL, worktree_path TEXT NOT NULL,
        title TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', provider_session_id TEXT, tab_position INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0, deleting INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`);
      legacy.exec(`INSERT INTO legacy_conversations (rowid, ${LEGACY_CONVERSATION_COLUMNS}) SELECT rowid, ${LEGACY_CONVERSATION_COLUMNS} FROM conversations`);
      legacy.exec(`UPDATE retained_usage SET bytes = bytes - (SELECT COALESCE(SUM(${TASK_RETAINED_SIZE}), 0) FROM tasks) WHERE id = 1`);
      legacy.exec("DROP TABLE conversations");
      legacy.exec("DROP TABLE tasks");
      legacy.pragma("legacy_alter_table = ON");
      legacy.exec("ALTER TABLE legacy_conversations RENAME TO conversations");
      legacy.pragma("legacy_alter_table = OFF");
      for (const { sql } of dependents) legacy.exec(sql);
      if (sessionEpoch) {
        legacy.exec("ALTER TABLE conversations ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0");
        legacy.exec("UPDATE conversations SET session_epoch = rowid * 3");
      }
    })();
    assert.equal(legacy.pragma("table_info(conversations)").some((column) => column.name === "task_id"), false);
  } finally { legacy.close(); }
}

function taskStoreSnapshot(filename) {
  const probe = new Database(filename, { readonly: true });
  try {
    const all = (sql) => probe.prepare(sql).all();
    return {
      conversations: all(`SELECT rowid, ${LEGACY_CONVERSATION_COLUMNS} FROM conversations ORDER BY rowid`),
      messages: all("SELECT rowid, id, conversation_id, body, search_order FROM messages ORDER BY rowid"),
      messageOrder: all("SELECT * FROM message_order ORDER BY scope, ordinal"),
      runs: all("SELECT rowid, id, conversation_id, status, recovery_decision FROM runs ORDER BY rowid"),
      recoveryScope: all("SELECT * FROM recovery_scope ORDER BY run_id"),
      searchVisible: all("SELECT * FROM search_visible_conversations ORDER BY source_rowid"),
      searchTitles: all("SELECT * FROM search_recent_titles ORDER BY source_rowid"),
      searchHeads: all("SELECT * FROM search_message_heads ORDER BY source_rowid"),
      triggers: all("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'conversations' ORDER BY name"),
      indexes: all("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'conversations' AND name != 'conversations_task' ORDER BY name"),
      retainedBytes: probe.prepare("SELECT bytes FROM retained_usage WHERE id = 1").get().bytes,
    };
  } finally { probe.close(); }
}

function populateTaskFixture(filename) {
  const database = createOutrightDatabase({ filename });
  try {
    const make = (title, worktree) => database.createConversation({ projectId: "project-1", worktreeId: worktree, worktreePath: `/tmp/${worktree}`, title, provider: "codex" });
    const plain = make("Plain needle chat", "tree-1");
    const pinned = make("Pinned chat", "tree-1");
    const archived = make("Archived chat", "tree-2");
    const deleting = make("Deleting chat", "tree-2");
    const interrupted = make("Interrupted chat", "tree-3");
    for (const conversation of [plain, pinned, archived, deleting, interrupted]) {
      database.addMessage({ conversationId: conversation.id, role: "user", body: `needle in ${conversation.title}` });
      database.addMessage({ conversationId: conversation.id, role: "assistant", body: "reply" });
    }
    database.updateConversation(pinned.id, { pinned: true, tabPosition: 7 });
    database.updateConversation(archived.id, { archived: true });
    database.updateConversation(deleting.id, { archived: true });
    const unresolved = database.createRun({ conversationId: interrupted.id, provider: "codex", approvalPolicy: "read-only", prompt: "half" });
    database.updateRun(unresolved.id, { status: "interrupted", recoveryClass: "never-started" });
    const settled = database.createRun({ conversationId: plain.id, provider: "codex", approvalPolicy: "read-only", prompt: "done" });
    database.updateRun(settled.id, { status: "completed" });
    const search = database.search("needle").conversations.map((row) => row.id).sort();
    return { plain, pinned, archived, deleting, interrupted, unresolved, search };
  } finally { database.close(); }
}

test("a populated pre-task store migrates every conversation into one worktree task without changing history", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-task-upgrade-"));
  const filename = path.join(directory, "outright.db");
  try {
    const fixture = populateTaskFixture(filename);
    seedPreTaskStore(filename);
    const raw = new Database(filename);
    try { raw.prepare("UPDATE conversations SET deleting = 1 WHERE id = ?").run(fixture.deleting.id); }
    finally { raw.close(); }
    const before = taskStoreSnapshot(filename);
    assert.equal(before.searchVisible.length, 4, "the deleting conversation is already hidden from search");
    let database = createOutrightDatabase({ filename });
    try {
      assert.equal(database.capacity().migrationStatus, "ready");
      const after = taskStoreSnapshot(filename);
      const { retainedBytes, ...history } = after;
      const { retainedBytes: legacyBytes, ...legacyHistory } = before;
      assert.deepEqual(history, legacyHistory, "ids, rowids, messages, runs, recovery and search rows are unchanged");
      const probe = new Database(filename, { readonly: true });
      try {
        assert.deepEqual(probe.pragma("foreign_key_check"), []);
        const tasks = probe.prepare("SELECT * FROM tasks ORDER BY id").all();
        assert.equal(tasks.length, before.conversations.length);
        const taskBytes = probe.prepare(`SELECT SUM(${TASK_RETAINED_SIZE}) AS bytes FROM tasks`).get().bytes;
        assert.equal(retainedBytes, legacyBytes + taskBytes, "backfilled tasks are counted once by the retained budget");
        for (const conversation of before.conversations) {
          const row = probe.prepare("SELECT task_id FROM conversations WHERE id = ?").get(conversation.id);
          const task = tasks.find((candidate) => candidate.id === row.task_id);
          assert.deepEqual({ ...task }, { id: row.task_id, scope_kind: "worktree", space_id: null, project_id: conversation.project_id,
            worktree_id: conversation.worktree_id, worktree_path: conversation.worktree_path, title: conversation.title, objective: "",
            origin: "user", user_status: "open", archived: conversation.archived, created_at: conversation.created_at,
            updated_at: conversation.updated_at });
        }
        const columns = Object.fromEntries(probe.pragma("table_info(conversations)").map((column) => [column.name, column.notnull]));
        assert.deepEqual([columns.task_id, columns.worktree_id, columns.worktree_path], [1, 0, 0]);
      } finally { probe.close(); }
      assert.deepEqual(database.search("needle").conversations.map((row) => row.id).sort(),
        fixture.search.filter((id) => id !== fixture.deleting.id).sort());
      assert.equal(database.listConversations().find((row) => row.id === fixture.pinned.id).tabPosition, 7);
      assert.equal(database.findUnresolvedInterruptedRunForWorktree("/tmp/tree-3").id, fixture.unresolved.id);
      assert.equal(database.getTask(database.getConversation(fixture.interrupted.id).taskId).status, "waiting");
      assert.equal(database.getConversation(fixture.archived.id).archived, 1);
      assert.equal(database.listTasks({ archived: true }).tasks.length, 2);
    } finally { database.close(); }
    const migrated = taskStoreSnapshot(filename);
    database = createOutrightDatabase({ filename });
    try { assert.deepEqual(taskStoreSnapshot(filename), migrated, "a second open is a no-op"); }
    finally { database.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("an interrupted task backfill resumes without duplicates, and a failed rebuild keeps the legacy table", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-task-resume-"));
  const filename = path.join(directory, "outright.db");
  try {
    let database = createOutrightDatabase({ filename });
    try {
      for (let index = 0; index < 70; index += 1) {
        database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: `Chat ${index}`, provider: "codex" });
      }
    } finally { database.close(); }
    seedPreTaskStore(filename, { sessionEpoch: true });
    // The first bounded batch commits during open; closing before the next
    // tick leaves a partially backfilled store.
    database = createOutrightDatabase({ filename });
    assert.equal(database.capacity().migrationStatus, "migrating");
    assert.equal(database.getConversation(database.listConversations()[0].id).taskId, null);
    assert.throws(() => database.listTasks(), (error) => error.statusCode === 503);
    database.close();
    let probe = new Database(filename, { readonly: true });
    try {
      assert.equal(probe.prepare("SELECT COUNT(*) AS count FROM tasks").get().count, 64);
      assert.equal(probe.pragma("table_info(conversations)").some((column) => column.name === "task_id"), false);
    } finally { probe.close(); }
    assert.throws(() => createOutrightDatabase({ filename, tasksMigrationStep: (step) => {
      if (step === "conversations-copied") throw new Error("injected rebuild failure");
    } }), /injected rebuild failure/);
    probe = new Database(filename, { readonly: true });
    try {
      assert.equal(probe.pragma("table_info(conversations)").some((column) => column.name === "task_id"), false);
      assert.equal(probe.prepare("SELECT 1 FROM sqlite_master WHERE name = 'conversations_rebuild'").get(), undefined);
      assert.equal(probe.prepare("SELECT COUNT(*) AS count FROM conversations").get().count, 70);
    } finally { probe.close(); }
    database = createOutrightDatabase({ filename });
    try {
      assert.equal(database.capacity().migrationStatus, "ready");
      probe = new Database(filename, { readonly: true });
      try {
        assert.equal(probe.prepare("SELECT COUNT(*) AS count FROM tasks").get().count, 70);
        assert.equal(probe.prepare("SELECT COUNT(DISTINCT task_id) AS count FROM conversations").get().count, 70);
        const epoch = probe.pragma("table_info(conversations)").find((column) => column.name === "session_epoch");
        assert.deepEqual({ type: epoch.type, notnull: epoch.notnull, dflt: epoch.dflt_value }, { type: "INTEGER", notnull: 1, dflt: "0" });
        assert.equal(probe.prepare("SELECT COUNT(*) AS count FROM conversations WHERE session_epoch != rowid * 3").get().count, 0,
          "a column added by another release keeps its values");
        assert.deepEqual(probe.pragma("foreign_key_check"), []);
      } finally { probe.close(); }
      assert.equal(database.listTasks({ limit: 100 }).tasks.length, 70);
    } finally { database.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("the tasks table rejects scope id combinations that do not match the scope kind", () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    const space = database.createSpace("Scoped");
    for (const input of [
      { scopeKind: "space" },
      { scopeKind: "space", spaceId: space.id, projectId: "p" },
      { scopeKind: "project", spaceId: space.id },
      { scopeKind: "project", projectId: "p", worktreeId: "w" },
      { scopeKind: "worktree", projectId: "p", worktreeId: "w" },
      { scopeKind: "branch", projectId: "p" },
      { scopeKind: "constructor", projectId: "p" },
      { scopeKind: "toString", projectId: "p" },
      { scopeKind: "__proto__", projectId: "p" },
      { scopeKind: ["project"], projectId: "p" },
    ]) {
      assert.throws(() => database.createTask({ ...input, title: "Bad" }), (error) => error.statusCode === 400, JSON.stringify(input));
    }
    assert.throws(() => database.createTask({ scopeKind: "project", projectId: "p", title: " " }), (error) => error.statusCode === 400);
    assert.throws(() => database.createTask({ scopeKind: "space", spaceId: "missing", title: "Orphan" }), (error) => error.statusCode === 404);
    assert.equal(database.createTask({ scopeKind: "space", spaceId: space.id, title: "Space task", origin: "outbot" }).origin, "outbot");
    const project = database.createTask({ scopeKind: "project", projectId: "p", title: "Project task" });
    assert.equal(project.scopeKind, "project");
    for (const patch of [{ constructor: "x" }, JSON.parse('{"__proto__": {"title": "x"}}'), { toString: "x" }]) {
      assert.throws(() => database.updateTask(project.id, patch), (error) => error.statusCode === 400, JSON.stringify(Object.keys(patch)));
    }
  } finally { database.close(); }
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-task-check-"));
  const filename = path.join(directory, "outright.db");
  try {
    createOutrightDatabase({ filename }).close();
    const raw = new Database(filename);
    try {
      raw.prepare("INSERT INTO spaces (id, name, created_at) VALUES ('s', 'S', 'now')").run();
      const insert = raw.prepare(`INSERT INTO tasks (id, scope_kind, space_id, project_id, worktree_id, worktree_path, title, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'T', 'now', 'now')`);
      for (const values of [["space", null, null, null, null], ["space", "s", "p", null, null], ["project", null, null, null, null],
        ["project", "s", "p", null, null], ["project", null, "p", "w", null], ["worktree", null, "p", "w", null], ["worktree", null, null, "w", "/w"]]) {
        assert.throws(() => insert.run(randomTaskId(), ...values), /CHECK constraint failed/, JSON.stringify(values));
      }
      for (const values of [["space", "s", null, null, null], ["project", null, "p", null, null], ["worktree", null, "p", "w", "/w"]]) insert.run(randomTaskId(), ...values);
    } finally { raw.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

function randomTaskId() { return `task-${Math.random().toString(36).slice(2)}`; }

test("task status derives from thread runs, user done overrides it, and both survive restart", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-task-status-"));
  const filename = path.join(directory, "outright.db");
  try {
    let database = createOutrightDatabase({ filename });
    const thread = (title, taskId) => database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title, provider: "codex", taskId });
    const run = (conversation, patch) => {
      const created = database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "go" });
      return patch ? database.updateRun(created.id, patch) : created;
    };
    let ids;
    try {
      const queued = thread("Queued");
      const sibling = thread("Second thread", queued.taskId);
      run(queued);
      run(sibling, { status: "completed" });
      const running = thread("Running");
      run(running, { status: "running", pid: 99999 });
      const waiting = thread("Waiting");
      run(waiting, { status: "interrupted", recoveryClass: "never-started" });
      const settled = thread("Settled");
      run(settled, { status: "interrupted", recoveryClass: "exited", recoveryDecision: "discard" });
      run(settled, { status: "failed" });
      const done = thread("Done");
      run(done, { status: "running", pid: 99998 });
      database.updateTask(done.taskId, { status: "done" });
      ids = { running: [queued.taskId, running.taskId], waiting: waiting.taskId, idle: settled.taskId, done: done.taskId };
      assert.equal(database.getTask(queued.taskId).threadCount, 2);
      const status = () => Object.fromEntries(database.listTasks().tasks.map((task) => [task.id, task.status]));
      assert.deepEqual(status(), { [ids.running[0]]: "running", [ids.running[1]]: "running", [ids.waiting]: "waiting", [ids.idle]: "idle", [ids.done]: "done" });
      assert.deepEqual(database.listTasks({ status: "running" }).tasks.map((task) => task.id).sort(), [...ids.running].sort());
      assert.deepEqual(database.listTasks({ status: "waiting" }).tasks.map((task) => task.id), [ids.waiting]);
      assert.deepEqual(database.listTasks({ status: "open" }).tasks.length, 4);
      assert.equal(database.getTask(ids.done).userStatus, "done");
      assert.equal(database.updateTask(ids.done, { status: "open" }).status, "running", "reopening returns to the derived status");
      database.updateTask(ids.done, { status: "done" });
    } finally { database.close(); }
    database = createOutrightDatabase({ filename });
    try {
      // A restarted runtime would reconcile live rows to interrupted; the
      // stored rows alone still derive the same status after reopening.
      assert.deepEqual(Object.fromEntries(database.listTasks().tasks.map((task) => [task.id, task.status])),
        { [ids.running[0]]: "running", [ids.running[1]]: "running", [ids.waiting]: "waiting", [ids.idle]: "idle", [ids.done]: "done" });
      database.reconcileInterruptedRuns({ probeAlive: () => "exited" });
      assert.equal(database.getTask(ids.running[0]).status, "waiting", "reconciled work waits for the user's recovery choice");
      assert.equal(database.getTask(ids.done).status, "done");
    } finally { database.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("task archive hides threads without deleting them, and retention removes an archived task with its last thread", async () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    const first = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "First", provider: "codex" });
    const second = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "Second", provider: "codex", taskId: first.taskId });
    assert.equal(database.getTask(first.taskId, { threads: true }).threads.length, 2);
    database.addMessage({ conversationId: first.id, role: "user", body: "kept while hidden" });
    database.updateTask(first.taskId, { archived: true });
    assert.deepEqual(database.listConversations().map((row) => row.id), []);
    assert.deepEqual(database.listConversations({ archived: true }).map((row) => row.id).sort(), [first.id, second.id].sort());
    assert.equal(database.getConversation(first.id).archived, 1);
    assert.equal(database.messageCount(first.id), 1);
    assert.throws(() => database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "Late", provider: "codex", taskId: first.taskId }),
      (error) => error.statusCode === 409 && error.details.code === "TASK_ARCHIVED");
    database.updateConversation(second.id, { archived: false });
    assert.equal(database.getTask(first.taskId).archived, false, "restoring a thread restores its task");
    assert.deepEqual(database.listConversations().map((row) => row.id).sort(), [first.id, second.id].sort());

    const single = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "Single", provider: "codex" });
    database.updateConversation(single.id, { archived: true });
    assert.equal(database.getTask(single.taskId).archived, true, "archiving the last visible thread archives its task");
    await database.deleteArchivedConversation(single.id, single.id);
    assert.equal(database.getTask(single.taskId), undefined);
    database.updateConversation(first.id, { archived: true });
    await database.deleteArchivedConversation(first.id, first.id);
    assert.equal(database.getTask(first.taskId).threadCount, 1, "a task with another thread survives retention");
  } finally { await database.close(); }
});

test("deleting a space is refused while it has unarchived space tasks", () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    const space = database.createSpace("Busy");
    const task = database.createTask({ scopeKind: "space", spaceId: space.id, title: "Plan" });
    assert.throws(() => database.deleteSpace(space.id), (error) => error.statusCode === 409 && error.details.code === "SPACE_HAS_TASKS");
    assert.equal(database.listSpaces().spaces.length, 1);
    database.updateTask(task.id, { archived: true });
    assert.equal(database.deleteSpace(space.id), true);
    assert.equal(database.getTask(task.id), undefined);
  } finally { database.close(); }
});

test("moving a thread reassigns it to a destination task and archives the task it leaves empty", () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    const conversation = database.createConversation({ projectId: "p", worktreeId: "a", worktreePath: "/tmp/a", title: "Traveller", provider: "codex" });
    const original = conversation.taskId;
    assert.equal(database.moveConversation(conversation.id, { projectId: "p", worktreeId: "a", worktreePath: "/tmp/a" }).taskId, original);
    const moved = database.moveConversation(conversation.id, { projectId: "p", worktreeId: "b", worktreePath: "/tmp/b" });
    assert.notEqual(moved.taskId, original);
    assert.deepEqual([database.getTask(moved.taskId).worktreeId, database.getTask(moved.taskId).title], ["b", "Traveller"]);
    assert.deepEqual([database.getTask(original).worktreeId, database.getTask(original).threadCount, database.getTask(original).archived], ["a", 0, true]);
    assert.deepEqual(database.listTasks().tasks.map((task) => task.id), [moved.taskId], "an emptied task is not listed as open work");
    const kept = database.createConversation({ projectId: "p", worktreeId: "b", worktreePath: "/tmp/b", title: "Stays", provider: "codex", taskId: moved.taskId });
    const named = database.createTask({ scopeKind: "worktree", projectId: "p", worktreeId: "c", worktreePath: "/tmp/c", title: "Named" });
    assert.throws(() => database.moveConversation(conversation.id, { projectId: "p", worktreeId: "b", worktreePath: "/tmp/b", taskId: named.id }),
      (error) => error.statusCode === 409 && error.details.code === "TASK_SCOPE_MISMATCH");
    assert.equal(database.moveConversation(conversation.id, { projectId: "p", worktreeId: "c", worktreePath: "/tmp/c", taskId: named.id }).taskId, named.id);
    assert.deepEqual([database.getTask(moved.taskId).archived, database.getTask(moved.taskId).threadCount], [false, 1], "a task that keeps a thread stays open");
    assert.equal(database.getConversation(kept.id).archived, 0);
    const project = database.createTask({ scopeKind: "project", projectId: "p", title: "Project" });
    assert.throws(() => database.createConversation({ projectId: "p", worktreeId: "c", worktreePath: "/tmp/c", title: "No", provider: "codex", taskId: project.id }),
      (error) => error.statusCode === 409 && error.details.code === "TASK_SCOPE_UNSUPPORTED");
  } finally { database.close(); }
});

test("task pages are bounded and continue by cursor", () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    for (let index = 0; index < 5; index += 1) database.createTask({ scopeKind: "project", projectId: index % 2 ? "odd" : "even", title: `Task ${index}`, objective: "x".repeat(16 * 1024) });
    for (const limit of [0, 101, 1.5]) assert.throws(() => database.listTasks({ limit }), (error) => error.statusCode === 400);
    assert.throws(() => database.listTasks({ cursor: "not a cursor" }), (error) => error.statusCode === 400);
    assert.throws(() => database.listTasks({ status: "busy" }), (error) => error.statusCode === 400);
    assert.throws(() => database.createTask({ scopeKind: "project", projectId: "p", title: "Big", objective: "x".repeat(16 * 1024 + 1) }), (error) => error.statusCode === 400);
    const seen = [];
    let cursor = null;
    do {
      const page = database.listTasks({ limit: 2, cursor });
      assert.ok(page.tasks.length <= 2);
      seen.push(...page.tasks.map((task) => task.id));
      cursor = page.nextCursor;
    } while (cursor);
    assert.equal(new Set(seen).size, 5);
    assert.equal(database.listTasks({ projectId: "odd" }).tasks.length, 2);
  } finally { database.close(); }
});

test("retention during a pending task backfill leaves no task without its conversation", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-task-backfill-delete-"));
  const filename = path.join(directory, "outright.db");
  try {
    let database = createOutrightDatabase({ filename });
    let doomed;
    let vanished;
    try {
      doomed = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "Doomed", provider: "codex" });
      vanished = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "Vanished", provider: "codex" });
      database.addMessage({ conversationId: doomed.id, role: "user", body: "remove me" });
      database.updateConversation(doomed.id, { archived: true });
      for (let index = 0; index < 70; index += 1) {
        database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: `Chat ${index}`, provider: "codex" });
      }
    } finally { database.close(); }
    seedPreTaskStore(filename);
    // Hold the backfill after its first batch, so deletion runs while the
    // legacy table is still in place.
    let batches = 0;
    database = createOutrightDatabase({ filename, onMigrationError: () => {}, tasksMigrationStep: (step) => {
      if (step === "tasks-backfilled" && ++batches > 1) throw new Error("hold the backfill");
    } });
    try {
      assert.equal(database.capacity().migrationStatus, "migrating");
      assert.equal((await database.deleteArchivedConversation(doomed.id, doomed.id)).deleted, 1);
    } finally { await database.close(); }
    const raw = new Database(filename);
    try {
      assert.equal(raw.pragma("table_info(conversations)").some((column) => column.name === "task_id"), false);
      // Both conversations were in the first backfilled batch. A conversation
      // removed by another path, such as a shadow cutover, is swept on rebuild.
      assert.deepEqual(raw.prepare("SELECT id FROM tasks WHERE id IN (?, ?)").all(doomed.id, vanished.id).map((row) => row.id), [vanished.id]);
      raw.prepare("DELETE FROM conversations WHERE id = ?").run(vanished.id);
    } finally { raw.close(); }
    database = createOutrightDatabase({ filename });
    try {
      assert.equal(database.capacity().migrationStatus, "ready");
      const probe = new Database(filename, { readonly: true });
      try {
        assert.equal(probe.prepare("SELECT COUNT(*) AS count FROM tasks").get().count, 70);
        assert.equal(probe.prepare("SELECT COUNT(*) AS count FROM tasks WHERE NOT EXISTS (SELECT 1 FROM conversations WHERE task_id = tasks.id)").get().count, 0);
        assert.equal(probe.prepare("SELECT COUNT(*) AS count FROM conversations").get().count, 70);
      } finally { probe.close(); }
    } finally { await database.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("threads hidden by an archived task are listed, deleted and pruned like archived threads", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-task-archive-retention-"));
  const filename = path.join(directory, "outright.db");
  const database = createOutrightDatabase({ filename, runtimeLease: true });
  try {
    const thread = (title, taskId) => database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title, provider: "codex", taskId });
    const small = thread("Small");
    const giant = thread("Giant", small.taskId);
    const pinned = thread("Pinned", small.taskId);
    const message = database.addMessage({ conversationId: giant.id, role: "assistant", body: "small for now" });
    database.updateConversation(pinned.id, { pinned: true });
    const writer = new Database(filename);
    try { writer.prepare("UPDATE messages SET body = ? WHERE id = ?").run("x".repeat(4 * 1024 * 1024), message.id); }
    finally { writer.close(); }
    await assert.rejects(database.deleteArchivedConversation(small.id, small.id), (error) => error.statusCode === 409);
    database.updateTask(small.taskId, { archived: true });
    assert.deepEqual(database.listDeletableArchivedConversations().conversations.map((row) => row.id).sort(),
      [small.id, giant.id, pinned.id].sort());
    assert.equal((await database.deleteArchivedConversation(small.id, small.id)).deleted, 1);
    const writerAge = new Database(filename);
    try {
      const old = new Date(Date.now() - 100 * 86_400_000).toISOString();
      writerAge.prepare("UPDATE conversations SET updated_at = ? WHERE id IN (?, ?)").run(old, giant.id, pinned.id);
    } finally { writerAge.close(); }
    // The giant row is reclaimed by the shadow worker; the pinned thread
    // keeps automatic retention away, as it does for an archived thread.
    assert.deepEqual((await database.pruneHistory()).ids, [giant.id]);
    assert.equal(database.getConversation(giant.id), undefined);
    assert.deepEqual([database.getTask(small.taskId).threadCount, database.getTask(small.taskId).archived], [1, true]);
    assert.equal((await database.deleteArchivedConversation(pinned.id, pinned.id)).deleted, 1);
    assert.equal(database.getTask(small.taskId), undefined, "the archived task leaves with its last thread");
  } finally { await database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("task detail bounds each thread summary and the serialized thread list", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-task-detail-"));
  const filename = path.join(directory, "outright.db");
  let database = createOutrightDatabase({ filename });
  try {
    const first = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "Legacy", provider: "codex" });
    for (let index = 1; index < 200; index += 1) {
      database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "🧵".repeat(500), provider: "codex", taskId: first.taskId });
    }
    database.close();
    const writer = new Database(filename);
    try { writer.prepare("UPDATE conversations SET title = ? WHERE id = ?").run("t".repeat(1024 * 1024), first.id); }
    finally { writer.close(); }
    database = createOutrightDatabase({ filename });
    const detail = database.getTask(first.taskId, { threads: true });
    assert.equal(detail.threadCount, 200);
    assert.equal(detail.threads[0].title.length, 500, "a legacy title is projected short");
    assert.equal(detail.threadsTruncated, true);
    assert.ok(detail.threads.length > 50 && detail.threads.length < 200, `${detail.threads.length} threads`);
    assert.ok(Buffer.byteLength(JSON.stringify(detail.threads)) <= 256 * 1024 + detail.threads.length);
    assert.ok(Buffer.byteLength(JSON.stringify(detail)) < 300 * 1024);
    const few = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: "/tmp/w", title: "Few", provider: "codex" });
    assert.deepEqual([database.getTask(few.taskId, { threads: true }).threads.length, database.getTask(few.taskId, { threads: true }).threadsTruncated], [1, false]);
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});
