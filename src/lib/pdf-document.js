// The viewer downloads each PDF itself, so closing it stops the download at
// once. A download, document or page with no progress for stallMs fails.
export const PDF_DEADLINES = { stallMs: 30_000 };
// Nothing in a document runs; no image over maxImageSize pixels is decoded.
export const PDF_DOCUMENT_OPTIONS = Object.freeze({ isEvalSupported: false, enableXfa: false, maxImageSize: 2 ** 24, canvasMaxAreaInBytes: 2 ** 24 });

export function withDeadline(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((resolve, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(message), { name: "TimeoutError" })), ms); })]).finally(() => clearTimeout(timer));
}

// The bytes at url. However it ends, its request is aborted.
export async function fetchPdf(url, { signal, stallMs = PDF_DEADLINES.stallMs, fetchImpl = globalThis.fetch } = {}) {
  const request = new AbortController();
  const stop = () => request.abort();
  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) stop();
  let stalled = false;
  let timer;
  const progress = () => { clearTimeout(timer); timer = setTimeout(() => { stalled = true; stop(); }, stallMs); };
  try {
    progress();
    const response = await fetchImpl(url, { credentials: "same-origin", signal: request.signal });
    if (!response.ok) throw new Error(`The PDF could not be downloaded (HTTP ${response.status})`);
    const chunks = [];
    const reader = response.body.getReader();
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) { progress(); chunks.push(chunk.value); }
    return new Uint8Array(await new Blob(chunks).arrayBuffer());
  } catch (error) {
    throw stalled ? new Error("The PDF stopped downloading") : error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
    stop();
  }
}
