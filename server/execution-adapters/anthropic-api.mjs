import { fileURLToPath } from "node:url";
import { anthropicEndpoint, ENDPOINT_REQUIREMENT, MAX_OUTPUT_TOKENS } from "./anthropic-api-runner.mjs";
import { ADAPTER_CONTRACT_VERSION, defineAdapter } from "./contract.mjs";

// Bumped whenever the runner's argv or output stream changes.
export const ANTHROPIC_RUNNER_VERSION = "1.0.0";
const RUNNER_PATH = fileURLToPath(new URL("./anthropic-api-runner.mjs", import.meta.url));
// Stop reasons that end an answer before the model finished it.
const TRUNCATING_STOP_REASONS = Object.freeze({
  max_tokens: `the ${MAX_OUTPUT_TOKENS}-token output limit`,
  model_context_window_exceeded: "the model's context window",
});

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
      // A delta without a type, or a text delta without text, would otherwise
      // drop part of the answer and still complete. Other delta types are
      // ignored.
      if (!raw.delta || typeof raw.delta !== "object" || typeof raw.delta.type !== "string" || !raw.delta.type
        || (raw.delta.type === "text_delta" && typeof raw.delta.text !== "string")) {
        return [{ type: "provider.failure", payload: { message: "Anthropic API sent a malformed text delta; the answer is incomplete", terminal: true, native: { type: "malformed_delta" } } }];
      }
      return raw.delta.type === "text_delta" && raw.delta.text ? [{ type: "assistant.delta", payload: { text: raw.delta.text } }] : [];
    }
    if (raw.type === "message_start") return [{ type: "usage", payload: { inputTokens: raw.message?.usage?.input_tokens, native: raw.message?.usage ?? null } }];
    if (raw.type === "message_delta") {
      const usage = { type: "usage", payload: { outputTokens: raw.usage?.output_tokens, native: { ...raw.usage, stop_reason: raw.delta?.stop_reason } } };
      // A cut-off answer must not look complete, and neither may one whose
      // final delta has no stop reason. The text and usage so far are kept.
      const stopReason = raw.delta?.stop_reason;
      if (typeof stopReason !== "string" || !stopReason) return [usage, { type: "provider.failure", payload: { message: "Anthropic API ended the message without a stop reason; the answer may be incomplete", terminal: true, native: { type: "malformed_stop_reason" } } }];
      if (!Object.hasOwn(TRUNCATING_STOP_REASONS, stopReason)) return [usage];
      return [usage, { type: "provider.failure", payload: { message: `Anthropic API stopped at ${TRUNCATING_STOP_REASONS[stopReason]}; the answer is truncated`, terminal: true, native: { stop_reason: stopReason } } }];
    }
    if (raw.type === "error") return [{ type: "provider.failure", payload: { message: String(raw.error?.message ?? "Anthropic API request failed"), terminal: true, native: raw.error ?? null } }];
    // Pings, block boundaries and thinking deltas carry no user-visible state.
    if (["ping", "content_block_start", "content_block_stop", "message_stop"].includes(raw.type)) return [];
    return [{ type: "provider.event", payload: raw }];
  },
});
