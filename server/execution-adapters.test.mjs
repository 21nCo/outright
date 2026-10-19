import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ADAPTER_CONTRACT_VERSION, defineAdapter, modelMatches, NORMALIZED_EVENT_TYPES, requestedModel, validateRunConfiguration } from "./execution-adapters/contract.mjs";
import { buildExecutionEnvironment, buildExecutionLaunch, describeAdapter, EXECUTION_ADAPTERS, findExecutionAdapter, validateExecutionConfiguration, versionCompatibility } from "./execution-adapters/index.mjs";
import { createProviderDiscovery } from "./provider-discovery.mjs";
import { ENDPOINT_REQUIREMENT } from "./execution-adapters/anthropic-api-runner.mjs";

const fixtures = new URL("../tests/fixtures/execution-adapters/", import.meta.url);
const fixture = (adapter, name) => readFileSync(new URL(`${adapter}/${name}`, fixtures), "utf8");
// Every normalized event must belong to the contract's shared vocabulary.
const normalized = (adapter, records) => records.flatMap((record) => adapter.normalize(record)).map((event) => {
  assert.ok(NORMALIZED_EVENT_TYPES.includes(event.type), `${adapter.id} emitted ${event.type}`);
  return event;
});
const normalizeFixture = (adapter, name) => normalized(adapter, fixture(adapter.id, name).split("\n").filter(Boolean).map((line) => JSON.parse(line)));
// Long enough that redacting a reflected key cannot match ordinary stream text.
const fixtureKey = "fixture-direct-api-key";
const baseRun = { model: "", reasoningEffort: "medium", approvalPolicy: "read-only", prompt: "review" };
const codex = findExecutionAdapter("codex");
const claude = findExecutionAdapter("claude");
const anthropic = findExecutionAdapter("anthropic-api");

function harnessSpec(overrides = {}) {
  return {
    id: "fixture", label: "Fixture", kind: "harness", contractVersion: ADAPTER_CONTRACT_VERSION, modelProvider: "openai",
    authority: { source: "harness-login" }, executable: "fixture", versions: { minimum: "1.0.0", belowMajor: 2 },
    capabilities: { permissionModes: { "read-only": "ro" }, models: ["m"], reasoningEfforts: ["medium"], structuredOutput: "jsonl" },
    parseVersion: () => "1.0.0", buildLaunch: () => ({}), normalize: () => [],
    ...overrides,
  };
}

test("the adapter contract rejects specifications the scheduler could not trust", () => {
  assert.equal(defineAdapter(harnessSpec()).capabilities.readOnly, true);
  assert.throws(() => defineAdapter(harnessSpec({ contractVersion: 2 })), /targets contract 2/);
  assert.throws(() => defineAdapter(harnessSpec({ executable: "/usr/bin/codex --flag" })), /bare executable/);
  assert.throws(() => defineAdapter(harnessSpec({ capabilities: { ...harnessSpec().capabilities, permissionModes: { sudo: "x" } } })), /approval policies/);
  assert.throws(() => defineAdapter(harnessSpec({ capabilities: { ...harnessSpec().capabilities, resume: true } })), /native session field/);
  // A direct provider can never borrow a harness CLI login.
  assert.throws(() => defineAdapter(harnessSpec({ kind: "direct-provider", detect: () => ({}) })), /own API credential/);
  // A direct provider's credential must sit in Outright's namespace, which no harness spawn inherits.
  const direct = { kind: "direct-provider", detect: () => ({}), environment: ["ANTHROPIC_API_KEY"], authority: { source: "env", variable: "ANTHROPIC_API_KEY" } };
  assert.throws(() => defineAdapter(harnessSpec(direct)), /own API credential/);
  assert.throws(() => defineAdapter(harnessSpec({ ...direct, authority: { source: "env", variable: "OUTRIGHT_KEY" } })), /launch environment/);
  assert.deepEqual(defineAdapter(harnessSpec({ ...direct, authority: { source: "env", variable: "OUTRIGHT_KEY" }, environment: ["OUTRIGHT_KEY"] })).environment, ["OUTRIGHT_KEY"]);
  assert.throws(() => defineAdapter(harnessSpec({ versions: { minimum: "2.0.0", belowMajor: 2 } })), /version range/);
  for (const unhonoredModels of [{ "read-only": ["unlisted"] }, { "workspace-write": ["m"] }, { "read-only": "m" }]) {
    assert.throws(() => defineAdapter(harnessSpec({ capabilities: { ...harnessSpec().capabilities, unhonoredModels } })), /unhonored models/);
  }
});

// Claude Code 2.1.296 answers with Sonnet for the haiku alias in plan mode
// (live acceptance at b15b200). Every other advertised model and policy runs
// exactly the model it names.
test("every advertised Claude model and approval policy runs that model or is rejected before queueing", () => {
  const conversation = { worktreePath: "/w" };
  for (const model of claude.capabilities.models) {
    for (const [approvalPolicy, mode] of Object.entries(claude.capabilities.permissionModes)) {
      const run = { provider: "claude", ...baseRun, model, approvalPolicy };
      if (model === "haiku" && approvalPolicy === "read-only") {
        assert.throws(() => validateExecutionConfiguration(run), (error) => {
          assert.deepEqual([error.code, error.statusCode], ["PROVIDER_CONFIGURATION_UNSUPPORTED", 409]);
          assert.match(error.message, /haiku under the read-only approval policy/);
          return true;
        });
        assert.throws(() => buildExecutionLaunch({ conversation, run }), { code: "PROVIDER_CONFIGURATION_UNSUPPORTED" }, "a stale queued run fails closed at launch");
        continue;
      }
      const { args } = buildExecutionLaunch({ conversation, run });
      assert.deepEqual(args.filter((arg, index) => ["--model", "--permission-mode"].includes(args[index - 1])), [mode, model], `${model} ${approvalPolicy}`);
    }
  }
  assert.doesNotThrow(() => validateExecutionConfiguration({ provider: "claude", ...baseRun, model: "claude-haiku-5-5" }), "the full id is honored in plan mode");
  assert.deepEqual(describeAdapter(claude).capabilities.unhonoredModels, { "read-only": ["haiku"] });
});

test("a reported model matches the requested id, its dated snapshot or the adapter's alias", () => {
  for (const [adapter, requested, reported, expected] of [
    [claude, "haiku", "claude-haiku-5-5", true], [claude, "haiku", "claude-haiku-5-5-20261001", true], [claude, "haiku", "claude-sonnet-5-5", false], [claude, "sonnet", "claude-sonnet-5-5", true],
    [claude, "claude-haiku-5-5", "claude-haiku-5-5", true], [claude, "claude-haiku-5-5", "claude-sonnet-5-5", false],
    [claude, "my-model", "claude-my-model-1", false], [anthropic, "claude-opus-5-5", "claude-opus-5-5-20261001", true], [anthropic, "claude-opus-5-5", "claude-sonnet-5-5", false],
    // Before, any hyphenated extension matched: another release, generation or custom model hid the substitution.
    [anthropic, "claude-opus-5", "claude-opus-5-5", false], [anthropic, "claude-haiku-5", "claude-haiku-5-5", false], [anthropic, "my-model", "my-model-large", false],
    [anthropic, "claude-opus-5-5", "claude-opus-5-5-preview", false], [anthropic, "claude-opus-5-5", "claude-opus-5-5-2026100", false], [claude, "haiku", "claude-haiku-4-5", false],
    // Only the documented alias table applies, and an empty request is resolved before comparing.
    [anthropic, "haiku", "claude-haiku-5-5", false], [claude, "constructor", "claude-constructor", false], [claude, "", "claude-sonnet-5-5", false],
  ]) assert.equal(modelMatches(adapter, requested, reported), expected, `${adapter.id} ${requested} -> ${reported}`);
  assert.deepEqual([requestedModel(anthropic, ""), requestedModel(anthropic, "claude-haiku-5-5"), requestedModel(claude, ""), requestedModel(codex, "")], ["claude-opus-5-5", "claude-haiku-5-5", "", ""]);
  // A blank direct-provider run launches exactly the model it is compared with.
  const { args } = buildExecutionLaunch({ conversation: { worktreePath: "/w" }, run: { provider: "anthropic-api", ...baseRun } });
  assert.equal(args[args.indexOf("--model") + 1], requestedModel(anthropic, ""));
  assert.throws(() => defineAdapter(harnessSpec({ defaultModel: "unlisted" })), /default model must be an advertised model/);
  assert.throws(() => defineAdapter(harnessSpec({ modelAliases: { unlisted: ["m-1"] } })), /model aliases must map advertised models/);
  assert.throws(() => defineAdapter(harnessSpec({ modelAliases: { m: ["--flag"] } })), /model aliases must map advertised models/);
});

test("every registered adapter has fixtures and a serializable description without secrets", () => {
  assert.deepEqual(EXECUTION_ADAPTERS.map((adapter) => adapter.id), ["codex", "claude", "anthropic-api"]);
  for (const adapter of EXECUTION_ADAPTERS) {
    assert.ok(existsSync(new URL(`${adapter.id}/`, fixtures)), `${adapter.id} needs compatibility fixtures`);
    const description = describeAdapter(adapter);
    assert.equal(description.contractVersion, ADAPTER_CONTRACT_VERSION);
    assert.deepEqual(JSON.parse(JSON.stringify(description)), description);
    assert.ok(description.capabilities.permissionModes.length > 0);
  }
  assert.deepEqual(describeAdapter(anthropic).authority, { source: "env", variable: "OUTRIGHT_ANTHROPIC_API_KEY" });
  assert.equal(describeAdapter(codex).capabilities.hosted, false);
  assert.equal(describeAdapter(anthropic).capabilities.hosted, true);
});

