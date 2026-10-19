// Execution adapter contract, version 1.
//
// An adapter is the only place that knows a provider's command line, native
// permission names, session identity and stream format. The scheduler owns
// supervision, persistence and recovery and treats every adapter alike.
//
// Two kinds exist. A "harness" adapter drives an external agent CLI (Codex,
// Claude Code, ...) that authenticates itself. A "direct-provider" adapter is
// Outright-managed execution against a model provider API; it must name its
// own credential reference and never inherits a harness login. Its settings
// live in Outright's own OUTRIGHT_* namespace and are handed only to its own
// spawn, so enabling it never changes the authority of a harness CLI.
export const ADAPTER_CONTRACT_VERSION = 1;
export const APPROVAL_POLICIES = Object.freeze(["read-only", "workspace-write", "danger-full-access"]);
export const REASONING_EFFORTS = Object.freeze(["low", "medium", "high", "xhigh"]);
// A provider.failure with `terminal: true` fails the run even if the process
// exits 0; any other failure only explains a nonzero exit. A "model" event
// names the model the provider reports actually answered. A "rate_limit"
// event carries the account's usage windows as the provider reports them.
export const NORMALIZED_EVENT_TYPES = Object.freeze(["session", "assistant.delta", "assistant.message", "tool.started", "tool.completed", "usage", "model", "rate_limit", "provider.failure", "provider.event"]);
// Values that reach a provider's argv must never parse as an option.
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+[\]-]{0,199}$/;
const SESSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const DIRECT_VARIABLE_PATTERN = /^OUTRIGHT_[A-Z0-9_]+$/;
const HOME_VARIABLE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const IDENTITY_ARGUMENT_PATTERN = /^-{0,2}[a-z][a-z-]{0,31}$/;
const LIMIT_WINDOW_PATTERN = /^[a-z0-9_]{1,40}$/;
const LIMIT_STATUS_PATTERN = /^[a-z_]{1,32}$/;
const MAX_LIMIT_WINDOWS = 8;
const MAX_IDENTITY_TEXT = 200;

function contractError(message) {
  return new TypeError(`Invalid execution adapter: ${message}`);
}

export function configurationError(message, code = "PROVIDER_CONFIGURATION_UNSUPPORTED", statusCode = 409) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

// Keeps a prerelease suffix, so "0.162.1-rc.1" is never read as 0.162.1.
export function parseSemanticVersion(text) {
  const match = String(text ?? "").match(/(?:^|[^\d.])(\d+\.\d+\.\d+)(-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?![\d.-])/);
  return match ? match[1] + (match[2] ?? "") : null;
}

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}

