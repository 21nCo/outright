// A worktree's pane arrangement is a versioned binary split tree. Each view
// appears at most once, so a layout holds at most four panes and a view keeps
// one mounted instance however its pane moves. The conversation view is always
// present: the chat tabs above the main view control it.

export const PANE_LAYOUT_VERSION = 1;
export const PANE_VIEWS = Object.freeze(["conversation", "changes", "terminal", "context"]);
export const PANE_VIEW_LABELS = Object.freeze({ conversation: "Conversation", changes: "Changes", terminal: "Terminal", context: "Context" });
// Smallest usable size of each pane in CSS pixels, its header included. Each
// covers the view's fixed chrome in its compact styles (the `pane` container
// queries in styles.css) plus primary content: several message lines beside
// the composer with room for its notices (a recovery decision, history and
// live output share a bounded region), a few changed files and diff lines with
// the commit bar, and a few terminal rows. A layout that cannot give every pane its minimum shows
// one pane at a time.
export const MIN_PANE_SIZE = Object.freeze({
  conversation: Object.freeze({ width: 320, height: 400 }),
  changes: Object.freeze({ width: 280, height: 340 }),
  terminal: Object.freeze({ width: 260, height: 200 }),
  context: Object.freeze({ width: 240, height: 180 }),
});
export const PANE_SEPARATOR_SIZE = 6;
export const PANE_SIDES = Object.freeze(["left", "right", "up", "down"]);
export const PANE_LAYOUT_STORAGE_KEY = "outright.pane-layouts";
// Saved layouts for the most recently arranged worktrees; older ones fall back
// to the default arrangement.
export const MAX_SAVED_LAYOUTS = 64;
const MIN_RATIO = 0.05;
const MAX_RATIO = 0.95;
const MAX_STORED_CHARACTERS = 256 * 1024;

const pane = (view) => ({ type: "pane", view });
const split = (axis, first, second, ratio = 0.5) => ({ type: "split", axis, ratio, first, second });

export function isPaneView(value) { return PANE_VIEWS.includes(value); }

export function defaultPaneLayout() { return { version: PANE_LAYOUT_VERSION, root: pane("conversation"), focused: "conversation" }; }

export const PANE_LAYOUT_PRESETS = Object.freeze([
  { id: "conversation", label: "Conversation only", root: () => pane("conversation") },
  { id: "terminal", label: "Conversation and terminal", root: () => split("row", pane("conversation"), pane("terminal"), 0.6) },
  { id: "review", label: "Conversation, terminal and changes", root: () => split("row", pane("conversation"), split("column", pane("terminal"), pane("changes")), 0.55) },
]);

export function applyPreset(layout, presetId) {
  const preset = PANE_LAYOUT_PRESETS.find((item) => item.id === presetId);
  if (!preset) return layout;
  const root = preset.root();
  const views = layoutViews(root);
  return { version: PANE_LAYOUT_VERSION, root, focused: views.includes(layout.focused) ? layout.focused : "conversation" };
}

// Views in reading order: left to right, then top to bottom.
export function layoutViews(node) {
  if (!node) return [];
  return node.type === "pane" ? [node.view] : [...layoutViews(node.first), ...layoutViews(node.second)];
}

export function hasView(layout, view) { return layoutViews(layout.root).includes(view); }

function clampRatio(value) { return Math.min(MAX_RATIO, Math.max(MIN_RATIO, value)); }

