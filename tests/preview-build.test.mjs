import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { uiFixtureBudget } from "./ui-fixture-budget.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

// Every dynamic import in the client build, with the code right after it.
// Rollup writes import("./x.js").then(m => m.p) when it gives a chunk short
// export names; a retry of that chunk's address (src/lib/module-retry.js)
// would get the short names, not the module the import asked for.
function dynamicImports(assets) {
  const found = [];
  for (const name of readdirSync(assets).filter((file) => file.endsWith(".js"))) {
    const code = readFileSync(path.join(assets, name), "utf8");
    for (const match of code.matchAll(/import\((["'])\.\/([^"']+)\1\)/g)) {
      found.push({ from: name, target: match[2], after: code.slice(match.index + match[0].length, match.index + match[0].length + 12) });
    }
  }
  return found;
}

const exportedNames = (code) => [...code.matchAll(/export\{([^}]*)\}/g)].flatMap((match) => match[1].split(","))
  .map((part) => part.trim().split(/\s+as\s+/).at(-1));

test("the production build keeps every dynamic import in the preview path retryable", { timeout: 120_000 }, async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "outright-preview-build-"));
  try {
    await build({ configFile: path.join(root, "vite.config.mjs"), logLevel: "error", build: { outDir, emptyOutDir: true } });
    const assets = path.join(outDir, "assets");
    const imports = dynamicImports(assets);
    const projected = imports.filter((entry) => entry.after.startsWith(".then("));
    assert.deepEqual(projected, [], "a dynamic import picks its module out of a shared chunk, so a retry would get other names");

    const viewer = imports.find((entry) => /^PdfPreview-[\w-]+\.js$/.test(entry.target));
    assert(viewer, `the PDF viewer is not loaded on demand: ${JSON.stringify(imports)}`);
    const viewerCode = readFileSync(path.join(assets, viewer.target), "utf8");
    assert(exportedNames(viewerCode).includes("default"), "the viewer chunk does not export its component as default");

    const library = imports.filter((entry) => entry.from === viewer.target);
    assert.equal(library.length, 1, `the viewer should load only pdf.js on demand: ${JSON.stringify(library)}`);
    const libraryNames = exportedNames(readFileSync(path.join(assets, library[0].target), "utf8"));
    for (const name of ["getDocument", "PDFWorker"]) assert(libraryNames.includes(name), `the pdf.js chunk does not export ${name}`);

    // The worker script's address is part of the viewer, not another import.
    const worker = readdirSync(assets).find((file) => /^pdf\.worker\.min-[\w-]+\.mjs$/.test(file));
    assert(worker && viewerCode.includes(worker), "the viewer does not name the built worker script");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

// The browser fixture's harness (ui-races.test.mjs) builds its page as the
// app is built and runs one step in headless Chrome: the built viewer and
// pdf.js chunks fail, and Retry and Refresh files load them without a page
// reload. The harness owns Chrome, the preview server and their cleanup
// within its own deadline, so it is stopped only after that has passed.
const { fixtureMs } = uiFixtureBudget();
test("in the production build, failed PDF viewer and pdf.js chunks load again in headless Chrome", { timeout: fixtureMs + 20_000 }, async () => {
  const env = { ...process.env, OUTRIGHT_UI_BUILD: "1", OUTRIGHT_UI_STEP: "files pdf build load" };
  delete env.NODE_TEST_CONTEXT;
  delete env.OUTRIGHT_TEST_UI_PROFILE;
  const child = spawn(process.execPath, ["--test", "--test-name-pattern=browser interaction regressions", path.join(root, "tests", "ui-races.test.mjs")], {
    cwd: root, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const timer = setTimeout(() => child.kill("SIGTERM"), fixtureMs + 15_000);
  const [code] = await new Promise((resolve) => child.once("close", (...result) => resolve(result))).finally(() => clearTimeout(timer));
  assert.equal(code, 0, output.slice(-4000));
  assert.match(output, /(?:#|ℹ) pass 1\b/, output.slice(-4000));
});
