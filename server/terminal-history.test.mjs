import assert from "node:assert/strict";
import test, { mock } from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { decodeRecords, encodeRecord, openTerminalHistory, probeWindowsHistoryAcl, TERMINAL_HISTORY_LIMITS, windowsAclPrivate } from "./terminal-history.mjs";
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
// Bytes on disk plus the per-file charge: what usage() must account for.
function diskCharge(directory, fileBytes) {
  const files = readdirSync(directory).map((name) => statSync(path.join(directory, name))).filter((stat) => stat.isFile());
  return files.reduce((sum, stat) => sum + stat.size + fileBytes, 0);
}
// Output removal for the returned ids fails as under a Windows antivirus or
// indexer lock, on every platform.
function lockOutput(t) {
  const locked = new Set();
  const rm = fs.rmSync;
  mock.method(fs, "rmSync", (target, options) => {
    const name = path.basename(String(target));
    if (name.endsWith(".log") && locked.has(name.slice(0, 36))) throw Object.assign(new Error("resource busy or locked"), { code: "EBUSY" });
    return rm(target, options);
  });
  syncBuiltinESMExports();
  t.after(() => { mock.restoreAll(); syncBuiltinESMExports(); });
  return locked;
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
  await Promise.resolve();
  assert.equal(published.filter((event) => event.type === "terminals.changed").length, 1,
    "a client showing the reservation was not told to re-list it");
  const [listed] = terminals.list();
  assert.deepEqual([listed.name, listed.recoveryReservation], ["Shell", undefined], "the restored listing kept reservation fields");
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
  await Promise.resolve();
  assert.equal(published.filter((event) => event.type === "terminals.changed").length, 1, "the scan result was not announced once");
  await terminals.shutdown();
});

test("quota eviction, retention expiry and dismissal each tell clients to re-list", async (t) => {
  const { directory } = workspace(t);
  let clock = Date.parse("2026-10-21T00:00:00.000Z");
  const limits = { ...TERMINAL_HISTORY_LIMITS, terminalBytes: 64 * 1024, totalBytes: 28 * 1024, fileBytes: 1024 };
  const seed = openTerminalHistory({ directory, limits, now: () => clock });
  const [oldest, expiring, dismissed] = [begin(seed), begin(seed), begin(seed)];
  for (const id of [oldest, expiring, dismissed]) { clock += 1000; seed.end(id, { exitCode: 0 }); }
  seed.close();
  const published = [];
  const store = openTerminalHistory({ directory, limits, now: () => clock });
  const { manager: terminals, ptys } = manager(store, { publish: (event) => published.push(event) });
  const changes = async () => { await Promise.resolve(); return published.splice(0).filter((event) => event.type === "terminals.changed").length; };
  const listed = () => terminals.list().map((entry) => entry.id);

  const live = terminals.create({ cwd: "/work/tree" });
  await changes();
  ptys[0].emit("x".repeat(20 * 1024));
  assert.equal(listed().includes(oldest), false, "the quota did not evict the oldest saved session");
  assert.equal(await changes(), 1, "quota eviction was not announced");

  clock += TERMINAL_HISTORY_LIMITS.retentionMs;
  assert.deepEqual(listed().filter((id) => id !== live.id), [], "expired sessions were still listed");
  assert.equal(await changes(), 1, "retention expiry was not announced once");

  const saved = begin(store);
  store.end(saved, { exitCode: 1 });
  await changes();
  assert.equal(await terminals.close(saved), true);
  assert.equal(await changes(), 1, "dismissal was not announced to other clients");
  await terminals.shutdown();
});

