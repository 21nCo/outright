// Sizes the canvas for one PDF page before anything is allocated. pdf.js
// draws at whatever size it is given, and a page can be up to 14,400 units
// on a side, times its UserUnit. So the page fits the pane width (zoomed at
// most 4x and never taller than maxSide CSS pixels), and the drawing density
// then drops below the display's pixel ratio as needed to keep each side and
// the total area of the canvas within budget. A page that would still be too
// blurry or less than a pixel wide is not drawn.
export const PDF_CANVAS_LIMITS = Object.freeze({
  maxZoom: 4,
  maxSide: 16_384,
  maxPixels: 2 ** 24,
  minDensity: 0.25,
});

// `page` is the page's size at scale 1 (pdf.js includes its UserUnit).
// Returns the pdf.js scale and the canvas and CSS sizes, or { tooLarge: true }.
export function pdfCanvasSize(page, paneWidth, pixelRatio = 1, limits = PDF_CANVAS_LIMITS) {
  const { width, height } = page ?? {};
  if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height))) return { tooLarge: true };
  const fit = Math.max(1, paneWidth - 2) / width;
  const cssScale = Math.min(limits.maxZoom, fit, limits.maxSide / height);
  const cssWidth = width * cssScale;
  const cssHeight = height * cssScale;
  const ratio = pixelRatio > 0 && Number.isFinite(pixelRatio) ? pixelRatio : 1;
  const density = Math.min(ratio, limits.maxSide / Math.max(cssWidth, cssHeight), Math.sqrt(limits.maxPixels / (cssWidth * cssHeight)));
  const canvasWidth = Math.floor(cssWidth * density);
  const canvasHeight = Math.floor(cssHeight * density);
  if (cssWidth < 1 || cssHeight < 1 || canvasWidth < 1 || canvasHeight < 1 || density < limits.minDensity) return { tooLarge: true };
  return { scale: cssScale * density, canvasWidth, canvasHeight, cssWidth: Math.floor(cssWidth), cssHeight: Math.floor(cssHeight) };
}
