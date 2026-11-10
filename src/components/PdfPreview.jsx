import { useEffect, useRef, useState } from "react";
import { ArrowsClockwise, CaretLeft, CaretRight, SpinnerGap, WarningCircle } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { retryingImport } from "@/lib/module-retry";
import { pdfCanvasSize, settledWidth } from "@/lib/pdf-canvas";
import { readPageText } from "@/lib/pdf-text";
import { pdfWorkerStarter } from "@/lib/pdf-worker";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

// pdf.js draws one page at a time to a canvas. Nothing in the document runs:
// eval and XFA forms are off, and no annotation or scripting layer exists,
// so links and form actions are inert. Each page's text is offered beside
// the drawing for reading and assistive technology. Character maps, standard
// fonts and image decoders load from this app's own /pdfjs/ folder.
const PDF_ASSETS = `${import.meta.env.BASE_URL ?? "/"}pdfjs/`;
const assetUrl = (folder) => new URL(`${PDF_ASSETS}${folder}/`, window.location.href).href;
// pdf.js loads on first use. A load that fails is reported like a document
// that cannot be read, and Retry loads it afresh (or a reload, when only
// that can). The worker script's
// address is only a string, so it is part of this module.
const loadPdfjs = retryingImport(() => import("pdfjs-dist"), { exports: ["getDocument", "PDFWorker"] });