// A saved layout is untrusted input: another version, a hand edit or a view
// this build does not have. Keep what is valid, repair the rest, and report it.
export function normalizePaneLayout(raw) {
  const problems = [];
  if (!raw || typeof raw !== "object" || raw.version !== PANE_LAYOUT_VERSION) {
    return { layout: defaultPaneLayout(), problems: [raw?.version !== undefined && raw?.version !== PANE_LAYOUT_VERSION ? "version" : "unreadable"] };
  }
  const seen = new Set();
  const visit = (node, depth) => {
    if (!node || typeof node !== "object" || depth > PANE_VIEWS.length) { problems.push("node"); return null; }
    if (node.type === "pane") {
      if (!isPaneView(node.view)) { problems.push("view"); return null; }
      if (seen.has(node.view)) { problems.push("duplicate"); return null; }
      seen.add(node.view);
      return pane(node.view);
    }
    if (node.type !== "split" || (node.axis !== "row" && node.axis !== "column")) { problems.push("node"); return null; }
    const first = visit(node.first, depth + 1);
    const second = visit(node.second, depth + 1);
    if (!first || !second) return first ?? second;
    let ratio = 0.5;
    if (typeof node.ratio === "number" && Number.isFinite(node.ratio)) ratio = clampRatio(node.ratio);
    if (ratio !== node.ratio) problems.push("ratio");
    return split(node.axis, first, second, ratio);
  };
  let root = visit(raw.root, 0);
  if (!root) root = pane("conversation");
  else if (!seen.has("conversation")) {
    problems.push("conversation");
    root = split("row", pane("conversation"), root);
  }
  const views = layoutViews(root);
  return { layout: { version: PANE_LAYOUT_VERSION, root, focused: views.includes(raw.focused) ? raw.focused : "conversation" }, problems };
}

function replaceNode(node, match, replace) {
  if (match(node)) return replace(node);
  if (node.type === "pane") return node;
  const first = replaceNode(node.first, match, replace);
  const second = replaceNode(node.second, match, replace);
  return first === node.first && second === node.second ? node : { ...node, first, second };
}

function removeView(node, view) {
  if (node.type === "pane") return node.view === view ? null : node;
  const first = removeView(node.first, view);
  const second = removeView(node.second, view);
  if (!first) return second;
  if (!second) return first;
  return first === node.first && second === node.second ? node : { ...node, first, second };
}

function dock(node, view, target, side) {
  const axis = side === "left" || side === "right" ? "row" : "column";
  return replaceNode(node, (item) => item.type === "pane" && item.view === target,
    (item) => side === "left" || side === "up" ? split(axis, pane(view), item) : split(axis, item, pane(view)));
}

// Opening a view already in the layout only focuses it.
export function openView(layout, view, target = layout.focused, side = "right") {
  if (!isPaneView(view) || !PANE_SIDES.includes(side)) return layout;
  if (hasView(layout, view)) return layout.focused === view ? layout : { ...layout, focused: view };
  const views = layoutViews(layout.root);
  const anchor = views.includes(target) ? target : "conversation";
  return { ...layout, root: dock(layout.root, view, anchor, side), focused: view };
}

// The sibling that takes a closed pane's place receives focus.
export function closeView(layout, view) {
  if (view === "conversation" || !hasView(layout, view)) return layout;
  let successor = "conversation";
  const findSuccessor = (node) => {
    if (node.type === "pane") return false;
    for (const [child, sibling] of [[node.first, node.second], [node.second, node.first]]) {
      if (child.type === "pane" && child.view === view) { successor = layoutViews(sibling)[0]; return true; }
    }
    return findSuccessor(node.first) || findSuccessor(node.second);
  };
  findSuccessor(layout.root);
  const root = removeView(layout.root, view);
  return { ...layout, root, focused: layout.focused === view ? successor : layout.focused };
}

export function moveView(layout, view, target, side) {
  const views = layoutViews(layout.root);
  if (view === target || !views.includes(view) || !views.includes(target) || !PANE_SIDES.includes(side)) return layout;
  const root = dock(removeView(layout.root, view), view, target, side);
  return { ...layout, root, focused: view };
}

export function swapViews(layout, first, second) {
  const views = layoutViews(layout.root);
  if (first === second || !views.includes(first) || !views.includes(second)) return layout;
  const root = replaceNode(layout.root, (node) => node.type === "pane" && (node.view === first || node.view === second),
    (node) => pane(node.view === first ? second : first));
  return { ...layout, root, focused: first };
}

