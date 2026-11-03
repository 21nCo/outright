// Loads a module on demand, and loads it again after a failure without a page
// reload. The browser remembers a module that failed to load (the network, or
// a chunk gone after a rebuild) and fails the same address again without a
// request. So after a failure, the next attempt asks for the failed address,
// which Chrome and Firefox name in the error, with a query added: a new module
// to the browser, the same file to the server. An error that names no
// same-origin address (Safari) is retried with the original import.
let attempts = 0;

export function failedModuleUrl(error, origin) {
  const named = /\bhttps?:\/\/[^\s"']+/.exec(error?.message ?? "")?.[0];
  if (!named || !origin) return null;
  try {
    const url = new URL(named);
    return url.origin === origin ? url : null;
  } catch { return null; }
}

export function retryingImport(load, { importUrl = (href) => import(/* @vite-ignore */ href), origin } = {}) {
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
    loaded = attempt.catch((error) => {
      loaded = null;
      failedUrl = failedModuleUrl(error, origin ?? globalThis.location?.origin) ?? failedUrl;
      throw error;
    });
    return loaded;
  };
}
