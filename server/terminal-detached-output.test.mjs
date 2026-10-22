import assert from "node:assert/strict";
import test from "node:test";
import { createDetachedOutput, DETACHED_OUTPUT_BYTES } from "./terminal-detached-output.mjs";

test("detached output keeps the newest 1 MiB and reports what it dropped", () => {
  assert.equal(DETACHED_OUTPUT_BYTES, 1024 * 1024);
  const ring = createDetachedOutput();
  const line = `${"x".repeat(1022)}\r\n`;
  ring.push("FIRST\r\n");
  for (let index = 0; index < 1536; index += 1) ring.push(line);
  ring.push("LAST");
  const taken = ring.take();
  const [notice, ...rest] = taken.split("detached]\r\n");
  const output = rest.join("detached]\r\n");
  assert.equal(Buffer.byteLength(output), DETACHED_OUTPUT_BYTES);
  assert.ok(output.endsWith("LAST"));
  assert.ok(!output.includes("FIRST"), "the oldest output survived overflow");
  const dropped = Number(/\[Outright: (\d+) earlier terminal output characters were dropped while/.exec(notice)?.[1]);
  assert.equal(dropped + output.length, "FIRST\r\n".length + 1536 * line.length + "LAST".length);
  assert.equal(ring.take(), "", "taking output empties the ring");
});

test("detached output cuts on a character boundary and counts shed peer output", () => {
  const ring = createDetachedOutput(10);
  ring.drop(3);
  ring.push("ab");
  ring.push("€€€€");
  const taken = ring.take();
  const output = taken.slice(taken.indexOf("\r\n") + 2);
  assert.equal(output, "€€€");
  assert.match(taken, /\[Outright: 6 earlier terminal output characters were dropped while detached\]/);
  ring.push("small");
  assert.equal(ring.take(), "small", "output within the limit has no notice");
});