test("an exited terminal leaving memory becomes saved output and tells clients to re-list once", async (t) => {
  const { directory } = workspace(t);
  const published = [];
  const changes = async () => { await Promise.resolve(); return published.splice(0).filter((event) => event.type === "terminals.changed").length; };
  // The live tail keeps 16 characters; the saved session serves them all.
  const output = "build output that outgrows the live tail\n";
  const exited = async ({ manager: terminals, ptys }, cwd = "/work/tree") => {
    const terminal = terminals.create({ cwd, name: "Build" });
    ptys.at(-1).emit(output);
    ptys.at(-1).exit({ exitCode: 3, signal: 0 });
    await waitFor(() => terminals.get(terminal.id).status === "exited");
    await changes();
    return terminal.id;
  };
  const savedAs = (terminals, id) => {
    const { status, endReason, exitCode, pid, buffer } = terminals.get(id);
    assert.deepEqual({ status, endReason, exitCode, pid, buffer }, { status: "ended", endReason: "exit", exitCode: 3, pid: null, buffer: output });
    assert.equal(terminals.list().find((entry) => entry.id === id)?.status, "ended");
  };
  const options = { publish: (event) => published.push(event), maxBufferChars: 16 };

  const expiring = manager(openTerminalHistory({ directory }), { ...options, exitedRetentionMs: 30 });
  const expired = await exited(expiring);
  await waitFor(() => expiring.manager.list().find((entry) => entry.id === expired)?.status === "ended");
  assert.equal(await changes(), 1, "retention of an exited terminal did not tell clients it is now saved");
  savedAs(expiring.manager, expired);
  await expiring.manager.shutdown();

  for (const [name, limits, cwd] of [["global", { maxTerminals: 2 }, "/work/other"], ["per-worktree", { maxTerminalsPerCwd: 1 }, "/work/tree"]]) {
    const pruning = manager(openTerminalHistory({ directory }), { ...options, ...limits });
    const pruned = await exited(pruning);
    if (name === "global") pruning.manager.create({ cwd: "/work/tree" });
    await changes();
    pruning.manager.create({ cwd });
    assert.equal(await changes(), 1, `${name} capacity pruning did not tell clients the exited terminal is now saved`);
    savedAs(pruning.manager, pruned);
    await pruning.manager.shutdown();
  }
});

test("the socket connection snapshot omits saved sessions, so any admitted population still connects", async (t) => {
  const { directory } = workspace(t);
  const seed = openTerminalHistory({ directory });
  for (let index = 0; index < 40; index += 1) seed.end(begin(seed), { exitCode: 0 });
  seed.close();
  const { manager: terminals } = manager(openTerminalHistory({ directory }));
  const live = terminals.create({ cwd: "/work/tree" });
  const all = terminals.list();
  assert.equal(all.length, 41);
  assert.deepEqual(terminals.list({ saved: false }).map((entry) => entry.id), [live.id], "the connection snapshot carried saved sessions");
  // The quota admits one saved session per two charged files. Listing every
  // one in a single socket frame would exceed the hub's 1 MiB client budget.
  const admitted = Math.floor(TERMINAL_HISTORY_LIMITS.totalBytes / (2 * TERMINAL_HISTORY_LIMITS.fileBytes));
  const perEntry = Buffer.byteLength(JSON.stringify(all.at(-1)));
  assert.ok(admitted * perEntry > 1024 * 1024, "the admitted population no longer needs to be kept out of the snapshot");
  await terminals.shutdown();
});

