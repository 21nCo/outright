import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { outrightApiPlugin } from "./server/outright-vite-plugin.mjs";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  build: {
    outDir: "dist/client",
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("@xterm/")) return "terminal";
          if (id.includes("@phosphor-icons/")) return "icons";
          if (id.includes("@base-ui/")) return "base-ui";
          if (id.includes("node_modules")) return "vendor";
        },
      },
    },
  },
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
    outrightApiPlugin({ configUrl: new URL("./outright.config.json", import.meta.url) }),
  ],
});
