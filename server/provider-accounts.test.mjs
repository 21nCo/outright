import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createAgentManager, LAUNCH_AUTHORIZED_CONTROL } from "./agent-manager.mjs";
import { createOutrightDatabase } from "./database.mjs";
import { accountPin, createProviderAccounts, LIMIT_STALE_AFTER_MS } from "./provider-accounts.mjs";

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

async function fixture(t, { clock, launchCommand, extraEnvironment = {} } = {}) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "outright-accounts-")));
  const inheritedHome = path.join(root, "inherited");
  const workHome = path.join(root, "work");
  mkdirSync(inheritedHome);
  mkdirSync(workHome);
  const logins = new Map([[inheritedHome, signedIn("me@example.com")], [workHome, signedIn("work@example.com")]]);
  const probe = fakeProbe(logins);
  const environment = { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: inheritedHome, OUTRIGHT_ANTHROPIC_API_KEY: "direct-secret", ...extraEnvironment };
  const database = createOutrightDatabase({ filename: path.join(root, "outright.db") });
  const published = [];
  const accounts = createProviderAccounts({ database, probe, environment, publish: (event) => published.push(event), ...(clock ? { clock } : {}) });
  const spawned = [];
  const manager = createAgentManager({
    database, publish: () => {}, accounts, environment,
    providerDiscoveryFactory: () => ({ list: () => [], refresh: async () => [], available: async () => true, close: async () => {} }),
    launchCommand: async (command) => {
      await launchCommand?.();
      return { executable: process.execPath, args: command.args, display: "fixture" };
    },
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
  // A completed run whose provider created `sessionId`.
  const finish = async (index, sessionId) => {
    if (sessionId) spawned[index].child.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: sessionId })}\n`);
    await tick();
    spawned[index].child.emit("close", 0, null);
    await tick();
  };
  const claude = () => accounts.list().providers.find((provider) => provider.provider === "claude");
  return { root, inheritedHome, workHome, logins, probe, environment, database, accounts, manager, spawned, published, conversation, claudeRun, claude, finish };
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
  spawned[0].child.stdout.write(`${JSON.stringify({ type: "result", result: "done" })}\n`);
  await tick();
  // The answer itself names the account, so any page of history shows it.
  const answer = database.listMessages(chat.id).find((message) => message.role === "assistant");
  assert.deepEqual(answer.payload.account, { label: "Work", identity: "work@example.com" });
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
  // A recovery is pinned to the interrupted run's account the same way. Its
  // session cannot be cleared to change that, and adding the same directory
  // again makes a new account, so the error offers only what works.
  database.updateRun(first.id, { status: "interrupted" });
  await accounts.add({ provider: "claude", label: "Work", homePath: context.workHome });
  await assert.rejects(accounts.assertLaunchable({ provider: "claude", conversationId: chat.id, pin: accountPin(database.getRun(first.id)) }),
    (error) => error.details.code === "PROVIDER_ACCOUNT_UNAVAILABLE" && /Discard the interrupted run/.test(error.message)
      && !/session|add|again/i.test(error.message));
  assert.equal(database.resolveInterruptedRun(first.id, "discard").status, "failed");
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
  const defaultLogin = { id: "claude:default", provider: "claude", home: context.inheritedHome };
  accounts.recordLimits(defaultLogin, "run-1", [
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
  accounts.recordLimits(defaultLogin, "run-2", [{ window: "five_hour", utilization: 0.7, status: "allowed_warning", resetsAt: "2026-10-19T15:00:00.000Z" }]);
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
  const launch = (account, home, usage) => {
    const run = context.claudeRun(chat.id);
    database.bindRunAccount(run.id, { id: account, provider: "claude", label: account, home });
    database.updateRun(run.id, { status: "completed", ...usage });
    return run;
  };
  launch(work.id, context.workHome, { inputTokens: 100, outputTokens: 20, costUsd: 0.5 });
  launch(work.id, context.workHome, { inputTokens: 10, outputTokens: 5 });
  launch("claude:default", context.inheritedHome, { inputTokens: 1000, outputTokens: 1000, costUsd: 9 });
  const measured = (id = work.id) => Object.fromEntries(context.claude().accounts.find((account) => account.id === id).measured.map((period) => [period.period, period]));
  assert.deepEqual({ ...measured()["5h"], since: undefined, label: undefined, changesAt: undefined }, { period: "5h", since: undefined, label: undefined, changesAt: undefined, runs: 2, inputTokens: 110, outputTokens: 25, runsWithoutTokens: 0, runsWithPartialTokens: 0, costUsd: 0.5, runsWithoutCost: 1 });
  // A run that reported no tokens is counted as unreported, never as zero:
  // a partial sum stays partial and nothing reported stays null.
  launch(work.id, context.workHome, {});
  assert.deepEqual([measured()["5h"].runs, measured()["5h"].inputTokens, measured()["5h"].runsWithoutTokens], [3, 110, 1]);
  // A run that reported one counter keeps it and is counted as partial.
  launch(work.id, context.workHome, { inputTokens: 7 });
  assert.deepEqual([measured()["5h"].runs, measured()["5h"].inputTokens, measured()["5h"].outputTokens, measured()["5h"].runsWithoutTokens, measured()["5h"].runsWithPartialTokens], [4, 117, 25, 1, 1]);
  const codexHome = path.join(context.root, "codex");
  mkdirSync(codexHome);
  context.logins.set(codexHome, "Logged in using ChatGPT\n");
  await context.accounts.add({ provider: "codex", label: "Silent", homePath: codexHome });
  const silent = context.accounts.list().providers.find((provider) => provider.provider === "codex").accounts.find((account) => account.label === "Silent");
  const silentRun = database.createRun({ conversationId: chat.id, provider: "codex", approvalPolicy: "read-only", prompt: "hello" });
  database.bindRunAccount(silentRun.id, { id: silent.id, provider: "codex", label: "Silent", home: codexHome });
  const silentUsage = context.accounts.list().providers.find((provider) => provider.provider === "codex").accounts.find((account) => account.id === silent.id).measured[0];
  assert.deepEqual([silentUsage.runs, silentUsage.inputTokens, silentUsage.outputTokens, silentUsage.runsWithoutTokens, silentUsage.runsWithPartialTokens], [1, null, null, 1, 0]);
  // The listing says when its oldest run leaves each window; at that moment
  // the total drops without any run or account event.
  const oldest = database.listRuns(chat.id).filter((run) => run.accountId === work.id).map((run) => run.createdAt).sort()[0];
  const leavesAt = Date.parse(measured()["5h"].changesAt);
  assert.ok(leavesAt > Date.parse(oldest) + 5 * 3_600_000 - 1_000 && leavesAt <= Date.now() + 5 * 3_600_000 + 1);
  now = leavesAt - 1;
  assert.equal(measured()["5h"].runs, 4);
  now = leavesAt;
  assert.ok(measured()["5h"].runs < 4, "the oldest run left the 5-hour total");
  assert.equal(Date.parse(measured()["7d"].changesAt) - 7 * 86_400_000, leavesAt - 5 * 3_600_000);
  now += 6 * 3_600_000;
  assert.equal(measured()["5h"].runs, 0);
  assert.equal(measured()["5h"].changesAt, null, "an empty window has nothing to age out");
  assert.equal(measured()["5h"].costUsd, null, "no runs means no measured cost, not zero");
  assert.equal(measured()["7d"].runs, 4);
});

test("a launched run's account cannot be rebound", async (t) => {
  const context = await fixture(t);
  const { database } = context;
  const work = await addWork(context);
  const run = context.claudeRun(context.conversation().id);
  database.bindRunAccount(run.id, { id: "claude:default", provider: "claude", label: "Default login" });
  // A deferred admission is still queued and binds again at its next launch.
  database.bindRunAccount(run.id, { id: work.id, provider: "claude", label: "Work", home: context.workHome });
  assert.equal(database.getRun(run.id).accountId, work.id);
  assert.equal(database.getRun(run.id).accountHome, context.workHome);
  assert.throws(() => database.bindRunAccount(run.id, { id: "removed", provider: "claude", label: "Removed" }), (error) => error.details.code === "PROVIDER_ACCOUNT_UNAVAILABLE");
  database.updateRun(run.id, { status: "launching" });
  assert.throws(() => database.bindRunAccount(run.id, { id: "claude:default", provider: "claude", label: "Default login" }), (error) => error.details.code === "RUN_ACCOUNT_IMMUTABLE");
  assert.equal(database.getRun(run.id).accountId, work.id);
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
  raw.exec("DROP TABLE run_accounts; DROP TABLE run_account_pins; DROP TABLE provider_accounts; DROP TABLE provider_account_selection; DROP TABLE provider_limit_windows;");
  raw.close();

  database = createOutrightDatabase({ filename });
  t.after(() => database.close());
  assert.equal(database.getRun(legacyRun.id).accountId, null, "a run from before accounts names none");
  assert.equal(database.listRuns(chat.id).length, 1);
  assert.equal(database.activeProviderAccountId("claude"), "claude:default");
  assert.equal(database.capacity().retainedUsageStatus, "measured", "new empty tables need no retained rescan");
  const before = database.capacity().retainedBytes;
  database.bindRunAccount(legacyRun.id, { id: "claude:default", provider: "claude", label: "Default login" });
  assert.ok(database.capacity().retainedBytes > before, "a recorded account counts toward retained history");
});

test("a check that fails after its probe does not block later checks or switches", async (t) => {
  const context = await fixture(t);
  const { accounts, database, logins } = context;
  const work = await addWork(context);
  // The check's bookkeeping meets a storage fault (archive maintenance).
  const getProviderAccount = database.getProviderAccount;
  logins.set(context.workHome, () => {
    database.getProviderAccount = () => { throw Object.assign(new Error("maintenance"), { statusCode: 503 }); };
    return signedIn("work@example.com");
  });
  await assert.rejects(accounts.refresh(work.id), /maintenance/);
  database.getProviderAccount = getProviderAccount;
  logins.set(context.workHome, signedIn("work@example.com"));
  const probes = context.probe.calls.length;
  await accounts.refresh("claude:default");
  assert.equal(context.probe.calls.length, probes + 1, "the next check probes instead of repeating the old failure");
  await accounts.activate({ provider: "claude", accountId: work.id });
  assert.equal(context.claude().activeAccountId, work.id);
});

test("a session from before accounts resumes with the default login, and an attached one with the active account", async (t) => {
  const context = await fixture(t);
  const { accounts, database, manager, spawned } = context;
  const chat = context.conversation();
  // A pre-upgrade run created the session and has no recorded account.
  const legacy = context.claudeRun(chat.id);
  database.updateRun(legacy.id, { status: "completed", providerSessionId: "legacy-session" });
  database.updateConversation(chat.id, { providerSessionId: "legacy-session" });
  const work = await addWork(context);
  await accounts.activate({ provider: "claude", accountId: work.id });

  const resumed = context.claudeRun(chat.id);
  await manager.schedule({ conversation: database.getConversation(chat.id), run: resumed });
  assert.ok(spawned[0].args.includes("legacy-session"));
  assert.equal(spawned[0].env.CLAUDE_CONFIG_DIR, context.inheritedHome);
  assert.equal(database.getRun(resumed.id).accountId, "claude:default");
  await context.finish(0);

  // No run created this session, so it starts on the active account.
  database.updateConversation(chat.id, { providerSessionId: "attached-session" });
  const attached = context.claudeRun(chat.id);
  await manager.schedule({ conversation: database.getConversation(chat.id), run: attached });
  assert.equal(spawned[1].env.CLAUDE_CONFIG_DIR, context.workHome);
  assert.equal(database.getRun(attached.id).accountId, work.id);
  await context.finish(1);
});

test("the default login's home is recorded, so a changed environment neither resumes nor shares its usage", async (t) => {
  const context = await fixture(t);
  const { database, manager, spawned } = context;
  const chat = context.conversation();
  const first = context.claudeRun(chat.id);
  await manager.schedule({ conversation: chat, run: first });
  spawned[0].child.stdout.write(`${JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.4, resetsAt: Math.floor(Date.now() / 1000) + 3600 } })}\n`);
  await context.finish(0, "session-1");
  assert.equal(database.getRun(first.id).accountHome, context.inheritedHome);

  // After a restart the environment selects another home for the default.
  const otherHome = path.join(context.root, "other");
  mkdirSync(otherHome);
  context.logins.set(otherHome, signedIn("other@example.com"));
  const restarted = createProviderAccounts({ database, probe: context.probe, environment: { ...context.environment, CLAUDE_CONFIG_DIR: otherHome } });
  t.after(() => restarted.close());
  assert.throws(() => restarted.resolve({ provider: "claude", conversationId: chat.id, sessionId: "session-1" }),
    (error) => error.details.code === "PROVIDER_ACCOUNT_UNAVAILABLE" && error.message.includes(context.inheritedHome));
  const defaultLogin = (accounts) => accounts.list().providers.find((provider) => provider.provider === "claude").accounts[0];
  assert.equal(defaultLogin(restarted).measured[1].runs, 0, "another login's runs are not this login's usage");
  assert.deepEqual(defaultLogin(restarted).limits, []);
  assert.equal(defaultLogin(context.accounts).measured[1].runs, 1);
  assert.equal(defaultLogin(context.accounts).limits[0].utilization, 0.4);
  // A new session uses the current default login.
  assert.equal(restarted.resolve({ provider: "claude", conversationId: chat.id }).home, otherHome);
});

test("a recovery's account pin is durable across a restart before it launches", async (t) => {
  const context = await fixture(t);
  const { accounts, database, manager, spawned } = context;
  const work = await addWork(context);
  await accounts.activate({ provider: "claude", accountId: work.id });
  const chat = context.conversation();
  const first = context.claudeRun(chat.id);
  await manager.schedule({ conversation: chat, run: first });
  await context.finish(0, "session-1");
  database.updateRun(first.id, { status: "interrupted" });
  await accounts.activate({ provider: "claude", accountId: "claude:default" });

  const recovery = database.beginInterruptedRunRecovery(first.id, "retry");
  assert.deepEqual(accountPin(recovery.run), { accountId: work.id, home: context.workHome, recovery: true });
  // The runtime restarts before the recovery launches; its retry keeps the pin.
  database.updateRun(recovery.run.id, { status: "interrupted" });
  const again = database.beginInterruptedRunRecovery(recovery.run.id, "retry");
  assert.equal(again.run.accountPinId, work.id);
  await manager.schedule({ conversation: database.getConversation(chat.id), run: again.run, forceFreshSession: true });
  assert.equal(spawned[1].env.CLAUDE_CONFIG_DIR, context.workHome);
  assert.equal(database.getRun(again.run.id).accountId, work.id);
  await context.finish(1);
});

test("an account removed while its launch is being prepared fails the run without spawning", async (t) => {
  let duringLaunch = null;
  const context = await fixture(t, { launchCommand: () => duringLaunch?.() });
  const { accounts, database, manager, spawned } = context;
  const work = await addWork(context);
  await accounts.activate({ provider: "claude", accountId: work.id });
  const chat = context.conversation();
  duringLaunch = async () => {
    duringLaunch = null;
    await accounts.activate({ provider: "claude", accountId: "claude:default" });
    accounts.remove(work.id);
  };
  const run = context.claudeRun(chat.id);
  await manager.schedule({ conversation: chat, run });
  assert.equal(spawned.length, 0);
  assert.equal(database.getRun(run.id).status, "failed");
  assert.match(database.getRun(run.id).error, /removed before this run launched/);
  assert.equal(database.getRun(run.id).accountId, null);
});

test("inherited credential variables never reach an added account's check or launch", async (t) => {
  const context = await fixture(t, { extraEnvironment: { ANTHROPIC_API_KEY: "env-key", CLAUDE_CODE_OAUTH_TOKEN: "env-token" } });
  const { accounts, manager, spawned } = context;
  const work = await addWork(context);
  const check = context.probe.calls.find((call) => call.environment.CLAUDE_CONFIG_DIR === context.workHome);
  assert.equal(check.environment.ANTHROPIC_API_KEY, undefined);
  assert.equal(check.environment.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  await accounts.activate({ provider: "claude", accountId: work.id });
  const chat = context.conversation();
  await manager.schedule({ conversation: chat, run: context.claudeRun(chat.id) });
  assert.equal(spawned[0].env.CLAUDE_CONFIG_DIR, context.workHome);
  assert.equal(spawned[0].env.ANTHROPIC_API_KEY, undefined);
  assert.equal(spawned[0].env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  await context.finish(0);
  // The default login is whatever the environment selects, credentials included.
  await accounts.activate({ provider: "claude", accountId: "claude:default" });
  const other = context.conversation(path.join(context.root, "other"));
  await manager.schedule({ conversation: other, run: context.claudeRun(other.id) });
  assert.equal(spawned[1].env.ANTHROPIC_API_KEY, "env-key");
  await context.finish(1);
});

test("a removed account's live run records no orphan limit windows", async (t) => {
  const context = await fixture(t);
  const { accounts, database, manager, spawned } = context;
  const work = await addWork(context);
  await accounts.activate({ provider: "claude", accountId: work.id });
  const chat = context.conversation();
  await manager.schedule({ conversation: chat, run: context.claudeRun(chat.id) });
  await accounts.activate({ provider: "claude", accountId: "claude:default" });
  accounts.remove(work.id);
  spawned[0].child.stdout.write(`${JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.4 } })}\n`);
  await tick();
  assert.deepEqual(database.listProviderLimits(work.id, context.workHome), []);
  await context.finish(0);
});

test("an identity probe whose cleanup is uncertain stops further probes and is reported at close", async (t) => {
  const context = await fixture(t);
  const uncertain = Object.assign(new Error("Provider probe forced cleanup failed"), { code: "OUTRIGHT_PROBE_CLEANUP_UNCERTAIN" });
  let probes = 0;
  const accounts = createProviderAccounts({ database: context.database, environment: context.environment, probe: async (executable) => { if (executable === "claude") probes += 1; throw uncertain; } });
  await accounts.refresh("claude:default");
  const login = () => accounts.list().providers.find((provider) => provider.provider === "claude").accounts[0].login;
  assert.equal(login().status, "unknown");
  await accounts.refresh("claude:default");
  assert.equal(probes, 1);
  assert.match(login().error, /checks stopped/);
  await assert.rejects(accounts.close(), (error) => error instanceof AggregateError && error.errors[0] === uncertain);
});

test("on Windows an account home must be inside the user's profile", async (t) => {
  const context = await fixture(t);
  const profile = path.join(context.root, "profile");
  const inside = path.join(profile, ".claude-work");
  mkdirSync(inside, { recursive: true });
  context.logins.set(inside, signedIn("work@example.com"));
  const accounts = createProviderAccounts({ database: context.database, probe: context.probe, environment: context.environment, platform: "win32", homeDirectory: profile });
  t.after(() => accounts.close());
  await assert.rejects(accounts.add({ provider: "claude", label: "Outside", homePath: context.workHome }), (error) => error.details.code === "PROVIDER_ACCOUNT_INVALID" && /user profile/.test(error.message));
  await accounts.add({ provider: "claude", label: "Inside", homePath: inside });
  assert.ok(accounts.list().providers.find((provider) => provider.provider === "claude").accounts.some((account) => account.label === "Inside"));
});

test("a recovery of a run launched before accounts stays on the default login, repeatedly", async (t) => {
  const context = await fixture(t);
  const { accounts, database, manager, spawned } = context;
  const chat = context.conversation();
  // Pre-upgrade: one run launched (no recorded account), one never launched.
  const launched = context.claudeRun(chat.id);
  database.updateRun(launched.id, { status: "interrupted", startedAt: new Date().toISOString() });
  const work = await addWork(context);
  await accounts.activate({ provider: "claude", accountId: work.id });

  // The runtime's check and the durable pin agree on the default login.
  assert.deepEqual(accountPin(database.getRun(launched.id)), { accountId: "claude:default", home: undefined, recovery: true });
  await accounts.assertLaunchable({ provider: "claude", conversationId: chat.id, pin: accountPin(database.getRun(launched.id)) });
  const first = database.beginInterruptedRunRecovery(launched.id, "retry");
  assert.deepEqual([first.run.accountPinId, first.run.accountPinHomeKnown], ["claude:default", 0]);
  // A restart before it launches keeps the pin, home still unknown.
  database.updateRun(first.run.id, { status: "interrupted" });
  const second = database.beginInterruptedRunRecovery(first.run.id, "retry");
  assert.deepEqual(accountPin(second.run), { accountId: "claude:default", home: undefined, recovery: true });
  await manager.schedule({ conversation: database.getConversation(chat.id), run: second.run, forceFreshSession: true });
  assert.equal(spawned[0].env.CLAUDE_CONFIG_DIR, context.inheritedHome);
  assert.deepEqual([database.getRun(second.run.id).accountId, database.getRun(second.run.id).accountHome], ["claude:default", context.inheritedHome]);
  await context.finish(0);
  // Interrupted again after launching, it is retried on the same login.
  database.updateRun(second.run.id, { status: "interrupted" });
  const third = database.beginInterruptedRunRecovery(second.run.id, "retry");
  await manager.schedule({ conversation: database.getConversation(chat.id), run: third.run, forceFreshSession: true });
  assert.equal(spawned[1].env.CLAUDE_CONFIG_DIR, context.inheritedHome);
  assert.equal(database.getRun(third.run.id).accountId, "claude:default");
  await context.finish(1);

  // A run that never launched has no account to keep: it uses the active one.
  const queued = context.claudeRun(chat.id);
  database.updateRun(queued.id, { status: "interrupted" });
  assert.equal(accountPin(database.getRun(queued.id)), null);
  const fresh = database.beginInterruptedRunRecovery(queued.id, "retry");
  assert.equal(fresh.run.accountPinId, null);
  await manager.schedule({ conversation: database.getConversation(chat.id), run: fresh.run, forceFreshSession: true });
  assert.equal(spawned[2].env.CLAUDE_CONFIG_DIR, context.workHome);
  assert.equal(database.getRun(fresh.run.id).accountId, work.id);
  await context.finish(2);
});

test("a recovery whose default-login home changed names actions that work", async (t) => {
  const context = await fixture(t);
  const { database, manager } = context;
  const chat = context.conversation();
  const first = context.claudeRun(chat.id);
  await manager.schedule({ conversation: chat, run: first });
  await context.finish(0, "session-1");
  database.updateRun(first.id, { status: "interrupted" });
  const otherHome = path.join(context.root, "other");
  mkdirSync(otherHome);
  const restarted = createProviderAccounts({ database, probe: context.probe, environment: { ...context.environment, CLAUDE_CONFIG_DIR: otherHome } });
  t.after(() => restarted.close());
  assert.throws(() => restarted.resolve({ provider: "claude", conversationId: chat.id, pin: accountPin(database.getRun(first.id)) }),
    (error) => error.details.code === "PROVIDER_ACCOUNT_UNAVAILABLE" && error.message.includes(context.inheritedHome)
      && /Restore CLAUDE_CONFIG_DIR or discard the interrupted run/.test(error.message) && !/session/i.test(error.message));
  // A chat session in the same state can still be cleared.
  assert.throws(() => restarted.resolve({ provider: "claude", conversationId: chat.id, sessionId: "session-1" }), /clear the session in chat settings/);
});

test("off Windows the default login reads only the exact home variable name", async (t) => {
  const context = await fixture(t);
  const twin = path.join(context.root, "twin");
  mkdirSync(twin);
  context.logins.set(twin, signedIn("twin@example.com"));
  const environment = { PATH: process.env.PATH, claude_config_dir: twin };
  const posix = createProviderAccounts({ database: context.database, probe: context.probe, environment, platform: "linux" });
  const windows = createProviderAccounts({ database: context.database, probe: context.probe, environment, platform: "win32", homeDirectory: context.root });
  t.after(() => Promise.all([posix.close(), windows.close()]));
  // The CLI ignores a lowercase twin on POSIX, so the default home is standard.
  assert.equal(posix.resolve({ provider: "claude", conversationId: "c" }).home, null);
  assert.equal(windows.resolve({ provider: "claude", conversationId: "c" }).home, twin.toLowerCase(), "Windows keys a home without case");
  // The twin is a separate login there, not the default one.
  await posix.add({ provider: "claude", label: "Twin", homePath: twin });
  await assert.rejects(windows.add({ provider: "claude", label: "Twin again", homePath: twin }),
    (error) => error.details.code === "PROVIDER_ACCOUNT_DUPLICATE");
});

test("with its variable unset, the CLI's standard home is the default login under any path", async (t) => {
  const context = await fixture(t);
  const { database, probe, root } = context;
  const user = path.join(root, "user");
  const standard = { claude: path.join(user, ".claude"), codex: path.join(user, ".codex") };
  for (const home of Object.values(standard)) mkdirSync(home, { recursive: true });
  const unset = createProviderAccounts({ database, probe, environment: { PATH: process.env.PATH }, homeDirectory: user });
  t.after(() => unset.close());
  for (const [provider, home] of Object.entries(standard)) {
    const link = path.join(root, `${provider}-link`);
    symlinkSync(home, link);
    for (const homePath of [home, link, `${home}/.`]) {
      await assert.rejects(unset.add({ provider, label: "Alias", homePath }),
        (error) => error.details.code === "PROVIDER_ACCOUNT_DUPLICATE" && /default login/.test(error.message), homePath);
    }
  }
  assert.equal(database.listProviderAccounts().length, 0);

  // Naming the standard home in the variable is still the standard home, so
  // a session recorded under it resumes and its usage stays in one bucket.
  const chat = context.conversation();
  const run = context.claudeRun(chat.id);
  database.bindRunAccount(run.id, { id: "claude:default", provider: "claude", label: "Default login", home: null });
  database.updateRun(run.id, { status: "completed", providerSessionId: "session-1" });
  const named = createProviderAccounts({ database, probe, environment: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: path.join(root, "claude-link") }, homeDirectory: user });
  t.after(() => named.close());
  assert.equal(named.resolve({ provider: "claude", conversationId: chat.id }).home, null);
  assert.equal(named.resolve({ provider: "claude", conversationId: chat.id, sessionId: "session-1" }).home, null);
  await assert.rejects(named.add({ provider: "claude", label: "Standard", homePath: standard.claude }), (error) => error.details.code === "PROVIDER_ACCOUNT_DUPLICATE");

  // When the variable selects another home, the standard home is another login.
  const other = createProviderAccounts({ database, probe, environment: context.environment, homeDirectory: user });
  t.after(() => other.close());
  await other.add({ provider: "claude", label: "Standard", homePath: standard.claude });
  assert.equal(database.listProviderAccounts()[0].homePath, standard.claude);
});

test("one CLI home keeps one usage and limit history under any spelling, link or case", async (t) => {
  const context = await fixture(t);
  const { database, inheritedHome, probe, root } = context;
  const chat = context.conversation();
  const run = context.claudeRun(chat.id);
  await context.manager.schedule({ conversation: chat, run });
  context.spawned[0].child.stdout.write(`${JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.4, resetsAt: Math.floor(Date.now() / 1000) + 3600 } })}\n`);
  await context.finish(0, "session-1");
  const link = path.join(root, "inherited-link");
  symlinkSync(inheritedHome, link);
  const defaultLogin = (accounts) => accounts.list().providers.find((provider) => provider.provider === "claude").accounts[0];
  // A restart that names the same directory another way is the same login.
  for (const spelling of [`${inheritedHome}/.`, `${inheritedHome}/`, link]) {
    const restarted = createProviderAccounts({ database, probe, environment: { ...context.environment, CLAUDE_CONFIG_DIR: spelling } });
    t.after(() => restarted.close());
    assert.equal(restarted.resolve({ provider: "claude", conversationId: chat.id }).home, inheritedHome, spelling);
    assert.equal(defaultLogin(restarted).measured[1].runs, 1, spelling);
    assert.equal(defaultLogin(restarted).limits[0]?.utilization, 0.4, spelling);
    assert.equal(restarted.resolve({ provider: "claude", conversationId: chat.id, sessionId: "session-1" }).id, "claude:default");
  }

  // Reports under two default-login homes are kept apart, each with its own cap.
  const otherHome = path.join(root, "other");
  mkdirSync(otherHome);
  const other = createProviderAccounts({ database, probe, environment: { ...context.environment, CLAUDE_CONFIG_DIR: otherHome } });
  t.after(() => other.close());
  const otherLogin = other.resolve({ provider: "claude", conversationId: chat.id });
  other.recordLimits(otherLogin, "run-other", Array.from({ length: 8 }, (_, index) => ({ window: `window_${index}`, utilization: 0.9, status: "allowed", resetsAt: null })));
  assert.equal(defaultLogin(other).limits.length, 8);
  assert.deepEqual(defaultLogin(context.accounts).limits.map((limit) => [limit.window, limit.utilization]), [["five_hour", 0.4]], "restoring the first home shows its own window");
  context.accounts.recordLimits(context.accounts.resolve({ provider: "claude", conversationId: chat.id }), "run-2", [{ window: "seven_day", utilization: 0.1, status: "allowed", resetsAt: null }]);
  assert.equal(defaultLogin(context.accounts).limits.length, 2, "another home's windows do not use up this home's cap");
  assert.equal(defaultLogin(other).limits.length, 8);

  // On Windows, case variants of one directory are one key.
  const upper = createProviderAccounts({ database, probe, platform: "win32", homeDirectory: root, environment: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: inheritedHome.toUpperCase() } });
  const lower = createProviderAccounts({ database, probe, platform: "win32", homeDirectory: root, environment: { PATH: process.env.PATH, claude_config_dir: inheritedHome.toLowerCase() } });
  t.after(() => Promise.all([upper.close(), lower.close()]));
  const key = upper.resolve({ provider: "claude", conversationId: chat.id }).home;
  assert.equal(key, lower.resolve({ provider: "claude", conversationId: chat.id }).home);
  upper.recordLimits({ id: "claude:default", provider: "claude", home: key }, "run-win", [{ window: "five_hour", utilization: 0.3, status: "allowed", resetsAt: null }]);
  assert.equal(defaultLogin(lower).limits[0].utilization, 0.3);
});

test("an added account whose directory becomes the default login's is flagged, not activated and keeps its sessions", async (t) => {
  const context = await fixture(t);
  const { accounts, database, manager, probe, spawned } = context;
  const work = await addWork(context);
  await accounts.activate({ provider: "claude", accountId: work.id });
  const chat = context.conversation();
  await manager.schedule({ conversation: chat, run: context.claudeRun(chat.id) });
  await context.finish(0, "session-work");
  await accounts.activate({ provider: "claude", accountId: "claude:default" });
  assert.equal(context.claude().accounts.find((account) => account.id === work.id).sameAsDefault, false);

  // After a restart the environment selects Work's directory for the default.
  const restarted = createProviderAccounts({ database, probe, environment: { ...context.environment, CLAUDE_CONFIG_DIR: context.workHome } });
  t.after(() => restarted.close());
  const listed = restarted.list().providers.find((provider) => provider.provider === "claude").accounts.find((account) => account.id === work.id);
  assert.equal(listed.sameAsDefault, true);
  await assert.rejects(restarted.activate({ provider: "claude", accountId: work.id }),
    (error) => error.details.code === "PROVIDER_ACCOUNT_DUPLICATE" && /Default login/.test(error.message));
  assert.equal(database.activeProviderAccountId("claude"), "claude:default");
  // The chat's existing session still resumes on Work.
  assert.equal(restarted.resolve({ provider: "claude", conversationId: chat.id, sessionId: "session-work" }).id, work.id);
  // Were it already active, it starts no new session under a second id.
  database.selectProviderAccount("claude", work.id);
  assert.throws(() => restarted.resolve({ provider: "claude", conversationId: chat.id }), (error) => error.details.code === "PROVIDER_ACCOUNT_DUPLICATE");
  assert.equal(spawned.length, 1);
});

test("a default login that uses a credential variable is not refused as signed out", async (t) => {
  const context = await fixture(t, { extraEnvironment: { CODEX_API_KEY: "env-secret" } });
  const { accounts, database, probe, root } = context;
  const codex = () => accounts.list().providers.find((provider) => provider.provider === "codex");
  // The default CODEX_HOME has no login; `codex login status` would say so.
  const before = probe.calls.length;
  codex();
  await tick(); await tick();
  const login = codex().accounts[0].login;
  assert.equal(login.status, "configured");
  assert.equal(login.identity.variable, "CODEX_API_KEY");
  assert.ok(!JSON.stringify(codex()).includes("env-secret"), "the variable is named, never its value");
  assert.ok(!probe.calls.slice(before).some((call) => call.executable === "codex" && call.environment.CODEX_HOME === undefined), "the home login is not what the default launches with");
  const chat = database.createConversation({ projectId: "p", worktreeId: root, worktreePath: root, title: "Codex", provider: "codex" });
  assert.equal((await accounts.assertLaunchable({ provider: "codex", conversationId: chat.id })).identity, "CODEX_API_KEY");

  // Switching back to the default works; an added signed-out account is still refused.
  const personal = path.join(root, "codex-personal");
  const signedOutHome = path.join(root, "codex-signed-out");
  mkdirSync(personal);
  mkdirSync(signedOutHome);
  context.logins.set(personal, "Logged in using ChatGPT");
  await accounts.add({ provider: "codex", label: "Personal", homePath: personal });
  await accounts.add({ provider: "codex", label: "Old", homePath: signedOutHome });
  const id = (label) => codex().accounts.find((account) => account.label === label).id;
  await accounts.activate({ provider: "codex", accountId: id("Personal") });
  await accounts.activate({ provider: "codex", accountId: "codex:default" });
  assert.equal(database.activeProviderAccountId("codex"), "codex:default");
  await assert.rejects(accounts.activate({ provider: "codex", accountId: id("Old") }), (error) => error.details.code === "PROVIDER_ACCOUNT_SWITCH_FAILED");
  const check = probe.calls.find((call) => call.environment.CODEX_HOME === signedOutHome);
  assert.equal(check.environment.CODEX_API_KEY, undefined, "an added account is checked by its own login");
});

test("limit windows stored before homes were keyed are kept by home", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-limit-keys-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const filename = path.join(root, "outright.db");
  createOutrightDatabase({ filename }).close();
  const raw = new Database(filename);
  raw.exec(`DROP TABLE provider_limit_windows;
    CREATE TABLE provider_limit_windows (account_id TEXT NOT NULL, provider TEXT NOT NULL, window_name TEXT NOT NULL, utilization REAL, status TEXT, resets_at TEXT,
      observed_at TEXT NOT NULL, run_id TEXT, home_path TEXT, PRIMARY KEY (account_id, window_name));
    INSERT INTO provider_limit_windows VALUES ('claude:default', 'claude', 'five_hour', 0.5, 'allowed', NULL, '2026-10-19T10:00:00.000Z', 'run-1', NULL);`);
  raw.close();
  const database = createOutrightDatabase({ filename });
  t.after(() => database.close());
  assert.equal(database.listProviderLimits("claude:default", null)[0].utilization, 0.5);
  database.recordProviderLimits({ accountId: "claude:default", provider: "claude", home: "/other" }, "run-2", [{ window: "five_hour", utilization: 0.2, status: "allowed", resetsAt: null }]);
  assert.equal(database.listProviderLimits("claude:default", null)[0].utilization, 0.5);
  assert.equal(database.listProviderLimits("claude:default", "/other")[0].utilization, 0.2);
});
