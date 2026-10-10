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
  assert.match(old.reason, /Codex 0\.20\.0 is not supported; Outright supports 0\.145\.0 or newer below 1\.0\.0/);
  assert.equal(versionCompatibility(claude, claude.parseVersion("3.0.0 (Claude Code)")).compatible, false, "an unverified major is incompatible");
  assert.match(versionCompatibility(codex, codex.parseVersion("codex development build")).reason, /unrecognized version/);
});

test("unsupported configurations are rejected instead of falling back", () => {
  // Before adapters, an unknown policy silently became workspace-write.
  assert.throws(() => validateExecutionConfiguration({ provider: "codex", ...baseRun, approvalPolicy: "bypass" }),
    { code: "PROVIDER_CONFIGURATION_UNSUPPORTED", statusCode: 409 });
  assert.throws(() => validateExecutionConfiguration({ provider: "anthropic-api", ...baseRun, approvalPolicy: "workspace-write" }),
    { code: "PROVIDER_CONFIGURATION_UNSUPPORTED", message: /Anthropic API does not support the workspace-write approval policy/ });
  assert.throws(() => validateExecutionConfiguration({ provider: "anthropic-api", ...baseRun, reasoningEffort: "high" }),
    { code: "PROVIDER_CONFIGURATION_UNSUPPORTED" });
  assert.throws(() => validateExecutionConfiguration({ provider: "codex", ...baseRun, reasoningEffort: undefined }),
    { code: "PROVIDER_CONFIGURATION_UNSUPPORTED" }, "an invalid effort used to be dropped silently");
  assert.throws(() => validateExecutionConfiguration({ provider: "hermes", ...baseRun }), { code: "PROVIDER_UNKNOWN", statusCode: 400 });
  assert.throws(() => validateExecutionConfiguration({ provider: "anthropic-api", ...baseRun, sessionId: "a1d55507-d4ad-43ef-8154-19b111bbed42" }),
    { code: "PROVIDER_RESUME_UNSUPPORTED" });
  assert.doesNotThrow(() => validateRunConfiguration(codex, { ...baseRun, model: "gpt-6.1-sol" }), "harness CLIs accept custom model names");
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
    const result = await runRunner(["--model", "claude-opus-5-5", "--", "hi"], { OUTRIGHT_ANTHROPIC_API_KEY: "k", OUTRIGHT_ANTHROPIC_BASE_URL: base });
    assert.equal(result.code, 1);
    assert.equal(result.events.at(-1).payload.message, "Overloaded");
  });
  // A key is never sent over plaintext to a non-local host, and no CLI login is consulted.
  const insecure = await runRunner(["--model", "m", "--", "hi"], { OUTRIGHT_ANTHROPIC_API_KEY: "k", OUTRIGHT_ANTHROPIC_BASE_URL: "http://example.com" });
  assert.equal(insecure.code, 2);
  assert.match(insecure.events[0].payload.message, /must be an https URL/);
  // A harness's own Anthropic credential is never borrowed by the direct provider.
  const missing = await runRunner(["--model", "m", "--", "hi"], { ANTHROPIC_API_KEY: "harness-key" });
  assert.equal(missing.code, 2);
  assert.match(missing.events[0].payload.message, /OUTRIGHT_ANTHROPIC_API_KEY is not set/);
});

