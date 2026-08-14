import { describe, expect, it } from "vitest";

import type { ProjectRef } from "../src/contracts/projects.js";
import type { WorkItem } from "../src/contracts/taskboard.js";
import {
  mergeWorkItemSnapshot,
  normalizeAuthoritativeScopeInventories,
} from "../src/cache/merge-work-item-snapshot.js";
import type { CacheAccount, CacheMergeInput, CachedSnapshot } from "../src/cache/work-item-cache-store.js";

const now = new Date("2026-08-14T12:00:00.000Z");
const account: CacheAccount = { providerId: "feishu-project", accountKey: "user-1", tenantKey: "tenant-1", accountDisplayName: "Alice" };

function project(externalId: string): ProjectRef {
  return { providerId: account.providerId, externalId, name: `Project ${externalId}`, selected: true, available: true, source: "discovered", lastVerifiedAt: now.toISOString() };
}

function item(externalId: string, providerItemType: string): WorkItem {
  return { key: `${account.providerId}:A:${providerItemType}:${externalId}`, providerId: account.providerId, externalId, projectExternalId: "A", projectName: "Project A", kind: "other", providerItemType, title: externalId, stage: "todo", providerStatus: "open", freshness: "cached" };
}

function previous(): CachedSnapshot {
  const scopes = ["created:old", "created:kept", "created:unscanned", "mywork:todo:task"].map((providerItemType) => ({ projectExternalId: "A", providerItemType, kind: "other" as const, freshness: "cached" as const, lastSuccessfulSyncAt: "2026-08-13T12:00:00.000Z", items: [item(providerItemType, providerItemType)] }));
  return { account: { providerId: account.providerId, accountDisplayName: "Alice" }, projects: [project("A")], scopes, items: scopes.flatMap((scope) => scope.items), lastSuccessfulSyncAt: "2026-08-13T12:00:00.000Z" };
}

function input(overrides: Partial<CacheMergeInput> = {}): CacheMergeInput {
  return { account, projects: [project("A")], scopes: [], now, ...overrides };
}

describe("mergeWorkItemSnapshot", () => {
  it("retains unscanned inventory types while pruning types deleted from metadata", () => {
    const merged = mergeWorkItemSnapshot(previous(), input({
      scopes: [{ projectExternalId: "A", providerItemType: "created:kept", kind: "other", outcome: "success", items: [{ ...item("fresh", "created:kept"), freshness: "fresh" }] }],
      authoritativeScopePrefixes: [{ projectExternalId: "A", providerItemTypePrefix: "created:" }],
      authoritativeScopeInventories: [{ projectExternalId: "A", providerItemTypePrefix: "created:", providerItemTypes: ["created:unscanned", "created:kept"] }],
    }));

    expect(merged.scopes.map((scope) => scope.providerItemType).sort()).toEqual(["created:kept", "created:unscanned", "mywork:todo:task"]);
    expect(merged.scopes.find((scope) => scope.providerItemType === "created:kept")).toMatchObject({ freshness: "fresh", items: [{ externalId: "fresh", freshness: "fresh" }] });
    expect(merged.scopes.find((scope) => scope.providerItemType === "created:unscanned")).toMatchObject({ freshness: "cached" });
  });

  it("lets an empty inventory delete old created scopes and insert only the current catalog sentinel", () => {
    const merged = mergeWorkItemSnapshot(previous(), input({
      scopes: [{ projectExternalId: "A", providerItemType: "created:catalog", kind: "other", outcome: "success", items: [] }],
      authoritativeScopeInventories: [{ projectExternalId: "A", providerItemTypePrefix: "created:", providerItemTypes: [] }],
    }));
    expect(merged.scopes.map((scope) => scope.providerItemType).sort()).toEqual(["created:catalog", "mywork:todo:task"]);
  });

  it("normalizes inventories without mutation and rejects invalid authority", () => {
    const inventories = [{ projectExternalId: " A ", providerItemTypePrefix: " created: ", providerItemTypes: [" created:z ", "created:a"] }];
    expect(normalizeAuthoritativeScopeInventories(inventories)).toEqual([{ projectExternalId: "A", providerItemTypePrefix: "created:", providerItemTypes: ["created:a", "created:z"] }]);
    expect(inventories[0]?.providerItemTypes).toEqual([" created:z ", "created:a"]);

    const invalid = [
      [{ projectExternalId: "", providerItemTypePrefix: "created:", providerItemTypes: [] }],
      [{ projectExternalId: "A", providerItemTypePrefix: "", providerItemTypes: [] }],
      [{ projectExternalId: "A", providerItemTypePrefix: "created:", providerItemTypes: [""] }],
      [{ projectExternalId: "A", providerItemTypePrefix: "created:", providerItemTypes: ["created:"] }],
      [{ projectExternalId: "A", providerItemTypePrefix: "created:", providerItemTypes: ["other:x"] }],
      [{ projectExternalId: "A", providerItemTypePrefix: "created:", providerItemTypes: ["created:x", "created:x"] }],
      [{ projectExternalId: "A", providerItemTypePrefix: "created:", providerItemTypes: ["created:catalog"] }],
      [{ projectExternalId: "A", providerItemTypePrefix: "created:", providerItemTypes: [] }, { projectExternalId: "A", providerItemTypePrefix: "created:", providerItemTypes: [] }],
    ];
    for (const value of invalid) expect(() => normalizeAuthoritativeScopeInventories(value)).toThrow(/inventory/i);
  });

  it("rejects duplicate item keys inside one successful scope like SQLite", () => {
    const duplicate = { ...item("duplicate", "created:x"), freshness: "fresh" as const };
    expect(() => mergeWorkItemSnapshot(undefined, input({
      scopes: [{
        projectExternalId: "A",
        providerItemType: "created:x",
        kind: "other",
        outcome: "success",
        items: [duplicate, duplicate],
      }],
    }))).toThrow(/duplicate cache item key/i);
  });
});
