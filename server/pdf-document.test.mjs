import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { retryingImport, probeScript } from "../src/lib/module-retry.js";
import { fetchPdf, PDF_DOCUMENT_OPTIONS, withDeadline } from "../src/lib/pdf-document.js";
import { pdfWorkerStarter } from "../src/lib/pdf-worker.js";

const origin = "http://app.test";
const pdfjs = { getDocument() {}, PDFWorker() {} };
const settled = (promise, ms = 1000) => Promise.race([promise.then(() => "resolved", (error) => error), new Promise((resolve) => setTimeout(() => resolve("pending"), ms))]);

test("a first import that gives a module without the names asked for asks for a reload, since the browser keeps that module", async () => {
  let calls = 0;
  const load = retryingImport(() => { calls += 1; return Promise.resolve({ somethingElse() {} }); }, { origin, exports: ["getDocument", "PDFWorker"], probe: () => assert.fail("nothing to ask about") });
  const error = await load().catch((caught) => caught);
  assert.equal(error.reloadRequired, true);
  assert.match(error.message, /no getDocument, PDFWorker/);
});

test("an import that never settles fails at its deadline, lets the next attempt import again, and asks for a reload when it stalls again", async () => {
  let calls = 0;
  const load = retryingImport(() => { calls += 1; return calls < 3 ? new Promise(() => {}) : Promise.resolve(pdfjs); }, { origin, exports: ["getDocument", "PDFWorker"], timeoutMs: 30, probe: () => assert.fail("nothing to ask about") });
  const first = await settled(load());
  assert.ok(first instanceof Error, `first attempt ${first}`);
  assert.match(first.message, /did not load in time/);
  assert.equal(first.reloadRequired, undefined, "one stall is retried in place");
  const second = await settled(load());
  assert.equal(second.reloadRequired, true);
  assert.equal(second.retryable, true, "the user can still try again");
  assert.equal(await load(), pdfjs);
  assert.equal(calls, 3, "each attempt imports again rather than waiting on the stalled one");
});

test("a pdf.js worker start cancelled while its failed script is probed stops the probe and counts no failure", async () => {
  const workers = [];
  const createWorker = (url) => {
    const listeners = new Map();
    const worker = { url, terminated: false, addEventListener: (type, listener) => listeners.set(`${type}`, listener), removeEventListener: (type) => listeners.delete(type), terminate() { worker.terminated = true; }, emit: (type, event) => listeners.get(type)?.(event) };
    workers.push(worker);
    return worker;
  };
  const probes = [];
  const probe = (href, { signal }) => new Promise((resolve) => { probes.push(signal); signal.addEventListener("abort", () => resolve("unreachable")); });
  const start = pdfWorkerStarter({ createWorker, base: () => `${origin}/`, probe });
  const failing = start("/assets/pdf.worker.mjs");
  failing.worker.emit("error", { message: "boom" });
  assert.equal(probes.length, 1);
  failing.cancel();
  assert.ok(probes[0].aborted, "the probe is stopped");
  const error = await failing.ready.catch((caught) => caught);
  assert.equal(error.name, "AbortError");
  const next = start("/assets/pdf.worker.mjs");
  assert.equal(new URL(next.worker.url).search, "", "the next start asks for the script as usual");
});

test("a probe stops when its caller's signal aborts", async () => {
  const caller = new AbortController();
  const asked = probeScript(`${origin}/x.js`, { signal: caller.signal, fetchImpl: (href, init) => new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))) });
  caller.abort();
  assert.equal(await asked, "unreachable");
});

test("a deadline rejects a promise that does not settle in time and leaves one that does alone", async () => {
  await assert.rejects(withDeadline(new Promise(() => {}), 20, "too late"), { name: "TimeoutError", message: "too late" });
  assert.equal(await withDeadline(Promise.resolve(7), 1000, "too late"), 7);
});

