import { useEffect, useRef, useState } from "react";
import { ArrowsClockwise, CaretLeft, CaretRight, SpinnerGap, WarningCircle } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { pdfCanvasSize } from "@/lib/pdf-canvas";

const MAX_PAGE_TEXT = 100_000;

// pdf.js draws one page at a time to a canvas. Nothing in the document runs:
// eval and XFA forms are off, and no annotation or scripting layer exists,
// so links and form actions are inert. Each page's text is offered beside
// the drawing for reading and assistive technology. Character maps, standard
// fonts and image decoders load from this app's own /pdfjs/ folder.
const PDF_ASSETS = `${import.meta.env.BASE_URL ?? "/"}pdfjs/`;
const assetUrl = (folder) => new URL(`${PDF_ASSETS}${folder}/`, window.location.href).href;
// A document that fails to load is reported through onFailed, so the
// preview offers Retry and a refresh opens it afresh. A page that fails to
// draw offers its own Retry, and is drawn again on the next refresh.
export default function PdfPreview({ url, name, refreshKey, onFailed }) {
  const [pdfState, setPdfState] = useState({ status: "loading" });
  const [pageError, setPageError] = useState(null);
  const [redraw, setRedraw] = useState(0);
  const onFailedRef = useRef(onFailed);
  onFailedRef.current = onFailed;
  const drawFailedRef = useRef(false);
  drawFailedRef.current = Boolean(pageError?.retry);
  const [page, setPage] = useState(1);
  const [width, setWidth] = useState(0);
  const [pageText, setPageText] = useState("");
  const frameRef = useRef(null);
  const canvasRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    let task;
    setPdfState({ status: "loading" });
    setPage(1);
    (async () => {
      const [pdfjs, worker] = await Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]);
      // Unmounted or reopened while the viewer loaded: start nothing.
      if (cancelled) return;
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      task = pdfjs.getDocument({ url, isEvalSupported: false, enableXfa: false, withCredentials: false, disableAutoFetch: true,
        cMapUrl: assetUrl("cmaps"), cMapPacked: true, standardFontDataUrl: assetUrl("standard_fonts"), wasmUrl: assetUrl("wasm"), iccUrl: assetUrl("iccs") });
      const pdf = await task.promise;
      if (!cancelled) setPdfState({ status: "ready", pdf, pages: pdf.numPages });
    })().catch((error) => {
      if (cancelled) return;
      const message = error?.message || "The PDF could not be read";
      setPdfState({ status: "error", message });
      onFailedRef.current?.(message);
    });
    // Destroying the loading task ends its worker and document, whether the
    // document is still loading or already shown.
    return () => { cancelled = true; void task?.destroy(); };
  }, [url]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return undefined;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(frame);
    return () => observer.disconnect();
  }, [pdfState.status]);

  // A refresh draws a failed page again; a page that drew is left as it is.
  useEffect(() => { if (drawFailedRef.current) setRedraw((value) => value + 1); }, [refreshKey]);

  useEffect(() => {
    if (pdfState.status !== "ready" || !width || !canvasRef.current) return undefined;
    let cancelled = false;
    let render;
    setPageText("");
    setPageError(null);
    (async () => {
      const pdfPage = await pdfState.pdf.getPage(page);
      if (cancelled) return;
      // The canvas is sized within a pixel budget before it is allocated.
      const size = pdfCanvasSize(pdfPage.getViewport({ scale: 1 }), width, window.devicePixelRatio || 1);
      const canvas = canvasRef.current;
      if (size.tooLarge) {
        canvas.width = 0;
        canvas.height = 0;
        setPageError({ message: "This page is too large to draw. Its text is below.", retry: false });
      } else {
        canvas.width = size.canvasWidth;
        canvas.height = size.canvasHeight;
        canvas.style.width = `${size.cssWidth}px`;
        canvas.style.height = `${size.cssHeight}px`;
        render = pdfPage.render({ canvas, canvasContext: canvas.getContext("2d"), viewport: pdfPage.getViewport({ scale: size.scale }) });
        await render.promise;
      }
      const content = await pdfPage.getTextContent();
      if (!cancelled) setPageText(content.items.map((item) => item.str ?? "").join(" ").replace(/\s+/g, " ").trim().slice(0, MAX_PAGE_TEXT));
    })().catch((error) => {
      if (!cancelled && error?.name !== "RenderingCancelledException") setPageError({ message: `This page could not be drawn: ${error?.message || "unknown error"}`, retry: true });
    });
    return () => { cancelled = true; render?.cancel(); };
  }, [pdfState, page, width, redraw]);

  if (pdfState.status === "loading") return <div className="preview-state" role="status"><SpinnerGap className="spin" />Reading PDF…</div>;
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
    <details className="pdf-text"><summary>Page text</summary><p>{pageText || "No text found on this page."}</p></details>
  </div>;
}
