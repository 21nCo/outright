import { ADAPTER_CONTRACT_VERSION, boundedLimitWindows, defineAdapter, identityText, limitWindow, parseSemanticVersion } from "./contract.mjs";

// `claude auth status --json` prints the login it would use. Only these
// display fields are kept; it prints no token. The login is the one stored
// in CLAUDE_CONFIG_DIR (`ownLogin`) only for a claude.ai sign-in or a
// Console key from /login. Claude Code 2.1.303 reports every other source
// as another method: a token, profile or federation as oauth_token, a key
// from the environment as api_key with that source, a helper as
// api_key_helper and a cloud provider as third_party.
function parseIdentity(output) {
  let status;
  try { status = JSON.parse(output); } catch { return null; }
  if (!status || typeof status !== "object" || typeof status.loggedIn !== "boolean") return null;
  const ownLogin = status.loggedIn && (status.authMethod === "claude.ai" || (status.authMethod === "api_key" && status.apiKeySource === "/login managed key"));
  return { signedIn: status.loggedIn, ownLogin, method: identityText(status.authMethod), email: identityText(status.email),
    organization: identityText(status.orgName), plan: identityText(status.subscriptionType) };
}

// A rate_limit_event names the window that applies now and, in
// unifiedWindows, every window it measured.
function limitWindows(info) {
  if (!info || typeof info !== "object") return [];
  const unified = info.unifiedWindows && typeof info.unifiedWindows === "object" ? Object.entries(info.unifiedWindows) : [];
  return boundedLimitWindows([
    ...unified.map(([name, window]) => limitWindow(name, { utilization: window?.utilization, resetsAt: window?.resetsAt })),
    limitWindow(info.rateLimitType, { resetsAt: info.resetsAt, status: info.status, utilization: info.utilization }),
  ]);
}