test("CLI versions are gated to the verified supported range", () => {
  assert.deepEqual(versionCompatibility(codex, codex.parseVersion(fixture("codex", "version.txt"))), { version: "0.162.1", compatible: true, reason: "" });
  assert.deepEqual(versionCompatibility(claude, claude.parseVersion(fixture("claude", "version.txt"))), { version: "2.1.296", compatible: true, reason: "" });
  const old = versionCompatibility(codex, codex.parseVersion("codex-cli 0.20.0"));
  assert.equal(old.compatible, false);
  assert.match(old.reason, /Codex 0\.20\.0 is not supported; Outright supports 0\.162\.1 or newer below 1\.0\.0/);
  // No evidence exists below the recorded fixtures, so older CLIs are not enqueued.
  assert.equal(versionCompatibility(codex, codex.parseVersion("codex-cli 0.162.0")).compatible, false);
  assert.equal(versionCompatibility(codex, codex.parseVersion("codex-cli 0.145.0")).compatible, false);
  // A prerelease at or above the floor is not the stable release the fixtures were recorded from.
  for (const [adapter, text, version] of [[codex, "codex-cli 0.162.1-rc.1", "0.162.1-rc.1"], [codex, "codex 0.163.0-nightly.20261001", "0.163.0-nightly.20261001"], [claude, "2.1.296-beta.4 (Claude Code)", "2.1.296-beta.4"]]) {
    assert.deepEqual(versionCompatibility(adapter, adapter.parseVersion(text)),
      { version, compatible: false, reason: `${adapter.label} ${version} is a prerelease; Outright supports stable releases ${adapter.versions.minimum} or newer below ${adapter.versions.belowMajor}.0.0` });
  }
  assert.equal(versionCompatibility(claude, claude.parseVersion("3.0.0 (Claude Code)")).compatible, false, "an unverified major is incompatible");
  assert.match(versionCompatibility(codex, codex.parseVersion("codex development build")).reason, /unrecognized version/);
});

test("unsupported configurations are rejected instead of falling back", () => {
  // Before adapters, an unknown policy silently became workspace-write.
  assert.throws(() => validateExecutionConfiguration({ provider: "codex", ...baseRun, approvalPolicy: "bypass" }),
    { code: "PROVIDER_CONFIGURATION_INVALID", statusCode: 400 });
  assert.throws(() => validateExecutionConfiguration({ provider: "anthropic-api", ...baseRun, approvalPolicy: "workspace-write" }),
    { code: "PROVIDER_CONFIGURATION_UNSUPPORTED", message: /Anthropic API does not support the workspace-write approval policy/ });
  assert.throws(() => validateExecutionConfiguration({ provider: "anthropic-api", ...baseRun, reasoningEffort: "high" }),
    { code: "PROVIDER_CONFIGURATION_UNSUPPORTED" });
  assert.throws(() => validateExecutionConfiguration({ provider: "codex", ...baseRun, reasoningEffort: undefined }),
    { code: "PROVIDER_CONFIGURATION_INVALID", statusCode: 400 }, "an invalid effort used to be dropped silently");
  assert.throws(() => validateExecutionConfiguration({ provider: "hermes", ...baseRun }), { code: "PROVIDER_UNKNOWN", statusCode: 400 });
  assert.throws(() => validateExecutionConfiguration({ provider: "anthropic-api", ...baseRun, sessionId: "a1d55507-d4ad-43ef-8154-19b111bbed42" }),
    { code: "PROVIDER_RESUME_UNSUPPORTED" });
  assert.doesNotThrow(() => validateRunConfiguration(codex, { ...baseRun, model: "gpt-6.1-sol" }), "harness CLIs accept custom model names");
});

test("malformed approval policies and efforts are invalid requests and are not echoed", () => {
  // Before, any value was a 409 "unsupported" that interpolated the raw input.
  for (const field of ["approvalPolicy", "reasoningEffort"]) {
    for (const value of [{ toString: () => "object" }, ["read-only"], 7, "x".repeat(5000)]) {
      assert.throws(() => validateExecutionConfiguration({ provider: "claude", ...baseRun, [field]: value }), (error) => {
        assert.deepEqual([error.code, error.statusCode], ["PROVIDER_CONFIGURATION_INVALID", 400], field);
        assert.ok(error.message.length < 200 && !error.message.includes("object") && !error.message.includes("xxxx"), error.message);
        return true;
      });
    }
  }
});

test("model, session and prompt values can never become provider options", () => {
  assert.throws(() => validateExecutionConfiguration({ provider: "claude", ...baseRun, model: "--dangerously-skip-permissions" }),
    { code: "PROVIDER_CONFIGURATION_INVALID", statusCode: 400 });
  assert.throws(() => buildExecutionLaunch({ conversation: { worktreePath: "/w" }, run: { provider: "codex", ...baseRun }, sessionId: "--dangerously-bypass-approvals-and-sandbox" }),
    { code: "PROVIDER_SESSION_INVALID" });
  for (const prompt of ["review", "--help", "-"]) {
    for (const sessionId of [null, "01a12627-f09a-7fd1-acee-6058eb376e35"]) {
      for (const provider of ["codex", "claude"]) {
        const { args } = buildExecutionLaunch({ conversation: { worktreePath: "/w" }, run: { provider, ...baseRun, prompt }, sessionId });
        // Codex resume takes the session id as a positional before the prompt.
        assert.equal(args.at(-1), prompt, `${provider} keeps ${prompt} positional`);
        assert.equal(args.at(sessionId && provider === "codex" ? -3 : -2), "--");
      }
    }
  }
});

test("native permission modes and session identity are preserved per adapter", () => {
  const conversation = { worktreePath: "/w" };
  const claudeResume = buildExecutionLaunch({ conversation, run: { provider: "claude", ...baseRun, approvalPolicy: "danger-full-access" }, sessionId: "s-1" }).args;
  assert.deepEqual(claudeResume.slice(claudeResume.indexOf("--permission-mode"), claudeResume.indexOf("--permission-mode") + 2), ["--permission-mode", "bypassPermissions"]);
  assert.deepEqual(claudeResume.slice(claudeResume.indexOf("--resume"), claudeResume.indexOf("--resume") + 2), ["--resume", "s-1"]);
  const codexResume = buildExecutionLaunch({ conversation, run: { provider: "codex", ...baseRun, approvalPolicy: "workspace-write" }, sessionId: "s-1" }).args;
  assert.deepEqual(codexResume.slice(0, 3), ["exec", "resume", "--json"]);
  assert.ok(codexResume.includes('sandbox_mode="workspace-write"'));
  assert.deepEqual(codexResume.slice(-3, -1), ["--", "s-1"]);
  const direct = buildExecutionLaunch({ conversation, run: { provider: "anthropic-api", ...baseRun } });
  assert.equal(direct.executable, process.execPath);
  assert.deepEqual(direct.args.slice(1), ["--model", "claude-opus-5-5", "--", "review"]);
});

test("recorded Codex streams normalize without erasing provider details", () => {
  const fresh = normalizeFixture(codex, "exec.jsonl");
  const session = fresh.find((event) => event.type === "session").payload.sessionId;
  assert.equal(session, "01a12627-f09a-7fd1-acee-6058eb376e35");
  assert.ok(fresh.some((event) => event.type === "assistant.message" && event.payload.text));
  assert.ok(fresh.some((event) => event.type === "tool.completed" && event.payload.item.type === "command_execution"), "tool items stay native");
  const usage = fresh.find((event) => event.type === "usage").payload;
  assert.ok(Number.isFinite(usage.inputTokens) && Number.isFinite(usage.outputTokens));
  assert.ok(Object.hasOwn(usage.native, "cached_input_tokens"), "provider-specific usage detail is retained");
  const resumed = normalizeFixture(codex, "resume.jsonl");
  assert.equal(resumed.find((event) => event.type === "session").payload.sessionId, session, "resume continues the native thread");
  assert.equal(resumed.find((event) => event.type === "assistant.message").payload.text, "READY");
  assert.ok(fresh.some((event) => event.type === "tool.started" && event.payload.item.type === "command_execution"));
  // Reasoning, plans and other non-tool items are native events, not tool rows.
  for (const type of ["reasoning", "todo_list", "error", "future_status"]) {
    for (const phase of ["item.started", "item.completed"]) {
      assert.deepEqual(codex.normalize({ type: phase, item: { id: "item_9", type, text: "thinking" } }).map((event) => event.type), ["provider.event"], `${phase} ${type}`);
    }
  }
  for (const type of ["file_change", "mcp_tool_call", "web_search"]) {
    assert.equal(codex.normalize({ type: "item.started", item: { id: "item_9", type } })[0].type, "tool.started", type);
    assert.equal(codex.normalize({ type: "item.completed", item: { id: "item_9", type } })[0].type, "tool.completed", type);
  }
  const failedTurn = normalizeFixture(codex, "failed-turn.jsonl");
  assert.equal(failedTurn.some((event) => event.type === "tool.completed"), false, "CLI notices are not tool calls");
  assert.ok(failedTurn.some((event) => event.type === "provider.event" && event.payload.item?.type === "error"), "CLI notices stay as native events");
  const failures = failedTurn.filter((event) => event.type === "provider.failure");
  assert.ok(failures.length >= 1);
  assert.match(failures.at(-1).payload.message, /not supported when using Codex with a ChatGPT account/);
  assert.equal(failures.at(-1).payload.native.type, "turn.failed");
  // A top-level error may be a retried stream notice; only turn.failed is terminal.
  assert.deepEqual(failures.map((event) => [event.payload.native.type, event.payload.terminal]), [["error", false], ["turn.failed", true]]);
});

