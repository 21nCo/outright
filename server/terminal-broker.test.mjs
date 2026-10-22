import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { AGENT_SUPERVISOR } from "./agent-manager.mjs";
import { proofMatches, reattachNonce, reattachProof } from "./terminal-reattach-proof.mjs";

const brokerScript = fileURLToPath(new URL("./terminal-broker.mjs", import.meta.url));

test("broker preserves a failing shell exit in its frame and process status", { timeout: 15_000 }, async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pty-broker-exit-"));
  const address = process.platform === "win32"
    ? `\\\\.\\pipe\\outright-broker-test-${randomUUID()}` : path.join(directory, "broker.sock");
  const token = randomUUID() + randomUUID();
  const broker = spawn(process.execPath, [brokerScript, address, token], {
    stdio: ["ignore", "ignore", "pipe"], detached: process.platform !== "win32", windowsHide: true,
  });
  let socket;
  const frames = [];
  let pending = "";
  let exitFrameReady;
  const exitFrame = new Promise((resolve) => { exitFrameReady = resolve; });
  try {
    const deadline = Date.now() + 8000;
    while (!socket && Date.now() < deadline && broker.exitCode === null) {
      try {
        socket = await new Promise((resolve, reject) => {
          const candidate = net.createConnection(address);
          candidate.once("connect", () => resolve(candidate));
          candidate.once("error", reject);
        });
      } catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
    }
    assert.ok(socket, "broker did not listen");
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      pending += chunk;
      let end;
      while ((end = pending.indexOf("\n")) !== -1) {
        const frame = JSON.parse(pending.slice(0, end));
        frames.push(frame);
        if (frame.type === "shell-exited") exitFrameReady(frame);
        pending = pending.slice(end + 1);
      }
    });
    socket.write(`${JSON.stringify({ type: "start", token, shell: process.execPath,
      cwd: directory, env: process.env, cols: 80, rows: 24 })}\n`);
    while (!frames.some((frame) => frame.type === "ready") && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(frames.some((frame) => frame.type === "ready"), "PTY did not become ready");
    let timeout;
    const closed = new Promise((resolve) => broker.once("close", (code, signal) => resolve({ code, signal })));
    socket.write(`${JSON.stringify({ type: "write", data: "process.exit(7)\r" })}\n`);
    let result;
    try {
      [result] = await Promise.race([
        Promise.all([closed, exitFrame]),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("broker exit or final frame was not delivered")), 6000); }),
      ]);
    } finally { clearTimeout(timeout); }
    assert.deepEqual(frames.filter((frame) => frame.type === "shell-exited"),
      [{ type: "shell-exited", exitCode: 7, signal: 0 }]);
    assert.deepEqual(result, { code: 7, signal: null });
  } finally {
    socket?.destroy();
    if (broker.exitCode === null) {
      if (process.platform === "win32") spawnSync("taskkill", ["/T", "/F", "/PID", String(broker.pid)],
        { windowsHide: true, stdio: "ignore", timeout: 5000 });
      else try { process.kill(-broker.pid, "SIGKILL"); } catch {}
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("broker diagnostics keep lifecycle events after sustained terminal input", { timeout: 20_000 }, async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pty-broker-diagnostics-"));
  const address = process.platform === "win32"
    ? `\\\\.\\pipe\\outright-broker-diagnostics-${randomUUID()}` : path.join(directory, "broker.sock");
  const token = randomUUID() + randomUUID();
  const broker = spawn(process.execPath, [brokerScript, address, token], {
    stdio: ["ignore", "ignore", "pipe"], detached: process.platform !== "win32", windowsHide: true,
    env: { ...process.env, OUTRIGHT_BROKER_DIAGNOSTICS: "1" },
  });
  const closed = new Promise((resolve) => broker.once("close", resolve));
  let stderr = "";
  broker.stderr.setEncoding("utf8");
  broker.stderr.on("data", (chunk) => { stderr += chunk; });
  let socket;
  let frames = "";
  try {
    const deadline = Date.now() + 10_000;
    while (!socket && Date.now() < deadline && broker.exitCode === null) {
      try {
        socket = await new Promise((resolve, reject) => {
          const candidate = net.createConnection(address);
          candidate.once("connect", () => resolve(candidate));
          candidate.once("error", reject);
        });
      } catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
    }
    assert.ok(socket, "broker did not listen");
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { frames += chunk; });
    socket.write(`${JSON.stringify({ type: "start", token, shell: process.execPath,
      cwd: directory, env: process.env, cols: 80, rows: 24 })}\n`);
    while (!frames.includes('"type":"ready"') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(frames.includes('"type":"ready"'), "PTY did not become ready");
    // More separate input writes than the whole lifecycle event budget.
    for (let index = 0; index < 100; index += 1) {
      socket.write(`${JSON.stringify({ type: "write", data: `${index};\r` })}\n`);
      await new Promise((resolve) => setImmediate(resolve));
    }
    socket.write(`${JSON.stringify({ type: "write", data: "process.exit(0)\r" })}\n`);
    while (!frames.includes('"type":"shell-exited"') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(frames.includes('"type":"shell-exited"'), "the shell exit frame was not delivered");
    socket.destroy();
    await closed;
    const events = stderr.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const names = events.map((event) => event.broker);
    assert.ok(names.includes("shell-exit"), `shell-exit missing from ${names.join(",")}`);
    assert.ok(names.includes("peer-closed"), `peer-closed missing from ${names.join(",")}`);
    assert.ok(events.length < 64, "interaction consumed the lifecycle event budget");
    assert.ok(events.at(-1).inputWrites >= 1 && events.at(-1).inputBytes > 0, "input activity was not aggregated");
  } finally {
    socket?.destroy();
    if (broker.exitCode === null) {
      if (process.platform === "win32") spawnSync("taskkill", ["/T", "/F", "/PID", String(broker.pid)],
        { windowsHide: true, stdio: "ignore", timeout: 5000 });
      else try { process.kill(-broker.pid, "SIGKILL"); } catch {}
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Windows terminal supervisor stop empties the owned Job Object when a PTY cannot exit", { skip: process.platform !== "win32", timeout: 15_000 }, async () => {
  // A broker whose terminal.kill fails still loses its owner socket. The
  // managed adapter sends stop on that path; exercise the native control pipe
  // with a child that will not exit on its own and inspect the OS process.
  const owner = spawn(AGENT_SUPERVISOR, [process.execPath, "-e",
    'console.log("OWNED_CHILD=" + process.pid); setInterval(() => {}, 1000)'],
  { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let output = "";
  let errorOutput = "";
  owner.stdout.on("data", (chunk) => { output += chunk; });
  owner.stderr.on("data", (chunk) => { errorOutput += chunk; });
  try {
    const deadline = Date.now() + 5000;
    while (!/OWNED_CHILD=(\d+)/.test(output) && Date.now() < deadline && owner.exitCode === null) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const childPid = Number(output.match(/OWNED_CHILD=(\d+)/)?.[1]);
    assert.ok(childPid, `owned child did not start: ${errorOutput}`);
    const identity = spawnSync(AGENT_SUPERVISOR, ["--identity", String(owner.pid)],
      { encoding: "utf8", windowsHide: true, timeout: 1500 });
    assert.match(identity.stdout, /^\d+\s*$/);
    owner.stdin.end("stop\n");
    let timeout;
    await Promise.race([
      new Promise((resolve) => owner.once("close", resolve)),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("native owner retained a live Job Object after stop")), 5000); }),
    ]).finally(() => clearTimeout(timeout));
    const probe = spawnSync(AGENT_SUPERVISOR, ["--probe", String(owner.pid), identity.stdout.trim()],
      { encoding: "utf8", windowsHide: true, timeout: 1500 });
    assert.equal(probe.stdout.trim(), "absent", "native owner remained after Job Object stop");
    assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" }, "owned child survived native stop");
  } finally {
    owner.stdin.destroy();
    // The Job Object owner can exit before an escaped or fault-injected child.
    // Always inspect and clean up the fixture child independently.
    const childPid = Number(output.match(/OWNED_CHILD=(\d+)/)?.[1]);
    if (childPid) {
      try { process.kill(childPid, 0); spawnSync("taskkill", ["/T", "/F", "/PID", String(childPid)],
        { windowsHide: true, stdio: "ignore", timeout: 5000 }); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    if (owner.exitCode === null) spawnSync("taskkill", ["/T", "/F", "/PID", String(owner.pid)],
      { windowsHide: true, stdio: "ignore", timeout: 5000 });
  }
});

test("a slow broker reader backpressures sustained PTY output without losing its shell", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pty-broker-"));
  const address = process.platform === "win32"
    ? `\\\\.\\pipe\\outright-broker-test-${randomUUID()}` : path.join(directory, "broker.sock");
  const token = randomUUID() + randomUUID();
  // Bounded broker lifecycle events identify which boundary held a missing
  // exit: queued input, PTY exit notification, or final frame delivery.
  const broker = spawn(process.execPath, [brokerScript, address, token], {
    stdio: ["ignore", "ignore", "pipe"], detached: process.platform !== "win32", windowsHide: true,
    env: { ...process.env, OUTRIGHT_BROKER_DIAGNOSTICS: "1" },
  });
  let stderr = "";
  broker.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-8192); });
  const shellState = () => {
    const pid = Number(/"shellPid":(\d+)/.exec(stderr)?.[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0) return "shell pid unknown";
    try { process.kill(pid, 0); return `shell ${pid} alive`; }
    catch (error) { return `shell ${pid} ${error.code === "ESRCH" ? "gone" : error.code}`; }
  };
  let socket;
  let pending = "";
  let closed = false;
  let brokerExited = false;
  let dataBytes = 0;
  let recentData = "";
  // Any earlier omission notice reaches the socket before later input can
  // reach the shell, so only a notice that follows the colored burst's own
  // characters proves that burst was shed. Counting them avoids depending on
  // ConPTY rendering the burst's first row.
  let coloredChars = 0;
  let omissionReset = false;
  const received = [];
  const waiters = new Set();
  const notify = () => { for (const waiter of waiters) waiter(); };
  broker.on("close", () => { brokerExited = true; closed = true; notify(); });
  try {
    const deadline = Date.now() + 8000;
    while (!socket && Date.now() < deadline && !closed) {
      try {
        socket = await new Promise((resolve, reject) => {
          const candidate = net.createConnection(address);
          candidate.once("connect", () => resolve(candidate));
          candidate.once("error", reject);
        });
      } catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
    }
    assert.ok(socket, `broker failed to listen: ${stderr}`);
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      pending += chunk;
      let end;
      while ((end = pending.indexOf("\n")) !== -1) {
        const frame = JSON.parse(pending.slice(0, end));
        pending = pending.slice(end + 1);
        if (frame.type === "data") {
          dataBytes += Buffer.byteLength(frame.data);
          recentData = `${recentData}${frame.data}`.slice(-128);
          if (coloredChars >= 4096 && frame.data.includes("[Outright:") && frame.data.startsWith("\u001b[0m\r\n")) omissionReset = true;
          coloredChars += frame.data.split("c").length - 1;
        } else received.push(frame.type);
        notify();
      }
    });
    socket.on("close", () => { closed = true; notify(); });
    const until = async (condition, label, timeoutMs = 20_000) => {
      const expires = Date.now() + timeoutMs;
      while (!condition() && !closed && Date.now() < expires) {
        await new Promise((resolve) => {
          const timer = setTimeout(() => { waiters.delete(wake); resolve(); }, 100);
          const wake = () => { clearTimeout(timer); waiters.delete(wake); resolve(); };
          waiters.add(wake);
        });
      }
      assert.ok(condition(), `${label}; broker closed=${closed}, output=${dataBytes}, tail=${JSON.stringify(recentData)}, ${shellState()}, stderr=${stderr}`);
    };
    socket.write(`${JSON.stringify({ type: "start", token, shell: process.execPath,
      cwd: directory, env: process.env, cols: 80, rows: 24 })}\n`);
    await until(() => received.includes("ready"), "PTY did not become ready");

    // The broker may shed any PTY output while its socket is backed up, even
    // behind a reader that is pulling (and Windows sheds ConPTY output rather
    // than pausing it), so every wait below is on a file the shell writes or
    // on a frame the broker never sheds.
    const shellWrote = (name) => existsSync(path.join(directory, name));
    // A full read window shows this reader has stopped pulling output; it
    // resumes before the burst can finish. Whether the broker paused behind
    // it depends on kernel buffer sizes, so only the silent span below
    // asserts a broker-side pause.
    socket.pause();
    socket.write(`${JSON.stringify({ type: "write",
      data: 'process.stdout.write("x".repeat(8*1024*1024)); require("fs").writeFileSync("burst-done", "")\r' })}\n`);
    await until(() => socket.readableLength >= socket.readableHighWaterMark, "paused broker reader did not fill its read window");
    assert.equal(closed, false, `slow reader disconnected its broker: ${stderr}`);
    socket.resume();
    await until(() => shellWrote("burst-done"), "burst did not finish");
    await until(() => dataBytes > 1024 * 1024, "the fixture did not sustain enough PTY output to backpressure the socket");
    // The broker hands input to the shell only while it is unpaused with no
    // queued output, so this file shows the first burst has drained and its
    // stalled-reader timer is cleared before the reader goes silent again.
    socket.write(`${JSON.stringify({ type: "write", data: 'require("fs").writeFileSync("burst-drained", "")\r' })}\n`);
    await until(() => shellWrote("burst-drained"), "broker did not drain the first burst");

    // Stay silent until the shell's whole burst has been written. 2 MiB is
    // far larger than every socket, pipe and PTY buffer, so the broker has
    // shed output and is still waiting on this reader; later input cannot
    // reach the shell mid-burst. The broker tears down a reader that stays
    // silent for its 8s stalled-reader window, so the silent span is bounded
    // well inside it: the 2s Unix PTY hold plus a short drain on every OS.
    const stalledReaderMs = 8000;
    const silentBudgetMs = 6000;
    socket.pause();
    coloredChars = 0;
    omissionReset = false;
    const silentSince = Date.now();
    socket.write(`${JSON.stringify({ type: "write",
      data: 'process.stdout.write("\\u001b[31m"+"c".repeat(2*1024*1024)); require("fs").writeFileSync("burst-written", "")\r' })}\n`);
    await until(() => shellWrote("burst-written"),
      `shell did not finish its burst within ${silentBudgetMs}ms of a silent reader (broker stalled-reader window ${stalledReaderMs}ms)`, silentBudgetMs);
    const silentMs = Date.now() - silentSince;
    t.diagnostic(`silent reader span ${silentMs}ms of the ${stalledReaderMs}ms stalled-reader window`);
    // This input is sent while the client is still silent; the shell must
    // still run it, once, after the reader resumes.
    socket.write(`${JSON.stringify({ type: "write", data: 'require("fs").appendFileSync("later-ran", "later\\n")\r' })}\n`);
    socket.resume();
    await until(() => omissionReset, "shed colored output did not reset styling before its notice");
    await until(() => shellWrote("later-ran"), "shell did not accept later input");
    socket.write(`${JSON.stringify({ type: "write", data: "process.exit(0)\r" })}\n`);
    try { await until(() => received.includes("shell-exited"), "shell exit was not delivered"); }
    catch (error) {
      // Stop the shell outside its PTY. The broker's shell-exit event then
      // records whether the exit input reached the PTY or is still queued.
      const pid = Number(/"shellPid":(\d+)/.exec(stderr)?.[1]);
      if (pid > 0) try { process.kill(pid); } catch {}
      const expires = Date.now() + 3000;
      while (!stderr.includes('"broker":"shell-exit"') && Date.now() < expires) await new Promise((resolve) => setTimeout(resolve, 25));
      error.message += `; after stopping the shell: ${stderr}`;
      throw error;
    }
    const exitDeadline = Date.now() + 5000;
    while (!brokerExited && Date.now() < exitDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(brokerExited, true, "broker process did not exit after its shell exited");
    assert.equal(readFileSync(path.join(directory, "later-ran"), "utf8"), "later\n", "shell did not run later input exactly once");
    // These counts are lifetime totals, so the 8 MiB first burst can satisfy
    // them; they are only a cumulative sanity floor. The burst-scoped notice
    // check above (reset at the silent span's start, after 4096 of its own
    // "c" characters) is what proves the silent burst was shed. A notice
    // proves omitted output, not a pause: truncating a chunk over 64 KiB
    // emits one too.
    const counts = JSON.parse(/\{"broker":"shell-exit"[^\n]*/.exec(stderr)?.[0] ?? "null");
    assert.ok(counts, `broker did not report its shell exit: ${stderr}`);
    assert.ok(counts.pauses >= 1, `broker did not pause behind a silent reader: ${stderr}`);
    assert.ok(counts.shedChars > 0, `broker did not shed output behind a silent reader: ${stderr}`);
  } finally {
    socket?.destroy();
    if (broker.exitCode === null) {
      if (process.platform === "win32") spawnSync("taskkill", ["/T", "/F", "/PID", String(broker.pid)],
        { windowsHide: true, stdio: "ignore", timeout: 5000 });
      else try { process.kill(-broker.pid, "SIGKILL"); } catch {}
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a silent owner releases a broker after the shell exits behind backpressure", { timeout: 20_000 }, async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pty-broker-silent-"));
  const address = process.platform === "win32"
    ? `\\\\.\\pipe\\outright-broker-test-${randomUUID()}` : path.join(directory, "broker.sock");
  const token = randomUUID() + randomUUID();
  const broker = spawn(process.execPath, [brokerScript, address, token], {
    stdio: ["ignore", "ignore", "pipe"], detached: process.platform !== "win32", windowsHide: true,
  });
  let socket;
  try {
    const deadline = Date.now() + 8000;
    while (!socket && Date.now() < deadline && broker.exitCode === null) {
      try {
        socket = await new Promise((resolve, reject) => {
          const candidate = net.createConnection(address);
          candidate.once("connect", () => resolve(candidate));
          candidate.once("error", reject);
        });
      } catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
    }
    assert.ok(socket, "broker did not listen");
    const ready = new Promise((resolve, reject) => {
      let pending = "";
      socket.on("data", (chunk) => {
        pending += chunk;
        const end = pending.indexOf("\n");
        if (end !== -1 && JSON.parse(pending.slice(0, end)).type === "ready") resolve();
      });
      socket.once("error", reject);
    });
    socket.write(`${JSON.stringify({ type: "start", token, shell: process.execPath,
      cwd: directory, env: process.env, cols: 80, rows: 24 })}\n`);
    await ready;
    socket.pause();
    socket.write(`${JSON.stringify({ type: "write",
      data: 'process.stdout.write("x".repeat(8*1024*1024)); process.exit(0)\r' })}\n`);
    let timeout;
    const result = await Promise.race([
      new Promise((resolve) => broker.once("close", (code, signal) => resolve({ code, signal }))),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("silent peer stranded broker after shell exit")), 13_000); }),
    ]).finally(() => clearTimeout(timeout));
    assert.deepEqual(result, { code: 0, signal: null });
  } finally {
    socket?.destroy();
    if (broker.exitCode === null) {
      if (process.platform === "win32") spawnSync("taskkill", ["/T", "/F", "/PID", String(broker.pid)],
        { windowsHide: true, stdio: "ignore", timeout: 5000 });
      else try { process.kill(-broker.pid, "SIGKILL"); } catch {}
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("disconnecting a live owner releases the broker and its PTY child", { timeout: 20_000 }, async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pty-broker-disconnect-"));
  const address = process.platform === "win32"
    ? `\\\\.\\pipe\\outright-broker-test-${randomUUID()}` : path.join(directory, "broker.sock");
  const token = randomUUID() + randomUUID();
  const broker = spawn(process.execPath, [brokerScript, address, token], {
    stdio: ["ignore", "ignore", "pipe"], detached: process.platform !== "win32", windowsHide: true,
  });
  let stderr = "";
  broker.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-1024); });
  let socket;
  let shellPid;
  let pidOutput = "";
  let ready = false;
  let pending = "";
  try {
    const deadline = Date.now() + 5000;
    while (!socket && Date.now() < deadline && broker.exitCode === null) {
      try {
        socket = await new Promise((resolve, reject) => {
          const candidate = net.createConnection(address);
          candidate.once("connect", () => resolve(candidate));
          candidate.once("error", reject);
        });
      } catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
    }
    assert.ok(socket, "broker did not listen");
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      pending += chunk;
      let end;
      while ((end = pending.indexOf("\n")) !== -1) {
        const frame = JSON.parse(pending.slice(0, end));
        pending = pending.slice(end + 1);
        if (frame.type === "ready") ready = true;
        if (frame.type === "data") {
          // ConPTY may split a frame anywhere and can decorate line endings.
          // The closing tag proves the entire PID arrived without depending
          // on a particular platform's newline sequence.
          pidOutput = `${pidOutput}${frame.data}`.slice(-1024);
          const match = pidOutput.match(/OUTRIGHT_CHILD_PID=(\d+):END/);
          if (match) shellPid = Number(match[1]);
        }
      }
    });
    socket.write(`${JSON.stringify({ type: "start", token, shell: process.execPath,
      cwd: directory, env: process.env, cols: 80, rows: 24 })}\n`);
    while (!ready && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(ready, true);
    // Give Unix PTY hangup a short, observable child-exit delay. The broker
    // must remain its reaper instead of reporting a released owner first.
    socket.write(`${JSON.stringify({ type: "write", data: 'process.once("SIGHUP",()=>setTimeout(()=>process.exit(0),250)); process.stdout.write("OUTRIGHT_CHILD_PID="+process.pid+":END\\n")\r' })}\n`);
    const pidDeadline = Date.now() + 8000;
    while (!shellPid && Date.now() < pidDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(shellPid, `PTY child did not identify itself; broker=${broker.pid}/${broker.exitCode}/${broker.signalCode}, runner=${process.pid}, frames=${JSON.stringify(pidOutput)}, stderr=${stderr}`);
    let brokerClosedWithLiveChild = false;
    const brokerClosed = new Promise((resolve) => broker.once("close", () => {
      try { process.kill(shellPid, 0); brokerClosedWithLiveChild = true; }
      catch (error) { if (error.code !== "ESRCH") throw error; }
      resolve();
    }));
    socket.destroy();
    const released = () => {
      if (broker.exitCode === null) return false;
      try { process.kill(shellPid, 0); return false; } catch (error) { return error.code === "ESRCH"; }
    };
    const releaseDeadline = Date.now() + 5000;
    while (!released() && Date.now() < releaseDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(released(), "disconnected broker or PTY child remained alive");
    await brokerClosed;
    assert.equal(brokerClosedWithLiveChild, false, "broker reported release while its PTY child was still alive");
    await assert.rejects(new Promise((resolve, reject) => {
      const candidate = net.createConnection(address);
      candidate.once("connect", () => { candidate.destroy(); resolve(); });
      candidate.once("error", reject);
    }), "released broker still accepted a socket");
    if (process.platform !== "win32") assert.equal(existsSync(address), false, "broker left its Unix socket behind");
  } finally {
    socket?.destroy();
    if (broker.exitCode === null) {
      if (process.platform === "win32") spawnSync("taskkill", ["/T", "/F", "/PID", String(broker.pid)],
        { windowsHide: true, stdio: "ignore", timeout: 5000 });
      else try { process.kill(-broker.pid, "SIGKILL"); } catch {}
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

// A broker started like the managed launcher, with an optional reattach
// session, and a framed client for each connection the test opens.
async function startSessionBroker(t, { session, diagnostics = false, captureStdout = false } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pty-broker-session-"));
  const address = process.platform === "win32"
    ? `\\\\.\\pipe\\outright-broker-session-${randomUUID()}` : path.join(directory, "broker.sock");
  const broker = spawn(process.execPath, [brokerScript, address, randomUUID() + randomUUID()], {
    stdio: ["ignore", captureStdout ? "pipe" : "ignore", "pipe"], detached: process.platform !== "win32", windowsHide: true,
    env: { ...process.env, ...(diagnostics ? { OUTRIGHT_BROKER_DIAGNOSTICS: "1" } : {}) },
  });
  let stdout = "";
  broker.stdout?.setEncoding("utf8");
  broker.stdout?.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-4096); });
  let stderr = "";
  broker.stderr.setEncoding("utf8");
  broker.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-16_384); });
  const closed = new Promise((resolve) => broker.once("close", (code, signal) => resolve({ code, signal })));
  t.after(() => {
    if (broker.exitCode === null && broker.signalCode === null) {
      if (process.platform === "win32") spawnSync("taskkill", ["/T", "/F", "/PID", String(broker.pid)],
        { windowsHide: true, stdio: "ignore", timeout: 5000 });
      else try { process.kill(-broker.pid, "SIGKILL"); } catch {}
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const connect = async (deadline = Date.now() + 8000) => {
    for (;;) {
      try {
        return await new Promise((resolve, reject) => {
          const candidate = net.createConnection(address);
          candidate.once("connect", () => resolve(candidate));
          candidate.once("error", reject);
        });
      } catch (error) {
        if (Date.now() > deadline || broker.exitCode !== null) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  };
  const client = async (first) => {
    const socket = await connect();
    const frames = [];
    let pending = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      pending += chunk;
      let end;
      while ((end = pending.indexOf("\n")) !== -1) {
        frames.push(JSON.parse(pending.slice(0, end)));
        pending = pending.slice(end + 1);
      }
    });
    let isClosed = false;
    const ended = new Promise((resolve) => socket.once("close", () => { isClosed = true; resolve(); }));
    socket.on("error", () => {});
    const send = (message) => socket.write(`${JSON.stringify(message)}\n`);
    send(first);
    // A refusal closes the connection without any frame after the challenge.
    const refusal = async () => {
      await waitUntil(() => isClosed, "a refused reattach attempt kept its connection");
      return frames.filter((frame) => frame.type !== "challenge");
    };
    return { socket, frames, ended, send, refusal, output: () => frames.filter((frame) => frame.type === "data").map((frame) => frame.data).join("") };
  };
  // The managed client's handshake: the broker proves the token it holds over
  // this nonce, then the client proves its own token for label and identity.
  const reattach = async ({ label, identity, token, nextToken }) => {
    const nonce = reattachNonce();
    const attempt = await client({ type: "reattach", nonce });
    await waitUntil(() => attempt.frames.length, "a detached broker sent no challenge");
    const [challenge] = attempt.frames;
    assert.equal(challenge.type, "challenge");
    attempt.brokerProven = proofMatches(reattachProof(token, "broker", [nonce, challenge.nonce, label, identity]), challenge.proof);
    attempt.send({ type: "prove", nextToken, proof: reattachProof(token, "client", [challenge.nonce, nonce, label, identity, nextToken]) });
    return attempt;
  };
  const start = await client({ type: "start", token: broker.spawnargs.at(-1), shell: process.execPath, cwd: directory,
    env: process.env, cols: 120, rows: 30, ...(session ? { session } : {}) });
  await waitUntil(() => start.frames.some((frame) => frame.type === "ready"), "PTY did not become ready");
  return { directory, broker, closed, start, client, reattach, connectOnly: connect, stderr: () => stderr, stdout: () => stdout };
}

async function waitUntil(predicate, message, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("a reattachable broker keeps the shell through a peer close and accepts each token once", { timeout: 40_000 }, async (t) => {
  const label = `com.21n.outright.terminal.${randomUUID()}`;
  const first = randomUUID() + randomUUID();
  const { broker, start, client, reattach, connectOnly } = await startSessionBroker(t, { session: { label, token: first, windowMs: 30_000 } });
  const identity = start.frames.find((frame) => frame.type === "ready").identity;
  assert.match(identity, /^[0-9a-f-]{36}$/);
  start.send({ type: "write", data: "globalThis.kept = 41\r" });
  await waitUntil(() => start.output().includes("41"), "the shell did not evaluate input");
  // Output produced after the peer is gone must be kept for the reattach.
  start.send({ type: "write", data: "setTimeout(() => console.log('while-' + 'detached'), 400)\r" });
  start.socket.destroy();
  await start.ended;
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal(broker.exitCode, null, "closing the peer ended a reattachable shell");

  // An attempt that never completes its handshake loses the peer slot.
  const idle = await connectOnly();
  let idleClosed = false;
  idle.once("close", () => { idleClosed = true; });
  idle.on("error", () => {});
  await waitUntil(() => idleClosed, "an idle connection held the detached session", 8000);

  // Neither a client proof without a challenge nor the token itself opens it.
  const second = randomUUID() + randomUUID();
  for (const unchallenged of [{ type: "prove", nextToken: second, proof: reattachProof(first, "client", [label, identity, second]) },
    { type: "reattach", label, identity, token: first, nextToken: second }]) {
    const refused = await client(unchallenged);
    assert.deepEqual(await refused.refusal(), []);
  }
  // Every refusal looks the same: the same challenge, then a close with no
  // frame. Only the holder of the broker's token can check its proof.
  for (const wrong of [
    { label, identity, token: randomUUID() + randomUUID() },
    { label: `com.21n.outright.terminal.${randomUUID()}`, identity, token: first },
    { label, identity: randomUUID(), token: first },
  ]) {
    const refused = await reattach({ ...wrong, nextToken: second });
    assert.deepEqual(await refused.refusal(), []);
    assert.equal(refused.brokerProven, false, "a broker proof verified for the wrong session");
  }

  const resumed = await reattach({ label, identity, token: first, nextToken: second });
  assert.equal(resumed.brokerProven, true, "the broker did not prove the token it holds");
  await waitUntil(() => resumed.output().includes("while-detached"), "buffered output was not replayed");
  assert.deepEqual(resumed.frames[1], { type: "reattached", identity, pid: resumed.frames[1].pid });
  resumed.send({ type: "write", data: "kept + 1\r" });
  await waitUntil(() => resumed.output().includes("42"), "the reattached shell is not the live process");
  resumed.socket.destroy();
  await resumed.ended;

  const reused = await reattach({ label, identity, token: first, nextToken: randomUUID() + randomUUID() });
  assert.deepEqual(await reused.refusal(), [], "a spent token reattached");
  assert.equal(reused.brokerProven, false, "the broker still proved a spent token");
  const rotated = await reattach({ label, identity, token: second, nextToken: randomUUID() + randomUUID() });
  assert.equal(rotated.brokerProven, true);
  await waitUntil(() => rotated.frames.some((frame) => frame.type === "reattached"), "the rotated token was refused");
  const closed = new Promise((resolve) => broker.once("close", resolve));
  rotated.send({ type: "terminate" });
  await waitUntil(() => rotated.frames.some((frame) => frame.type === "shell-exited"), "terminate did not end the shell");
  await closed;
});

// A detaching native supervisor pauses its own window only while a runtime is
// reattached, so the broker reports each detach and each reattach, and only
// those, on its stdout.
test("a reattachable broker reports each detach and reattach to its supervisor", { timeout: 40_000 }, async (t) => {
  const label = `com.21n.outright.terminal.${randomUUID()}`;
  const token = randomUUID() + randomUUID();
  const { start, reattach, stdout } = await startSessionBroker(t, { session: { label, token, windowMs: 30_000 }, captureStdout: true });
  const identity = start.frames.find((frame) => frame.type === "ready").identity;
  const statuses = () => stdout().split("\n").filter(Boolean);
  start.send({ type: "write", data: "console.log('__OUTRIGHT_BROKER_' + 'ATTACHED_V1__')\r" });
  await waitUntil(() => start.output().includes("__OUTRIGHT_BROKER_ATTACHED_V1__"), "the shell did not run");
  assert.deepEqual(statuses(), [], "the first owner's attach or the shell's own output reached the supervisor");
  start.socket.destroy();
  await waitUntil(() => statuses().length === 1, "a detach was not reported");
  const second = randomUUID() + randomUUID();
  const resumed = await reattach({ label, identity, token, nextToken: second });
  await waitUntil(() => resumed.frames.some((frame) => frame.type === "reattached"), "the reattach was refused");
  await waitUntil(() => statuses().length === 2, "a reattach was not reported");
  resumed.send({ type: "release" });
  await waitUntil(() => statuses().length === 3, "a hand-back was not reported");
  assert.deepEqual(statuses(), ["__OUTRIGHT_BROKER_DETACHED_V1__", "__OUTRIGHT_BROKER_ATTACHED_V1__", "__OUTRIGHT_BROKER_DETACHED_V1__"]);
  const last = await reattach({ label, identity, token: second, nextToken: randomUUID() + randomUUID() });
  await waitUntil(() => last.frames.some((frame) => frame.type === "reattached"), "the rotated token was refused");
  last.send({ type: "terminate" });
  await waitUntil(() => last.frames.some((frame) => frame.type === "shell-exited"), "terminate did not end the shell");
});

test("input queued behind output backpressure reaches the shell when its peer detaches", { timeout: 40_000 }, async (t) => {
  const label = `com.21n.outright.terminal.${randomUUID()}`;
  const token = randomUUID() + randomUUID();
  const { directory, start, reattach, stderr } = await startSessionBroker(t, { session: { label, token, windowMs: 30_000 }, diagnostics: true });
  const identity = start.frames.find((frame) => frame.type === "ready").identity;
  // A reader that stops pulling a sustained stream backs the broker up, so
  // input it accepts now waits for the output to drain.
  start.socket.pause();
  start.send({ type: "write", data: 'globalThis.flood = setInterval(() => process.stdout.write("f".repeat(65536)), 2)\r' });
  await waitUntil(() => start.socket.readableLength >= start.socket.readableHighWaterMark, "a paused reader did not fill its read window");
  await new Promise((resolve) => setTimeout(resolve, 500));
  start.send({ type: "write", data: 'clearInterval(flood); require("fs").writeFileSync("queued-ran", "ran")\r' });
  await new Promise((resolve) => setTimeout(resolve, 200));
  start.socket.destroy();
  await start.ended;
  const detached = () => stderr().split("\n").map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .find((event) => event?.broker === "peer-detached");
  await waitUntil(detached, "the peer close did not detach the shell");
  assert.ok(detached().pendingInputBytes > 0, `the input was not queued behind backpressure: ${stderr()}`);
  await waitUntil(() => existsSync(path.join(directory, "queued-ran")), "queued input was lost when the peer detached");
  const resumed = await reattach({ label, identity, token, nextToken: randomUUID() + randomUUID() });
  await waitUntil(() => resumed.frames.some((frame) => frame.type === "reattached"), "the shell that ran the input was not kept");
  resumed.send({ type: "terminate" });
  await waitUntil(() => resumed.frames.some((frame) => frame.type === "shell-exited"), "terminate did not end the shell");
});

test("a detached shell ends when its window expires and the broker exits with its status", { timeout: 30_000 }, async (t) => {
  const label = `com.21n.outright.terminal.${randomUUID()}`;
  const token = randomUUID() + randomUUID();
  const { start, closed, reattach, stderr } = await startSessionBroker(t, { session: { label, token, windowMs: 300 }, diagnostics: true });
  const identity = start.frames.find((frame) => frame.type === "ready").identity;
  start.socket.destroy();
  let timeout;
  const result = await Promise.race([closed, new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`detached broker outlived its window: ${stderr()}`)), 12_000);
  })]).finally(() => clearTimeout(timeout));
  // On Windows, node-pty's kill forks a console-list helper that shares the
  // broker's stderr and can report its own failure there; only the broker's
  // diagnostic lines are its lifecycle.
  const lines = stderr().trim().split("\n").filter(Boolean);
  const diagnostics = lines.map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter((event) => event?.broker);
  assert.deepEqual(diagnostics.map((event) => event.broker).filter((event) => ["peer-detached", "detach-expired", "shell-exit"].includes(event)),
    ["peer-detached", "detach-expired", "shell-exit"], `broker stderr: ${lines.join("\n").slice(-4000)}`);
  assert.notEqual(result.code, 0, "an expired shell was reported as a clean exit");
  await assert.rejects(reattach({ label, identity, token, nextToken: randomUUID() + randomUUID() }),
    "an expired session still accepted a connection");
});

test("without a reattach session a peer close still ends the shell", { timeout: 20_000 }, async (t) => {
  const { start, closed, stderr } = await startSessionBroker(t, { diagnostics: true });
  assert.equal(start.frames.find((frame) => frame.type === "ready").identity, undefined);
  start.socket.destroy();
  let timeout;
  await Promise.race([closed, new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error("a broker without a session kept its shell after the peer closed")), 10_000);
  })]).finally(() => clearTimeout(timeout));
  assert.ok(!stderr().includes("peer-detached"));
});

test("an unterminated peer frame over the read limit still ends the peer and its shell", { timeout: 20_000 }, async (t) => {
  // The limit bounds each frame and the remainder after complete frames, so
  // a read of many frames passes while one endless frame is still refused.
  const { start, closed } = await startSessionBroker(t);
  start.socket.write(`{"type":"write","data":"${"x".repeat(600 * 1024)}`);
  let timeout;
  await Promise.race([closed, new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error("the broker kept a peer sending an endless frame")), 10_000);
  })]).finally(() => clearTimeout(timeout));
});
