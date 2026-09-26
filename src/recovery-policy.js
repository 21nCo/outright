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

export function recordCheckpointCursor(cursors, message, activeRunIds = new Set()) {
  const runId = message?.payload?.runId;
  const seq = message?.payload?.checkpointEventSeq;
  if (typeof runId === "string" && Number.isSafeInteger(seq)) {
    const previous = cursors.get(runId);
    if (previous !== undefined && seq <= previous) return cursors;
    cursors.delete(runId);
    cursors.set(runId, seq);
    // The server replays at most 1,000 recent events on one ordered socket.
    // Retain every active run even when many completed runs cycle through the
    // cache; an old completed run beyond that replay horizon cannot emit a
    // new delayed event, while a long-lived active run still can.
    while (cursors.size > 2048) {
      let evictable;
      for (const id of cursors.keys()) { if (!activeRunIds.has(id)) { evictable = id; break; } }
      if (!evictable) break;
      cursors.delete(evictable);
    }
  }
  return cursors;
}

export function checkpointCursors(messages = [], initial = new Map(), activeRunIds = new Set()) {
  const cursors = new Map(initial);
  for (const message of messages) recordCheckpointCursor(cursors, message, activeRunIds);
  return cursors;
}

export function isStaleCheckpointMessage(cursors, message) {
  const runId = message?.payload?.runId;
  const seq = message?.payload?.checkpointEventSeq;
  return typeof runId === "string" && Number.isSafeInteger(seq)
    && cursors.has(runId) && seq <= cursors.get(runId);
}

export function upsertRuntimeMessage(messages, message) {
  return [...messages.filter((entry) => entry.id !== message.id), message]
    .sort(compareMessageOrder);
}

export function messagePrecedesPage(message, first) {
  if (Number.isSafeInteger(message?.searchOrder) && Number.isSafeInteger(first?.searchOrder)) return message.searchOrder < first.searchOrder;
  return Boolean(message?.createdAt && first?.createdAt && message.createdAt < first.createdAt);
}

function compareMessageOrder(left, right) {
  if (Number.isSafeInteger(left.searchOrder) && Number.isSafeInteger(right.searchOrder)) return left.searchOrder - right.searchOrder;
  return left.createdAt.localeCompare(right.createdAt);
}

// HTTP snapshots and websocket events travel over independent connections.
// Events captured while a conversation request is in flight are replayed over
// its durable snapshot before React sees either state, so a late response can
// neither roll back a checkpoint cursor nor erase a newer live tail.
export function bufferConversationRuntimeEvent(pendingLoad, event, maxBytes) {
  if (!pendingLoad || pendingLoad.conversationId !== event?.conversationId) return "ignored";
  const eventBytes = JSON.stringify(event).length * 2;
  if (pendingLoad.eventBytes + eventBytes > maxBytes) {
    pendingLoad.overflowed = true;
    return "overflow";
  }
  pendingLoad.eventBytes += eventBytes;
  pendingLoad.events.push(event);
  return "buffered";
}

export function replayConversationEvents(snapshotMessages = [], events = [], maxMessages = Number.POSITIVE_INFINITY) {
  const messagesById = new Map(snapshotMessages.map((message) => [message.id, message]));
  const cursors = checkpointCursors(snapshotMessages);
  let streamingText = "";
  let runEvents = [];
  for (const event of events) {
    if (event?.type === "message.created") {
      if (isStaleCheckpointMessage(cursors, event.payload)) continue;
      recordCheckpointCursor(cursors, event.payload);
      streamingText = streamingTextAfterRuntimeEvent(streamingText, event);
      messagesById.delete(event.payload.id);
      messagesById.set(event.payload.id, event.payload);
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
  let messages = [...messagesById.values()].sort(compareMessageOrder);
  const dropped = Math.max(0, messages.length - maxMessages);
  if (dropped) messages = messages.slice(-maxMessages);
  return { messages, cursors, streamingText, runEvents, dropped };
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
  if (!["run.resolved", "run.recovery-updated"].includes(event?.type)) return false;
  return event.conversationId === selectedConversationId
    || Boolean(event.runId && event.runId === interruptedRunId);
}
