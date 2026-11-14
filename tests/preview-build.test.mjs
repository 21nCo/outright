import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { uiFixtureBudget } from "./ui-fixture-budget.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

// Every dynamic import in the client build, with the code right after it.
// Rollup writes import("./x.js").then(m => m.p) when it gives a chunk short
// export names; a retry of that chunk's address (src/lib/module-retry.js)
// would get the short names, not the module the import asked for.
function dynamicImports(assets) {
  const found = [];
  for (const name of readdirSync(assets).filter((file) => file.endsWith(".js"))) {
    const code = readFileSync(path.join(assets, name), "utf8");
    for (const match of code.matchAll(/import\((["'])\.\/([^"']+)\1\)/g)) {
      found.push({ from: name, target: match[2], after: code.slice(match.index + match[0].length, match.index + match[0].length + 12) });
    }
  }
  return found;
}

const exportedNames = (code) => [...code.matchAll(/export\{([^}]*)\}/g)].flatMap((match) => match[1].split(","))
  .map((part) => part.trim().split(/\s+as\s+/).at(-1));

test("the production build keeps every dynamic import in the preview path retryable", { timeout: 120_000 }, async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "outright-preview-build-"));
  try {
    await build({ configFile: path.join(root, "vite.config.mjs"), logLevel: "error", build: { outDir, emptyOutDir: true } });
    const assets = path.join(outDir, "assets");
    const imports = dynamicImports(assets);
    const projected = imports.filter((entry) => entry.after.startsWith(".then("));
    assert.deepEqual(projected, [], "a dynamic import picks its module out of a shared chunk, so a retry would get other names");

    const viewer = imports.find((entry) => /^PdfPreview-[\w-]+\.js$/.test(entry.target));
    assert(viewer, `the PDF viewer is not loaded on demand: ${JSON.stringify(imports)}`);
    const viewerCode = readFileSync(path.join(assets, viewer.target), "utf8");
    assert(exportedNames(viewerCode).includes("default"), "the viewer chunk does not export its component as default");

    const library = imports.filter((entry) => entry.from === viewer.target);
    assert.equal(library.length, 1, `the viewer should load only pdf.js on demand: ${JSON.stringify(library)}`);
    const libraryNames = exportedNames(readFileSync(path.join(assets, library[0].target), "utf8"));
    for (const name of ["getDocument", "PDFWorker"]) assert(libraryNames.includes(name), `the pdf.js chunk does not export ${name}`);

    // The worker script's address is part of the viewer, not another import.
    // The viewer starts its own worker entry (src/lib/pdf-worker-entry.js),
    // which bundles pdf.js's worker.
    const worker = readdirSync(assets).find((file) => /^pdf-worker-entry-[\w-]+\.js$/.test(file));
    assert(worker && viewerCode.includes(worker), "the viewer does not name the built worker script");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

// A run of a fixture file that this test owns. The file runs in its own
// process group (on POSIX) with this owner's Chrome profile and an IPC
// channel, and reports each tree it starts (ui-races.test.mjs: Vite and
// Chrome, which it starts in groups of their own) with a marker that only
// that launch's command line has (Vite's run-unique title, Chrome's private
// profile). When cancelAt settles the owner asks the file over IPC to
// cancel, which its own cleanup answers by stopping its trees and files
// and exiting, within graceMs. Past that the owner stops the file's group,
// each reported tree whose command line still has its marker, and every
// process started with the owner's profile (Chrome's helpers can leave
// Chrome's group). On Windows it ends the file's process tree and the same
// reported and profile-owned processes. Either way, nothing the run started
// may outlive it or keep its output open.
function posixProcesses() {
  const result = spawnSync("/bin/ps", ["-axo", "pid=,pgid=,stat=,command="], { encoding: "utf8", timeout: 5_000 });
  if (result.status !== 0) throw new Error(`Cannot list processes: ${result.stderr || result.error}`);
  return result.stdout.split("\n").map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/))
    .filter((fields) => fields && !fields[3].startsWith("Z")).map((fields) => [Number(fields[1]), Number(fields[2]), fields[4]]);
}

// Each process in rows ([pid, group, command]) that is the run's:
// [pid, group to stop or null, command].
function selectOwned(rows, child, owned, profile) {
  const running = child.exitCode === null && child.signalCode === null;
  // A group is the run's while its leader is the run's own process (the file,
  // or a reported tree whose command line still has its marker), or once its
  // leader has gone: a group's id is not reused while any member remains.
  const leader = (group) => rows.find(([pid]) => pid === group);
  const groups = new Set([
    ...(running || !leader(child.pid) ? [child.pid] : []),
    ...owned.filter((entry) => !leader(entry.pid) || leader(entry.pid)[2].includes(entry.marker)).map((entry) => entry.pid),
  ]);
  return rows.filter(([pid, group, command]) => pid !== process.pid && (groups.has(group) || command.includes(profile)))
    .map(([pid, group, command]) => [pid, groups.has(group) ? group : null, command]);
}

function ownedLeft(child, owned, profile, { list = posixProcesses } = {}) {
  if (process.platform === "win32") {
    const running = child.exitCode === null && child.signalCode === null;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"], { encoding: "utf8", timeout: 15_000, windowsHide: true });
    if (result.status !== 0) throw new Error(`Cannot list Windows processes: ${result.stderr || result.error}`);
    return [JSON.parse(result.stdout || "[]")].flat().filter(({ ProcessId, CommandLine }) => (ProcessId === child.pid && running)
      || (CommandLine && (CommandLine.includes(profile) || owned.some((entry) => entry.pid === ProcessId && CommandLine.includes(entry.marker)))))
      .map(({ ProcessId, CommandLine }) => [ProcessId, null, CommandLine ?? ""]);
  }
  return selectOwned(list(), child, owned, profile);
}

// Signals every target, each on its own: one that fails does not keep the
// others running. A group that rejects the signal (macOS Chrome can put
// protected helpers in its group, ui-races.test.mjs) is stopped through its
// members in the same listing. Failures are reported after every target has
// been tried.
function stopOwned(child, owned, profile, { list, kill = (target, signal) => process.kill(target, signal) } = {}) {
  const left = ownedLeft(child, owned, profile, { list });
  if (process.platform === "win32") {
    if (child.exitCode === null && child.signalCode === null) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 15_000 });
    for (const [pid] of left) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 15_000 });
    return;
  }
  const errors = [];
  const signal = (target) => {
    try { kill(target, "SIGKILL"); return true; }
    catch (error) {
      if (error.code === "ESRCH") return true;
      if (error.code !== "EPERM" || target > 0) errors.push(new Error(`SIGKILL ${target}: ${error.message}`, { cause: error }));
      return false;
    }
  };
  for (const target of new Set(left.map(([pid, group]) => (group === null ? pid : -group)))) {
    if (signal(target) || target > 0) continue;
    for (const [pid, group] of left) if (-group === target) signal(pid);
  }
  if (errors.length) throw new AggregateError(errors, `Cannot stop the run's processes: ${errors.map((error) => error.message).join("; ")}`);
}

