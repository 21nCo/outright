import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

async function unusedPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("standalone closes instead of serving permanent API failures when runtime construction fails", async () => {
  const directory = mkdtempSync(join(tmpdir(), "outright-standalone-init-"));
  writeFileSync(join(directory, "outright.db"), "invalid SQLite file");
  const port = await unusedPort();
  const child = spawn(process.execPath, [fileURLToPath(new URL("./standalone.mjs", import.meta.url))], {
    env: { ...process.env, OUTRIGHT_DATA_DIR: directory, PORT: String(port), HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve, reject) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
    child.once("error", reject);
  });
  let deadline;
  try {
    const exit = await Promise.race([
      closed,
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("standalone kept serving after runtime construction failed")), 5000); }),
    ]);
    assert.equal(exit.code, 1);
    assert.match(stderr, /Runtime initialization failed/);
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null) { child.kill("SIGKILL"); await closed; }
    rmSync(directory, { recursive: true, force: true });
  }
});
