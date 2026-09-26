import { useLayoutEffect, useMemo, useRef, useState } from "react";

const LINE_HEIGHT = 14;
const OVERSCAN = 40;
// Chromium clamps a single element near 16.7 million CSS pixels. Keep the
// virtual track below that limit even for the allowed 12 MiB diff output.
const MAX_TRACK_HEIGHT = 8_000_000;

function lineOffsets(diff) {
  const starts = [0];
  for (let index = 0; index < diff.length; index += 1) if (diff.charCodeAt(index) === 10 && index + 1 < diff.length) starts.push(index + 1);
  return starts;
}

export function WindowedDiff({ diff, label }) {
  const viewportRef = useRef(null);
  const [position, setPosition] = useState({ top: 0, height: 600 });
  const [needle, setNeedle] = useState("");
  const [foundLine, setFoundLine] = useState(-1);
  const [searched, setSearched] = useState(false);
  const foundOffsetRef = useRef(-1);
  const pendingFindAlignmentRef = useRef(null);
  const starts = useMemo(() => diff ? lineOffsets(diff) : [], [diff]);
  const searchable = useMemo(() => diff.toLocaleLowerCase(), [diff]);
  const searchableStarts = useMemo(() => searchable ? lineOffsets(searchable) : [], [searchable]);
  const count = starts.length;
  const scale = Math.max(1, count * LINE_HEIGHT / MAX_TRACK_HEIGHT);
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
    if (viewportRef.current) {
      viewportRef.current.scrollTop = Math.max(0, (line * LINE_HEIGHT - viewportRef.current.clientHeight / 3) / scale);
      setPosition({ top: viewportRef.current.scrollTop, height: viewportRef.current.clientHeight });
    }
  }
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const update = () => setPosition({ top: viewport.scrollTop, height: viewport.clientHeight });
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
    setFoundLine(low - 1);
  }, [diff]);
  const atEnd = position.top > 0 && position.top >= (viewportRef.current?.scrollHeight ?? Infinity) - position.height - 2;
  const start = atEnd ? Math.max(0, count - Math.ceil(position.height / LINE_HEIGHT) - OVERSCAN)
    : Math.max(0, Math.floor(position.top * scale / LINE_HEIGHT) - OVERSCAN);
  const end = atEnd ? count : Math.min(count, start + Math.ceil(position.height / LINE_HEIGHT) + OVERSCAN * 2);
  useLayoutEffect(() => {
    const pending = pendingFindAlignmentRef.current;
    const viewport = viewportRef.current;
    if (!pending || pending.line !== foundLine || !viewport) return;
    const mark = viewport.querySelector('[data-find-match="true"]');
    if (!mark || pending.attempts++ >= 3) return;
    const viewportTop = viewport.getBoundingClientRect().top;
    const before = viewport.scrollTop;
    viewport.scrollTop += mark.getBoundingClientRect().top - viewportTop - viewport.clientHeight / 3;
    setPosition({ top: viewport.scrollTop, height: viewport.clientHeight });
    const bounds = mark.getBoundingClientRect();
    if ((bounds.bottom > viewportTop && bounds.top < viewportTop + viewport.clientHeight) || viewport.scrollTop === before) pendingFindAlignmentRef.current = null;
  }, [foundLine, start, end, position.height]);
  const lines = [];
  for (let index = start; index < end; index += 1) {
    const endOffset = index + 1 < count ? starts[index + 1] - 1 : diff.length;
    const line = diff.slice(starts[index], endOffset);
    lines.push(<span className={line.startsWith("+") && !line.startsWith("+++") ? "added" : line.startsWith("-") && !line.startsWith("---") ? "removed" : line.startsWith("@@") ? "hunk" : ""} data-find-match={index === foundLine ? "true" : undefined} key={index}><i aria-hidden="true">{index + 1}</i>{line}{"\n"}</span>);
  }
  return <div className="windowed-diff"><div className="window-find" role="search" aria-label={`Find in ${label}`}><input aria-label="Find in diff" value={needle} onChange={(event) => { setNeedle(event.target.value); setFoundLine(-1); setSearched(false); foundOffsetRef.current = -1; }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); find(event.shiftKey ? -1 : 1); } }} /><button type="button" onClick={() => find(-1)} disabled={!needle} aria-label="Previous diff match">↑</button><button type="button" onClick={() => find(1)} disabled={!needle} aria-label="Next diff match">↓</button><span role="status">{needle && foundLine >= 0 ? `Line ${foundLine + 1}` : needle && searched ? "No match" : needle ? "Press Enter to find" : ""}</span></div><pre ref={viewportRef} className="diff-view" tabIndex={0} aria-label={label} onScroll={(event) => setPosition({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })}>
    {diff ? <>{start > 0 && <span aria-hidden="true" style={{ height: start * LINE_HEIGHT / scale }} />}{lines}{end < count && <span aria-hidden="true" style={{ height: (count - end) * LINE_HEIGHT / scale }} />}</> : <span className="diff-empty">Select a changed file to inspect its diff.</span>}
  </pre></div>;
}
