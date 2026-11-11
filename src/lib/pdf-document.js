// The viewer downloads a PDF itself and hands pdf.js the bytes, so closing
// a document stops its download at once, with no wait on a worker that may
// no longer answer. A download without progress, or a document that does
// not open, within LOAD_STALL_MS fails, and the viewer offers Retry.
export const LOAD_STALL_MS = 30_000;

// pdf.js options for every document. Nothing in it runs, and no embedded
// image is decoded past maxImageSize pixels (pdf.js leaves it out of the
// drawing; the page's text is still offered) or kept larger than
// canvasMaxAreaInBytes, whatever the page canvas's own budget.
export const PDF_DOCUMENT_OPTIONS = Object.freeze({ isEvalSupported: false, enableXfa: false, maxImageSize: 2 ** 24, canvasMaxAreaInBytes: 2 ** 24 });

export function withDeadline(promise, ms, message) {
  let timer;
  const late = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

// The bytes at url. However it ends, its request is aborted.
export async function fetchPdf(url, { signal, stallMs = LOAD_STALL_MS, fetchImpl = globalThis.fetch } = {}) {
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
