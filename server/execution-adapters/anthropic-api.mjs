import { fileURLToPath } from "node:url";
import { anthropicEndpoint, ENDPOINT_REQUIREMENT } from "./anthropic-api-runner.mjs";
import { ADAPTER_CONTRACT_VERSION, defineAdapter } from "./contract.mjs";

// Bumped whenever the runner's argv or output stream changes.
export const ANTHROPIC_RUNNER_VERSION = "1.0.0";
const RUNNER_PATH = fileURLToPath(new URL("./anthropic-api-runner.mjs", import.meta.url));

// Outright-managed execution: Outright itself calls the Messages API with an
// explicitly configured key. It has no tools, so it can only answer from the
// prompt and is read-only by construction; it never mutates the worktree.
export const anthropicApiAdapter = defineAdapter({
  id: "anthropic-api",
  label: "Anthropic API",
  kind: "direct-provider",
  contractVersion: ADAPTER_CONTRACT_VERSION,
  modelProvider: "anthropic",
  // Never the Claude Code login: a subscription does not grant API access.
  // Outright's own variables, not ANTHROPIC_*, so Claude Code keeps whatever
  // authority it already had when this provider is enabled.
  authority: { source: "env", variable: "OUTRIGHT_ANTHROPIC_API_KEY" },
  environment: ["OUTRIGHT_ANTHROPIC_API_KEY", "OUTRIGHT_ANTHROPIC_BASE_URL"],
  versions: { minimum: "1.0.0", belowMajor: 2 },
  capabilities: {
    permissionModes: { "read-only": "no-tools" },
    models: ["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5", "claude-haiku-5-5"],
    customModels: true,
    // Thinking controls differ across models; only the model default is
    // offered until a per-model mapping has been verified.
    reasoningEfforts: ["medium"],
    resume: false,
    structuredOutput: "jsonl",
    hosted: true,
  },
  detect(environment = process.env) {
    if (!environment.OUTRIGHT_ANTHROPIC_API_KEY) return { available: false, version: "", reason: "Set OUTRIGHT_ANTHROPIC_API_KEY to enable Outright-managed Anthropic API runs" };
    if (!anthropicEndpoint(environment)) return { available: false, version: "", reason: `${ENDPOINT_REQUIREMENT}; fix or unset it to use api.anthropic.com` };
    return { available: true, version: ANTHROPIC_RUNNER_VERSION, reason: "" };
  },
  buildLaunch({ run }) {
    // The key reaches the runner only through its scoped environment, never
    // argv. A blank
    // model means the adapter's advertised default, the first listed model.
    const model = run.model || this.capabilities.models[0];
    return {
      executable: process.execPath,
      args: [RUNNER_PATH, "--model", model, "--", run.prompt],
      display: `anthropic-api messages ${model} …`,
    };
  },
  normalize(raw) {
    if (raw.type === "content_block_delta") {
      return raw.delta?.type === "text_delta" && typeof raw.delta.text === "string" && raw.delta.text
        ? [{ type: "assistant.delta", payload: { text: raw.delta.text } }] : [];
    }
    if (raw.type === "message_start") return [{ type: "usage", payload: { inputTokens: raw.message?.usage?.input_tokens, native: raw.message?.usage ?? null } }];
    if (raw.type === "message_delta") return [{ type: "usage", payload: { outputTokens: raw.usage?.output_tokens, native: { ...raw.usage, stop_reason: raw.delta?.stop_reason } } }];
    if (raw.type === "error") return [{ type: "provider.failure", payload: { message: String(raw.error?.message ?? "Anthropic API request failed"), terminal: true, native: raw.error ?? null } }];
    // Pings, block boundaries and thinking deltas carry no user-visible state.
    if (["ping", "content_block_start", "content_block_stop", "message_stop"].includes(raw.type)) return [];
    return [{ type: "provider.event", payload: raw }];
  },
});
