// Reads one page's text from pdf.js's text stream (PDFPageProxy
// streamTextContent), with whitespace collapsed to single spaces and the
// ends trimmed, up to max characters. Reading stops, and the stream is
// cancelled so pdf.js's worker stops extracting, once max is reached or
// signal aborts, so a page with a huge amount of text costs no more than
// its first max characters. Items are joined by a space, as pdf.js's own
// text layer would read them.
export const PAGE_TEXT_LIMIT = 100_000;

export async function readPageText(stream, { max = PAGE_TEXT_LIMIT, signal } = {}) {
  const reader = stream.getReader();
  const stop = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", stop, { once: true });
  let text = "";
  try {
    while (!signal?.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const item of value?.items ?? []) {
        const str = typeof item?.str === "string" ? item.str : "";
        const words = /\S+/g;
        for (let word = words.exec(str); word; word = words.exec(str)) {
          text += text ? ` ${word[0]}` : word[0];
          if (text.length >= max) return text.slice(0, max);
        }
      }
    }
    return text;
  } finally {
    signal?.removeEventListener("abort", stop);
    stop();
  }
}
