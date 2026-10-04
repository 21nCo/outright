import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const brokerScript = fileURLToPath(new URL("./terminal-broker.mjs", import.meta.url));

test("a slow broker reader backpressures sustained PTY output without losing its shell", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pty-broker-"));
  const address = process.platform === "win32"
    ? `\\\\.\\pipe\\outright-broker-test-${randomUUID()}` : path.join(directory, "broker.sock");
  const token = randomUUID() + randomUUID();
  const broker = spawn(process.execPath, [brokerScript, address, token], {
    stdio: ["ignore", "ignore", "pipe"], detached: process.platform !== "win32", windowsHide: true,
  });
  let stderr = "";
  broker.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-2048); });
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
      assert.ok(condition(), `${label}; broker closed=${closed}, output=${dataBytes}, stderr=${stderr}`);
    };
    socket.write(`${JSON.stringify({ type: "start", token, shell: process.execPath,
      cwd: directory, env: process.env, cols: 80, rows: 24 })}\n`);
    await until(() => received.includes("ready"), "PTY did not become ready");

    socket.pause();
    socket.write(`${JSON.stringify({ type: "write",
      data: 'process.stdout.write("x".repeat(8*1024*1024)); console.log("OUTRIGHT_"+"BURST_DONE")\r' })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(closed, false, `slow reader disconnected its broker: ${stderr}`);
    socket.resume();
    await until(() => received.includes("OUTRIGHT_BURST_DONE"), "burst did not finish");
    assert.ok(dataBytes > 1024 * 1024, "the fixture did not sustain enough PTY output to backpressure the socket");

    socket.pause();
    socket.write(`${JSON.stringify({ type: "write",
      data: 'process.stdout.write("\\u001b[31m"+"c".repeat(8*1024*1024))\r' })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 4000));
    socket.resume();
    await until(() => omissionReset, "shed colored output did not reset styling before its notice");

    socket.write(`${JSON.stringify({ type: "write", data: 'console.log("OUTRIGHT_"+"LATER")\r' })}\n`);
    await until(() => received.includes("OUTRIGHT_LATER"), "shell did not accept later input");
    socket.write(`${JSON.stringify({ type: "write", data: ".exit\r" })}\n`);
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

test("disconnecting a live owner releases the broker and its PTY child", { timeout: 12_000 }, async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pty-broker-disconnect-"));
  const address = process.platform === "win32"
    ? `\\\\.\\pipe\\outright-broker-test-${randomUUID()}` : path.join(directory, "broker.sock");
  const token = randomUUID() + randomUUID();
  const broker = spawn(process.execPath, [brokerScript, address, token], {
    stdio: ["ignore", "ignore", "pipe"], detached: process.platform !== "win32", windowsHide: true,
  });
  let socket;
  let shellPid;
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
          const match = frame.data.match(/OUTRIGHT_CHILD_PID=(\d+)/);
          if (match) shellPid = Number(match[1]);
        }
      }
    });
    socket.write(`${JSON.stringify({ type: "start", token, shell: process.execPath,
      cwd: directory, env: process.env, cols: 80, rows: 24 })}\n`);
    while (!ready && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(ready, true);
    socket.write(`${JSON.stringify({ type: "write", data: 'console.log("OUTRIGHT_CHILD_PID="+process.pid)\r' })}\n`);
    while (!shellPid && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(shellPid, "PTY child did not identify itself");
    socket.destroy();
    const released = () => {
      if (broker.exitCode === null) return false;
      try { process.kill(shellPid, 0); return false; } catch (error) { return error.code === "ESRCH"; }
    };
    const releaseDeadline = Date.now() + 5000;
    while (!released() && Date.now() < releaseDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(released(), "disconnected broker or PTY child remained alive");
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
