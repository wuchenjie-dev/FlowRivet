import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  JsonStderrCreatedSyncDiagnosticLogger,
  createdSyncIdentityHash,
  type CreatedSyncDiagnosticEvent,
  type CreatedSyncDiagnosticLogger,
} from "../src/observability/created-sync-diagnostic-logger.js";

describe("created sync diagnostic logger", () => {
  it("hashes stable project/type identities as lower-case truncated SHA-256", () => {
    const expected = createHash("sha256")
      .update(JSON.stringify(["PRIVATE_PROJECT", "PRIVATE_TYPE"]))
      .digest("hex")
      .slice(0, 16);

    expect(createdSyncIdentityHash("PRIVATE_PROJECT", "PRIVATE_TYPE")).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{16}$/u);
  });

  it("writes one privacy-safe JSON line without raw identities or payload data", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const event: CreatedSyncDiagnosticEvent = {
      mode: "automatic",
      catalog: "available",
      totalTypeCount: 47,
      scannedTypeCount: 40,
      batchCompleted: true,
      attemptedIdentityHashes: [createdSyncIdentityHash("PRIVATE_PROJECT", "PRIVATE_TYPE")],
    };
    const logger: CreatedSyncDiagnosticLogger = new JsonStderrCreatedSyncDiagnosticLogger();

    logger.completed(event);

    expect(write).toHaveBeenCalledOnce();
    const output = String(write.mock.calls[0]?.[0]);
    expect(JSON.parse(output)).toEqual({ event: "created_sync.completed", ...event });
    expect(output).not.toContain("PRIVATE_PROJECT");
    expect(output).not.toContain("PRIVATE_TYPE");
    expect(output).not.toMatch(/account|task|cursor|session_id|cli_payload/iu);
    write.mockRestore();
  });
});
