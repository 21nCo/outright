import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { retryingImport, probeScript } from "../src/lib/module-retry.js";
import { fetchPdf, PDF_DOCUMENT_OPTIONS, withDeadline } from "../src/lib/pdf-document.js";
import { pdfWorkerStarter } from "../src/lib/pdf-worker.js";
import { pdfFile } from "../tests/fixtures/pdf-preview/make-pdf.mjs";

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

test("an import that never settles fails at its deadline and at once offers the reload, as the browser keeps waiting on it, and a retry that imports again", async () => {
  let calls = 0;
  const load = retryingImport(() => { calls += 1; return calls < 2 ? new Promise(() => {}) : Promise.resolve(pdfjs); }, { origin, exports: ["getDocument", "PDFWorker"], timeoutMs: 30, probe: () => assert.fail("nothing to ask about") });
  const first = await settled(load());
  assert.ok(first instanceof Error, `first attempt ${first}`);
  assert.match(first.message, /did not load in time/);
  assert.equal(first.reloadRequired, true, "the first stall already offers the reload");
  assert.equal(first.retryable, true, "the user can still try again");
  assert.equal(await load(), pdfjs);
  assert.equal(calls, 2, "the retry imports again rather than waiting on the stalled attempt");
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
  next.cancel();
  assert.equal((await next.ready.catch((caught) => caught)).name, "AbortError");
  assert.ok(next.worker.terminated, "no worker start is left waiting on its deadline");
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

test("real pdf.js, given the viewer's document options, leaves out an embedded image too large to decode", { timeout: 60_000 }, async () => {
  const { getDocument, OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const images = async (options) => {
    const task = getDocument({ data: pdfFile({ image: { width: 6000, height: 3000 } }), ...options, verbosity: 0 });
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
  assert.equal(PDF_DOCUMENT_OPTIONS.verbosity, 1, "warnings stay on: the viewer's worker reports a left-out image through them");
});

test("the viewer's worker tells it of each image real pdf.js leaves out as too large, and of nothing else", { timeout: 60_000 }, async () => {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const posted = [];
  const warn = console.warn;
  globalThis.self = { postMessage: (message) => posted.push(message) };
  console.warn = () => {};
  try {
    // In Node, pdf.js runs its worker code in this thread, so its warnings pass through the hook.
    await import("../src/lib/pdf-worker-warnings.js");
    for (const [image, expected] of [[undefined, 0], [{ width: 6000, height: 3000 }, 1], [{ width: 800, height: 600 }, 1]]) {
      const task = getDocument({ data: pdfFile({ text: "Hello", image }), ...PDF_DOCUMENT_OPTIONS });
      try { await (await (await task.promise).getPage(1)).getOperatorList(); } finally { await task.destroy(); }
      assert.equal(posted.length, expected, JSON.stringify(image));
    }
    assert.deepEqual(posted, [{ action: "imageRefused" }]);
  } finally {
    console.warn = warn;
    delete globalThis.self;
  }
});
