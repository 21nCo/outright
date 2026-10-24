import { Component, useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChatCircle, Columns, DotsSixVertical, DotsThree, GitDiff, Rows, TerminalWindow, TreeStructure, X } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { nextTabIndex } from "@/lib/accessibility";
import {
  MIN_PANE_SIZE, PANE_SEPARATOR_SIZE, PANE_VIEWS, PANE_VIEW_LABELS, closeView, computePaneRects, focusView, layoutViews,
  moveView, neighborView, openView, resizeSplit, swapViews,
} from "@/lib/pane-layout";

const VIEW_ICONS = { conversation: ChatCircle, changes: GitDiff, terminal: TerminalWindow, context: TreeStructure };
const PANE_DRAG_TYPE = "application/x-outright-pane";
const MOVE_SIDES = [["left", "Move left", ArrowLeft], ["right", "Move right", ArrowRight], ["up", "Move up", ArrowUp], ["down", "Move down", ArrowDown]];

export function paneId(view) { return `pane-${view}`; }

// Reordering keyed panes moves their DOM nodes, which resets scroll offsets
// and can drop focus. Capture both just before the commit and restore them.
class PreserveMovedState extends Component {
  getSnapshotBeforeUpdate(previous) {
    if (previous.order === this.props.order) return null;
    const stage = this.props.stageRef.current;
    if (!stage) return null;
    const scrolled = [];
    const walker = document.createTreeWalker(stage, NodeFilter.SHOW_ELEMENT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.scrollTop || node.scrollLeft) scrolled.push([node, node.scrollTop, node.scrollLeft]);
    }
    const active = document.activeElement;
    return { scrolled, focused: stage.contains(active) ? active : null };
  }
  componentDidUpdate(_previous, _state, snapshot) {
    if (!snapshot) return;
    for (const [node, top, left] of snapshot.scrolled) {
      if (!node.isConnected) continue;
      node.scrollTop = top;
      node.scrollLeft = left;
    }
    const { focused } = snapshot;
    if (focused?.isConnected && document.activeElement !== focused && (document.activeElement === document.body || !document.activeElement)) {
      focused.focus({ preventScroll: true });
    }
  }
  render() { return this.props.children; }
}

// Switching between split and one-at-a-time panes replaces the layout's own
// chrome: separators, pane headers, the pane tabs, their options buttons and
// the options menus portaled out of the layout. Focus on any of it that the
// switch drops moves to the shown pane, not the page. Focus inside a view's
// body is left to the view.
class KeepFocusAcrossModes extends Component {
  getSnapshotBeforeUpdate(previous) {
    if (previous.compact === this.props.compact) return null;
    const active = document.activeElement;
    if (!active) return false;
    const portaled = active.closest("[data-pane-layout-owner]");
    if (portaled) return portaled.dataset.paneLayoutOwner === this.props.ownerId;
    return Boolean(this.props.containerRef.current?.contains(active) && !active.closest(".pane-body"));
  }
  componentDidUpdate(_previous, _state, lost) {
    if (lost && (!document.activeElement || document.activeElement === document.body)) this.props.onFocusLost();
  }
  render() { return this.props.children; }
}

function preferredSide(rect, target, view) {
  if (!rect) return "right";
  const targetMin = MIN_PANE_SIZE[target];
  const viewMin = MIN_PANE_SIZE[view];
  const right = rect.width - PANE_SEPARATOR_SIZE >= targetMin.width + viewMin.width;
  const down = rect.height - PANE_SEPARATOR_SIZE >= targetMin.height + viewMin.height;
  if (right && (!down || rect.width >= rect.height)) return "right";
  return down ? "down" : "right";
}

function dropSide(event, element) {
  const rect = element.getBoundingClientRect();
  const dx = (event.clientX - rect.left) / Math.max(1, rect.width) - 0.5;
  const dy = (event.clientY - rect.top) / Math.max(1, rect.height) - 0.5;
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? "left" : "right";
  return dy < 0 ? "up" : "down";
}

const SIDE_WORDS = { left: "to the left of", right: "to the right of", up: "above", down: "below" };