// cancel defaults to asking the file over IPC; a test may end the owner
// instead. A closed channel does not throw on send: it reports the error
// later, to the callback, so asking a file that has gone is a no-op.
// stop may give stopOwned another kill (the EPERM test). The output is
// closed, the run checked for what is left and the profile removed even if
// a stop fails; the run's stop failures are returned in stopErrors.
const askCancel = (child) => { if (child.connected) child.send("cancel", () => {}); };
async function runOwned(args, { env, cancelAt, graceMs, closeMs = 10_000, cancel = askCancel, stop = {} }) {
  const profile = mkdtempSync(path.join(tmpdir(), "outright-fixture-owner-"));
  const runEnv = { ...env, OUTRIGHT_TEST_UI_PROFILE: profile };
  delete runEnv.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, args, {
    cwd: root, env: runEnv, stdio: ["ignore", "pipe", "pipe", "ipc"], detached: process.platform !== "win32", windowsHide: true,
  });
  const owned = [];
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  child.on("message", (message) => {
    if (typeof message?.owned === "string" && Number.isInteger(message.pid) && typeof message.marker === "string" && message.marker) owned.push({ role: message.owned, pid: message.pid, marker: message.marker });
  });
  // "close" comes only once the file has exited and every holder of its output has closed it.
  const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  const within = (ms) => { let timer; return Promise.race([closed, new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); })]).finally(() => clearTimeout(timer)); };
  const stopErrors = [];
  const tryStop = () => { try { stopOwned(child, owned, profile, stop); } catch (error) { stopErrors.push(error); } };
  let outcome = "finished";
  let result = null;
  let left = [];
  try {
    result = await Promise.race([closed, cancelAt(owned).then(() => null)]);
    if (!result) {
      outcome = "cancelled";
      cancel(child);
      result = await within(graceMs);
    }
    if (!result) {
      outcome = "forced";
      tryStop();
      result = await within(closeMs);
    }
  } finally {
    if (!result) { child.stdout.destroy(); child.stderr.destroy(); }
    try {
      left = ownedLeft(child, owned, profile).map(([pid, , command]) => `${pid} ${command}`);
      if (left.length) tryStop();
    } catch (error) { stopErrors.push(error); }
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  return { ...result, outcome, output, owned, left, stopErrors, profile, outputClosed: Boolean(result) };
}
const after = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });
const ownedReported = (owned, roles, limitMs) => new Promise((resolve) => {
  const until = Date.now() + limitMs;
  const check = () => (roles.every((role) => owned.some((entry) => entry.role === role)) || Date.now() > until ? resolve() : setTimeout(check, 50).unref());
  check();
});

