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

export function isUnverifiableLegacyRecovery(run) {
  return run?.recoveryClass === "unknown" && !run?.pid && !run?.worktreePath;
}

export function recoveryBelongsToConversation(run, conversation) {
  return Boolean(run && conversation && run.conversationId === conversation.id);
}
