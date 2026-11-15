import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after as afterAll, before } from "node:test";
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
// and exiting, within graceMs. Past that the owner stops what is still the
// run's. The profile is also the run's token: the file passes
// OUTRIGHT_TEST_UI_PROFILE on to everything it starts, and no other process
// can have it. A process is the run's when it has the token (in its
// environment, or as Chrome's profile on its command line), or is in a
// group the owner can prove is the run's: the file's while it runs, or a
// reported tree's whose leader still has its marker. A group whose leader
// has gone is not proof (its ID may now be another run's), so only its
// members with the token are taken. Each target is checked again just
// before it is signalled. On Windows the owner ends the file through its
// own handle, and each process that has the token, a reported marker, or a
// selected parent that started before it, once its start time is checked
// again. Either way, nothing the run started may outlive it or keep its
// output open.
const tokenOf = (profile) => `OUTRIGHT_TEST_UI_PROFILE=${profile}`;
// On macOS ps -E adds each process's environment (only this user's) to its
// command, so one listing gives the token with the group and command it
// belongs to; no second listing can pair them with another process. That
// listing decides; the command shown in messages comes from a plain
// listing, so no process's environment reaches the output. Linux reads the
// token from /proc: a reused ID there shows it only if the new process is
// the run's too. Rows: [pid, group, command, has the token, shown].
function posixProcesses(profile, { run = spawnSync } = {}) {
  const linux = process.platform === "linux";
  const list = (args) => {
    const result = run("/bin/ps", [...args, "pid=,pgid=,stat=,command="], { encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`Cannot list processes: ${result.stderr || result.error}`);
    return result.stdout.split("\n").map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/))
      .filter((fields) => fields && !fields[3].startsWith("Z")).map((fields) => [Number(fields[1]), Number(fields[2]), fields[4]]);
  };
  const token = tokenOf(profile);
  if (linux) {
    const carries = (pid) => { try { return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(token); } catch { return false; } };
    return list(["-axo"]).map(([pid, group, command]) => [pid, group, command, carries(pid), command]);
  }
  const rows = list(["-axEww", "-o"]);
  const shown = new Map(list(["-axo"]).map(([pid, , command]) => [pid, command]));
  return rows.map(([pid, group, command]) => [pid, group, command, `${command} `.includes(` ${token} `), shown.get(pid) ?? ""]);
}

// Each process in rows ([pid, group, command, has the token, shown]) that is
// the run's: [pid, group to stop or null, command to show].
function selectOwned(rows, child, owned, profile) {
  // An exited file that Node has not yet reaped keeps its ID.
  const running = child.exitCode === null && child.signalCode === null;
  const leads = ({ pid, marker }) => rows.some(([id, group, command]) => id === pid && group === pid && command.includes(marker));
  const groups = new Set([...(running ? [child.pid] : []), ...owned.filter(leads).map((entry) => entry.pid)]);
  return rows.filter(([pid, group, command, carries]) => pid !== process.pid && (groups.has(group) || carries || command.includes(profile)))
    .map(([pid, group, command, , shown = command]) => [pid, groups.has(group) ? group : null, shown]);
}

