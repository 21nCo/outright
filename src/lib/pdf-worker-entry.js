// pdf.js's worker only logs an image it leaves out as too large to decode;
// pdf-worker-warnings.js, evaluated first, also tells the viewer.
import "./pdf-worker-warnings.js";
import "pdfjs-dist/build/pdf.worker.min.mjs";
