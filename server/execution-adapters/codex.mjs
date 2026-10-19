import { ADAPTER_CONTRACT_VERSION, defineAdapter, parseSemanticVersion } from "./contract.mjs";

// `codex login status` prints one line for CODEX_HOME. An API-key login
// prints a masked key after the method; only the method is kept. It does
// not say whether a key came from the environment, so an added account's
// check runs without every credential source, and any other line is
// unrecognized.
function parseIdentity(output) {
  const line = String(output).trim().split(/\r?\n/)[0] ?? "";
  if (/^Not logged in\b/.test(line)) return { signedIn: false, ownLogin: false, method: null, email: null, organization: null, plan: null };
  if (/^Logged in using ChatGPT\b/.test(line)) return { signedIn: true, ownLogin: true, method: "chatgpt", email: null, organization: null, plan: null };
  if (/^Logged in using an API key\b/.test(line)) return { signedIn: true, ownLogin: true, method: "api-key", email: null, organization: null, plan: null };
  return null;
}

const SANDBOX_MODES = { "read-only": "read-only", "workspace-write": "workspace-write", "danger-full-access": "danger-full-access" };

// Item types `codex exec --json` emits for tool calls.
const TOOL_ITEM_TYPES = Object.freeze(["command_execution", "file_change", "mcp_tool_call", "web_search"]);

export const codexAdapter = defineAdapter({
  id: "codex",
  label: "Codex",
  kind: "harness",
  contractVersion: ADAPTER_CONTRACT_VERSION,
  modelProvider: "openai",
  authority: { source: "harness-login" },
  executable: "codex",
  // The minimum is the CLI the fixtures were recorded from, the oldest one
  // whose "--"-separated exec and exec resume argv and JSON stream were seen.
  versions: { minimum: "0.162.1", belowMajor: 1 },
  capabilities: {
    permissionModes: SANDBOX_MODES,
    models: ["gpt-5.4", "gpt-5.3-codex"],
    customModels: true,
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
    resume: true,
    structuredOutput: "jsonl",
    hosted: false,
  },
  sessionIdentity: { nativeField: "thread_id" },
  parseVersion: parseSemanticVersion,
  // `codex exec --json` reports token usage but no usage windows.
  // CODEX_HOME is ~/.codex when unset. Codex documents CODEX_API_KEY,
  // CODEX_ACCESS_TOKEN and the OPENAI_FEDERATION_RULE_ID and
  // OPENAI_IDENTITY_TOKEN_FILE workload identity as sources used in place
  // of that login, and OPENAI_* also picks its endpoint and organization.
  // Codex 0.162 does not authenticate with OPENAI_API_KEY, so that one
  // never stands in for the login; it is still kept from an added
  // account's launch and check. `codex login status` reads only
  // CODEX_HOME, so the default login with CODEX_API_KEY or
  // CODEX_ACCESS_TOKEN set counts as configured unchecked; with only an
  // endpoint, organization or workload-identity setting it is checked.
  accounts: { homeVariable: "CODEX_HOME", standardHome: ".codex", identityArgs: ["login", "status"], parseIdentity,
    credentialVariables: ["OPENAI_*", "CODEX_*KEY*", "CODEX_*TOKEN*", "CODEX_*AUTH*", "CODEX_*FEDERATION*", "CODEX_*IDENTITY*"],
    nonCredentialVariables: [], credentialSwitches: [], inertCredentials: ["OPENAI_API_KEY"], unreportedCredentials: ["CODEX_API_KEY", "CODEX_ACCESS_TOKEN"] },
  buildLaunch({ worktreePath, run, sessionId }) {
    const sandbox = SANDBOX_MODES[run.approvalPolicy];
    const options = [];
    if (run.model) options.push("--model", run.model);
    options.push("-c", `model_reasoning_effort=${JSON.stringify(run.reasoningEffort)}`);
    // Positional values follow "--" so a prompt such as "review" or "--help"
    // can never select a subcommand or option.
    if (sessionId) {
      // `exec resume` has no --sandbox flag; the policy is a config override.
      if (sandbox === "danger-full-access") options.push("--dangerously-bypass-approvals-and-sandbox");
      else options.push("-c", `sandbox_mode=${JSON.stringify(sandbox)}`);
      return { executable: "codex", args: ["exec", "resume", "--json", ...options, "--", sessionId, run.prompt], display: "codex exec resume --json …" };
    }
    return { executable: "codex", args: ["exec", "--json", "-C", worktreePath, "--sandbox", sandbox, ...options, "--", run.prompt], display: `codex exec --json --sandbox ${sandbox} …` };
  },
  normalize(raw) {
    const events = [];
    if (raw.type === "thread.started" && raw.thread_id) events.push({ type: "session", payload: { sessionId: raw.thread_id } });
    // Only tool calls become tool rows. Reasoning, plans, error notices
    // and future item types stay native events outside the transcript.
    const tool = TOOL_ITEM_TYPES.includes(raw.item?.type);
    if (raw.type === "item.started" && tool) events.push({ type: "tool.started", payload: { item: raw.item } });
    if (raw.type === "item.completed") {
      if (raw.item?.type === "agent_message" && raw.item.text) events.push({ type: "assistant.message", payload: { text: raw.item.text } });
      else if (tool) events.push({ type: "tool.completed", payload: { item: raw.item } });
    }
    if (raw.type === "turn.completed" && raw.usage) {
      events.push({ type: "usage", payload: { inputTokens: raw.usage.input_tokens, outputTokens: raw.usage.output_tokens, native: raw.usage } });
    }
    // A top-level error can be a retried stream notice ("Reconnecting...");
    // only turn.failed ends the turn.
    if (raw.type === "turn.failed" || raw.type === "error") {
      events.push({ type: "provider.failure", payload: { message: String(raw.error?.message ?? raw.message ?? "Codex reported a failure"), terminal: raw.type === "turn.failed", native: raw } });
    }
    if (!events.length) events.push({ type: "provider.event", payload: raw });
    return events;
  },
});