test("load cleanup is best effort, and another load failure is named and serves nothing", (t) => {
  const { directory } = workspace(t);
  const seed = openTerminalHistory({ directory });
  const id = begin(seed);
  seed.end(id, { exitCode: 0 });
  seed.close();
  const temp = path.join(directory, `${id}.meta.0123456789abcdef.tmp`);
  writeFileSync(temp, "partial", { mode: 0o600 });
  const restore = () => { mock.restoreAll(); syncBuiltinESMExports(); };
  t.after(restore);
  // An antivirus or indexer lock on a leftover file is not an unsafe store.
  const rm = fs.rmSync;
  mock.method(fs, "rmSync", (target, options) => {
    if (String(target).endsWith(".tmp")) throw Object.assign(new Error("locked"), { code: "EBUSY" });
    return rm(target, options);
  });
  syncBuiltinESMExports();
  const locked = openTerminalHistory({ directory });
  assert.equal(locked.status().persistent, true, "a locked temporary file made the store untrusted");
  assert.deepEqual(locked.saved().map((entry) => entry.id), [id]);
  assert.equal(locked.usage().undeleted, 1);
  assert.equal(locked.usage().totalBytes, diskCharge(directory, TERMINAL_HISTORY_LIMITS.fileBytes), "a locked leftover escaped the quota");
  restore();
  locked.sweep();
  assert.equal(existsSync(temp), false, "a sweep did not retry the leftover once the lock cleared");
  assert.equal(locked.usage().totalBytes, diskCharge(directory, TERMINAL_HISTORY_LIMITS.fileBytes));
  locked.close();
  const lstat = fs.lstatSync;
  mock.method(fs, "lstatSync", (target, options) => {
    if (String(target).endsWith(".meta")) throw Object.assign(new Error("I/O error"), { code: "EIO" });
    return lstat(target, options);
  });
  syncBuiltinESMExports();
  const failing = openTerminalHistory({ directory });
  assert.equal(failing.status().persistent, false);
  assert.match(failing.status().warning, /could not be loaded \(EIO\)/, "an I/O failure was reported as an unsafe directory");
  assert.deepEqual(failing.saved(), [], "a store that is not persisting served saved sessions");
  failing.close();
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

test("a Windows ACL probe that cannot run is a named load failure, not an unsafe store, and a later start recovers", (t) => {
  const { directory } = workspace(t);
  const day = 24 * 60 * 60 * 1000;
  let clock = Date.UTC(2026, 9, 1);
  const seed = openTerminalHistory({ directory, now: () => clock });
  const [expired, kept] = [begin(seed), begin(seed)];
  seed.end(expired, { exitCode: 1 });
  clock += 2 * day;
  seed.end(kept, { exitCode: 2 });
  seed.close();
  clock += 6 * day;
  const before = readdirSync(directory).sort();
  const user = "S-1-5-21-9-9-9-1001";
  const windows = (probeWindowsAcl) => openTerminalHistory({ directory, now: () => clock, platform: "win32", identity: { user, groups: [] }, probeWindowsAcl });

  for (const [run, code] of [[() => ({ error: Object.assign(new Error("spawnSync powershell.exe ETIMEDOUT"), { code: "ETIMEDOUT" }) }), "ETIMEDOUT"],
    [() => ({ error: Object.assign(new Error("stdout maxBuffer length exceeded"), { code: "ENOBUFS" }) }), "ENOBUFS"],
    [() => ({ error: Object.assign(new Error("spawnSync powershell.exe EACCES"), { code: "EACCES" }) }), "EACCES"],
    [() => ({ status: 1, stdout: "" }), "exit 1"]]) {
    const failed = windows((target) => probeWindowsHistoryAcl(target, run));
    assert.equal(failed.status().persistent, false);
    assert.doesNotMatch(failed.status().warning, /not private/, `a ${code} probe failure was reported as an unsafe store`);
    assert.match(failed.status().warning, new RegExp(`could not be loaded \\(ACL check ${code}\\)`));
    assert.deepEqual(failed.saved(), [], "a store that could not verify its ACL served saved sessions");
    failed.sweep();
    failed.close();
  }
  assert.deepEqual(readdirSync(directory).sort(), before, "a failed load changed its directory");

  // An observed foreign ACE is still unsafe.
  const foreign = windows(() => ({ user, groups: [], entries: [{ name: "terminal-history", owner: user, reparse: false, allow: [user, "S-1-1-0"] }] }));
  assert.match(foreign.status().warning, /not private to this user/);
  foreign.close();

  // Once the probe works again, the next start restores and applies retention.
  const recovered = windows(() => ({ user, groups: [], entries: [{ name: "terminal-history", owner: user, reparse: false, allow: [user, "S-1-5-18"] }] }));
  assert.equal(recovered.status().persistent, true);
  assert.deepEqual(recovered.saved().map((entry) => entry.id), [kept]);
  assert.deepEqual(terminalFiles(directory, expired), [], "retention did not run after the store recovered");
  recovered.close();
});

test("a store at the maximum admitted population loads, lists and verifies its ACL within budget", { timeout: 300_000 }, async (t) => {
  const { directory } = workspace(t);
  openTerminalHistory({ directory }).close();
  const endedAt = Date.now();
  const meta = (id) => encodeRecord(1, JSON.stringify({ version: 1, id, name: "Shell", cwd: "/work/tree", createdAt: "2026-10-21T00:00:00.000Z",
    end: { exitCode: 0, signal: null, endedAt } }));
  // Every session holds a metadata file and an output file, each charged a
  // block, so this is the most sessions the global cap admits.
  const perSession = meta(randomUUID()).length + 2 * TERMINAL_HISTORY_LIMITS.fileBytes;
  const admitted = Math.floor(TERMINAL_HISTORY_LIMITS.totalBytes / perSession);
  for (let index = 0; index < admitted; index += 1) {
    const id = randomUUID();
    writeFileSync(path.join(directory, `${id}.meta`), meta(id), { mode: 0o600 });
    writeFileSync(path.join(directory, `${id}.1.log`), "", { mode: 0o600 });
  }
  if (process.platform === "win32") {
    // The real probe reads every file's ACL in one process and reports each
    // distinct ACL once, well inside its 30 s timeout and 4 MiB output cap.
    const started = performance.now();
    const report = probeWindowsHistoryAcl(directory);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 20_000, `the ACL probe took ${Math.round(elapsed)} ms for ${2 * admitted} files`);
    assert.ok(report.entries.length <= 4, `the ACL probe reported ${report.entries.length} entries instead of distinct ACLs`);
    assert.equal(windowsAclPrivate(report), true);
  }
  const started = performance.now();
  const store = openTerminalHistory({ directory });
  assert.equal(store.status().persistent, true, store.status().warning);
  assert.equal(store.usage().terminals, admitted, "a session within the cap was evicted");
  assert.ok(store.usage().totalBytes <= TERMINAL_HISTORY_LIMITS.totalBytes);
  const { manager: terminals } = manager(store);
  const listing = JSON.stringify({ terminals: terminals.list() });
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 20_000, `loading and listing ${admitted} sessions took ${Math.round(elapsed)} ms`);
  assert.ok(Buffer.byteLength(listing) < 4 * 1024 * 1024, `GET /api/terminals would send ${Buffer.byteLength(listing)} bytes`);
  assert.deepEqual(terminals.list({ saved: false }), [], "the socket snapshot carried saved sessions");
  await terminals.shutdown();
});