test("recorded Claude Code streams normalize without erasing provider details", () => {
  const fresh = normalizeFixture(claude, "print.jsonl");
  const session = fresh.find((event) => event.type === "session").payload.sessionId;
  assert.equal(session, "a1d55507-d4ad-43ef-8154-19b111bbed42");
  assert.equal(fresh.filter((event) => event.type === "assistant.delta").map((event) => event.payload.text).join(""), "READY");
  const usage = fresh.find((event) => event.type === "usage").payload;
  assert.ok(Number.isFinite(usage.costUsd));
  assert.ok(Object.hasOwn(usage.native, "cache_read_input_tokens"));
  assert.equal(normalizeFixture(claude, "resume.jsonl").find((event) => event.type === "session").payload.sessionId, session);
  const failed = normalizeFixture(claude, "error-result.jsonl");
  assert.equal(failed.some((event) => event.type === "assistant.message"), false, "an error result is not an assistant answer");
  const failure = failed.find((event) => event.type === "provider.failure").payload;
  assert.match(failure.message, /issue with the selected model/);
  assert.deepEqual([failure.native.terminal_reason, failure.native.api_error_status], ["api_error", 404]);
  assert.equal(failure.terminal, true);
  assert.ok(fresh.some((event) => event.type === "provider.event" && event.payload.type === "assistant"), "a text-only assistant record stays a native event");
  assert.deepEqual(fresh.filter((event) => event.type === "model").map((event) => event.payload.model), ["claude-opus-5-5"]);
});

test("Claude Code reports the model its own messages ran, not its init event or subagents", () => {
  const events = normalizeFixture(claude, "model-substitution.jsonl");
  // Init says Haiku; the run's own messages say Sonnet; the Task subagent's Haiku is not the run's model.
  assert.deepEqual(events.filter((event) => event.type === "model").map((event) => event.payload.model), ["claude-sonnet-5-5", "claude-sonnet-5-5", "claude-sonnet-5-5"]);
  const usage = events.find((event) => event.type === "usage").payload;
  assert.deepEqual(Object.keys(usage.modelUsage), ["claude-sonnet-5-5", "claude-haiku-5-5"], "per-model usage is kept");
  assert.deepEqual(anthropic.normalize({ type: "message_start", message: { model: "claude-sonnet-5-5", usage: { input_tokens: 1 } } }).map((event) => event.type === "model" ? event.payload.model : event.type), ["usage", "claude-sonnet-5-5"]);
  // The CLI's own error message carries model "<synthetic>"; no model answered it.
  assert.equal(normalizeFixture(claude, "error-result.jsonl").some((event) => event.type === "model"), false);
});

function runRunner(args, environment, nodeOptions = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeOptions, fileURLToPath(new URL("./execution-adapters/anthropic-api-runner.mjs", import.meta.url)), ...args],
      { env: { PATH: process.env.PATH, ...environment }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr, events: normalized(anthropic, stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line))) }));
  });
}

