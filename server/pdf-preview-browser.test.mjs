import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

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
        builder.onResolve({ filter: /^pdfjs-dist\/build\/pdf\.worker\.min\.mjs\?url$/ }, () => ({ path: "worker-url", namespace: "fake" }));
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
// /retire-worker removes the worker script, as a deployment would.
function fixtureServer(html, holdMs) {
  let release;
  let retired = false;
  const done = new Promise((resolve) => { release = resolve; });
  const held = setTimeout(() => release(null), holdMs);
  const server = createServer((request, response) => {
    if (request.url === "/") { response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(html); return; }
    if (request.url === WORKER_PATH && !retired) { response.setHeader("Content-Type", "text/javascript"); response.end("postMessage({ sourceName: 'worker', action: 'ready' });"); return; }
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

test("the PDF viewer reads each page once, stops a page's work before releasing it, retries only what failed, ends documents that fail, redraws a dragged pane once and asks for a reload when its worker is gone", { timeout: 180_000 }, async (t) => {
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
  const { opened, dragged, failedDraw, retried, skipped, unreadable, reopened, refreshed, closed, broken, retired } = outcome.result;

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
  // A page left before it arrived is released and never drawn or read.
  assert.equal(skipped.page2.cleanups.length, 1);
  assert.equal(skipped.page3.renders, 0);
  assert.equal(skipped.page3.textReads, 0);
  assert.equal(skipped.page3.cleanups.length, 1);
  // Endless page text stops at the limit and pdf.js's stream is cancelled.
  assert.equal(skipped.textLength, 100_000);
  assert.ok(skipped.page4.textCancelled);
  // A page pdf.js cannot read says its text cannot be read, not that it is being read.
  assert.match(unreadable.alert, /page could not be read: bad page object/);
  assert.equal(unreadable.text, "This page's text could not be read.");
  // Its Retry opens the document again on the same page and ends the old one.
  assert.equal(reopened.opened, 2);
  assert.ok(reopened.firstEnded);
  assert.equal(reopened.page5.renders, 1);
  assert.equal(reopened.text, "This page's text could not be read.");
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
  // A worker script gone after an update asks for a reload the user starts, not a Retry that cannot work.
  assert.match(retired.alert, /needs a page reload/);
  assert.equal(retired.button, "Reload page");
  assert.deepEqual(retired.failures, []);
});
