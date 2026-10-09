import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { AGENT_SUPERVISOR } from "./agent-manager.mjs";

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

test("a slow broker reader backpressures sustained PTY output without losing its shell", async () => {
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
          if (frame.data.includes("[Outright:") && frame.data.startsWith("\u001b[0m\r\n")) omissionReset = true;
          recentData = `${recentData}${frame.data}`.slice(-128);
          if (recentData.includes("OUTRIGHT_BURST_DONE")) received.push("OUTRIGHT_BURST_DONE");
          if (recentData.includes("OUTRIGHT_LATER")) received.push("OUTRIGHT_LATER");
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
      assert.ok(condition(), `${label}; broker closed=${closed}, output=${dataBytes}, ${shellState()}, stderr=${stderr}`);
    };
    socket.write(`${JSON.stringify({ type: "start", token, shell: process.execPath,
      cwd: directory, env: process.env, cols: 80, rows: 24 })}\n`);
    await until(() => received.includes("ready"), "PTY did not become ready");

    socket.pause();
    socket.write(`${JSON.stringify({ type: "write",
      data: 'process.stdout.write("x".repeat(8*1024*1024)); console.log("OUTRIGHT_"+"BURST_DONE")\r' })}\n`);
    await until(() => socket.readableLength > 0, "paused broker reader did not buffer output");
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(closed, false, `slow reader disconnected its broker: ${stderr}`);
    socket.resume();
    await until(() => received.includes("OUTRIGHT_BURST_DONE"), "burst did not finish");
    assert.ok(dataBytes > 1024 * 1024, "the fixture did not sustain enough PTY output to backpressure the socket");

    socket.pause();
    socket.write(`${JSON.stringify({ type: "write",
      data: 'process.stdout.write("\\u001b[31m"+"c".repeat(8*1024*1024))\r' })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 4000));
    // This input arrives while the client is still silent. It must wait for
    // the same drain boundary as the output, then reach the live shell once.
    socket.write(`${JSON.stringify({ type: "write", data: 'console.log("OUTRIGHT_"+"LATER")\r' })}\n`);
    socket.resume();
    await until(() => omissionReset, "shed colored output did not reset styling before its notice");
    await until(() => received.includes("OUTRIGHT_LATER"), "shell did not accept later input");
    socket.write(`${JSON.stringify({ type: "write", data: "process.exit(0)\r" })}\n`);
    await until(() => received.includes("shell-exited"), "shell exit was not delivered");
    const exitDeadline = Date.now() + 5000;
    while (!brokerExited && Date.now() < exitDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(brokerExited, true, "broker process did not exit after its shell exited");
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
