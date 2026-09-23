import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));

export default defineConfig({
  root,
  resolve: {
    alias: {
      "@": path.join(root, "src"),
    },
  },
  plugins: [tailwindcss(), react()],
});
