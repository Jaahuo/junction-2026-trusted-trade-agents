import { existsSync } from "node:fs";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";
import { viteSingleFile } from "vite-plugin-singlefile";

const root = resolve(import.meta.dirname, "src/views");

// Each view is one self-contained HTML file (SPEC-013).
// `vp build --mode <view>` builds src/views/<view>.html into dist/<view>.html.
// Another mode (such as development) keeps Vite's default input.
export default defineConfig(({ mode }) => {
  const input = resolve(root, `${mode}.html`);
  return {
    root,
    plugins: [react(), tailwindcss(), viteSingleFile()],
    build: {
      outDir: resolve(import.meta.dirname, "dist"),
      emptyOutDir: false,
      ...(existsSync(input) ? { rollupOptions: { input } } : {}),
    },
  };
});
