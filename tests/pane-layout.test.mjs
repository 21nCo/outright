import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_SAVED_LAYOUTS, MIN_PANE_SIZE, PANE_LAYOUT_STORAGE_KEY, PANE_SEPARATOR_SIZE, PANE_VIEWS, applyPreset, closeView, computePaneRects,
  defaultPaneLayout, layoutViews, loadPaneLayout, moveView, neighborView, normalizePaneLayout, openView, resizeSplit, savePaneLayout, swapViews,
} from "../src/lib/pane-layout.js";

const pane = (view) => ({ type: "pane", view });
const split = (axis, first, second, ratio = 0.5) => ({ type: "split", axis, ratio, first, second });
const layout = (root, focused = "conversation") => ({ version: 1, root, focused });
// conversation | (terminal / changes)
const review = () => layout(split("row", pane("conversation"), split("column", pane("terminal"), pane("changes")), 0.6), "terminal");

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => { values.set(key, String(value)); },
  };
}

test("restoring a damaged layout keeps valid panes and reports each repair", () => {
  const restored = normalizePaneLayout({
    version: 1,
    focused: "browser",
    root: split("row", pane("terminal"), split("column", pane("browser"), split("row", pane("terminal"), pane("changes"), Number.NaN)), 7),
  });
  // The unknown view and the duplicate terminal leave; their splits collapse.
  // The conversation, which the chat tabs control, is always restored.
  assert.deepEqual(layoutViews(restored.layout.root), ["conversation", "terminal", "changes"]);
  assert.equal(restored.layout.root.second.ratio, 0.95);
  assert.equal(restored.layout.focused, "conversation");
  assert.deepEqual([...new Set(restored.problems)].sort(), ["conversation", "duplicate", "ratio", "view"]);

  assert.deepEqual(normalizePaneLayout({ version: 2, root: pane("terminal") }), { layout: defaultPaneLayout(), problems: ["version"] });
  assert.deepEqual(normalizePaneLayout("not a layout").problems, ["unreadable"]);
  assert.deepEqual(normalizePaneLayout(review()), { layout: review(), problems: [] });
});

test("restoring refuses trees deeper than the view count instead of recursing through them", () => {
  let root = pane("terminal");
  for (let index = 0; index < 10_000; index += 1) root = split("row", root, pane("bogus"));
  const restored = normalizePaneLayout({ version: 1, root, focused: "terminal" });
  assert.deepEqual(layoutViews(restored.layout.root), ["conversation"]);
  assert.ok(restored.problems.includes("node"));
});

test("each view has one pane, so a layout never holds more than four", () => {
  let current = defaultPaneLayout();
  for (const view of [...PANE_VIEWS, ...PANE_VIEWS]) current = openView(current, view, current.focused, "right");
  assert.deepEqual([...layoutViews(current.root)].sort(), [...PANE_VIEWS].sort());
  const reopened = openView(current, "terminal", "conversation", "down");
  assert.equal(reopened.root, current.root, "Opening a shown view changed the arrangement");
  assert.equal(reopened.focused, "terminal");
  assert.equal(openView(current, "browser"), current);
});

test("opening docks beside its target; closing hands focus to the pane that takes its place", () => {
  const opened = openView(defaultPaneLayout(), "terminal", "conversation", "down");
  assert.deepEqual(opened.root, split("column", pane("conversation"), pane("terminal")));
  assert.equal(opened.focused, "terminal");
  assert.deepEqual(openView(opened, "changes", "terminal", "left").root, split("column", pane("conversation"), split("row", pane("changes"), pane("terminal"))));

  const closed = closeView(review(), "terminal");
  assert.deepEqual(closed.root, split("row", pane("conversation"), pane("changes"), 0.6));
  assert.equal(closed.focused, "changes");
  const current = review();
  assert.equal(closeView(current, "conversation"), current, "The conversation pane closed");
  assert.equal(closeView(current, "context"), current);
});

test("moving and swapping change positions without adding or losing views", () => {
  const moved = moveView(review(), "changes", "conversation", "left");
  assert.deepEqual(moved.root, split("row", split("row", pane("changes"), pane("conversation")), pane("terminal"), 0.6));
  assert.equal(moved.focused, "changes");
  const current = review();
  assert.equal(moveView(current, "changes", "changes", "left"), current);
  assert.equal(moveView(current, "context", "conversation", "left"), current);

  const swapped = swapViews(current, "conversation", "changes");
  assert.deepEqual(layoutViews(swapped.root), ["changes", "terminal", "conversation"]);
  assert.equal(swapped.root.ratio, 0.6, "Swapping changed the pane sizes");
});

test("neighbors follow the arrangement, not the window size", () => {
  const root = review().root;
  assert.equal(neighborView(root, "conversation", "right"), "terminal");
  assert.equal(neighborView(root, "changes", "left"), "conversation");
  assert.equal(neighborView(root, "terminal", "down"), "changes");
  assert.equal(neighborView(root, "changes", "up"), "terminal");
  assert.equal(neighborView(root, "conversation", "left"), null);
  assert.equal(neighborView(root, "terminal", "right"), null);
});

