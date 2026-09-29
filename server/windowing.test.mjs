import assert from "node:assert/strict";
import test from "node:test";
import { windowRange } from "../src/lib/windowing.js";

test("long lists keep a bounded visible range and stable spacer height", () => {
  const sizes = Array.from({ length: 1_000 }, (_, index) => index % 2 ? 180 : 60);
  const total = sizes.reduce((sum, size) => sum + size, 0);
  const nearEnd = windowRange(sizes.length, (index) => sizes[index], total - 700, 700);
  assert.ok(nearEnd.start > 900);
  assert.ok(nearEnd.end - nearEnd.start < 30);
  assert.equal(nearEnd.top + sizes.slice(nearEnd.start, nearEnd.end).reduce((sum, size) => sum + size, 0) + nearEnd.bottom, total);
  const top = windowRange(sizes.length, (index) => sizes[index], 0, 700);
  assert.equal(top.start, 0);
  assert.ok(top.end < 30);
});
