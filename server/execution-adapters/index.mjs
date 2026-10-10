import { anthropicApiAdapter } from "./anthropic-api.mjs";
import { claudeAdapter } from "./claude.mjs";
import { codexAdapter } from "./codex.mjs";
import { configurationError, validateRunConfiguration } from "./contract.mjs";

export { describeAdapter, isProviderSessionId, versionCompatibility } from "./contract.mjs";

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

// Direct-provider variables are removed from every spawn and handed only to
// the adapter that declares them. A harness keeps its CLI's own authority,
// including any credentials the user configured for that CLI.
export const DIRECT_PROVIDER_VARIABLES = Object.freeze(EXECUTION_ADAPTERS.flatMap((adapter) => adapter.environment));
const directProviderVariables = new Set(DIRECT_PROVIDER_VARIABLES);

// The base environment for any subprocess that is not a direct-provider run.
// server/child-process.mjs applies it to every spawn. Windows names are
// case-insensitive.
export function withoutDirectProviderCredentials(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !directProviderVariables.has(key.toUpperCase())));
}

export function buildExecutionEnvironment(id, runtimeEnvironment, inherited = runtimeEnvironment) {
  const adapter = requireExecutionAdapter(id);
  const environment = withoutDirectProviderCredentials(inherited);
  for (const variable of adapter.environment) if (runtimeEnvironment[variable]) environment[variable] = runtimeEnvironment[variable];
  return environment;
}