// Pane geometry is computed in pixels for minimum sizes, then placed as
// fractions of the stage so a resize between measurements never overflows it.
function placement(rect, size) {
  if (!rect || !size.width || !size.height) return { inset: 0 };
  const percent = (value, total) => `${(value / total) * 100}%`;
  return { left: percent(rect.x, size.width), top: percent(rect.y, size.height), width: percent(rect.width, size.width), height: percent(rect.height, size.height) };
}

// `views` maps each view to an element created by the owner. Re-rendering the
// layout during a drag reuses those elements, so the views themselves do not
// re-render for each pointer move.
export function PaneLayout({ ref, layout, onChange, compactPreferred = false, views: viewElements, className = "" }) {
  const containerRef = useRef(null);
  const ownerId = useId();
  const stageRef = useRef(null);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const pendingFocusRef = useRef(null);
  // A menu action that moves focus to a pane stops the closing menu from
  // returning focus to its trigger, which may have moved or unmounted.
  const menuMovedFocusRef = useRef(false);
  const dragRef = useRef(null);
  const draggedViewRef = useRef(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [drag, setDrag] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);
  const [announcement, setAnnouncement] = useState("");

  useLayoutEffect(() => {
    const container = containerRef.current;
    const measure = () => {
      const rect = container.getBoundingClientRect();
      const next = { width: Math.floor(rect.width), height: Math.floor(rect.height) };
      setSize((current) => current.width === next.width && current.height === next.height ? current : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // A separator drag belongs to the tree it started on. Switching worktree or
  // changing the panes replaces that tree, which cancels the drag unsaved.
  const dragCurrent = drag && drag.root === layout.root;
  useLayoutEffect(() => {
    if (!dragRef.current || dragRef.current.root === layout.root) return;
    dragRef.current = null;
    setDrag(null);
  }, [layout.root]);

  const views = layoutViews(layout.root);
  const multiple = views.length > 1;
  const shownRoot = dragCurrent ? resizeSplit(layout, drag.path, drag.ratio).root : layout.root;
  const geometry = computePaneRects(shownRoot, size.width, size.height);
  const compact = multiple && (compactPreferred || !geometry.fits);
  const geometryRef = useRef(geometry);
  geometryRef.current = geometry;
  const focused = views.includes(layout.focused) ? layout.focused : views[0];

  // A pane title drag also belongs to its tree, in split mode. Replacing the
  // tree or showing one pane at a time abandons it, even when the browser
  // cannot deliver dragend to a title that has unmounted.
  useLayoutEffect(() => {
    if (!draggedViewRef.current || (draggedViewRef.current.root === layout.root && !compact)) return;
    draggedViewRef.current = null;
    setDropTarget(null);
  }, [layout.root, compact]);

  // The selected pane tab stays in view in a narrow tab strip, however it was
  // selected. Only the strip scrolls; scrollIntoView could move the workspace.
  const tablistRef = useRef(null);
  useLayoutEffect(() => {
    const list = tablistRef.current;
    const tab = compact && list?.querySelector(`[data-pane-view="${focused}"]`);
    if (!tab) return;
    const strip = list.getBoundingClientRect();
    const shown = tab.getBoundingClientRect();
    if (shown.left < strip.left) list.scrollLeft -= strip.left - shown.left;
    else if (shown.right > strip.right) list.scrollLeft += shown.right - strip.right;
  }, [compact, focused, size.width]);

  // Focus waits for the commit that shows its pane. A pane no longer in the
  // layout drops the request rather than taking focus later.
  const applyPendingFocus = useCallback(() => {
    const view = pendingFocusRef.current;
    if (!view) return;
    if (!layoutViews(layoutRef.current.root).includes(view)) { pendingFocusRef.current = null; return; }
    const element = document.getElementById(paneId(view));
    if (!element || element.inert) return;
    pendingFocusRef.current = null;
    element.focus({ preventScroll: true });
  }, []);
  useLayoutEffect(applyPendingFocus);

  const commit = useCallback((next, message = "", focusTarget = null) => {
    if (focusTarget) pendingFocusRef.current = focusTarget;
    if (message) setAnnouncement(message);
    if (next !== layoutRef.current) {
      layoutRef.current = next;
      onChange(next);
    } else applyPendingFocus();
  }, [onChange, applyPendingFocus]);

  const focusPane = useCallback((view) => commit(focusView(layoutRef.current, view), "", view), [commit]);

  const open = useCallback((view, { target, side, focus = true } = {}) => {
    const current = layoutRef.current;
    if (layoutViews(current.root).includes(view)) {
      if (focus) focusPane(view);
      return;
    }
    const anchor = target ?? current.focused;
    const placementSide = side ?? preferredSide(geometryRef.current.panes[anchor], anchor, view);
    commit(openView(current, view, anchor, placementSide), `${PANE_VIEW_LABELS[view]} pane opened`, focus ? view : null);
  }, [commit, focusPane]);

  const close = useCallback((view, { focusSuccessor = false } = {}) => {
    const current = layoutRef.current;
    const next = closeView(current, view);
    if (next === current) return;
    const element = document.getElementById(paneId(view));
    const hadFocus = focusSuccessor || Boolean(element?.contains(document.activeElement));
    commit(next, `${PANE_VIEW_LABELS[view]} pane closed`, hadFocus ? next.focused : null);
  }, [commit]);

  useImperativeHandle(ref, () => ({
    open,
    close,
    toggle: (view) => (layoutViews(layoutRef.current.root).includes(view) ? close(view) : open(view)),
    focus: focusPane,
  }), [open, close, focusPane]);

  // F6 and Shift+F6 cycle focus through panes, as in other multi-pane apps.
  // The capture listener also works when a terminal owns the keyboard.
  useEffect(() => {
    const cycle = (event) => {
      if (event.key !== "F6" || event.altKey || event.ctrlKey || event.metaKey) return;
      if (document.querySelector('[role="dialog"][data-open]') || containerRef.current?.closest("[inert]")) return;
      const order = layoutViews(layoutRef.current.root);
      event.preventDefault();
      event.stopPropagation();
      const current = order.findIndex((view) => document.getElementById(paneId(view))?.contains(document.activeElement));
      let next = layoutRef.current.focused;
      if (current >= 0) next = order[(current + (event.shiftKey ? -1 : 1) + order.length) % order.length];
      focusPane(next);
    };
    window.addEventListener("keydown", cycle, true);
    return () => window.removeEventListener("keydown", cycle, true);
  }, [focusPane]);

  function swap(view, side) {
    const other = neighborView(layoutRef.current.root, view, side);
    if (!other) return;
    commit(swapViews(layoutRef.current, view, other), `${PANE_VIEW_LABELS[view]} pane moved ${side === "up" || side === "down" ? side : `to the ${side}`}`, view);
  }

  function resizeTo(separator, size) {
    if (!separator.available) return;
    const first = Math.min(separator.max, Math.max(separator.min, size));
    commit(resizeSplit(layoutRef.current, separator.path, first / separator.available));
  }

  function separatorKeyDown(event, separator) {
    const row = separator.axis === "row";
    const step = Math.max(8, Math.round(separator.available * 0.05));
    let next;
    if (event.key === (row ? "ArrowLeft" : "ArrowUp")) next = separator.size - step;
    else if (event.key === (row ? "ArrowRight" : "ArrowDown")) next = separator.size + step;
    else if (event.key === "Home") next = separator.min;
    else if (event.key === "End") next = separator.max;
    else return;
    event.preventDefault();
    resizeTo(separator, next);
  }

  function separatorPointerDown(event, separator) {
    if (event.button !== 0 || !separator.available) return;
    event.preventDefault();
    // Capture fails for a pointer already released; the drag still ends on
    // that pointer's up or cancel event.
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* not capturable */ }
    const stage = stageRef.current.getBoundingClientRect();
    const ratio = separator.size / separator.available;
    const { root } = layoutRef.current;
    dragRef.current = { separator, origin: separator.axis === "row" ? stage.left : stage.top, pointerId: event.pointerId, ratio, root };
    setDrag({ path: separator.path, ratio, root });
  }

  function separatorPointerMove(event) {
    const active = dragRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const { separator } = active;
    const position = (separator.axis === "row" ? event.clientX : event.clientY) - active.origin - separator.start - PANE_SEPARATOR_SIZE / 2;
    const first = Math.min(separator.max, Math.max(separator.min, position));
    active.ratio = first / separator.available;
    setDrag({ path: separator.path, ratio: active.ratio, root: active.root });
  }

  // The drag shows its ratio locally and saves the layout once, on release.
  function separatorPointerEnd(event) {
    const active = dragRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDrag(null);
    if (active.root !== layoutRef.current.root) return;
    commit(resizeSplit(layoutRef.current, active.separator.path, active.ratio));
  }

  // Only a pane title dragged in this layout docks; chat tabs and files do not.
  function paneDragged(event) {
    const dragged = draggedViewRef.current;
    return dragged?.root === layoutRef.current.root && [...(event.dataTransfer?.types ?? [])].includes(PANE_DRAG_TYPE) ? dragged.view : null;
  }

  function dragOver(event, view) {
    const dragged = paneDragged(event);
    if (!dragged || compact) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = dragged === view ? "none" : "move";
    const side = dragged === view ? null : dropSide(event, event.currentTarget);
    setDropTarget((current) => current?.view === view && current.side === side ? current : side ? { view, side } : null);
  }

  function drop(event, view) {
    const dragged = paneDragged(event);
    if (!dragged) return;
    event.preventDefault();
    event.stopPropagation();
    draggedViewRef.current = null;
    setDropTarget(null);
    if (dragged === view || compact) return;
    const side = dropSide(event, event.currentTarget);
    commit(moveView(layoutRef.current, dragged, view, side), `${PANE_VIEW_LABELS[dragged]} pane moved ${SIDE_WORDS[side]} ${PANE_VIEW_LABELS[view]}`, dragged);
  }

  function selectCompactTab(view, focusTab = false) {
    if (focusTab) document.getElementById(`pane-tab-${view}`)?.focus({ preventScroll: true });
    commit(focusView(layoutRef.current, view));
  }

  function compactTabKeyDown(event) {
    const index = views.indexOf(event.target.dataset?.paneView);
    if (index < 0) return;
    const next = nextTabIndex(index, views.length, event.key);
    if (next === index || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    selectCompactTab(views[next], true);
  }

  function menu(view) {
    const closed = PANE_VIEWS.filter((item) => !views.includes(item));
    const label = PANE_VIEW_LABELS[view];
    const finalFocus = () => {
      const moved = menuMovedFocusRef.current;
      menuMovedFocusRef.current = false;
      return !moved;
    };
    const act = (action) => () => { menuMovedFocusRef.current = true; action(); };
    return <DropdownMenu onOpenChange={(open) => { if (open) menuMovedFocusRef.current = false; }}>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label={`${label} pane options`} />}><DotsThree weight="bold" /></DropdownMenuTrigger>
      <DropdownMenuContent align="end" finalFocus={finalFocus} data-pane-layout-owner={ownerId} className="w-auto min-w-48">
        {closed.length > 0 && <>
          <DropdownMenuGroup><DropdownMenuLabel>Split right</DropdownMenuLabel>{closed.map((item) => <DropdownMenuItem key={item} aria-label={`Open ${PANE_VIEW_LABELS[item]} to the right of ${label}`} onClick={act(() => open(item, { target: view, side: "right" }))}><Columns />{PANE_VIEW_LABELS[item]}</DropdownMenuItem>)}</DropdownMenuGroup>
          <DropdownMenuGroup><DropdownMenuLabel>Split down</DropdownMenuLabel>{closed.map((item) => <DropdownMenuItem key={item} aria-label={`Open ${PANE_VIEW_LABELS[item]} below ${label}`} onClick={act(() => open(item, { target: view, side: "down" }))}><Rows />{PANE_VIEW_LABELS[item]}</DropdownMenuItem>)}</DropdownMenuGroup>
        </>}
        {multiple && <>
          {closed.length > 0 && <DropdownMenuSeparator />}
          <DropdownMenuGroup><DropdownMenuLabel>Move</DropdownMenuLabel>{MOVE_SIDES.map(([side, text, Icon]) => <DropdownMenuItem key={side} disabled={!neighborView(layout.root, view, side)} onClick={act(() => swap(view, side))}><Icon />{text}</DropdownMenuItem>)}</DropdownMenuGroup>
        </>}
        {view !== "conversation" && <><DropdownMenuSeparator /><DropdownMenuItem variant="destructive" onClick={act(() => close(view, { focusSuccessor: true }))}><X />Close {label} pane</DropdownMenuItem></>}
      </DropdownMenuContent>
    </DropdownMenu>;
  }

  return <div ref={containerRef} className={`pane-layout ${compact ? "is-compact" : ""} ${className}`}><KeepFocusAcrossModes compact={compact} containerRef={containerRef} ownerId={ownerId} onFocusLost={() => focusPane(focused)}>
    {compact && <div className="pane-switcher">
      <div ref={tablistRef} role="tablist" aria-label="Panes" aria-orientation="horizontal" onKeyDown={compactTabKeyDown}>
        {views.map((view) => { const Icon = VIEW_ICONS[view]; return <button key={view} type="button" role="tab" id={`pane-tab-${view}`} data-pane-view={view} aria-selected={view === focused} aria-controls={paneId(view)} tabIndex={view === focused ? 0 : -1} className={view === focused ? "is-active" : ""} onClick={() => selectCompactTab(view)}><Icon />{PANE_VIEW_LABELS[view]}</button>; })}
      </div>
      {menu(focused)}
    </div>}
    <div ref={stageRef} className="pane-stage">
      <PreserveMovedState order={views.join(",")} stageRef={stageRef}>
        {views.map((view) => {
          const rect = geometry.panes[view];
          const concealed = compact && view !== focused;
          const Icon = VIEW_ICONS[view];
          return <section key={view} id={paneId(view)} data-pane-view={view} tabIndex={-1}
            className={`pane ${multiple && !compact ? "has-header" : ""} ${concealed ? "is-concealed" : ""} ${focused === view && multiple ? "is-focused" : ""}`}
            role={compact ? "tabpanel" : "region"} aria-label={compact ? undefined : `${PANE_VIEW_LABELS[view]} pane`} aria-labelledby={compact ? `pane-tab-${view}` : undefined}
            inert={concealed ? true : undefined}
            style={compact ? undefined : placement(rect, size)}
            onFocus={() => { if (layoutRef.current.focused !== view) commit(focusView(layoutRef.current, view)); }}
            onDragOverCapture={(event) => dragOver(event, view)} onDropCapture={(event) => drop(event, view)}
            onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDropTarget((current) => current?.view === view ? null : current); }}>
            {multiple && !compact && <header className="pane-header">
              <span className="pane-title" draggable onDragStart={(event) => { draggedViewRef.current = { view, root: layout.root }; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData(PANE_DRAG_TYPE, view); }} onDragEnd={() => { draggedViewRef.current = null; setDropTarget(null); }} title="Drag to move this pane"><DotsSixVertical className="pane-grip" aria-hidden="true" /><Icon aria-hidden="true" />{PANE_VIEW_LABELS[view]}</span>
              {menu(view)}
            </header>}
            <div className="pane-body">{viewElements[view]}</div>
            {dropTarget?.view === view && <div className={`pane-drop-indicator is-${dropTarget.side}`} aria-hidden="true" />}
          </section>;
        })}
      </PreserveMovedState>
      {!compact && geometry.separators.map((separator) => {
        const percent = (value) => separator.available ? Math.round((value / separator.available) * 100) : 0;
        const firstLabel = separator.first.map((view) => PANE_VIEW_LABELS[view]).join(" and ");
        const secondLabel = separator.second.map((view) => PANE_VIEW_LABELS[view]).join(" and ");
        return <div key={separator.path.join(".") || "root"} role="separator" tabIndex={0} className={`pane-separator ${dragCurrent && drag.path.join(".") === separator.path.join(".") ? "is-dragging" : ""}`}
          aria-orientation={separator.axis === "row" ? "vertical" : "horizontal"} aria-label={`Resize ${firstLabel} and ${secondLabel}`}
          aria-controls={[...separator.first, ...separator.second].map(paneId).join(" ")}
          aria-valuenow={percent(separator.size)} aria-valuemin={percent(separator.min)} aria-valuemax={percent(separator.max)} aria-valuetext={`${firstLabel} ${percent(separator.size)}%`}
          style={placement(separator.rect, size)}
          onKeyDown={(event) => separatorKeyDown(event, separator)} onPointerDown={(event) => separatorPointerDown(event, separator)}
          onPointerMove={separatorPointerMove} onPointerUp={separatorPointerEnd} onPointerCancel={separatorPointerEnd} onLostPointerCapture={separatorPointerEnd} />;
      })}
    </div>
    <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
  </KeepFocusAcrossModes></div>;
}
