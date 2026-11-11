// Stands in for pdfjs-dist in the PdfPreview browser fixture and records
// what the viewer asks of each page. Like pdf.js, a document answers each
// page number with one promise, kept for as long as the document is open,
// failures included. Page 2's first drawing fails, page 3 arrives only after
// page 4 is asked for, page 4 has endless text, page 5 cannot be read the
// first time /doc.pdf is opened and its first text read fails. /broken.pdf
// cannot be opened the first time. While control.holdDrawing is set, a drawing runs until
// it is cancelled.
export const pages = {};
export const documents = [];
export const ports = [];
export const control = { holdDrawing: false };
const WORDS = ["", "one", "two", "three", "four", "five"];

class FakePage {
  constructor(number) {
    Object.assign(this, { number, renders: 0, cancelledRenders: 0, settledRenders: 0, cleanups: [], textReads: 0, textCancelled: false });
  }

  getViewport({ scale }) { return { width: 600 * scale, height: 800 * scale, scale }; }

  render() {
    this.renders += 1;
    const attempt = this.renders;
    let cancel;
    let settled = false;
    const promise = new Promise((resolve, reject) => {
      const finish = () => { settled = true; this.settledRenders += 1; if (this.number === 2 && attempt === 1) reject(new Error("broken drawing")); else resolve(); };
      const timer = control.holdDrawing ? null : setTimeout(finish, 30);
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
    const read = this.textReads;
    let sent = false;
    return new ReadableStream({
      pull(controller) {
        if (page.number === 4) controller.enqueue({ items: Array.from({ length: 100 }, () => ({ str: "endless text " })) });
        else if (page.number === 5 && read === 1) controller.error(new Error("broken text"));
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
  constructor({ port }) { Object.assign(this, { port, destroyed: false }); ports.push(this); }
  destroy() { this.destroyed = true; }
}

let releasePage3;
const page3Released = new Promise((resolve) => { releasePage3 = resolve; });

export function getDocument({ url, worker }) {
  const record = { url, destroyed: false, port: worker };
  documents.push(record);
  const opened = documents.filter((each) => each.url === url).length;
  const promises = new Map();
  const pdf = {
    numPages: 5,
    getPage(number) {
      if (!promises.has(number)) {
        pages[number] ??= new FakePage(number);
        if (number === 4) releasePage3();
        const ready = number === 3 ? page3Released : Promise.resolve();
        promises.set(number, ready.then(() => new Promise((resolve, reject) => setTimeout(() => {
          if (number === 5 && opened === 1) reject(new Error("bad page object")); else resolve(pages[number]);
        }, 5))));
      }
      return promises.get(number);
    },
  };
  const promise = url === "/broken.pdf" && opened === 1 ? Promise.reject(new Error("Invalid PDF structure")) : Promise.resolve(pdf);
  return { promise, destroy: async () => { record.destroyed = true; } };
}