async function withApiFixture(respond, callback) {
  const requests = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => { requests.push({ headers: request.headers, body: JSON.parse(body), url: request.url }); respond(response); });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { return await callback(`http://127.0.0.1:${server.address().port}`, requests); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

// Synthetic streams open their message, and each content block, as the API does.
const messageStart = `data: ${JSON.stringify({ type: "message_start", message: { model: "claude-opus-5-5", usage: { input_tokens: 1 } } })}\n\n`;
const blockStart = (index = 0) => `data: ${JSON.stringify({ type: "content_block_start", index, content_block: { type: "text", text: "" } })}\n\n`;
const blockStop = (index = 0) => `data: ${JSON.stringify({ type: "content_block_stop", index })}\n\n`;

test("the Outright-managed Anthropic path streams through its own credential", async () => {
  const secret = "sk-ant-fixture-secret";
  await withApiFixture((response) => { response.writeHead(200, { "content-type": "text/event-stream" }); response.end(fixture("anthropic-api", "stream.sse")); }, async (base, requests) => {
    const launch = buildExecutionLaunch({ conversation: { worktreePath: "/w" }, run: { provider: "anthropic-api", ...baseRun, prompt: "--help" } });
    assert.equal(launch.args.includes(secret), false);
    const result = await runRunner(launch.args.slice(1), { OUTRIGHT_ANTHROPIC_API_KEY: secret, OUTRIGHT_ANTHROPIC_BASE_URL: base });
    assert.equal(result.code, 0);
    assert.equal(result.stdout.includes(secret), false, "the key is never echoed");
    assert.equal(requests[0].url, "/v1/messages");
    assert.equal(requests[0].headers["x-api-key"], secret);
    assert.deepEqual([requests[0].body.model, requests[0].body.stream, requests[0].body.messages[0].content], ["claude-opus-5-5", true, "--help"]);
    assert.equal(result.events.filter((event) => event.type === "assistant.delta").map((event) => event.payload.text).join(""), "READY now");
    const usage = result.events.filter((event) => event.type === "usage").map((event) => event.payload);
    assert.deepEqual([usage[0].inputTokens, usage.at(-1).outputTokens, usage.at(-1).native.stop_reason], [12, 3, "end_turn"]);
    assert.equal(result.events.some((event) => event.type === "provider.event"), false, "stream noise is not persisted");
  });
});

test("Anthropic API failures are normalized and fail the run", async () => {
  await withApiFixture((response) => { response.writeHead(401, { "content-type": "application/json" }); response.end(fixture("anthropic-api", "unauthorized.json")); }, async (base) => {
    const result = await runRunner(["--model", "claude-opus-5-5", "--", "hi"], { OUTRIGHT_ANTHROPIC_API_KEY: "bad", OUTRIGHT_ANTHROPIC_BASE_URL: base });
    assert.equal(result.code, 1);
    assert.deepEqual(result.events.map((event) => [event.type, event.payload.message, event.payload.native?.type]), [["provider.failure", "invalid x-api-key", "authentication_error"]]);
  });
  await withApiFixture((response) => { response.writeHead(200, { "content-type": "text/event-stream" }); response.end(fixture("anthropic-api", "overloaded.sse")); }, async (base) => {
    const result = await runRunner(["--model", "claude-opus-5-5", "--", "hi"], { OUTRIGHT_ANTHROPIC_API_KEY: fixtureKey, OUTRIGHT_ANTHROPIC_BASE_URL: base });
    assert.equal(result.code, 1);
    assert.equal(result.events.at(-1).payload.message, "Overloaded");
  });
  // A key is never sent over plaintext to a non-local host, and no CLI login is consulted.
  const insecure = await runRunner(["--model", "m", "--", "hi"], { OUTRIGHT_ANTHROPIC_API_KEY: fixtureKey, OUTRIGHT_ANTHROPIC_BASE_URL: "http://example.com" });
  assert.equal(insecure.code, 2);
  assert.match(insecure.events[0].payload.message, /must be an https URL/);
  // A harness's own Anthropic credential is never borrowed by the direct provider.
  const missing = await runRunner(["--model", "m", "--", "hi"], { ANTHROPIC_API_KEY: "harness-key" });
  assert.equal(missing.code, 2);
  assert.match(missing.events[0].payload.message, /OUTRIGHT_ANTHROPIC_API_KEY is not set/);
});

test("an Anthropic answer cut off at the output cap or context window fails visibly and keeps its text", async () => {
  for (const [file, stopReason, message] of [["max-tokens.sse", "max_tokens", /8192-token output limit; the answer is truncated/],
    ["context-window.sse", "model_context_window_exceeded", /the model's context window; the answer is truncated/]]) {
    await withApiFixture((response) => { response.writeHead(200, { "content-type": "text/event-stream" }); response.end(fixture("anthropic-api", file)); }, async (base, requests) => {
      const result = await runRunner(["--model", "claude-opus-5-5", "--", "hi"], { OUTRIGHT_ANTHROPIC_API_KEY: fixtureKey, OUTRIGHT_ANTHROPIC_BASE_URL: base });
      assert.equal(requests[0].body.max_tokens, 8192, "the declared cap is the one requested");
      assert.equal(result.events.filter((event) => event.type === "assistant.delta").map((event) => event.payload.text).join(""), "READY now");
      // Before, a truncating stop normalized to usage only and the run completed.
      const failure = result.events.find((event) => event.type === "provider.failure");
      assert.deepEqual([failure?.payload.terminal, failure?.payload.native], [true, { stop_reason: stopReason }], file);
      assert.match(failure.payload.message, message);
      assert.equal(result.events.find((event) => event.type === "usage" && event.payload.outputTokens !== undefined)?.payload.native.stop_reason, stopReason, "usage keeps the native stop reason");
    });
  }
});

test("a recognized Anthropic text delta without text fails the run instead of dropping it", async () => {
  await withApiFixture((response) => { response.writeHead(200, { "content-type": "text/event-stream" }); response.end(fixture("anthropic-api", "malformed-delta.sse")); }, async (base) => {
    const result = await runRunner(["--model", "claude-opus-5-5", "--", "hi"], { OUTRIGHT_ANTHROPIC_API_KEY: fixtureKey, OUTRIGHT_ANTHROPIC_BASE_URL: base });
    assert.equal(result.events.filter((event) => event.type === "assistant.delta").map((event) => event.payload.text).join(""), "READY");
    // Before, the numeric text normalized to nothing and message_stop completed the run.
    const failures = result.events.filter((event) => event.type === "provider.failure");
    assert.deepEqual(failures.map((event) => [event.payload.terminal, event.payload.message]), [[true, "Anthropic API sent a malformed text delta; the answer is incomplete"]]);
    assert.equal(JSON.stringify(failures).includes("424242"), false, "the malformed payload is not echoed");
  });
  // Without a native type the delta cannot be shown to carry no answer text.
  const source = fixture("anthropic-api", "malformed-delta.sse");
  for (const delta of ['{"text":" lost"}', '{"type":7,"text":" lost"}', '{"type":"","text":" lost"}']) {
    await withApiFixture((response) => { response.writeHead(200, { "content-type": "text/event-stream" }); response.end(source.replace('{"type":"text_delta","text":424242}', delta)); }, async (base) => {
      const result = await runRunner(["--model", "claude-opus-5-5", "--", "hi"], { OUTRIGHT_ANTHROPIC_API_KEY: fixtureKey, OUTRIGHT_ANTHROPIC_BASE_URL: base });
      assert.equal(result.events.filter((event) => event.type === "assistant.delta").map((event) => event.payload.text).join(""), "READY", delta);
      assert.deepEqual(result.events.filter((event) => event.type === "provider.failure").map((event) => event.payload.terminal), [true], delta);
      assert.equal(result.events.find((event) => event.type === "usage" && event.payload.outputTokens !== undefined)?.payload.outputTokens, 3, delta);
    });
  }
  // A delta type Outright does not consume stays ignored for forward compatibility.
  assert.deepEqual(anthropic.normalize({ type: "content_block_delta", index: 0, delta: { type: "future_delta", value: 1 } }), []);
  assert.equal(anthropic.normalize({ type: "content_block_delta", index: 0 })[0].type, "provider.failure");
});

// A key with characters JSON escapes, so a nested reflection differs from it.
const reflectedKey = 'fixture-"reflected"\\direct-key';
// Every form of the key a reader could recover by decoding once or more.
const formsOf = (key) => [key, JSON.stringify(key).slice(1, -1), JSON.stringify(JSON.stringify(key)).slice(1, -1)];
function assertNoKey(result, label, keyForms = formsOf(reflectedKey)) {
  // The manager persists stderr as process events and as a fallback run error.
  const strings = [result.stdout, result.stderr, result.events.filter((event) => event.type === "assistant.delta").map((event) => event.payload.text).join("")];
  const collect = (value) => {
    if (typeof value === "string") strings.push(value);
    else if (value && typeof value === "object") for (const [name, item] of Object.entries(value)) { strings.push(name); collect(item); }
  };
  collect(result.events);
  assert.equal(strings.some((text) => keyForms.some((form) => text.includes(form))), false, `${label}: the key left the runner`);
}

test("a reflected API key never leaves the runner in provider error text", async () => {
  const reflected = `invalid x-api-key ${reflectedKey}`;
  const nested = JSON.stringify({ echoed: reflectedKey });
  const twiceNested = JSON.stringify({ inner: nested });
  const sseError = (error) => `event: error\ndata: ${JSON.stringify({ type: "error", error })}\n\n`;
  for (const [respond, message] of [
    [(response) => { response.writeHead(401, { "content-type": "application/json" }); response.end(JSON.stringify({ type: "error", error: { type: `authentication_error ${reflectedKey}`, message: reflected } })); }, "invalid x-api-key [redacted]"],
    [(response) => { response.writeHead(200, { "content-type": "text/event-stream" }); response.end(sseError({ type: "overloaded_error", message: reflected, echoed: reflectedKey, [reflectedKey]: 1 })); }, "invalid x-api-key [redacted]"],
    // A gateway can nest the key inside JSON-encoded text, once or more.
    [(response) => { response.writeHead(401, { "content-type": "application/json" }); response.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: nested } })); }, JSON.stringify({ echoed: "[redacted]" })],
    [(response) => { response.writeHead(200, { "content-type": "text/event-stream" }); response.end(sseError({ type: "api_error", message: twiceNested })); }, JSON.stringify({ inner: JSON.stringify({ echoed: "[redacted]" }) })],
  ]) {
    await withApiFixture(respond, async (base) => {
      const result = await runRunner(["--model", "claude-opus-5-5", "--", "hi"], { OUTRIGHT_ANTHROPIC_API_KEY: reflectedKey, OUTRIGHT_ANTHROPIC_BASE_URL: base });
      // Before, the gateway's message reached stdout, run events and the run
      // error verbatim, and a nested reflection kept its escaped form.
      assert.equal(result.code, 1);
      assertNoKey(result, message);
      const failure = result.events.at(-1);
      assert.deepEqual([failure.type, failure.payload.terminal, failure.payload.message], ["provider.failure", true, message], "the rest of the diagnostic is kept");
    });
  }
});

test("a key split across text deltas never reaches the assembled answer", async () => {
  const delta = (text) => `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n`;
  const ping = 'event: ping\ndata: {"type":"ping"}\n\n';
  const end = 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
  // Every two-way split position, and three-way splits with a ping between.
  let body = "";
  let expected = "";
  for (let index = 1; index < reflectedKey.length; index += 1) {
    body += `${delta(`<${reflectedKey.slice(0, index)}`)}${delta(`${reflectedKey.slice(index)}>`)}`;
    const third = Math.min(index + 3, reflectedKey.length - 1);
    if (third > index) body += `${delta(`(${reflectedKey.slice(0, index)}`)}${ping}${delta(reflectedKey.slice(index, third))}${delta(`${reflectedKey.slice(third)})`)}`;
    expected += third > index ? "<[redacted]>([redacted])" : "<[redacted]>";
  }
  // Held text that turns out not to be the key is delivered unchanged.
  body += `${delta(` ${reflectedKey.slice(0, 9)}`)}${delta("!")}${delta(` ${reflectedKey.slice(0, 12)}`)}`;
  expected += ` ${reflectedKey.slice(0, 9)}! ${reflectedKey.slice(0, 12)}`;
  for (const [stream, code] of [[`${messageStart}${blockStart()}${body}${blockStop()}${end}`, 0], [`${messageStart}${blockStart()}${body}data: {"index":0}\n\n`, 1]]) {
    await withApiFixture((response) => { response.writeHead(200, { "content-type": "text/event-stream" }); response.end(stream); }, async (base) => {
      const result = await runRunner(["--model", "claude-opus-5-5", "--", "hi"], { OUTRIGHT_ANTHROPIC_API_KEY: reflectedKey, OUTRIGHT_ANTHROPIC_BASE_URL: base });
      // Before, each record was redacted alone and the answer held the key at every split.
      assertNoKey(result, `exit ${code}`);
      assert.equal(result.events.filter((event) => event.type === "assistant.delta").map((event) => event.payload.text).join(""), expected);
      assert.equal(result.code, code);
      if (code) assert.equal(result.events.at(-1).payload.message, "Anthropic API sent a malformed stream event", "an event without a type fails after the held text");
    });
  }
});

