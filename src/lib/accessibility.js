export function nextTabIndex(currentIndex, count, key) {
  if (count <= 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowRight" || key === "ArrowDown") return (currentIndex + 1 + count) % count;
  if (key === "ArrowLeft" || key === "ArrowUp") return (currentIndex - 1 + count) % count;
  return currentIndex;
}

export function domId(prefix, value) {
  return `${prefix}-${String(value).replace(/[^A-Za-z0-9_-]/g, "-")}`;
}