// Another run's processes at the IDs this run reported, as recycled IDs
// would show them: another worktree's fixture Vite (from before and after
// launches had titles of their own), Chrome with its own profile and fixture
// file. The forced stop must take none of them for the run's, and must
// still take the run's own launches.
function assertMarkersAreTheRunsOwn(run) {
  const foreign = {
    Vite: ["node /other/node_modules/vite/bin/vite.js --config tests/vite.ui-races.config.mjs --host 127.0.0.1 --port 5173 --strictPort", `outright-ui-races-vite-${randomUUID()}`],
    Chrome: [`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless=new --user-data-dir=${path.join(tmpdir(), "outright-fixture-owner-other")}`],
    fixture: ["node --test-name-pattern=browser interaction regressions /other/tests/ui-races.test.mjs", `outright-ui-races-fixture-${randomUUID()}`],
  };
  const gone = { pid: -1, exitCode: 0, signalCode: null };
  for (const entry of run.owned) {
    for (const command of foreign[entry.role]) {
      assert.deepEqual(selectOwned([[entry.pid, entry.pid, command]], gone, run.owned, run.profile), [], `${entry.role} marker ${entry.marker} takes another run's ${command}`);
    }
    const own = `${entry.role === "Chrome" ? "chrome --user-data-dir=" : "node "}${entry.marker}`;
    assert.equal(selectOwned([[entry.pid, entry.pid, own]], gone, run.owned, run.profile).length, 1, `${entry.role} marker does not take its own launch`);
  }
}