test("a credential-bearing index never leaves the runner, whichever way the stream ends", async () => {
  const event = (record) => `data: ${JSON.stringify(record)}\n\n`;
  const textDelta = (index, text) => event({ type: "content_block_delta", index, delta: { type: "text_delta", text } });
  const end = `${event({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } })}${event({ type: "message_stop" })}`;
  // Block boundaries are forwarded redacted. The text ends in a key prefix,
  // so a suffix is held until the stream ends.
  const start = `${messageStart}${event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "", [reflectedKey]: reflectedKey } })}`;
  const held = `ok ${reflectedKey.slice(0, 5)}`;
  const opening = `${start}${textDelta(0, held)}`;
  const malformed = "Anthropic API sent a malformed stream event";
  const cases = [
    ["end_turn", `${opening}${event({ type: "content_block_stop", index: 0, echoed: [reflectedKey] })}${end}`, 0, null, held],
    ["error event", `${opening}${event({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })}`, 1, "Overloaded", held],
    ["no message_stop", opening, 1, "Anthropic API stream ended before message_stop", held],
    ["overflow", `${opening}data: ${"x".repeat(1024 * 1024 + 1)}\n`, 1, "Anthropic API stream event exceeded 1 MiB", held],
    ["network", opening, 1, /^Anthropic API stream failed: /, held],
    // The held text is released under the last text delta's index, so only a
    // native one is accepted; the rejected delta's text is not kept. A block
    // boundary with a key for its index fails the same way.
    ...[reflectedKey, { [reflectedKey]: reflectedKey }, [reflectedKey], -1, 0.5].map((index) => [`index ${JSON.stringify(index)}`, `${start}${textDelta(0, "ok ")}${textDelta(index, reflectedKey.slice(0, 5))}${end}`, 1, malformed, "ok "]),
    ["block stop index", `${opening}${event({ type: "content_block_stop", index: [reflectedKey] })}${end}`, 1, malformed, held],
  ];
  for (const [name, body, code, message, answer] of cases) {
    await withApiFixture((response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (name === "network") response.write(body, () => setTimeout(() => response.destroy(), 20));
      else response.end(body);
    }, async (base) => {
      const result = await runRunner(["--model", "claude-opus-5-5", "--", "hi"], { OUTRIGHT_ANTHROPIC_API_KEY: reflectedKey, OUTRIGHT_ANTHROPIC_BASE_URL: base });
      // Before, the held text was released under the raw provider index.
      assertNoKey(result, name);
      assert.equal(result.code, code, name);
      assert.equal(result.events.filter((item) => item.type === "assistant.delta").map((item) => item.payload.text).join(""), answer, name);
      const failure = result.events.find((item) => item.type === "provider.failure")?.payload.message ?? null;
      if (message instanceof RegExp) assert.match(failure, message, name);
      else assert.equal(failure, message, name);
    });
  }
});

test("a message that ends without a valid stop reason fails and keeps its text and usage", async () => {
  const text = (result) => result.events.filter((event) => event.type === "assistant.delta").map((event) => event.payload.text).join("");
  const withoutReason = fixture("anthropic-api", "missing-stop-reason.sse");
  for (const [name, body] of [["missing", withoutReason], ["numeric", withoutReason.replace('"delta":{"stop_sequence":null}', '"delta":{"stop_reason":7}')],
    ["empty", withoutReason.replace('"delta":{"stop_sequence":null}', '"delta":{"stop_reason":""}')]]) {
    await withApiFixture((response) => { response.writeHead(200, { "content-type": "text/event-stream" }); response.end(body); }, async (base) => {
      const result = await runRunner(["--model", "claude-opus-5-5", "--", "hi"], { OUTRIGHT_ANTHROPIC_API_KEY: fixtureKey, OUTRIGHT_ANTHROPIC_BASE_URL: base });
      assert.equal(text(result), "READY now", name);
      assert.equal(result.events.find((event) => event.type === "usage" && event.payload.outputTokens !== undefined)?.payload.outputTokens, 3, name);
      // Before, the delta normalized to usage only and message_stop completed the run.
      const failures = result.events.filter((event) => event.type === "provider.failure");
      assert.deepEqual(failures.map((event) => [event.payload.terminal, event.payload.message, event.payload.native]),
        [[true, "Anthropic API ended the message without a stop reason; the answer may be incomplete", { type: "malformed_stop_reason" }]], name);
    });
  }
  // A non-empty stop reason Outright does not know still completes.
  assert.deepEqual(anthropic.normalize({ type: "message_delta", delta: { stop_reason: "future_reason" }, usage: { output_tokens: 1 } }).map((event) => event.type), ["usage"]);
  // A stream with no message_delta at all reaches message_stop without any
  // stop reason, out of order. A Windows checkout may end the fixture's lines in CRLF.
  const noDelta = withoutReason.replace(/event: message_delta\r?\n.*\r?\n\r?\n/, "");
  assert.equal(noDelta.includes("message_delta"), false);
  await withApiFixture((response) => { response.writeHead(200, { "content-type": "text/event-stream" }); response.end(noDelta); }, async (base) => {
    const result = await runRunner(["--model", "claude-opus-5-5", "--", "hi"], { OUTRIGHT_ANTHROPIC_API_KEY: fixtureKey, OUTRIGHT_ANTHROPIC_BASE_URL: base });
    assert.deepEqual([result.code, text(result), result.events.at(-1).payload.message], [1, "READY now", "Anthropic API sent stream events out of order; the answer may be incomplete"]);
  });
});

test("the direct provider never forwards its key across a redirect", async () => {
  await withApiFixture((response) => { response.writeHead(200, { "content-type": "text/event-stream" }); response.end(fixture("anthropic-api", "stream.sse")); }, async (target, followed) => {
    for (const [status, location] of [[307, `${target}/v1/messages`], [308, "http://example.com/v1/messages"], [302, "/v1/elsewhere"]]) {
      await withApiFixture((response) => { response.writeHead(status, { location }); response.end(); }, async (base, requests) => {
        const result = await runRunner(["--model", "claude-opus-5-5", "--", "hi"], { OUTRIGHT_ANTHROPIC_API_KEY: "sk-ant-redirect", OUTRIGHT_ANTHROPIC_BASE_URL: base });
        assert.equal(result.code, 1, `HTTP ${status} must fail the run`);
        assert.match(result.events.at(-1).payload.message, new RegExp(`redirected the request \\(HTTP ${status}\\)`));
        assert.equal(requests.length, 1, "a same-origin redirect is not followed either");
      });
    }
    assert.equal(followed.length, 0, "the cross-origin hop never received the key");
  });
});

test("the runner's own failure messages are redacted once the key is read", async () => {
  // Each key is text its exit writes itself, so a call site that skipped
  // redaction would print it.
  const closed = await new Promise((resolve) => { const server = createServer(); server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); }); });
  await withApiFixture((response) => { response.writeHead(307, { location: "/elsewhere" }); response.end(); }, async (redirecting) => {
    for (const [name, key, base, code, message] of [
      ["fetch rejection", "ECONNREFUSED", `http://127.0.0.1:${closed}`, 1, "Anthropic API request failed: [redacted]"],
      ["redirect", "HTTP 307", redirecting, 1, "Anthropic API redirected the request ([redacted]); Outright does not forward credentials across redirects"],
      ["unusable endpoint", "loopback http address", "http://example.com", 2, ENDPOINT_REQUIREMENT.replace("loopback http address", "[redacted]")],
    ]) {
      const result = await runRunner(["--model", "claude-opus-5-5", "--", "hi"], { OUTRIGHT_ANTHROPIC_API_KEY: key, OUTRIGHT_ANTHROPIC_BASE_URL: base });
      // Before, these three exits wrote their message without redaction.
      assertNoKey(result, name, formsOf(key));
      assert.deepEqual([result.code, result.events.at(-1).payload.message], [code, message], name);
    }
  });
});

test("CR, LF and CRLF line endings stream the same answer, even split across chunks", async () => {
  const runWith = (body, pieces) => withApiFixture((response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    // Each piece ends right after a CR, so a CRLF arrives split in two.
    const parts = pieces ? body.split(/(?<=\r)/) : [body];
    const next = () => { const part = parts.shift(); if (parts.length) response.write(part, () => setTimeout(next, 5)); else response.end(part); };
    next();
  }, (base) => runRunner(["--model", "claude-opus-5-5", "--", "hi"], { OUTRIGHT_ANTHROPIC_API_KEY: fixtureKey, OUTRIGHT_ANTHROPIC_BASE_URL: base }));
  const source = fixture("anthropic-api", "stream.sse");
  const expected = await runWith(source, false);
  assert.equal(expected.code, 0);
  for (const ending of ["\r", "\r\n"]) {
    // Before, a CR-only stream never ended a line and never saw message_stop.
    const result = await runWith(source.replaceAll("\n", ending), true);
    assert.deepEqual([result.code, result.events], [0, expected.events], JSON.stringify(ending));
  }
});

test("one stream event is bounded across chunks and data lines", async () => {
  // Each data line is small and the event never reaches a blank-line dispatch.
  const line = `data: ${"x".repeat(64 * 1024)}\n`;
  for (const lines of [24, 40]) {
    await withApiFixture((response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (let index = 0; index < lines; index += 1) response.write(line);
      response.end("\n");
    }, async (base) => {
      const result = await runRunner(["--model", "claude-opus-5-5", "--", "hi"], { OUTRIGHT_ANTHROPIC_API_KEY: fixtureKey, OUTRIGHT_ANTHROPIC_BASE_URL: base });
      assert.equal(result.code, 1, `a ${lines}-line event must fail`);
      assert.equal(result.events.at(-1).payload.message, "Anthropic API stream event exceeded 1 MiB");
      assert.ok(result.stdout.length < 1024, "the oversized event is not echoed");
    });
  }
});