export function defineAdapter(spec) {
  if (!spec || typeof spec !== "object") throw contractError("specification is required");
  if (spec.contractVersion !== ADAPTER_CONTRACT_VERSION) throw contractError(`${spec.id} targets contract ${spec.contractVersion}; this runtime supports ${ADAPTER_CONTRACT_VERSION}`);
  if (!ID_PATTERN.test(spec.id ?? "")) throw contractError("id must be a short lowercase identifier");
  if (typeof spec.label !== "string" || !spec.label) throw contractError(`${spec.id} needs a label`);
  if (!["harness", "direct-provider"].includes(spec.kind)) throw contractError(`${spec.id} kind must be harness or direct-provider`);
  if (typeof spec.modelProvider !== "string" || !spec.modelProvider) throw contractError(`${spec.id} must name its model provider`);
  const authority = spec.authority ?? {};
  if (spec.kind === "harness") {
    if (authority.source !== "harness-login") throw contractError(`${spec.id} harness authority must be its own login`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(spec.executable ?? "")) throw contractError(`${spec.id} needs a bare executable name`);
    if (typeof spec.parseVersion !== "function") throw contractError(`${spec.id} must parse its CLI version`);
    // A harness login lives in the CLI's own home directory. Selecting another
    // directory selects another login; Outright never reads its credentials.
    // Credential variables override the home's login, so an added account's
    // launch and login check run without them. The standard home is the
    // directory in the user's home the CLI uses when the variable is unset.
    // Credential switches are credential variables that count only when
    // the CLI reads them as enabled.
    const accounts = spec.accounts;
    const environmentVariable = (variable) => HOME_VARIABLE_PATTERN.test(variable ?? "") && !variable.startsWith("OUTRIGHT_");
    if (accounts !== undefined && (!environmentVariable(accounts?.homeVariable) || !/^\.?[A-Za-z0-9][A-Za-z0-9._-]*$/.test(accounts.standardHome ?? "")
      || !Array.isArray(accounts.identityArgs) || !accounts.identityArgs.length || accounts.identityArgs.some((arg) => !IDENTITY_ARGUMENT_PATTERN.test(arg))
      || !Array.isArray(accounts.credentialVariables) || !accounts.credentialVariables.every(environmentVariable)
      || !Array.isArray(accounts.credentialSwitches) || !accounts.credentialSwitches.every((variable) => accounts.credentialVariables.includes(variable))
      || typeof accounts.parseIdentity !== "function")) throw contractError(`${spec.id} accounts must name a home variable, its standard directory, credential variables and switches, identity arguments and a parser`);
  } else {
    // A harness login never grants direct API access.
    if (authority.source !== "env" || !DIRECT_VARIABLE_PATTERN.test(authority.variable ?? "")) throw contractError(`${spec.id} must reference its own API credential`);
    if (!Array.isArray(spec.environment) || !spec.environment.includes(authority.variable)
      || spec.environment.some((variable) => !DIRECT_VARIABLE_PATTERN.test(variable))) throw contractError(`${spec.id} must declare its OUTRIGHT_* launch environment`);
    if (typeof spec.detect !== "function") throw contractError(`${spec.id} must detect its credential`);
    if (spec.accounts !== undefined) throw contractError(`${spec.id} direct credentials are configured by environment, not account homes`);
  }
  const versions = spec.versions ?? {};
  if (!VERSION_PATTERN.test(versions.minimum ?? "") || !Number.isInteger(versions.belowMajor)
    || Number(versions.minimum.split(".")[0]) >= versions.belowMajor) throw contractError(`${spec.id} needs a supported version range`);
  const capabilities = spec.capabilities ?? {};
  const modes = Object.keys(capabilities.permissionModes ?? {});
  if (!modes.length || modes.some((mode) => !APPROVAL_POLICIES.includes(mode))) throw contractError(`${spec.id} must map supported approval policies to native modes`);
  if (!Array.isArray(capabilities.reasoningEfforts) || capabilities.reasoningEfforts.some((effort) => !REASONING_EFFORTS.includes(effort))) throw contractError(`${spec.id} reasoning efforts are invalid`);
  if (!Array.isArray(capabilities.models) || capabilities.models.some((model) => !MODEL_PATTERN.test(model))) throw contractError(`${spec.id} models are invalid`);
  if (!capabilities.models.length && !capabilities.customModels) throw contractError(`${spec.id} must allow at least one model`);
  // Advertised models the native CLI runs as another model under a policy.
  const unhonored = capabilities.unhonoredModels ?? {};
  if (Object.entries(unhonored).some(([mode, models]) => !modes.includes(mode) || !Array.isArray(models)
    || models.some((model) => !capabilities.models.includes(model)))) throw contractError(`${spec.id} unhonored models must be advertised models under supported policies`);
  // The model a blank request launches, when the adapter rather than its CLI picks it.
  if (spec.defaultModel !== undefined && !capabilities.models.includes(spec.defaultModel)) throw contractError(`${spec.id} default model must be an advertised model`);
  // Advertised aliases and the full ids the verified CLI resolves them to.
  const aliases = spec.modelAliases ?? {};
  if (!aliases || typeof aliases !== "object" || Object.entries(aliases).some(([alias, ids]) => !capabilities.models.includes(alias)
    || !Array.isArray(ids) || !ids.length || ids.some((id) => !MODEL_PATTERN.test(id)))) throw contractError(`${spec.id} model aliases must map advertised models to model ids`);
  if (capabilities.structuredOutput !== "jsonl") throw contractError(`${spec.id} must stream JSON lines`);
  if (capabilities.resume && !spec.sessionIdentity?.nativeField) throw contractError(`${spec.id} resumes sessions but names no native session field`);
  for (const method of ["buildLaunch", "normalize"]) if (typeof spec[method] !== "function") throw contractError(`${spec.id} must implement ${method}`);
  return Object.freeze({
    ...spec,
    accounts: spec.accounts ? Object.freeze({ ...spec.accounts, identityArgs: Object.freeze([...spec.accounts.identityArgs]),
      credentialVariables: Object.freeze([...spec.accounts.credentialVariables]), credentialSwitches: Object.freeze([...spec.accounts.credentialSwitches]) }) : null,
    modelAliases: Object.freeze(Object.fromEntries(Object.entries(aliases).map(([alias, ids]) => [alias, Object.freeze([...ids])]))),
    environment: Object.freeze([...(spec.kind === "harness" ? [] : spec.environment)]),
    capabilities: Object.freeze({
      ...capabilities,
      readOnly: modes.includes("read-only"),
      permissionModes: Object.freeze({ ...capabilities.permissionModes }),
      models: Object.freeze([...capabilities.models]),
      unhonoredModels: Object.freeze(Object.fromEntries(Object.entries(unhonored).map(([mode, models]) => [mode, Object.freeze([...models])]))),
      reasoningEfforts: Object.freeze([...capabilities.reasoningEfforts]),
    }),
  });
}

