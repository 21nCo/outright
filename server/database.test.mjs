import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOutrightDatabase, defaultProbeRun } from "./database.mjs";

test("persists settings, groups, conversations, messages, runs, and search", () => {
  const database = createOutrightDatabase({ filename: ":memory:" });
  try {
    assert.equal(database.updateSettings({ provider: "claude", maxConcurrentRuns: 5 }).provider, "claude");
    const group = database.createGroup("Client work");
    database.setProjectGroup("project-1", group.id);
    assert.equal(database.listGroups().memberships["project-1"], group.id);

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
    let maximumGapMs = 0;
    let lastTick = performance.now();
    const timer = setInterval(() => {
      const current = performance.now();
      maximumGapMs = Math.max(maximumGapMs, current - lastTick);
      lastTick = current;
      timerTicks += 1;
    }, 1);
    try {
      let result = await database.findMessagePage(chat.id, "tail needle", first.id);
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
    assert.ok(maximumGapMs < 250, `large body scan delayed the event loop for ${maximumGapMs.toFixed(1)}ms`);
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
      const started = performance.now();
      assert.equal((await database.findMessagePage(target.id, "absent", null)).matchId, null);
      durations.push(performance.now() - started);
    }
    assert.ok(durations.sort((a, b) => a - b)[1] < 250, `Sparse search blocked the runtime: ${durations.map((value) => value.toFixed(1)).join(", ")}ms`);
    const pageStarted = performance.now();
    assert.equal(database.listMessagePage(target.id, { beforeId: last.id, limit: 1 }).messages[0].id, first.id);
    assert.ok(performance.now() - pageStarted < 250, "Sparse history pagination scanned sibling messages");
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
    assert.equal(database.launchDirectory, path.join(root, "data", "launches"));
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
    record("run-that-never-existed", 444);

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
    assert.equal(existsSync(path.join(launchDirectory, "run-that-never-existed.json")), false, "a record for an unknown run is swept");
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
    assert.equal(database.launchDirectory, path.join(root, "custom", "launches"));
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
