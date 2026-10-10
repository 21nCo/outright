import { anthropicApiAdapter } from "./anthropic-api.mjs";
import { claudeAdapter } from "./claude.mjs";
import { codexAdapter } from "./codex.mjs";
import { configurationError, validateRunConfiguration } from "./contract.mjs";

export { describeAdapter, versionCompatibility } from "./contract.mjs";

// Adding a provider means adding an adapter here. Persisted runs and
// conversations store only the adapter id, so ids are permanent.
export const EXECUTION_ADAPTERS = Object.freeze([codexAdapter, claudeAdapter, anthropicApiAdapter]);
export const EXECUTION_ADAPTER_IDS = Object.freeze(EXECUTION_ADAPTERS.map((adapter) => adapter.id));

export function findExecutionAdapter(id) {
  return EXECUTION_ADAPTERS.find((adapter) => adapter.id === id) ?? null;
}

export function requireExecutionAdapter(id) {
  const adapter = findExecutionAdapter(id);
  if (!adapter) throw configurationError(`Unknown provider: ${String(id).slice(0, 64)}`, "PROVIDER_UNKNOWN", 400);
  return adapter;
}

// Static preflight shared by enqueue and launch. Availability and version
// compatibility are separate, asynchronous discovery checks.
export function validateExecutionConfiguration(config) {
  const adapter = requireExecutionAdapter(config.provider);
  validateRunConfiguration(adapter, config);
  return adapter;
}

export function buildExecutionLaunch({ conversation, run, sessionId }) {
  const adapter = validateExecutionConfiguration({ ...run, sessionId });
  return adapter.buildLaunch({ worktreePath: conversation.worktreePath, run, sessionId: sessionId || null });
}
