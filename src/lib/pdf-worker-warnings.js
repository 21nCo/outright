const warn = console.warn;
console.warn = (...args) => {
  if (/Image exceeded maximum allowed size/.test(String(args[0]))) self.postMessage({ action: "imageRefused" });
  warn(...args);
};