// Each document gets its own worker, started here (see pdf-worker.js).
const startWorker = pdfWorkerStarter();
// A document that fails to load is reported through onFailed, so the
// preview offers Retry and a refresh opens it afresh, unless only a page
// reload can load the viewer again (see module-retry.js): then this offers
// the reload, which the user starts. A page that fails to draw offers its
// own Retry, and is drawn again on the next refresh.
export default function PdfPreview({ url, name, refreshKey, onFailed }) {
  const [pdfState, setPdfState] = useState({ status: "loading" });
  const [pageError, setPageError] = useState(null);
  const [redraw, setRedraw] = useState(0);
  const onFailedRef = useRef(onFailed);
  useEffect(() => { onFailedRef.current = onFailed; });
  const [page, setPage] = useState(1);
  // The page on show, fetched once per page, retry and document.
  const [pageProxy, setPageProxy] = useState(null);
  const [width, setWidth] = useState(0);
  const [pageText, setPageText] = useState({ status: "loading" });
  const frameRef = useRef(null);
  const canvasRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    let task;
    let started;
    let port;
    setPdfState({ status: "loading" });
    setPage(1);
    (async () => {
      const pdfjs = await loadPdfjs();
      // Unmounted or reopened while the viewer loaded: start nothing.
      if (cancelled) return;
      started = startWorker(workerUrl);
      await started.ready;
      if (cancelled) return;
      port = new pdfjs.PDFWorker({ port: started.worker });
      task = pdfjs.getDocument({ url, worker: port, isEvalSupported: false, enableXfa: false, withCredentials: false, disableAutoFetch: true,
        cMapUrl: assetUrl("cmaps"), cMapPacked: true, standardFontDataUrl: assetUrl("standard_fonts"), wasmUrl: assetUrl("wasm"), iccUrl: assetUrl("iccs") });
      const pdf = await task.promise;
      if (!cancelled) setPdfState({ status: "ready", pdf, pages: pdf.numPages });
    })().catch((error) => {
      if (cancelled) return;
      if (error?.reloadRequired) { setPdfState({ status: "reload" }); return; }
      const message = error?.message || "The PDF could not be read";
      setPdfState({ status: "error", message });
      onFailedRef.current?.(message);
    });
    // Closing, replacing or failing ends the document, then its worker,
    // which pdf.js does not end for a port it was given. A worker that does
    // not answer within a few seconds is ended anyway.
    return () => {
      cancelled = true;
      const ended = task ? Promise.race([task.destroy().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 3000))]) : Promise.resolve();
      void ended.then(() => { port?.destroy(); started?.worker.terminate(); });
    };
  }, [url]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return undefined;
    const widths = settledWidth(setWidth);
    const observer = new ResizeObserver(([entry]) => widths.update(Math.floor(entry.contentRect.width)));
    observer.observe(frame);
    return () => { widths.cancel(); observer.disconnect(); };
  }, [pdfState.status]);

  // A refresh draws a failed page, or reads its failed text, again; a page
  // that drew is left as it is.
  useEffect(() => { if (pageError?.retry || pageText.status === "failed") setRedraw((value) => value + 1); }, [refreshKey]);

  // Drawing follows the page and the pane's width. A cancelled drawing is
  // not an error: a newer one replaces it.
  useEffect(() => {
    if (!pageProxy || !width || !canvasRef.current) return undefined;
    let cancelled = false;
    setPageError(null);
    // The canvas is sized within a pixel budget before it is allocated.
    const size = pdfCanvasSize(pageProxy.getViewport({ scale: 1 }), width, window.devicePixelRatio || 1);
    const canvas = canvasRef.current;
    if (size.tooLarge) {
      canvas.width = 0;
      canvas.height = 0;
      setPageError({ message: "This page is too large to draw. Its text is below.", retry: false });
      return undefined;
    }
    canvas.width = size.canvasWidth;
    canvas.height = size.canvasHeight;
    canvas.style.width = `${size.cssWidth}px`;
    canvas.style.height = `${size.cssHeight}px`;
    const render = pageProxy.render({ canvas, canvasContext: canvas.getContext("2d"), viewport: pageProxy.getViewport({ scale: size.scale }) });
    render.promise.catch((error) => {
      if (!cancelled && error?.name !== "RenderingCancelledException") setPageError({ message: `This page could not be drawn: ${error?.message || "unknown error"}`, retry: true });
    });
    return () => { cancelled = true; render.cancel(); };
  }, [pageProxy, width]);

  // The page's text is read once per page, apart from drawing, so a resize
  // does not read it again and a page that fails to draw keeps its text.
  useEffect(() => {
    if (!pageProxy) return undefined;
    const controller = new AbortController();
    readPageText(pageProxy.streamTextContent(), { signal: controller.signal }).then(
      (text) => { if (!controller.signal.aborted) setPageText({ status: "ready", text }); },
      () => { if (!controller.signal.aborted) setPageText({ status: "failed" }); });
    return () => controller.abort();
  }, [pageProxy]);

  // Declared after the drawing and text effects, so their cleanups cancel
  // first. A page that is replaced, or comes back after it was, releases
  // its decoded images and drawing operations (pdf.js does so once any
  // drawing still running on it has stopped), so visiting many pages keeps
  // only the shown one's.
  useEffect(() => {
    if (pdfState.status !== "ready") return undefined;
    let cancelled = false;
    let proxy;
    setPageProxy(null);
    setPageError(null);
    setPageText({ status: "loading" });
    pdfState.pdf.getPage(page).then((value) => {
      proxy = value;
      if (cancelled) value.cleanup(); else setPageProxy(value);
    }, (error) => {
      if (!cancelled) setPageError({ message: `This page could not be read: ${error?.message || "unknown error"}`, retry: true });
    });
    return () => { cancelled = true; proxy?.cleanup(); };
  }, [pdfState, page, redraw]);

  if (pdfState.status === "loading") return <div className="preview-state" role="status"><SpinnerGap className="spin" />Reading PDF…</div>;
  if (pdfState.status === "reload") return <div className="preview-state" role="alert"><WarningCircle /><p>Outright was updated, or part of it did not load, so the PDF viewer needs a page reload. Reloading clears unsent messages.</p>
    <Button variant="outline" size="xs" onClick={() => window.location.reload()}><ArrowsClockwise />Reload page</Button></div>;
  if (pdfState.status === "error") return <div className="preview-state" role="alert"><WarningCircle />This PDF could not be read: {pdfState.message}</div>;
  return <div className="pdf-preview">
    <div className="pdf-toolbar" role="group" aria-label="PDF pages">
      <Button variant="ghost" size="icon-xs" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}><CaretLeft /></Button>
      <span role="status" aria-live="polite">Page {page} of {pdfState.pages}</span>
      <Button variant="ghost" size="icon-xs" aria-label="Next page" disabled={page >= pdfState.pages} onClick={() => setPage((value) => Math.min(pdfState.pages, value + 1))}><CaretRight /></Button>
    </div>
    <div className="pdf-frame" ref={frameRef}>
      <canvas ref={canvasRef} role="img" hidden={Boolean(pageError)} aria-label={`Page ${page} of ${pdfState.pages} of ${name}`} />
      {pageError && <div className="preview-state" role="alert"><p>{pageError.message}</p>{pageError.retry && <Button variant="outline" size="xs" onClick={() => setRedraw((value) => value + 1)}><ArrowsClockwise />Retry</Button>}</div>}
    </div>
    <details className="pdf-text"><summary>Page text</summary><p>{{ loading: "Reading page text…", failed: "This page's text could not be read." }[pageText.status] ?? (pageText.text || "No text found on this page.")}</p></details>
  </div>;
}
