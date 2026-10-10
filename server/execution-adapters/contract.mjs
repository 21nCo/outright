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
export const NORMALIZED_EVENT_TYPES = Object.freeze(["session", "assistant.delta", "assistant.message", "tool.started", "tool.completed", "usage", "provider.failure", "provider.event"]);
// Values that reach a provider's argv must never parse as an option.
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+[\]-]{0,199}$/;
const SESSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const DIRECT_VARIABLE_PATTERN = /^OUTRIGHT_[A-Z0-9_]+$/;

function contractError(message) {
  return new TypeError(`Invalid execution adapter: ${message}`);
}

export function configurationError(message, code = "PROVIDER_CONFIGURATION_UNSUPPORTED", statusCode = 409) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

export function parseSemanticVersion(text) {
  const match = String(text ?? "").match(/(?:^|[^\d.])(\d+)\.(\d+)\.(\d+)(?![\d.])/);
  return match ? match.slice(1, 4).join(".") : null;
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
  } else {
    // A harness login never grants direct API access.
    if (authority.source !== "env" || !DIRECT_VARIABLE_PATTERN.test(authority.variable ?? "")) throw contractError(`${spec.id} must reference its own API credential`);
    if (!Array.isArray(spec.environment) || !spec.environment.includes(authority.variable)
      || spec.environment.some((variable) => !DIRECT_VARIABLE_PATTERN.test(variable))) throw contractError(`${spec.id} must declare its OUTRIGHT_* launch environment`);
    if (typeof spec.detect !== "function") throw contractError(`${spec.id} must detect its credential`);
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
  if (capabilities.structuredOutput !== "jsonl") throw contractError(`${spec.id} must stream JSON lines`);
  if (capabilities.resume && !spec.sessionIdentity?.nativeField) throw contractError(`${spec.id} resumes sessions but names no native session field`);
  for (const method of ["buildLaunch", "normalize"]) if (typeof spec[method] !== "function") throw contractError(`${spec.id} must implement ${method}`);
  return Object.freeze({
    ...spec,
    environment: Object.freeze([...(spec.kind === "harness" ? [] : spec.environment)]),
    capabilities: Object.freeze({
      ...capabilities,
      readOnly: modes.includes("read-only"),
      permissionModes: Object.freeze({ ...capabilities.permissionModes }),
      models: Object.freeze([...capabilities.models]),
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
    supportedVersions: { minimum: adapter.versions.minimum, belowMajor: adapter.versions.belowMajor },
    capabilities: {
      permissionModes: Object.keys(capabilities.permissionModes),
      nativePermissionModes: { ...capabilities.permissionModes },
      readOnly: capabilities.readOnly,
      models: [...capabilities.models],
      customModels: Boolean(capabilities.customModels),
      reasoningEfforts: [...capabilities.reasoningEfforts],
      resume: Boolean(capabilities.resume),
      structuredOutput: capabilities.structuredOutput,
      hosted: Boolean(capabilities.hosted),
    },
    models: [...capabilities.models],
  };
}

// Harness versions come from `<executable> --version`; a direct-provider
// adapter reports its own runner version from detect().
export function versionCompatibility(adapter, version) {
  const range = `${adapter.versions.minimum} or newer below ${adapter.versions.belowMajor}.0.0`;
  if (!version) return { version: "", compatible: false, reason: `${adapter.label} reported an unrecognized version; Outright supports ${range}` };
  const major = Number(version.split(".")[0]);
  if (compareVersions(version, adapter.versions.minimum) < 0 || major >= adapter.versions.belowMajor) {
    return { version, compatible: false, reason: `${adapter.label} ${version} is not supported; Outright supports ${range}` };
  }
  return { version, compatible: true, reason: "" };
}

// Rejects anything the adapter cannot honour exactly. There is no fallback
// to another permission mode, model or reasoning level.
export function validateRunConfiguration(adapter, { model = "", reasoningEffort, approvalPolicy, sessionId } = {}) {
  const { capabilities } = adapter;
  if (!Object.hasOwn(capabilities.permissionModes, approvalPolicy)) {
    throw configurationError(`${adapter.label} does not support the ${approvalPolicy || "missing"} approval policy; choose ${Object.keys(capabilities.permissionModes).join(" or ")}`);
  }
  if (typeof model !== "string" || (model && !MODEL_PATTERN.test(model))) throw configurationError(`Model name is invalid for ${adapter.label}`, "PROVIDER_CONFIGURATION_INVALID", 400);
  if (model && !capabilities.customModels && !capabilities.models.includes(model)) {
    throw configurationError(`${adapter.label} does not support model ${model}`);
  }
  if (!capabilities.reasoningEfforts.includes(reasoningEffort)) {
    throw configurationError(`${adapter.label} does not support ${reasoningEffort || "missing"} reasoning effort`);
  }
  if (sessionId != null && sessionId !== "") {
    if (!capabilities.resume) throw configurationError(`${adapter.label} cannot resume a provider session`, "PROVIDER_RESUME_UNSUPPORTED");
    if (typeof sessionId !== "string" || !SESSION_PATTERN.test(sessionId)) throw configurationError(`Provider session id is invalid for ${adapter.label}`, "PROVIDER_SESSION_INVALID", 400);
  }
}
