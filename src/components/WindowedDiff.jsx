import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

const LINE_HEIGHT = 14;
const OVERSCAN = 40;
// Chromium clamps a single element near 16.7 million CSS pixels. Keep the
// virtual track below that limit even for the allowed 12 MiB diff output.
const MAX_TRACK_HEIGHT = 8_000_000;

function lineOffsets(diff) {
  let count = 1;
  for (let index = 0; index + 1 < diff.length; index += 1) if (diff.charCodeAt(index) === 10) count += 1;
  const starts = new Uint32Array(count);
  let next = 1;
  for (let index = 0; index + 1 < diff.length; index += 1) if (diff.charCodeAt(index) === 10) starts[next++] = index + 1;
  return starts;
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
  const updatePosition = (viewport) => {
    const top = viewport.scrollTop;
    const height = viewport.clientHeight;
    setPosition((current) => current.top === top && current.height === height ? current : { top, height });
  };
  const starts = useMemo(() => content ? lineOffsets(content) : [], [content]);
  const searchable = useMemo(() => content.toLocaleLowerCase(), [content]);
  // ASCII case folding leaves every newline offset unchanged. Large diffs
  // are commonly ASCII and should not retain a second million-entry index.
  const searchableStarts = useMemo(() => /[^\x00-\x7f]/.test(content) ? lineOffsets(searchable) : starts, [content, searchable, starts]);
  const count = starts.length;
  const compressed = count * LINE_HEIGHT > MAX_TRACK_HEIGHT;
  const trackHeight = compressed ? MAX_TRACK_HEIGHT : count * LINE_HEIGHT;
  const visibleRows = Math.max(1, Math.floor(position.height / LINE_HEIGHT));
  const maxFirst = Math.max(0, count - visibleRows);
  const maxScroll = Math.max(1, trackHeight - position.height);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !compressed) return;
    const wheel = (event) => {
      if (!event.deltaY) return; // Keep native horizontal navigation.
      pendingFindAlignmentRef.current = null;
      event.preventDefault();
      if (event.deltaX) viewport.scrollLeft += event.deltaX * (event.deltaMode === 1 ? LINE_HEIGHT : event.deltaMode === 2 ? viewport.clientWidth : 1);
      const pixels = event.deltaY * (event.deltaMode === 1 ? LINE_HEIGHT : event.deltaMode === 2 ? viewport.clientHeight : 1);
      wheelRemainderRef.current += pixels / LINE_HEIGHT;
      const lines = Math.trunc(wheelRemainderRef.current);
      wheelRemainderRef.current -= lines;
      if (!lines) return;
      // Read the physical position on every event; React may batch several
      // wheels before it renders a new firstVisible value.
      const first = Math.min(maxFirst, Math.round(viewport.scrollTop / maxScroll * maxFirst));
      viewport.scrollTop = Math.max(0, Math.min(maxFirst, first + lines)) / maxFirst * maxScroll;
      updatePosition(viewport);
    };
    viewport.addEventListener("wheel", wheel, { passive: false });
    return () => viewport.removeEventListener("wheel", wheel);
  }, [compressed, maxFirst, maxScroll]);
  function moveFirst(first) {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollTop = maxFirst ? Math.max(0, Math.min(maxFirst, first)) / maxFirst * maxScroll : 0;
    updatePosition(viewport);
  }
  function seekLine(line) {
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (compressed) {
      const first = Math.max(0, Math.min(maxFirst, line - Math.floor(visibleRows / 3)));
      moveFirst(first);
      return;
    }
    viewport.scrollTop = Math.max(0, line * LINE_HEIGHT - viewport.clientHeight / 3);
    updatePosition(viewport);
  }
  function find(direction = 1, value = needle) {
    const query = value.trim().toLocaleLowerCase();
    if (!query) { setFoundLine(-1); setSearched(false); foundOffsetRef.current = -1; return; }
    const offset = foundOffsetRef.current < 0 ? (direction > 0 ? 0 : searchable.length - 1) : foundOffsetRef.current + direction;
    let match = direction > 0 ? searchable.indexOf(query, offset) : searchable.lastIndexOf(query, offset);
    if (match < 0) match = direction > 0 ? searchable.indexOf(query) : searchable.lastIndexOf(query);
    if (match < 0) { setFoundLine(-1); setSearched(true); foundOffsetRef.current = -1; return; }
    foundOffsetRef.current = match;
    setSearched(true);
    let low = 0; let high = searchableStarts.length;
    while (low < high) { const middle = (low + high) >>> 1; if (searchableStarts[middle] <= match) low = middle + 1; else high = middle; }
    const line = low - 1;
    setFoundLine(line);
    pendingFindAlignmentRef.current = { line, attempts: 0 };
    seekLine(line);
  }
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const update = () => updatePosition(viewport);
    update();
    const resize = new ResizeObserver(update);
    resize.observe(viewport);
    return () => resize.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (!needle.trim() || foundOffsetRef.current < 0) return;
    const query = needle.trim().toLocaleLowerCase();
    let match = searchable.indexOf(query, Math.min(foundOffsetRef.current, searchable.length));
    if (match < 0) match = searchable.indexOf(query);
    if (match < 0) { foundOffsetRef.current = -1; setFoundLine(-1); setSearched(true); return; }
    foundOffsetRef.current = match;
    let low = 0; let high = searchableStarts.length;
    while (low < high) { const middle = (low + high) >>> 1; if (searchableStarts[middle] <= match) low = middle + 1; else high = middle; }
    const line = low - 1;
    setFoundLine(line);
    pendingFindAlignmentRef.current = { line, attempts: 0 };
    seekLine(line);
  }, [content]);
  const scrollFirst = compressed ? Math.min(maxFirst, Math.round(position.top / maxScroll * maxFirst))
    : Math.min(maxFirst, Math.floor(position.top / LINE_HEIGHT));
  // A seek can race a queued native End/scroll event after a mode switch.
  // Keep the target mounted while the browser delivers that event and align
  // again over several frames. A fresh user gesture releases this intent.
  const pendingLine = pendingFindAlignmentRef.current?.line;
  const firstVisible = pendingLine != null
    && (pendingLine < scrollFirst - OVERSCAN || pendingLine >= scrollFirst + visibleRows + OVERSCAN)
    ? Math.max(0, Math.min(maxFirst, pendingLine - Math.floor(visibleRows / 3))) : scrollFirst;
  const start = Math.max(0, firstVisible - OVERSCAN);
  const end = Math.min(count, firstVisible + visibleRows + OVERSCAN);
  const visibleStatus = needle && foundLine >= 0 ? `Line ${foundLine + 1}` : needle && searched ? "No match" : needle ? "Press Enter to find" : "";
  useEffect(() => {
    const timer = window.setTimeout(() => setAnnouncedStatus(visibleStatus), 180);
    return () => window.clearTimeout(timer);
  }, [visibleStatus]);
  useLayoutEffect(() => {
    const pending = pendingFindAlignmentRef.current;
    const viewport = viewportRef.current;
    if (!pending || pending.line !== foundLine || !viewport) return;
    let frame;
    const align = () => {
      if (pendingFindAlignmentRef.current !== pending) return;
      const mark = viewport.querySelector('[data-find-match="true"]');
      if (compressed || !mark) seekLine(pending.line);
      else {
        const viewportTop = viewport.getBoundingClientRect().top;
        const rowTop = mark.getBoundingClientRect().top;
        const desired = viewportTop + viewport.clientHeight / 3;
        if (Math.abs(rowTop - desired) > 1) viewport.scrollTop += rowTop - desired;
        updatePosition(viewport);
      }
      if (++pending.attempts < 12) frame = window.requestAnimationFrame(align);
      else if (pendingFindAlignmentRef.current === pending) pendingFindAlignmentRef.current = null;
    };
    align();
    return () => window.cancelAnimationFrame(frame);
  }, [foundLine, start, end, position.height, compressed]);
  const lines = [];
  for (let index = start; index < end; index += 1) {
    const endOffset = index + 1 < count ? starts[index + 1] - 1 : content.length;
    const line = content.slice(starts[index], endOffset);
    lines.push(<span className={line.startsWith("+") && !line.startsWith("+++") ? "added" : line.startsWith("-") && !line.startsWith("---") ? "removed" : line.startsWith("@@") ? "hunk" : ""} data-find-match={index === foundLine ? "true" : undefined} key={index}><i aria-hidden="true">{index + 1}</i>{line}{"\n"}</span>);
  }
  return <div className="windowed-diff"><div className="window-find" role="search" aria-label={`Find in ${label}`}><input aria-label="Find in diff" value={needle} onChange={(event) => { setNeedle(event.target.value); setFoundLine(-1); setSearched(false); foundOffsetRef.current = -1; pendingFindAlignmentRef.current = null; }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); find(event.shiftKey ? -1 : 1); } }} /><button type="button" onClick={() => find(-1)} disabled={!needle} aria-label="Previous diff match">↑</button><button type="button" onClick={() => find(1)} disabled={!needle} aria-label="Next diff match">↓</button><span aria-hidden="true">{visibleStatus}</span><span className="sr-only" role="status">{announcedStatus}</span></div><pre ref={viewportRef} className="diff-view" tabIndex={0} aria-label={label} onScroll={(event) => updatePosition(event.currentTarget)} onPointerDown={() => { pendingFindAlignmentRef.current = null; }} onTouchStart={() => { pendingFindAlignmentRef.current = null; }} onWheelCapture={() => { pendingFindAlignmentRef.current = null; }} onKeyDown={(event) => {
    pendingFindAlignmentRef.current = null;
    if (!compressed) return;
    const moves = { ArrowDown: 1, ArrowUp: -1, PageDown: visibleRows - 1, PageUp: 1 - visibleRows, Home: -maxFirst, End: maxFirst };
    if (!(event.key in moves)) return;
    event.preventDefault();
    moveFirst(event.key === "Home" ? 0 : event.key === "End" ? maxFirst : firstVisible + moves[event.key]);
  }}>
    {content ? compressed
      ? <div style={{ height: trackHeight, position: "relative" }}><div style={{ position: "absolute", top: position.top + (start - firstVisible) * LINE_HEIGHT, left: 0, right: 0 }}>{lines}</div></div>
      : <>{start > 0 && <span aria-hidden="true" style={{ height: start * LINE_HEIGHT }} />}{lines}{end < count && <span aria-hidden="true" style={{ height: (count - end) * LINE_HEIGHT }} />}</>
      : <span className="diff-empty">Select a changed file to inspect its diff.</span>}
  </pre></div>;
}
