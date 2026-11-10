// Drives the real PdfPreview over the fake pdf.js and posts what it
// observed to /done, which server/pdf-preview-browser.test.mjs reads.
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import PdfPreview from "@/components/PdfPreview";
import { documents, pages } from "./fake-pdfjs.js";

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
  await until(() => status() === "Page 1 of 4" && pageText() === "Page one text", "page 1");
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

  next();
  await until(() => status() === "Page 2 of 4" && alertText().includes("could not be drawn") && pageText() !== "Reading page text…", "page 2 failure");
  result.failedDraw = { alert: alertText(), text: pageText(), retry: Boolean(document.querySelector(".pdf-frame [role=alert] button")), page1: snapshot(1) };

  // Page 3 arrives after page 4 was asked for.
  next();
  await until(() => pages[3], "page 3 asked for");
  next();
  await until(() => status() === "Page 4 of 4" && pageText()?.length > 1000, "page 4 text");
  await wait(300);
  result.skipped = { page2: snapshot(2), page3: snapshot(3), page4: snapshot(4), textLength: pageText().length };

  root.unmount();
  await wait(50);
  result.closed = { page4: snapshot(4), destroyed: documents.every((record) => record.destroyed) };

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
