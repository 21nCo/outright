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
let shellResult;
let listenerClosed = false;
let nativeExitTimer;
const finishAfterNativeExit = () => {
  if (listenerClosed && (!terminal || shellExited)) process.exit(shellResult?.processCode ?? 0);
};
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
  let stalledReaderTimer;
  const pauseOutput = () => {
    if (!outputPaused) {
      outputPaused = true;
      // A peer that never drains cannot own an unbounded ConPTY stream.
      // Give a temporarily slow reader time to resume, then tear down this
      // broker's shell and let the supervisor verify the owned boundary.
      stalledReaderTimer = setTimeout(() => {
        if (!outputPaused || socket.destroyed) return;
        try { terminal?.kill(); } catch { /* The shell may already be gone. */ }
        socket.destroy();
      }, 8000);
      stalledReaderTimer.unref();
      if (!shellExited) {
        // Windows ConPTY can hold shell progress (and even its exit notice)
        // while paused. Drain and shed there immediately; the owner socket is
        // still bounded by its writable high-water mark. Unix PTYs can pause
        // briefly, then also shed if the peer stays silent.
        if (process.platform !== "win32") {
          terminal.pause();
          shedTimer = setTimeout(() => { if (outputPaused && !shellExited) terminal.resume(); }, 2000);
          shedTimer.unref();
        }
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
      const notice = `\u001b[0m\r\n[Outright: ${count} terminal output characters omitted]\r\n`;
      if (!socket.write(`${JSON.stringify({ type: "data", data: notice })}\n`)) {
        pauseOutput();
        return;
      }
    }
    if (shellExited && !exitSent) {
      exitSent = true;
      socket.end(`${JSON.stringify({ type: "shell-exited", exitCode: shellResult.exitCode, signal: shellResult.signal })}\n`);
      if (server.listening) server.close();
    } else if (outputPaused && !shellExited) {
      outputPaused = false;
      clearTimeout(shedTimer);
      clearTimeout(stalledReaderTimer);
      if (process.platform !== "win32") terminal.resume();
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
        terminal.onExit(({ exitCode, signal }) => {
          // The broker is the supervisor's child. Its process status and the
          // final frame must agree with the PTY rather than reporting a clean
          // broker shutdown as a successful shell outcome.
          const validCode = Number.isSafeInteger(exitCode) && exitCode >= 0;
          // ConPTY reports an ordinary exit with signal:null; Unix node-pty
          // uses zero. The wire format has one portable no-signal value.
          const normalizedSignal = signal == null ? 0 : signal;
          const validSignal = Number.isSafeInteger(normalizedSignal) && normalizedSignal >= 0;
          let processCode = validCode ? exitCode : 1;
          if (validSignal && normalizedSignal > 0) processCode = 128 + normalizedSignal;
          shellResult = { exitCode: validCode || (validSignal && normalizedSignal > 0) ? processCode : null,
            signal: validSignal ? normalizedSignal : null, processCode };
          shellExited = true;
          clearTimeout(nativeExitTimer);
          clearTimeout(shedTimer);
          // socket.end can itself wait forever for a silent peer. The owner
          // has exited, so bound delivery of its final frames and release the
          // broker even if the client never drains.
          exitTimer = setTimeout(() => socket.destroy(), 5000);
          exitTimer.unref();
          // Exit may race a backpressured write. Queue the final frame now;
          // a later drain continues it in order if the socket still cannot
          // accept the frame. Waiting only for drain can strand a quiet peer.
          flushOutput();
          finishAfterNativeExit();
        });
      } else if (!shellExited && message.type === "write" && typeof message.data === "string"
        && Buffer.byteLength(message.data) <= 64 * 1024) terminal.write(message.data);
      else if (!shellExited && message.type === "resize" && Number.isInteger(message.cols) && message.cols >= 20 && message.cols <= 400
        && Number.isInteger(message.rows) && message.rows >= 5 && message.rows <= 200)
        terminal.resize(message.cols, message.rows);
      else socket.destroy();
    }
  });
  socket.on("close", () => {
    clearTimeout(shedTimer);
    clearTimeout(exitTimer);
    clearTimeout(stalledReaderTimer);
    if (!shellExited && terminal) {
      try { terminal.kill(); } catch { /* Supervisor owns final cleanup. */ }
      // Retain the broker as the PTY reaper until onExit. A close of the
      // listener alone does not prove that the native child has exited.
      nativeExitTimer = setTimeout(() => process.exit(1), 5000);
    }
    // node-pty can retain a Windows ConPTY handle after onExit and socket
    // close. The listener's close event releases its address before exit.
    if (server.listening) server.close();
  });
});
server.listen(address, () => {
  if (process.platform !== "win32") chmodSync(address, 0o600);
  process.umask(inheritedUmask);
});
server.on("close", () => {
  if (process.platform !== "win32") try { unlinkSync(address); } catch {}
  // This broker accepts exactly one peer. Exit only after the native PTY has
  // reported exit, or after the bounded failure timer asks its supervisor to
  // clean up the owned process boundary.
  listenerClosed = true;
  finishAfterNativeExit();
});
