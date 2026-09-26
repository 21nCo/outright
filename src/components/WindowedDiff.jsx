import { useLayoutEffect, useMemo, useRef, useState } from "react";

const LINE_HEIGHT = 14;
const OVERSCAN = 40;

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
  const starts = useMemo(() => diff ? lineOffsets(diff) : [], [diff]);
  const searchable = useMemo(() => diff.toLocaleLowerCase(), [diff]);
  const searchableStarts = useMemo(() => searchable ? lineOffsets(searchable) : [], [searchable]);
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
    if (viewportRef.current) {
      viewportRef.current.scrollTop = Math.max(0, line * LINE_HEIGHT - viewportRef.current.clientHeight / 3);
      setPosition({ top: viewportRef.current.scrollTop, height: viewportRef.current.clientHeight });
    }
  }
  useLayoutEffect(() => {
    foundOffsetRef.current = -1;
    setFoundLine(-1);
    setSearched(false);
    const viewport = viewportRef.current;
    if (!viewport) return;
    const update = () => setPosition({ top: viewport.scrollTop, height: viewport.clientHeight });
    update();
    const resize = new ResizeObserver(update);
    resize.observe(viewport);
    return () => resize.disconnect();
  }, [diff]);
  const count = starts.length;
  const start = Math.max(0, Math.floor(position.top / LINE_HEIGHT) - OVERSCAN);
  const end = Math.min(count, Math.ceil((position.top + position.height) / LINE_HEIGHT) + OVERSCAN);
  const lines = [];
  for (let index = start; index < end; index += 1) {
    const endOffset = index + 1 < count ? starts[index + 1] - 1 : diff.length;
    const line = diff.slice(starts[index], endOffset);
    lines.push(<span className={line.startsWith("+") && !line.startsWith("+++") ? "added" : line.startsWith("-") && !line.startsWith("---") ? "removed" : line.startsWith("@@") ? "hunk" : ""} data-find-match={index === foundLine ? "true" : undefined} key={index}><i aria-hidden="true">{index + 1}</i>{line}{"\n"}</span>);
  }
  return <div className="windowed-diff"><div className="window-find" role="search" aria-label={`Find in ${label}`}><input aria-label="Find in diff" value={needle} onChange={(event) => { setNeedle(event.target.value); setFoundLine(-1); setSearched(false); foundOffsetRef.current = -1; }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); find(event.shiftKey ? -1 : 1); } }} /><button type="button" onClick={() => find(-1)} disabled={!needle} aria-label="Previous diff match">↑</button><button type="button" onClick={() => find(1)} disabled={!needle} aria-label="Next diff match">↓</button><span role="status">{needle && foundLine >= 0 ? `Line ${foundLine + 1}` : needle && searched ? "No match" : needle ? "Press Enter to find" : ""}</span></div><pre ref={viewportRef} className="diff-view" tabIndex={0} aria-label={label} onScroll={(event) => setPosition({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })}>
    {diff ? <>{start > 0 && <span aria-hidden="true" style={{ height: start * LINE_HEIGHT }} />}{lines}{end < count && <span aria-hidden="true" style={{ height: (count - end) * LINE_HEIGHT }} />}</> : <span className="diff-empty">Select a changed file to inspect its diff.</span>}
  </pre></div>;
}