test("split geometry keeps every pane at its minimum size and reports when the area is too small", () => {
  const narrowLeft = review();
  narrowLeft.root = { ...narrowLeft.root, ratio: 0.05 };
  const { panes, separators, fits } = computePaneRects(narrowLeft.root, 1000, 700);
  assert.equal(fits, true);
  assert.equal(panes.conversation.width, MIN_PANE_SIZE.conversation.width, "A stored small ratio shrank the conversation below its minimum");
  assert.equal(panes.terminal.x, MIN_PANE_SIZE.conversation.width + PANE_SEPARATOR_SIZE);
  assert.equal(panes.terminal.width + panes.conversation.width + PANE_SEPARATOR_SIZE, 1000);
  assert.equal(panes.terminal.height + panes.changes.height + PANE_SEPARATOR_SIZE, 700);
  const [outer] = separators;
  assert.deepEqual([outer.min, outer.max], [MIN_PANE_SIZE.conversation.width, 1000 - PANE_SEPARATOR_SIZE - MIN_PANE_SIZE.changes.width]);
  assert.deepEqual(outer.first, ["conversation"]);
  assert.deepEqual(outer.second, ["terminal", "changes"]);

  const tooNarrow = computePaneRects(review().root, 500, 700);
  assert.equal(tooNarrow.fits, false);
  assert.equal(computePaneRects(review().root, 1000, MIN_PANE_SIZE.terminal.height + MIN_PANE_SIZE.changes.height).fits, false);
  assert.equal(computePaneRects(pane("conversation"), 0, 0).fits, false);
});

test("resizing addresses one split and keeps ratios in bounds", () => {
  const current = review();
  const resized = resizeSplit(current, ["second"], 0.2);
  assert.equal(resized.root.second.ratio, 0.2);
  assert.equal(resized.root.ratio, 0.6);
  assert.equal(resizeSplit(current, ["second"], -4).root.second.ratio, 0.05);
  assert.equal(resizeSplit(current, ["first"], 0.3), current, "A pane path resized a split");
  assert.equal(resizeSplit(current, ["second", "second"], 0.3), current);
  assert.equal(resizeSplit(current, [], Number.NaN), current);
});

test("presets keep views they share with the current layout and its focus", () => {
  const applied = applyPreset(review(), "terminal");
  assert.deepEqual(layoutViews(applied.root), ["conversation", "terminal"]);
  assert.equal(applied.focused, "terminal");
  assert.equal(applyPreset(review(), "conversation").focused, "conversation");
  const current = review();
  assert.equal(applyPreset(current, "missing"), current);
});

test("layouts persist per worktree and survive another worktree's save", () => {
  const storage = memoryStorage();
  assert.deepEqual(loadPaneLayout(storage, "wt-a"), { layout: defaultPaneLayout(), problems: [] });
  assert.equal(savePaneLayout(storage, "wt-a", review(), 1), true);
  assert.equal(savePaneLayout(storage, "wt-b", openView(defaultPaneLayout(), "context"), 2), true);
  assert.deepEqual(loadPaneLayout(storage, "wt-a"), { layout: review(), problems: [] });
  assert.deepEqual(layoutViews(loadPaneLayout(storage, "wt-b").layout.root), ["conversation", "context"]);
  // A worktree id is data, never an object key with special meaning.
  assert.equal(savePaneLayout(storage, "__proto__", review(), 3), true);
  assert.deepEqual(loadPaneLayout(storage, "__proto__").layout, review());
  assert.deepEqual(loadPaneLayout(storage, "constructor"), { layout: defaultPaneLayout(), problems: [] });
});

test("saved layouts are bounded to the most recently arranged worktrees", () => {
  const storage = memoryStorage();
  for (let index = 0; index <= MAX_SAVED_LAYOUTS; index += 1) savePaneLayout(storage, `wt-${index}`, review(), index + 1);
  const saved = JSON.parse(storage.getItem(PANE_LAYOUT_STORAGE_KEY));
  assert.equal(Object.keys(saved.worktrees).length, MAX_SAVED_LAYOUTS);
  assert.equal(saved.worktrees["wt-0"], undefined, "The oldest layout was kept");
  assert.deepEqual(loadPaneLayout(storage, "wt-0").layout, defaultPaneLayout());
  assert.deepEqual(loadPaneLayout(storage, `wt-${MAX_SAVED_LAYOUTS}`).layout, review());
});

test("unreadable or unavailable storage falls back to the default layout and says so", () => {
  const damaged = memoryStorage({ [PANE_LAYOUT_STORAGE_KEY]: "{not json" });
  assert.deepEqual(loadPaneLayout(damaged, "wt-a"), { layout: defaultPaneLayout(), problems: ["unreadable"] });
  assert.equal(savePaneLayout(damaged, "wt-a", review(), 1), true, "A damaged store blocked new saves");
  assert.deepEqual(loadPaneLayout(damaged, "wt-a"), { layout: review(), problems: [] });

  const entry = memoryStorage({ [PANE_LAYOUT_STORAGE_KEY]: JSON.stringify({ version: 1, worktrees: { "wt-a": { layout: { version: 1, root: pane("browser") }, savedAt: 1 } } }) });
  assert.deepEqual(loadPaneLayout(entry, "wt-a"), { layout: defaultPaneLayout(), problems: ["view"] });

  const refusing = { getItem() { throw new Error("SecurityError"); }, setItem() { throw new Error("QuotaExceededError"); } };
  assert.deepEqual(loadPaneLayout(refusing, "wt-a"), { layout: defaultPaneLayout(), problems: ["storage"] });
  assert.equal(savePaneLayout(refusing, "wt-a", review()), false);
  const full = { ...memoryStorage(), setItem() { throw new Error("QuotaExceededError"); } };
  assert.equal(savePaneLayout(full, "wt-a", review()), false);
});
