// How the production build groups modules into files.
//
// pdf.js is left to its own chunk, made for its one dynamic import: that
// chunk exports pdf.js's own names. Grouped with other code, Rollup gives a
// chunk short export names and each import picks its module out with
// .then(m => m.x), and a retry of the chunk's address (module-retry.js)
// would get the short names instead. Nothing in the app imports the viewer
// yet; the build check that no dynamic import picks a module out this way
// lands with the slice that does (OUT-18), and until then a retry that gets
// short names asks for a page reload (module-retry.js).
export function manualChunks(id) {
  if (id.includes("@xterm/")) return "terminal";
  if (id.includes("@phosphor-icons/")) return "icons";
  if (id.includes("@base-ui/")) return "base-ui";
  if (id.includes("pdfjs-dist")) return undefined;
  if (id.includes("node_modules")) return "vendor";
  return undefined;
}
