// Stands in for pdfjs-dist in the PdfPreview browser fixture and records
// what the viewer asks of each page. Page 2 fails to draw, page 3 arrives
// only after page 4 is asked for, and page 4 has endless text.
export const pages = {};
export const documents = [];
const WORDS = ["", "one", "two", "three"];

class FakePage {
  constructor(number) {
    Object.assign(this, { number, renders: 0, cancelledRenders: 0, settledRenders: 0, cleanups: [], textReads: 0, textCancelled: false });
  }

  getViewport({ scale }) { return { width: 600 * scale, height: 800 * scale, scale }; }

  render() {
    this.renders += 1;
    let cancel;
    let settled = false;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { settled = true; this.settledRenders += 1; if (this.number === 2) reject(new Error("broken drawing")); else resolve(); }, 30);
      // Like pdf.js, cancelling a finished drawing does nothing.
      cancel = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.cancelledRenders += 1;
        this.settledRenders += 1;
        reject(Object.assign(new Error("Rendering cancelled"), { name: "RenderingCancelledException" }));
      };
    });
    promise.catch(() => {});
    return { promise, cancel };
  }

  streamTextContent() {
    this.textReads += 1;
    const page = this;
    let sent = false;
    return new ReadableStream({
      pull(controller) {
        if (page.number === 4) controller.enqueue({ items: Array.from({ length: 100 }, () => ({ str: "endless text " })) });
        else if (sent) controller.close();
        else { sent = true; controller.enqueue({ items: [{ str: `Page ${WORDS[page.number]}` }, { str: "  text " }] }); }
      },
      cancel() { page.textCancelled = true; },
    }, { highWaterMark: 0 });
  }

  // Records how many drawings were still running when cleanup was asked.
  cleanup() {
    this.cleanups.push(this.renders - this.settledRenders);
    return true;
  }
}

export class PDFWorker {
  constructor({ port }) { this.port = port; }
  destroy() { this.destroyed = true; }
}

let releasePage3;
const page3Released = new Promise((resolve) => { releasePage3 = resolve; });

export function getDocument({ url }) {
  const record = { url, destroyed: false };
  documents.push(record);
  const pdf = {
    numPages: 4,
    getPage(number) {
      pages[number] ??= new FakePage(number);
      if (number === 4) releasePage3();
      const ready = number === 3 ? page3Released : Promise.resolve();
      return ready.then(() => new Promise((resolve) => setTimeout(() => resolve(pages[number]), 5)));
    },
  };
  return { promise: Promise.resolve(pdf), destroy: async () => { record.destroyed = true; } };
}
