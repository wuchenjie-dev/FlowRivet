import { describe, expect, it, vi } from "vitest";

import { JsonUpdateLogger } from "../src/logging/update-logger.js";

describe("update logger", () => {
  it("writes only approved structured fields with a request ID", () => {
    const write = vi.fn();
    const logger = new JsonUpdateLogger(write);

    const requestId = logger.started("checking", { platform: "windows-x64" });
    logger.completed(requestId, "checking", {
      outcome: "error",
      errorCode: "update_registry_unreachable",
      durationMs: 12,
      unsafe: {
        authorization: "DEPLOY-TOKEN secret",
        responseBody: "task title",
      },
    } as never);

    expect(requestId).toEqual(expect.any(String));
    const output = write.mock.calls.flat().join("\n");
    expect(output).toContain(requestId);
    expect(output).toContain("update_registry_unreachable");
    expect(output).not.toMatch(/DEPLOY-TOKEN|secret|task title|responseBody|authorization/);
  });
});
