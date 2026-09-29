export function windowRange(length, sizeAt, offset, viewportSize, overscan = 600) {
  if (!length) return { start: 0, end: 0, top: 0, bottom: 0, total: 0 };
  const startEdge = Math.max(0, offset - overscan);
  const endEdge = offset + Math.max(1, viewportSize) + overscan;
  let position = 0;
  let start = 0;
  let end = length;
  let top = 0;
  let bottom = 0;
  for (let index = 0; index < length; index += 1) {
    const next = position + sizeAt(index);
    if (next < startEdge) { start = index + 1; top = next; }
    if (position <= endEdge) end = index + 1;
    position = next;
  }
  if (end < start) end = start;
  for (let index = end; index < length; index += 1) bottom += sizeAt(index);
  return { start, end, top, bottom, total: position };
}

// A hidden tab may pause animation frames and throttle timers while page or row
// measurements still change. A posted task keeps bounded alignment moving.
export function scheduleLayoutTick(callback) {
  let pending = true;
  let frame;
  let timer;
  let channel;
  const wakeWhenHidden = () => {
    if (!document.hidden || channel) return;
    channel = new MessageChannel();
    channel.port1.onmessage = run;
    channel.port2.postMessage(null);
  };
  const cancel = () => {
    pending = false;
    window.cancelAnimationFrame(frame);
    window.clearTimeout(timer);
    document.removeEventListener("visibilitychange", wakeWhenHidden);
    channel?.port1.close();
    channel?.port2.close();
  };
  const run = () => {
    if (!pending) return;
    cancel();
    callback();
  };
  frame = window.requestAnimationFrame(run);
  timer = window.setTimeout(run, 32);
  document.addEventListener("visibilitychange", wakeWhenHidden);
  wakeWhenHidden();
  return cancel;
}
