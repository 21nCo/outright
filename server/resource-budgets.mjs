// Shared admission and retention defaults. Future workflow children and
// diagnostic calls must debit their parent scope rather than start a new one.
export const RESOURCE_BUDGETS = Object.freeze({
  maxQueuedRuns: 32,
  maxRetainedMiB: 512,
  retentionDays: 90,
  maxRunTranscriptItems: 2000,
  maxRunTranscriptBytes: 16 * 1024 * 1024,
  maxRunEventBytes: 8 * 1024 * 1024,
});
