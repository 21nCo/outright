import { anthropicApiAdapter } from "./anthropic-api.mjs";
import { claudeAdapter } from "./claude.mjs";
import { codexAdapter } from "./codex.mjs";
import { configurationError, validateRunConfiguration } from "./contract.mjs";

export { describeAdapter, isModelName, isProviderSessionId, MODEL_NAME_REQUIREMENT, modelMatches, requestedModel, versionCompatibility } from "./contract.mjs";

// Adding a provider means adding an adapter here. Persisted runs and
// conversations store only the adapter id, so ids are permanent.
export const EXECUTION_ADAPTERS = Object.freeze([codexAdapter, claudeAdapter, anthropicApiAdapter]);
export const EXECUTION_ADAPTER_IDS = Object.freeze(EXECUTION_ADAPTERS.map((adapter) => adapter.id));

export function findExecutionAdapter(id) {
  return EXECUTION_ADAPTERS.find((adapter) => adapter.id === id) ?? null;
}

export function requireExecutionAdapter(id) {
  const adapter = findExecutionAdapter(id);
  // The submitted value is not echoed; it may be any JSON type or length.
  if (!adapter) throw configurationError(`Provider must be one of ${EXECUTION_ADAPTER_IDS.join(", ")}`, "PROVIDER_UNKNOWN", 400);
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

// A configured account selects its CLI home directory; the default account
// keeps whatever home and credentials the inherited environment selects.
export function buildExecutionEnvironment(id, runtimeEnvironment, inherited = runtimeEnvironment, account = null) {
  const adapter = requireExecutionAdapter(id);
  const environment = withoutDirectProviderCredentials(inherited);
  for (const variable of adapter.environment) if (runtimeEnvironment[variable]) environment[variable] = runtimeEnvironment[variable];
  if (account?.homePath) {
    if (!adapter.accounts) throw configurationError(`${adapter.label} has no selectable accounts`, "PROVIDER_ACCOUNT_UNSUPPORTED");
    return withAccountHome(environment, adapter.accounts, account.homePath);
  }
  return environment;
}

// An added account's login is the one in its home: every inherited
// credential source (accounts.isCredential) is removed.
export function withAccountHome(environment, { homeVariable, isCredential }, homePath) {
  // Windows names are case-insensitive; never leave a second spelling behind.
  const scoped = Object.fromEntries(Object.entries(environment).filter(([key]) => key.toUpperCase() !== homeVariable && !isCredential(key.toUpperCase())));
  scoped[homeVariable] = homePath;
  return scoped;
}
