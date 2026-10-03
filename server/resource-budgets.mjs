// Shared admission and retention defaults. Future workflow children and
// diagnostic calls must debit their parent scope rather than start a new one.
export const RESOURCE_BUDGETS = Object.freeze({
  maxConcurrentRuns: 3,
  maxQueuedRuns: 32,
  maxRetainedMiB: 512,
  physicalDatabaseMultiplier: 4,
  physicalRecoveryReserveBytes: 64 * 1024 * 1024,
  physicalArchiveHeadroomBytes: 32 * 1024 * 1024,
  retentionDays: 90,
  maxRunTranscriptItems: 2000,
  maxRunTranscriptBytes: 16 * 1024 * 1024,
  maxRunEventBytes: 8 * 1024 * 1024,
});

export const RETAINED_ROW_OVERHEAD_BYTES = 128;
export const RETAINED_MESSAGE_FIELDS = Object.freeze([
  "id", "conversation_id", "role", "kind", "body", "payload", "created_at",
]);

// Match the messages row charged by database.mjs retainedSizeExpression.
// Checkpoints can acquire a cursor in the same commit as their delta event;
// budget the longest safe integer before that cursor is assigned.
export function retainedTranscriptMessageBytes(message) {
  const payload = message.kind === "text"
    ? { ...message.payload, checkpointEventSeq: Number.MAX_SAFE_INTEGER }
    : message.payload;
  return RETAINED_ROW_OVERHEAD_BYTES + [
    message.id, message.conversationId, message.role, message.kind ?? "text",
    message.body ?? "", JSON.stringify(payload ?? null), message.createdAt ?? new Date().toISOString(),
  ].reduce((bytes, value) => bytes + Buffer.byteLength(value ?? ""), 0);
}