test("an event's data lines are bounded by the bytes the event holds, however short they are", async () => {
  const MAX = 1024 * 1024;
  const opening = `${messageStart}${blockStart()}data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `kept ${reflectedKey.slice(0, 5)}` } })}\n\n`;
  const stream = (ending, line, count) => {
    const unit = `${line}${ending}`;
    // Pieces end mid-line, and inside a CRLF when there is one.
    const size = unit.length * 9362 + unit.length - 1;
    let body = opening.replaceAll("\n", ending);
    return (response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      let sent = 0;
      const next = () => {
        if (response.destroyed) return;
        while (body.length < size && (count === Infinity || sent < count)) { body += unit; sent += 1; }
        if (count !== Infinity && sent >= count && body.length <= size) return response.end(`${body}${ending}`);
        response.write(body.slice(0, size), next);
        body = body.slice(size);
      };
      next();
    };
  };
  const run = (respond, nodeOptions) => withApiFixture(respond, (base) => runRunner(["--model", "claude-opus-5-5", "--", "hi"], { OUTRIGHT_ANTHROPIC_API_KEY: reflectedKey, OUTRIGHT_ANTHROPIC_BASE_URL: base }, nodeOptions));
  const answer = (result) => result.events.filter((event) => event.type === "assistant.delta").map((event) => event.payload.text).join("");
  // An endless event of empty or one-byte lines stops at the bound in a heap
  // far smaller than one entry per line would need. Before, the line array
  // the 1 MiB count did not see exhausted that heap (no exit code).
  for (const line of ["data:", "data:x"]) {
    for (const ending of ["\n", "\r", "\r\n"]) {
      const name = `${JSON.stringify(line)} ${JSON.stringify(ending)}`;
      const result = await run(stream(ending, line, Infinity), ["--max-old-space-size=8"]);
      assert.equal(result.code, 1, name);
      assert.equal(result.events.at(-1).payload.message, "Anthropic API stream event exceeded 1 MiB", name);
      assert.equal(answer(result), `kept ${reflectedKey.slice(0, 5)}`, `${name}: the earlier text and the held tail are kept`);
      assert.ok(result.stdout.length < 1024, `${name}: the oversized event is not echoed`);
      assertNoKey(result, name);
    }
  }
  // The bound is the joined data: MAX + 1 empty lines are MAX separators and
  // reach dispatch (not JSON); one more line overflows.
  for (const [count, message] of [[MAX + 1, "Anthropic API sent a malformed stream event"], [MAX + 2, "Anthropic API stream event exceeded 1 MiB"]]) {
    const result = await run(stream("\n", "data:", count));
    assert.equal(result.events.at(-1).payload.message, message, `${count} empty lines`);
  }
  // An ordinary multiline event and one just under the bound still parse.
  const end = 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\ndata: {"type":"message_stop"}\n\n';
  const head = '{"type":"content_block_delta","index":0,\ndata: "delta":{"type":"text_delta","text":';
  for (const text of ["two lines", "y".repeat(MAX - 200)]) {
    const result = await run((response) => { response.writeHead(200, { "content-type": "text/event-stream" }); response.end(`${messageStart}${blockStart()}data: ${head}"${text}"}}\n\n${blockStop()}${end}`); });
    assert.equal(result.code, 0, `${text.length} characters`);
    assert.ok(answer(result) === text, `${text.length} characters: the answer is kept whole`);
  }
});

test("a malformed stream event fails the run and keeps the text already streamed", async () => {
  const delta = (text) => `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n`;
  for (const broken of ["data: {broken-json}\n\n", "data: [1]\n\n"]) {
    await withApiFixture((response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`${messageStart}${blockStart()}${delta("partial")}${broken}${delta(" lost")}data: {"type":"message_stop"}\n\n`);
    }, async (base) => {
      const result = await runRunner(["--model", "claude-opus-5-5", "--", "hi"], { OUTRIGHT_ANTHROPIC_API_KEY: fixtureKey, OUTRIGHT_ANTHROPIC_BASE_URL: base });
      // Before, the event was dropped and message_stop completed the run.
      assert.equal(result.code, 1, broken);
      assert.deepEqual(result.events.filter((event) => !["usage", "model"].includes(event.type)).map((event) => [event.type, event.payload.text ?? event.payload.message]),
        [["assistant.delta", "partial"], ["provider.failure", "Anthropic API sent a malformed stream event"]]);
      assert.equal(result.events.at(-1).payload.terminal, true);
    });
  }
});

