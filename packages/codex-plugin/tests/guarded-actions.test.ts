import { describe, expect, it } from "vitest";
import { ConfirmationService } from "../src/executions/confirmation-service.js";

describe("guarded actions", () => {
  it("does not treat a boolean confirmation as a challenge", () => {
    const service = new ConfirmationService({ createId: () => "challenge-1" });
    expect(() => service.consume({ challengeId: String(true), actorKey: "user-1", targetVersion: "v1" }))
      .toThrow("confirmation_missing");
  });
});
