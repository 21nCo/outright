import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { windowRange } from "@/lib/windowing";

export const ESTIMATED_MESSAGE_HEIGHT = 110;
const FULL_RENDER_LIMIT = 80;

export function WindowedMessages({ messages, viewportRef, renderMessage }) {
  const listRef = useRef(null);
  const heightsRef = useRef(new Map());
  const rangeRef = useRef({ start: 0, end: Math.min(messages.length, FULL_RENDER_LIMIT), top: 0, bottom: 0 });
  const [range, setRange] = useState(rangeRef.current);

  const update = useCallback(() => {
    const viewport = viewportRef.current;
    const list = listRef.current;
    if (!viewport || !list) return;
    const known = heightsRef.current;
    const localOffset = list.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
    const next = messages.length <= FULL_RENDER_LIMIT
      ? { start: 0, end: messages.length, top: 0, bottom: 0 }
      : windowRange(messages.length, (index) => known.get(messages[index].id) ?? ESTIMATED_MESSAGE_HEIGHT, Math.max(0, -localOffset), viewport.clientHeight);
    const prior = rangeRef.current;
    if (prior.start !== next.start || prior.end !== next.end || prior.top !== next.top || prior.bottom !== next.bottom) {
      rangeRef.current = next;
      setRange(next);
    }
  }, [messages, viewportRef]);

  useEffect(() => {
    const ids = new Set(messages.map((message) => message.id));
    for (const id of heightsRef.current.keys()) if (!ids.has(id)) heightsRef.current.delete(id);
    const viewport = viewportRef.current;
    if (!viewport) return;
    let frame = 0;
    const schedule = () => { if (!frame) frame = window.setTimeout(() => { frame = 0; update(); }, 16); };
    viewport.addEventListener("scroll", schedule, { passive: true });
    const resize = new ResizeObserver(schedule);
    resize.observe(viewport);
    update();
    return () => { viewport.removeEventListener("scroll", schedule); resize.disconnect(); clearTimeout(frame); };
  }, [messages, update, viewportRef]);

  useLayoutEffect(() => {
    if (messages.length <= FULL_RENDER_LIMIT) return;
    const list = listRef.current;
    if (!list) return;
    const resize = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const id = entry.target.dataset.windowId;
        const height = Math.ceil(entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height);
        if (height && heightsRef.current.get(id) !== height) { heightsRef.current.set(id, height); changed = true; }
      }
      if (changed) update();
    });
    for (const row of list.querySelectorAll("[data-window-id]")) resize.observe(row);
    return () => resize.disconnect();
  }, [messages, range.start, range.end, update]);

  return <div ref={listRef} role="list" aria-label="Conversation history">
    {range.top > 0 && <div aria-hidden="true" style={{ height: range.top }} />}
    {messages.slice(range.start, range.end).map((message, offset) => <div key={message.id} data-window-id={message.id} role="listitem" aria-posinset={range.start + offset + 1} aria-setsize={messages.length} style={{ display: "flow-root" }}>{renderMessage(message)}</div>)}
    {range.bottom > 0 && <div aria-hidden="true" style={{ height: range.bottom }} />}
  </div>;
}