test("a stream that breaks the message lifecycle fails the run and keeps the text before the break", async () => {
  const event = (record) => `data: ${JSON.stringify(record)}\n\n`;
  const text = (value, index = 0) => event({ type: "content_block_delta", index, delta: { type: "text_delta", text: value } });
  const delta = event({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
  const stop = event({ type: "message_stop" });
  const ping = event({ type: "ping" });
  const future = event({ type: "future_event", detail: 1 });
  // The answer ends in a key prefix, so held text is released on every exit.
  const said = `ok ${reflectedKey.slice(0, 5)}`;
  const opened = `${messageStart}${blockStart()}${text(said)}`;
  const closed = `${opened}${blockStop()}`;
  const outOfOrder = "Anthropic API sent stream events out of order; the answer may be incomplete";
  for (const [name, body, code, message, answer] of [
    // Before, each of these exited 0 and completed the run.
    ["no message_start", `${blockStart()}${text(said)}${blockStop()}${delta}${stop}`, 1, outOfOrder, ""],
    ["only delta and stop", `${delta}${stop}`, 1, outOfOrder, ""],
    ["stop before delta", `${closed}${stop}${delta}`, 1, outOfOrder, said],
    ["duplicate message_start", `${closed}${messageStart}${delta}${stop}`, 1, outOfOrder, said],
    ["text after message_delta", `${closed}${delta}${text(" late")}${stop}`, 1, outOfOrder, said],
    ["text after message_stop", `${closed}${delta}${stop}${text(" late")}`, 1, outOfOrder, said],
    ["ping after message_stop", `${closed}${delta}${stop}${ping}`, 1, outOfOrder, said],
    ["no message_stop", `${closed}${delta}`, 1, "Anthropic API stream ended before message_stop", said],
    // Each content block is its start, deltas for its index only, then its
    // stop. Before, each of these exited 0 and completed the run.
    ["delta before its block starts", `${messageStart}${text(" late")}${blockStart()}${blockStop()}${delta}${stop}`, 1, outOfOrder, ""],
    ["delta before the next block starts", `${closed}${text(" late", 1)}${delta}${stop}`, 1, outOfOrder, said],
    ["delta after its block stops", `${closed}${text(" late")}${delta}${stop}`, 1, outOfOrder, said],
    ["block open at message_delta", `${opened}${delta}${stop}`, 1, outOfOrder, said],
    ["reused index", `${closed}${blockStart()}${text(" late")}${blockStop()}${delta}${stop}`, 1, outOfOrder, said],
    ["stop without start", `${closed}${blockStop(1)}${delta}${stop}`, 1, outOfOrder, said],
    ["delta for another index than the open one", `${opened}${text(" late", 1)}${blockStop()}${delta}${stop}`, 1, outOfOrder, said],
    ["block starts while another is open", `${opened}${blockStart(1)}${text(" late", 1)}${blockStop(1)}${delta}${stop}`, 1, outOfOrder, said],
    // Several blocks in order, and a block with no deltas (a server-side
    // fallback), complete.
    ["blocks in order", `${closed}${blockStart(1)}${blockStop(1)}${blockStart(2)}${text(" more", 2)}${blockStop(2)}${delta}${stop}`, 0, null, `${said} more`],
    // Pings, unknown event types and repeated deltas before message_stop are kept compatible.
    ["pings and unknown events", `${ping}${messageStart}${future}${blockStart()}${ping}${text(said)}${future}${blockStop()}${delta}${ping}${delta}${stop}`, 0, null, said],
    ["error before message_start", event({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }), 1, "Overloaded", ""],
  ]) {
    await withApiFixture((response) => { response.writeHead(200, { "content-type": "text/event-stream" }); response.end(body); }, async (base) => {
      const result = await runRunner(["--model", "claude-opus-5-5", "--", "hi"], { OUTRIGHT_ANTHROPIC_API_KEY: reflectedKey, OUTRIGHT_ANTHROPIC_BASE_URL: base });
      assertNoKey(result, name);
      assert.equal(result.code, code, name);
      assert.equal(result.events.filter((item) => item.type === "assistant.delta").map((item) => item.payload.text).join(""), answer, name);
      const failures = result.events.filter((item) => item.type === "provider.failure");
      assert.deepEqual(failures.map((item) => [item.payload.terminal, item.payload.message]), message ? [[true, message]] : [], name);
      assert.equal(result.stdout.includes("late"), false, `${name}: nothing after the break is forwarded`);
    });
  }
});

test("the direct runner stops reading the API while its consumer is stalled", async () => {
  // Pipes are synchronous on Linux and Windows, so only asynchronous stdout
  // can buffer; either way the stalled consumer must hold the API stream back.
  const event = `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x".repeat(60 * 1024) } })}\n\n`;
  const events = 512;
  let flushed = false;
  await withApiFixture((response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    let index = 0;
    response.write(`${messageStart}${blockStart()}`);
    const pump = () => {
      while (index < events) { index += 1; if (!response.write(event)) { response.once("drain", pump); return; } }
      response.end(`${blockStop()}` + 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\ndata: {"type":"message_stop"}\n\n', () => { flushed = true; });
    };
    pump();
  }, async (base) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./execution-adapters/anthropic-api-runner.mjs", import.meta.url)), "--model", "m", "--", "hi"],
      { env: { PATH: process.env.PATH, OUTRIGHT_ANTHROPIC_API_KEY: fixtureKey, OUTRIGHT_ANTHROPIC_BASE_URL: base }, stdio: ["ignore", "pipe", "ignore"] });
    const closed = new Promise((resolve) => child.on("close", resolve));
    let bytes = 0;
    child.stdout.pause();
    try {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      // Without waiting for drain the runner read all 30 MiB into its own memory.
      assert.equal(flushed, false, "the API stream is held back while stdout is full");
      child.stdout.on("data", (chunk) => { bytes += chunk.length; });
      child.stdout.resume();
      assert.equal(await closed, 0);
    } finally {
      // A failed assertion must not leave the runner blocked on its pipe and
      // the fixture server open.
      if (child.exitCode === null && child.signalCode === null) { child.stdout.resume(); child.kill(); await closed; }
    }
    assert.equal(flushed, true);
    assert.ok(bytes > events * 60 * 1024, "every event was delivered once the consumer resumed");
  });
});

test("an unusable direct-provider endpoint is reported as unavailable", async () => {
  for (const base of ["invalid-url", "http://example.com", "ftp://api.anthropic.com"]) {
    const discovery = createProviderDiscovery({ environment: { OUTRIGHT_ANTHROPIC_API_KEY: fixtureKey, OUTRIGHT_ANTHROPIC_BASE_URL: base }, probe: async () => { throw new Error("missing"); } });
    try {
      // Before, only the key was checked, so the run was queued and failed at launch.
      assert.equal(await discovery.available("anthropic-api"), false, base);
      assert.match(discovery.list().find((entry) => entry.id === "anthropic-api").reason, /OUTRIGHT_ANTHROPIC_BASE_URL must be an https URL or a loopback http address/);
    } finally { await discovery.close(); }
  }
  for (const base of ["https://gateway.example/anthropic", "http://127.0.0.1:8080"]) {
    assert.equal(anthropic.detect({ OUTRIGHT_ANTHROPIC_API_KEY: fixtureKey, OUTRIGHT_ANTHROPIC_BASE_URL: base }).available, true, base);
  }
});

test("an endpoint carrying a user name or password is refused before queueing and never echoed", async () => {
  await withApiFixture((response) => { response.writeHead(200, { "content-type": "text/event-stream" }); response.end(fixture("anthropic-api", "stream.sse")); }, async (origin, requests) => {
    const { port } = new URL(origin);
    for (const base of [`http://user:fixture-password@127.0.0.1:${port}/anthropic`, `https://fixture-password@api.anthropic.com`]) {
      // Before, detect() accepted it and fetch rejected it after the run was
      // queued, with an error that quoted the URL and its password.
      const status = anthropic.detect({ OUTRIGHT_ANTHROPIC_API_KEY: fixtureKey, OUTRIGHT_ANTHROPIC_BASE_URL: base });
      assert.equal(status.available, false, base);
      assert.match(status.reason, /without a user name or password/);
      assert.equal(status.reason.includes("fixture-password"), false);
      const result = await runRunner(["--model", "m", "--", "hi"], { OUTRIGHT_ANTHROPIC_API_KEY: fixtureKey, OUTRIGHT_ANTHROPIC_BASE_URL: base });
      assert.equal(result.code, 2);
      assert.equal(result.stdout.includes("fixture-password"), false, "the failure persisted as a run event is free of the secret");
    }
    assert.equal(requests.length, 0);
  });
});

test("a path-prefixed gateway base receives the request under its own path", async () => {
  await withApiFixture((response) => { response.writeHead(200, { "content-type": "text/event-stream" }); response.end(fixture("anthropic-api", "stream.sse")); }, async (origin, requests) => {
    for (const suffix of ["/anthropic", "/anthropic/", "/team/anthropic"]) {
      const result = await runRunner(["--model", "claude-opus-5-5", "--", "hi"], { OUTRIGHT_ANTHROPIC_API_KEY: fixtureKey, OUTRIGHT_ANTHROPIC_BASE_URL: `${origin}${suffix}` });
      assert.equal(result.code, 0, suffix);
      // Before, the leading-slash resolution sent the key to /v1/messages at the origin root.
      assert.equal(requests.at(-1).url, `${suffix.replace(/\/$/, "")}/v1/messages`, suffix);
    }
    await runRunner(["--model", "claude-opus-5-5", "--", "hi"], { OUTRIGHT_ANTHROPIC_API_KEY: fixtureKey, OUTRIGHT_ANTHROPIC_BASE_URL: origin });
    assert.equal(requests.at(-1).url, "/v1/messages", "a bare origin keeps the documented path");
  });
});

test("discovery reports incompatible and unconfigured providers before authorization", async () => {
  const probed = [];
  const versions = { codex: "codex-cli 0.20.0", claude: "2.1.296 (Claude Code)" };
  const discovery = createProviderDiscovery({ environment: { ANTHROPIC_API_KEY: "harness-key" }, probe: async (executable) => { probed.push(executable); return versions[executable]; } });
  try {
    assert.equal(await discovery.available("codex"), false, "an installed but unsupported CLI is not authorized");
    assert.equal(await discovery.available("claude"), true);
    assert.equal(await discovery.available("anthropic-api"), false, "a Claude Code login or key does not grant direct API access");
    const byId = Object.fromEntries(discovery.list().map((entry) => [entry.id, entry]));
    assert.deepEqual([byId.codex.available, byId.codex.compatible, byId.codex.version], [true, false, "0.20.0"]);
    assert.match(byId.codex.reason, /0\.20\.0 is not supported/);
    assert.deepEqual([byId.claude.compatible, byId.claude.capabilities.resume], [true, true]);
    assert.match(byId["anthropic-api"].reason, /OUTRIGHT_ANTHROPIC_API_KEY/);
    assert.equal(probed.includes("anthropic-api"), false, "a direct provider is never probed as a CLI");
  } finally { await discovery.close(); }
  const configured = createProviderDiscovery({ environment: { OUTRIGHT_ANTHROPIC_API_KEY: fixtureKey }, probe: async () => { throw new Error("missing"); } });
  try {
    assert.equal(await configured.available("anthropic-api"), true);
    assert.equal(configured.list().find((entry) => entry.id === "anthropic-api").version, "1.0.0");
  } finally { await configured.close(); }
});

test("Claude Code usage windows normalize from the recorded stream and drop malformed values", () => {
  const windows = normalizeFixture(claude, "print.jsonl").filter((event) => event.type === "rate_limit").map((event) => event.payload.windows);
  // Before, the record stayed an opaque provider.event and no limit was kept.
  assert.ok(windows.length > 0);
  assert.deepEqual(windows[0], [{ window: "five_hour", utilization: 0.86, resetsAt: new Date(1791650400 * 1000).toISOString(), status: "allowed" }]);
  const [malformed] = claude.normalize({ type: "rate_limit_event", rate_limit_info: { status: "Allowed!", rateLimitType: "five_hour", resetsAt: "soon",
    unifiedWindows: { five_hour: { utilization: -1, resetsAt: 1791650400 }, "seven day": { utilization: 0.5 }, seven_day_opus: { utilization: 0.4, resetsAt: Infinity } } } });
  assert.deepEqual(malformed.payload.windows, [
    { window: "five_hour", utilization: null, resetsAt: new Date(1791650400 * 1000).toISOString(), status: null },
    { window: "seven_day_opus", utilization: 0.4, resetsAt: null, status: null },
  ]);
  assert.deepEqual(claude.normalize({ type: "rate_limit_event", rate_limit_info: { rateLimitType: "../x" } }).map((event) => event.type), ["provider.event"]);
  assert.equal(describeAdapter(claude).capabilities.usageLimits, true);
  assert.equal(describeAdapter(codex).capabilities.usageLimits, false);
});

test("harness logins are read from each CLI's status without credentials", () => {
  const parseClaude = claude.accounts.parseIdentity;
  assert.deepEqual(parseClaude(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "a@example.com", orgName: "Org\u0007", subscriptionType: "max", configDirectory: "/x" })),
    { signedIn: true, ownLogin: true, method: "claude.ai", email: "a@example.com", organization: "Org", plan: "max" });
  assert.equal(parseClaude(JSON.stringify({ loggedIn: false, authMethod: "none" })).signedIn, false);
  // Claude Code 2.1.303 with an empty CLAUDE_CONFIG_DIR and only dummy
  // federation selectors, an inherited key or a helper: signed in, but not
  // by a login stored in that directory.
  for (const status of [{ authMethod: "oauth_token" }, { authMethod: "api_key", apiKeySource: "ANTHROPIC_API_KEY" }, { authMethod: "api_key_helper" }, { authMethod: "third_party" }]) {
    assert.deepEqual([parseClaude(JSON.stringify({ loggedIn: true, apiProvider: "firstParty", ...status })).signedIn, parseClaude(JSON.stringify({ loggedIn: true, ...status })).ownLogin], [true, false], JSON.stringify(status));
  }
  assert.equal(parseClaude(JSON.stringify({ loggedIn: true, authMethod: "api_key", apiKeySource: "/login managed key" })).ownLogin, true);
  assert.equal(parseClaude("not json"), null);
  assert.equal(parseClaude(JSON.stringify({ loggedIn: "yes" })), null);
  const parseCodex = codex.accounts.parseIdentity;
  assert.deepEqual(parseCodex("Logged in using ChatGPT\n"), { signedIn: true, ownLogin: true, method: "chatgpt", email: null, organization: null, plan: null });
  assert.doesNotMatch(JSON.stringify(parseCodex("Logged in using an API key - sk-proj-***ABCD")), /sk-/);
  assert.equal(parseCodex("Not logged in").signedIn, false);
  assert.equal(parseCodex("Something else"), null);
  assert.deepEqual([claude.accounts.homeVariable, codex.accounts.homeVariable, anthropic.accounts], ["CLAUDE_CONFIG_DIR", "CODEX_HOME", null]);
  assert.deepEqual([claude.accounts.standardHome, codex.accounts.standardHome], [".claude", ".codex"]);
  const accounts = { homeVariable: "FIXTURE_HOME", standardHome: ".fixture", identityArgs: ["status"], parseIdentity: () => null, credentialVariables: ["FIXTURE_*", "OTHER_TOKEN"],
    nonCredentialVariables: ["FIXTURE_MODEL", "FIXTURE_USE_TOOL"], credentialSwitches: ["FIXTURE_USE_*"], inertCredentials: ["FIXTURE_IGNORED"],
    unreportedCredentials: ["FIXTURE_TOKEN", "FIXTURE_IGNORED", "FIXTURE_MODEL"] };
  const fixture = defineAdapter(harnessSpec({ accounts })).accounts;
  assert.equal(fixture.homeVariable, "FIXTURE_HOME");
  assert.throws(() => defineAdapter(harnessSpec({ accounts: { ...accounts, homeVariable: "OUTRIGHT_HOME" } })), /accounts must name/);
  assert.throws(() => defineAdapter(harnessSpec({ accounts: { ...accounts, identityArgs: ["status; rm"] } })), /accounts must name/);
  // The standard home is one directory inside the user's home, never a path out of it.
  for (const standardHome of [undefined, "../.fixture", "/etc", "a/b"]) {
    assert.throws(() => defineAdapter(harnessSpec({ accounts: { ...accounts, standardHome } })), /accounts must name/, standardHome);
  }
  for (const credentialVariables of [undefined, [], ["OUTRIGHT_*"], ["fixture_*"], ["FIXTURE_(.*)"]]) {
    assert.throws(() => defineAdapter(harnessSpec({ accounts: { ...accounts, credentialVariables } })), /accounts must name/, String(credentialVariables));
  }
  for (const field of ["nonCredentialVariables", "credentialSwitches", "inertCredentials", "unreportedCredentials"]) {
    assert.throws(() => defineAdapter(harnessSpec({ accounts: { ...accounts, [field]: undefined } })), /accounts must name/, field);
  }
  // A source is any name its rules match, except the home variable and the
  // non-credential exceptions; an inert one never stands in for the login.
  assert.deepEqual(["FIXTURE_TOKEN", "FIXTURE_NEW_SOURCE", "OTHER_TOKEN", "FIXTURE_HOME", "FIXTURE_MODEL", "OTHER_TOKENS", "FIXTURE_IGNORED"].map(fixture.isCredential),
    [true, true, true, false, false, false, true]);
  assert.deepEqual([fixture.overridesLogin("FIXTURE_IGNORED"), fixture.overridesLogin("FIXTURE_TOKEN")], [false, true]);
  assert.deepEqual(["FIXTURE_USE_CLOUD", "FIXTURE_USE_TOOL", "FIXTURE_TOKEN"].map(fixture.isCredentialSwitch), [true, false, false]);
  // Only a source that stands in for the login can count as one unchecked.
  assert.deepEqual(["FIXTURE_TOKEN", "FIXTURE_NEW_SOURCE", "FIXTURE_IGNORED", "FIXTURE_MODEL"].map(fixture.isUnreported), [true, false, false, false]);
  // Claude Code 2.1.303's own sources, including those it reads for
  // profiles, federation and gateways; model and tool choices are not.
  const claudeSources = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_PROFILE", "ANTHROPIC_FEDERATION_RULE_ID", "ANTHROPIC_ORGANIZATION_ID",
    "ANTHROPIC_IDENTITY_TOKEN", "ANTHROPIC_IDENTITY_TOKEN_FILE", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
    "CLAUDE_CODE_GATEWAY_TOKEN", "CLAUDE_CODE_SESSION_ACCESS_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_GATEWAY"];
  assert.deepEqual(claudeSources.filter((name) => !claude.accounts.overridesLogin(name)), []);
  assert.deepEqual(["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "CLAUDE_CODE_USE_POWERSHELL_TOOL", "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CONFIG_DIR"]
    .filter(claude.accounts.isCredential), []);
  assert.deepEqual(["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_MANTLE", "CLAUDE_CODE_USE_NATIVE_FILE_SEARCH", "ANTHROPIC_API_KEY"].map(claude.accounts.isCredentialSwitch), [true, true, false, false]);
  // Codex: OPENAI_API_KEY is a source an added account runs without, but
  // Codex never signs in with it in place of its login.
  assert.deepEqual(["CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_FEDERATION_RULE_ID", "OPENAI_IDENTITY_TOKEN_FILE", "OPENAI_API_KEY", "CODEX_HOME", "CODEX_SANDBOX"]
    .map(codex.accounts.isCredential), [true, true, true, true, true, false, false]);
  assert.deepEqual([codex.accounts.overridesLogin("OPENAI_API_KEY"), codex.accounts.overridesLogin("CODEX_ACCESS_TOKEN")], [false, true]);
  // Claude Code's status command reports every source that signs it in;
  // `codex login status` reports neither of Codex's keys from the environment.
  assert.deepEqual(claudeSources.filter(claude.accounts.isUnreported), []);
  assert.deepEqual(["CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_BASE_URL", "OPENAI_FEDERATION_RULE_ID"].map(codex.accounts.isUnreported), [true, true, false, false]);
});

