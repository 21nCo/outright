// Drives the real PdfPreview over the fake pdf.js and posts what it
// observed to /done, which server/pdf-preview-browser.test.mjs reads.
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import PdfPreview from "@/components/PdfPreview";
import { control, documents, pages } from "./fake-pdfjs.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, ms = 5000) {
  const end = performance.now() + ms;
  while (!check()) {
    if (performance.now() > end) throw new Error(`Timed out waiting for ${label}; renders ${JSON.stringify(Object.values(pages).map((p) => [p.renders, p.settledRenders]))}, frame ${document.querySelector(".pdf-frame")?.getBoundingClientRect().width}; page text ${JSON.stringify(pageText()?.slice(0, 80))}, status ${status()}`);
    await wait(10);
  }
}
const pageText = () => document.querySelector(".pdf-text p")?.textContent;
const status = () => document.querySelector(".pdf-toolbar [role=status]")?.textContent;
const alertText = () => document.querySelector(".pdf-frame [role=alert]")?.textContent ?? "";
const next = () => document.querySelector("button[aria-label='Next page']").click();
const retry = () => document.querySelector(".pdf-frame [role=alert] button").click();
const snapshot = (number) => {
  const page = pages[number];
  return page ? { renders: page.renders, cancelledRenders: page.cancelledRenders, cleanups: [...page.cleanups], textReads: page.textReads, textCancelled: page.textCancelled } : null;
};

async function run() {
  const result = {};
  const host = document.getElementById("host");
  host.style.width = "600px";
  const root = createRoot(host);
  flushSync(() => root.render(<PdfPreview url="/doc.pdf" name="doc.pdf" refreshKey={0} />));
  await until(() => status() === "Page 1 of 5" && pageText() === "Page one text", "page 1");
  await until(() => pages[1].settledRenders === 1, "page 1 drawn");
  result.opened = snapshot(1);

  // Drag the pane narrower over half a second, one step per frame. A step
  // that a busy machine delays past the settle time may draw once more.
  let stalls = 0;
  for (let step = 1; step <= 30; step += 1) {
    const before = performance.now();
    host.style.width = `${600 - step * 5}px`;
    await wait(16);
    if (performance.now() - before >= 150) stalls += 1;
  }
  await wait(400);
  result.dragged = { ...snapshot(1), stalls, canvasWidth: document.querySelector("canvas").style.width };

  // Leave page 1 while it is being drawn again.
  control.holdDrawing = true;
  host.style.width = "500px";
  await until(() => pages[1].renders === result.dragged.renders + 1, "page 1 drawing again");
  next();
  control.holdDrawing = false;
  await until(() => status() === "Page 2 of 5" && alertText().includes("could not be drawn") && pageText() !== "Reading page text…", "page 2 failure");
  result.failedDraw = { alert: alertText(), text: pageText(), retry: Boolean(document.querySelector(".pdf-frame [role=alert] button")), page1: snapshot(1) };

  // Retry draws the page again although pdf.js answers with the same page at once.
  retry();
  await until(() => pages[2].settledRenders === 2 && !alertText(), "page 2 drawn again");
  result.retried = { page2: snapshot(2), text: pageText(), canvasHidden: document.querySelector("canvas").hidden };

  // Page 3 arrives after page 4 was asked for.
  next();
  await until(() => pages[3], "page 3 asked for");
  next();
  await until(() => status() === "Page 4 of 5" && pageText()?.length > 1000, "page 4 text");
  await wait(300);
  result.skipped = { page2: snapshot(2), page3: snapshot(3), page4: snapshot(4), textLength: pageText().length };

  // A page pdf.js cannot read settles its text, and Retry opens the document again.
  next();
  await until(() => alertText().includes("could not be read"), "page 5 failure");
  result.unreadable = { alert: alertText(), text: pageText(), page5: snapshot(5) };
  retry();
  await until(() => status() === "Page 5 of 5" && pages[5].settledRenders === 1 && pageText() !== "Reading page text…", "page 5 reopened");
  await wait(50);
  const first = documents[0];
  result.reopened = { text: pageText(), opened: documents.length, firstEnded: first.destroyed && first.port.destroyed, page5: snapshot(5) };

  // A refresh reads the failed text again without drawing the page again.
  flushSync(() => root.render(<PdfPreview url="/doc.pdf" name="doc.pdf" refreshKey={1} />));
  await until(() => pageText() === "Page five text", "page 5 text read again");
  result.refreshed = { page5: snapshot(5) };

  root.unmount();
  await wait(50);
  result.closed = { page5: snapshot(5), ended: documents.every((record) => record.destroyed && record.port.destroyed) };

  // A document that cannot be opened is ended while its error stays on show.
  const brokenFailures = [];
  const brokenRoot = createRoot(host);
  flushSync(() => brokenRoot.render(<PdfPreview url="/broken.pdf" name="broken.pdf" refreshKey={0} onFailed={(message) => brokenFailures.push(message)} />));
  await until(() => document.querySelector("[role=alert]")?.textContent.includes("This PDF could not be read"), "the broken document");
  await wait(50);
  const broken = documents.at(-1);
  result.broken = { url: broken.url, destroyed: broken.destroyed, portDestroyed: broken.port.destroyed, failures: brokenFailures };
  brokenRoot.unmount();

  await fetch("/retire-worker", { method: "POST" });
  const failures = [];
  const retiredRoot = createRoot(host);
  flushSync(() => retiredRoot.render(<PdfPreview url="/other.pdf" name="other.pdf" refreshKey={0} onFailed={(message) => failures.push(message)} />));
  await until(() => document.querySelector("[role=alert]")?.textContent.includes("reload"), "the reload state");
  result.retired = { alert: document.querySelector("[role=alert]").textContent, button: document.querySelector("[role=alert] button")?.textContent, failures };
  retiredRoot.unmount();
  return result;
}

run().then((result) => ({ ok: true, result }), (error) => ({ ok: false, error: String(error?.stack ?? error) }))
  .then((outcome) => fetch("/done", { method: "POST", body: JSON.stringify(outcome) }));
