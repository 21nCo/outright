import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { pdfFile } from "../tests/fixtures/pdf-preview/make-pdf.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = path.join(root, "tests", "fixtures", "pdf-preview");
// The worker script the fixture serves: it says it is ready, as pdf.js's own does.
const WORKER_PATH = "/assets/pdf.worker-abc123.mjs";

function chromeExecutable() {
  return [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"),
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe"),
  ].filter(Boolean).find((candidate) => existsSync(candidate));
}

// The real PdfPreview, with pdf.js replaced by tests/fixtures/pdf-preview/fake-pdfjs.js.
async function bundle() {
  const output = await build({
    entryPoints: [path.join(fixture, "fixture.jsx")],
    bundle: true,
    write: false,
    format: "iife",
    jsx: "automatic",
    logLevel: "silent",
    alias: { "@": path.join(root, "src") },
    define: { "import.meta.env.BASE_URL": JSON.stringify("/"), "process.env.NODE_ENV": JSON.stringify("development") },
    plugins: [{
      name: "fake-pdfjs",
      setup(builder) {
        builder.onResolve({ filter: /pdf-worker-entry\.js\?worker&url$/ }, () => ({ path: "worker-url", namespace: "fake" }));
        builder.onLoad({ filter: /^worker-url$/, namespace: "fake" }, () => ({ contents: `export default ${JSON.stringify(WORKER_PATH)};`, loader: "js" }));
        builder.onResolve({ filter: /^pdfjs-dist$/ }, () => ({ path: path.join(fixture, "fake-pdfjs.js") }));
      },
    }],
  });
  return output.outputFiles[0].text;
}

