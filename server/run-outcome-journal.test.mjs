import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
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