test("output that cannot be deleted stays charged, is reported on dismissal and retried until it is gone", async (t) => {
  const { directory } = workspace(t);
  const store = openTerminalHistory({ directory });
  const { manager: terminals } = manager(store);
  const id = begin(store);
  store.append(id, "dismissed output\n");
  store.end(id, { exitCode: 0 });
  const locked = lockOutput(t);
  locked.add(id);
  await assert.rejects(terminals.close(id), (error) => error.statusCode === 503 && /could not be deleted yet/.test(error.message),
    "a dismissal reported success while its output stayed on disk");
  assert.equal(terminals.list().some((entry) => entry.id === id), false, "the dismissed session was still listed");
  assert.equal(store.usage().undeleted, 1);
  assert.equal(store.usage().totalBytes, diskCharge(directory, TERMINAL_HISTORY_LIMITS.fileBytes), "the undeleted output was no longer charged");
  assert.equal(store.status().persistent, true, "a lock on one file stopped persistence");
  store.sweep();
  assert.equal(store.usage().undeleted, 1, "a retry reported success while the file was still locked");
  locked.clear();
  store.sweep();
  assert.equal(store.usage().undeleted, 0);
  assert.equal(store.usage().totalBytes, diskCharge(directory, TERMINAL_HISTORY_LIMITS.fileBytes), "usage differs from disk once the lock cleared");
  assert.deepEqual(terminalFiles(directory, id), []);
  await terminals.shutdown();
});

