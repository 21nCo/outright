import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createAgentManager, LAUNCH_AUTHORIZED_CONTROL } from "./agent-manager.mjs";
import { createOutrightDatabase } from "./database.mjs";
import { createProviderAccounts, LIMIT_STALE_AFTER_MS } from "./provider-accounts.mjs";

const signedIn = (email) => JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email, orgName: "Org", subscriptionType: "max" });
const signedOut = JSON.stringify({ loggedIn: false, authMethod: "none" });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// Answers an identity check by the account home the probe would run with.
function fakeProbe(logins) {
  const calls = [];
  const probe = async (executable, options) => {
    calls.push({ executable, ...options });
    const login = logins.get(options.environment[executable === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"] ?? "unset");
    if (login instanceof Error) throw login;
    return typeof login === "function" ? login() : (login ?? "Not logged in");
  };
  probe.calls = calls;
  return probe;
}

function fakeChild() {
  const child = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.stdio = [child.stdin, child.stdout, child.stderr, new PassThrough()];
  const write = child.stdin.write.bind(child.stdin);
  child.stdin.write = (chunk, ...args) => {
    const written = write(chunk, ...args);
    if (String(chunk).includes("go\n")) queueMicrotask(() => child.stdio[3].write(`${LAUNCH_AUTHORIZED_CONTROL}\n`));
    return written;
  };
  child.kill = () => true;
  return child;
}

async function fixture(t, { clock } = {}) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "outright-accounts-")));
  const inheritedHome = path.join(root, "inherited");
  const workHome = path.join(root, "work");
  mkdirSync(inheritedHome);
  mkdirSync(workHome);
  const logins = new Map([[inheritedHome, signedIn("me@example.com")], [workHome, signedIn("work@example.com")]]);
  const probe = fakeProbe(logins);
  const environment = { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: inheritedHome, OUTRIGHT_ANTHROPIC_API_KEY: "direct-secret" };
  const database = createOutrightDatabase({ filename: path.join(root, "outright.db") });
  const published = [];
  const accounts = createProviderAccounts({ database, probe, environment, publish: (event) => published.push(event), ...(clock ? { clock } : {}) });
  const spawned = [];
  const manager = createAgentManager({
    database, publish: () => {}, accounts, environment,
    providerDiscoveryFactory: () => ({ list: () => [], refresh: async () => [], available: async () => true, close: async () => {} }),
    launchCommand: (command) => ({ executable: process.execPath, args: command.args, display: "fixture" }),
    spawnProcess: (executable, args, options) => { const child = fakeChild(); spawned.push({ args, env: options.env, child }); return child; },
  });
  t.after(async () => {
    await manager.shutdown();
    await accounts.close();
    await database.close();
    rmSync(root, { recursive: true, force: true });
  });
  const conversation = (worktreePath = root) => database.createConversation({ projectId: "p", worktreeId: worktreePath, worktreePath, title: "Accounts", provider: "claude" });
  const claudeRun = (conversationId) => database.createRun({ conversationId, provider: "claude", approvalPolicy: "read-only", prompt: "hello" });
  const claude = () => accounts.list().providers.find((provider) => provider.provider === "claude");
  return { root, inheritedHome, workHome, logins, probe, environment, database, accounts, manager, spawned, published, conversation, claudeRun, claude };
}

async function addWork(context) {
  await context.accounts.add({ provider: "claude", label: "Work", homePath: context.workHome });
  return context.claude().accounts.find((account) => account.label === "Work");
}

