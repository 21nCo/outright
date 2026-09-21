import { createOutrightRuntime } from "./outright-runtime.mjs";

export function outrightApiPlugin({ configUrl, createRuntime = createOutrightRuntime }) {
  let runtime = null;

  return {
    name: "outright-local-runtime",
    configureServer(server) {
      runtime = createRuntime({ configUrl });
      runtime.attach(server);
    },
    // Vite awaits plugin disposal before its signal handler exits the process.
    closeBundle() {
      return runtime?.shutdown();
    },
  };
}
