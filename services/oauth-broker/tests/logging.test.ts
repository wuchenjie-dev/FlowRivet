import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger, transactionRef } from "../src/logging.js";

describe("broker logging", () => {
  it("writes structured JSON and redacts OAuth credentials", async () => {
    const destination = new PassThrough();
    let output = "";
    destination.on("data", (chunk) => {
      output += chunk.toString();
    });
    const logger = createLogger("info", destination);
    const written = new Promise((resolve) => destination.once("data", resolve));

    logger.info({
      event: "test.redaction",
      accessToken: "fixture-access-token",
      clientSecret: "fixture-client-secret",
      code: "fixture-code",
      state: "fixture-state",
      codeVerifier: "fixture-verifier",
      codeChallenge: "fixture-challenge",
      authorizationUrl: "https://example.test/?code=fixture-code",
      headers: { authorization: "Bearer fixture-token" },
    });
    await written;

    const entry = JSON.parse(output) as Record<string, unknown>;
    expect(entry.event).toBe("test.redaction");
    expect(output).not.toContain("fixture-");
    expect(output.trim().split("\n")).toHaveLength(1);
  });

  it("creates a stable non-reversible transaction reference", () => {
    const reference = transactionRef("transaction-secret-id");

    expect(reference).toMatch(/^[a-f0-9]{16}$/);
    expect(reference).toBe(transactionRef("transaction-secret-id"));
    expect(reference).not.toContain("transaction-secret-id");
  });
});