test("switching applies to new sessions while a resumed session and a running run keep their account", async (t) => {
  const context = await fixture(t);
  const { accounts, database, manager, spawned } = context;
  const work = await addWork(context);
  await accounts.activate({ provider: "claude", accountId: work.id });
  const chat = context.conversation();

  const first = context.claudeRun(chat.id);
  await manager.schedule({ conversation: chat, run: first });
  assert.equal(spawned[0].env.CLAUDE_CONFIG_DIR, context.workHome, "the active account's home reaches the provider");
  assert.equal(database.getRun(first.id).accountId, work.id);
  spawned[0].child.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: "session-1" })}\n`);
  await tick();
  // Switching while the run is live changes neither its record nor its process.
  await accounts.activate({ provider: "claude", accountId: "claude:default" });
  assert.equal(database.getRun(first.id).accountId, work.id);
  assert.equal(database.getRun(first.id).accountLabel, "Work");
  assert.equal(database.getRun(first.id).accountIdentity, "work@example.com");
  spawned[0].child.emit("close", 0, null);
  await tick();
  assert.equal(database.getConversation(chat.id).providerSessionId, "session-1");

  // Resuming the session keeps the account that created it.
  const resumed = context.claudeRun(chat.id);
  await manager.schedule({ conversation: database.getConversation(chat.id), run: resumed });
  assert.ok(spawned[1].args.includes("--resume"));
  assert.equal(spawned[1].env.CLAUDE_CONFIG_DIR, context.workHome);
  assert.equal(database.getRun(resumed.id).accountId, work.id);
  spawned[1].child.emit("close", 0, null);
  await tick();

  // A new session uses the newly active default login.
  database.updateConversation(chat.id, { providerSessionId: null });
  const fresh = context.claudeRun(chat.id);
  await manager.schedule({ conversation: database.getConversation(chat.id), run: fresh });
  assert.equal(spawned[2].args.includes("--resume"), false);
  assert.equal(spawned[2].env.CLAUDE_CONFIG_DIR, context.inheritedHome);
  assert.equal(database.getRun(fresh.id).accountId, "claude:default");
  assert.equal(database.listRuns(chat.id).find((run) => run.id === fresh.id).accountLabel, "Default login");
  spawned[2].child.emit("close", 0, null);
  await tick();
});

test("concurrent runs on different accounts keep separate homes and usage windows", async (t) => {
  const context = await fixture(t);
  const { accounts, database, manager, spawned } = context;
  const work = await addWork(context);
  const first = context.conversation(path.join(context.root, "one"));
  const second = context.conversation(path.join(context.root, "two"));
  await accounts.activate({ provider: "claude", accountId: work.id });
  await manager.schedule({ conversation: first, run: context.claudeRun(first.id) });
  await accounts.activate({ provider: "claude", accountId: "claude:default" });
  await manager.schedule({ conversation: second, run: context.claudeRun(second.id) });
  assert.deepEqual(spawned.map((entry) => entry.env.CLAUDE_CONFIG_DIR), [context.workHome, context.inheritedHome]);
  const report = (utilization) => `${JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", resetsAt: Math.floor(Date.now() / 1000) + 3600, unifiedWindows: { five_hour: { utilization, resetsAt: Math.floor(Date.now() / 1000) + 3600 } } } })}\n`;
  spawned[0].child.stdout.write(report(0.25));
  spawned[1].child.stdout.write(report(0.9));
  await tick();
  const limits = Object.fromEntries(context.claude().accounts.map((account) => [account.id, account.limits.map((limit) => limit.utilization)]));
  assert.deepEqual(limits, { "claude:default": [0.9], [work.id]: [0.25] });
  for (const entry of spawned) entry.child.emit("close", 0, null);
  await tick();
  assert.equal(database.getRun(database.listRuns(first.id)[0].id).status, "completed");
});

