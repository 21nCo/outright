import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { decodeRecords, encodeRecord, openTerminalHistory, TERMINAL_HISTORY_LIMITS, windowsAclPrivate } from "./terminal-history.mjs";
import { createTerminalManager } from "./terminal-manager.mjs";
import { createOutrightDatabase } from "./database.mjs";
import { hardenWindowsLaunchDirectory } from "./agent-manager.mjs";

const MiB = 1024 * 1024;
const fakeDatabase = () => ({ audit() {}, auditAdmission() {}, auditCritical() {}, auditRequired: async () => {} });

function workspace(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "outright-history-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, directory: path.join(root, "terminal-history") };
}
function terminalFiles(directory, id) { return readdirSync(directory).filter((name) => name.startsWith(id)); }
function terminalBytes(directory, id) { return terminalFiles(directory, id).reduce((sum, name) => sum + statSync(path.join(directory, name)).size, 0); }
function begin(store, id = randomUUID(), extra = {}) {
  assert.equal(store.begin({ id, name: "Shell", cwd: "/work/tree", createdAt: "2026-10-21T00:00:00.000Z", ...extra }), true);
  return id;
}
function fakePty() {
  const pty = { pid: 1000 + Math.floor(Math.random() * 1000), write() {}, resize() {}, kill() {} };
  pty.onData = (callback) => { pty.emit = callback; };
  pty.onExit = (callback) => { pty.exit = callback; };
  return pty;
}
function manager(store, options = {}) {
  const ptys = [];
  const instance = createTerminalManager({ database: fakeDatabase(), publish: () => {}, history: store, terminate: async () => {},
    spawnTerminal: () => { const pty = fakePty(); ptys.push(pty); return pty; }, ...options });
  return { manager: instance, ptys };
}
async function waitFor(predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for terminal history");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
// The platform's own permission model: POSIX mode bits or a Windows ACE.
function grantEveryone(target) {
  if (process.platform !== "win32") { chmodSync(target, statSync(target).isDirectory() ? 0o755 : 0o644); return; }
  const result = spawnSync("icacls", [target, "/grant", "*S-1-1-0:(R)"], { stdio: "ignore" });
  assert.equal(result.status, 0, "icacls could not grant Everyone read access");
}

test("history limits match the product decisions", () => {
  assert.equal(TERMINAL_HISTORY_LIMITS.terminalBytes, 2 * MiB);
  assert.equal(TERMINAL_HISTORY_LIMITS.totalBytes, 64 * MiB);
  assert.equal(TERMINAL_HISTORY_LIMITS.retentionMs, 7 * 24 * 60 * 60 * 1000);
});

test("a torn or corrupt final record is dropped and earlier records survive a crash", (t) => {
  const records = Buffer.concat([encodeRecord(2, "first\n"), encodeRecord(2, "second\n")]);
  const torn = Buffer.concat([records, encodeRecord(2, "third\n").subarray(0, 19)]);
  assert.deepEqual(decodeRecords(torn).records.map(({ payload }) => payload.toString()), ["first\n", "second\n"]);
  assert.equal(decodeRecords(torn).torn, true);
  const flipped = Buffer.concat([records, encodeRecord(2, "third\n")]);
  flipped[flipped.length - 1] ^= 0xff;
  assert.deepEqual(decodeRecords(flipped).records.map(({ payload }) => payload.toString()), ["first\n", "second\n"]);

  const { directory } = workspace(t);
  const store = openTerminalHistory({ directory });
  const id = begin(store);
  store.append(id, "kept before crash\n");
  store.finish(id);
  // Simulate a crash during the next append: only part of a frame landed.
  const segment = path.join(directory, terminalFiles(directory, id).find((name) => name.endsWith(".log")));
  appendFileSync(segment, encodeRecord(2, "lost in crash\n").subarray(0, 21));
  store.close();
  const restored = openTerminalHistory({ directory });
  assert.equal(restored.read(id), "kept before crash\n");
  assert.equal(restored.saved()[0].endReason, "restart");
  restored.close();
});

test("each terminal keeps at most 2 MiB, dropping its oldest output first", (t) => {
  const { directory } = workspace(t);
  const store = openTerminalHistory({ directory });
  const id = begin(store);
  const chunk = (index) => `${String(index).padStart(6, "0")}:${"x".repeat(64 * 1024 - 8)}\n`;
  for (let index = 0; index < 80; index += 1) store.append(id, chunk(index));
  store.end(id, { exitCode: 0 });
  assert.ok(terminalBytes(directory, id) <= 2 * MiB, `terminal history used ${terminalBytes(directory, id)} bytes`);
  const restored = store.read(id);
  assert.ok(restored.endsWith(chunk(79)), "the newest output was not kept");
  assert.ok(!restored.includes("000000:"), "the oldest output was not dropped first");
  assert.ok(restored.length >= MiB / 2, "the cap dropped more than its oldest segment");
  store.close();
});

test("the global quota evicts the oldest ended terminals before newer or running ones", (t) => {
  const { directory } = workspace(t);
  let clock = 1_000;
  const limits = { ...TERMINAL_HISTORY_LIMITS, terminalBytes: 64 * 1024, totalBytes: 80 * 1024, fileBytes: 0 };
  const store = openTerminalHistory({ directory, limits, now: () => clock });
  const block = "y".repeat(20 * 1024);
  const [oldest, middle, newest, running] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  for (const id of [oldest, middle, newest, running]) {
    begin(store, id);
    store.append(id, block);
    store.append(id, block);
  }
  for (const id of [middle, oldest, newest]) { clock += 1_000; store.end(id, { exitCode: 0 }); }
  // `middle` ended first, so it is the oldest ended terminal.
  store.append(running, block.repeat(2));
  assert.ok(store.usage().totalBytes <= limits.totalBytes);
  assert.deepEqual([middle, oldest, newest, running].map((id) => store.has(id)), [false, true, true, true],
    "one eviction did not take exactly the oldest ended terminal");
  assert.deepEqual(terminalFiles(directory, middle), []);
  store.append(running, block.repeat(2));
  store.append(running, block.repeat(2));
  store.finish(running);
  assert.ok(store.usage().totalBytes <= limits.totalBytes);
  assert.equal(store.has(running), true, "a running terminal was evicted");
  assert.equal(store.has(newest), true, "the newest ended terminal was evicted before older ones");
  const total = readdirSync(directory).reduce((sum, name) => sum + statSync(path.join(directory, name)).size, 0);
  assert.equal(total, store.usage().totalBytes, "accounted bytes differ from bytes on disk");
  store.close();

  // Running terminals alone over the cap give up their oldest output.
  const busy = openTerminalHistory({ directory: path.join(directory, "..", "busy"), limits: { ...limits, totalBytes: 40 * 1024 } });
  const shells = [randomUUID(), randomUUID(), randomUUID()].map((id) => begin(busy, id));
  for (const id of shells) for (let index = 0; index < 4; index += 1) busy.append(id, `${index}:${block}`);
  assert.ok(busy.usage().totalBytes <= 40 * 1024, `running histories used ${busy.usage().totalBytes} bytes`);
  assert.ok(shells.every((id) => busy.has(id)), "a running terminal was evicted");
  assert.ok(busy.read(shells[2]).endsWith(`3:${block}`), "the latest running output was dropped before older output");
  busy.close();
});

test("every history file is charged against the global quota, so tiny sessions cannot accumulate", (t) => {
  const { directory } = workspace(t);
  let clock = 1_000;
  const limits = { ...TERMINAL_HISTORY_LIMITS, terminalBytes: 64 * 1024, totalBytes: 64 * 1024 };
  const store = openTerminalHistory({ directory, limits, now: () => clock });
  const ids = [];
  for (let index = 0; index < 40; index += 1) {
    const id = begin(store);
    store.append(id, `${index}\n`);
    clock += 1;
    store.end(id, { exitCode: 0 });
    ids.push(id);
  }
  const files = readdirSync(directory);
  const disk = files.reduce((sum, name) => sum + statSync(path.join(directory, name)).size, 0);
  assert.equal(store.usage().totalBytes, disk + files.length * limits.fileBytes);
  assert.ok(store.usage().totalBytes <= limits.totalBytes);
  assert.ok(store.usage().terminals < 10, `${store.usage().terminals} tiny sessions escaped the per-file charge`);
  assert.equal(store.has(ids.at(-1)), true, "the newest ended terminal was evicted");
  assert.equal(store.has(ids[0]), false, "the oldest ended terminal was kept");
  store.close();
  // A restart enumerates and charges every file again.
  const reopened = openTerminalHistory({ directory, limits, now: () => clock });
  assert.equal(reopened.usage().totalBytes, store.usage().totalBytes);
  reopened.close();
});

test("ended terminals are kept for seven days and then removed", (t) => {
  const { directory } = workspace(t);
  const day = 24 * 60 * 60 * 1000;
  let clock = Date.UTC(2026, 9, 1);
  const store = openTerminalHistory({ directory, now: () => clock });
  const expired = begin(store);
  const kept = begin(store);
  store.end(expired, { exitCode: 3 });
  clock += 2 * day;
  store.end(kept, { exitCode: 4 });
  store.close();
  clock += 7 * day - 1;
  const reopened = openTerminalHistory({ directory, now: () => clock });
  assert.deepEqual(reopened.saved().map((entry) => entry.id), [kept]);
  assert.deepEqual(terminalFiles(directory, expired), [], "expired history stayed on disk");
  clock += 2 * day;
  assert.deepEqual(reopened.saved(), [], "a running store did not expire history");
  assert.deepEqual(terminalFiles(directory, kept), []);
  reopened.close();
});

test("a session ended by restart is kept seven days from that restart, which a later restart cannot extend", (t) => {
  const { directory } = workspace(t);
  const day = 24 * 60 * 60 * 1000;
  let clock = Date.UTC(2026, 9, 1);
  const store = openTerminalHistory({ directory, now: () => clock });
  const crashed = begin(store);
  const shutDown = begin(store);
  store.append(crashed, "idle for weeks\n");
  store.append(shutDown, "stopped cleanly\n");
  // Idle output is old, then the runtime crashes without finish() for one
  // terminal and shuts down cleanly for the other.
  clock += 10 * day;
  store.finish(shutDown);
  store.close();
  clock += 1_000;
  const first = openTerminalHistory({ directory, now: () => clock });
  assert.deepEqual(first.saved().map((entry) => [entry.id, entry.endReason]).sort(),
    [[crashed, "restart"], [shutDown, "restart"]].sort(), "an idle session was dropped instead of restored");
  assert.equal(first.read(crashed), "idle for weeks\n");
  first.close();

  clock += 6 * day;
  const second = openTerminalHistory({ directory, now: () => clock });
  assert.equal(second.saved().length, 2, "a session expired before seven days after its restart");
  second.close();
  clock += day;
  const third = openTerminalHistory({ directory, now: () => clock });
  assert.deepEqual(third.saved(), [], "a later restart extended retention");
  assert.deepEqual(readdirSync(directory), []);
  third.close();
});

test("published output survives an abrupt process exit without finish, close or read", { timeout: 20_000 }, (t) => {
  const { directory } = workspace(t);
  const id = randomUUID();
  const module = new URL("./terminal-history.mjs", import.meta.url).href;
  const script = `import { openTerminalHistory } from ${JSON.stringify(module)};
const store = openTerminalHistory({ directory: ${JSON.stringify(directory)} });
store.begin({ id: ${JSON.stringify(id)}, name: "Shell", cwd: "/work/tree", createdAt: "2026-10-21T00:00:00.000Z" }, "first\\n");
store.append(${JSON.stringify(id)}, "published just before the crash\\n");
process.kill(process.pid, "SIGKILL");`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  assert.ok(child.signal === "SIGKILL" || child.status !== 0, `the child exited normally: ${child.stderr}`);
  const restored = openTerminalHistory({ directory });
  assert.equal(restored.read(id), "first\npublished just before the crash\n");
  assert.equal(restored.saved()[0].endReason, "restart");
  restored.close();
});

test("an unsafe history directory or file is refused and terminals keep working in memory", async (t) => {
  const { root, directory } = workspace(t);
  const seed = openTerminalHistory({ directory });
  const id = begin(seed);
  seed.append(id, "private output\n");
  seed.end(id, { exitCode: 0 });
  seed.close();
  if (process.platform === "win32") hardenWindowsLaunchDirectory(directory);
  const before = readdirSync(directory).sort();

  // Wrong owner: the platform owner check compares against another account.
  const otherUser = process.platform === "win32" ? { user: "S-1-5-21-1-2-3-1001", groups: [] } : { uid: process.getuid() + 1 };
  const foreign = openTerminalHistory({ directory, identity: otherUser });
  assert.equal(foreign.status().persistent, false);
  assert.match(foreign.status().warning, /not private to this user/);
  assert.deepEqual(foreign.saved(), [], "history was read from a directory owned by someone else");

  // Wrong permissions on a history file, then on the directory itself.
  const meta = path.join(directory, `${id}.meta`);
  grantEveryone(meta);
  const openFile = openTerminalHistory({ directory });
  assert.equal(openFile.status().persistent, false);
  assert.deepEqual(openFile.saved(), []);
  if (process.platform === "win32") assert.equal(spawnSync("icacls", [meta, "/remove:g", "*S-1-1-0"], { stdio: "ignore" }).status, 0);
  else chmodSync(meta, 0o600);
  assert.equal(openTerminalHistory({ directory }).status().persistent, true, "restoring the file permission did not restore trust");
  grantEveryone(directory);
  const openDirectory = openTerminalHistory({ directory });
  assert.equal(openDirectory.status().persistent, false);
  assert.equal(openDirectory.begin({ id: randomUUID(), name: "Shell", cwd: "/w", createdAt: "now" }), false);

  const link = path.join(root, "linked-history");
  symlinkSync(directory, link, process.platform === "win32" ? "junction" : "dir");
  assert.equal(openTerminalHistory({ directory: link }).status().persistent, false, "a linked history directory was trusted");
  assert.deepEqual(readdirSync(directory).sort(), before, "a refused store changed its directory");

  const { manager: terminals, ptys } = manager(openDirectory);
  const terminal = terminals.create({ cwd: "/work/tree", name: "Memory" });
  ptys[0].emit("still visible\n");
  assert.equal(terminals.get(terminal.id).buffer, "still visible\n");
  assert.match(terminals.historyStatus().warning, /not private/);
  await terminals.shutdown();
});

test("a Windows ACL is private only when owned by the user and closed to other principals", () => {
  const user = "S-1-5-21-9-9-9-1001";
  const report = (entries, groups = []) => ({ user, groups, entries });
  const item = (owner, allow) => ({ name: "terminal-history", owner, reparse: false, allow });
  assert.equal(windowsAclPrivate(report([item(user, [user, "S-1-5-18", "S-1-5-32-544"])])), true);
  assert.equal(windowsAclPrivate(report([item("S-1-5-32-544", [user])], ["S-1-5-32-544"])), true);
  assert.equal(windowsAclPrivate(report([item("S-1-5-32-544", [user])])), false, "a group the user does not hold owned the store");
  assert.equal(windowsAclPrivate(report([item(user, [user, "S-1-1-0"])])), false, "Everyone access was accepted");
  assert.equal(windowsAclPrivate(report([item(user, [user, "S-1-5-32-545"])])), false, "Users access was accepted");
  assert.equal(windowsAclPrivate(report([{ ...item(user, [user]), reparse: true }])), false, "a reparse point was accepted");
  assert.equal(windowsAclPrivate(report([])), false);
});

test("restart restores saved output as ended, never running, and a relaunch is a new shell", async (t) => {
  const { directory } = workspace(t);
  const first = manager(openTerminalHistory({ directory }));
  const exited = first.manager.create({ cwd: "/work/tree", name: "Build" });
  const running = first.manager.create({ cwd: "/work/tree", name: "Server" });
  first.ptys[0].emit("make: done\n");
  first.ptys[1].emit("listening on 3000\n");
  first.ptys[0].exit({ exitCode: 7, signal: 0 });
  await waitFor(() => first.manager.get(exited.id).status === "exited");
  await first.manager.shutdown();

  const second = manager(openTerminalHistory({ directory }));
  const listed = second.manager.list();
  assert.deepEqual(listed.map(({ id, status, endReason, exitCode, pid }) => ({ id, status, endReason, exitCode, pid })).sort((a, b) => a.id.localeCompare(b.id)),
    [{ id: exited.id, status: "ended", endReason: "exit", exitCode: 7, pid: null },
      { id: running.id, status: "ended", endReason: "restart", exitCode: null, pid: null }].sort((a, b) => a.id.localeCompare(b.id)));
  assert.equal(second.manager.get(running.id).buffer, "listening on 3000\n");
  assert.equal(second.manager.get(exited.id).buffer, "make: done\n");
  assert.equal(second.manager.write(running.id, "ls\r"), false, "saved output accepted input");
  assert.equal(second.manager.resize(running.id, 80, 24), false);
  assert.equal(second.manager.capacity().active, 0, "a saved session was charged as a process");

  assert.throws(() => second.manager.create({ cwd: "/work/tree", relaunchedFrom: "../escape" }), (error) => error.statusCode === 400);
  const relaunched = second.manager.create({ cwd: "/work/tree", name: "Server", relaunchedFrom: running.id });
  assert.notEqual(relaunched.id, running.id);
  assert.equal(relaunched.status, "running");
  assert.equal(relaunched.relaunchedFrom, running.id);
  assert.equal(second.manager.get(relaunched.id).buffer, "", "a relaunched shell inherited the saved session");
  assert.equal(second.manager.list().find((entry) => entry.id === running.id).status, "ended");
  await second.manager.shutdown();
});

test("close and dismiss remove history; shutdown keeps it", async (t) => {
  const { directory } = workspace(t);
  const first = manager(openTerminalHistory({ directory }));
  const closed = first.manager.create({ cwd: "/work/tree" });
  const kept = first.manager.create({ cwd: "/work/tree" });
  first.ptys[0].emit("closing soon\n");
  first.ptys[1].emit("survives restart\n");
  assert.equal(await first.manager.close(closed.id), true);
  assert.deepEqual(terminalFiles(directory, closed.id), [], "closing a terminal kept its history");
  await first.manager.shutdown();
  assert.notDeepEqual(terminalFiles(directory, kept.id), [], "shutdown deleted history");

  const second = manager(openTerminalHistory({ directory }));
  assert.deepEqual(second.manager.list().map((entry) => entry.id), [kept.id]);
  assert.equal(await second.manager.close(kept.id), true);
  assert.deepEqual(terminalFiles(directory, kept.id), [], "dismissing a saved terminal kept its history");
  assert.deepEqual(second.manager.list(), []);
  assert.equal(await second.manager.close(kept.id), false);
  await second.manager.shutdown();
});

test("a user's close that shutdown joins still removes its history", async (t) => {
  const { directory } = workspace(t);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const { manager: terminals } = manager(openTerminalHistory({ directory }), { terminate: () => held });
  const terminal = terminals.create({ cwd: "/work/tree" });
  const closing = terminals.close(terminal.id);
  const stopping = terminals.shutdown();
  release();
  assert.equal(await closing, true);
  await stopping;
  assert.deepEqual(terminalFiles(directory, terminal.id), [], "shutdown kept a terminal the user closed");
  const reopened = openTerminalHistory({ directory });
  assert.deepEqual(reopened.saved(), []);
  reopened.close();
});

test("a failed history removal is reported and the session stays listed instead of reappearing later", async (t) => {
  const { directory } = workspace(t);
  const seed = openTerminalHistory({ directory });
  const id = begin(seed);
  seed.end(id, { exitCode: 0 });
  seed.close();
  const events = [];
  const store = openTerminalHistory({ directory, onStatusChange: (status) => events.push(status) });
  const { manager: terminals } = manager(store);
  const live = terminals.create({ cwd: "/work/tree", name: "Live" });
  // A directory in place of the metadata makes its removal fail everywhere.
  for (const target of [id, live.id]) {
    rmSync(path.join(directory, `${target}.meta`));
    mkdirSync(path.join(directory, `${target}.meta`));
  }
  await assert.rejects(terminals.close(id), (error) => error.statusCode === 503 && /could not be deleted/.test(error.message));
  assert.equal(terminals.list().find((entry) => entry.id === id)?.status, "ended", "an undeleted session disappeared until restart");
  assert.equal(store.status().persistent, false);
  assert.equal(events.length, 1, "the persistence change was not reported exactly once");
  assert.match(events[0].warning, /could not be saved/);
  await assert.rejects(terminals.close(live.id), (error) => error.statusCode === 503);
  const closed = terminals.list().find((entry) => entry.id === live.id);
  assert.deepEqual([closed?.status, closed?.endReason], ["ended", "closed"], "a closed terminal was not labelled closed");
  await terminals.shutdown();
});

test("a verified exit whose audit fails is still restored with its exit status", async (t) => {
  const { directory } = workspace(t);
  const database = { ...fakeDatabase(), auditRequired: async (action) => { if (action === "terminal.exited") throw new Error("audit unavailable"); } };
  const first = manager(openTerminalHistory({ directory }), { database });
  const terminal = first.manager.create({ cwd: "/work/tree" });
  first.ptys[0].exit({ exitCode: 5, signal: 0 });
  await waitFor(() => first.manager.get(terminal.id).status === "unknown");
  await first.manager.shutdown();
  const restored = openTerminalHistory({ directory });
  assert.deepEqual(restored.saved().map(({ endReason, exitCode }) => ({ endReason, exitCode })), [{ endReason: "exit", exitCode: 5 }]);
  restored.close();
});

test("a prior-run owner awaiting proof stays recovery-only even with saved output", async (t) => {
  const { directory } = workspace(t);
  const seed = openTerminalHistory({ directory });
  const id = begin(seed, randomUUID(), { cwd: "/work/tree" });
  seed.append(id, "before crash\n");
  seed.finish(id);
  seed.close();
  let reservations = [{ target: id, cwd: "/work/tree", pid: 4242 }];
  let proven = false;
  const database = { ...fakeDatabase(), launchDirectory: path.dirname(directory), terminalUnknownReservations: () => reservations,
    resolveTerminalUnknown: (target) => { assert.equal(target, id); reservations = []; } };
  const published = [];
  const terminals = createTerminalManager({ database, publish: (event) => published.push(event), history: openTerminalHistory({ directory }),
    recoverTerminal: async () => proven, cleanupSocket: () => {} });
  assert.deepEqual(terminals.list().map(({ id: listed, status, recoveryReservation }) => ({ id: listed, status, recoveryReservation })),
    [{ id, status: "unknown", recoveryReservation: true }], "a prior-run PID was listed as live, ended or twice");
  assert.equal(terminals.get(id).status, "unknown");
  assert.equal(terminals.get(id).buffer, "before crash\n");
  assert.equal(terminals.write(id, "x"), false);
  assert.equal(await terminals.close(id), false, "a recovery reservation was dismissed before proof");
  assert.equal(terminals.capacity().unknown, 1);
  assert.equal(await terminals.reconcileUnknown(), 0);
  assert.equal(terminals.list()[0].status, "unknown");
  proven = true;
  assert.equal(await terminals.reconcileUnknown(), 1);
  assert.deepEqual(terminals.list().map(({ status, endReason, pid }) => ({ status, endReason, pid })), [{ status: "ended", endReason: "restart", pid: null }]);
  const restored = published.filter((event) => event.type === "terminal.restored");
  assert.deepEqual(restored.map(({ terminalId, payload }) => [terminalId, payload.status, payload.name, payload.recoveryReservation]),
    [[id, "ended", "Shell", undefined]], "a client showing the reservation was not told it ended");
  assert.equal(terminals.capacity().active, 0);
  await terminals.shutdown();
});

test("while the audit scan is pending a session with no recorded exit is not shown as ended", async (t) => {
  const { directory } = workspace(t);
  const seed = openTerminalHistory({ directory });
  const unproven = begin(seed);
  const exited = begin(seed);
  seed.append(unproven, "maybe still running\n");
  seed.end(exited, { exitCode: 2 });
  seed.finish(unproven);
  seed.close();
  let scanning = true;
  const database = { ...fakeDatabase(), get terminalAuditScanPending() { return scanning; }, terminalUnknownReservations: () => [] };
  const published = [];
  const terminals = createTerminalManager({ database, publish: (event) => published.push(event), history: openTerminalHistory({ directory }) });
  const status = () => Object.fromEntries(terminals.list().map((entry) => [entry.id, entry.status]));
  assert.deepEqual(status(), { [unproven]: "unknown", [exited]: "ended" });
  assert.equal(terminals.get(unproven).status, "unknown");
  assert.equal(terminals.get(unproven).buffer, "maybe still running\n");
  assert.equal(await terminals.close(unproven), false, "an unverified session was dismissed during the scan");
  scanning = false;
  terminals.reloadUnknownReservations();
  assert.deepEqual(status(), { [unproven]: "ended", [exited]: "ended" });
  assert.equal(terminals.get(unproven).endReason, "restart");
  assert.deepEqual(published.filter((event) => event.type === "terminal.restored").map((event) => event.terminalId), [unproven],
    "only the masked session was announced as restored");
  await terminals.shutdown();
});

test("a real terminal's output is restored from the launch directory after the runtime restarts", { timeout: 30_000 }, async (t) => {
  const { root } = workspace(t);
  const filename = path.join(root, "runtime.db");
  let database = createOutrightDatabase({ filename, runtimeLease: true });
  let terminals = createTerminalManager({ publish: () => {}, database });
  let id;
  try {
    ({ id } = await terminals.create({ cwd: root, name: "Restored" }));
    const shell = process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "/bin/sh");
    terminals.write(id, /(?:powershell|pwsh)(?:\.exe)?$/i.test(shell) ? "Write-Output ('saved-' + 'scrollback')\r" : "printf 'saved-%s\\n' scrollback\r");
    await waitFor(() => terminals.get(id)?.buffer.includes("saved-scrollback"), 15_000);
    await terminals.shutdown();
    database.close();
    assert.ok(existsSync(path.join(root, "launches", "terminal-history", `${id}.meta`)));
    database = createOutrightDatabase({ filename, runtimeLease: true });
    terminals = createTerminalManager({ publish: () => {}, database });
    assert.deepEqual(terminals.historyStatus(), { persistent: true, warning: null });
    const restored = terminals.get(id);
    assert.equal(restored.status, "ended");
    assert.equal(restored.endReason, "restart");
    assert.match(restored.buffer, /saved-scrollback/);
    if (process.platform !== "win32") {
      assert.equal(statSync(path.join(root, "launches", "terminal-history")).mode & 0o777, 0o700);
      for (const name of readdirSync(path.join(root, "launches", "terminal-history"))) {
        assert.equal(statSync(path.join(root, "launches", "terminal-history", name)).mode & 0o777, 0o600);
      }
    }
  } finally {
    await terminals.shutdown();
    database.close();
  }
});

test("a store that cannot write stops persisting and reports why", (t) => {
  const { directory } = workspace(t);
  const store = openTerminalHistory({ directory, limits: { ...TERMINAL_HISTORY_LIMITS, terminalBytes: 64 * 1024 } });
  const id = begin(store);
  // Occupy the next segment name so rotation fails like a full disk would.
  mkdirSync(path.join(directory, `${id}.2.log`));
  store.append(id, "x".repeat(70 * 1024));
  assert.equal(store.status().persistent, true);
  store.append(id, "y".repeat(70 * 1024));
  assert.equal(store.status().persistent, false);
  assert.match(store.status().warning, /could not be saved \(EEXIST\)/);
  store.append(id, "z".repeat(70 * 1024));
  assert.equal(store.read(id).length, 24 * 1024 - 16, "a disabled store kept writing");
  store.close();
});
