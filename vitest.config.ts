import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    coverage: { enabled: false },
    exclude: ["packages/*/e2e/**", "node_modules/**", "dist/**", ".worktrees/**"],
  },
});
