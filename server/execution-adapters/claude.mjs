import { ADAPTER_CONTRACT_VERSION, defineAdapter, parseSemanticVersion } from "./contract.mjs";

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
    customModels: true,
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
    resume: true,
    structuredOutput: "jsonl",
    hosted: false,
  },
  sessionIdentity: { nativeField: "session_id" },
  parseVersion: parseSemanticVersion,
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
    if (raw.type === "result") {
      if (raw.result && !raw.is_error) events.push({ type: "assistant.message", payload: { text: raw.result } });
      if (raw.is_error) events.push({ type: "provider.failure", payload: { message: String(raw.result || raw.subtype || "Claude Code reported a failure"), terminal: true, native: { subtype: raw.subtype, is_error: true, terminal_reason: raw.terminal_reason, api_error_status: raw.api_error_status } } });
      events.push({ type: "usage", payload: { costUsd: raw.total_cost_usd, inputTokens: raw.usage?.input_tokens, outputTokens: raw.usage?.output_tokens, native: raw.usage ?? null } });
    }
    if (!events.length && raw.type !== "stream_event") events.push({ type: "provider.event", payload: raw });
    return events;
  },
});
