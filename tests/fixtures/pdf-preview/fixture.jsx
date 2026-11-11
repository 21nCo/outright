// Drives the real PdfPreview over the fake pdf.js and posts what it
// observed to /done, which server/pdf-preview-browser.test.mjs reads.
import { useLayoutEffect } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import PdfPreview from "@/components/PdfPreview";
import { control, documents, events, ports } from "./fake-pdfjs.js";

// The pages of the document opened last.
const pages = new Proxy({}, { get: (target, number) => documents.at(-1)?.pages[number], ownKeys: () => Reflect.ownKeys(documents.at(-1)?.pages ?? {}), getOwnPropertyDescriptor: (target, number) => ({ value: documents.at(-1)?.pages[number], enumerable: true, configurable: true }) });
// The worker the viewer ends is logged with its document's number.
const terminate = Worker.prototype.terminate;
Worker.prototype.terminate = function end() {
  events.push(`${documents.find((record) => record.port?.port === this)?.id} terminate`);
  return terminate.call(this);
};
// Each document's ending, in order: its page work is stopped and released
// before the document ends, and the document before its port and worker.
const teardown = (record) => events.filter((event) => event.startsWith(`${record.id} `)).map((event) => event.split(" ")[1]);

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
// Buttons are pressed as from the keyboard: focused, then activated.
const press = (button) => { button.focus(); button.click(); };
const next = () => press(document.querySelector("button[aria-label='Next page']"));
const retry = () => press(document.querySelector(".pdf-frame [role=alert] button"));
// Focus stays inside the viewer instead of falling back to the page.
const focusKept = () => document.activeElement !== document.body && document.getElementById("host").contains(document.activeElement);
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
  result.retried = { page2: snapshot(2), text: pageText(), canvasHidden: document.querySelector("canvas").hidden, focusKept: focusKept() };

  // Page 3 arrives after page 4 was asked for.
  next();
  await until(() => pages[3], "page 3 asked for");
  // While page 3 is on its way, page 2's drawing is not shown as page 3.
  const pending = { canvasHidden: document.querySelector("canvas").hidden, canvasLabel: document.querySelector("canvas").getAttribute("aria-label"), loading: document.querySelector(".pdf-frame [role=status]")?.textContent ?? "" };
  next();
  await until(() => status() === "Page 4 of 5" && pageText()?.length > 1000, "page 4 text");
  await wait(300);
  result.skipped = { page2: snapshot(2), page3: snapshot(3), page4: snapshot(4), textLength: pageText().length, pending };

  // A page pdf.js cannot read settles its text, and Retry opens the document again.
  next();
  await until(() => alertText().includes("could not be read"), "page 5 failure");
  // Next, now disabled on the last page, keeps focus.
  result.unreadable = { alert: alertText(), text: pageText(), page5: snapshot(5), focus: document.activeElement?.getAttribute("aria-label") };
  retry();
  await until(() => status() === "Page 5 of 5" && pages[5].settledRenders === 1 && pageText() !== "Reading page text…", "page 5 reopened");
  await wait(50);
  const first = documents[0];
  result.reopened = { text: pageText(), opened: documents.length, firstEnded: first.destroyed && first.port.destroyed, page5: snapshot(5), focusKept: focusKept() };

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
  result.broken = { url: broken.url, destroyed: broken.destroyed, portDestroyed: broken.port.destroyed, failures: [...brokenFailures] };
  // A refresh opens it again, and the error clears once it opens.
  flushSync(() => brokenRoot.render(<PdfPreview url="/broken.pdf" name="broken.pdf" refreshKey={1} onFailed={(message) => brokenFailures.push(message)} />));
  await until(() => status() === "Page 1 of 5", "the broken document opened again");
  const brokenDocuments = documents.filter((record) => record.url === "/broken.pdf");
  result.brokenRefreshed = { opened: brokenDocuments.length, firstEnded: broken.destroyed && broken.port.destroyed, alert: document.querySelector("[role=alert]")?.textContent ?? "", failures: brokenFailures };
  brokenRoot.unmount();

  // The error's own Retry opens a document again, with no refresh.
  const retriedFailures = [];
  const retryRoot = createRoot(host);
  flushSync(() => retryRoot.render(<PdfPreview url="/broken-again.pdf" name="broken-again.pdf" refreshKey={0} onFailed={(message) => retriedFailures.push(message)} />));
  await until(() => document.querySelector("[role=alert]")?.textContent.includes("This PDF could not be read"), "the second broken document");
  const retryButton = document.querySelector("[role=alert] button");
  const button = retryButton?.textContent ?? "";
  press(retryButton);
  await until(() => status() === "Page 1 of 5", "the second broken document retried");
  const again = documents.filter((record) => record.url === "/broken-again.pdf");
  result.brokenRetried = { button, alert: document.querySelector("[role=alert]")?.textContent ?? "", opened: again.length, firstEnded: again[0].destroyed && again[0].port.destroyed, failures: retriedFailures, focusKept: focusKept() };
  retryRoot.unmount();

  // Replacing a document while its page is drawn and its text read: the
  // first commit with the new address shows nothing of the old document,
  // and the old one's page work stops and is released before it ends.
  control.holdDrawing = true;
  control.holdText = true;
  const commits = [];
  function Probe({ url }) {
    useLayoutEffect(() => { commits.push({ url, canvas: host.querySelector("canvas")?.getAttribute("aria-label") ?? null, pages: status() ?? null }); }, [url]);
    return <PdfPreview url={url} name={url.slice(1)} refreshKey={0} />;
  }
  const orderRoot = createRoot(host);
  orderRoot.render(<Probe url="/a.pdf" />);
  await until(() => documents.at(-1).url === "/a.pdf" && pages[1]?.renders === 1 && pages[1]?.textReads === 1, "a.pdf drawing and reading");
  const replaced = documents.at(-1);
  orderRoot.render(<Probe url="/b.pdf" />);
  await until(() => documents.at(-1).url === "/b.pdf" && pages[1]?.renders === 1 && pages[1]?.textReads === 1, "b.pdf drawing and reading");
  const closedRecord = documents.at(-1);
  orderRoot.unmount();
  await until(() => teardown(closedRecord).includes("terminate"), "b.pdf ended");
  await until(() => teardown(replaced).includes("terminate"), "a.pdf ended");
  control.holdDrawing = false;
  control.holdText = false;
  result.order = { firstCommit: commits.find((commit) => commit.url === "/b.pdf"), replaced: teardown(replaced), closed: teardown(closedRecord) };

  // A worker that fails after its document opened fails the document: the
  // page is released before the document ends, and Retry opens it again.
  const crashFailures = [];
  const crashRoot = createRoot(host);
  flushSync(() => crashRoot.render(<PdfPreview url="/crash.pdf" name="crash.pdf" refreshKey={0} onFailed={(message) => crashFailures.push(message)} />));
  await until(() => status() === "Page 1 of 5" && pages[1]?.settledRenders === 1, "crash.pdf drawn");
  const crashed = documents.at(-1);
  ports.at(-1).port.postMessage("crash");
  await until(() => document.querySelector("[role=alert]")?.textContent.includes("stopped") && teardown(crashed).includes("terminate"), "the worker failure");
  result.crashed = { alert: document.querySelector("[role=alert]").textContent, failures: [...crashFailures], teardown: teardown(crashed) };
  press(document.querySelector("[role=alert] button"));
  await until(() => status() === "Page 1 of 5", "crash.pdf opened again");
  result.crashRetried = { opened: documents.filter((record) => record.url === "/crash.pdf").length, focusKept: focusKept() };
  crashRoot.unmount();

  // Closing a document whose download is still arriving stops the download.
  const heldRoot = createRoot(host);
  flushSync(() => heldRoot.render(<PdfPreview url="/held.pdf" name="held.pdf" refreshKey={0} />));
  const held = async () => (await fetch("/held-state")).json();
  const heldEnd = performance.now() + 5000;
  while (!(await held()).requested && performance.now() < heldEnd) await wait(20);
  result.held = { requested: (await held()).requested };
  heldRoot.unmount();
  while (!(await held()).closed && performance.now() < heldEnd + 5000) await wait(20);
  result.held.closed = (await held()).closed;

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
  .then((outcome) => fetch("/done", { method: "POST", body: JSON.stringify(outcome) }))
  // Nothing is left to report to: the test sees the missing outcome.
  .catch((error) => console.error(error));
