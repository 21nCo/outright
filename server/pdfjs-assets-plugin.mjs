import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

// pdf.js needs character maps (CJK text), standard font data (PDFs that do
// not embed their fonts) and decoders (JPEG 2000, JBIG2 and colour profiles)
// beside its worker. They are served from the app's own origin under
// /pdfjs/<folder>/, from node_modules during development and copied into the
// client build, so a preview never fetches them from elsewhere.
export const PDFJS_ASSET_FOLDERS = Object.freeze(["cmaps", "standard_fonts", "wasm", "iccs"]);
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TYPES = { ".bcmap": "application/octet-stream", ".pfb": "application/octet-stream", ".ttf": "font/ttf", ".wasm": "application/wasm", ".js": "text/javascript", ".icc": "application/vnd.iccprofile" };

// The headers a /pdfjs/<folder>/<name> asset is served with, the same in
// development and from the build: its own type and no sniffing. Null for any
// other address.
export function pdfjsAssetHeaders(pathname) {
  const [top, folder, name, ...rest] = pathname.split("/").filter(Boolean);
  if (top !== "pdfjs" || rest.length || !PDFJS_ASSET_FOLDERS.includes(folder) || !SAFE_NAME.test(name ?? "")) return null;
  return { "Content-Type": TYPES[path.extname(name)] ?? "application/octet-stream", "X-Content-Type-Options": "nosniff" };
}

export function pdfjsAssetsPlugin() {
  const base = path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
  const assets = () => PDFJS_ASSET_FOLDERS.flatMap((folder) => readdirSync(path.join(base, folder))
    .filter((name) => SAFE_NAME.test(name))
    .map((name) => ({ folder, name })));
  return {
    name: "outright-pdfjs-assets",
    configureServer(server) {
      server.middlewares.use("/pdfjs", (request, response, next) => {
        // The mount strips "/pdfjs"; the query is not part of an asset's name.
        const pathname = `/pdfjs${request.url.split(/[?#]/)[0]}`;
        const headers = pdfjsAssetHeaders(pathname);
        if (!headers) { next(); return; }
        let body;
        try { body = readFileSync(path.join(base, ...pathname.split("/").slice(2))); } catch { next(); return; }
        for (const [header, value] of Object.entries(headers)) response.setHeader(header, value);
        response.end(body);
      });
    },
    generateBundle() {
      for (const { folder, name } of assets()) {
        this.emitFile({ type: "asset", fileName: `pdfjs/${folder}/${name}`, source: readFileSync(path.join(base, folder, name)) });
      }
    },
  };
}