// A server whose /held.pdf sends part of a PDF and then nothing more.
async function pdfServer(t) {
  const requests = [];
  const server = createServer((request, response) => {
    const record = { url: request.url, closed: false };
    requests.push(record);
    response.on("close", () => { record.closed = true; });
    if (request.url === "/doc.pdf") { response.end(Buffer.from("%PDF-1.7 whole")); return; }
    if (request.url === "/held.pdf") { response.writeHead(200, { "Content-Type": "application/pdf" }); response.write("%PDF-1.7 "); return; }
    response.statusCode = 404;
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const address = (pathname) => `http://127.0.0.1:${server.address().port}${pathname}`;
  const closed = async (pathname) => {
    const end = Date.now() + 2000;
    while (!requests.find((record) => record.url === pathname)?.closed && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
    return Boolean(requests.find((record) => record.url === pathname)?.closed);
  };
  return { address, requests, closed };
}

test("a PDF download returns its bytes, fails on an error response, and is cut off by the server-visible connection when it stalls or is abandoned", async (t) => {
  const { address, requests, closed } = await pdfServer(t);
  assert.equal(Buffer.from(await fetchPdf(address("/doc.pdf"))).toString(), "%PDF-1.7 whole");
  await assert.rejects(fetchPdf(address("/missing.pdf")), /could not be downloaded \(HTTP 404\)/);
  // No progress for stallMs fails the download and closes its connection.
  await assert.rejects(fetchPdf(address("/held.pdf"), { stallMs: 100 }), /stopped downloading/);
  assert.ok(await closed("/held.pdf"), "the stalled request was closed");
  // Closing the document aborts its download and closes the connection.
  const abandon = new AbortController();
  const download = fetchPdf(address("/held.pdf"), { signal: abandon.signal });
  while (requests.filter((record) => record.url === "/held.pdf").length < 2) await new Promise((resolve) => setTimeout(resolve, 10));
  abandon.abort();
  await assert.rejects(download, { name: "AbortError" });
  const end = Date.now() + 2000;
  while (!requests.at(-1).closed && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(requests.at(-1).closed, "the abandoned request was closed");
});

// A one-page PDF painting a Flate-compressed 6000x3000 1-bit image: a few
// kilobytes on disk, 18 million pixels decoded.
function pdfWithImage(width, height) {
  const image = deflateSync(Buffer.alloc((width / 8) * height));
  const content = "q 300 0 0 200 0 0 cm /Im0 Do Q";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>",
    [`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /FlateDecode /Length ${image.length} >>\nstream\n`, image, "\nendstream"],
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  const parts = [Buffer.from("%PDF-1.7\n")];
  const offsets = [];
  let size = parts[0].length;
  objects.forEach((body, index) => {
    offsets.push(size);
    const part = Buffer.concat([`${index + 1} 0 obj\n`, ...[body].flat(), "\nendobj\n"].map((piece) => Buffer.from(piece)));
    parts.push(part);
    size += part.length;
  });
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`;
  return new Uint8Array(Buffer.concat([...parts, Buffer.from(xref)]));
}

test("real pdf.js, given the viewer's document options, leaves out an embedded image too large to decode", { timeout: 60_000 }, async () => {
  const { getDocument, OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const images = async (options) => {
    const task = getDocument({ data: pdfWithImage(6000, 3000), verbosity: 0, ...options });
    try {
      const page = await (await task.promise).getPage(1);
      return (await page.getOperatorList()).fnArray.filter((op) => op === OPS.paintImageXObject).length;
    } finally { await task.destroy(); }
  };
  assert.equal(await images({}), 1, "without limits pdf.js decodes the whole image");
  assert.equal(await images(PDF_DOCUMENT_OPTIONS), 0);
  assert.ok(PDF_DOCUMENT_OPTIONS.maxImageSize > 0 && PDF_DOCUMENT_OPTIONS.maxImageSize < 6000 * 3000);
  assert.ok(PDF_DOCUMENT_OPTIONS.canvasMaxAreaInBytes > 0);
  assert.equal(PDF_DOCUMENT_OPTIONS.isEvalSupported, false);
});
