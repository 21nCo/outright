import assert from "node:assert/strict";
import test from "node:test";
import { failedModuleUrl, probeScript, retryingImport } from "../src/lib/module-retry.js";
import { pdfCanvasSize, settledWidth } from "../src/lib/pdf-canvas.js";
import { PAGE_TEXT_LIMIT, readPageText } from "../src/lib/pdf-text.js";
import { pdfWorkerStarter } from "../src/lib/pdf-worker.js";

const origin = "http://app.test";
const chunk = `${origin}/assets/pdf-abc.js`;
const vendor = `${origin}/assets/vendor-def.js`;
const fetchFailure = (url) => new TypeError(`Failed to fetch dynamically imported module: ${url}`);
const pdfjs = { getDocument() {}, PDFWorker() {} };
const options = (extra) => ({ origin, exports: ["getDocument", "PDFWorker"], ...extra });

test("a module whose import keeps failing on a reachable file asks for a reload instead of retrying the cached failure", async () => {
  // A file the chunk imports failed; the browser keeps that failure, so the
  // retried chunk fails again although the server has it (Chrome names the
  // chunk it was asked for).
  const imported = [];
  const load = retryingImport(() => Promise.reject(fetchFailure(chunk)), options({
    importUrl: (href) => { imported.push(href); return Promise.reject(fetchFailure(href)); },
    probe: async () => "present",
  }));
  const first = await load().catch((error) => error);
  assert.equal(first.reloadRequired, undefined, "the first failure is retried in place");
  const second = await load().catch((error) => error);
  assert.equal(second.reloadRequired, true);
  assert.equal(imported.length, 1);
  assert.equal(new URL(imported[0]).pathname, "/assets/pdf-abc.js");
});

test("a retry that loads a dependency the error named, not the module, asks for a reload and never returns to the original failed import", async () => {
  let originals = 0;
  const imported = [];
  const load = retryingImport(() => { originals += 1; return Promise.reject(fetchFailure(vendor)); }, options({
    // The network is back: the dependency itself now loads, without pdf.js's names.
    importUrl: (href) => { imported.push(href); return Promise.resolve({ vendorHelper() {} }); },
    probe: async () => "present",
  }));
  await assert.rejects(load());
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const error = await load().catch((caught) => caught);
    assert.equal(error.reloadRequired, true);
    assert.match(error.message, /no getDocument, PDFWorker/);
  }
  assert.equal(originals, 1, "the cached failed import is not tried again");
  assert.ok(imported.every((href) => new URL(href).pathname === "/assets/vendor-def.js"));
});

test("a chunk the server no longer has asks for a reload at once", async () => {
  const probed = [];
  const load = retryingImport(() => Promise.reject(fetchFailure(chunk)), options({
    importUrl: () => assert.fail("a gone file is not retried"),
    probe: async (href) => { probed.push(href); return "gone"; },
  }));
  const error = await load().catch((caught) => caught);
  assert.equal(error.reloadRequired, true);
  assert.deepEqual(probed, [chunk]);
});

test("while the server cannot be reached a failure stays retryable, and the module loads once it can", async () => {
  let online = false;
  const imported = [];
  const load = retryingImport(() => Promise.reject(fetchFailure(chunk)), options({
    importUrl: (href) => { imported.push(href); return online ? Promise.resolve(pdfjs) : Promise.reject(fetchFailure(href)); },
    probe: async () => online ? "present" : "unreachable",
  }));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const error = await load().catch((caught) => caught);
    assert.equal(error.reloadRequired, undefined);
  }
  online = true;
  assert.equal(await load(), pdfjs);
  assert.equal(await load(), pdfjs, "a loaded module is kept");
  assert.equal(imported.length, 3);
  assert.equal(new Set(imported).size, 3, "each retry is a new address");
});

