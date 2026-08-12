import { randomUUID } from "node:crypto";
import { confirmationChallengeSchema, type ConfirmationChallenge } from "../contracts/executions.js";

export class ConfirmationError extends Error {
  constructor(readonly code: string) { super(code); this.name = "ConfirmationError"; }
}
export class ConfirmationService {
  private readonly challenges = new Map<string, ConfirmationChallenge>();
  private readonly clock: () => Date;
  private readonly createId: () => string;
  constructor(options: { clock?: () => Date; createId?: () => string } = {}) {
    this.clock = options.clock ?? (() => new Date()); this.createId = options.createId ?? randomUUID;
  }
  prepare(input: Omit<ConfirmationChallenge, "challengeId" | "expiresAt">) {
    const challenge = confirmationChallengeSchema.parse({ ...input, challengeId: this.createId(), expiresAt: new Date(this.clock().getTime() + 5 * 60_000).toISOString() });
    this.challenges.set(challenge.challengeId, challenge); return challenge;
  }
  consume(input: { challengeId: string; actorKey: string; targetVersion: string }) {
    const challenge = this.challenges.get(input.challengeId);
    if (!challenge) throw new ConfirmationError("confirmation_missing");
    if (new Date(challenge.expiresAt).getTime() <= this.clock().getTime()) {
      this.challenges.delete(input.challengeId); throw new ConfirmationError("confirmation_expired");
    }
    if (challenge.actorKey !== input.actorKey) throw new ConfirmationError("confirmation_actor_mismatch");
    if (challenge.targetVersion !== input.targetVersion) throw new ConfirmationError("confirmation_target_changed");
    this.challenges.delete(input.challengeId); return challenge;
  }
}
