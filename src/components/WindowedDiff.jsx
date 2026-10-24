import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { foldFindText } from "@/lib/find-text";

const LINE_HEIGHT = 14;
const OVERSCAN = 40;
// Chromium clamps a single element near 16.7 million CSS pixels. Keep the
// virtual track below that limit even for the allowed 12 MiB diff output.
const MAX_TRACK_HEIGHT = 8_000_000;
// Position updates are synchronous layout work. A geometry feedback that the
// rows height below does not absorb must defer to the next frame, not recurse.
const MAX_POSITION_UPDATES_PER_FRAME = 8;

function lineOffsets(diff) {
  let count = 1;
  for (let index = 0; index + 1 < diff.length; index += 1) if (diff.charCodeAt(index) === 10) count += 1;
  const starts = new Uint32Array(count);
  let next = 1;
  for (let index = 0; index + 1 < diff.length; index += 1) if (diff.charCodeAt(index) === 10) starts[next++] = index + 1;
  return starts;
}

// The rows height is the viewport's box, not clientHeight: a classic
// horizontal scrollbar from a long mounted row must not change the rows, the
// Find target or the mounted window in turn.
export function diffRowsHeight(viewport) { return viewport.offsetHeight; }

// One Find geometry for seeking, alignment and resizes: the match row sits a
// third of the way down the rows, below the viewport's top padding.
export function diffFindTop(viewport, line) {
  const padding = Number.parseFloat(getComputedStyle(viewport).paddingTop) || 0;
  return Math.max(0, padding + line * LINE_HEIGHT - diffRowsHeight(viewport) / 3);
}

