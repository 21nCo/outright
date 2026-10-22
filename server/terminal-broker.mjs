// Runs inside the platform supervisor's owned process boundary. The runtime
// communicates over a private local socket because launchd does not attach a
// submitted job to its submitter's stdin.
import * as pty from "node-pty";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { chmodSync, unlinkSync, writeSync } from "node:fs";
import { createDetachedOutput } from "./terminal-detached-output.mjs";
import { proofMatches, reattachNonce, reattachProof, validNonce } from "./terminal-reattach-proof.mjs";

const [address, token] = process.argv.slice(2);
if (!address || !token || token.length < 32) process.exit(64);
const inheritedUmask = process.umask(0o077);
const SESSION_LABEL = /^com\.21n\.outright\.terminal\.[0-9a-f-]{36}$/;
// This broker process's identity. A reattach must name it as well as the
// owner label and the current token; a reused PID cannot present it.
const instance = randomUUID();
let terminal;
let peer;
let shellExited = false;
let shellResult;
let listenerClosed = false;
let nativeExitTimer;
let session = null;
// The authenticated peer's output handlers, or the detached output ring.
let attached = null;
// A reattachable session survives its peer for a bounded window, keeping its
// output in a bounded ring meanwhile.
let detached = null;
// Opt-in lifecycle evidence for platform CI. Events carry counts and states,
// never terminal output, input text or environment values, and are bounded.
// Interaction is only counted, so it cannot spend the lifecycle event budget.
const diagnosticsEnabled = process.env.OUTRIGHT_BROKER_DIAGNOSTICS === "1";
const diagnosticCounts = { pauses: 0, resumes: 0, shedChars: 0, queuedInputs: 0, inputWrites: 0, inputBytes: 0 };
let diagnosticEvents = 0;
const diagnostic = (event, details = {}) => {
  if (!diagnosticsEnabled || diagnosticEvents >= 64) return;
  diagnosticEvents += 1;
  // A bounded synchronous line survives the process.exit that follows the
  // final lifecycle events; an asynchronous pipe write may not.
  try { writeSync(2, `${JSON.stringify({ broker: event, ...details, ...diagnosticCounts })}\n`); }
  catch { /* Diagnostics never affect terminal ownership. */ }
};
// Node emits the listener's close before the socket's own close event after
// the final frame. Either path records the closed peer, exactly once.
let recordPeerClosed = () => {};
const finishAfterNativeExit = () => {
  if (listenerClosed && (!terminal || shellExited)) process.exit(shellResult?.processCode ?? 0);
};
const validToken = (value) => typeof value === "string" && value.length >= 32 && value.length <= 256;
const validSize = (cols, rows) => Number.isInteger(cols) && cols >= 20 && cols <= 400
  && Number.isInteger(rows) && rows >= 5 && rows <= 200;
const validSession = (value) => value && typeof value === "object" && SESSION_LABEL.test(value.label)
  && validToken(value.token) && Number.isInteger(value.windowMs) && value.windowMs >= 50 && value.windowMs <= 10 * 60 * 1000;

// The window ends the shell. Its exit is the broker's own process status,
// which the native supervisor reports to its owner.
function expireDetached() {
  if (!detached || shellExited) return;
  diagnostic("detach-expired");
  session = null;
  peer?.destroy();
  try { terminal.kill(); } catch { /* The shell may already be gone. */ }
  nativeExitTimer = setTimeout(() => process.exit(1), 5000);
  if (server.listening) server.close();
}

function detach(unsent, omitted, details = {}) {
  attached = null;
  peer = undefined;
  detached = { output: createDetachedOutput(), timer: setTimeout(expireDetached, session.windowMs) };
  detached.output.drop(omitted);
  detached.output.push(unsent);
  // A peer's backpressure must not hold the shell while nobody reads it.
  if (process.platform !== "win32") try { terminal.resume(); } catch { /* The shell may already be gone. */ }
  diagnostic("peer-detached", { windowMs: session.windowMs, ...details });
}

function onTerminalData(data) {
  if (attached) attached.data(data);
  else if (detached) detached.output.push(data);
}

function onTerminalExit({ exitCode, signal }) {
  const validCode = Number.isSafeInteger(exitCode) && exitCode >= 0;
  const normalizedSignal = signal == null ? 0 : signal;
  const validSignal = Number.isSafeInteger(normalizedSignal) && normalizedSignal >= 0;
  let processCode = validCode ? exitCode : 1;
  if (validSignal && normalizedSignal > 0) processCode = 128 + normalizedSignal;
  shellResult = { exitCode: validCode || (validSignal && normalizedSignal > 0) ? processCode : null,
    signal: validSignal ? normalizedSignal : null, processCode };
  shellExited = true;
  diagnostic("shell-exit", { exitCode: shellResult.exitCode, signal: shellResult.signal, detached: Boolean(detached),
    ...attached?.state() });
  clearTimeout(nativeExitTimer);
  if (attached) attached.exit();
  else if (detached) {
    // Nobody can read a detached shell's end; its process status records it.
    clearTimeout(detached.timer);
    peer?.destroy();
    if (server.listening) server.close();
  }
  finishAfterNativeExit();
}