test("an Anthropic answer cut off at the output cap fails visibly and keeps its text", async () => {
  await withApiFixture((response) => { response.writeHead(200, { "content-type": "text/event-stream" }); response.end(fixture("anthropic-api", "max-tokens.sse")); }, async (base, requests) => {
    const result = await runRunner(["--model", "claude-opus-5-5", "--", "hi"], { OUTRIGHT_ANTHROPIC_API_KEY: "k", OUTRIGHT_ANTHROPIC_BASE_URL: base });
    assert.equal(requests[0].body.max_tokens, 8192, "the declared cap is the one requested");
    assert.equal(result.events.filter((event) => event.type === "assistant.delta").map((event) => event.payload.text).join(""), "READY now");
    // Before, a max_tokens stop normalized to usage only and the run completed.
    const failure = result.events.find((event) => event.type === "provider.failure");
    assert.deepEqual([failure?.payload.terminal, failure?.payload.native], [true, { stop_reason: "max_tokens" }]);
    assert.match(failure.payload.message, /8192-token output limit; the answer is truncated/);
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

test("one stream event is bounded across chunks and data lines", async () => {
  // Each data line is small and the event never reaches a blank-line dispatch.
  const line = `data: ${"x".repeat(64 * 1024)}\n`;
  for (const lines of [24, 40]) {
    await withApiFixture((response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (let index = 0; index < lines; index += 1) response.write(line);
      response.end("\n");
    }, async (base) => {
      const result = await runRunner(["--model", "claude-opus-5-5", "--", "hi"], { OUTRIGHT_ANTHROPIC_API_KEY: "k", OUTRIGHT_ANTHROPIC_BASE_URL: base });
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
      const result = await runRunner(["--model", "claude-opus-5-5", "--", "hi"], { OUTRIGHT_ANTHROPIC_API_KEY: "k", OUTRIGHT_ANTHROPIC_BASE_URL: base });
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
      response.end('data: {"type":"message_stop"}\n\n', () => { flushed = true; });
    };
    pump();
  }, async (base) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./execution-adapters/anthropic-api-runner.mjs", import.meta.url)), "--model", "m", "--", "hi"],
      { env: { PATH: process.env.PATH, OUTRIGHT_ANTHROPIC_API_KEY: "k", OUTRIGHT_ANTHROPIC_BASE_URL: base }, stdio: ["ignore", "pipe", "ignore"] });
    child.stdout.pause();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    // Without waiting for drain the runner read all 30 MiB into its own memory.
    assert.equal(flushed, false, "the API stream is held back while stdout is full");
    let bytes = 0;
    const closed = new Promise((resolve) => child.on("close", resolve));
    child.stdout.on("data", (chunk) => { bytes += chunk.length; });
    child.stdout.resume();
    const code = await closed;
    assert.equal(code, 0);
    assert.equal(flushed, true);
    assert.ok(bytes > events * 60 * 1024, "every event was delivered once the consumer resumed");
  });
});

test("an unusable direct-provider endpoint is reported as unavailable", async () => {
  for (const base of ["invalid-url", "http://example.com", "ftp://api.anthropic.com"]) {
    const discovery = createProviderDiscovery({ environment: { OUTRIGHT_ANTHROPIC_API_KEY: "k", OUTRIGHT_ANTHROPIC_BASE_URL: base }, probe: async () => { throw new Error("missing"); } });
    try {
      // Before, only the key was checked, so the run was queued and failed at launch.
      assert.equal(await discovery.available("anthropic-api"), false, base);
      assert.match(discovery.list().find((entry) => entry.id === "anthropic-api").reason, /OUTRIGHT_ANTHROPIC_BASE_URL must be an https URL or a loopback http address/);
    } finally { await discovery.close(); }
  }
  for (const base of ["https://gateway.example/anthropic", "http://127.0.0.1:8080"]) {
    assert.equal(anthropic.detect({ OUTRIGHT_ANTHROPIC_API_KEY: "k", OUTRIGHT_ANTHROPIC_BASE_URL: base }).available, true, base);
  }
});

test("a path-prefixed gateway base receives the request under its own path", async () => {
  await withApiFixture((response) => { response.writeHead(200, { "content-type": "text/event-stream" }); response.end(fixture("anthropic-api", "stream.sse")); }, async (origin, requests) => {
    for (const suffix of ["/anthropic", "/anthropic/", "/team/anthropic"]) {
      const result = await runRunner(["--model", "claude-opus-5-5", "--", "hi"], { OUTRIGHT_ANTHROPIC_API_KEY: "k", OUTRIGHT_ANTHROPIC_BASE_URL: `${origin}${suffix}` });
      assert.equal(result.code, 0, suffix);
      // Before, the leading-slash resolution sent the key to /v1/messages at the origin root.
      assert.equal(requests.at(-1).url, `${suffix.replace(/\/$/, "")}/v1/messages`, suffix);
    }
    await runRunner(["--model", "claude-opus-5-5", "--", "hi"], { OUTRIGHT_ANTHROPIC_API_KEY: "k", OUTRIGHT_ANTHROPIC_BASE_URL: origin });
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
  const configured = createProviderDiscovery({ environment: { OUTRIGHT_ANTHROPIC_API_KEY: "k" }, probe: async () => { throw new Error("missing"); } });
  try {
    assert.equal(await configured.available("anthropic-api"), true);
    assert.equal(configured.list().find((entry) => entry.id === "anthropic-api").version, "1.0.0");
  } finally { await configured.close(); }
});