// The browser fixture's harness (ui-races.test.mjs) builds its page as the
// app is built and runs one step in headless Chrome: the built viewer and
// pdf.js chunks fail, and Retry and Refresh files load them without a page
// reload. The harness owns Chrome, the preview server and their cleanup
// within its own deadline, so it is cancelled only after that has passed.
const { fixtureMs } = uiFixtureBudget();
const fixtureFile = path.join(root, "tests", "ui-races.test.mjs");
const browserRun = ["--test-name-pattern=browser interaction regressions", fixtureFile];
// The harness's cleanup stops each tree in at most 7 seconds.
const cleanupGraceMs = 25_000;
test("in the production build, failed PDF viewer and pdf.js chunks load again in headless Chrome", { timeout: fixtureMs + 60_000 }, async () => {
  const env = { ...process.env, OUTRIGHT_UI_BUILD: "1", OUTRIGHT_UI_STEP: "files pdf build load" };
  const run = await runOwned(browserRun, { env, cancelAt: () => after(fixtureMs + 5_000), graceMs: cleanupGraceMs });
  assert.deepEqual(run.left, [], `the fixture left processes running: ${run.output.slice(-2000)}`);
  assert.equal(run.outcome, "finished", run.output.slice(-4000));
  assert.equal(run.code, 0, run.output.slice(-4000));
  assert.match(run.output, /(?:#|ℹ) pass 1\b/, run.output.slice(-4000));
});

test("a hung fixture is cancelled by its owner, and its Vite, Chrome and output end with it", { timeout: 120_000 }, async () => {
  const env = { ...process.env, OUTRIGHT_TEST_UI_HANG: "1", OUTRIGHT_UI_STEP: "recovery actions" };
  delete env.OUTRIGHT_UI_BUILD;
  const run = await runOwned(browserRun, { env, cancelAt: (owned) => ownedReported(owned, ["Vite", "Chrome"], 60_000).then(() => after(1_000)), graceMs: cleanupGraceMs });
  assert.deepEqual(run.owned.map((entry) => entry.role).sort(), ["Chrome", "Vite"], run.output.slice(-2000));
  assert.equal(run.outcome, "cancelled", `the fixture did not end on its owner's cancel: ${run.output.slice(-2000)}`);
  assert.notEqual(run.code, 0);
  assert.match(run.output, /The fixture's owner cancelled it/);
  assert.doesNotMatch(run.output, /UI harness cleanup failed/);
  assert(run.outputClosed, "the fixture's output stayed open");
  assert.deepEqual(run.left, [], "the fixture left processes running");
  assert.deepEqual(run.stopErrors, []);
  assertMarkersAreTheRunsOwn(run);
});

// An owner that dies (the suite deadline's SIGKILL, or Ctrl-C escalated to
// it) can neither cancel the fixture nor stop it: the fixture, Vite and
// Chrome run in groups of their own. This owner starts the fixture as
// runOwned does, passes its own output on, and relays what it reports; the
// fixture must take the owner's channel closing as a cancel. The fixture's
// title is this launch's alone, its marker.
const dyingOwner = `
const { spawn } = require("node:child_process");
const title = process.argv[2];
const fixture = spawn(process.execPath, ["--title=" + title, ...JSON.parse(process.argv[1])], { stdio: ["ignore", "inherit", "inherit", "ipc"], detached: process.platform !== "win32", windowsHide: true });
process.send({ owned: "fixture", pid: fixture.pid, marker: title });
fixture.on("message", (message) => { if (process.connected) process.send(message, () => {}); });
setInterval(() => {}, 1000);`;
test("a hung fixture whose owner is killed stops its Vite, Chrome and output", { timeout: 120_000 }, async () => {
  const env = { ...process.env, OUTRIGHT_TEST_UI_HANG: "1", OUTRIGHT_UI_STEP: "recovery actions" };
  delete env.OUTRIGHT_UI_BUILD;
  const run = await runOwned(["-e", dyingOwner, JSON.stringify(browserRun), `outright-ui-races-fixture-${randomUUID()}`], {
    env, cancelAt: (owned) => ownedReported(owned, ["Vite", "Chrome"], 60_000).then(() => after(1_000)), graceMs: cleanupGraceMs,
    cancel: (child) => child.kill("SIGKILL"),
  });
  assert.deepEqual(run.owned.map((entry) => entry.role).sort(), ["Chrome", "Vite", "fixture"], run.output.slice(-2000));
  assert.equal(run.outcome, "cancelled", `the fixture did not end when its owner died: ${run.output.slice(-2000)}`);
  assert.equal(run.signal, "SIGKILL");
  assert.match(run.output, /The fixture's owner went away/);
  assert.doesNotMatch(run.output, /UI harness cleanup failed/);
  assert(run.outputClosed, "the fixture's output stayed open");
  assert.deepEqual(run.left, [], "the fixture left processes running");
  assert.deepEqual(run.stopErrors, []);
  assertMarkersAreTheRunsOwn(run);
});

const ownedHang = path.join(root, "tests", "fixtures", "owned-hang.mjs");
test("a fixture that ignores its owner's cancel is stopped with every process it started", { timeout: 60_000 }, async () => {
  const run = await runOwned([ownedHang], {
    env: process.env, cancelAt: (owned) => ownedReported(owned, ["service"], 10_000), graceMs: 1_000,
  });
  assert.equal(run.owned.length, 1, run.output);
  assert.equal(run.outcome, "forced", run.output);
  assert(run.outputClosed, "a descendant kept the fixture's output open");
  assert.deepEqual(run.left, [], "the fixture's processes outlived it");
  assert.deepEqual(run.stopErrors, []);
});

const refused = (target) => Object.assign(new Error(`kill ${target} EPERM`), { code: "EPERM" });

test("the forced stop signals every target when a group refuses the signal, and reports what it could not stop", { skip: process.platform === "win32" }, () => {
  const profile = "/tmp/outright-fixture-owner-test";
  const child = { pid: 100, exitCode: null, signalCode: null };
  const owned = [{ role: "Chrome", pid: 200, marker: profile }, { role: "Vite", pid: 300, marker: "outright-ui-races-vite-test" }];
  const rows = [[100, 100, "node fixture"], [101, 100, "node helper"], [200, 200, `chrome --user-data-dir=${profile}`], [201, 200, "chrome renderer"],
    [202, 200, "chrome protected helper"], [300, 300, "outright-ui-races-vite-test"], [400, 400, `chrome utility --user-data-dir=${profile}`], [500, 500, "unrelated"]];
  const signalled = [];
  const kill = (target) => { signalled.push(target); if (target === -200 || target === 202) throw refused(target); };
  assert.throws(() => stopOwned(child, owned, profile, { list: () => rows, kill }),
    (error) => error instanceof AggregateError && error.errors.length === 1 && /SIGKILL 202:/.test(error.message));
  // Chrome's group refuses, so its members are stopped one by one; the
  // protected helper's refusal is reported only after Vite and the stray
  // profile helper have been stopped too.
  assert.deepEqual(signalled, [-100, -200, 200, 201, 202, -300, 400]);
});

test("a forced stop whose group signals are refused stops the run through its members and removes its profile", { skip: process.platform === "win32", timeout: 60_000 }, async () => {
  const kill = (target, signal) => { if (target < 0) throw refused(target); process.kill(target, signal); };
  const run = await runOwned([ownedHang], {
    env: process.env, cancelAt: (owned) => ownedReported(owned, ["service"], 10_000), graceMs: 1_000, stop: { kill },
  });
  assert.equal(run.outcome, "forced", run.output);
  assert.deepEqual(run.stopErrors, []);
  assert(run.outputClosed, "a descendant kept the fixture's output open");
  assert.deepEqual(run.left, [], "the fixture's processes outlived it");
  assert(!existsSync(run.profile), "the owner's profile was left behind");
});

test("a forced stop that cannot stop a process still closes the run and removes its profile, and reports the failure", { skip: process.platform === "win32", timeout: 60_000 }, async () => {
  // The service refuses every signal; the fixture and its helper do not.
  let service = [];
  const list = () => {
    const rows = posixProcesses();
    service = rows.filter(([, , command]) => command.includes("outright-owned-hang-")).map(([pid]) => pid);
    return rows;
  };
  const kill = (target, signal) => { if (service.includes(Math.abs(target))) throw refused(target); process.kill(target, signal); };
  let run;
  try {
    run = await runOwned([ownedHang], {
      env: process.env, cancelAt: (owned) => ownedReported(owned, ["service"], 10_000), graceMs: 1_000, stop: { list, kill },
    });
    assert.equal(run.outcome, "forced", run.output);
    assert(run.outputClosed, "the fixture's output stayed open");
    assert(!existsSync(run.profile), "the owner's profile was left behind");
    assert.equal(run.left.length, 1, run.left.join("\n"));
    assert(run.left[0].startsWith(`${run.owned[0].pid} `), run.left.join("\n"));
    assert(run.stopErrors.length >= 1 && run.stopErrors.every((error) => /EPERM/.test(error.message)), run.stopErrors.map((error) => error.message).join("; "));
  } finally {
    for (const pid of service) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  }
});
