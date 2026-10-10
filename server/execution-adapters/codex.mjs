import { ADAPTER_CONTRACT_VERSION, defineAdapter, parseSemanticVersion } from "./contract.mjs";

const SANDBOX_MODES = { "read-only": "read-only", "workspace-write": "workspace-write", "danger-full-access": "danger-full-access" };

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
    if (raw.type === "item.started") events.push({ type: "tool.started", payload: { item: raw.item } });
    if (raw.type === "item.completed") {
      const item = raw.item ?? {};
      if (item.type === "agent_message" && item.text) events.push({ type: "assistant.message", payload: { text: item.text } });
      // Error items are non-fatal CLI notices (configuration, model metadata),
      // not tool calls; keep them as native events outside the transcript.
      else if (item.type === "error") events.push({ type: "provider.event", payload: raw });
      else events.push({ type: "tool.completed", payload: { item } });
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
