import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readRunOutcome, saveRunOutcome } from "./run-outcome-journal.mjs";

test("an outcome saved without optional transcript fields survives journal replay", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-outcome-"));
  const runId = "00000000-0000-4000-8000-000000000001";
  try {
    saveRunOutcome(directory, runId, {
      status: "completed", finishedAt: "2026-10-05T00:00:00.000Z", exitCode: 0, message: "",
    });
    assert.deepEqual(readRunOutcome(directory, runId), {
      version: 2, runId, status: "completed", finishedAt: "2026-10-05T00:00:00.000Z",
      exitCode: 0, message: "", transcriptOmitted: false, transcriptMessage: null,
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("invalid and future transcript timestamps cannot change recovered conversation recency", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-outcome-time-"));
  const runId = "00000000-0000-4000-8000-000000000002";
  const base = { version: 2, runId, status: "completed", finishedAt: new Date().toISOString(),
    exitCode: 0, message: "", transcriptOmitted: false };
  try {
    for (const createdAt of ["garbage", "9999-01-01T00:00:00.000Z"]) {
      const transcriptMessage = { id: `${runId}:1`, conversationId: "conversation", role: "assistant",
        kind: "text", body: "final", payload: { runId }, createdAt };
      assert.throws(() => saveRunOutcome(directory, runId, { ...base, transcriptMessage }), /timestamp/);
      writeFileSync(path.join(directory, `${runId}.outcome.json`), JSON.stringify({ ...base, transcriptMessage }));
      assert.throws(() => readRunOutcome(directory, runId), /Invalid run outcome record/);
    }
    saveRunOutcome(directory, runId, { ...base, transcriptMessage: { id: `${runId}:1`,
      conversationId: "conversation", role: "assistant", kind: "text", body: "final",
      payload: { runId }, createdAt: base.finishedAt } });
    assert.equal(readRunOutcome(directory, runId).transcriptMessage.body, "final");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