// A split is addressed by its path of "first"/"second" steps from the root.
export function splitAt(root, path) {
  let node = root;
  for (const step of path) {
    if (node?.type !== "split" || (step !== "first" && step !== "second")) return null;
    node = node[step];
  }
  return node?.type === "split" ? node : null;
}

export function resizeSplit(layout, path, ratio) {
  const target = splitAt(layout.root, path);
  if (!target || typeof ratio !== "number" || !Number.isFinite(ratio)) return layout;
  const next = clampRatio(ratio);
  if (next === target.ratio) return layout;
  return { ...layout, root: replaceNode(layout.root, (node) => node === target, (node) => ({ ...node, ratio: next })) };
}

export function focusView(layout, view) {
  return layout.focused === view || !hasView(layout, view) ? layout : { ...layout, focused: view };
}

function minimumSize(node, dimension) {
  if (node.type === "pane") return MIN_PANE_SIZE[node.view][dimension];
  const first = minimumSize(node.first, dimension);
  const second = minimumSize(node.second, dimension);
  const along = (node.axis === "row") === (dimension === "width");
  return along ? first + second + PANE_SEPARATOR_SIZE : Math.max(first, second);
}

export function minimumLayoutSize(root) {
  return { width: minimumSize(root, "width"), height: minimumSize(root, "height") };
}

// Pixel rectangles for every pane and separator. Each split gives its children
// at least their minimum sizes when it can; `fits` reports whether every pane
// received its minimum in this area.
export function computePaneRects(root, width, height) {
  const panes = {};
  const separators = [];
  let fits = width >= minimumSize(root, "width") && height >= minimumSize(root, "height");
  const place = (node, x, y, w, h, path) => {
    if (node.type === "pane") {
      const min = MIN_PANE_SIZE[node.view];
      if (w < min.width || h < min.height) fits = false;
      panes[node.view] = { x, y, width: w, height: h };
      return;
    }
    const row = node.axis === "row";
    const extent = row ? w : h;
    const available = Math.max(0, extent - PANE_SEPARATOR_SIZE);
    const dimension = row ? "width" : "height";
    const firstMin = minimumSize(node.first, dimension);
    const secondMin = minimumSize(node.second, dimension);
    let first = Math.round(node.ratio * available);
    let min = firstMin;
    let max = available - secondMin;
    if (min > max) {
      // Too small for both minimums: share the space by ratio instead.
      min = 0;
      max = available;
    }
    first = Math.min(max, Math.max(min, first));
    const second = available - first;
    separators.push({
      path, axis: node.axis, first: layoutViews(node.first), second: layoutViews(node.second),
      start: row ? x : y, available, size: first, min, max,
      rect: row ? { x: x + first, y, width: PANE_SEPARATOR_SIZE, height: h } : { x, y: y + first, width: w, height: PANE_SEPARATOR_SIZE },
    });
    if (row) {
      place(node.first, x, y, first, h, [...path, "first"]);
      place(node.second, x + first + PANE_SEPARATOR_SIZE, y, second, h, [...path, "second"]);
    } else {
      place(node.first, x, y, w, first, [...path, "first"]);
      place(node.second, x, y + first + PANE_SEPARATOR_SIZE, w, second, [...path, "second"]);
    }
  };
  place(root, 0, 0, Math.max(0, width), Math.max(0, height), []);
  return { panes, separators, fits };
}

// The pane on a side of another, judged on a unit square so the answer does
// not depend on the current window size. Ties prefer the larger shared edge.
export function neighborView(root, view, side) {
  const { panes } = computePaneRects(root, 1000, 1000);
  const from = panes[view];
  if (!from) return null;
  const epsilon = PANE_SEPARATOR_SIZE + 1;
  let best = null;
  for (const [candidate, rect] of Object.entries(panes)) {
    if (candidate === view) continue;
    const horizontal = side === "left" || side === "right";
    let gap;
    if (side === "left") gap = from.x - (rect.x + rect.width);
    else if (side === "right") gap = rect.x - (from.x + from.width);
    else if (side === "up") gap = from.y - (rect.y + rect.height);
    else gap = rect.y - (from.y + from.height);
    if (gap < 0 || gap > epsilon) continue;
    const overlap = horizontal
      ? Math.min(from.y + from.height, rect.y + rect.height) - Math.max(from.y, rect.y)
      : Math.min(from.x + from.width, rect.x + rect.width) - Math.max(from.x, rect.x);
    if (overlap <= 0) continue;
    if (!best || overlap > best.overlap) best = { view: candidate, overlap };
  }
  return best?.view ?? null;
}

