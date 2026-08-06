import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const uiRoot = fileURLToPath(new URL("./src/ui", import.meta.url));

export default defineConfig({
  root: uiRoot,
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: `${packageRoot}/dist/ui`,
    emptyOutDir: false,
    rollupOptions: {
      input: `${uiRoot}/taskboard.html`,
    },
  },
});
