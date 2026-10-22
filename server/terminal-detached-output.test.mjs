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

// Splits a taken ring into its dropped-character count and the kept output.
function taken(ring) {
  const value = ring.take();
  const match = /^\u001b\[0m\[Outright: (\d+) earlier terminal output characters were dropped while detached\]\r\n/.exec(value);
  return match ? { dropped: Number(match[1]), output: value.slice(match[0].length) } : { dropped: 0, output: value };
}

test("detached output never holds more than its limit between takes", () => {
  const limit = DETACHED_OUTPUT_BYTES;
  const check = (ring, label) => assert.ok(ring.retainedBytes() <= limit, `${label}: ${ring.retainedBytes()} bytes held`);

  // A reattach replay handed back as one chunk near the limit, then more output.
  const seeded = createDetachedOutput();
  const seed = "s".repeat(960 * 1024 + 7);
  seeded.push(seed);
  check(seeded, "seed");
  const piece = "p".repeat(16 * 1024);
  for (let index = 0; index < 63; index += 1) {
    seeded.push(piece);
    check(seeded, `push ${index}`);
  }
  const fromSeed = taken(seeded);
  assert.equal(Buffer.byteLength(fromSeed.output), limit);
  assert.ok(fromSeed.output.endsWith(piece.repeat(63)), "the newest output was not kept");
  assert.equal(fromSeed.dropped + fromSeed.output.length, seed.length + 63 * piece.length);

  // One push larger than the whole limit.
  const flooded = createDetachedOutput();
  const flood = `${"o".repeat(512 * 1024)}${"n".repeat(limit)}`;
  flooded.push(flood);
  check(flooded, "flood");
  const fromFlood = taken(flooded);
  assert.equal(fromFlood.output, "n".repeat(limit));
  assert.equal(fromFlood.dropped, 512 * 1024);
});

test("detached output cuts multibyte characters and surrogate pairs whole while it is held", () => {
  const ring = createDetachedOutput(10);
  ring.push("é😀");
  ring.push("€");
  ring.push("😀");
  assert.ok(ring.retainedBytes() <= 10, `${ring.retainedBytes()} bytes held`);
  const cut = taken(ring);
  assert.equal(cut.output, "€😀");
  assert.equal(cut.dropped, "é😀".length);

  // A pair split across two pushes, then cut while held.
  const split = createDetachedOutput(6);
  split.push("ab\ud83d");
  split.push("\ude00c");
  assert.equal(split.retainedBytes(), 6, "a joined pair counts four bytes");
  split.push("d");
  assert.ok(split.retainedBytes() <= 6);
  const joined = taken(split);
  assert.equal(joined.output, "😀cd");
  assert.equal(joined.dropped, 2);

  // A pair across a full chunk boundary stays in one chunk and is dropped whole.
  const wide = createDetachedOutput(16 * 1024 + 2);
  wide.push(`${"x".repeat(16 * 1024 - 1)}\ud83d`);
  wide.push("\ude00");
  wide.push("y".repeat(16 * 1024));
  assert.ok(wide.retainedBytes() <= 16 * 1024 + 2);
  const across = taken(wide);
  assert.equal(across.output, "y".repeat(16 * 1024), "a surrogate pair was split");
  assert.equal(across.dropped, 16 * 1024 + 1);
});