test("a failed switch leaves the active account unchanged", async (t) => {
  const context = await fixture(t);
  const { accounts, logins } = context;
  const work = await addWork(context);
  // The identity check runs with the account's own home and without any
  // direct-provider credential.
  const call = context.probe.calls.find((entry) => entry.environment.CLAUDE_CONFIG_DIR === context.workHome);
  assert.deepEqual(call.args, ["auth", "status", "--json"]);
  assert.equal(call.environment.OUTRIGHT_ANTHROPIC_API_KEY, undefined);

  logins.set(context.workHome, signedOut);
  await assert.rejects(accounts.activate({ provider: "claude", accountId: work.id }), (error) => error.details.code === "PROVIDER_ACCOUNT_SWITCH_FAILED" && /signed out/.test(error.message));
  assert.equal(context.claude().activeAccountId, "claude:default");

  logins.set(context.workHome, new Error("Provider version check exited 2: claude (token=abc)"));
  await assert.rejects(accounts.activate({ provider: "claude", accountId: work.id }), (error) => error.details.code === "PROVIDER_ACCOUNT_SWITCH_FAILED" && !error.message.includes("token"));
  assert.equal(context.claude().activeAccountId, "claude:default");

  // The account is removed while its eligibility check is still running.
  let release;
  logins.set(context.workHome, () => new Promise((resolve) => { release = () => resolve(signedIn("work@example.com")); }));
  const switching = accounts.activate({ provider: "claude", accountId: work.id });
  await tick();
  accounts.remove(work.id);
  release();
  await assert.rejects(switching, (error) => error.details.code === "PROVIDER_ACCOUNT_SWITCH_FAILED" || error.details.code === "PROVIDER_ACCOUNT_NOT_FOUND");
  assert.equal(context.claude().activeAccountId, "claude:default");

  await assert.rejects(accounts.activate({ provider: "anthropic-api", accountId: "anthropic-api:default" }), (error) => error.details.code === "PROVIDER_ACCOUNT_UNSUPPORTED");
  await assert.rejects(accounts.activate({ provider: "claude", accountId: "codex:default" }), (error) => error.details.code === "PROVIDER_ACCOUNT_NOT_FOUND");
});

