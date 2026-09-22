import assert from "node:assert/strict";
import test from "node:test";
import { draftAfterSubmission, isComposerSubmitKey, isUnverifiableLegacyRecovery, recoveryBelongsToConversation, recoveryGate, streamingTextAfterDurableMessage } from "../src/recovery-policy.js";

test("worktree recovery metadata gates sibling composers before conversation-local history", () => {
  const local = { id: "local", status: "interrupted" };
  const sibling = { id: "sibling", conversationId: "owner", status: "interrupted" };
  assert.equal(recoveryGate({ worktreeInterruptedRun: sibling, oldestInterruptedRun: local }), sibling);
  assert.equal(recoveryBelongsToConversation(sibling, { id: "selected" }), false);
  assert.equal(recoveryBelongsToConversation(sibling, { id: "owner" }), true);
});

test("recovery gate retains conversation-local and legacy runtime fallbacks", () => {
  const local = { id: "local", status: "interrupted" };
  const resolved = { id: "resolved", status: "interrupted", recoveryDecision: "discard" };
  const older = { id: "older", status: "interrupted" };
  const newer = { id: "newer", status: "interrupted" };
  assert.equal(recoveryGate({ oldestInterruptedRun: local }), local);
  assert.equal(recoveryGate({ runs: [resolved, older, newer] }), newer);
  assert.equal(recoveryGate({ runs: [resolved] }), null);
  assert.equal(recoveryGate(null), null);
  assert.equal(recoveryGate(undefined), null);
});

test("keyboard submission recognizes plain Enter but preserves Shift+Enter and composition", () => {
  assert.equal(isComposerSubmitKey({ key: "Enter", shiftKey: false, isComposing: false }), true);
  assert.equal(isComposerSubmitKey({ key: "Enter", shiftKey: false, isComposing: false, repeat: true }), false);
  assert.equal(isComposerSubmitKey({ key: "Enter", shiftKey: true, isComposing: false }), false);
  assert.equal(isComposerSubmitKey({ key: "Enter", shiftKey: false, isComposing: true }), false);
  assert.equal(isComposerSubmitKey({ key: "a", shiftKey: false, isComposing: false }), false);
});

test("a completed submission only clears the draft that was submitted", () => {
  assert.equal(draftAfterSubmission("submitted prompt", "submitted prompt"), "");
  assert.equal(draftAfterSubmission("newer prompt", "submitted prompt"), "newer prompt");
});

test("durable run checkpoints replace the overlapping live stream", () => {
  assert.equal(streamingTextAfterDurableMessage("duplicated answer", { role: "assistant", payload: { runId: "run-1" } }), "");
  assert.equal(streamingTextAfterDurableMessage("keep live output", { role: "user" }), "keep live output");
  assert.equal(streamingTextAfterDurableMessage("keep live output", { role: "assistant", payload: {} }), "keep live output");
});

test("only legacy rows without any process or worktree identity offer manual cleanup", () => {
  assert.equal(isUnverifiableLegacyRecovery({ recoveryClass: "unknown", pid: null, worktreePath: null }), true);
  assert.equal(isUnverifiableLegacyRecovery({ recoveryClass: "unknown", pid: 42, worktreePath: null }), false);
  assert.equal(isUnverifiableLegacyRecovery({ recoveryClass: "unknown", pid: null, worktreePath: "/tmp/tree" }), false);
  assert.equal(isUnverifiableLegacyRecovery({ recoveryClass: "never-started", pid: null, worktreePath: null }), false);
});
