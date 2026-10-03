import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { access, chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createGitService } from "./git-service.mjs";
import { createSubprocessBudget } from "./subprocess-budget.mjs";
import { createOutrightDatabase } from "./database.mjs";

const execFileAsync = promisify(execFile);
// The host may attach a Git Trace2 consumer that writes into disposable .git
// directories after a command exits, racing their removal in these tests.
process.env.GIT_TRACE2_EVENT = "0";

function capacityError() {
  return Object.assign(new Error("Utility process capacity is full"), { statusCode: 429, code: "SUBPROCESS_CAPACITY" });
}

async function stagedTrackedFixture(root) {
  await git(root, ["init", "project"]);
  const repository = await realpath(path.join(root, "project"));
  await git(repository, ["config", "user.email", "outright@example.test"]);
  await git(repository, ["config", "user.name", "Outright Test"]);
  await writeFile(path.join(repository, "tracked.txt"), "first\n");
  await git(repository, ["add", "tracked.txt"]);
  await git(repository, ["commit", "-m", "initial"]);
  await writeFile(path.join(repository, "tracked.txt"), "second\n");
  await git(repository, ["add", "tracked.txt"]);
  return repository;
}

test("optional Git history failure leaves required status usable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "outright-git-optional-log-"));
  try {
    await git(root, ["init", "project"]);
    const repository = await realpath(path.join(root, "project"));
    await git(repository, ["config", "user.email", "outright@example.test"]);
    await git(repository, ["config", "user.name", "Outright Test"]);
    await writeFile(path.join(repository, "tracked.txt"), "committed history\n");
    await git(repository, ["add", "tracked.txt"]);
    await git(repository, ["commit", "-m", "history exists"]);
    await writeFile(path.join(repository, "new file.txt"), "untracked\n");
    let failRequired = false;
    const service = createGitService({
      database: {}, getProjects: () => [{ worktrees: [{ path: repository }] }],
      getConfig: async () => ({ scanRoots: [root] }),
      subprocesses: { run: (file, args, options) => {
        if (args[2] === "log") return Promise.reject(Object.assign(new Error("history timed out"), { code: "ETIMEDOUT" }));
        if (failRequired && args[2] === "status") return Promise.reject(capacityError());
        return execFileAsync(file, args, options);
      } },
    });
    const status = await service.status(repository);
    assert.equal(status.files[0].path, "new file.txt");
    assert.deepEqual(status.commits, []);
    failRequired = true;
    await assert.rejects(service.status(repository), (error) => error.code === "SUBPROCESS_CAPACITY");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("editor launch releases utility capacity when a GUI stays open and records spawn failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "outright-editor-launch-"));
  try {
    const cwd = await realpath(root);
    const actions = [];
    const launched = [];
    let failLaunch = false;
    let holdLaunch = true;
    const subprocesses = createSubprocessBudget({ limit: 1, launch: (file, args, options) => {
      const child = new EventEmitter();
      child.pid = 42 + launched.length;
      child.unref = () => { child.unreferenced = true; };
      launched.push({ file, args, options, child });
      if (!holdLaunch) queueMicrotask(() => child.emit(failLaunch ? "error" : "spawn",
        failLaunch ? Object.assign(new Error("missing editor"), { code: "ENOENT" }) : undefined));
      return child;
    } });
    const service = createGitService({ database: {
      getSettings: () => ({ editor: "code" }),
      auditAdmission: (action) => actions.push(action),
      auditCritical: (action) => actions.push(action),
    }, getProjects: () => [{ worktrees: [{ path: cwd }] }], getConfig: async () => ({ scanRoots: [cwd] }), subprocesses });
    const opening = service.openInEditor(cwd);
    const deadline = Date.now() + 2_000;
    while (!launched.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(launched.length, 1, "editor launcher never reached process admission");
    assert.equal(subprocesses.capacity().active, 1);
    await assert.rejects(service.openInEditor(cwd), (error) => error.code === "SUBPROCESS_CAPACITY");
    launched[0].child.emit("spawn");
    holdLaunch = false;
    assert.deepEqual(await opening, { opened: true, editor: "code", target: cwd });
    assert.equal(launched[0].child.unreferenced, true);
    assert.equal(launched[0].options.stdio, "ignore");
    assert.equal(subprocesses.capacity().active, 0, "an open editor retained the utility slot");
    failLaunch = true;
    await assert.rejects(service.openInEditor(cwd), (error) => error.code === "ENOENT");
    assert.equal(subprocesses.capacity().active, 0);
    assert.ok(actions.includes("editor.open") && actions.includes("editor.open.failed"));
    assert.equal(launched.length, 2, "the live editor prevented another launch attempt");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unstage capacity refusal preserves a staged tracked modification", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "outright-unstage-capacity-"));
  try {
    const repository = await stagedTrackedFixture(root);
    const service = createGitService({
      database: { auditAdmission() {}, auditCritical() {} },
      getProjects: () => [{ worktrees: [{ path: repository }] }],
      getConfig: async () => ({ scanRoots: [root] }),
      subprocesses: { run: (file, args, options) => args.includes("restore") ? Promise.reject(capacityError()) : execFileAsync(file, args, options) },
    });
    await assert.rejects(service.unstage(repository, ["tracked.txt"]), (error) => error.code === "SUBPROCESS_CAPACITY");
    const { stdout } = await execFileAsync("git", ["-C", repository, "status", "--porcelain"]);
    assert.equal(stdout.trim(), "M  tracked.txt");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Git without restore unstages tracked changes without staging a deletion", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "outright-unstage-compat-"));
  try {
    const repository = await stagedTrackedFixture(root);
    const service = createGitService({
      database: { auditAdmission() {}, auditCritical() {} },
      getProjects: () => [{ worktrees: [{ path: repository }] }],
      getConfig: async () => ({ scanRoots: [root] }),
      subprocesses: { run: (file, args, options) => args.includes("restore")
        ? Promise.reject(Object.assign(new Error("git: 'restore' is not a git command"), { stderr: "git: 'restore' is not a git command" }))
        : execFileAsync(file, args, options) },
    });
    assert.equal((await service.unstage(repository, ["tracked.txt"])).unstagedCount, 1);
    const { stdout } = await execFileAsync("git", ["-C", repository, "status", "--porcelain"]);
    assert.equal(stdout.trimStart(), "M tracked.txt\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a committed Git effect reports success when only its status refresh hits capacity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "outright-git-refresh-capacity-"));
  try {
    await git(root, ["init", "project"]);
    const repository = await realpath(path.join(root, "project"));
    await git(repository, ["config", "user.email", "outright@example.test"]);
    await git(repository, ["config", "user.name", "Outright Test"]);
    await writeFile(path.join(repository, "tracked.txt"), "first\n");
    await git(repository, ["add", "tracked.txt"]);
    await git(repository, ["commit", "-m", "initial"]);
    await writeFile(path.join(repository, "tracked.txt"), "second\n");
    let mutated = false;
    const actions = [];
    const service = createGitService({
      database: { auditAdmission: (action) => actions.push(action), auditCritical: (action) => actions.push(action) },
      getProjects: () => [{ worktrees: [{ path: repository }] }],
      getConfig: async () => ({ scanRoots: [root] }),
      subprocesses: { run: async (file, args, options) => {
        if (mutated && ["branch", "status", "log"].includes(args[2])) throw capacityError();
        const result = await execFileAsync(file, args, options);
        if (["add", "restore", "commit"].includes(args[2])) mutated = true;
        return result;
      } },
    });
    assert.deepEqual(await service.stage(repository, ["tracked.txt"]), { refreshDeferred: true });
    mutated = false;
    assert.deepEqual(await service.unstage(repository, ["tracked.txt"]), { refreshDeferred: true });
    mutated = false;
    await git(repository, ["add", "tracked.txt"]);
    const committed = await service.commit(repository, "capacity after effect");
    assert.equal(committed.refreshDeferred, true);
    assert.equal(committed.status, null);
    assert.match(committed.output, /capacity after effect/);
    const { stdout } = await execFileAsync("git", ["-C", repository, "log", "-1", "--format=%s"]);
    assert.equal(stdout.trim(), "capacity after effect");
    for (const action of ["git.stage", "git.unstage", "git.commit"]) assert.ok(actions.includes(action));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("reviews, stages, commits, creates, and safely removes discovered worktrees", async () => {
  const scanRoot = await mkdtemp(path.join(os.tmpdir(), "outright-git-test-"));
  const rawRepository = path.join(scanRoot, "project");
  const audit = [];
  try {
    await git(scanRoot, ["init", "project"]);
    const canonicalScanRoot = await realpath(scanRoot);
    const repository = await realpath(rawRepository);
    let projects = [{ id: "project", name: "project", path: repository, worktrees: [{ id: "main", path: repository, isLinked: false, changedCount: 0 }] }];
    await git(repository, ["config", "user.email", "outright@example.test"]);
    await git(repository, ["config", "user.name", "Outright Test"]);
    await writeFile(path.join(repository, "README.md"), "first\n");
    await git(repository, ["add", "README.md"]);
    await git(repository, ["commit", "-m", "initial"]);

    let interruptedRun = null;
    const service = createGitService({ database: { audit: (action, details) => audit.push({ action, details }), auditAdmission: (action, details) => audit.push({ action, details }), auditCritical: (action, details) => audit.push({ action, details }), getSettings: () => ({ editor: "zed" }), findUnresolvedInterruptedRunForWorktree: () => interruptedRun }, getProjects: () => projects, getConfig: async () => ({ scanRoots: [canonicalScanRoot] }) });
    await writeFile(path.join(repository, "README.md"), "first\nsecond\n");
    assert.equal((await service.status(repository)).unstagedCount, 1);
    assert.match((await service.diff(repository, "README.md")).diff, /\+second/);
    assert.equal((await service.stage(repository, ["README.md"])).stagedCount, 1);
    assert.equal((await service.unstage(repository, ["README.md"])).unstagedCount, 1);
    await service.stage(repository, ["README.md"]);
    assert.match((await service.commit(repository, "update docs")).output, /update docs/);

    const created = await service.createWorktree({ projectId: "project", branch: "feature/runtime", name: "project-runtime" });
    projects = [{ ...projects[0], worktrees: [...projects[0].worktrees, { id: "runtime", path: created.path, isLinked: true, changedCount: 0 }] }];
    assert.equal(await exists(created.path), true);
    interruptedRun = { id: "interrupted-run" };
    await assert.rejects(
      service.removeWorktree({ projectId: "project", worktreePath: created.path, confirmation: created.path }),
      /Resolve the interrupted run/,
    );
    assert.equal(await exists(created.path), true, "pending recovery prevents destructive worktree removal");
    interruptedRun = null;
    assert.equal((await service.removeWorktree({ projectId: "project", worktreePath: created.path, confirmation: created.path })).removed, true);
    assert.equal(await exists(created.path), false);
    assert.ok(audit.some((entry) => entry.action === "git.commit"));
    assert.ok(audit.some((entry) => entry.action === "git.worktree.removed"));
  } finally {
    await rm(scanRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("parses portable filenames and supported quote characters from NUL porcelain output", async () => {
  const scanRoot = await mkdtemp(path.join(os.tmpdir(), "outright-git-spaces-"));
  const rawRepository = path.join(scanRoot, "project");
  try {
    await git(scanRoot, ["init", "project"]);
    const canonicalScanRoot = await realpath(scanRoot);
    const repository = await realpath(rawRepository);
    const projects = [{ id: "project", name: "project", path: repository, worktrees: [{ id: "main", path: repository, isLinked: false, changedCount: 0 }] }];
    await git(repository, ["config", "user.email", "outright@example.test"]);
    await git(repository, ["config", "user.name", "Outright Test"]);
    const service = createGitService({ database: { audit: () => {}, auditAdmission: () => {}, auditCritical: () => {}, getSettings: () => ({ editor: "zed" }) }, getProjects: () => projects, getConfig: async () => ({ scanRoots: [canonicalScanRoot] }) });

    await writeFile(path.join(repository, "hello world.txt"), "hello\n");
    let status = await service.status(repository);
    assert.equal(status.files[0].path, "hello world.txt");
    assert.equal(status.files[0].worktree, "?");

    await service.stage(repository, ["hello world.txt"]);
    status = await service.status(repository);
    assert.equal(status.stagedCount, 1);
    await git(repository, ["commit", "-m", "add spaced file"]);

    await git(repository, ["mv", "hello world.txt", "renamed file.txt"]);
    status = await service.status(repository);
    const renamed = status.files.find((file) => file.index === "R");
    assert.equal(renamed.path, "renamed file.txt");
    assert.equal(renamed.originalPath, "hello world.txt");

    // Windows filesystems reject double quotes before Git can observe them.
    if (process.platform !== "win32") {
      await writeFile(path.join(repository, `quoted "name".txt`), "q\n");
      status = await service.status(repository);
      assert.ok(status.files.some((file) => file.path === `quoted "name".txt`));
    }
  } finally {
    await rm(scanRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("Git mutations refuse before changing the repository when audit admission is out of quota", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "outright-git-audit-"));
  let database;
  try {
    await git(root, ["init", "project"]);
    const canonicalRoot = await realpath(root);
    const repository = await realpath(path.join(root, "project"));
    await git(repository, ["config", "user.email", "outright@example.test"]);
    await git(repository, ["config", "user.name", "Outright Test"]);
    await writeFile(path.join(repository, "README.md"), "initial\n");
    await git(repository, ["add", "README.md"]);
    await git(repository, ["commit", "-m", "initial"]);
    await writeFile(path.join(repository, "README.md"), "changed\n");
    database = createOutrightDatabase({ filename: path.join(root, "runtime.db") });
    const conversation = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: repository, title: "quota", provider: "codex" });
    database.addMessage({ conversationId: conversation.id, role: "assistant", body: "x".repeat(65 * 1024 * 1024) });
    database.updateSettings({ maxRetainedMiB: 64 });
    const project = { id: "p", name: "project", path: repository, worktrees: [{ path: repository, isLinked: false }] };
    const service = createGitService({ database, getProjects: () => [project], getConfig: async () => ({ scanRoots: [canonicalRoot] }) });
    await assert.rejects(service.stage(repository, ["README.md"]), (error) => error.statusCode === 507);
    assert.equal((await service.status(repository)).stagedCount, 0);
    database.updateSettings({ maxRetainedMiB: 128 });
    assert.equal((await service.stage(repository, ["README.md"])).stagedCount, 1);
    const created = await service.createWorktree({ projectId: "p", branch: "feature/audit", name: "project-audit" });
    project.worktrees.push({ path: created.path, isLinked: true, changedCount: 0 });
    database.updateSettings({ maxRetainedMiB: 64 });
    await assert.rejects(service.unstage(repository, ["README.md"]), (error) => error.statusCode === 507);
    assert.equal((await service.status(repository)).stagedCount, 1);
    await assert.rejects(service.commit(repository, "must not commit"), (error) => error.statusCode === 507);
    assert.equal((await service.status(repository)).commits[0].subject, "initial");
    await assert.rejects(service.createWorktree({ projectId: "p", branch: "feature/refused", name: "project-refused" }), (error) => error.statusCode === 507);
    assert.equal(await exists(path.join(canonicalRoot, "project-refused")), false);
    await assert.rejects(service.removeWorktree({ projectId: "p", worktreePath: created.path, confirmation: created.path }), (error) => error.statusCode === 507);
    assert.equal(await exists(created.path), true);
    database.close();
    database = createOutrightDatabase({ filename: path.join(root, "runtime.db") });
    const actions = database.listAudit(10).map((entry) => entry.action);
    assert.equal(actions.filter((action) => action === "git.stage.requested").length, 1);
    assert.ok(!actions.includes("git.commit.requested"));
    assert.ok(!actions.includes("git.worktree.remove.requested"));
  } finally {
    database?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("a commit keeps its durable outcome when quota falls inside a Git hook", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "outright-git-outcome-"));
  const filename = path.join(root, "runtime.db");
  let database;
  try {
    await git(root, ["init", "project"]);
    const repository = await realpath(path.join(root, "project"));
    await git(repository, ["config", "user.email", "outright@example.test"]);
    await git(repository, ["config", "user.name", "Outright Test"]);
    await writeFile(path.join(repository, "README.md"), "initial\n");
    await git(repository, ["add", "README.md"]);
    await git(repository, ["commit", "-m", "initial"]);
    database = createOutrightDatabase({ filename });
    const conversation = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: repository, title: "quota", provider: "codex" });
    database.addMessage({ conversationId: conversation.id, role: "assistant", body: "x".repeat(65 * 1024 * 1024) });
    const project = { id: "p", name: "project", path: repository, worktrees: [{ path: repository, isLinked: false }] };
    const service = createGitService({ database, getProjects: () => [project], getConfig: async () => ({ scanRoots: [await realpath(root)] }) });
    await writeFile(path.join(repository, "README.md"), "changed\n");
    await service.stage(repository, ["README.md"]);
    const hook = path.join(repository, ".git", "hooks", "pre-commit");
    const entered = path.join(root, "hook-entered");
    const release = path.join(root, "hook-release");
    await writeFile(hook, `#!/bin/sh\ntouch '${entered}'\nwhile [ ! -f '${release}' ]; do sleep 0.01; done\n`);
    await chmod(hook, 0o755);
    const committing = service.commit(repository, "quota changed during hook");
    try {
      const hookDeadline = Date.now() + 8_000;
      while (!await exists(entered) && Date.now() < hookDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(await exists(entered), true, "Git never entered the hook");
      database.updateSettings({ maxRetainedMiB: 64 });
    } finally { await writeFile(release, "go"); }
    assert.match((await committing).output, /quota changed during hook/);
    database.close();
    database = createOutrightDatabase({ filename });
    const actions = database.listAudit(20).map((entry) => entry.action);
    assert.ok(actions.includes("git.commit.requested"));
    assert.ok(actions.includes("git.commit"), "successful commit lost its outcome after the quota changed");
    assert.equal((await service.status(repository)).commits[0].subject, "quota changed during hook");
  } finally {
    database?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("failed Git hooks and a later retry have separate durable outcomes", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "outright-git-retry-"));
  let database;
  try {
    await git(root, ["init", "project"]);
    const repository = await realpath(path.join(root, "project"));
    await git(repository, ["config", "user.email", "outright@example.test"]);
    await git(repository, ["config", "user.name", "Outright Test"]);
    await git(repository, ["commit", "--allow-empty", "-m", "initial"]);
    database = createOutrightDatabase({ filename: path.join(root, "runtime.db") });
    const project = { id: "p", path: repository, worktrees: [{ path: repository, isLinked: false }] };
    const service = createGitService({ database, getProjects: () => [project], getConfig: async () => ({ scanRoots: [root] }) });
    await writeFile(path.join(repository, "README.md"), "retry\n");
    await service.stage(repository, ["README.md"]);
    const hook = path.join(repository, ".git", "hooks", "pre-commit");
    await writeFile(hook, "#!/bin/sh\nexit 1\n");
    await chmod(hook, 0o755);
    await assert.rejects(service.commit(repository, "retry"));
    assert.equal((await service.status(repository)).commits[0].subject, "initial");
    await rm(hook);
    await service.commit(repository, "retry");
    const entries = database.listAudit(20).filter((entry) => entry.action.startsWith("git.commit"));
    const requests = entries.filter((entry) => entry.action === "git.commit.requested");
    assert.equal(requests.length, 2);
    assert.equal(new Set(requests.map((entry) => entry.details.operationId)).size, 2);
    for (const request of requests) {
      const outcomes = entries.filter((entry) => entry.details.operationId === request.details.operationId && entry.action !== request.action);
      assert.equal(outcomes.length, 1, "each attempt needs one terminal audit outcome");
    }
    assert.ok(entries.some((entry) => entry.action === "git.commit.failed"));
    assert.ok(entries.some((entry) => entry.action === "git.commit"));
  } finally {
    database?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("stage, unstage and worktree changes retain outcomes after quota changes at admission", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "outright-git-siblings-"));
  const filename = path.join(root, "runtime.db");
  let database;
  try {
    await git(root, ["init", "project"]);
    const repository = await realpath(path.join(root, "project"));
    await git(repository, ["config", "user.email", "outright@example.test"]);
    await git(repository, ["config", "user.name", "Outright Test"]);
    await writeFile(path.join(repository, "README.md"), "initial\n");
    await git(repository, ["add", "README.md"]);
    await git(repository, ["commit", "-m", "initial"]);
    database = createOutrightDatabase({ filename });
    const conversation = database.createConversation({ projectId: "p", worktreeId: "w", worktreePath: repository, title: "quota", provider: "codex" });
    database.addMessage({ conversationId: conversation.id, role: "assistant", body: "x".repeat(65 * 1024 * 1024) });
    const project = { id: "p", name: "project", path: repository, worktrees: [{ path: repository, isLinked: false }] };
    const service = createGitService({ database, getProjects: () => [project], getConfig: async () => ({ scanRoots: [await realpath(root)] }) });
    const admit = database.auditAdmission.bind(database);
    database.auditAdmission = (action, details) => {
      admit(action, details);
      database.updateSettings({ maxRetainedMiB: 64 });
    };
    const reset = () => database.updateSettings({ maxRetainedMiB: 128 });
    await writeFile(path.join(repository, "README.md"), "changed\n");
    await service.stage(repository, ["README.md"]);
    reset();
    await service.unstage(repository, ["README.md"]);
    reset();
    const linked = await service.createWorktree({ projectId: "p", branch: "feature/outcome", name: "project-outcome" });
    project.worktrees.push({ path: linked.path, isLinked: true, changedCount: 0 });
    reset();
    await service.removeWorktree({ projectId: "p", worktreePath: linked.path, confirmation: linked.path });
    database.close();
    database = createOutrightDatabase({ filename });
    const actions = database.listAudit(30).map((entry) => entry.action);
    for (const action of ["git.stage", "git.unstage", "git.worktree.created", "git.worktree.removed"]) {
      assert.ok(actions.includes(action), `${action} was lost when the quota changed during its command`);
    }
  } finally {
    database?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("a timed out Git mutation keeps its admission unresolved for inspection", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "outright-git-timeout-")));
  const actions = [];
  const service = createGitService({
    database: { auditAdmission: (action) => actions.push(action), auditCritical: (action) => actions.push(action) },
    getProjects: () => [{ worktrees: [{ path: root }] }], getConfig: async () => ({ scanRoots: [root] }),
    subprocesses: { run: async () => { throw Object.assign(new Error("Git timed out"), { killed: true, signal: "SIGTERM" }); } },
  });
  try {
    await assert.rejects(service.stage(root, ["README.md"]), (error) =>
      error.statusCode === 503 && error.details?.outcomeUnknown === true);
    assert.deepEqual(actions, ["git.stage.requested"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an unaudited post-commit outcome reports a recoverable unknown operation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "outright-git-unknown-"));
  const filename = path.join(root, "runtime.db");
  let database;
  try {
    await git(root, ["init", "project"]);
    const repository = await realpath(path.join(root, "project"));
    await git(repository, ["config", "user.email", "outright@example.test"]);
    await git(repository, ["config", "user.name", "Outright Test"]);
    await git(repository, ["commit", "--allow-empty", "-m", "initial"]);
    database = createOutrightDatabase({ filename });
    const project = { id: "p", path: repository, worktrees: [{ path: repository, isLinked: false }] };
    const service = createGitService({ database, getProjects: () => [project], getConfig: async () => ({ scanRoots: [root] }) });
    await writeFile(path.join(repository, "README.md"), "effect\n");
    await service.stage(repository, ["README.md"]);
    const required = database.auditCritical.bind(database);
    database.auditCritical = (action, details) => {
      if (action === "git.commit") throw Object.assign(new Error("storage interrupted"), { code: "SQLITE_BUSY" });
      return required(action, details);
    };
    await assert.rejects(service.commit(repository, "effect may have completed"), (error) =>
      error.statusCode === 503 && error.details?.outcomeUnknown === true && Boolean(error.details.operationId));
    assert.equal((await service.status(repository)).commits[0].subject, "effect may have completed");
    database.close();
    database = createOutrightDatabase({ filename });
    const entries = database.listAudit(10).filter((entry) => entry.action.startsWith("git.commit"));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].action, "git.commit.requested");
    assert.ok(entries[0].details.operationId);
  } finally {
    database?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

async function git(cwd, args) {
  await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

async function exists(target) {
  try { await access(target); return true; }
  catch { return false; }
}
