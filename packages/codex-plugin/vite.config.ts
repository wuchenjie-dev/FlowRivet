import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const uiRoot = fileURLToPath(new URL("./src/ui", import.meta.url));

export default defineConfig({
  root: uiRoot,
  plugins: [react(), viteSingleFile()],
  define: {
    "import.meta.env.VITE_FLOWRIVET_UI_VERSION": JSON.stringify(
      process.env.VITE_FLOWRIVET_UI_VERSION
        ?? process.env.CI_COMMIT_TAG?.replace(/^v/u, "")
        ?? "0.1.0",
    ),
  },
  build: {
    outDir: `${packageRoot}/dist/ui`,
    emptyOutDir: false,
    rollupOptions: {
      input: `${uiRoot}/taskboard.html`,
    },
  },
});
