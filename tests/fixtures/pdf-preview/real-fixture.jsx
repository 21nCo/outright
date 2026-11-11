// Drives the real PdfPreview over real pdf.js, whose worker never answers
// Terminate (see server/pdf-preview-browser.test.mjs), and posts what it
// observed to /done.
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import PdfPreview from "@/components/PdfPreview";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, ms = 20_000) {
  const end = performance.now() + ms;
  while (!check()) {
    if (performance.now() > end) throw new Error(`Timed out waiting for ${label}; ${document.body.innerText}`);
    await wait(20);
  }
}
// pdf.js names each font it adds to the page g_<document>_….
const fonts = () => [...document.fonts].map((face) => face.family.replaceAll(/["']/g, "")).filter((family) => family.startsWith("g_"));
const viewer = (url) => {
  const host = document.body.appendChild(document.createElement("div"));
  host.style.width = "400px";
  const root = createRoot(host);
  flushSync(() => root.render(<PdfPreview url={url} name={url.slice(1)} refreshKey={0} />));
  const shown = () => ({ text: host.querySelector(".pdf-text p")?.textContent, notice: host.querySelector(".pdf-frame p[role=status]")?.textContent ?? "", canvas: host.querySelector("canvas")?.hidden === false });
  return { root, shown };
};

async function run() {
  const plain = viewer("/text.pdf");
  await until(() => plain.shown().text === "Plain page" && plain.shown().canvas && fonts().length > 0, "the plain page and its font");
  const plainFonts = fonts();
  const large = viewer("/image.pdf");
  await until(() => large.shown().text === "Large image" && large.shown().notice && fonts().length > plainFonts.length, "the page with a large image");
  const largeFonts = fonts().filter((family) => !plainFonts.includes(family));
  const result = { plain: plain.shown(), large: large.shown(), plainFonts, largeFonts };
  // Closing a document whose worker never answers: after the 3 s fallback its fonts are gone, the other's stay.
  const settled = (check) => until(check, "fonts removed", 10_000).catch(() => {});
  plain.root.unmount();
  await settled(() => !fonts().some((family) => plainFonts.includes(family)));
  await wait(200);
  result.afterPlainClosed = fonts();
  large.root.unmount();
  await settled(() => fonts().length === 0);
  result.afterBothClosed = fonts();
  return result;
}

run().then((result) => ({ ok: true, result }), (error) => ({ ok: false, error: String(error?.stack ?? error) }))
  .then((outcome) => fetch("/done", { method: "POST", body: JSON.stringify(outcome) }))
  .catch((error) => console.error(error));
