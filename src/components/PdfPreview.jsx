import { useEffect, useRef, useState } from "react";
import { CaretLeft, CaretRight, SpinnerGap, WarningCircle } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";

const MAX_PAGE_TEXT = 100_000;

// pdf.js draws one page at a time to a canvas. Nothing in the document runs:
// eval and XFA forms are off, and no annotation or scripting layer exists,
// so links and form actions are inert. Each page's text is offered beside
// the drawing for reading and assistive technology. Character maps, standard
// fonts and image decoders load from this app's own /pdfjs/ folder.
const PDF_ASSETS = `${import.meta.env.BASE_URL ?? "/"}pdfjs/`;
const assetUrl = (folder) => new URL(`${PDF_ASSETS}${folder}/`, window.location.href).href;
export default function PdfPreview({ url, name }) {
  const [pdfState, setPdfState] = useState({ status: "loading" });
  const [pageError, setPageError] = useState("");
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
    })().catch((error) => { if (!cancelled) setPdfState({ status: "error", message: error?.message || "The PDF could not be read" }); });
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

  useEffect(() => {
    if (pdfState.status !== "ready" || !width || !canvasRef.current) return undefined;
    let cancelled = false;
    let render;
    setPageText("");
    setPageError("");
    (async () => {
      const pdfPage = await pdfState.pdf.getPage(page);
      if (cancelled) return;
      const base = pdfPage.getViewport({ scale: 1 });
      const scale = Math.max(0.25, Math.min(4, (width - 2) / base.width));
      const ratio = window.devicePixelRatio || 1;
      const viewport = pdfPage.getViewport({ scale: scale * ratio });
      const canvas = canvasRef.current;
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${Math.floor(viewport.width / ratio)}px`;
      canvas.style.height = `${Math.floor(viewport.height / ratio)}px`;
      render = pdfPage.render({ canvas, canvasContext: canvas.getContext("2d"), viewport });
      await render.promise;
      const content = await pdfPage.getTextContent();
      if (!cancelled) setPageText(content.items.map((item) => item.str ?? "").join(" ").replace(/\s+/g, " ").trim().slice(0, MAX_PAGE_TEXT));
    })().catch((error) => {
      if (!cancelled && error?.name !== "RenderingCancelledException") setPageError(error?.message || "This page could not be drawn");
    });
    return () => { cancelled = true; render?.cancel(); };
  }, [pdfState, page, width]);

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
      {pageError && <p role="alert">{pageError}</p>}
    </div>
    <details className="pdf-text"><summary>Page text</summary><p>{pageText || "No text found on this page."}</p></details>
  </div>;
}