// [pid, parent, start time (Unix ms), command] for each process.
function windowsProcesses() {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,@{n='Created';e={([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}},CommandLine | ConvertTo-Json -Compress"],
  { encoding: "utf8", timeout: 15_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Cannot list Windows processes: ${result.stderr || result.error}`);
  return [JSON.parse(result.stdout || "[]")].flat().map((row) => [row.ProcessId, row.ParentProcessId, row.Created ?? 0, row.CommandLine ?? ""]);
}

// Windows has no process groups and no environment in this listing, so the
// run's processes are its roots (the running file, a reported tree's leader
// with its marker, anything with the profile on its command line) and their
// descendants. A parent ID can be reused, so a process is taken as a
// child only if it started after the parent it names. The check for what
// is left takes only the roots: a console child's conhost.exe, its child,
// can outlast it for a moment.
function selectWindows(rows, child, owned, profile, { descendants = true } = {}) {
  const running = child.exitCode === null && child.signalCode === null;
  const selected = new Map(rows.filter(([pid, , , command]) => (pid === child.pid && running) || command.includes(profile)
    || owned.some((entry) => entry.pid === pid && command.includes(entry.marker))).map((row) => [row[0], row]));
  for (let grew = descendants; grew;) {
    grew = false;
    for (const row of rows) {
      const parent = selected.get(row[1]);
      if (parent && !selected.has(row[0]) && row[2] >= parent[2]) { selected.set(row[0], row); grew = true; }
    }
  }
  return [...selected.values()].filter(([pid]) => pid !== process.pid);
}

// Stops each target only if its ID still names the process listed, by its
// start time. A .NET Process handle is held across that check and Kill()
// (as ui-races.test.mjs's killWindowsOwned does), so an ID reused between
// them cannot become the target. Like killWindowsOwned, it reads the start
// time again from the CIM listing the target came from, so the check
// compares one source's values exactly. One that has gone is skipped; one that could not be
// stopped and still runs is reported. Returns what it did with each target,
// with .NET's own start time beside the listed one.
function stopVerified(targets) {
  const script = `$done = @(); $failed = @(); foreach ($t in (ConvertFrom-Json '${JSON.stringify(targets)}')) {
    try { $p = [System.Diagnostics.Process]::GetProcessById([int]$t.pid) } catch { $done += "$($t.pid) gone"; continue }
    try { $handle = $p.Handle
      $row = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$t.pid)"
      $listed = if ($row) { ([DateTimeOffset]$row.CreationDate).ToUnixTimeMilliseconds() } else { 'none' }
      $started = 'none'; try { $started = ([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds() } catch { }
      $seen = "listed=$listed started=$started expected=$($t.created)"
      if ($row -and $listed -eq [long]$t.created) { $p.Kill(); $done += "$($t.pid) stopped $seen" } else { $done += "$($t.pid) skipped $seen" } }
    catch { $alive = $true; try { $alive = -not $p.HasExited } catch { }; if ($alive) { $failed += "$($t.pid): $($_.Exception.Message)" } else { $done += "$($t.pid) gone" } }
    finally { $p.Dispose() } }
  [Console]::Out.Write($done -join ';')
  if ($failed.Count) { [Console]::Error.WriteLine($failed -join '; '); exit 1 }
  exit 0`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 30_000 });
  if (result.status !== 0) throw new Error(`Cannot stop Windows processes: ${result.stderr?.toString().trim() || result.error}`);
  return result.stdout.toString().split(";").filter(Boolean);
}

function stopWindows(child, owned, profile, { list = windowsProcesses, stop = stopVerified } = {}) {
  // Node's handle names the file itself, never a process that reused its ID.
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  const targets = selectWindows(list(), child, owned, profile).filter(([pid]) => pid !== child.pid);
  if (targets.length) stop(targets.map(([pid, , created]) => ({ pid, created })));
}

function ownedLeft(child, owned, profile, { list } = {}) {
  if (process.platform === "win32") return selectWindows((list ?? windowsProcesses)(), child, owned, profile, { descendants: false }).map(([pid, , , command]) => [pid, null, command]);
  return selectOwned((list ?? (() => posixProcesses(profile)))(), child, owned, profile);
}

// Signals every target, each on its own: one that fails does not keep the
// others running. The run's processes are listed again before each signal,
// so a target that is no longer the run's is not signalled, and the members
// with the token of a group whose leader has just gone become targets of
// their own. A group that rejects the signal (macOS Chrome can put protected
// helpers in its group, ui-races.test.mjs) is stopped through its members.
// Failures are reported after every target has been tried.
function stopOwned(child, owned, profile, { list, kill = (target, signal) => process.kill(target, signal), ...windows } = {}) {
  if (process.platform === "win32") { stopWindows(child, owned, profile, { list, ...windows }); return; }
  const current = () => ownedLeft(child, owned, profile, { list });
  const targetsOf = (left) => new Set(left.map(([pid, group]) => (group === null ? pid : -group)));
  const errors = [];
  const signal = (target) => {
    try { kill(target, "SIGKILL"); return true; }
    catch (error) {
      if (error.code === "ESRCH") return true;
      if (error.code !== "EPERM" || target > 0) errors.push(new Error(`SIGKILL ${target}: ${error.message}`, { cause: error }));
      return false;
    }
  };
  // Each turn signals one target from a fresh listing: first the members of
  // a group that refused the signal, then the next target not yet tried.
  const tried = new Set();
  const refusing = new Set();
  for (let turns = 0; turns < 1_000; turns++) {
    const left = current();
    const target = left.find(([pid, group]) => refusing.has(group) && !tried.has(pid))?.[0]
      ?? [...targetsOf(left)].find((candidate) => !tried.has(candidate));
    if (target === undefined) break;
    tried.add(target);
    if (!signal(target) && target < 0) refusing.add(-target);
  }
  if (errors.length) throw new AggregateError(errors, `Cannot stop the run's processes: ${errors.map((error) => error.message).join("; ")}`);
}

// cancel defaults to asking the file over IPC; a test may end the owner
// instead. A closed channel does not throw on send: it reports the error
// later, to the callback, so asking a file that has gone is a no-op.
// stop may give stopOwned another kill (the EPERM test); owned may be the
// caller's own list of the reports, to see them as they come. The output is
// closed, the run checked for what is left and the profile removed even if
// a stop fails; the run's stop failures are returned in stopErrors.
const askCancel = (child) => { if (child.connected) child.send("cancel", () => {}); };
async function runOwned(args, { env, cancelAt, graceMs, closeMs = 10_000, cancel = askCancel, stop = {}, owned = [] }) {
  const profile = mkdtempSync(path.join(tmpdir(), "outright-fixture-owner-"));
  const runEnv = { ...env, OUTRIGHT_TEST_UI_PROFILE: profile };
  delete runEnv.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, args, {
    cwd: root, env: runEnv, stdio: ["ignore", "pipe", "pipe", "ipc"], detached: process.platform !== "win32", windowsHide: true,
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  child.on("message", (message) => {
    if (typeof message?.owned === "string" && Number.isInteger(message.pid) && typeof message.marker === "string" && message.marker) owned.push({ role: message.owned, pid: message.pid, marker: message.marker });
  });
  // "close" comes only once the file has exited and every holder of its output has closed it.
  const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal, closedAt: Date.now() })));
  const within = (ms) => { let timer; return Promise.race([closed, new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); })]).finally(() => clearTimeout(timer)); };
  const stopErrors = [];
  const tryStop = () => { try { stopOwned(child, owned, profile, stop); } catch (error) { stopErrors.push(error); } };
  let outcome = "finished";
  let result = null;
  let left = [];
  let cancelledAt = null;
  try {
    result = await Promise.race([closed, cancelAt(owned, profile).then(() => null)]);
    if (!result) {
      outcome = "cancelled";
      cancelledAt = Date.now();
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
  // How long the file took to close after the cancel, for a failure's message.
  const cancelToCloseMs = result && cancelledAt ? result.closedAt - cancelledAt : null;
  return { ...result, outcome, output, owned, left, stopErrors, profile, cancelToCloseMs, outputClosed: Boolean(result) };
}
// A cancel point for runOwned, which races it with the run closing: it
// waits on no process, so it must not hold the event loop open.
const after = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });
// Waits that poll for a process to go use this ref'd timer: once the process
// has gone, nothing else may hold the event loop open for the rest of a test.
const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
// Whether a child of this file exits within ms (an already exited one does).
const exitsWithin = (child, ms) => new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) { resolve(true); return; }
  const timer = setTimeout(() => { child.off("exit", exited); resolve(false); }, ms);
  const exited = () => { clearTimeout(timer); resolve(true); };
  child.once("exit", exited);
});
// A running process's command line as ps shows it, or "" once it has gone.
// A process that has exited is gone even while it waits as a zombie for a
// parent to reap it, which a container's PID 1 may never do.
const commandOf = (pid) => {
  const [, state = "", command = ""] = /^\s*(\S+)\s?(.*)$/s.exec(spawnSync("/bin/ps", ["-o", "stat=,command=", "-p", String(pid)], { encoding: "utf8", timeout: 5_000 }).stdout?.trim() ?? "") ?? [];
  return state.startsWith("Z") ? "" : command.trim();
};