test("an error naming no same-origin address is retried with the original import", async () => {
  let calls = 0;
  const load = retryingImport(() => (calls += 1) === 1 ? Promise.reject(new TypeError("Importing a module script failed.")) : Promise.resolve(pdfjs), options({
    importUrl: () => assert.fail("no address to retry"),
    probe: () => assert.fail("nothing to ask about"),
  }));
  await assert.rejects(load());
  assert.equal(await load(), pdfjs);
  assert.equal(failedModuleUrl(fetchFailure("https://elsewhere.test/x.js"), origin), null);
});

test("an import that keeps failing without naming an address offers a reload, and can still be tried again", async () => {
  let calls = 0;
  let online = false;
  const load = retryingImport(() => { calls += 1; return online ? Promise.resolve(pdfjs) : Promise.reject(new TypeError("Importing a module script failed.")); }, options({
    importUrl: () => assert.fail("no address to retry"),
    probe: () => assert.fail("nothing to ask about"),
  }));
  const first = await load().catch((error) => error);
  assert.equal(first.reloadRequired, undefined, "one failure is retried in place");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const error = await load().catch((caught) => caught);
    assert.equal(error.reloadRequired, true);
    assert.equal(error.retryable, true);
  }
  assert.equal(calls, 3, "each attempt imports again");
  online = true;
  assert.equal(await load(), pdfjs);
});

test("probing a script tells a gone file from a present one and from an unreachable server", async () => {
  let cancelled = 0;
  const answer = (status, type) => async (href, init) => {
    assert.equal(init.cache, "no-store");
    return { status, ok: status >= 200 && status < 300, headers: new Headers(type ? { "content-type": type } : {}), body: { cancel: async () => { cancelled += 1; } } };
  };
  assert.equal(await probeScript(chunk, { fetchImpl: answer(404) }), "gone");
  assert.equal(await probeScript(chunk, { fetchImpl: answer(410) }), "gone");
  // A single-page server answers a missing chunk with its index page.
  assert.equal(await probeScript(chunk, { fetchImpl: answer(200, "text/html") }), "gone");
  assert.equal(await probeScript(chunk, { fetchImpl: answer(200, "text/javascript; charset=utf-8") }), "present");
  assert.equal(await probeScript(chunk, { fetchImpl: answer(503, "text/plain") }), "unreachable");
  assert.equal(await probeScript(chunk, { fetchImpl: () => Promise.reject(new TypeError("Failed to fetch")) }), "unreachable");
  // Node does not keep itself running for AbortSignal.timeout, so hold it open.
  const awake = setTimeout(() => {}, 5000);
  assert.equal(await probeScript(chunk, { timeoutMs: 20, fetchImpl: (href, init) => new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))) }), "unreachable");
  clearTimeout(awake);
  assert.equal(cancelled, 5, "no response body is kept open");
});

function fakeWorkers() {
  const workers = [];
  return {
    workers,
    createWorker(url) {
      const listeners = { message: new Set(), error: new Set() };
      const worker = {
        url,
        terminated: false,
        addEventListener: (type, listener) => listeners[type].add(listener),
        removeEventListener: (type, listener) => listeners[type].delete(listener),
        terminate() { worker.terminated = true; },
        emit: (type, event) => { for (const listener of [...listeners[type]]) listener(event); },
        listeners: () => listeners.message.size + listeners.error.size,
      };
      workers.push(worker);
      return worker;
    },
  };
}

