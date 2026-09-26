import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { windowRange } from "@/lib/windowing";

export const ESTIMATED_MESSAGE_HEIGHT = 110;
const FULL_RENDER_LIMIT = 80;

export function WindowedMessages({ messages, viewportRef, renderMessage, onFind, onCancelFind }) {
  const listRef = useRef(null);
  const heightsRef = useRef(new Map());
  const rangeRef = useRef({ start: 0, end: Math.min(messages.length, FULL_RENDER_LIMIT), top: 0, bottom: 0 });
  const [range, setRange] = useState(rangeRef.current);
  const [needle, setNeedle] = useState("");
  const [foundIndex, setFoundIndex] = useState(-1);
  const [foundId, setFoundId] = useState(null);
  const [findRequest, setFindRequest] = useState(0);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const searchGenerationRef = useRef(0);
  const pendingFoundRef = useRef(null);

  async function find(direction = 1) {
    const query = needle.trim();
    if (!query || !messages.length) return;
    if (onFind) {
      const generation = ++searchGenerationRef.current;
      setSearching(true);
      try {
        const id = await onFind(query, direction, foundId);
        if (generation !== searchGenerationRef.current) return;
        setSearchError(false);
        setFoundId(id);
        pendingFoundRef.current = id;
        if (id) setFindRequest((current) => current + 1);
        setSearched(true);
        setFoundIndex(messages.findIndex((message) => message.id === id));
      } catch {
        if (generation === searchGenerationRef.current) setSearchError(true);
      } finally { if (generation === searchGenerationRef.current) setSearching(false); }
      return;
    }
    let index = foundIndex;
    for (let checked = 0; checked < messages.length; checked += 1) {
      index = (index + direction + messages.length) % messages.length;
      if (!String(messages[index].body ?? "").toLocaleLowerCase().includes(query.toLocaleLowerCase())) continue;
      setFoundIndex(index);
      setFoundId(messages[index].id);
      setSearched(true);
      const viewport = viewportRef.current;
      const list = listRef.current;
      if (viewport && list) {
        let offset = viewport.scrollTop + list.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
        for (let row = 0; row < index; row += 1) offset += heightsRef.current.get(messages[row].id) ?? ESTIMATED_MESSAGE_HEIGHT;
        viewport.scrollTop = Math.max(0, offset - viewport.clientHeight / 3);
        update();
      }
      return;
    }
    setFoundIndex(-1);
    setFoundId(null);
    setSearched(true);
  }

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

  useLayoutEffect(() => {
    if (!foundId) return;
    const index = messages.findIndex((message) => message.id === foundId);
    if (index < 0) return;
    setFoundIndex(index);
    if (pendingFoundRef.current !== foundId) return;
    const viewport = viewportRef.current;
    const list = listRef.current;
    if (!viewport || !list) return;
    let offset = viewport.scrollTop + list.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
    for (let row = 0; row < index; row += 1) offset += heightsRef.current.get(messages[row].id) ?? ESTIMATED_MESSAGE_HEIGHT;
    viewport.scrollTop = Math.max(0, offset - viewport.clientHeight / 3);
    pendingFoundRef.current = null;
    update();
  }, [foundId, findRequest, messages, viewportRef, update]);

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

  return <><div className="history-find" role="search" aria-label="Find in conversation"><input aria-label="Find in conversation" maxLength={200} value={needle} onChange={(event) => { ++searchGenerationRef.current; pendingFoundRef.current = null; onCancelFind?.(); setNeedle(event.target.value); setFoundIndex(-1); setFoundId(null); setSearching(false); setSearched(false); setSearchError(false); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); find(event.shiftKey ? -1 : 1); } }} /><button type="button" onClick={() => find(-1)} disabled={!needle || searching} aria-label="Previous conversation match">↑</button><button type="button" onClick={() => find(1)} disabled={!needle || searching} aria-label="Next conversation match">↓</button><span role="status">{searching ? "Searching…" : searchError ? "Search failed; retry" : needle && foundIndex >= 0 ? `Message ${foundIndex + 1} of ${messages.length}` : needle && searched ? "No match" : needle ? "Press Enter to find" : ""}</span></div><div ref={listRef} role="list" aria-label="Conversation history">
    {range.top > 0 && <div aria-hidden="true" style={{ height: range.top }} />}
    {messages.slice(range.start, range.end).map((message, offset) => <div key={message.id} data-window-id={message.id} data-find-match={range.start + offset === foundIndex ? "true" : undefined} role="listitem" aria-posinset={range.start + offset + 1} aria-setsize={messages.length} style={{ display: "flow-root" }}>{renderMessage(message)}</div>)}
    {range.bottom > 0 && <div aria-hidden="true" style={{ height: range.bottom }} />}
  </div></>;
}
