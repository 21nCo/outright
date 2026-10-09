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
// Opt-in lifecycle evidence for platform CI. Events carry counts and states,
// never terminal output, input text or environment values, and are bounded.
const diagnosticsEnabled = process.env.OUTRIGHT_BROKER_DIAGNOSTICS === "1";
const diagnosticCounts = { pauses: 0, resumes: 0, shedChars: 0, queuedInputs: 0 };
let diagnosticEvents = 0;
const diagnostic = (event, details = {}) => {
  if (!diagnosticsEnabled || diagnosticEvents >= 64) return;
  diagnosticEvents += 1;
  try { process.stderr.write(`${JSON.stringify({ broker: event, ...details, ...diagnosticCounts })}\n`); }
  catch { /* Diagnostics never affect terminal ownership. */ }
};
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
  let pendingInput = "";
  let outputOffset = 0;
  let omittedChars = 0;
  let outputPaused = false;
  let exitSent = false;
  let shedTimer;
  let exitTimer;
  let stalledReaderTimer;
  const flushInput = () => {
    if (outputPaused || pendingOutput || !pendingInput || shellExited || !terminal) return;
    const input = pendingInput;
    pendingInput = "";
    terminal.write(input);
    diagnostic("input-written", { bytes: Buffer.byteLength(input) });
  };
  const pauseOutput = () => {
    if (!outputPaused) {
      outputPaused = true;
      diagnosticCounts.pauses += 1;
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
  const flushOutputTail = () => {
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
      diagnostic("exit-frame-sent");
      socket.end(`${JSON.stringify({ type: "shell-exited", exitCode: shellResult.exitCode, signal: shellResult.signal })}\n`);
      if (server.listening) server.close();
    } else if (outputPaused && !shellExited) {
      outputPaused = false;
      diagnosticCounts.resumes += 1;
      clearTimeout(shedTimer);
      clearTimeout(stalledReaderTimer);
      if (process.platform !== "win32") terminal.resume();
      flushInput();
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
    flushOutputTail();
  };
  const onTerminalData = (data) => {
    if (socket.destroyed) return;
    // Already queued output has priority; shed any excess at this boundary.
    if (outputPaused || pendingOutput) {
      omittedChars = Math.min(Number.MAX_SAFE_INTEGER, omittedChars + data.length);
      diagnosticCounts.shedChars = Math.min(Number.MAX_SAFE_INTEGER, diagnosticCounts.shedChars + data.length);
      return;
    }
    let end = Math.min(data.length, 64 * 1024);
    if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1])
      && /[\uDC00-\uDFFF]/.test(data[end])) end -= 1;
    pendingOutput = data.slice(0, end);
    omittedChars = Math.min(Number.MAX_SAFE_INTEGER, omittedChars + data.length - end);
    flushOutput();
  };
  const onTerminalExit = ({ exitCode, signal }) => {
    const validCode = Number.isSafeInteger(exitCode) && exitCode >= 0;
    const normalizedSignal = signal == null ? 0 : signal;
    const validSignal = Number.isSafeInteger(normalizedSignal) && normalizedSignal >= 0;
    let processCode = validCode ? exitCode : 1;
    if (validSignal && normalizedSignal > 0) processCode = 128 + normalizedSignal;
    shellResult = { exitCode: validCode || (validSignal && normalizedSignal > 0) ? processCode : null,
      signal: validSignal ? normalizedSignal : null, processCode };
    shellExited = true;
    diagnostic("shell-exit", { exitCode: shellResult.exitCode, signal: shellResult.signal, outputPaused,
      pendingOutputChars: pendingOutput.length - outputOffset, pendingInputBytes: Buffer.byteLength(pendingInput) });
    clearTimeout(nativeExitTimer);
    clearTimeout(shedTimer);
    // A silent peer cannot retain the final frame or broker indefinitely.
    exitTimer = setTimeout(() => socket.destroy(), 5000);
    exitTimer.unref();
    flushOutput();
    finishAfterNativeExit();
  };
  const startTerminal = (message) => {
    if (message.type !== "start" || message.token !== token || typeof message.shell !== "string"
      || typeof message.cwd !== "string" || !message.env || typeof message.env !== "object"
      || !Number.isInteger(message.cols) || message.cols < 20 || message.cols > 400
      || !Number.isInteger(message.rows) || message.rows < 5 || message.rows > 200) {
      socket.destroy(); return;
    }
    authenticated = true;
    try { terminal = pty.spawn(message.shell, [], { name: "xterm-256color", cols: message.cols,
      rows: message.rows, cwd: message.cwd, env: message.env }); }
    catch (error) {
      socket.write(`${JSON.stringify({ type: "error", message: String(error.message ?? error).slice(0, 512) })}\n`);
      socket.end();
      server.close();
      return;
    }
    socket.write(`${JSON.stringify({ type: "ready" })}\n`);
    diagnostic("shell-spawned", { shellPid: terminal.pid });
    terminal.onData(onTerminalData);
    terminal.onExit(onTerminalExit);
  };
  const handleMessage = (message) => {
    if (!authenticated) { startTerminal(message); return; }
    if (!shellExited && message.type === "write" && typeof message.data === "string"
      && Buffer.byteLength(message.data) <= 64 * 1024) {
      // ConPTY can still be draining a large synchronous write after the
      // client resumes. Preserve input order at the same backpressure
      // boundary instead of racing later commands with that drain.
      if (Buffer.byteLength(pendingInput) + Buffer.byteLength(message.data) > 256 * 1024) {
        socket.destroy(); return;
      }
      pendingInput += message.data;
      if (outputPaused || pendingOutput) diagnosticCounts.queuedInputs += 1;
      flushInput();
      return;
    }
    if (!shellExited && message.type === "resize" && Number.isInteger(message.cols) && message.cols >= 20 && message.cols <= 400
      && Number.isInteger(message.rows) && message.rows >= 5 && message.rows <= 200) {
      terminal.resize(message.cols, message.rows);
      return;
    }
    socket.destroy();
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
      handleMessage(message);
      if (socket.destroyed || socket.writableEnded || !terminal) return;
    }
  });
  socket.on("close", () => {
    diagnostic("peer-closed", { shellExited, exitSent });
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
