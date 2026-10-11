import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ADAPTER_CONTRACT_VERSION, defineAdapter, NORMALIZED_EVENT_TYPES, validateRunConfiguration } from "./execution-adapters/contract.mjs";
import { buildExecutionLaunch, describeAdapter, EXECUTION_ADAPTERS, findExecutionAdapter, validateExecutionConfiguration, versionCompatibility } from "./execution-adapters/index.mjs";
import { createProviderDiscovery } from "./provider-discovery.mjs";

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
});

function runRunner(args, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./execution-adapters/anthropic-api-runner.mjs", import.meta.url)), ...args],
      { env: { PATH: process.env.PATH, ...environment }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, events: normalized(anthropic, stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line))) }));
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
  // A delta type Outright does not consume stays ignored for forward compatibility.
  assert.deepEqual(anthropic.normalize({ type: "content_block_delta", index: 0, delta: { type: "future_delta", value: 1 } }), []);
  assert.equal(anthropic.normalize({ type: "content_block_delta", index: 0 })[0].type, "provider.failure");
});

test("a reflected API key never leaves the runner in provider error text", async () => {
  const secret = "sk-ant-reflected/fixture+key";
  const reflected = `invalid x-api-key ${secret}`;
  const sseError = `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: reflected, echoed: secret } })}\n\n`;
  for (const respond of [
    (response) => { response.writeHead(401, { "content-type": "application/json" }); response.end(JSON.stringify({ type: "error", error: { type: `authentication_error ${secret}`, message: reflected } })); },
    (response) => { response.writeHead(200, { "content-type": "text/event-stream" }); response.end(sseError); },
  ]) {
    await withApiFixture(respond, async (base) => {
      const result = await runRunner(["--model", "claude-opus-5-5", "--", "hi"], { OUTRIGHT_ANTHROPIC_API_KEY: secret, OUTRIGHT_ANTHROPIC_BASE_URL: base });
      // Before, the gateway's message reached stdout, run events and the run error verbatim.
      assert.equal(result.code, 1);
      assert.equal(result.stdout.includes(secret) || result.stdout.includes(JSON.stringify(secret).slice(1, -1)), false, "the key is never echoed");
      const failure = result.events.at(-1);
      assert.deepEqual([failure.type, failure.payload.terminal, failure.payload.message], ["provider.failure", true, "invalid x-api-key [redacted]"]);
    });
  }
});

test("a message that ends without a valid stop reason fails and keeps its text and usage", async () => {
  const text = (result) => result.events.filter((event) => event.type === "assistant.delta").map((event) => event.payload.text).join("");
  const withoutReason = fixture("anthropic-api", "missing-stop-reason.sse");
  for (const [name, body] of [["missing", withoutReason], ["numeric", withoutReason.replace('"delta":{"stop_sequence":null}', '"delta":{"stop_reason":7}')]]) {
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
  // A stream with no message_delta at all reaches message_stop without any stop reason.
  const noDelta = withoutReason.replace(/event: message_delta\n.*\n\n/, "");
  await withApiFixture((response) => { response.writeHead(200, { "content-type": "text/event-stream" }); response.end(noDelta); }, async (base) => {
    const result = await runRunner(["--model", "claude-opus-5-5", "--", "hi"], { OUTRIGHT_ANTHROPIC_API_KEY: fixtureKey, OUTRIGHT_ANTHROPIC_BASE_URL: base });
    assert.deepEqual([result.code, text(result), result.events.at(-1).payload.message], [1, "READY now", "Anthropic API stream ended without a stop reason; the answer may be incomplete"]);
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

test("a malformed stream event fails the run and keeps the text already streamed", async () => {
  const delta = (text) => `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n`;
  for (const broken of ["data: {broken-json}\n\n", "data: [1]\n\n"]) {
    await withApiFixture((response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`${delta("partial")}${broken}${delta(" lost")}data: {"type":"message_stop"}\n\n`);
    }, async (base) => {
      const result = await runRunner(["--model", "claude-opus-5-5", "--", "hi"], { OUTRIGHT_ANTHROPIC_API_KEY: fixtureKey, OUTRIGHT_ANTHROPIC_BASE_URL: base });
      // Before, the event was dropped and message_stop completed the run.
      assert.equal(result.code, 1, broken);
      assert.deepEqual(result.events.map((event) => [event.type, event.payload.text ?? event.payload.message]),
        [["assistant.delta", "partial"], ["provider.failure", "Anthropic API sent a malformed stream event"]]);
      assert.equal(result.events.at(-1).payload.terminal, true);
    });
  }
});

test("the direct runner stops reading the API while its consumer is stalled", { skip: process.platform === "win32" }, async () => {
  // Pipes are synchronous on Linux, so only asynchronous stdout can buffer.
  const event = `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x".repeat(60 * 1024) } })}\n\n`;
  const events = 512;
  let flushed = false;
  await withApiFixture((response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    let index = 0;
    const pump = () => {
      while (index < events) { index += 1; if (!response.write(event)) { response.once("drain", pump); return; } }
      response.end('data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\ndata: {"type":"message_stop"}\n\n', () => { flushed = true; });
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