// Another run's processes, alive for this whole file: their command lines
// have what this file's runs use (owned-hang's marker and a fixture Vite
// title), but they are not this file's. No run's stop may take them. The
// decoy stays in this file's group (runs are in groups of their own), so
// the suite's stop of the file's group takes it, and it exits when its
// input closes, as it does when this file dies by any means.
const decoyMarker = `outright-owned-hang-decoy-${randomUUID()} outright-ui-races-vite-decoy-${randomUUID()}`;
const decoyArgs = (marker) => ["-e", "process.stdin.on('end', () => process.exit()); process.stdin.resume(); setInterval(() => {}, 1000);", marker];
const decoyOptions = { stdio: ["pipe", "ignore", "ignore"] };
let decoy;
before(() => {
  if (process.platform === "win32") return;
  decoy = spawn(process.execPath, decoyArgs(decoyMarker), decoyOptions);
});
afterAll(() => { if (decoy?.exitCode === null && decoy.signalCode === null) decoy.kill("SIGKILL"); });
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

// The build runs before anything reports, and blocks the file, so a run
// stopped mid-build is forced. Its build is in the owner's profile, which
// the owner removes.
test("a built fixture forced to stop mid-build leaves neither its build nor the owner's profile", { timeout: 120_000 }, async () => {
  const env = { ...process.env, OUTRIGHT_UI_BUILD: "1", OUTRIGHT_UI_STEP: "files pdf build load" };
  let build;
  const building = (owned, profile) => new Promise((resolve) => {
    const until = Date.now() + 60_000;
    const check = () => {
      // The profile is gone once the run has ended without a build.
      build = existsSync(profile) ? readdirSync(profile).find((name) => name.startsWith("outright-ui-build-")) : undefined;
      if (build || !existsSync(profile) || Date.now() > until) resolve(); else setTimeout(check, 50);
    };
    check();
  });
  const run = await runOwned(browserRun, { env, cancelAt: building, cancel: () => {}, graceMs: 0 });
  assert(build, `the fixture did not build in the owner's profile: ${run.output.slice(-2000)}`);
  assert.equal(run.outcome, "forced", run.output.slice(-2000));
  assert(run.outputClosed, "the fixture's output stayed open");
  assert.deepEqual(run.left, [], "the fixture left processes running");
  assert.deepEqual(run.stopErrors, []);
  assert(!existsSync(path.join(run.profile, build)) && !existsSync(run.profile), "the build or the owner's profile was left behind");
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
// title is this launch's alone, its marker. On Windows, libuv puts each
// child it does not detach in a job that ends when its parent does
// (src/win/process.c, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE): Windows ends the
// fixture as its owner dies, and the fixture's own job ends its Vite and
// Chrome, before the fixture can say why (the owner's output closes about
// a second after the kill, with nothing more in it). There the fixture
// still must not outlive its owner, nor leave anything running.
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
  const seen = JSON.stringify({ outcome: run.outcome, signal: run.signal, cancelToCloseMs: run.cancelToCloseMs, left: run.left, output: run.output.slice(-2000) });
  assert.deepEqual(run.owned.map((entry) => entry.role).sort(), ["Chrome", "Vite", "fixture"], seen);
  assert.equal(run.outcome, "cancelled", `the fixture did not end when its owner died: ${seen}`);
  assert.equal(run.signal, "SIGKILL", seen);
  if (process.platform !== "win32") assert.match(run.output, /The fixture's owner went away/, seen);
  assert.doesNotMatch(run.output, /UI harness cleanup failed/, seen);
  assert(run.outputClosed, `the fixture's output stayed open: ${seen}`);
  assert.deepEqual(run.left, [], `the fixture left processes running: ${seen}`);
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
  // The reported service refuses every signal; the fixture and its helper
  // do not. Only what the run reported is refused, and killed afterwards.
  const owned = [];
  const service = (target) => owned.some((entry) => entry.role === "service" && entry.pid === Math.abs(target));
  const kill = (target, signal) => { if (service(target)) throw refused(target); process.kill(target, signal); };
  let run;
  try {
    run = await runOwned([ownedHang], {
      env: process.env, owned, cancelAt: () => ownedReported(owned, ["service"], 10_000), graceMs: 1_000, stop: { kill },
    });
    assert.equal(run.outcome, "forced", run.output);
    assert(run.outputClosed, "the fixture's output stayed open");
    assert(!existsSync(run.profile), "the owner's profile was left behind");
    assert.equal(run.left.length, 1, run.left.join("\n"));
    assert(run.left[0].startsWith(`${run.owned[0].pid} `), run.left.join("\n"));
    assert(run.stopErrors.length >= 1 && run.stopErrors.every((error) => /EPERM/.test(error.message)), run.stopErrors.map((error) => error.message).join("; "));
  } finally {
    for (const entry of owned) if (commandOf(entry.pid).includes(entry.marker)) process.kill(entry.pid, "SIGKILL");
  }
});

test("the forced stop takes only the members of a leaderless group that have the run's token", { skip: process.platform === "win32" }, () => {
  const profile = "/tmp/outright-fixture-owner-test";
  const gone = { pid: 100, exitCode: 0, signalCode: null };
  const owned = [{ role: "Vite", pid: 300, marker: "outright-ui-races-vite-test" }];
  // Vite (300) has gone; its group's ID may now be another run's.
  const rows = [[301, 300, "esbuild --service", true], [302, 300, "another run's helper", false], [101, 100, "node helper", true], [103, 100, "another run's node", false]];
  assert.deepEqual(selectOwned(rows, gone, owned, profile), [[301, null, "esbuild --service"], [101, null, "node helper"]]);
  const signalled = [];
  stopOwned(gone, owned, profile, { list: () => rows, kill: (target) => signalled.push(target) });
  assert.deepEqual(signalled, [301, 101]);
});

test("the forced stop does not signal a target whose ID names another process by its turn", { skip: process.platform === "win32" }, () => {
  const profile = "/tmp/outright-fixture-owner-test";
  const gone = { pid: 100, exitCode: 0, signalCode: null };
  const owned = [{ role: "Vite", pid: 300, marker: "outright-ui-races-vite-test" }, { role: "service", pid: 400, marker: "outright-owned-hang-test" }];
  const listings = [
    [[300, 300, "outright-ui-races-vite-test", true], [400, 400, "node -e outright-owned-hang-test", true], [500, 500, "helper", true]],
    // After Vite's turn the helper's ID names another process.
    [[400, 400, "node -e outright-owned-hang-test", true], [500, 500, "unrelated", false]],
  ];
  let call = 0;
  const signalled = [];
  stopOwned(gone, owned, profile, { list: () => listings[Math.min(call++, 1)], kill: (target) => signalled.push(target) });
  assert.deepEqual(signalled, [-300, -400]);
});

test("on Windows the forced stop takes the run's roots and their later children, and checks each start time again", () => {
  const profile = "C:\\Temp\\outright-fixture-owner-test";
  const child = { pid: 10, exitCode: 0, signalCode: null };
  const owned = [{ role: "Vite", pid: 20, marker: "outright-ui-races-vite-test" }, { role: "Chrome", pid: 30, marker: profile }];
  const rows = [
    [20, 10, 200, "node --title=outright-ui-races-vite-test vite.js"], [21, 20, 210, "esbuild --service"],
    [30, 10, 300, `chrome.exe --user-data-dir=${profile}`], [31, 30, 310, "chrome.exe --type=renderer"], [32, 31, 320, "chrome.exe --type=gpu"],
    // 40 reused a reported ID; 41 names a selected parent but started before it, so its parent ID was reused.
    [40, 1, 400, "node another-run.js"], [41, 30, 100, "older process"], [42, 40, 420, "child of another run"],
  ];
  const reportedAgain = [...owned, { role: "Vite", pid: 40, marker: "outright-ui-races-vite-earlier" }];
  assert.deepEqual(selectWindows(rows, child, reportedAgain, profile).map(([pid]) => pid), [20, 30, 21, 31, 32]);
  let targets;
  const running = { pid: 10, exitCode: null, signalCode: null, kill: (signal) => { running.killed = signal; } };
  stopWindows(running, owned, profile, { list: () => [[10, 1, 100, "node fixture"], ...rows], stop: (list) => { targets = list; } });
  assert.equal(running.killed, "SIGKILL");
  assert.deepEqual(targets, [{ pid: 20, created: 200 }, { pid: 30, created: 300 }, { pid: 21, created: 210 }, { pid: 31, created: 310 }, { pid: 32, created: 320 }]);
});

test("the forced stop goes on through the token members of a group whose leader leaves before its turn", { skip: process.platform === "win32" }, () => {
  const profile = "/tmp/outright-fixture-owner-test";
  const gone = { pid: 100, exitCode: 0, signalCode: null };
  const owned = [{ role: "Vite", pid: 300, marker: "outright-ui-races-vite-test" }, { role: "Chrome", pid: 200, marker: profile }];
  const vite = [[300, 300, "outright-ui-races-vite-test", true], [301, 300, "esbuild --service", true], [302, 300, "another run's helper", false]];
  const chrome = [[200, 200, `chrome --user-data-dir=${profile}`, true], [201, 200, "chrome helper", true]];
  const stop = (listings, refuse) => {
    let call = 0;
    const signalled = [];
    stopOwned(gone, owned, profile, { list: () => listings[Math.min(call++, listings.length - 1)],
      kill: (target) => { signalled.push(target); if (target === refuse) throw refused(target); } });
    return signalled;
  };
  // Vite leaves while Chrome's group is stopped: its token member is still stopped.
  assert.deepEqual(stop([[...chrome, ...vite], vite.slice(1)]), [-200, 301]);
  // Chrome's group refuses the signal, and Chrome leaves before its members are listed.
  assert.deepEqual(stop([chrome, chrome.slice(1)], -200), [-200, 201]);
  // Chrome's group refuses the signal; once its first helper is stopped, the
  // next helper's ID names another process, which is left alone.
  const helpers = [...chrome, [202, 200, "chrome helper", true]];
  assert.deepEqual(stop([helpers, helpers, helpers, [[202, 900, "unrelated", false]]], -200), [-200, 200, 201]);
});

test("the owner's decoy does not outlive a file that is killed", { skip: process.platform === "win32", timeout: 30_000 }, async () => {
  const file = spawn(process.execPath, ["-e", `const c = require("node:child_process").spawn(process.execPath, ...JSON.parse(process.argv[1]));
    console.log(c.pid); setInterval(() => {}, 1000);`, JSON.stringify([decoyArgs(`outright-decoy-probe-${randomUUID()}`), decoyOptions])], { stdio: ["ignore", "pipe", "ignore"] });
  const pid = await new Promise((resolve) => file.stdout.once("data", (chunk) => resolve(Number.parseInt(chunk, 10))));
  assert(commandOf(pid).includes("outright-decoy-probe-"), "the probe's decoy did not start");
  file.kill("SIGKILL");
  const until = Date.now() + 10_000;
  while (commandOf(pid) && Date.now() < until) await pause(100);
  assert.equal(commandOf(pid), "", "the decoy outlived its file");
});

test("on Windows the verified stop ends a process only while its start time matches", { skip: process.platform !== "win32", timeout: 60_000 }, async (t) => {
  const target = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  const spawnedAt = Date.now();
  let ended = null;
  target.once("exit", (code, signal) => { ended = `exited (${code ?? signal}) ${Date.now() - spawnedAt}ms after it started`; });
  const report = (phase, done) => { const line = `${phase}: ${done.join("; ")}; target ${ended ?? "running"}`; t.diagnostic(line); return line; };
  try {
    await new Promise((resolve) => target.once("spawn", resolve));
    const [, , created] = windowsProcesses().find(([pid]) => pid === target.pid);
    const mismatched = stopVerified([{ pid: target.pid, created: created - 1 }]);
    const stoppedEarly = await exitsWithin(target, 1_000);
    const first = report("another start time", mismatched);
    assert(!stoppedEarly && mismatched.some((line) => line.startsWith(`${target.pid} skipped `)), `a process with another start time was stopped: ${first}`);
    // One that has gone by then is skipped, not a failure.
    const exited = spawn(process.execPath, ["-e", ""], { stdio: "ignore", windowsHide: true });
    await new Promise((resolve) => exited.once("spawn", resolve));
    const [, , exitedCreated] = windowsProcesses().find(([pid]) => pid === exited.pid) ?? [, , 0];
    await exitsWithin(exited, 10_000);
    const matching = stopVerified([{ pid: target.pid, created }, { pid: exited.pid, created: exitedCreated }]);
    const stopped = await exitsWithin(target, 10_000);
    const second = report("its own start time", matching);
    assert(stopped && matching.some((line) => line.startsWith(`${target.pid} stopped `)), `the verified process was not stopped: ${second}`);
    assert(!matching.some((line) => line.startsWith(`${exited.pid} stopped `)), `a process that had gone was stopped: ${second}`);
  } finally { target.kill(); }
});

test("on macOS one listing gives each process's group, command and token together", { skip: process.platform !== "darwin" }, () => {
  const profile = "/tmp/outright-fixture-owner-test";
  // A second listing would show Vite's ID as another process with the token.
  // The plain listing, read second, shows Vite's ID as another process.
  let envListings = 0;
  const run = (command, args) => (args.includes("-axEww") ? (envListings++, { status: 0, stdout: " 300   300 S    outright-ui-races-vite-test HOME=/x\n" })
    : { status: 0, stdout: " 300   900 S    other\n" });
  const rows = posixProcesses(profile, { run });
  assert.equal(envListings, 1);
  assert.deepEqual(rows, [[300, 300, "outright-ui-races-vite-test HOME=/x", false, "other"]]);
});

test("no process's environment reaches what the owner shows", { skip: process.platform === "win32" }, () => {
  const profile = "/tmp/outright-fixture-owner-test";
  const env = ` API_KEY=REVIEW_SENTINEL OUTRIGHT_TEST_UI_PROFILE=${profile}`;
  const run = (command, args) => ({ status: 0, stdout: ` 400   400 S    node helper${args.includes("-axEww") ? env : ""}\n` });
  const listed = process.platform === "linux" ? [[400, 400, "node helper", true, "node helper"]] : posixProcesses(profile, { run });
  const left = selectOwned(listed, { pid: 1, exitCode: 0, signalCode: null }, [], profile);
  assert.deepEqual(left, [[400, null, "node helper"]]);
  assert(!JSON.stringify(left).includes("REVIEW_SENTINEL"));
});

test("on Linux a process is known by a token whose profile path is not ASCII", { skip: process.platform !== "linux", timeout: 30_000 }, async () => {
  const profile = path.join(tmpdir(), `outright-fixture-owner-é-${randomUUID()}`);
  const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", env: { ...process.env, OUTRIGHT_TEST_UI_PROFILE: profile } });
  try {
    await new Promise((resolve) => helper.once("spawn", resolve));
    assert(posixProcesses(profile).some(([pid, , , carries]) => pid === helper.pid && carries), "the helper's token was not recognised");
  } finally { helper.kill("SIGKILL"); }
});

// Last in the file: every run above has been stopped by now.
test("no run's stop took another run's processes", { skip: process.platform === "win32" }, () => {
  assert.equal(decoy.exitCode, null);
  assert.equal(decoy.signalCode, null);
  assert(commandOf(decoy.pid).includes(decoyMarker), "another run's process was stopped");
});
