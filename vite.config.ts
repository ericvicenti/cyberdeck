import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

// Keep the renderer, worker, fonts and image decoders at the same pinned version.
// Versioned assets are additive on fleet installs so open tabs retain their build.
const require = createRequire(import.meta.url);
const pdfRoot = dirname(require.resolve("pdfjs-dist/package.json"));
const pdfVersion = JSON.parse(readFileSync(join(pdfRoot, "package.json"), "utf8")).version;
const pdfAssets = ["cmaps", "standard_fonts", "wasm", "iccs"].flatMap(group =>
  readdirSync(join(pdfRoot, group)).map(name => ({ name: `assets/pdfjs-${pdfVersion}/${group}/${name}`, file: join(pdfRoot, group, name) })));

export default defineConfig({
  root: "ui",
  plugins: [react(), tailwindcss(), {
    name: "pdf-preview-assets",
    generateBundle() {
      for (const asset of pdfAssets) this.emitFile({ type: "asset", fileName: asset.name, source: readFileSync(asset.file) });
      this.emitFile({ type: "asset", fileName: `assets/pdfjs-${pdfVersion}/LICENSE`, source: readFileSync(join(pdfRoot, "LICENSE")) });
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const asset = pdfAssets.find(asset => `/${asset.name}` === req.url?.split("?")[0]);
        if (!asset) return next();
        res.setHeader("Content-Type", asset.name.endsWith(".wasm") ? "application/wasm" : asset.name.endsWith(".js") ? "text/javascript" : "application/octet-stream");
        res.end(readFileSync(asset.file));
      });
    },
  }],
  build: {
    outDir: "../dist/ui",
    emptyOutDir: true,
    rollupOptions: {
      input: { main: "ui/index.html", spotifyPlayer: "ui/spotify-player.html" },
    },
  },
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4777",
        ws: true,
      },
    },
  },
});
