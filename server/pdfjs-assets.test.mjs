import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pdfjsAssetHeaders, pdfjsAssetsPlugin } from "./pdfjs-assets-plugin.mjs";
import { clientFiles } from "./standalone-host.mjs";

test("the built client serves pdf.js assets with the development server's headers, and a missing one is a 404", { timeout: 30_000 }, async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "outright-client-"));
  let server;
  // One ordered teardown: drop the client's keep-alive sockets, wait for the
  // server (and the files it streamed) to close, then remove the folder,
  // which Windows refuses while a file in it is still open.
  t.after(async () => {
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  mkdirSync(path.join(directory, "pdfjs", "cmaps"), { recursive: true });
  mkdirSync(path.join(directory, "pdfjs", "standard_fonts"), { recursive: true });
  writeFileSync(path.join(directory, "index.html"), "<!doctype html><title>Outright</title>");
  writeFileSync(path.join(directory, "pdfjs", "cmaps", "Adobe-Japan1-UCS2.bcmap"), Buffer.from([0xe0, 1, 2]));
  writeFileSync(path.join(directory, "pdfjs", "standard_fonts", "FoxitSans.pfb"), "<html><script>alert(1)</script>");
  const files = clientFiles(directory);
  server = createServer((request, response) => files(request, response, () => { response.statusCode = 404; response.end(); }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  // Each body is read to its end, so no response holds its file open.
  const get = async (pathname) => {
    const response = await fetch(new URL(pathname, `http://127.0.0.1:${server.address().port}`));
    return Object.assign(response, { bytes: Buffer.from(await response.arrayBuffer()) });
  };
  for (const pathname of ["/pdfjs/cmaps/Adobe-Japan1-UCS2.bcmap", "/pdfjs/standard_fonts/FoxitSans.pfb"]) {
    const response = await get(pathname);
    assert.equal(response.status, 200, pathname);
    assert.deepEqual(response.bytes, readFileSync(path.join(directory, pathname)), pathname);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff", pathname);
    assert.equal(response.headers.get("content-type"), pdfjsAssetHeaders(pathname)["Content-Type"], pathname);
    assert.equal(response.headers.get("content-type"), "application/octet-stream", pathname);
  }
  assert.equal((await get("/pdfjs/cmaps/missing.bcmap")).status, 404);
  // The app's own pages are unchanged.
  const page = await get("/projects/anything");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  assert.equal(page.headers.get("x-content-type-options"), null);
});

test("only a /pdfjs/<folder>/<name> address gets pdf.js asset headers", () => {
  assert.deepEqual(pdfjsAssetHeaders("/pdfjs/wasm/openjpeg.wasm"), { "Content-Type": "application/wasm", "X-Content-Type-Options": "nosniff" });
  for (const pathname of ["/index.html", "/pdfjs/other/x.bcmap", "/pdfjs/cmaps/../x", "/pdfjs/cmaps/a/b", "/assets/pdfjs/cmaps/x.bcmap"]) assert.equal(pdfjsAssetHeaders(pathname), null, pathname);
});

test("the development server serves a pdf.js asset whether its request target is a path or an absolute URL, and answers any other /pdfjs/ address with a 404", () => {
  let middleware;
  pdfjsAssetsPlugin().configureServer({ middlewares: { use: (mount, handler) => { assert.equal(mount, "/pdfjs"); middleware = handler; } } });
  const asset = readFileSync(path.join(path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json")), "cmaps", "78-EUC-H.bcmap"));
  // Connect strips the mount from the path but keeps an absolute-form request's scheme and host.
  for (const url of ["/cmaps/78-EUC-H.bcmap?v=1", "http://localhost:5173/cmaps/78-EUC-H.bcmap?v=1", "/cmaps/../package.json", "/cmaps/missing.bcmap", "/other/x.bcmap", "/"]) {
    const headers = {};
    const response = { statusCode: 200, setHeader: (name, value) => { headers[name] = value; }, end: (data) => { response.body = data ?? null; } };
    let passed = false;
    // Nothing reaches the next middleware, so Vite's page fallback never answers for a pdf.js asset.
    middleware({ url }, response, () => { passed = true; });
    assert.ok(!passed, url);
    if (!url.includes("78-EUC-H")) { assert.deepEqual([response.statusCode, response.body, headers], [404, null, {}], url); continue; }
    assert.equal(response.statusCode, 200, url);
    assert.deepEqual(response.body, asset, url);
    assert.deepEqual(headers, pdfjsAssetHeaders("/pdfjs/cmaps/78-EUC-H.bcmap"), url);
  }
});
