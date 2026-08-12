import { describe, expect, it } from "vitest";
import { ConfirmationService } from "../src/executions/confirmation-service.js";

describe("ConfirmationService", () => {
  it("binds a challenge to actor target version and one use", () => {
    let now = new Date("2026-08-12T00:00:00.000Z");
    const service = new ConfirmationService({ clock: () => now, createId: () => "challenge-1" });
    const challenge = service.prepare({ operationId: "operation-1", action: "merge_mr", actorKey: "user-1", targetVersion: "sha-1", summary: { title: "合并 MR !9", details: ["cc/flowrivet"] } });
    expect(() => service.consume({ challengeId: challenge.challengeId, actorKey: "user-2", targetVersion: "sha-1" })).toThrow("confirmation_actor_mismatch");
    expect(() => service.consume({ challengeId: challenge.challengeId, actorKey: "user-1", targetVersion: "sha-2" })).toThrow("confirmation_target_changed");
    expect(service.consume({ challengeId: challenge.challengeId, actorKey: "user-1", targetVersion: "sha-1" })).toEqual(challenge);
    expect(() => service.consume({ challengeId: challenge.challengeId, actorKey: "user-1", targetVersion: "sha-1" })).toThrow("confirmation_missing");
    now = new Date("2026-08-12T00:10:00.000Z");
    const expired = service.prepare({ operationId: "operation-2", action: "retry_pipeline", actorKey: "user-1", targetVersion: "12", summary: { title: "重试 Pipeline 12", details: [] } });
    now = new Date("2026-08-12T00:16:00.000Z");
    expect(() => service.consume({ challengeId: expired.challengeId, actorKey: "user-1", targetVersion: "12" })).toThrow("confirmation_expired");
  });
});