test("quota eviction and retention expiry keep undeletable output charged and retry it", (t) => {
  const { directory } = workspace(t);
  const day = 24 * 60 * 60 * 1000;
  let clock = Date.UTC(2026, 9, 1);
  const limits = { ...TERMINAL_HISTORY_LIMITS, terminalBytes: 64 * 1024, totalBytes: 64 * 1024, fileBytes: 1024 };
  const store = openTerminalHistory({ directory, limits, now: () => clock });
  const block = "e".repeat(16 * 1024);
  const locked = lockOutput(t);
  const [evicted, running] = [begin(store), begin(store)];
  store.append(evicted, block);
  store.end(evicted, { exitCode: 0 });
  locked.add(evicted);

  // Quota eviction: the oldest ended session leaves, its output stays charged.
  store.append(running, "r".repeat(30 * 1024));
  store.append(running, "r".repeat(30 * 1024));
  assert.equal(store.has(evicted), false, "the quota did not evict the oldest ended session");
  assert.equal(store.usage().undeleted, 1);
  assert.ok(store.usage().totalBytes <= limits.totalBytes);
  assert.equal(store.usage().totalBytes, diskCharge(directory, limits.fileBytes), "the evicted session's undeleted output was not charged");

  // Retention expiry takes the same path.
  const expiring = begin(store);
  store.append(expiring, "expiring\n");
  store.end(expiring, { exitCode: 0 });
  locked.add(expiring);
  clock += 8 * day;
  assert.equal(store.saved().some((entry) => entry.id === expiring), false);
  assert.equal(store.usage().undeleted, 2);
  assert.equal(store.usage().totalBytes, diskCharge(directory, limits.fileBytes), "the expired session's undeleted output was not charged");
  locked.clear();
  store.sweep();
  assert.equal(store.usage().undeleted, 0);
  assert.equal(store.usage().totalBytes, diskCharge(directory, limits.fileBytes), "usage differs from disk once the locks cleared");

  // Once undeletable output alone keeps the store over its cap, it stops
  // persisting instead of letting disk use keep growing.
  for (let index = 0; index < 8 && store.status().persistent; index += 1) {
    const stuck = begin(store);
    locked.add(stuck);
    store.append(stuck, block);
    store.end(stuck, { exitCode: 0 });
    store.append(running, "s".repeat(30 * 1024));
  }
  assert.equal(store.status().persistent, false, "persistence continued past the cap");
  assert.match(store.status().warning, /could not be saved \(EBUSY\)/);
  const stopped = store.usage().totalBytes;
  store.append(running, "s".repeat(30 * 1024));
  assert.equal(store.usage().totalBytes, stopped, "a store over its cap kept writing");
  store.close();
});

test("a terminal that cannot delete its oldest output stops saving within its own cap and evicts no other session", (t) => {
  const { directory } = workspace(t);
  const limits = { ...TERMINAL_HISTORY_LIMITS, terminalBytes: 64 * 1024, totalBytes: 192 * 1024, fileBytes: 1024 };
  const events = [];
  const store = openTerminalHistory({ directory, limits, onStatusChange: (status) => events.push(status) });
  const other = begin(store);
  store.append(other, "o".repeat(16 * 1024));
  store.end(other, { exitCode: 0 });
  const locked = lockOutput(t);
  const id = begin(store);
  locked.add(id);
  for (let index = 0; index < 128; index += 1) store.append(id, "x".repeat(8 * 1024));
  assert.ok(terminalBytes(directory, id) <= limits.terminalBytes, `a locked terminal grew to ${terminalBytes(directory, id)} bytes on disk`);
  assert.equal(store.has(other), true, "another saved session was evicted to make room for undeletable output");
  assert.equal(events.length, 1, "the stalled terminal was not reported exactly once");
  assert.match(events[0].warning, /could not be deleted \(EBUSY\)/);
  assert.equal(store.status().persistent, true, "one locked terminal stopped every terminal's history");
  assert.equal(store.usage().totalBytes, diskCharge(directory, limits.fileBytes), "usage differs from disk while output is locked");
  const next = begin(store);
  store.append(next, "still saved\n");
  assert.match(store.read(next), /still saved/);

  locked.clear();
  store.sweep();
  assert.equal(store.usage().undeleted, 0, "the locked output was not retried");
  assert.equal(store.usage().totalBytes, diskCharge(directory, limits.fileBytes), "usage differs from disk once the lock cleared");
  assert.ok(terminalBytes(directory, id) <= limits.terminalBytes);

  // With the residue gone the terminal saves output again and the warning clears.
  assert.equal(store.status().warning, null, "the stall warning outlived its cause");
  assert.deepEqual(events.at(-1), { persistent: true, warning: null }, "clients were not told the stall cleared");
  store.append(id, "saved after recovery\n");
  for (let index = 0; index < 16; index += 1) store.append(id, "y".repeat(8 * 1024));
  store.append(id, "newest after recovery\n");
  assert.ok(terminalBytes(directory, id) <= limits.terminalBytes, "a recovered terminal grew past its cap");
  assert.equal(store.usage().totalBytes, diskCharge(directory, limits.fileBytes));
  store.close();
  const reopened = openTerminalHistory({ directory, limits });
  assert.match(reopened.read(id), /newest after recovery\n$/, "output after recovery was not saved");
  reopened.close();
});

