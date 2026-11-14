// A fixture that ignores its owner's cancel (tests/preview-build.test.mjs).
// It starts a service in a group of its own that ignores SIGTERM and
// reports it, and a helper in its own group that holds its output open.
import { spawn } from "node:child_process";

const marker = `outright-owned-hang-${process.pid}-${Date.now()}`;
const holdOn = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
const service = spawn(process.execPath, ["-e", holdOn, marker], { stdio: "ignore", detached: process.platform !== "win32", windowsHide: true });
spawn(process.execPath, ["-e", holdOn], { stdio: ["ignore", "inherit", "inherit"], windowsHide: true });
service.once("spawn", () => process.send({ owned: "service", pid: service.pid, marker }));
process.on("message", () => { /* Ignores the owner's cancel. */ });
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