// Serializable description for the API and UI. Credential references are
// names only; secret values never leave the adapter's own process.
export function describeAdapter(adapter) {
  const { capabilities } = adapter;
  return {
    id: adapter.id,
    label: adapter.label,
    kind: adapter.kind,
    contractVersion: adapter.contractVersion,
    modelProvider: adapter.modelProvider,
    authority: adapter.kind === "harness" ? { source: "harness-login" } : { source: "env", variable: adapter.authority.variable },
    accounts: adapter.accounts ? { homeVariable: adapter.accounts.homeVariable } : null,
    supportedVersions: { minimum: adapter.versions.minimum, belowMajor: adapter.versions.belowMajor },
    capabilities: {
      permissionModes: Object.keys(capabilities.permissionModes),
      nativePermissionModes: { ...capabilities.permissionModes },
      readOnly: capabilities.readOnly,
      models: [...capabilities.models],
      unhonoredModels: Object.fromEntries(Object.entries(capabilities.unhonoredModels).map(([mode, models]) => [mode, [...models]])),
      customModels: Boolean(capabilities.customModels),
      reasoningEfforts: [...capabilities.reasoningEfforts],
      resume: Boolean(capabilities.resume),
      structuredOutput: capabilities.structuredOutput,
      hosted: Boolean(capabilities.hosted),
      usageLimits: Boolean(capabilities.usageLimits),
    },
    models: [...capabilities.models],
  };
}

// Harness versions come from `<executable> --version`; a direct-provider
// adapter reports its own runner version from detect().
export function versionCompatibility(adapter, version) {
  const range = `${adapter.versions.minimum} or newer below ${adapter.versions.belowMajor}.0.0`;
  if (!version) return { version: "", compatible: false, reason: `${adapter.label} reported an unrecognized version; Outright supports ${range}` };
  // Fixtures are recorded from stable releases; a prerelease may change the
  // argv or stream the adapter relies on.
  if (version.includes("-")) return { version, compatible: false, reason: `${adapter.label} ${version} is a prerelease; Outright supports stable releases ${range}` };
  const major = Number(version.split(".")[0]);
  if (compareVersions(version, adapter.versions.minimum) < 0 || major >= adapter.versions.belowMajor) {
    return { version, compatible: false, reason: `${adapter.label} ${version} is not supported; Outright supports ${range}` };
  }
  return { version, compatible: true, reason: "" };
}

// The one session id rule for launch, conversation attach and ids a
// provider emits, so a stored session can always be resumed.
export function isProviderSessionId(value) {
  return typeof value === "string" && SESSION_PATTERN.test(value);
}

// The one model name rule for launch, settings and conversations, so a saved
// model can always be launched. Empty means the adapter's default.
export const MODEL_NAME_REQUIREMENT = "Model name must start with a letter or digit and use only letters, digits and . _ : / @ + [ ] -, up to 200 characters";
export function isModelName(value) {
  return typeof value === "string" && (value === "" || MODEL_PATTERN.test(value));
}