test("a metadata read error keeps every history file and a later start restores the session", (t) => {
  const { directory } = workspace(t);
  const seed = openTerminalHistory({ directory });
  const id = begin(seed);
  seed.append(id, "kept through a read error\n");
  seed.end(id, { exitCode: 3 });
  seed.close();
  const before = readdirSync(directory).sort();
  const read = fs.readFileSync;
  mock.method(fs, "readFileSync", (target, options) => {
    if (String(target).endsWith(".meta")) throw Object.assign(new Error("I/O error"), { code: "EIO" });
    return read(target, options);
  });
  syncBuiltinESMExports();
  const restore = () => { mock.restoreAll(); syncBuiltinESMExports(); };
  t.after(restore);
  const failing = openTerminalHistory({ directory });
  assert.equal(failing.status().persistent, false);
  assert.match(failing.status().warning, /could not be loaded \(EIO\)/);
  assert.deepEqual(failing.saved(), [], "a store that could not load served saved sessions");
  failing.close();
  assert.deepEqual(readdirSync(directory).sort(), before, "a read error deleted saved history");
  restore();
  const reopened = openTerminalHistory({ directory });
  assert.deepEqual(reopened.saved().map(({ id: savedId, endReason, exitCode }) => [savedId, endReason, exitCode]), [[id, "exit", 3]]);
  assert.equal(reopened.read(id), "kept through a read error\n");
  reopened.close();
});

test("a close whose metadata cannot be deleted is finished by the next start, never restored as a restart", async (t) => {
  const restore = () => { mock.restoreAll(); syncBuiltinESMExports(); };
  t.after(restore);
  const rm = fs.rmSync;
  for (const kind of ["saved", "live"]) {
    const { directory } = workspace(t);
    const seed = openTerminalHistory({ directory });
    const saved = begin(seed);
    seed.append(saved, "dismissed\n");
    seed.end(saved, { exitCode: 0 });
    seed.close();
    const { manager: terminals } = manager(openTerminalHistory({ directory }));
    const id = kind === "saved" ? saved : terminals.create({ cwd: "/work/tree" }).id;
    mock.method(fs, "rmSync", (target, options) => {
      if (String(target).endsWith(".meta")) throw Object.assign(new Error("resource busy or locked"), { code: "EBUSY" });
      return rm(target, options);
    });
    syncBuiltinESMExports();
    await assert.rejects(terminals.close(id), (error) => error.statusCode === 503);
    await terminals.shutdown();
    restore();
    const reopened = openTerminalHistory({ directory });
    assert.equal(reopened.saved().some((entry) => entry.id === id), false, `a user-closed ${kind} session was restored after a failed deletion`);
    assert.deepEqual(terminalFiles(directory, id), [], `the next start did not finish the ${kind} removal`);
    reopened.close();
  }
});

