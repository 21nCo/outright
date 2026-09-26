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
