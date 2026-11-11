// Stands in for pdfjs-dist in the PdfPreview browser fixture and records
// what the viewer asks of each document and page. The viewer hands it the
// bytes it downloaded; the fixture server answers each PDF address with the
// address itself, so a document knows which one it is. Like pdf.js, a
// document answers each page number with one promise, kept for as long as
// the document is open, failures included, and its pages are its own.
// Page 2's first drawing fails, page 3 arrives only after page 4 is asked
// for, page 4 has endless text, page 5 cannot be read the first time
// /doc.pdf is opened and its first text read fails. Each /broken*.pdf cannot
// be opened the first time. While control.holdDrawing is set, a drawing runs
// until it is cancelled; while control.holdText is set, text never arrives.
// `events` logs, in order, every cancel, page release and document, port
// and worker ending, each tagged with its document's number.
export const documents = [];
export const ports = [];
export const events = [];
export const control = { holdDrawing: false, holdText: false };
const WORDS = ["", "one", "two", "three", "four", "five"];

class FakePage {
  constructor(record, number) {
    Object.assign(this, { record, number, renders: 0, cancelledRenders: 0, settledRenders: 0, cleanups: [], textReads: 0, textCancelled: false });
  }

  log(what) { events.push(`${this.record.id} ${what} p${this.number}`); }

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
        this.log("render-cancel");
        reject(Object.assign(new Error("Rendering cancelled"), { name: "RenderingCancelledException" }));
      };
    });
    promise.catch(() => {});
    return { promise, cancel };
  }

  streamTextContent() {
    this.textReads += 1;
    const read = this.textReads;
    let sent = false;
    return new ReadableStream({
      pull: (controller) => {
        if (control.holdText) return new Promise(() => {});
        if (this.number === 4) controller.enqueue({ items: Array.from({ length: 100 }, () => ({ str: "endless text " })) });
        else if (this.number === 5 && read === 1) controller.error(new Error("broken text"));
        else if (sent) controller.close();
        else { sent = true; controller.enqueue({ items: [{ str: `Page ${WORDS[this.number]}` }, { str: "  text " }] }); }
        return undefined;
      },
      cancel: () => { this.textCancelled = true; this.log("text-cancel"); },
    }, { highWaterMark: 0 });
  }

  // Records how many drawings were still running when cleanup was asked.
  cleanup() {
    this.cleanups.push(this.renders - this.settledRenders);
    this.log("cleanup");
    return true;
  }
}

export class PDFWorker {
  constructor({ port }) { Object.assign(this, { port, destroyed: false }); ports.push(this); }
  destroy() {
    this.destroyed = true;
    const record = documents.find((each) => each.port === this);
    events.push(`${record?.id} port-destroy`);
  }
}

export function getDocument({ data, url: address, worker }) {
  const url = data ? new TextDecoder().decode(data) : address;
  const record = { id: documents.length + 1, url, destroyed: false, port: worker, pages: {} };
  documents.push(record);
  const opened = documents.filter((each) => each.url === url).length;
  const promises = new Map();
  let releasePage3;
  const page3Released = new Promise((resolve) => { releasePage3 = resolve; });
  const pdf = {
    numPages: 5,
    getPage(number) {
      if (record.destroyed) events.push(`${record.id} getPage-after-destroy`);
      if (!promises.has(number)) {
        record.pages[number] ??= new FakePage(record, number);
        if (number === 4) releasePage3();
        const ready = number === 3 ? page3Released : Promise.resolve();
        promises.set(number, ready.then(() => new Promise((resolve, reject) => setTimeout(() => {
          if (number === 5 && opened === 1 && url === "/doc.pdf") reject(new Error("bad page object")); else resolve(record.pages[number]);
        }, 5))));
      }
      return promises.get(number);
    },
  };
  const promise = url.startsWith("/broken") && opened === 1 ? Promise.reject(new Error("Invalid PDF structure")) : Promise.resolve(pdf);
  return { promise, destroy: async () => { record.destroyed = true; events.push(`${record.id} destroy`); } };
}