test("a user's close whose history cleanup fails still lets an overlapping shutdown succeed", async (t) => {
  const { directory } = workspace(t);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const store = openTerminalHistory({ directory });
  const { manager: terminals } = manager(store, { terminate: () => held });
  const terminal = terminals.create({ cwd: "/work/tree" });
  const rm = fs.rmSync;
  mock.method(fs, "rmSync", (target, options) => {
    if (String(target).endsWith(".meta")) throw Object.assign(new Error("resource busy or locked"), { code: "EBUSY" });
    return rm(target, options);
  });
  syncBuiltinESMExports();
  t.after(() => { mock.restoreAll(); syncBuiltinESMExports(); });
  const closing = terminals.close(terminal.id);
  const stopping = terminals.shutdown();
  release();
  await assert.rejects(closing, (error) => error.statusCode === 503, "the user's close hid the incomplete cleanup");
  await stopping;
  assert.equal(store.status().persistent, false);
  assert.match(store.status().warning, /could not be saved \(EBUSY\)/, "the history status did not report the failed cleanup");
});

test("a restored session serves all of its saved output, beyond the live tail and the view's line limit", async (t) => {
  const { directory } = workspace(t);
  const first = manager(openTerminalHistory({ directory }));
  const terminal = first.manager.create({ cwd: "/work/tree", name: "Long" });
  const lines = Array.from({ length: 12_000 }, (_, index) => `saved line ${index}\n`);
  for (let index = 0; index < lines.length; index += 1000) first.ptys[0].emit(lines.slice(index, index + 1000).join(""));
  await first.manager.shutdown();
  const second = manager(openTerminalHistory({ directory }));
  const { buffer } = second.manager.get(terminal.id);
  assert.ok(buffer.length > 150_000 && lines.length > 5000);
  assert.equal(buffer, lines.join(""), "saved output kept within the cap was not restored in full");
  await second.manager.shutdown();
});

test("a recovery reservation and an audit-pending session serve all saved output and stay recovery-only", async (t) => {
  const { directory } = workspace(t);
  const seed = openTerminalHistory({ directory });
  const lines = Array.from({ length: 12_000 }, (_, index) => `saved line ${index}\n`);
  const reserved = begin(seed);
  const pending = begin(seed);
  for (const id of [reserved, pending]) {
    for (let index = 0; index < lines.length; index += 1000) seed.append(id, lines.slice(index, index + 1000).join(""));
    seed.finish(id);
  }
  seed.close();
  let reservations = [{ target: reserved, cwd: "/work/tree", pid: 4242 }];
  let scanning = true;
  const database = { ...fakeDatabase(), get terminalAuditScanPending() { return scanning; }, terminalUnknownReservations: () => reservations,
    resolveTerminalUnknown: () => { reservations = []; } };
  const terminals = createTerminalManager({ database, publish: () => {}, history: openTerminalHistory({ directory }),
    recoverTerminal: async () => true, cleanupSocket: () => {} });
  terminals.reloadUnknownReservations();
  assert.ok(lines.join("").length > 150_000 && lines.length > 5000);
  for (const id of [reserved, pending]) {
    const detail = terminals.get(id);
    assert.deepEqual([detail.status, detail.recoveryReservation], ["unknown", true], "unproven saved output was shown as running or ended");
    assert.equal(detail.buffer, lines.join(""), "saved output awaiting proof was cut to the live tail");
  }
  scanning = false;
  assert.equal(await terminals.reconcileUnknown(), 1);
  terminals.reloadUnknownReservations();
  for (const id of [reserved, pending]) assert.deepEqual([terminals.get(id).status, terminals.get(id).buffer], ["ended", lines.join("")]);
  await terminals.shutdown();
});