test("a pdf.js worker whose script the server no longer has fails with reloadRequired; one that fails otherwise stays retryable", async () => {
  const fake = fakeWorkers();
  let state = "gone";
  const probed = [];
  const start = pdfWorkerStarter({ createWorker: fake.createWorker, base: () => `${origin}/`, probe: async (href) => { probed.push(href); return state; } });
  const gone = start("/assets/pdf.worker-abc.mjs");
  gone.worker.emit("error", {});
  const goneError = await gone.ready.catch((error) => error);
  assert.equal(goneError.reloadRequired, true);
  assert.ok(gone.worker.terminated);
  assert.equal(gone.worker.listeners(), 0);
  state = "present";
  const failing = start("/assets/pdf.worker-abc.mjs");
  failing.worker.emit("error", { message: "SyntaxError" });
  const failingError = await failing.ready.catch((error) => error);
  assert.equal(failingError.reloadRequired, false);
  assert.match(failingError.message, /did not start: SyntaxError/);
  assert.equal(new URL(probed[1]).searchParams.get("retry"), "1", "the retry asks for the script afresh");
  const working = start("/assets/pdf.worker-abc.mjs");
  working.worker.emit("message", { data: { sourceName: "worker", action: "ready" } });
  await working.ready;
  assert.equal(working.worker.terminated, false);
  assert.equal(probed.length, 2, "a worker that starts is never probed");
});

test("a silent pdf.js worker is ended at its startup deadline and its failure settles every timer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fake = fakeWorkers();
  const start = pdfWorkerStarter({ createWorker: fake.createWorker, base: () => `${origin}/`, startupMs: 1000, probe: async () => "present" });
  const silent = start("/assets/pdf.worker.mjs");
  t.mock.timers.tick(999);
  assert.equal(silent.worker.terminated, false);
  t.mock.timers.tick(1);
  const error = await silent.ready.catch((caught) => caught);
  assert.match(error.message, /did not start in time/);
  assert.ok(silent.worker.terminated);
  assert.equal(silent.worker.listeners(), 0);
});

test("a pdf.js worker start abandoned before it is ready ends quietly: no probe, no failure counted, no timer left", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fake = fakeWorkers();
  const probed = [];
  const start = pdfWorkerStarter({ createWorker: fake.createWorker, base: () => `${origin}/`, startupMs: 1000, probe: async (href) => { probed.push(href); return "present"; } });
  const abandoned = start("/assets/pdf.worker.mjs");
  abandoned.cancel();
  const error = await abandoned.ready.catch((caught) => caught);
  assert.equal(error.name, "AbortError");
  assert.ok(abandoned.worker.terminated);
  assert.equal(abandoned.worker.listeners(), 0);
  t.mock.timers.tick(5000);
  abandoned.worker.emit("error", {});
  assert.deepEqual(probed, []);
  const next = start("/assets/pdf.worker.mjs");
  assert.equal(new URL(next.worker.url).search, "", "the next start asks for the script as usual");
  next.worker.emit("message", { data: { sourceName: "worker", action: "ready" } });
  await next.ready;
  next.cancel();
  assert.equal(next.worker.terminated, false, "cancelling a started worker leaves it to its document");
});

// The pre-change normalisation, which copied the whole page's text first.
const wholePageText = (items) => items.map((item) => item.str ?? "").join(" ").replace(/\s+/g, " ").trim();
function textStream(chunks, counters = {}) {
  let index = 0;
  counters.pulls = 0;
  counters.cancelled = false;
  return new ReadableStream({
    pull(controller) {
      counters.pulls += 1;
      const next = typeof chunks === "function" ? chunks(index) : chunks[index];
      index += 1;
      if (next) controller.enqueue({ items: next }); else controller.close();
    },
    cancel() { counters.cancelled = true; },
  }, { highWaterMark: 0 });
}

test("page text reads like the whole-page normalisation, across chunks and odd whitespace", async () => {
  const chunks = [
    [{ str: "  Hello  " }, { str: "world" }, { str: "" }, { hasEOL: true }],
    [{ str: "\t\n" }, { str: "line\ntwo " }, { str: 42 }, { str: "end." }],
  ];
  assert.equal(await readPageText(textStream(chunks)), wholePageText(chunks.flat().map((item) => ({ str: typeof item.str === "string" ? item.str : "" }))));
  assert.equal(await readPageText(textStream([])), "");
  const small = [[{ str: "abc def" }, { str: "ghi" }]];
  for (let max = 1; max <= 11; max += 1) assert.equal(await readPageText(textStream(small), { max }), wholePageText(small[0]).slice(0, max), `max ${max}`);
});

