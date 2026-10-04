import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
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
  let dataBytes = 0;
  const received = [];
  const waiters = new Set();
  const notify = () => { for (const waiter of waiters) waiter(); };
  broker.on("close", () => { closed = true; notify(); });
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
          if (frame.data.includes("OUTRIGHT_BURST_DONE") || frame.data.includes("OUTRIGHT_LATER")) received.push(frame.data);
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
    await until(() => received.some((item) => item.includes("OUTRIGHT_BURST_DONE")), "burst did not finish");
    assert.ok(dataBytes > 1024 * 1024, "the fixture did not sustain enough PTY output to backpressure the socket");

    socket.write(`${JSON.stringify({ type: "write", data: 'console.log("OUTRIGHT_"+"LATER")\r' })}\n`);
    await until(() => received.some((item) => item.includes("OUTRIGHT_LATER")), "shell did not accept later input");
    socket.write(`${JSON.stringify({ type: "write", data: ".exit\r" })}\n`);
    await until(() => received.includes("shell-exited"), "shell exit was not delivered");
    await until(() => closed, "broker did not close after its shell exited", 5000);
  } finally {
    socket?.destroy();
    if (broker.exitCode === null) {
      try { process.kill(process.platform === "win32" ? broker.pid : -broker.pid, "SIGKILL"); } catch {}
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
