export function recoveryGate(conversation) {
  return conversation?.worktreeInterruptedRun
    ?? conversation?.oldestInterruptedRun
    ?? conversation?.runs?.filter((run) => run.status === "interrupted" && !run.recoveryDecision).at(-1)
    ?? null;
}

export function isComposerSubmitKey(event) {
  return event?.key === "Enter" && !event.shiftKey && !event.isComposing && !event.repeat;
}

export function draftAfterSubmission(currentDraft, submittedDraft) {
  return currentDraft === submittedDraft ? "" : currentDraft;
}

export function streamingTextAfterDurableMessage(currentText, message) {
  return message?.role === "assistant" && message?.payload?.runId ? "" : currentText;
}

// The durable assistant message owns a prefix of the response and the live
// stream owns only the suffix after that prefix. Applying both event kinds
// through one reducer keeps that ownership rule identical in the UI and in
// end-to-end publication-order regressions.
export function streamingTextAfterRuntimeEvent(currentText, event, checkpointEventSeq = 0) {
  if (event?.type === "message.created") {
    return streamingTextAfterDurableMessage(currentText, event.payload);
  }
  if (event?.type !== "run.event") return currentText;
  if (event.payload?.type === "assistant.delta") {
    if (Number.isSafeInteger(event.payload.seq) && event.payload.seq <= checkpointEventSeq) return currentText;
    return `${currentText}${event.payload.payload?.text ?? ""}`;
  }
  if (event.payload?.type === "assistant.message") return "";
  return currentText;
}

export function recordCheckpointCursor(cursors, message) {
  const runId = message?.payload?.runId;
  const seq = message?.payload?.checkpointEventSeq;
  if (typeof runId === "string" && Number.isSafeInteger(seq)) {
    cursors.set(runId, Math.max(cursors.get(runId) ?? 0, seq));
  }
  return cursors;
}

export function checkpointCursors(messages = [], initial = new Map()) {
  const cursors = new Map(initial);
  for (const message of messages) recordCheckpointCursor(cursors, message);
  return cursors;
}

// HTTP snapshots and websocket events travel over independent connections.
// Events captured while a conversation request is in flight are replayed over
// its durable snapshot before React sees either state, so a late response can
// neither roll back a checkpoint cursor nor erase a newer live tail.
export function replayConversationEvents(snapshotMessages = [], events = []) {
  let messages = [...snapshotMessages];
  const cursors = checkpointCursors(messages);
  let streamingText = "";
  let runEvents = [];
  for (const event of events) {
    if (event?.type === "message.created") {
      recordCheckpointCursor(cursors, event.payload);
      streamingText = streamingTextAfterRuntimeEvent(streamingText, event);
      messages = [...messages.filter((message) => message.id !== event.payload.id), event.payload]
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      continue;
    }
    if (event?.type !== "run.event") continue;
    if (event.payload?.type === "assistant.delta") {
      streamingText = streamingTextAfterRuntimeEvent(streamingText, event, cursors.get(event.runId) ?? 0);
    } else if (event.payload?.type === "assistant.message") {
      streamingText = streamingTextAfterRuntimeEvent(streamingText, event);
    }
    if (event.payload?.type?.startsWith("tool.")) runEvents = [...runEvents, event.payload].slice(-20);
  }
  return { messages, cursors, streamingText, runEvents };
}

export function isUnverifiableLegacyRecovery(run) {
  return run?.recoveryClass === "unknown" && !run?.pid && !run?.worktreePath;
}

export function recoveryBelongsToConversation(run, conversation) {
  return Boolean(run && conversation && run.conversationId === conversation.id);
}

export function recoveryNoticeAction(run, conversation) {
  if (isUnverifiableLegacyRecovery(run)) return "discard-unverifiable";
  return recoveryBelongsToConversation(run, conversation) ? "owner" : "open-recovery";
}

export function shouldReloadConversationForResolvedRun(event, selectedConversationId, interruptedRunId) {
  if (event?.type !== "run.resolved") return false;
  return event.conversationId === selectedConversationId
    || Boolean(event.runId && event.runId === interruptedRunId);
}
