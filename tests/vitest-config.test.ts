import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { expect, test } from "vitest";

test("root test discovery excludes isolated worktrees", async () => {
  const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const config = await readFile(resolve(repositoryRoot, "vitest.config.ts"), "utf8");

  expect(config).toContain('".worktrees/**"');
});
