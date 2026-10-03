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
const server = net.createServer((socket) => {
  if (peer) { socket.destroy(); return; }
  peer = socket;
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    pending += chunk;
    if (pending.length > 128 * 1024) { socket.destroy(); return; }
    let end;
    while ((end = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      let message;
      try { message = JSON.parse(line); } catch { socket.destroy(); return; }
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
          for (let offset = 0; offset < data.length;) {
            if (socket.destroyed || socket.writableLength > 256 * 1024) {
              socket.destroy();
              return;
            }
            let end = Math.min(data.length, offset + 16 * 1024);
            if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1]) && /[\uDC00-\uDFFF]/.test(data[end])) end -= 1;
            socket.write(`${JSON.stringify({ type: "data", data: data.slice(offset, end) })}\n`);
            offset = end;
          }
        });
        terminal.onExit(() => { socket.end(`${JSON.stringify({ type: "shell-exited" })}\n`); if (server.listening) server.close(); });
      } else if (message.type === "write" && typeof message.data === "string"
        && Buffer.byteLength(message.data) <= 64 * 1024) terminal.write(message.data);
      else if (message.type === "resize" && Number.isInteger(message.cols) && message.cols >= 20 && message.cols <= 400
        && Number.isInteger(message.rows) && message.rows >= 5 && message.rows <= 200)
        terminal.resize(message.cols, message.rows);
      else socket.destroy();
    }
  });
  socket.on("close", () => { if (server.listening) server.close(); });
});
server.listen(address, () => {
  if (process.platform !== "win32") chmodSync(address, 0o600);
  process.umask(inheritedUmask);
});
server.on("close", () => { if (process.platform !== "win32") try { unlinkSync(address); } catch {} });
