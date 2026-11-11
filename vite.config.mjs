import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { outrightApiPlugin } from "./server/outright-vite-plugin.mjs";
import { pdfjsAssetsPlugin } from "./server/pdfjs-assets-plugin.mjs";
import { manualChunks } from "./server/vite-chunks.mjs";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  build: {
    outDir: "dist/client",
    rollupOptions: {
      output: { manualChunks },
    },
  },
  worker: { format: "es" },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: process.env.OUTRIGHT_HOST || "127.0.0.1",
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [
    tailwindcss(),
    react(),
    pdfjsAssetsPlugin(),
    outrightApiPlugin({ configUrl: new URL("./outright.config.json", import.meta.url) }),
  ],
});