export function WindowedDiff({ diff, label }) {
  const content = typeof diff === "string" ? diff : "";
  const viewportRef = useRef(null);
  const [position, setPosition] = useState({ top: 0, height: 600 });
  const [needle, setNeedle] = useState("");
  const [foundLine, setFoundLine] = useState(-1);
  const [searched, setSearched] = useState(false);
  const [announcedStatus, setAnnouncedStatus] = useState("");
  const foundOffsetRef = useRef(-1);
  const pendingFindAlignmentRef = useRef(null);
  const wheelRemainderRef = useRef(0);
  const logicalFirstRef = useRef(0);
  const programmaticTopRef = useRef(null);
  const layoutRef = useRef({ compressed: false, maxFirst: 0, maxScroll: 1 });
  const positionRef = useRef(null);
  const burstRef = useRef({ count: 0, reset: 0, deferred: 0, top: 0, first: null });
  const alignRef = useRef(null);
  const updatePosition = (viewport, logicalFirst = null) => {
    const top = viewport.scrollTop;
    const height = diffRowsHeight(viewport);
    const { compressed, maxFirst, maxScroll } = layoutRef.current;
    // A compressed track has fewer physical pixels than logical lines. Keep
    // line moves exact, even when the browser rounds a programmatic scroll.
    const first = logicalFirst ?? (programmaticTopRef.current != null && Math.abs(top - programmaticTopRef.current) <= 1
      ? logicalFirstRef.current : null);
    if (first == null) {
      programmaticTopRef.current = null;
      logicalFirstRef.current = compressed ? Math.max(0, Math.min(maxFirst, Math.round(top / maxScroll * maxFirst)))
        : Math.max(0, Math.min(maxFirst, Math.floor(top / LINE_HEIGHT)));
    } else logicalFirstRef.current = first;
    const current = positionRef.current;
    if (current && current.top === top && current.height === height && current.first === first) return;
    const burst = burstRef.current;
    if (++burst.count > MAX_POSITION_UPDATES_PER_FRAME) {
      // Defer the commit, not the update: the logical cursor above is already
      // current, and the next frame keeps its exact line unless the viewport
      // has moved since.
      burst.top = top;
      burst.first = first;
      if (!burst.deferred) burst.deferred = window.requestAnimationFrame(() => {
        burst.deferred = 0;
        if (viewport.isConnected) updatePosition(viewport, viewport.scrollTop === burst.top ? burst.first : null);
      });
      return;
    }
    if (!burst.reset) burst.reset = window.requestAnimationFrame(() => { burst.reset = 0; burst.count = 0; });
    positionRef.current = { top, height, first };
    setPosition(positionRef.current);
  };
  const starts = useMemo(() => content ? lineOffsets(content) : [], [content]);
  const searchable = useMemo(() => foldFindText(content), [content]);
  // ASCII case folding leaves every newline offset unchanged. Large diffs
  // are commonly ASCII and should not retain a second million-entry index.
  const searchableStarts = useMemo(() => /[^\x00-\x7f]/.test(content) ? lineOffsets(searchable) : starts, [content, searchable, starts]);
  const count = starts.length;
  const compressed = count * LINE_HEIGHT > MAX_TRACK_HEIGHT;
  const trackHeight = compressed ? MAX_TRACK_HEIGHT : count * LINE_HEIGHT;
  const visibleRows = Math.max(1, Math.floor(position.height / LINE_HEIGHT));
  const maxFirst = Math.max(0, count - visibleRows);
  const maxScroll = Math.max(1, trackHeight - position.height);
  useLayoutEffect(() => {
    // Only committed geometry can own scroll events. A discarded render must
    // not change the observer's coordinate model.
    layoutRef.current = { compressed, maxFirst, maxScroll };
  }, [compressed, maxFirst, maxScroll]);
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    // A refreshed diff starts a new line coordinate system. Adopt its actual
    // physical viewport before a later wheel uses the logical cursor.
    programmaticTopRef.current = null;
    updatePosition(viewport);
  }, [content]);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const wheel = (event) => {
      // Browser zoom (including trackpad pinch) and shifted horizontal wheel
      // gestures belong to the browser, not to diff row navigation.
      if (event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (!event.deltaY) return; // Keep native horizontal navigation.
      pendingFindAlignmentRef.current = null;
      event.preventDefault();
      if (event.deltaX) viewport.scrollLeft += event.deltaX * (event.deltaMode === 1 ? LINE_HEIGHT : event.deltaMode === 2 ? viewport.clientWidth : 1);
      const pixels = event.deltaY * (event.deltaMode === 1 ? LINE_HEIGHT : event.deltaMode === 2 ? viewport.clientHeight : 1);
      if (!compressed) {
        // Some engines cap the native movement from a large delivered wheel
        // to a few pixels after the virtual range changes. Apply the wheel's
        // delivered delta to the stable scroll track before changing rows.
        viewport.scrollTop += pixels;
        updatePosition(viewport);
        return;
      }
      wheelRemainderRef.current += pixels / LINE_HEIGHT;
      const lines = Math.trunc(wheelRemainderRef.current);
      wheelRemainderRef.current -= lines;
      if (!lines) return;
      // Physical pixels cannot represent every line near the diff size cap.
      // Wheel batches must advance the logical cursor, not round-trip through
      // scrollTop on each event before React renders.
      const first = Math.max(0, Math.min(maxFirst, logicalFirstRef.current + lines));
      viewport.scrollTop = maxFirst ? first / maxFirst * maxScroll : 0;
      programmaticTopRef.current = viewport.scrollTop;
      updatePosition(viewport, first);
    };
    // Capture before a platform's asynchronous scroll default can be queued.
    // A bubble listener can arrive after native movement on large tracks.
    viewport.addEventListener("wheel", wheel, { capture: true, passive: false });
    return () => viewport.removeEventListener("wheel", wheel, { capture: true });
  }, [compressed, maxFirst, maxScroll]);
  function moveFirst(first) {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const next = Math.max(0, Math.min(maxFirst, first));
    viewport.scrollTop = maxFirst ? next / maxFirst * maxScroll : 0;
    programmaticTopRef.current = viewport.scrollTop;
    updatePosition(viewport, next);
  }
  // A seek lands on the Find target directly, so aligning again with the
  // same geometry moves nothing and needs no corrective pass.
  function seekLine(line) {
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (compressed) {
      const first = Math.max(0, Math.min(maxFirst, line - Math.floor(visibleRows / 3)));
      if (Math.abs(viewport.scrollTop - (maxFirst ? first / maxFirst * maxScroll : 0)) > 1) moveFirst(first);
      else { programmaticTopRef.current = viewport.scrollTop; updatePosition(viewport, first); }
      return;
    }
    const top = diffFindTop(viewport, line);
    if (Math.abs(viewport.scrollTop - top) > 1) viewport.scrollTop = top;
    updatePosition(viewport);
  }
  // Find owns the viewport from a seek until a wheel, pointer, touch or key
  // gesture, or a new or cleared query. While it does, a resize aligns the
  // match before paint, and a scroll it did not cause, such as a late queued
  // native End, aligns it in that scroll event or in the next commit,
  // whichever comes first.
  function claimFind(line) {
    pendingFindAlignmentRef.current = { line, top: null };
    seekLine(line);
    pendingFindAlignmentRef.current.top = viewportRef.current?.scrollTop ?? null;
  }
  function find(direction = 1, value = needle) {
    const query = foldFindText(value.trim());
    if (!query) { setFoundLine(-1); setSearched(false); foundOffsetRef.current = -1; pendingFindAlignmentRef.current = null; return; }
    const offset = foundOffsetRef.current < 0 ? (direction > 0 ? 0 : searchable.length - 1) : foundOffsetRef.current + direction;
    // lastIndexOf treats a negative fromIndex as zero, so wrap explicitly
    // when Previous moves left of a match at the start of the diff.
    const searchOffset = direction < 0 && offset < 0 ? searchable.length - 1 : offset;
    let match = direction > 0 ? searchable.indexOf(query, searchOffset) : searchable.lastIndexOf(query, searchOffset);
    if (match < 0) match = direction > 0 ? searchable.indexOf(query) : searchable.lastIndexOf(query);
    if (match < 0) { setFoundLine(-1); setSearched(true); foundOffsetRef.current = -1; pendingFindAlignmentRef.current = null; return; }
    foundOffsetRef.current = match;
    setSearched(true);
    let low = 0; let high = searchableStarts.length;
    while (low < high) { const middle = (low + high) >>> 1; if (searchableStarts[middle] <= match) low = middle + 1; else high = middle; }
    const line = low - 1;
    setFoundLine(line);
    claimFind(line);
  }
  // Each alignment is one seek to the current target. It changes no state
  // when the viewport is already there, so it cannot recurse.
  const align = () => {
    const pending = pendingFindAlignmentRef.current;
    if (!pending || !viewportRef.current) return;
    seekLine(pending.line);
    // The scroll event this seek causes is not an outside scroll.
    pending.top = viewportRef.current.scrollTop;
  };
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    // ResizeObserver survives same-component diff refreshes. Read the latest
    // coordinate model, rather than retaining the layout from the first diff.
    updatePosition(viewport);
    // ResizeObserver delivers after layout and before paint.
    const resize = new ResizeObserver(() => { updatePosition(viewport); alignRef.current?.(); });
    resize.observe(viewport);
    const burst = burstRef.current;
    return () => {
      resize.disconnect();
      window.cancelAnimationFrame(burst.reset); window.cancelAnimationFrame(burst.deferred);
      burst.reset = 0; burst.deferred = 0;
    };
  }, []);
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    // Scroll and resize callbacks can enqueue a position from an older frame.
    // Reconcile the committed row placement with the physical viewport before
    // paint, including while a compressed Find seek is still pending.
    if (viewport.scrollTop !== position.top || diffRowsHeight(viewport) !== position.height) updatePosition(viewport);
    // A commit can land between a scroll Find did not cause and that scroll's
    // event, or after a seek the viewport could not take yet. Every commit
    // aligns while Find owns the viewport, so none depends on an event's
    // timing. An aligned viewport moves nothing, so this ends.
    if (pendingFindAlignmentRef.current) align();
  });
  useLayoutEffect(() => {
    if (!needle.trim() || foundOffsetRef.current < 0) return;
    const query = foldFindText(needle.trim());
    let match = searchable.indexOf(query, Math.min(foundOffsetRef.current, searchable.length));
    if (match < 0) match = searchable.indexOf(query);
    if (match < 0) { foundOffsetRef.current = -1; pendingFindAlignmentRef.current = null; setFoundLine(-1); setSearched(true); return; }
    foundOffsetRef.current = match;
    let low = 0; let high = searchableStarts.length;
    while (low < high) { const middle = (low + high) >>> 1; if (searchableStarts[middle] <= match) low = middle + 1; else high = middle; }
    const line = low - 1;
    setFoundLine(line);
    claimFind(line);
  }, [content]);
  // The mounted rows always follow the observed viewport. Alignment needs no
  // mounted row, so a pending Find never mounts its match where the viewport
  // is not.
  const firstVisible = compressed ? Math.max(0, Math.min(maxFirst, position.first ?? Math.round(position.top / maxScroll * maxFirst)))
    : Math.max(0, Math.min(maxFirst, Math.floor(position.top / LINE_HEIGHT)));
  const start = compressed ? firstVisible : Math.max(0, firstVisible - OVERSCAN);
  const end = Math.min(count, firstVisible + visibleRows + OVERSCAN);
  // Keep the mounted window attached to the physical viewport. Large CSS top
  // coordinates lose precision across engines at multi-million-pixel scroll
  // positions; a sticky zero-height anchor avoids that coordinate conversion.
  const visibleStatus = needle && foundLine >= 0 ? `Line ${foundLine + 1}` : needle && searched ? "No match" : needle ? "Press Enter to find" : "";
  useEffect(() => {
    const timer = window.setTimeout(() => setAnnouncedStatus(visibleStatus), 180);
    return () => window.clearTimeout(timer);
  }, [visibleStatus]);
  // Only committed geometry may align, as with the scroll coordinate model.
  // A committed height or mode change re-maps a compressed track.
  useLayoutEffect(() => { alignRef.current = align; });
  useLayoutEffect(() => { alignRef.current(); }, [position.height, compressed]);
  const lines = [];
  for (let index = start; index < end; index += 1) {
    const endOffset = index + 1 < count ? starts[index + 1] - 1 : content.length;
    const line = content.slice(starts[index], endOffset);
    lines.push(<span className={line.startsWith("+") && !line.startsWith("+++") ? "added" : line.startsWith("-") && !line.startsWith("---") ? "removed" : line.startsWith("@@") ? "hunk" : ""} data-find-match={index === foundLine ? "true" : undefined} key={index}><i aria-hidden="true">{index + 1}</i>{line}{"\n"}</span>);
  }
  return <div className="windowed-diff"><div className="window-find" role="search" aria-label={`Find in ${label}`}><input aria-label="Find in diff" value={needle} onChange={(event) => { setNeedle(event.target.value); setFoundLine(-1); setSearched(false); foundOffsetRef.current = -1; pendingFindAlignmentRef.current = null; }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); find(event.shiftKey ? -1 : 1); } }} /><button type="button" onClick={() => find(-1)} disabled={!needle} aria-label="Previous diff match">↑</button><button type="button" onClick={() => find(1)} disabled={!needle} aria-label="Next diff match">↓</button><span aria-hidden="true">{visibleStatus}</span><span className="sr-only" role="status">{announcedStatus}</span></div><pre ref={viewportRef} className="diff-view" tabIndex={0} aria-label={label} data-first-line={firstVisible} data-mounted-start={start} data-mounted-end={end} onScroll={(event) => { updatePosition(event.currentTarget); if (event.currentTarget.scrollTop !== pendingFindAlignmentRef.current?.top) alignRef.current?.(); }} onPointerDown={() => { pendingFindAlignmentRef.current = null; }} onTouchStart={() => { pendingFindAlignmentRef.current = null; }} onWheelCapture={(event) => { if (event.deltaY && !event.ctrlKey && !event.metaKey && !event.shiftKey) pendingFindAlignmentRef.current = null; }} onKeyDown={(event) => {
    pendingFindAlignmentRef.current = null;
    if (!compressed) return;
    const moves = { ArrowDown: 1, ArrowUp: -1, PageDown: visibleRows - 1, PageUp: 1 - visibleRows, Home: -maxFirst, End: maxFirst };
    if (!(event.key in moves)) return;
    event.preventDefault();
    moveFirst(event.key === "Home" ? 0 : event.key === "End" ? maxFirst : firstVisible + moves[event.key]);
  }}>
    {content ? compressed
      ? <div style={{ height: trackHeight }}><div style={{ position: "sticky", top: 0, height: 0 }}>{lines}</div></div>
      : <div style={{ height: trackHeight, position: "relative" }}><div style={{ position: "absolute", top: start * LINE_HEIGHT, left: 0, right: 0 }}>{lines}</div></div>
      : <span className="diff-empty">Select a changed file to inspect its diff.</span>}
  </pre></div>;
}