const server = net.createServer((socket) => {
  if (peer) { socket.destroy(); return; }
  peer = socket;
  socket.setEncoding("utf8");
  let pending = "";
  let authenticated = false;
  let challenge = null;
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
  let peerClosedRecorded = false;
  // A reattach attempt that never completes cannot hold the only peer slot.
  const handshakeTimer = detached ? setTimeout(() => { if (!authenticated) socket.destroy(); }, 5000) : undefined;
  const flushInput = (force = false) => {
    if ((!force && (outputPaused || pendingOutput)) || !pendingInput || shellExited || !terminal) return;
    const input = pendingInput;
    pendingInput = "";
    terminal.write(input);
    diagnosticCounts.inputWrites += 1;
    diagnosticCounts.inputBytes = Math.min(Number.MAX_SAFE_INTEGER, diagnosticCounts.inputBytes + Buffer.byteLength(input));
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
        session = null;
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
  const handlers = {
    data(data) {
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
    },
    exit() {
      clearTimeout(shedTimer);
      // A silent peer cannot retain the final frame or broker indefinitely.
      exitTimer = setTimeout(() => socket.destroy(), 5000);
      exitTimer.unref();
      flushOutput();
    },
    state: () => ({ outputPaused, pendingOutputChars: pendingOutput.length - outputOffset,
      pendingInputBytes: Buffer.byteLength(pendingInput) }),
  };
  recordPeerClosed = () => {
    if (peerClosedRecorded) return;
    peerClosedRecorded = true;
    diagnostic("peer-closed", { shellExited, exitSent });
  };
  const startTerminal = (message) => {
    if (terminal || message.type !== "start" || message.token !== token || typeof message.shell !== "string"
      || typeof message.cwd !== "string" || !message.env || typeof message.env !== "object"
      || !validSize(message.cols, message.rows)
      || (message.session !== undefined && !validSession(message.session))) {
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
    if (message.session) session = { label: message.session.label, token: message.session.token, windowMs: message.session.windowMs };
    attached = handlers;
    socket.write(`${JSON.stringify({ type: "ready", ...(session ? { identity: instance } : {}) })}\n`);
    diagnostic("shell-spawned", { shellPid: terminal.pid });
    terminal.onData(onTerminalData);
    terminal.onExit(onTerminalExit);
  };
  // A detached broker first proves its current token over the client's
  // nonce, so a client never trusts or feeds an endpoint that lacks it. The
  // client's proof then binds the owner label, this broker's identity and the
  // token that replaces it. Any wrong label, identity or token, or one already
  // spent, fails that proof and is refused the same way, so a refusal does
  // not tell whether the session exists.
  const reattach = (message) => {
    if (!detached || !session || shellExited) { socket.destroy(); return; }
    if (!challenge) {
      if (message.type !== "reattach" || !validNonce(message.nonce)) { socket.destroy(); return; }
      challenge = { client: message.nonce, broker: reattachNonce() };
      socket.write(`${JSON.stringify({ type: "challenge", nonce: challenge.broker,
        proof: reattachProof(session.token, "broker", [challenge.client, challenge.broker, session.label, instance]) })}\n`);
      return;
    }
    if (message.type !== "prove" || !validToken(message.nextToken) || message.nextToken === session.token
      || !proofMatches(reattachProof(session.token, "client",
        [challenge.broker, challenge.client, session.label, instance, message.nextToken]), message.proof)) {
      socket.destroy(); return;
    }
    clearTimeout(detached.timer);
    clearTimeout(handshakeTimer);
    const output = detached.output.take();
    detached = null;
    session.token = message.nextToken;
    authenticated = true;
    attached = handlers;
    diagnostic("reattached", { bufferedChars: output.length });
    socket.write(`${JSON.stringify({ type: "reattached", identity: instance, pid: terminal.pid })}\n`);
    if (validSize(message.cols, message.rows)) terminal.resize(message.cols, message.rows);
    pendingOutput = output;
    flushOutput();
  };
  const handleMessage = (message) => {
    if (!authenticated) {
      if (detached) reattach(message);
      else startTerminal(message);
      return;
    }
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
    if (!shellExited && message.type === "resize" && validSize(message.cols, message.rows)) {
      terminal.resize(message.cols, message.rows);
      return;
    }
    // A reattached owner ends the shell explicitly; closing only detaches.
    if (!shellExited && message.type === "terminate") {
      session = null;
      try { terminal.kill(); } catch { /* The shell may already be gone. */ }
      nativeExitTimer = setTimeout(() => process.exit(1), 5000);
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
    clearTimeout(handshakeTimer);
    clearTimeout(shedTimer);
    clearTimeout(exitTimer);
    clearTimeout(stalledReaderTimer);
    // A refused reattach attempt leaves the detached session as it was.
    if (detached && !authenticated) {
      if (peer === socket) peer = undefined;
      return;
    }
    if (session && attached === handlers && !shellExited && terminal) {
      detach(pendingOutput.slice(outputOffset), omittedChars, { pendingInputBytes: Buffer.byteLength(pendingInput) });
      // Input this broker accepted still reaches the shell that outlives
      // the peer, in order, after the detached ring takes its output.
      flushInput(true);
      return;
    }
    recordPeerClosed();
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
  // This broker serves one peer at a time. Exit only after the native PTY has
  // reported exit, or after the bounded failure timer asks its supervisor to
  // clean up the owned process boundary.
  listenerClosed = true;
  recordPeerClosed();
  finishAfterNativeExit();
});
