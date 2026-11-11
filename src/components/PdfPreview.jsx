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
// own Retry, and is drawn again on the next refresh; text that fails to read
// is read again on the next refresh. A page that cannot be read at all
// (pdf.js keeps that failure for the open document) is retried by opening
// the document again.
export default function PdfPreview({ url, name, refreshKey, onFailed }) {
  const [pdfState, setPdfState] = useState({ status: "loading" });
  const [reopen, setReopen] = useState(0);
  const [pageError, setPageError] = useState(null);
  const [drawAttempt, setDrawAttempt] = useState(0);
  const [textAttempt, setTextAttempt] = useState(0);
  const onFailedRef = useRef(onFailed);
  useEffect(() => { onFailedRef.current = onFailed; });
  const [page, setPage] = useState(1);
  // The page on show, fetched once per page and document: { proxy, signal,
  // page }. The signal aborts when the page is left, which stops its drawing
  // and text reading before the page is released. Until the asked-for page
  // arrives, the canvas (still holding the last page) is hidden and cleared.
  const [pageSession, setPageSession] = useState(null);
  const [width, setWidth] = useState(0);
  const [pageText, setPageText] = useState({ status: "loading" });
  const frameRef = useRef(null);
  const canvasRef = useRef(null);

  useEffect(() => { setPage(1); }, [url]);

  useEffect(() => {
    let cancelled = false;
    let ended = false;
    let task;
    let started;
    let port;
    // Closing, replacing or failing ends the document, then its worker,
    // which pdf.js does not end for a port it was given. A worker that does
    // not answer within a few seconds is ended anyway; one still starting
    // is stopped without counting as a failed start.
    const end = () => {
      if (ended) return;
      ended = true;
      started?.cancel();
      let timer;
      const destroyed = task ? Promise.race([task.destroy().catch(() => {}), new Promise((resolve) => { timer = setTimeout(resolve, 3000); })]) : Promise.resolve();
      void destroyed.then(() => { clearTimeout(timer); port?.destroy(); started?.worker.terminate(); });
    };
    setPdfState({ status: "loading" });
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
      if (cancelled) return;
      // A document opened again may have fewer pages than the one before.
      setPage((value) => Math.min(value, pdf.numPages));
      setPdfState({ status: "ready", pdf, pages: pdf.numPages });
    })().catch((error) => {
      if (cancelled) return;
      end();
      if (error?.reloadRequired) { setPdfState({ status: "reload", retryable: Boolean(error.retryable) }); return; }
      const message = error?.message || "The PDF could not be read";
      setPdfState({ status: "error", message });
      onFailedRef.current?.(message);
    });
    return () => { cancelled = true; end(); };
  }, [url, reopen]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return undefined;
    const widths = settledWidth(setWidth);
    const observer = new ResizeObserver(([entry]) => widths.update(Math.floor(entry.contentRect.width)));
    observer.observe(frame);
    return () => { widths.cancel(); observer.disconnect(); };
  }, [pdfState.status]);

  // A refresh retries only what failed: a document that failed to open (or
  // a retryable reload state), or a page that cannot be read, opens the
  // document again; a failed drawing draws again and failed text is read
  // again. A page that drew, and text that was read, are left as they are.
  useEffect(() => {
    const reopenDocument = pdfState.status === "error" || pdfState.retryable || pageError?.retry === "reopen";
    if (reopenDocument) setReopen((value) => value + 1);
    if (pageError?.retry === "draw") setDrawAttempt((value) => value + 1);
    if (pageText.status === "failed" && !reopenDocument) setTextAttempt((value) => value + 1);
  }, [refreshKey]);

  // The page session. Leaving a page, or its document, first stops its
  // drawing and text reading, then releases the page's decoded images and
  // drawing operations, so visiting many pages keeps only the shown one's.
  const pdf = pdfState.pdf;
  useEffect(() => {
    setPageSession(null);
    setPageError(null);
    setPageText({ status: "loading" });
    if (canvasRef.current) canvasRef.current.width = 0;
    if (!pdf) return undefined;
    const session = new AbortController();
    let proxy;
    pdf.getPage(page).then((value) => {
      proxy = value;
      if (session.signal.aborted) value.cleanup(); else setPageSession({ proxy: value, signal: session.signal, page });
    }, (error) => {
      if (session.signal.aborted) return;
      setPageError({ message: `This page could not be read: ${error?.message || "unknown error"}`, retry: "reopen" });
      setPageText({ status: "failed" });
    });
    return () => { session.abort(); proxy?.cleanup(); };
  }, [pdf, page]);

  // Drawing follows the page, the pane's width and Retry. A cancelled
  // drawing is not an error: a newer one replaces it.
  useEffect(() => {
    if (!pageSession || pageSession.signal.aborted || !width || !canvasRef.current) return undefined;
    const { proxy, signal } = pageSession;
    let cancelled = false;
    setPageError(null);
    // The canvas is sized within a pixel budget before it is allocated.
    const size = pdfCanvasSize(proxy.getViewport({ scale: 1 }), width, window.devicePixelRatio || 1);
    const canvas = canvasRef.current;
    if (size.tooLarge) {
      canvas.width = 0;
      canvas.height = 0;
      setPageError({ message: "This page is too large to draw. Its text is below.", retry: null });
      return undefined;
    }
    canvas.width = size.canvasWidth;
    canvas.height = size.canvasHeight;
    canvas.style.width = `${size.cssWidth}px`;
    canvas.style.height = `${size.cssHeight}px`;
    const render = proxy.render({ canvas, canvasContext: canvas.getContext("2d"), viewport: proxy.getViewport({ scale: size.scale }) });
    const stop = () => { if (!cancelled) { cancelled = true; render.cancel(); } };
    signal.addEventListener("abort", stop, { once: true });
    render.promise.catch((error) => {
      if (!cancelled && error?.name !== "RenderingCancelledException") setPageError({ message: `This page could not be drawn: ${error?.message || "unknown error"}`, retry: "draw" });
    });
    return () => { signal.removeEventListener("abort", stop); stop(); };
  }, [pageSession, width, drawAttempt]);

  // The page's text is read once per page, apart from drawing, so a resize
  // or a drawing Retry does not read it again and a page that fails to draw
  // keeps its text.
  useEffect(() => {
    if (!pageSession || pageSession.signal.aborted) return undefined;
    const controller = new AbortController();
    const stop = () => controller.abort();
    pageSession.signal.addEventListener("abort", stop, { once: true });
    setPageText({ status: "loading" });
    readPageText(pageSession.proxy.streamTextContent(), { signal: controller.signal }).then(
      (text) => { if (!controller.signal.aborted) setPageText({ status: "ready", text }); },
      () => { if (!controller.signal.aborted) setPageText({ status: "failed" }); });
    return () => { pageSession.signal.removeEventListener("abort", stop); stop(); };
  }, [pageSession, textAttempt]);

  const retryPage = () => (pageError?.retry === "reopen" ? setReopen : setDrawAttempt)((value) => value + 1);
  if (pdfState.status === "loading") return <div className="preview-state" role="status"><SpinnerGap className="spin" />Reading PDF…</div>;
  if (pdfState.status === "reload") return <div className="preview-state" role="alert"><WarningCircle /><p>Outright was updated, or part of it did not load, so the PDF viewer needs a page reload. Reloading clears unsent messages.</p>
    <Button variant="outline" size="xs" onClick={() => window.location.reload()}><ArrowsClockwise />Reload page</Button>
    {pdfState.retryable && <Button variant="ghost" size="xs" onClick={() => setReopen((value) => value + 1)}>Try again</Button>}</div>;
  if (pdfState.status === "error") return <div className="preview-state" role="alert"><WarningCircle /><p>This PDF could not be read: {pdfState.message}</p><Button variant="outline" size="xs" onClick={() => setReopen((value) => value + 1)}><ArrowsClockwise />Retry</Button></div>;
  const pageShown = pageSession?.page === page;
  return <div className="pdf-preview">
    <div className="pdf-toolbar" role="group" aria-label="PDF pages">
      <Button variant="ghost" size="icon-xs" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}><CaretLeft /></Button>
      <span role="status" aria-live="polite">Page {page} of {pdfState.pages}</span>
      <Button variant="ghost" size="icon-xs" aria-label="Next page" disabled={page >= pdfState.pages} onClick={() => setPage((value) => Math.min(pdfState.pages, value + 1))}><CaretRight /></Button>
    </div>
    <div className="pdf-frame" ref={frameRef}>
      <canvas ref={canvasRef} role="img" hidden={Boolean(pageError) || !pageShown} aria-label={`Page ${page} of ${pdfState.pages} of ${name}`} />
      {!pageError && !pageShown && <div className="preview-state" role="status"><SpinnerGap className="spin" />Reading page {page}…</div>}
      {pageError && <div className="preview-state" role="alert"><p>{pageError.message}</p>{pageError.retry && <Button variant="outline" size="xs" onClick={retryPage}><ArrowsClockwise />Retry</Button>}</div>}
    </div>
    <details className="pdf-text"><summary>Page text</summary><p>{{ loading: "Reading page text…", failed: "This page's text could not be read." }[pageText.status] ?? (pageText.text || "No text found on this page.")}</p></details>
  </div>;
}