test("an account's home reaches only its own launch, and only under its own variable", () => {
  const inherited = { PATH: "/bin", claude_config_dir: "/inherited", OUTRIGHT_ANTHROPIC_API_KEY: "direct" };
  // The default account keeps whatever home the environment selects.
  assert.equal(buildExecutionEnvironment("claude", inherited).claude_config_dir, "/inherited");
  const scoped = buildExecutionEnvironment("claude", inherited, inherited, { homePath: "/accounts/work" });
  assert.equal(scoped.CLAUDE_CONFIG_DIR, "/accounts/work");
  assert.equal(Object.keys(scoped).filter((key) => key.toUpperCase() === "CLAUDE_CONFIG_DIR").length, 1, "no second spelling survives");
  assert.equal(scoped.OUTRIGHT_ANTHROPIC_API_KEY, undefined);
  assert.equal(buildExecutionEnvironment("codex", inherited, inherited, { homePath: "/accounts/codex" }).CODEX_HOME, "/accounts/codex");
  // A credential variable would make the CLI ignore the account's login. It
  // stays with the default login and never reaches an added account.
  const credentials = { PATH: "/bin", ANTHROPIC_API_KEY: "env-key", claude_code_oauth_token: "env-token", CLAUDE_CODE_USE_BEDROCK: "1", CODEX_API_KEY: "codex-key", OPENAI_API_KEY: "openai-key" };
  assert.equal(buildExecutionEnvironment("claude", credentials).ANTHROPIC_API_KEY, "env-key");
  assert.deepEqual(Object.keys(buildExecutionEnvironment("claude", credentials, credentials, { homePath: "/accounts/work" })).sort(), ["CLAUDE_CONFIG_DIR", "CODEX_API_KEY", "OPENAI_API_KEY", "PATH"]);
  assert.deepEqual(Object.keys(buildExecutionEnvironment("codex", credentials, credentials, { homePath: "/accounts/codex" })).sort(),
    ["ANTHROPIC_API_KEY", "CLAUDE_CODE_USE_BEDROCK", "CODEX_HOME", "PATH", "claude_code_oauth_token"]);
  // Profiles, federation and identity tokens are sources too; a model or
  // tool choice is not.
  const sources = { PATH: "/bin", ANTHROPIC_PROFILE: "work", ANTHROPIC_FEDERATION_RULE_ID: "rule", ANTHROPIC_ORGANIZATION_ID: "org", ANTHROPIC_IDENTITY_TOKEN: "jwt",
    ANTHROPIC_IDENTITY_TOKEN_FILE: "/t", ANTHROPIC_MODEL: "opus", CLAUDE_CODE_USE_POWERSHELL_TOOL: "1", CODEX_ACCESS_TOKEN: "token", OPENAI_FEDERATION_RULE_ID: "rule",
    OPENAI_IDENTITY_TOKEN_FILE: "/t" };
  assert.deepEqual(Object.keys(buildExecutionEnvironment("claude", sources, sources, { homePath: "/accounts/work" })).sort(),
    ["ANTHROPIC_MODEL", "CLAUDE_CODE_USE_POWERSHELL_TOOL", "CLAUDE_CONFIG_DIR", "CODEX_ACCESS_TOKEN", "OPENAI_FEDERATION_RULE_ID", "OPENAI_IDENTITY_TOKEN_FILE", "PATH"]);
  assert.deepEqual(Object.keys(buildExecutionEnvironment("codex", sources, sources, { homePath: "/accounts/codex" })).filter((name) => /^(CODEX|OPENAI)_/.test(name)), ["CODEX_HOME"]);
  assert.throws(() => buildExecutionEnvironment("anthropic-api", inherited, inherited, { homePath: "/accounts/x" }), /no selectable accounts/);
});
