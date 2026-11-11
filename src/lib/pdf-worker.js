// The PDF viewer, not pdf.js, starts and ends each document's worker. Left
// to itself, pdf.js answers a worker that fails to load by parsing every
// later PDF on the page's main thread, through an import of the worker
// script that it never retries. Here a worker that fails before it is ready
// fails its document (the preview offers Retry), the next start asks for
// the script afresh, and pdf.js is given the started worker as its port, so
// it never starts one of its own. A worker that neither starts nor fails
// within startupMs is treated as failed, so a silent one cannot leave the
// preview reading forever. A failure whose script the server no longer has
// (an update replaced its hashed name) carries reloadRequired, since no
// retry of that address can start it. A start its caller abandons is
// cancelled: the worker ends, any probe of its script stops, and nothing is
// counted as failed. After ready, the viewer listens for the worker failing.
import { probeScript } from "./module-retry.js";

const abandoned = () => Object.assign(new Error("The PDF reader was no longer needed"), { name: "AbortError" });

export function pdfWorkerStarter({ createWorker = (url) => new Worker(url, { type: "module" }), base = () => globalThis.location?.href, startupMs = 20_000, probe = probeScript } = {}) {
  let failed = false;
  let retries = 0;
  return (scriptUrl) => {
    const address = new URL(scriptUrl, base());
    if (failed) address.searchParams.set("retry", String(++retries));
    const worker = createWorker(address.href);
    let cancel;
    const probing = new AbortController();
    const ready = new Promise((resolve, reject) => {
      let pending = true;
      // Ends the start once: true only for the first caller.
      const settle = () => { const was = pending; pending = false; clearTimeout(timer); worker.removeEventListener("message", onMessage); worker.removeEventListener("error", onError); return was; };
      // pdf.js's worker says "ready" once it can take a document.
      const onMessage = ({ data }) => {
        if (data?.sourceName !== "worker" || data?.action !== "ready" || !settle()) return;
        failed = false;
        resolve();
      };
      // The failure counts, and the next start asks for the script afresh,
      // only if no cancel came while the script was probed.
      const fail = (reason) => {
        if (!settle()) return;
        worker.terminate();
        const error = new Error(`The PDF reader did not start${reason}`);
        void probe(address.href, { signal: probing.signal }).catch(() => "unreachable").then((state) => {
          if (probing.signal.aborted) { reject(abandoned()); return; }
          failed = true;
          reject(Object.assign(error, { reloadRequired: state === "gone" }));
        });
      };
      const onError = (event) => fail(event?.message ? `: ${event.message}` : "");
      const timer = setTimeout(() => fail(" in time"), startupMs);
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
      cancel = () => {
        probing.abort();
        if (!settle()) return;
        worker.terminate();
        reject(abandoned());
      };
    });
    return { worker, ready, cancel };
  };
}
