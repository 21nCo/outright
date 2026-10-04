// Runs inside the platform supervisor's owned process boundary. The runtime
// communicates over a private local socket because launchd does not attach a
// submitted job to its submitter's stdin.
import * as pty from "node-pty";
import net from "node:net";
import { chmodSync, unlinkSync } from "node:fs";

const [address, token] = process.argv.slice(2);
if (!address || !token || token.length < 32) process.exit(64);
const inheritedUmask = process.umask(0o077);
let terminal;
let peer;
let pending = "";
let authenticated = false;
let shellExited = false;
const server = net.createServer((socket) => {
  if (peer) { socket.destroy(); return; }
  peer = socket;
  socket.setEncoding("utf8");
  // Keep the PTY behind the socket's writable high-water mark. Pausing the
  // PTY also backpressures a shell that produces output faster than its owner
  // can read it, without treating a slow reader as loss of ownership.
  let pendingOutput = "";
  let outputOffset = 0;
  let omittedChars = 0;
  let outputPaused = false;
  let exitSent = false;
  let shedTimer;
  let exitTimer;
  const pauseOutput = () => {
    if (!outputPaused) {
      outputPaused = true;
      if (!shellExited) {
        terminal.pause();
        // A peer that never reads must not hold the shell at a blocked PTY
        // write forever. After a grace period, consume and count later output
        // without adding more socket frames.
        shedTimer = setTimeout(() => { if (outputPaused && !shellExited) terminal.resume(); }, 2000);
        shedTimer.unref();
      }
    }
  };
  const flushOutput = () => {
    if (socket.destroyed) return;
    while (outputOffset < pendingOutput.length) {
      let end = Math.min(pendingOutput.length, outputOffset + 8 * 1024);
      if (end < pendingOutput.length && /[\uD800-\uDBFF]/.test(pendingOutput[end - 1])
        && /[\uDC00-\uDFFF]/.test(pendingOutput[end])) end -= 1;
      const frame = `${JSON.stringify({ type: "data", data: pendingOutput.slice(outputOffset, end) })}\n`;
      outputOffset = end;
      if (!socket.write(frame)) { pauseOutput(); return; }
    }
    pendingOutput = "";
    outputOffset = 0;
    if (omittedChars) {
      const count = omittedChars;
      omittedChars = 0;
      if (!socket.write(`${JSON.stringify({ type: "data",
        data: `\u001b[0m\r\n[Outright: ${count} terminal output characters omitted]\r\n` })}\n`)) {
        pauseOutput();
        return;
      }
    }
    if (shellExited && !exitSent) {
      exitSent = true;
      socket.end(`${JSON.stringify({ type: "shell-exited" })}\n`);
      if (server.listening) server.close();
    } else if (outputPaused && !shellExited) {
      outputPaused = false;
      clearTimeout(shedTimer);
      terminal.resume();
    }
  };
  socket.on("drain", flushOutput);
  socket.on("error", () => { socket.destroy(); });
  socket.on("data", (chunk) => {
    pending += chunk;
    // A permitted 64 KiB write may JSON-escape every control byte as six
    // characters. Include the launch environment and framing as well.
    if (pending.length > 512 * 1024) { socket.destroy(); return; }
    let end;
    while ((end = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      let message;
      try { message = JSON.parse(line); } catch { socket.destroy(); return; }
      if (!message || typeof message !== "object" || Array.isArray(message)) { socket.destroy(); return; }
      if (!authenticated) {
        if (message.type !== "start" || message.token !== token || typeof message.shell !== "string"
          || typeof message.cwd !== "string" || !message.env || typeof message.env !== "object"
          || !Number.isInteger(message.cols) || message.cols < 20 || message.cols > 400
          || !Number.isInteger(message.rows) || message.rows < 5 || message.rows > 200) {
          socket.destroy(); return;
        }
        authenticated = true;
        try {
          terminal = pty.spawn(message.shell, [], { name: "xterm-256color", cols: message.cols,
            rows: message.rows, cwd: message.cwd, env: message.env });
        } catch (error) {
          socket.write(`${JSON.stringify({ type: "error", message: String(error.message ?? error).slice(0, 512) })}\n`);
          socket.end();
          server.close();
          return;
        }
        socket.write(`${JSON.stringify({ type: "ready" })}\n`);
        terminal.onData((data) => {
          if (socket.destroyed) return;
          // node-pty normally supplies small reads. A larger callback or an
          // already queued callback may shed output, but never grow a queue.
          if (outputPaused || pendingOutput) {
            omittedChars = Math.min(Number.MAX_SAFE_INTEGER, omittedChars + data.length);
            return;
          }
          let end = Math.min(data.length, 64 * 1024);
          if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1])
            && /[\uDC00-\uDFFF]/.test(data[end])) end -= 1;
          pendingOutput = data.slice(0, end);
          omittedChars = Math.min(Number.MAX_SAFE_INTEGER, omittedChars + data.length - end);
          flushOutput();
        });
        terminal.onExit(() => {
          shellExited = true;
          clearTimeout(shedTimer);
          // socket.end can itself wait forever for a silent peer. The owner
          // has exited, so bound delivery of its final frames and release the
          // broker even if the client never drains.
          exitTimer = setTimeout(() => socket.destroy(), 5000);
          exitTimer.unref();
          if (!outputPaused) flushOutput();
        });
      } else if (!shellExited && message.type === "write" && typeof message.data === "string"
        && Buffer.byteLength(message.data) <= 64 * 1024) terminal.write(message.data);
      else if (!shellExited && message.type === "resize" && Number.isInteger(message.cols) && message.cols >= 20 && message.cols <= 400
        && Number.isInteger(message.rows) && message.rows >= 5 && message.rows <= 200)
        terminal.resize(message.cols, message.rows);
      else socket.destroy();
    }
  });
  socket.on("close", () => { clearTimeout(shedTimer); clearTimeout(exitTimer); if (server.listening) server.close(); });
});
server.listen(address, () => {
  if (process.platform !== "win32") chmodSync(address, 0o600);
  process.umask(inheritedUmask);
});
server.on("close", () => { if (process.platform !== "win32") try { unlinkSync(address); } catch {} });