export const claudeAdapter = defineAdapter({
  id: "claude",
  label: "Claude Code",
  kind: "harness",
  contractVersion: ADAPTER_CONTRACT_VERSION,
  modelProvider: "anthropic",
  authority: { source: "harness-login" },
  executable: "claude",
  // --permission-prompts and --effort are recent; the minimum is the oldest
  // CLI whose flags and stream-json output were verified.
  versions: { minimum: "2.1.296", belowMajor: 3 },
  capabilities: {
    permissionModes: { "read-only": "plan", "workspace-write": "acceptEdits", "danger-full-access": "bypassPermissions" },
    models: ["sonnet", "opus", "haiku"],
    // Claude Code 2.1.296 answers with Sonnet for the haiku alias in plan
    // mode, while its init event still says Haiku. The full id is honored.
    unhonoredModels: { "read-only": ["haiku"] },
    customModels: true,
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
    resume: true,
    structuredOutput: "jsonl",
    hosted: false,
    // rate_limit_event reports the login's usage windows.
    usageLimits: true,
  },
  sessionIdentity: { nativeField: "session_id" },
  parseVersion: parseSemanticVersion,
  // Without CLAUDE_CONFIG_DIR Claude Code uses ~/.claude. Checked against
  // Claude Code 2.1.303: it can authenticate, or pick a provider or
  // endpoint, from every ANTHROPIC_* variable (keys, tokens, profiles,
  // federation, organization, base URLs) and the CLAUDE_CODE_* families
  // below, so each is a source. The exceptions choose models, betas or
  // logging, or a tool rather than a provider. Claude Code 2.1.304's
  // `auth status` reports each source that signs it in (a key as api_key,
  // a token as oauth_token, an enabled provider switch as third_party) and
  // an endpoint, profile or federation selector alone as signed out, so no
  // source counts as a login without that check.
  accounts: { homeVariable: "CLAUDE_CONFIG_DIR", standardHome: ".claude", identityArgs: ["auth", "status", "--json"], parseIdentity,
    credentialVariables: ["ANTHROPIC_*", "CLAUDE_CODE_USE_*", "CLAUDE_CODE_OAUTH_*", "CLAUDE_CODE_API_KEY_*", "CLAUDE_CODE_GATEWAY_*", "CLAUDE_CODE_HOST_*",
      "CLAUDE_CODE_FEDERATION_*", "CLAUDE_CODE_SDK_HAS_*", "CLAUDE_CODE_CLIENT_KEY*", "CLAUDE_CODE_ACCOUNT_*", "CLAUDE_CODE_ORGANIZATION_*",
      "CLAUDE_CODE_SESSION_ACCESS_TOKEN", "CLAUDE_CODE_WEBSOCKET_AUTH_*", "CLAUDE_CODE_CUSTOM_OAUTH_URL"],
    nonCredentialVariables: ["ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL", "ANTHROPIC_DEFAULT_*", "ANTHROPIC_CUSTOM_MODEL_OPTION*", "ANTHROPIC_BETAS", "ANTHROPIC_LOG",
      "CLAUDE_CODE_USE_NATIVE_FILE_SEARCH", "CLAUDE_CODE_USE_POWERSHELL_TOOL", "CLAUDE_CODE_USE_COWORK_PLUGINS", "CLAUDE_CODE_USE_CCR_V2"],
    credentialSwitches: ["CLAUDE_CODE_USE_*"], inertCredentials: [], unreportedCredentials: [] },
  // What Claude Code 2.1.296 resolves each alias to. Another release
  // answering for an alias is reported, not assumed equivalent.
  modelAliases: { haiku: ["claude-haiku-5-5"], sonnet: ["claude-sonnet-5-5"], opus: ["claude-opus-5-5"] },
  buildLaunch({ run, sessionId }) {
    const mode = this.capabilities.permissionModes[run.approvalPolicy];
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-prompts", "none", "--permission-mode", mode];
    if (run.model) args.push("--model", run.model);
    args.push("--effort", run.reasoningEffort);
    if (sessionId) args.push("--resume", sessionId);
    // The prompt follows "--" so it can never parse as an option.
    args.push("--", run.prompt);
    return { executable: "claude", args, display: ["claude", "-p", "…", "--permission-mode", mode].join(" ") };
  },
  normalize(raw) {
    const events = [];
    if (raw.type === "system" && raw.subtype === "init" && raw.session_id) events.push({ type: "session", payload: { sessionId: raw.session_id } });
    const delta = raw.event?.delta;
    if (raw.type === "stream_event" && delta?.type === "text_delta" && typeof delta.text === "string" && delta.text) {
      events.push({ type: "assistant.delta", payload: { text: delta.text } });
    }
    if (raw.type === "assistant") {
      for (const block of raw.message?.content ?? []) {
        if (block.type === "tool_use") events.push({ type: "tool.started", payload: { item: block } });
      }
    }
    if (raw.type === "user") {
      for (const block of raw.message?.content ?? []) {
        if (block.type === "tool_result") events.push({ type: "tool.completed", payload: { item: block } });
      }
    }
    if (raw.type === "rate_limit_event") {
      const windows = limitWindows(raw.rate_limit_info);
      if (windows.length) events.push({ type: "rate_limit", payload: { windows } });
    }
    if (raw.type === "result") {
      if (raw.result && !raw.is_error) events.push({ type: "assistant.message", payload: { text: raw.result } });
      if (raw.is_error) events.push({ type: "provider.failure", payload: { message: String(raw.result || raw.subtype || "Claude Code reported a failure"), terminal: true, native: { subtype: raw.subtype, is_error: true, terminal_reason: raw.terminal_reason, api_error_status: raw.api_error_status } } });
      events.push({ type: "usage", payload: { costUsd: raw.total_cost_usd, inputTokens: raw.usage?.input_tokens, outputTokens: raw.usage?.output_tokens, native: raw.usage ?? null, modelUsage: raw.modelUsage ?? null } });
    }
    if (!events.length && raw.type !== "stream_event") events.push({ type: "provider.event", payload: raw });
    // The run's model is the one its own messages report, not system/init.
    // Subagent messages and extra modelUsage entries may use other models, and
    // "<synthetic>" marks a message the CLI wrote itself, not a model answer.
    if (raw.type === "assistant" && raw.parent_tool_use_id == null && typeof raw.message?.model === "string" && raw.message.model && raw.message.model !== "<synthetic>") {
      events.push({ type: "model", payload: { model: raw.message.model } });
    }
    return events;
  },
});
