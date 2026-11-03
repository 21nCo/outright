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
// never kept, and the next attempt starts again from the original import.
let attempts = 0;

export function failedModuleUrl(error, origin) {
  const named = /\bhttps?:\/\/[^\s"']+/.exec(error?.message ?? "")?.[0];
  if (!named || !origin) return null;
  try {
    const url = new URL(named);
    return url.origin === origin ? url : null;
  } catch { return null; }
}

export function retryingImport(load, { exports = [], importUrl = (href) => import(/* @vite-ignore */ href), origin } = {}) {
  let loaded = null;
  let failedUrl = null;
  return () => {
    if (loaded) return loaded;
    let attempt;
    if (failedUrl) {
      const fresh = new URL(failedUrl);
      fresh.searchParams.set("retry", String(++attempts));
      attempt = importUrl(fresh.href);
    } else attempt = load();
    loaded = attempt.then((module) => {
      const missing = exports.filter((name) => module?.[name] === undefined);
      if (missing.length) {
        failedUrl = null;
        throw new Error(`The loaded module has no ${missing.join(", ")}`);
      }
      return module;
    }, (error) => {
      failedUrl = failedModuleUrl(error, origin ?? globalThis.location?.origin) ?? failedUrl;
      throw error;
    });
    loaded.catch(() => { loaded = null; });
    return loaded;
  };
}
