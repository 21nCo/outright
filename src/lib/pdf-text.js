// Reads one page's text from pdf.js's text stream (PDFPageProxy
// streamTextContent), with whitespace collapsed to single spaces and the
// ends trimmed, up to max characters. Items are joined by a space, as
// pdf.js's own text layer would read them.
//
// The work is bounded as well as the result: reading stops once max
// characters are kept, maxInput characters of item text have been looked at
// (whitespace included, and no item's text is scanned past that), or
// maxItems items and chunks have been taken. Reading also stops when signal
// aborts. Stopping cancels the stream, so pdf.js's worker stops extracting,
// and a page with endless text, endless whitespace or endless empty items
// costs no more than that budget.
export const PAGE_TEXT_LIMIT = 100_000;

export async function readPageText(stream, { max = PAGE_TEXT_LIMIT, maxInput = 4 * max, maxItems = 4 * max, signal } = {}) {
  const reader = stream.getReader();
  const stop = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", stop, { once: true });
  let text = "";
  let input = 0;
  let items = 0;
  // Checked after every chunk and item, so a spent budget never waits on
  // another read.
  const spent = () => signal?.aborted || items >= maxItems || input >= maxInput;
  try {
    while (!spent()) {
      const { value, done } = await reader.read();
      if (done) break;
      items += 1;
      for (const item of value?.items ?? []) {
        if (spent()) return text;
        items += 1;
        const str = typeof item?.str === "string" ? item.str.slice(0, maxInput - input) : "";
        input += str.length;
        const words = /\S+/g;
        for (let word = words.exec(str); word; word = words.exec(str)) {
          text += (text ? " " : "") + word[0].slice(0, max - text.length);
          if (text.length >= max) return text.slice(0, max).trimEnd();
        }
      }
    }
    return text;
  } finally {
    signal?.removeEventListener("abort", stop);
    stop();
  }
}
