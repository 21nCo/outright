// The PDF viewer, not pdf.js, starts and ends each document's worker. Left
// to itself, pdf.js answers a worker that fails to load by parsing every
// later PDF on the page's main thread, through an import of the worker
// script that it never retries. Here a worker that fails before it is ready
// fails its document (the preview offers Retry), the next start asks for
// the script afresh, and pdf.js is given the started worker as its port, so
// it never starts one of its own.
export function pdfWorkerStarter({ createWorker = (url) => new Worker(url, { type: "module" }), base = () => globalThis.location?.href } = {}) {
  let failed = false;
  let retries = 0;
  return (scriptUrl) => {
    const address = new URL(scriptUrl, base());
    if (failed) address.searchParams.set("retry", String(++retries));
    const worker = createWorker(address.href);
    const ready = new Promise((resolve, reject) => {
      const settle = () => { worker.removeEventListener("message", onMessage); worker.removeEventListener("error", onError); };
      // pdf.js's worker says "ready" once it can take a document.
      const onMessage = ({ data }) => {
        if (data?.sourceName !== "worker" || data?.action !== "ready") return;
        settle();
        failed = false;
        resolve();
      };
      const onError = (event) => {
        settle();
        failed = true;
        worker.terminate();
        reject(new Error(`The PDF reader did not start${event?.message ? `: ${event.message}` : ""}`));
      };
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
    });
    return { worker, ready };
  };
}