test("an exit observed before shutdown is restored with its status, never as ended by restart", async (t) => {
  for (const settle of ["held", "failed"]) {
    const { directory } = workspace(t);
    let release = () => {};
    const held = new Promise((resolve) => { release = resolve; });
    // The exit's settle is still waiting for, or has failed, its proof when
    // shutdown closes the terminal.
    const terminate = async (terminal, options) => {
      if (!options?.alreadyExited) return;
      if (settle === "failed") throw new Error("empty-tree proof unavailable");
      await held;
    };
    const { manager: terminals, ptys } = manager(openTerminalHistory({ directory }), { terminate });
    const exited = terminals.create({ cwd: "/work/tree" });
    const running = terminals.create({ cwd: "/work/tree" });
    ptys[0].exit({ exitCode: 7, signal: 0 });
    if (settle === "failed") await waitFor(() => terminals.get(exited.id).status === "unknown");
    await terminals.shutdown();
    release();
    await new Promise((resolve) => setImmediate(resolve));
    const restored = openTerminalHistory({ directory });
    const labels = Object.fromEntries(restored.saved().map((entry) => [entry.id, [entry.endReason, entry.exitCode]]));
    assert.deepEqual(labels, { [exited.id]: ["exit", 7], [running.id]: ["restart", null] }, `settle ${settle}`);
    restored.close();
  }
});

test("a resumed session keeps saved output inside its cap and continues its last segment", (t) => {
  const { directory } = workspace(t);
  const limits = { ...TERMINAL_HISTORY_LIMITS, terminalBytes: 64 * 1024 };
  const segments = (id) => terminalFiles(directory, id).filter((name) => name.endsWith(".log")).sort();
  const store = openTerminalHistory({ directory, limits });
  // Two segments, together inside the cap; a single-segment session; and
  // a single-segment session whose last append was torn by a crash.
  const twoSegments = begin(store);
  const oneSegment = begin(store);
  const torn = begin(store);
  const first = "a".repeat(20 * 1024);
  const second = "b".repeat(20 * 1024);
  store.append(twoSegments, first);
  store.append(twoSegments, second);
  store.append(oneSegment, "one\n");
  store.append(torn, "whole\n");
  store.close();
  assert.equal(segments(twoSegments).length, 2);
  const [tornSegment] = segments(torn);
  appendFileSync(path.join(directory, tornSegment), encodeRecord(2, "lost").subarray(0, 9));
  const savedSegments = segments(oneSegment);

  const restarted = openTerminalHistory({ directory, limits });
  for (const id of [twoSegments, oneSegment, torn]) assert.equal(restarted.resume(id), true);
  restarted.append(twoSegments, "detached\n");
  restarted.append(oneSegment, "two\n");
  restarted.append(torn, "after\n");
  restarted.close();
  assert.deepEqual(segments(oneSegment), savedSegments, "a resumed session with room started another segment");

  const again = openTerminalHistory({ directory, limits });
  assert.equal(again.read(twoSegments), `${first}${second}detached\n`, "resume dropped saved output inside the cap");
  assert.equal(again.read(oneSegment), "one\ntwo\n");
  assert.equal(again.read(torn), "whole\nafter\n", "output after a torn tail was not restored");
  again.close();
});

test("a reattached session resumes its restart-ended history; a session that exited stays ended", (t) => {
  const { directory } = workspace(t);
  const store = openTerminalHistory({ directory });
  const live = begin(store);
  const exited = begin(store);
  store.append(live, "before restart\n");
  store.end(exited, { exitCode: 0 });
  store.close();
  const restarted = openTerminalHistory({ directory });
  assert.equal(restarted.saved().find((entry) => entry.id === live).endReason, "restart");
  assert.equal(restarted.resume(exited), false, "an exited session was resumed");
  assert.equal(restarted.resume(randomUUID()), false);
  assert.equal(restarted.resume(live), true);
  restarted.append(live, "after reattach\n");
  assert.equal(restarted.read(live), "before restart\nafter reattach\n");
  assert.equal(restarted.saved().find((entry) => entry.id === live).endedAt, null);
  restarted.close();
  // A crash after the reattach ends it by that later restart, output intact.
  const again = openTerminalHistory({ directory });
  assert.equal(again.saved().find((entry) => entry.id === live).endReason, "restart");
  assert.equal(again.read(live), "before restart\nafter reattach\n");
  again.close();
});
