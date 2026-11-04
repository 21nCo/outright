// How the production build groups modules into files, shared by the app's
// build and the browser fixture's build so both load the preview path the
// same way.
//
// pdf.js is left to its own chunk, made for its one dynamic import: that
// chunk exports pdf.js's own names. Grouped with other code, Rollup gives a
// chunk short export names and each import picks its module out with
// .then(m => m.x), and a retry of the chunk's address (module-retry.js)
// would get the short names instead. tests/preview-build.test.mjs checks
// that no dynamic import in the build picks a module out this way.
export function manualChunks(id) {
  if (id.includes("@xterm/")) return "terminal";
  if (id.includes("@phosphor-icons/")) return "icons";
  if (id.includes("@base-ui/")) return "base-ui";
  if (id.includes("pdfjs-dist")) return undefined;
  if (id.includes("node_modules")) return "vendor";
  return undefined;
}