function readStore(storage) {
  const text = storage.getItem(PANE_LAYOUT_STORAGE_KEY);
  if (text === null) return { entries: new Map(), damaged: false };
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || parsed.version !== PANE_LAYOUT_VERSION || !parsed.worktrees || typeof parsed.worktrees !== "object") {
      return { entries: new Map(), damaged: true };
    }
    const entries = new Map();
    for (const [id, entry] of Object.entries(parsed.worktrees)) {
      if (entry && typeof entry === "object") entries.set(id, { layout: entry.layout, savedAt: Number(entry.savedAt) || 0 });
    }
    return { entries, damaged: false };
  } catch {
    return { entries: new Map(), damaged: true };
  }
}

// Returns the worktree's restored layout and whether anything was repaired.
// Storage that cannot be read is treated as an empty store.
export function loadPaneLayout(storage, worktreeId) {
  let store;
  try { store = readStore(storage); }
  catch { return { layout: defaultPaneLayout(), problems: ["storage"] }; }
  const entry = store.entries.get(worktreeId);
  if (!entry) return { layout: defaultPaneLayout(), problems: store.damaged ? ["store"] : [] };
  return normalizePaneLayout(entry.layout);
}

// "storage" and "store" describe every worktree's saved layouts, not one.
export const PANE_STORE_PROBLEMS = Object.freeze(["storage", "store"]);
const UNREADABLE_PROBLEMS = new Set([...PANE_STORE_PROBLEMS, "unreadable", "version"]);

// The notice names what restoring changed, or "" when nothing did.
export function paneRestoreMessage(problems) {
  if (!problems.length) return "";
  if (problems.some((problem) => UNREADABLE_PROBLEMS.has(problem))) return "The saved pane layout could not be read; showing the default layout";
  const repairs = [];
  if (problems.some((problem) => ["node", "view", "duplicate"].includes(problem))) repairs.push("panes that could not be restored were left out");
  if (problems.includes("conversation")) repairs.push("the conversation pane was added back");
  if (problems.includes("ratio")) repairs.push("pane sizes that were not valid were reset");
  if (!repairs.length) return "";
  const listed = repairs.length > 1 ? `${repairs.slice(0, -1).join(", ")} and ${repairs.at(-1)}` : repairs[0];
  return `Restored the pane layout; ${listed}`;
}

// Read-modify-write keeps other worktrees' layouts saved by another tab.
// Returns false when the browser refused the write.
export function savePaneLayout(storage, worktreeId, layout, now = Date.now()) {
  try {
    const { entries } = readStore(storage);
    entries.delete(worktreeId);
    // The layout being saved is never evicted: other worktrees' layouts are
    // ranked by age, which a tied or stepped-back clock cannot order against it.
    const others = [...entries].sort((a, b) => b[1].savedAt - a[1].savedAt).slice(0, MAX_SAVED_LAYOUTS - 1);
    const kept = [[worktreeId, { layout: { version: layout.version, root: layout.root, focused: layout.focused }, savedAt: now }], ...others];
    let text = JSON.stringify({ version: PANE_LAYOUT_VERSION, worktrees: Object.fromEntries(kept) });
    while (text.length > MAX_STORED_CHARACTERS && kept.length > 1) {
      kept.pop();
      text = JSON.stringify({ version: PANE_LAYOUT_VERSION, worktrees: Object.fromEntries(kept) });
    }
    storage.setItem(PANE_LAYOUT_STORAGE_KEY, text);
    return true;
  } catch {
    return false;
  }
}