test("a page with endless text is read only up to the limit, and pdf.js's stream is cancelled", async () => {
  const counters = {};
  const words = Array.from({ length: 100 }, () => ({ str: "word ".repeat(50) }));
  const text = await readPageText(textStream(() => words, counters));
  assert.equal(text.length, PAGE_TEXT_LIMIT);
  assert.ok(counters.cancelled);
  // 100 items of 250 characters each cover the limit in four chunks.
  assert.ok(counters.pulls <= 6, `pulled ${counters.pulls} chunks`);
});

test("page text stops at its input budget for endless whitespace, empty items and empty chunks, and cancels the stream", async () => {
  const spaces = {};
  // A million spaces in a thousand chunks: no text, but no more than the default budget is read.
  assert.equal(await readPageText(textStream((index) => index < 1000 ? [{ str: " ".repeat(1000) }] : null, spaces)), "");
  assert.ok(spaces.cancelled);
  assert.ok(spaces.pulls <= 4 * PAGE_TEXT_LIMIT / 1000 + 2, `pulled ${spaces.pulls} chunks`);
  const empty = {};
  assert.equal(await readPageText(textStream(() => Array.from({ length: 10 }, () => ({})), empty), { max: 10, maxItems: 50 }), "");
  assert.ok(empty.cancelled && empty.pulls <= 6, `pulled ${empty.pulls} chunks`);
  const none = {};
  assert.equal(await readPageText(textStream(() => [], none), { max: 10, maxItems: 50 }), "");
  assert.ok(none.cancelled && none.pulls <= 51, `pulled ${none.pulls} chunks`);
});

test("page text scans no item past the input budget and keeps no more of a huge word than fits", async () => {
  assert.equal(await readPageText(textStream([[{ str: `${" ".repeat(15)}abcdefghijklmnop` }]]), { max: 10, maxInput: 20 }), "abcde");
  assert.equal(await readPageText(textStream([[{ str: "a b" }, { str: "cdefghij" }]]), { max: 10, maxInput: 5 }), "a b cd");
  const huge = await readPageText(textStream([[{ str: "x".repeat(3_000_000) }]]));
  assert.equal(huge.length, PAGE_TEXT_LIMIT);
});

test("abandoning a page's text cancels pdf.js's stream", async () => {
  const counters = {};
  const controller = new AbortController();
  // pdf.js has not answered yet when the page is left.
  const stream = new ReadableStream({
    pull: () => new Promise(() => {}),
    cancel() { counters.cancelled = true; },
  }, { highWaterMark: 0 });
  const reading = readPageText(stream, { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  assert.equal(await reading, "");
  assert.ok(counters.cancelled);
});

test("a pane being dragged settles on one width; the first width is used at once", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const widths = [];
  const watcher = settledWidth((width) => widths.push(width), 150);
  watcher.update(0);
  watcher.update(600);
  assert.deepEqual(widths, [600]);
  for (let width = 601; width < 700; width += 1) { watcher.update(width); t.mock.timers.tick(16); }
  assert.deepEqual(widths, [600]);
  t.mock.timers.tick(150);
  assert.deepEqual(widths, [600, 699]);
  watcher.update(500);
  watcher.cancel();
  t.mock.timers.tick(1000);
  assert.deepEqual(widths, [600, 699], "a cancelled watcher reports nothing more");
});

test("a page canvas for a pane with no usable width is reported too large instead of sized NaN", () => {
  const page = { width: 612, height: 792 };
  for (const paneWidth of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) assert.deepEqual(pdfCanvasSize(page, paneWidth, 2), { tooLarge: true }, String(paneWidth));
  assert.equal(pdfCanvasSize(page, 600, 1).cssWidth, 598);
});
