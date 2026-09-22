import assert from "node:assert/strict";
import test from "node:test";
import { bufferConversationRuntimeEvent, checkpointCursors, draftAfterSubmission, isComposerSubmitKey, isStaleCheckpointMessage, isUnverifiableLegacyRecovery, recoveryBelongsToConversation, recoveryGate, recoveryNoticeAction, replayConversationEvents, shouldReloadConversationForResolvedRun, streamingTextAfterDurableMessage, streamingTextAfterRuntimeEvent } from "../src/recovery-policy.js";

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
  assert.equal(streamingTextAfterRuntimeEvent("", { type: "run.event", payload: { type: "assistant.delta", payload: { text: "live tail" } } }), "live tail");
  assert.equal(streamingTextAfterRuntimeEvent("live tail", { type: "message.created", payload: { role: "assistant", payload: { runId: "run-1" } } }), "");
  assert.equal(streamingTextAfterRuntimeEvent("live tail", { type: "run.event", payload: { type: "assistant.message", payload: { text: "done" } } }), "");
});

test("a loaded checkpoint cursor discards its delayed durable delta", () => {
  const delayed = {
    type: "run.event",
    runId: "run-1",
    payload: { runId: "run-1", seq: 7, type: "assistant.delta", payload: { text: "already durable" } },
  };
  assert.equal(streamingTextAfterRuntimeEvent("", delayed, 7), "", "the checkpoint already owns this delta");
  assert.equal(streamingTextAfterRuntimeEvent("", { ...delayed, payload: { ...delayed.payload, seq: 8 } }, 7), "already durable", "a later delta remains live");
});

test("conversation loads replay websocket events over a monotonic durable snapshot", () => {
  const checkpoint = { id: "message-1", role: "assistant", createdAt: "2026-09-22T00:00:00Z", payload: { runId: "run-1", checkpointEventSeq: 7 } };
  const delayed = { type: "run.event", runId: "run-1", payload: { runId: "run-1", seq: 7, type: "assistant.delta", payload: { text: "durable" } } };
  const newer = { type: "run.event", runId: "run-1", payload: { runId: "run-1", seq: 8, type: "assistant.delta", payload: { text: " live" } } };
  const replayed = replayConversationEvents([checkpoint], [delayed, newer]);
  assert.equal(replayed.streamingText, " live", "a late HTTP response keeps only the websocket tail after its checkpoint");
  assert.equal(replayed.cursors.get("run-1"), 7);

  const advanced = { ...checkpoint, payload: { ...checkpoint.payload, checkpointEventSeq: 8 }, body: "durable live" };
  const checkpointed = replayConversationEvents([checkpoint], [newer, { type: "message.created", payload: advanced }]);
  assert.equal(checkpointed.streamingText, "", "a websocket checkpoint consumes its overlapping live tail");
  assert.equal(checkpointed.cursors.get("run-1"), 8);
  assert.deepEqual(checkpointed.messages, [advanced]);

  const delayedCheckpoint = { type: "message.created", payload: checkpoint };
  const newerSnapshot = replayConversationEvents([advanced], [delayedCheckpoint, newer]);
  assert.deepEqual(newerSnapshot.messages, [advanced], "a delayed websocket checkpoint cannot replace the newer HTTP body");
  assert.equal(newerSnapshot.streamingText, "", "the newer HTTP cursor suppresses both its stale checkpoint and already-durable delta");
  assert.equal(isStaleCheckpointMessage(newerSnapshot.cursors, checkpoint), true);
});

test("checkpoint cursors loaded from older pages only advance", () => {
  const current = new Map([["run-1", 9]]);
  const merged = checkpointCursors([
    { payload: { runId: "run-1", checkpointEventSeq: 4 } },
    { payload: { runId: "run-2", checkpointEventSeq: 3 } },
  ], current);
  assert.equal(merged.get("run-1"), 9);
  assert.equal(merged.get("run-2"), 3);
});

test("conversation replay and its in-flight event buffer remain bounded", () => {
  const messages = Array.from({ length: 5 }, (_, index) => ({ id: `message-${index}`, role: "user", createdAt: `2026-09-22T00:00:0${index}Z` }));
  const replayed = replayConversationEvents(messages, [], 3);
  assert.deepEqual(replayed.messages.map((message) => message.id), ["message-2", "message-3", "message-4"]);
  assert.equal(replayed.dropped, 2);

  const pending = { conversationId: "conversation-1", events: [], eventBytes: 0, overflowed: false };
  const event = { type: "run.event", conversationId: "conversation-1", payload: { type: "assistant.delta", payload: { text: "some streamed text" } } };
  assert.equal(bufferConversationRuntimeEvent(pending, event, 1000), "buffered");
  assert.equal(bufferConversationRuntimeEvent(pending, event, pending.eventBytes), "overflow");
  assert.equal(pending.overflowed, true);
  assert.equal(pending.events.length, 1, "overflow never grows the retained event list");
  assert.equal(bufferConversationRuntimeEvent(pending, { ...event, conversationId: "another" }, 1000), "ignored");
});

test("only legacy rows without any process or worktree identity offer manual cleanup", () => {
  const legacy = { conversationId: "missing-owner", recoveryClass: "unknown", pid: null, worktreePath: null };
  assert.equal(isUnverifiableLegacyRecovery(legacy), true);
  assert.equal(isUnverifiableLegacyRecovery({ recoveryClass: "unknown", pid: 42, worktreePath: null }), false);
  assert.equal(isUnverifiableLegacyRecovery({ recoveryClass: "unknown", pid: null, worktreePath: "/tmp/tree" }), false);
  assert.equal(isUnverifiableLegacyRecovery({ recoveryClass: "never-started", pid: null, worktreePath: null }), false);
  assert.equal(recoveryNoticeAction(legacy, { id: "visible-sibling" }), "discard-unverifiable", "manual cleanup stays available when the owner target cannot be opened");
  assert.equal(recoveryNoticeAction(legacy, { id: "missing-owner" }), "discard-unverifiable");
  assert.equal(recoveryNoticeAction({ conversationId: "owner", recoveryClass: "exited" }, { id: "visible-sibling" }), "open-recovery");
});

test("resolved worktree recovery refreshes both its owner and gated sibling chats", () => {
  const event = { type: "run.resolved", conversationId: "owner", runId: "run-1" };
  assert.equal(shouldReloadConversationForResolvedRun(event, "owner", null), true);
  assert.equal(shouldReloadConversationForResolvedRun(event, "visible-sibling", "run-1"), true);
  assert.equal(shouldReloadConversationForResolvedRun(event, "visible-sibling", "another-run"), false);
  assert.equal(shouldReloadConversationForResolvedRun({ ...event, type: "run.event" }, "owner", "run-1"), false);
});
