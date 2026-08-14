import { describe, expect, it } from "vitest";

import { CreatedSyncScheduler } from "../src/meegle/created-sync-scheduler.js";

type SyncType = { projectKey: string; typeKey: string };

function type(projectKey: string, typeKey: string): SyncType {
  return { projectKey, typeKey };
}

function identities(types: readonly SyncType[]): string[] {
  return types.map(({ projectKey, typeKey }) => JSON.stringify([projectKey, typeKey]));
}

function generatedTypes(count: number, projectKey = "project"): SyncType[] {
  return Array.from({ length: count }, (_, index) =>
    type(projectKey, `type-${String(index).padStart(3, "0")}`));
}

describe("CreatedSyncScheduler", () => {
  it("rotates 132 identities in 40, 40, 40, and 12 entry rounds before wrapping", () => {
    const scheduler = new CreatedSyncScheduler({ automaticLimit: 40 });
    const types = generatedTypes(132);
    const rounds: string[][] = [];

    for (let index = 0; index < 5; index += 1) {
      const batch = scheduler.select({ identityKey: "account-a", mode: "automatic", types });
      rounds.push(identities(batch.selected));
      scheduler.commit(batch.commitToken);
    }

    expect(rounds.map((round) => round.length)).toEqual([40, 40, 40, 12, 40]);
    expect(new Set(rounds.slice(0, 4).flat()).size).toBe(132);
    expect(rounds[4]).toEqual(rounds[0]);
  });

  it("splits one 47-type project across automatic rounds", () => {
    const scheduler = new CreatedSyncScheduler({ automaticLimit: 40 });
    const types = generatedTypes(47, "only-project");

    const first = scheduler.select({ identityKey: "account-a", mode: "automatic", types });
    scheduler.commit(first.commitToken);
    const second = scheduler.select({ identityKey: "account-a", mode: "automatic", types });

    expect(first.selected).toHaveLength(40);
    expect(second.selected).toHaveLength(7);
    expect([...identities(first.selected), ...identities(second.selected)])
      .toEqual(identities(types));
  });

  it("advances after the caller commits attempted entries regardless of their results", () => {
    const scheduler = new CreatedSyncScheduler({ automaticLimit: 2 });
    const types = generatedTypes(4);
    const attempted = scheduler.select({ identityKey: "account-a", mode: "automatic", types });

    // Query outcomes are deliberately absent: the scheduler tracks attempts, not results.
    scheduler.commit(attempted.commitToken);

    expect(identities(scheduler.select({
      identityKey: "account-a", mode: "automatic", types,
    }).selected)).toEqual(identities(types.slice(2)));
  });

  it("does not advance when cancellation or identity recheck prevents commit", () => {
    const scheduler = new CreatedSyncScheduler({ automaticLimit: 2 });
    const types = generatedTypes(4);
    const cancelled = scheduler.select({ identityKey: "account-a", mode: "automatic", types });
    const identityMismatch = scheduler.select({ identityKey: "account-a", mode: "automatic", types });

    expect(identityMismatch.selected).toEqual(cancelled.selected);
    expect(scheduler.select({
      identityKey: "account-a", mode: "automatic", types,
    }).selected).toEqual(cancelled.selected);
  });

  it("continues from the lexicographic successor when entries are inserted or reordered", () => {
    const scheduler = new CreatedSyncScheduler({ automaticLimit: 2 });
    const first = scheduler.select({
      identityKey: "account-a",
      mode: "automatic",
      types: [type("p", "c"), type("p", "a"), type("p", "e")],
    });
    scheduler.commit(first.commitToken);

    const next = scheduler.select({
      identityKey: "account-a",
      mode: "automatic",
      types: [type("p", "e"), type("p", "b"), type("p", "d"), type("p", "a"), type("p", "c")],
    });

    expect(next.selected).toEqual([type("p", "d"), type("p", "e")]);
  });

  it("uses the first greater identity when the last identity was deleted, then wraps at the end", () => {
    const scheduler = new CreatedSyncScheduler({ automaticLimit: 2 });
    const first = scheduler.select({
      identityKey: "account-a", mode: "automatic", types: [type("p", "a"), type("p", "c")],
    });
    scheduler.commit(first.commitToken);

    const afterDeletion = scheduler.select({
      identityKey: "account-a", mode: "automatic", types: [type("p", "a"), type("p", "b"), type("p", "d")],
    });
    expect(afterDeletion.selected).toEqual([type("p", "d")]);
    scheduler.commit(afterDeletion.commitToken);

    const wrapped = scheduler.select({
      identityKey: "account-a", mode: "automatic", types: [type("p", "a"), type("p", "c")],
    });
    expect(wrapped.selected).toEqual([type("p", "a"), type("p", "c")]);
  });

  it("keeps cursors isolated by account identity key", () => {
    const scheduler = new CreatedSyncScheduler({ automaticLimit: 2 });
    const types = generatedTypes(4);
    const accountA = scheduler.select({ identityKey: "account-a", mode: "automatic", types });
    scheduler.commit(accountA.commitToken);

    expect(scheduler.select({
      identityKey: "account-a", mode: "automatic", types,
    }).selected).toEqual(types.slice(2));
    expect(scheduler.select({
      identityKey: "account-b", mode: "automatic", types,
    }).selected).toEqual(types.slice(0, 2));
  });

  it("returns every stable identity manually without advancing the automatic cursor", () => {
    const scheduler = new CreatedSyncScheduler({ automaticLimit: 2 });
    const types = [type("p", "c"), type("p", "a"), type("p", "b")];
    const first = scheduler.select({ identityKey: "account-a", mode: "automatic", types });
    scheduler.commit(first.commitToken);

    const manual = scheduler.select({ identityKey: "account-a", mode: "manual", types });
    expect(manual).toEqual({ mode: "manual", selected: [
      type("p", "a"), type("p", "b"), type("p", "c"),
    ] });
    expect("commitToken" in manual).toBe(false);

    expect(scheduler.select({
      identityKey: "account-a", mode: "automatic", types,
    }).selected).toEqual([type("p", "c")]);
  });

  it("makes commit tokens single-use and rejects stale competing selections", () => {
    const scheduler = new CreatedSyncScheduler({ automaticLimit: 2 });
    const types = generatedTypes(4);
    const winner = scheduler.select({ identityKey: "account-a", mode: "automatic", types });
    const stale = scheduler.select({ identityKey: "account-a", mode: "automatic", types });

    scheduler.commit(winner.commitToken);
    expect(() => scheduler.commit(winner.commitToken)).toThrow("commit token has already been used");
    expect(() => scheduler.commit(stale.commitToken)).toThrow("commit token is stale");
    expect(scheduler.select({
      identityKey: "account-a", mode: "automatic", types,
    }).selected).toEqual(types.slice(2));
  });

  it("snapshots and freezes selections so caller mutation cannot change commit meaning", () => {
    const scheduler = new CreatedSyncScheduler({ automaticLimit: 2 });
    const types = [type("p", "a"), type("p", "b"), type("p", "c")];
    const batch = scheduler.select({ identityKey: "account-a", mode: "automatic", types });

    types[1]!.typeKey = "z";
    types.push(type("p", "d"));
    expect(() => (batch.selected as SyncType[]).push(type("p", "x"))).toThrow();
    expect(() => ((batch.selected[1] as SyncType).typeKey = "y")).toThrow();
    expect(batch.selected).toEqual([type("p", "a"), type("p", "b")]);

    scheduler.commit(batch.commitToken);
    expect(scheduler.select({
      identityKey: "account-a",
      mode: "automatic",
      types: [type("p", "a"), type("p", "b"), type("p", "c")],
    }).selected).toEqual([type("p", "c")]);
  });
});