// Serves the fixture page. Its load event waits for /hold, which answers once
// the fixture posts its outcome to /done, so Chrome's --dump-dom run ends by
// itself when the fixture is finished, in real time (a virtual-time run
// delivers no ResizeObserver callbacks until its budget is spent). A POST to
// /retire-worker removes the worker script, as a deployment would. `serve`
// answers any other address it knows, first.
function fixtureServer(html, holdMs, serve = () => false) {
  let release;
  let retired = false;
  const heldPdfs = {};
  const done = new Promise((resolve) => { release = resolve; });
  const held = setTimeout(() => release(null), holdMs);
  const server = createServer((request, response) => {
    if (serve(request, response)) return;
    if (request.url === "/") { response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(html); return; }
    if (request.url === WORKER_PATH && !retired) { response.setHeader("Content-Type", "text/javascript"); response.end("postMessage({ sourceName: 'worker', action: 'ready' }); onmessage = ({ data }) => { if (data === 'crash') throw new Error('worker crashed'); if (data === 'refuse') postMessage({ action: 'imageRefused' }); };"); return; }
    // A PDF's bytes are its own address (see fake-pdfjs.js); /held.pdf sends a part and then nothing.
    if (request.url.startsWith("/held") && request.url.endsWith(".pdf")) { const held = { requested: true, closed: false }; heldPdfs[request.url] = held; response.on("close", () => { held.closed = true; }); response.writeHead(200, { "Content-Type": "application/pdf" }); response.write("%PDF"); return; }
    if (request.url === "/held-state") { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(heldPdfs)); return; }
    if (request.url.endsWith(".pdf")) { response.setHeader("Content-Type", "application/pdf"); response.end(request.url); return; }
    if (request.url === "/retire-worker" && request.method === "POST") { retired = true; response.end(); return; }
    if (request.url === "/hold") { void done.then(() => { response.statusCode = 204; response.end(); }); return; }
    if (request.url === "/done" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => { clearTimeout(held); response.end(); release(body); });
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  return { server, done };
}

function runChrome(executable, profile, url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chrome = spawn(executable, [
      "--headless=new", "--disable-gpu", "--disable-background-networking", "--disable-component-update", "--disable-dev-shm-usage",
      "--no-default-browser-check", "--no-first-run", `--user-data-dir=${profile}`, "--dump-dom", url,
    ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    chrome.stdout.on("data", (chunk) => { stdout += chunk; });
    chrome.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    const timer = setTimeout(() => chrome.kill("SIGKILL"), timeoutMs);
    chrome.once("error", (error) => { clearTimeout(timer); reject(error); });
    chrome.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

test("the PDF viewer reads each page once, stops a page's work before releasing it, retries only what failed, ends documents that fail and opens them again on Retry or refresh, hides a page until it arrives, redraws a dragged pane once and asks for a reload when its worker is gone", { timeout: 180_000 }, async (t) => {
  const executable = chromeExecutable();
  assert.ok(executable, "Chrome or Chromium is required to run the PDF viewer fixture");
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-pdf-preview-"));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const script = (await bundle()).replaceAll("</script", "<\\/script");
  const { server, done } = fixtureServer(`<!doctype html><meta charset="utf-8"><body><div id="host"></div><script>${script}</script><img src="/hold" alt=""></body>`, 140_000);
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const run = await runChrome(executable, path.join(directory, "profile"), `http://127.0.0.1:${server.address().port}/`, 150_000);
  const posted = await Promise.race([done, null]);
  assert.ok(posted, `the fixture did not finish: exit ${run.code ?? run.signal}; ${run.stderr}`);
  const outcome = JSON.parse(posted);
  assert.ok(outcome.ok, outcome.error);
  const { opened, dragged, failedDraw, retried, skipped, unreadable, reopened, refreshed, closed, broken, brokenRefreshed, brokenRetried, order, slow, progressing, late, refused, crashed, crashRetried, held, retired } = outcome.result;

  // Opening draws page 1 once and reads its text once.
  assert.equal(opened.renders, 1);
  assert.equal(opened.textReads, 1);
  // Thirty resize steps redraw once when the pane settles, at its final width, and never read the text again.
  assert.equal(dragged.renders, 2 + dragged.stalls, JSON.stringify(dragged));
  assert.equal(dragged.textReads, 1);
  assert.equal(dragged.canvasWidth, "448px");
  // Leaving page 1 while it is drawn cancels the drawing before the page is released.
  assert.deepEqual(failedDraw.page1.cleanups, [0]);
  assert.equal(failedDraw.page1.cancelledRenders, 1);
  // A page that fails to draw still offers its text, and a Retry.
  assert.match(failedDraw.alert, /could not be drawn: broken drawing/);
  assert.equal(failedDraw.text, "Page two text");
  assert.ok(failedDraw.retry);
  // Retry draws it again, though pdf.js gives back the same page at once, and does not read its text again.
  assert.equal(retried.page2.renders, 2);
  assert.equal(retried.page2.textReads, 1);
  assert.equal(retried.text, "Page two text");
  assert.equal(retried.canvasHidden, false);
  // The Retry that went away handed focus to the viewer, not to the page.
  assert.ok(retried.focusKept);
  // A page left before it arrived is released and never drawn or read; page 2 was left twice.
  assert.equal(skipped.page2.cleanups.length, 2);
  assert.equal(skipped.page3.renders, 0);
  assert.equal(skipped.page3.textReads, 0);
  assert.equal(skipped.page3.cleanups.length, 1);
  // While a page is on its way, the last page's drawing is hidden, not shown under the new page's label.
  assert.equal(skipped.pending.canvasHidden, true);
  assert.match(skipped.pending.canvasLabel, /^Page 3 of 5/);
  assert.equal(skipped.pending.loading, "Reading page 3…");
  // Returning to page 2 before page 3 arrives shows page 2 as on its way, not its ended visit's blank canvas.
  assert.deepEqual(skipped.pending.returned, { loadingShown: true });
  // Endless page text stops at the limit and pdf.js's stream is cancelled.
  assert.equal(skipped.textLength, 100_000);
  assert.ok(skipped.page4.textCancelled);
  // A page pdf.js cannot read says its text cannot be read, not that it is being read.
  assert.match(unreadable.alert, /page could not be read: bad page object/);
  assert.equal(unreadable.text, "This page's text could not be read.");
  // Next, disabled on the last page, keeps the focus it had.
  assert.equal(unreadable.focus, "Next page");
  // Its Retry opens the document again on the same page and ends the old one.
  assert.equal(reopened.opened, 2);
  assert.ok(reopened.firstEnded);
  assert.equal(reopened.page5.renders, 1);
  assert.equal(reopened.text, "This page's text could not be read.");
  assert.ok(reopened.focusKept);
  // A refresh reads failed text again and leaves the drawn page as it is.
  assert.equal(refreshed.page5.textReads, 2);
  assert.equal(refreshed.page5.renders, 1);
  // Closing releases the shown page and ends every document and its worker port.
  assert.equal(closed.page5.cleanups.length, 1);
  assert.ok(closed.ended);
  // A document that cannot be opened is reported once and ended while its error is shown.
  assert.equal(broken.url, "/broken.pdf");
  assert.deepEqual(broken.failures, ["Invalid PDF structure"]);
  assert.ok(broken.destroyed && broken.portDestroyed);
  // A refresh opens it again after the old one has ended, and the error clears.
  assert.equal(brokenRefreshed.opened, 2);
  assert.ok(brokenRefreshed.firstEnded);
  assert.equal(brokenRefreshed.alert, "");
  assert.deepEqual(brokenRefreshed.failures, ["Invalid PDF structure"]);
  // The error offers its own Retry, which opens the document again after the failed one ended.
  assert.equal(brokenRetried.button, "Retry");
  assert.equal(brokenRetried.opened, 2);
  assert.ok(brokenRetried.firstEnded);
  assert.equal(brokenRetried.alert, "");
  assert.deepEqual(brokenRetried.failures, ["Invalid PDF structure"]);
  assert.ok(brokenRetried.focusKept);
  // A new address shows nothing of the old document, not even for one commit.
  assert.deepEqual(order.firstCommit, { url: "/b.pdf", canvas: null, pages: null });
  // Replacing or closing a document stops its page's drawing and text, then releases the page, then ends the document, its port and its worker.
  // Returning to an address opens it anew: the ended document is neither shown nor asked for a page.
  assert.deepEqual(order.returnCommit, { url: "/b.pdf", canvas: null, pages: null });
  // (The drawing and the text are cancelled together, in either order.)
  for (const ended of [order.replaced, order.returned, order.closed]) {
    assert.deepEqual(ended.slice(0, 2).sort(), ["render-cancel", "text-cancel"], JSON.stringify(ended));
    assert.deepEqual(ended.slice(2), ["cleanup", "destroy", "port-destroy", "terminate"], JSON.stringify(ended));
  }
  // A drawing with no progress in time is cancelled, keeps its text, and fails only its page, which a resize neither clears nor draws again.
  assert.match(slow.alert, /could not be drawn: it stopped making progress/);
  assert.equal(slow.page1.cancelledRenders, 1);
  assert.equal(slow.text, "Page one text");
  assert.deepEqual(slow.failures, []);
  assert.equal(slow.resized.alert, slow.alert);
  assert.equal(slow.resized.renders, slow.page1.renders);
  // Its Retry opens the document again, after the stalled one has ended in order.
  assert.deepEqual(slow.reopened.slowEnded, ["render-cancel", "cleanup", "destroy", "port-destroy", "terminate"]);
  assert.ok(slow.reopened.focusKept);
  // After a stall, another page of the same document can still be visited and drawn.
  assert.deepEqual(slow.otherPage, { renders: 1, opened: 1 });
  // A drawing that keeps making progress past the deadline finishes.
  assert.deepEqual([progressing.page1.renders, progressing.page1.cancelledRenders, progressing.alert, progressing.canvasHidden], [1, 0, "", false]);
  // A page that arrives after its deadline is released once on arrival and never drawn or read, whether another page is on show or the viewer has closed.
  assert.deepEqual(late.page2.cleanups, [0]);
  assert.equal(late.page2.renders + late.page2.textReads, 0);
  assert.deepEqual([late.status, late.canvasHidden], ["Page 1 of 5", false]);
  assert.deepEqual(late.closed.page1.cleanups, [0]);
  assert.equal(late.closed.page1.renders + late.closed.page1.textReads, 0);
  assert.deepEqual(late.closed.ended, ["destroy", "port-destroy", "terminate", "cleanup"]);
  // A left-out image, which pdf.js does not tie to a page, is noticed for its document: the notice stays on the next page, and a document opened again starts without it.
  const leftOut = "Some images in this PDF are too large to show. Each page's text is below it.";
  assert.deepEqual(refused, { before: "", page2: leftOut, page1: leftOut, reopened: "" });
  // A worker that fails after its document opened fails the document in the same order, and Retry opens it again.
  assert.match(crashed.alert, /The PDF reader stopped: .*worker crashed/);
  assert.equal(crashed.failures.length, 1);
  assert.deepEqual(crashed.teardown, ["cleanup", "destroy", "port-destroy", "terminate"]);
  assert.equal(crashRetried.opened, 2);
  assert.ok(crashRetried.focusKept);
  // Closing a document still downloading closes its request.
  assert.deepEqual(held, { requested: true, closed: true });
  // A worker script gone after an update asks for a reload the user starts, not a Retry that cannot work.
  assert.match(retired.alert, /needs a page reload/);
  assert.equal(retired.button, "Reload page");
  assert.deepEqual(retired.failures, []);
});

test("with real pdf.js, a page whose image is too large to decode says so and keeps its text, and a document whose worker never answers Terminate has its fonts, and only its own, removed when it closes", { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  assert.ok(executable, "Chrome or Chromium is required to run the PDF viewer fixture");
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-pdf-real-"));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const bundled = async (entry, options) => (await build({ entryPoints: [entry], bundle: true, write: false, logLevel: "silent", alias: { "@": path.join(root, "src") }, ...options })).outputFiles[0].text;
  const script = (await bundled(path.join(fixture, "real-fixture.jsx"), {
    format: "iife", jsx: "automatic", define: { "import.meta.env.BASE_URL": JSON.stringify("/"), "process.env.NODE_ENV": JSON.stringify("development") },
    plugins: [{ name: "worker-url", setup(builder) {
      builder.onResolve({ filter: /pdf-worker-entry\.js\?worker&url$/ }, () => ({ path: "worker-url", namespace: "real" }));
      builder.onLoad({ filter: /^worker-url$/, namespace: "real" }, () => ({ contents: "export default '/worker.js';", loader: "js" }));
    } }],
  })).replaceAll("</script", "<\\/script");
  // The viewer's own worker entry, made deaf to Terminate, as a hung worker would be.
  const worker = await bundled(path.join(root, "src", "lib", "pdf-worker-entry.js"), { format: "esm", banner: { js: "addEventListener('message', (event) => { if (event.data?.action === 'Terminate') event.stopImmediatePropagation(); });" } });
  const files = { "/worker.js": ["text/javascript", worker], "/text.pdf": ["application/pdf", pdfFile({ text: "Plain page" })], "/image.pdf": ["application/pdf", pdfFile({ text: "Large image", image: { width: 6000, height: 3000 } })] };
  const serve = (request, response) => {
    const asset = /^\/pdfjs\/(cmaps|standard_fonts|wasm|iccs)\/([\w.-]+)$/.exec(request.url);
    const file = files[request.url] ?? (asset && existsSync(path.join(root, "node_modules", "pdfjs-dist", asset[1], asset[2])) && ["application/octet-stream", readFileSync(path.join(root, "node_modules", "pdfjs-dist", asset[1], asset[2]))]);
    if (!file) return false;
    response.setHeader("Content-Type", file[0]);
    response.end(file[1]);
    return true;
  };
  const { server, done } = fixtureServer(`<!doctype html><meta charset="utf-8"><body><script>${script}</script><img src="/hold" alt=""></body>`, 90_000, serve);
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const run = await runChrome(executable, path.join(directory, "profile"), `http://127.0.0.1:${server.address().port}/`, 100_000);
  const posted = await Promise.race([done, null]);
  assert.ok(posted, `the fixture did not finish: exit ${run.code ?? run.signal}; ${run.stderr}`);
  const outcome = JSON.parse(posted);
  assert.ok(outcome.ok, outcome.error);
  const { plain, large, plainFonts, largeFonts, afterPlainClosed, afterBothClosed } = outcome.result;
  // A page drawn whole has no notice; one whose image pdf.js left out says so, and its text is still read.
  assert.deepEqual(plain, { text: "Plain page", notice: "", canvas: true });
  assert.deepEqual(large, { text: "Large image", notice: "Some images in this PDF are too large to show. Each page's text is below it.", canvas: true });
  // Each document added fonts of its own; closing one removes its fonts and leaves the other's.
  assert.ok(plainFonts.length > 0 && largeFonts.length > 0, JSON.stringify({ plainFonts, largeFonts }));
  assert.deepEqual(afterPlainClosed.sort(), [...largeFonts].sort());
  assert.deepEqual(afterBothClosed, []);
});
