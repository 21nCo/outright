import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertRuntimeRequest, createOutrightRuntime, runtimeAllowedHosts } from "./outright-runtime.mjs";

function request(host, origin) {
  return { headers: { host, ...(origin ? { origin } : {}) } };
}

function requestStream(method, url, body) {
  const stream = new Readable({ read() {} });
  stream.method = method;
  stream.url = url;
  stream.headers = { host: "localhost:4173" };
  if (body != null) stream.push(JSON.stringify(body));
  stream.push(null);
  return stream;
}

function responseCapture() {
  return {
    statusCode: null,
    setHeader(key, value) { (this.headers ??= {})[key] = value; },
    end(payload) { this.body = payload ? JSON.parse(payload) : null; },
  };
}

function withRuntime(fn, options = {}) {
  return async () => {
    const dataDirectory = mkdtempSync(path.join(os.tmpdir(), "outright-test-"));
    process.env.OUTRIGHT_DATA_DIR = dataDirectory;
    const runtime = createOutrightRuntime({ configUrl: "file:///nonexistent-config.json", ...options });
    try {
      // The runtime wires its own database, manager, and event hub, so the
      // recovery endpoint is exercised exactly as in production.
      await fn(runtime);
    } finally {
      await runtime.shutdown();
      delete process.env.OUTRIGHT_DATA_DIR;
      rmSync(dataDirectory, { recursive: true, force: true });
    }
  };
}

test("reconciles runs at startup and resolves discard decisions through the API", withRuntime(async (runtime) => {
  const conversation = runtime.database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Recovery", provider: "codex" });
  const run = runtime.database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "half done" });
  runtime.database.reconcileInterruptedRuns({ probeAlive: () => false });
  assert.equal(runtime.database.getRun(run.id).status, "interrupted");

  const response = responseCapture();
  assert.equal(await runtime.handleRequest(requestStream("POST", `/api/runs/${run.id}/resume`, { policy: "discard" }), response), true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "failed");
  assert.equal(response.body.recoveryDecision, "discard");

  const repeat = responseCapture();
  await runtime.handleRequest(requestStream("POST", `/api/runs/${run.id}/resume`, { policy: "discard" }), repeat);
  assert.equal(repeat.statusCode, 409, "decisions are final");
}));

test("rejects a malformed recovery policy with 400", withRuntime(async (runtime) => {
  const conversation = runtime.database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Recovery", provider: "codex" });
  const run = runtime.database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "half done" });
  runtime.database.reconcileInterruptedRuns();
  const response = responseCapture();
  await runtime.handleRequest(requestStream("POST", `/api/runs/${run.id}/resume`, { policy: "guess" }), response);
  assert.equal(response.statusCode, 400);
}));

test("blocks direct run submission until the interrupted run has a recovery decision", withRuntime(async (runtime) => {
  const conversation = runtime.database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Recovery", provider: "codex" });
  const run = runtime.database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "half done" });
  runtime.database.reconcileInterruptedRuns();

  const blocked = responseCapture();
  await runtime.handleRequest(requestStream("POST", `/api/conversations/${conversation.id}/runs`, { prompt: "silently resume" }), blocked);
  assert.equal(blocked.statusCode, 409);
  assert.equal(blocked.body.code, "RUN_RECOVERY_REQUIRED");
  assert.equal(blocked.body.runId, run.id);

  const discarded = responseCapture();
  await runtime.handleRequest(requestStream("POST", `/api/runs/${run.id}/resume`, { policy: "discard" }), discarded);
  assert.equal(discarded.statusCode, 200);
  assert.equal(runtime.database.findUnresolvedInterruptedRun(conversation.id), undefined);
}));

test("does not resolve an alive recovered provider while it can still mutate the worktree", withRuntime(async (runtime) => {
  const conversation = runtime.database.createConversation({ projectId: "project-1", worktreeId: "tree-1", worktreePath: "/tmp/tree-1", title: "Recovery", provider: "codex" });
  const run = runtime.database.createRun({ conversationId: conversation.id, provider: "codex", approvalPolicy: "read-only", prompt: "half done" });
  runtime.database.updateRun(run.id, { status: "running", pid: 4242 });
  runtime.database.reconcileInterruptedRuns({ probeAlive: () => true });

  const response = responseCapture();
  await runtime.handleRequest(requestStream("POST", `/api/runs/${run.id}/resume`, { policy: "discard" }), response);
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.code, "RECOVERY_PROCESS_ACTIVE");
  assert.equal(runtime.database.getRun(run.id).recoveryDecision, null);
}, { recoveryProcessAlive: () => true }));

test("accepts loopback and same-origin runtime requests", () => {
  const allowedHosts = runtimeAllowedHosts({});
  assert.doesNotThrow(() => assertRuntimeRequest(request("127.0.0.1:4173", "http://127.0.0.1:4173"), allowedHosts));
  assert.doesNotThrow(() => assertRuntimeRequest(request("localhost:4173"), allowedHosts));
  assert.doesNotThrow(() => assertRuntimeRequest(request("[::1]:4173", "http://[::1]:4173"), allowedHosts));
  assert.doesNotThrow(() => assertRuntimeRequest(request("terminal.local:4173", "http://terminal.local:4173"), allowedHosts));
});

test("rejects hostile Host headers before trusting a matching Origin", () => {
  const allowedHosts = runtimeAllowedHosts({});
  assert.throws(
    () => assertRuntimeRequest(request("attacker.example", "http://attacker.example"), allowedHosts),
    (error) => error.statusCode === 403 && /host is not allowed/i.test(error.message),
  );
  assert.throws(
    () => assertRuntimeRequest(request("127.0.0.1:4173", "http://attacker.example"), allowedHosts),
    (error) => error.statusCode === 403 && /cross-origin/i.test(error.message),
  );
});

test("allows an explicitly configured runtime hostname", () => {
  const allowedHosts = runtimeAllowedHosts({ OUTRIGHT_ALLOWED_HOSTS: "outright.internal" });
  assert.doesNotThrow(() => assertRuntimeRequest(request("outright.internal:4173", "http://outright.internal:4173"), allowedHosts));
});

test("rejects non-loopback sockets even with an allowed Host header", () => {
  const allowedHosts = runtimeAllowedHosts({});
  assert.throws(
    () => assertRuntimeRequest({ headers: { host: "localhost:4173" }, socket: { remoteAddress: "192.168.1.20" } }, allowedHosts),
    (error) => error.statusCode === 403 && /loopback/i.test(error.message),
  );
  assert.doesNotThrow(() => assertRuntimeRequest({ headers: { host: "localhost:4173" }, socket: { remoteAddress: "127.0.0.1" } }, allowedHosts));
  assert.doesNotThrow(() => assertRuntimeRequest({ headers: { host: "localhost:4173" }, socket: { remoteAddress: "::1" } }, allowedHosts));
  assert.doesNotThrow(() => assertRuntimeRequest({ headers: { host: "localhost:4173" }, socket: { remoteAddress: "::ffff:127.0.0.1" } }, allowedHosts));
});
