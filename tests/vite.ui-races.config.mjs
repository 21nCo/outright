import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
// Images load through <img>, not the page's fetch, so the Files fixture's
// raw PNG is served here; every other raw file is missing.
const FIXTURE_PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a70000000049454e44ae426082", "hex");
const fixtureRawFiles = {
  name: "ui-races-raw-files",
  configureServer(server) {
    server.middlewares.use("/api/files/raw", (request, response) => {
      const file = new URL(request.url, "http://fixture").searchParams.get("file");
      if (file === "logo.png" || file === "docs/logo.png") { response.setHeader("Content-Type", "image/png"); response.end(FIXTURE_PNG); return; }
      response.statusCode = 404;
      response.end();
    });
  },
};

export default defineConfig({
  root,
  resolve: {
    alias: {
      "@": path.join(root, "src"),
    },
  },
  plugins: [tailwindcss(), react(), fixtureRawFiles],
});
