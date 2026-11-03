import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { pdfjsAssetsPlugin } from "../server/pdfjs-assets-plugin.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
// Images load through <img>, not the page's fetch, so the Files fixture's
// raw PNG is served here; every other raw file is missing.
const FIXTURE_PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a70000000049454e44ae426082", "hex");
// A step may also serve another PNG name (/__fixture/raw?serve=late.png),
// count its reads (/__fixture/raw?reads=late.png), and fail the next loads
// of an app module (/__fixture/fail-module?path=/src/x.jsx&times=1), and
// count the requests for any address (/__fixture/requests?path=/src/x.jsx).
const servedPngs = new Set(["logo.png", "docs/logo.png"]);
const pngReads = new Map();
const failingModules = new Map();
const requestCounts = new Map();
const fixtureRawFiles = {
  name: "ui-races-raw-files",
  configureServer(server) {
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
        response.end(JSON.stringify({ count: requestCounts.get(url.searchParams.get("path")) ?? 0 }));
        return;
      }
      if (url.pathname === "/fail-module") failingModules.set(url.searchParams.get("path"), Number(url.searchParams.get("times") ?? 1));
      response.end("ok");
    });
    server.middlewares.use((request, response, next) => {
      const pathname = new URL(request.url, "http://fixture").pathname;
      requestCounts.set(pathname, (requestCounts.get(pathname) ?? 0) + 1);
      const left = failingModules.get(pathname) ?? 0;
      if (left <= 0) { next(); return; }
      failingModules.set(pathname, left - 1);
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
  },
};

export default defineConfig({
  root,
  resolve: {
    alias: {
      "@": path.join(root, "src"),
    },
  },
  plugins: [tailwindcss(), react(), fixtureRawFiles, pdfjsAssetsPlugin()],
});