// Rejects anything the adapter cannot honour exactly. There is no fallback
// to another permission mode, model or reasoning level.
export function validateRunConfiguration(adapter, { model = "", reasoningEffort, approvalPolicy, sessionId } = {}) {
  const { capabilities } = adapter;
  // Unknown values are malformed requests and are never echoed back.
  if (!APPROVAL_POLICIES.includes(approvalPolicy)) throw configurationError(`Approval policy must be one of ${APPROVAL_POLICIES.join(", ")}`, "PROVIDER_CONFIGURATION_INVALID", 400);
  if (!REASONING_EFFORTS.includes(reasoningEffort)) throw configurationError(`Reasoning effort must be one of ${REASONING_EFFORTS.join(", ")}`, "PROVIDER_CONFIGURATION_INVALID", 400);
  if (!Object.hasOwn(capabilities.permissionModes, approvalPolicy)) {
    throw configurationError(`${adapter.label} does not support the ${approvalPolicy} approval policy; choose ${Object.keys(capabilities.permissionModes).join(" or ")}`);
  }
  if (!isModelName(model)) throw configurationError(`Model name is invalid for ${adapter.label}`, "PROVIDER_CONFIGURATION_INVALID", 400);
  if (model && !capabilities.customModels && !capabilities.models.includes(model)) {
    throw configurationError(`${adapter.label} does not support model ${model}`);
  }
  if (capabilities.unhonoredModels[approvalPolicy]?.includes(model)) {
    throw configurationError(`${adapter.label} runs another model for ${model} under the ${approvalPolicy} approval policy; choose another model or approval policy`);
  }
  if (!capabilities.reasoningEfforts.includes(reasoningEffort)) {
    throw configurationError(`${adapter.label} does not support ${reasoningEffort} reasoning effort`);
  }
  if (sessionId != null && sessionId !== "") {
    if (!capabilities.resume) throw configurationError(`${adapter.label} cannot resume a provider session`, "PROVIDER_RESUME_UNSUPPORTED");
    if (!isProviderSessionId(sessionId)) throw configurationError(`Provider session id is invalid for ${adapter.label}`, "PROVIDER_SESSION_INVALID", 400);
  }
}

// The model a run asks for: its own, else the adapter's default. Empty when
// the CLI picks, which leaves nothing to compare a reported model with.
export function requestedModel(adapter, model) {
  return model || adapter.defaultModel || "";
}

// Whether a model the provider reports answering is the requested one: the
// same id, a dated snapshot of it (-YYYYMMDD), or an id the adapter
// documents for the alias. Any other suffix names another release. Resolve
// the request with requestedModel first; an empty one matches nothing.
export function modelMatches(adapter, requested, reported) {
  if (!requested) return false;
  const aliased = Object.hasOwn(adapter.modelAliases, requested) ? adapter.modelAliases[requested] : [];
  return [requested, ...aliased].some((id) => reported === id || (reported.startsWith(`${id}-`) && /^\d{8}$/.test(reported.slice(id.length + 1))));
}

// Identity text a CLI prints is display-only: control characters are
// removed and the length is bounded. Anything else is dropped.
export function identityText(value) {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return text ? text.slice(0, MAX_IDENTITY_TEXT) : null;
}

// Usage windows as a provider reports them. Malformed windows, values and
// timestamps are dropped rather than guessed; a window keeps only what was
// reported, so an absent utilization or reset stays unknown.
export function limitWindow(window, { utilization, resetsAt, status } = {}) {
  if (typeof window !== "string" || !LIMIT_WINDOW_PATTERN.test(window)) return null;
  const seconds = Number.isFinite(resetsAt) && resetsAt > 0 && resetsAt < 32_503_680_000 ? resetsAt : null;
  return {
    window,
    utilization: Number.isFinite(utilization) && utilization >= 0 && utilization <= 10 ? utilization : null,
    resetsAt: seconds === null ? null : new Date(seconds * 1000).toISOString(),
    status: typeof status === "string" && LIMIT_STATUS_PATTERN.test(status) ? status : null,
  };
}

export function boundedLimitWindows(windows) {
  const byName = new Map();
  for (const window of windows) {
    if (!window || byName.size >= MAX_LIMIT_WINDOWS && !byName.has(window.window)) continue;
    const previous = byName.get(window.window);
    byName.set(window.window, previous ? { ...previous, ...Object.fromEntries(Object.entries(window).filter(([, value]) => value !== null)) } : window);
  }
  return [...byName.values()];
}