test("a removed session account fails the launch instead of falling back", async (t) => {
  const context = await fixture(t);
  const { accounts, database, manager, spawned } = context;
  const work = await addWork(context);
  await accounts.activate({ provider: "claude", accountId: work.id });
  const chat = context.conversation();
  const first = context.claudeRun(chat.id);
  await manager.schedule({ conversation: chat, run: first });
  spawned[0].child.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: "session-1" })}\n`);
  await tick();
  spawned[0].child.emit("close", 0, null);
  await tick();
  await assert.rejects(Promise.resolve().then(() => accounts.remove(work.id)), (error) => error.details.code === "PROVIDER_ACCOUNT_ACTIVE");
  await accounts.activate({ provider: "claude", accountId: "claude:default" });
  accounts.remove(work.id);

  const target = { provider: "claude", conversationId: chat.id, sessionId: "session-1" };
  await assert.rejects(accounts.assertLaunchable(target), (error) => error.details.code === "PROVIDER_ACCOUNT_UNAVAILABLE");
  const orphan = context.claudeRun(chat.id);
  await manager.schedule({ conversation: database.getConversation(chat.id), run: orphan });
  assert.equal(spawned.length, 1, "nothing launched with another account");
  assert.equal(database.getRun(orphan.id).status, "failed");
  assert.match(database.getRun(orphan.id).error, /session belongs to was removed/);
  assert.equal(database.getRun(orphan.id).accountId, null);
  // History keeps the removed account's recorded label.
  assert.equal(database.getRun(first.id).accountLabel, "Work");
  // A recovery is pinned to the interrupted run's account the same way.
  await assert.rejects(accounts.assertLaunchable({ provider: "claude", conversationId: chat.id, accountId: work.id }), (error) => error.details.code === "PROVIDER_ACCOUNT_UNAVAILABLE");
});

test("a cached sign-out is checked again before a send is refused", async (t) => {
  const context = await fixture(t);
  const { accounts, logins } = context;
  const chat = context.conversation();
  logins.set(context.inheritedHome, signedOut);
  await accounts.refresh("claude:default");
  await assert.rejects(accounts.assertLaunchable({ provider: "claude", conversationId: chat.id }), (error) => error.details.code === "PROVIDER_ACCOUNT_SIGNED_OUT");
  logins.set(context.inheritedHome, signedIn("me@example.com"));
  assert.equal((await accounts.assertLaunchable({ provider: "claude", conversationId: chat.id })).id, "claude:default");
});

test("account homes are validated and only display identity is kept", async (t) => {
  const context = await fixture(t);
  const { accounts, root, logins } = context;
  const file = path.join(root, "file");
  writeFileSync(file, "");
  const invalid = [
    [{ provider: "claude", label: "Relative", homePath: "relative/dir" }, "PROVIDER_ACCOUNT_INVALID"],
    [{ provider: "claude", label: "Missing", homePath: path.join(root, "missing") }, "PROVIDER_ACCOUNT_INVALID"],
    [{ provider: "claude", label: "File", homePath: file }, "PROVIDER_ACCOUNT_INVALID"],
    [{ provider: "claude", label: "", homePath: context.workHome }, "PROVIDER_ACCOUNT_INVALID"],
    [{ provider: "claude", label: "x".repeat(81), homePath: context.workHome }, "PROVIDER_ACCOUNT_INVALID"],
    [{ provider: "claude", label: "default login", homePath: context.workHome }, "PROVIDER_ACCOUNT_DUPLICATE"],
    [{ provider: "claude", label: "Inherited", homePath: context.inheritedHome }, "PROVIDER_ACCOUNT_DUPLICATE"],
    [{ provider: "anthropic-api", label: "Key", homePath: context.workHome }, "PROVIDER_ACCOUNT_UNSUPPORTED"],
    [{ provider: "other", label: "Other", homePath: context.workHome }, "PROVIDER_UNKNOWN"],
  ];
  for (const [input, code] of invalid) await assert.rejects(accounts.add(input), (error) => error.details.code === code, JSON.stringify(input));
  await addWork(context);
  await assert.rejects(accounts.add({ provider: "claude", label: "Again", homePath: `${context.workHome}/.` }), (error) => error.details.code === "PROVIDER_ACCOUNT_DUPLICATE");
  await assert.rejects(accounts.add({ provider: "claude", label: "WORK", homePath: path.join(root) }), (error) => error.details.code === "PROVIDER_ACCOUNT_DUPLICATE");

  // Codex prints a masked key after an API-key login; only the method is kept.
  const codexHome = path.join(root, "codex");
  mkdirSync(codexHome);
  logins.set(codexHome, "Logged in using an API key - sk-proj-***ABCD\n");
  await accounts.add({ provider: "codex", label: "API", homePath: codexHome });
  const codex = accounts.list().providers.find((provider) => provider.provider === "codex");
  assert.deepEqual(codex.accounts.find((account) => account.label === "API").login.identity, { signedIn: true, method: "api-key", email: null, organization: null, plan: null });
  assert.equal(codex.usageLimits, false);
  assert.equal(codex.accounts[0].limits, null, "an unreported limit is unavailable, not empty");
  assert.doesNotMatch(JSON.stringify(accounts.list()), /sk-proj|direct-secret/);
  const direct = accounts.list().providers.find((provider) => provider.provider === "anthropic-api");
  assert.equal(direct.switchable, false);
  assert.equal(direct.accounts[0].label, "OUTRIGHT_ANTHROPIC_API_KEY");
});

test("provider limits separate current, stale, reset and unreported windows", async (t) => {
  let now = Date.parse("2026-10-19T10:00:00.000Z");
  const context = await fixture(t, { clock: () => now });
  const { accounts } = context;
  const seconds = (iso) => Date.parse(iso) / 1000;
  accounts.recordLimits("claude:default", "claude", "run-1", [
    { window: "five_hour", utilization: 0.5, status: "allowed", resetsAt: new Date(seconds("2026-10-19T12:00:00Z") * 1000).toISOString() },
    { window: "seven_day", utilization: 0.2, status: null, resetsAt: "2026-10-22T00:00:00.000Z" },
  ]);
  const windows = () => Object.fromEntries(context.claude().accounts[0].limits.map((limit) => [limit.window, limit]));
  assert.equal(windows().five_hour.state, "current");
  assert.equal(windows().five_hour.utilization, 0.5);
  assert.equal(windows().five_hour.runId, "run-1");

  // The five-hour window resets on its own schedule; the weekly one does not.
  now = Date.parse("2026-10-19T12:00:01.000Z");
  assert.equal(windows().five_hour.state, "reset");
  assert.equal(windows().five_hour.utilization, null, "a reset window does not keep its old usage");
  assert.equal(windows().seven_day.state, "stale");
  assert.equal(windows().seven_day.utilization, 0.2);

  now = Date.parse("2026-10-19T10:00:00.000Z") + LIMIT_STALE_AFTER_MS - 1;
  assert.equal(windows().seven_day.state, "current");
  // A later report replaces the window, from whichever run made it.
  accounts.recordLimits("claude:default", "claude", "run-2", [{ window: "five_hour", utilization: 0.7, status: "allowed_warning", resetsAt: "2026-10-19T15:00:00.000Z" }]);
  assert.equal(windows().five_hour.utilization, 0.7);
  assert.equal(windows().five_hour.runId, "run-2");
  assert.equal(windows().seven_day.runId, "run-1");
  assert.deepEqual(accounts.list().providers.find((provider) => provider.provider === "codex").accounts[0].limits, null);
});

test("measured usage counts only runs launched with the account and flags missing cost", async (t) => {
  let now = Date.now();
  const context = await fixture(t, { clock: () => now });
  const { database } = context;
  const work = await addWork(context);
  const chat = context.conversation();
  const launch = (account, usage) => {
    const run = context.claudeRun(chat.id);
    database.bindRunAccount(run.id, { id: account, label: account });
    database.updateRun(run.id, { status: "completed", ...usage });
    return run;
  };
  launch(work.id, { inputTokens: 100, outputTokens: 20, costUsd: 0.5 });
  launch(work.id, { inputTokens: 10, outputTokens: 5 });
  launch("claude:default", { inputTokens: 1000, outputTokens: 1000, costUsd: 9 });
  const measured = () => Object.fromEntries(context.claude().accounts.find((account) => account.id === work.id).measured.map((period) => [period.period, period]));
  assert.deepEqual({ ...measured()["5h"], since: undefined, label: undefined }, { period: "5h", since: undefined, label: undefined, runs: 2, inputTokens: 110, outputTokens: 25, costUsd: 0.5, runsWithoutCost: 1 });
  now += 6 * 3_600_000;
  assert.equal(measured()["5h"].runs, 0);
  assert.equal(measured()["5h"].costUsd, null, "no runs means no measured cost, not zero");
  assert.equal(measured()["7d"].runs, 2);
});

test("a launched run's account cannot be rebound", async (t) => {
  const context = await fixture(t);
  const { database } = context;
  const run = context.claudeRun(context.conversation().id);
  database.bindRunAccount(run.id, { id: "claude:default", label: "Default login" });
  // A deferred admission is still queued and binds again at its next launch.
  database.bindRunAccount(run.id, { id: "other", label: "Other" });
  assert.equal(database.getRun(run.id).accountId, "other");
  database.updateRun(run.id, { status: "launching" });
  assert.throws(() => database.bindRunAccount(run.id, { id: "claude:default", label: "Default login" }), (error) => error.details.code === "RUN_ACCOUNT_IMMUTABLE");
  assert.equal(database.getRun(run.id).accountId, "other");
});

test("a database from before accounts upgrades in place and keeps its runs readable", async (t) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "outright-accounts-legacy-")));
  const filename = path.join(root, "outright.db");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let database = createOutrightDatabase({ filename });
  const chat = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: root, title: "Legacy", provider: "claude" });
  const legacyRun = database.createRun({ conversationId: chat.id, provider: "claude", approvalPolicy: "read-only", prompt: "old" });
  await database.close();
  const raw = new Database(filename);
  raw.exec("DROP TABLE run_accounts; DROP TABLE provider_accounts; DROP TABLE provider_account_selection; DROP TABLE provider_limit_windows;");
  raw.close();

  database = createOutrightDatabase({ filename });
  t.after(() => database.close());
  assert.equal(database.getRun(legacyRun.id).accountId, null, "a run from before accounts names none");
  assert.equal(database.listRuns(chat.id).length, 1);
  assert.equal(database.activeProviderAccountId("claude"), "claude:default");
  assert.equal(database.capacity().retainedUsageStatus, "measured", "new empty tables need no retained rescan");
  const before = database.capacity().retainedBytes;
  database.bindRunAccount(legacyRun.id, { id: "claude:default", label: "Default login" });
  assert.ok(database.capacity().retainedBytes > before, "a recorded account counts toward retained history");
});
