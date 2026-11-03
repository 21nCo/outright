import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, normalizePath } from "vite";
import { pdfjsAssetsPlugin } from "../server/pdfjs-assets-plugin.mjs";
import { manualChunks } from "../server/vite-chunks.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
// Images load through <img>, not the page's fetch, so the Files fixture's
// raw PNG is served here; every other raw file is missing.
const FIXTURE_PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a70000000049454e44ae426082", "hex");
// A step may also serve another PNG name (/__fixture/raw?serve=late.png),
// count its reads (/__fixture/raw?reads=late.png), and fail the next loads
// of an app module (/__fixture/fail-module?path=/src/x.jsx&times=1), and
// count the requests for any address (/__fixture/requests?path=/src/x.jsx).
// A built fixture (vite build, then vite preview) names its chunks by hash,
// so a step may fail and count them by the start of their address instead
// (/__fixture/fail-module?prefix=/assets/pdf-&times=1, requests?prefix=).
const servedPngs = new Set(["logo.png", "docs/logo.png"]);
const pngReads = new Map();
const failingModules = new Map();
const failingPrefixes = new Map();
const requestCounts = new Map();
const prefixCount = (prefix) => [...requestCounts].reduce((sum, [pathname, count]) => sum + (pathname.startsWith(prefix) ? count : 0), 0);
function fixtureMiddleware(server) {
    server.middlewares.use("/__fixture", (request, response) => {
      const url = new URL(request.url, "http://fixture");
      if (url.pathname === "/raw") {
        for (const file of url.searchParams.getAll("serve")) servedPngs.add(file);
        for (const file of url.searchParams.getAll("unserve")) servedPngs.delete(file);
        const counted = url.searchParams.get("reads");
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ reads: counted ? pngReads.get(counted) ?? [] : [] }));
        return;
      }
      if (url.pathname === "/requests") {
        response.setHeader("Content-Type", "application/json");
        const prefix = url.searchParams.get("prefix");
        response.end(JSON.stringify({ count: prefix ? prefixCount(prefix) : requestCounts.get(url.searchParams.get("path")) ?? 0 }));
        return;
      }
      if (url.pathname === "/fail-module") {
        const times = Number(url.searchParams.get("times") ?? 1);
        if (url.searchParams.has("prefix")) failingPrefixes.set(url.searchParams.get("prefix"), times);
        else failingModules.set(url.searchParams.get("path"), times);
      }
      response.end("ok");
    });
    server.middlewares.use((request, response, next) => {
      const pathname = new URL(request.url, "http://fixture").pathname;
      requestCounts.set(pathname, (requestCounts.get(pathname) ?? 0) + 1);
      const prefix = [...failingPrefixes.keys()].find((start) => pathname.startsWith(start) && failingPrefixes.get(start) > 0);
      const failing = prefix === undefined ? failingModules : failingPrefixes;
      const key = prefix ?? pathname;
      const left = failing.get(key) ?? 0;
      if (left <= 0) { next(); return; }
      failing.set(key, left - 1);
      response.statusCode = 503;
      response.end();
    });
    server.middlewares.use("/api/files/raw", (request, response) => {
      const url = new URL(request.url, "http://fixture");
      const file = url.searchParams.get("file");
      pngReads.set(file, [...(pngReads.get(file) ?? []), url.search]);
      if (servedPngs.has(file)) { response.setHeader("Content-Type", "image/png"); response.end(FIXTURE_PNG); return; }
      response.statusCode = 404;
      response.end();
    });
}
const fixtureRawFiles = {
  name: "ui-races-raw-files",
  configureServer: fixtureMiddleware,
  configurePreviewServer: fixtureMiddleware,
};

// The fixture runs every step inside its own top-level await, so a chunk
// that imports from it would wait for the whole run. The app's code shared
// with the viewer is therefore kept in a chunk of its own, as the app's
// entry chunk is in the app's build; the viewer's chunk stays as the app
// has it.
// Rollup's module IDs use "/" on every platform, so the source folder is
// compared in that form (path.join would give "\\" on Windows).
const VIEWER_ONLY = ["/src/components/PdfPreview.jsx", "/src/lib/pdf-canvas.js", "/src/lib/pdf-worker.js"];
const SOURCE = `${normalizePath(path.join(root, "src"))}/`;
function fixtureChunks(id) {
  const chunk = manualChunks(id);
  if (chunk || id.includes("node_modules") || !normalizePath(id).startsWith(SOURCE)) return chunk;
  return VIEWER_ONLY.some((file) => id.endsWith(file)) ? undefined : "app";
}

export default defineConfig({
  root,
  resolve: {
    alias: {
      "@": path.join(root, "src"),
    },
  },
  // Built like the app (OUTRIGHT_UI_BUILD in ui-races.test.mjs), so a step
  // can load the preview path from production chunks. The fixture itself
  // awaits at its top level.
  build: {
    target: "es2022",
    rollupOptions: { input: path.join(root, "tests", "ui-races.html"), output: { manualChunks: fixtureChunks } },
  },
  plugins: [tailwindcss(), react(), fixtureRawFiles, pdfjsAssetsPlugin()],
});
