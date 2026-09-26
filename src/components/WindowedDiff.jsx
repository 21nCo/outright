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
  const starts = useMemo(() => diff ? lineOffsets(diff) : [], [diff]);
  useLayoutEffect(() => {
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
    lines.push(<span className={line.startsWith("+") && !line.startsWith("+++") ? "added" : line.startsWith("-") && !line.startsWith("---") ? "removed" : line.startsWith("@@") ? "hunk" : ""} key={index}><i aria-hidden="true">{index + 1}</i>{line}{"\n"}</span>);
  }
  return <pre ref={viewportRef} className="diff-view" tabIndex={0} aria-label={label} onScroll={(event) => setPosition({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })}>
    {diff ? <>{start > 0 && <span aria-hidden="true" style={{ height: start * LINE_HEIGHT }} />}{lines}{end < count && <span aria-hidden="true" style={{ height: (count - end) * LINE_HEIGHT }} />}</> : <span className="diff-empty">Select a changed file to inspect its diff.</span>}
  </pre>;
}
