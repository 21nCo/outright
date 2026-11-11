// Loads a module on demand, and loads it again after a failure without a page
// reload. The browser remembers a module that failed to load (the network, or
// a chunk gone after a rebuild) and fails the same address again without a
// request. So after a failure, the next attempt asks for the failed address,
// which Chrome and Firefox name in the error, with a query added: a new module
// to the browser, the same file to the server. An error that names no
// same-origin address (Safari) is retried with the original import.
//
// A retry imports the chunk file itself, so the chunk must export the names
// the original import gives (server/vite-chunks.mjs keeps it so). `exports`
// names what the caller uses: a module without one of them is a failure,
// never kept.
//
// Some failures only a page reload repairs, and their error carries
// reloadRequired: the named file is gone from the server (an update replaced
// its hashed name), a retry of a file the server still has failed again (a
// file it imports failed, and the browser keeps that failure), or a retry
// gave a module without the names asked for (the error named one of its
// imports, not the module), or the first import gave such a module (the
// browser keeps it). A network that is still down is not one: the next
// attempt retries. An import that has not settled within timeoutMs offers
// the reload at once, and a retry: the browser keeps waiting on the stalled
// request, so only a reload is sure to ask again.
//
// An error that names no address cannot be probed, so a chunk that is gone
// would fail every retry. After failing twice in a row that way, the error
// carries reloadRequired and retryable: the viewer offers the reload, and
// still lets the user try again in case the network was down.
let attempts = 0;

export function failedModuleUrl(error, origin) {
  const named = /\bhttps?:\/\/[^\s"']+/.exec(error?.message ?? "")?.[0];
  if (!named || !origin) return null;
  try {
    const url = new URL(named);
    return url.origin === origin ? url : null;
  } catch { return null; }
}

// Asks the server for a script: "gone" when it answers 404 or 410, or
// anything but JavaScript (a single-page fallback), "present" when it serves
// the script, "unreachable" when it cannot be asked within timeoutMs.
export async function probeScript(href, { fetchImpl = globalThis.fetch, timeoutMs = 5000, signal } = {}) {
  try {
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await fetchImpl(href, { cache: "no-store", credentials: "same-origin", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    void response.body?.cancel().catch(() => {});
    if (response.status === 404 || response.status === 410) return "gone";
    if (!response.ok) return "unreachable";
    return /javascript/i.test(response.headers.get("content-type") ?? "") ? "present" : "gone";
  } catch { return "unreachable"; }
}

export function retryingImport(load, { exports = [], importUrl = (href) => import(/* @vite-ignore */ href), origin, probe = probeScript, timeoutMs = 30_000 } = {}) {
  let loaded = null;
  let failedUrl = null;
  let unnamed = 0;
  return () => {
    if (loaded) return loaded;
    let retried = null;
    let attempt;
    if (failedUrl) {
      retried = new URL(failedUrl);
      retried.searchParams.set("retry", String(++attempts));
      attempt = importUrl(retried.href);
    } else attempt = load();
    let timer;
    const late = new Promise((resolve, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("The PDF viewer did not load in time"), { reloadRequired: true, retryable: true })), timeoutMs); });
    loaded = Promise.race([attempt, late]).finally(() => clearTimeout(timer)).then((module) => {
      const missing = exports.filter((name) => module?.[name] === undefined);
      if (missing.length) throw Object.assign(new Error(`The loaded module has no ${missing.join(", ")}`), { reloadRequired: true });
      return module;
    }, async (error) => {
      const named = failedModuleUrl(error, origin ?? globalThis.location?.origin);
      failedUrl = named ?? failedUrl;
      unnamed = failedUrl ? 0 : unnamed + 1;
      if (unnamed >= 2) Object.assign(error, { reloadRequired: true, retryable: true });
      const state = named || retried ? await probe((named ?? retried).href) : "unreachable";
      if (state === "gone" || (state === "present" && retried)) Object.assign(error, { reloadRequired: true });
      throw error;
    });
    loaded.catch(() => { loaded = null; });
    return loaded;
  };
}
