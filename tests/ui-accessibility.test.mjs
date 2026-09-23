import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { domId, nextTabIndex } from "../src/lib/accessibility.js";

const root = new URL("../", import.meta.url);

test("tab navigation wraps and supports Home and End", () => {
  assert.equal(nextTabIndex(0, 3, "ArrowRight"), 1);
  assert.equal(nextTabIndex(2, 3, "ArrowRight"), 0);
  assert.equal(nextTabIndex(0, 3, "ArrowLeft"), 2);
  assert.equal(nextTabIndex(1, 3, "Home"), 0);
  assert.equal(nextTabIndex(1, 3, "End"), 2);
  assert.equal(nextTabIndex(1, 3, "Enter"), 1);
  assert.equal(nextTabIndex(0, 0, "ArrowRight"), -1);
});

test("DOM ids remain valid for provider and runtime identifiers", () => {
  assert.equal(domId("chat-tab", "abc/123:next"), "chat-tab-abc-123-next");
});

test("core surfaces retain accessible semantics and narrow-screen fallbacks", async () => {
  const [app, terminal, palette, styles] = await Promise.all([
    readFile(new URL("src/App.jsx", root), "utf8"),
    readFile(new URL("src/components/TerminalPane.jsx", root), "utf8"),
    readFile(new URL("src/components/CommandPalette.jsx", root), "utf8"),
    readFile(new URL("src/styles.css", root), "utf8"),
  ]);

  for (const expected of [
    'role="tablist"',
    'role="tabpanel"',
    'role="status"',
    'role="alert"',
    'aria-live="polite"',
    'className="mobile-scrim"',
  ]) assert.match(app, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  assert.match(terminal, /screenReaderMode: true/);
  assert.match(terminal, /aria-describedby="terminal-help"/);
  assert.match(palette, /role="combobox"/);
  assert.match(palette, /role="listbox"/);
  assert.match(styles, /@media \(max-width: 760px\)/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
});
