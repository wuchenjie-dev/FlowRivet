import { describe, expect, it } from "vitest";

import { authResultSchema } from "../src/contracts/auth.js";
import { projectCatalogSchema } from "../src/contracts/projects.js";
import { taskboardPreferencesSchema } from "../src/contracts/taskboard-preferences.js";
import {
  workItemDetailRefSchema,
  workItemDetailSchema,
} from "../src/contracts/work-item-detail.js";
import {
  canonicalStages,
  taskboardSnapshotSchema,
  workItemSchema,
} from "../src/contracts/taskboard.js";
import { demoTaskboardSnapshot } from "../src/demo/fixtures.js";

describe("taskboard demo contract", () => {
  it("accepts off and bounded integer refresh intervals only", () => {
    expect(taskboardPreferencesSchema.parse({ refreshIntervalSeconds: 0 }))
      .toEqual({ refreshIntervalSeconds: 0 });
    expect(taskboardPreferencesSchema.parse({ refreshIntervalSeconds: 5 }))
      .toEqual({ refreshIntervalSeconds: 5 });
    expect(taskboardPreferencesSchema.parse({ refreshIntervalSeconds: 3600 }))
      .toEqual({ refreshIntervalSeconds: 3600 });

    for (const refreshIntervalSeconds of [-1, 1, 4, 5.5, 3601, "60"]) {
      expect(taskboardPreferencesSchema.safeParse({ refreshIntervalSeconds }).success)
        .toBe(false);
    }
    expect(taskboardPreferencesSchema.safeParse({
      refreshIntervalSeconds: 60,
      providerId: "tapd",
    }).success).toBe(false);
  });

  it("provides a valid connected board snapshot", () => {
    const snapshot = {
      ...demoTaskboardSnapshot,
      readOnly: true as const,
      syncSummary: {
        successfulProjects: 2,
        failedProjects: 0,
        itemCount: demoTaskboardSnapshot.items.length,
      },
    };

    expect(taskboardSnapshotSchema.parse(snapshot)).toMatchObject({
      connection: { tapd: "connected", gitlab: "not_configured" },
      stages: ["todo", "in_progress", "in_review", "done"],
      readOnly: true,
      syncSummary: { successfulProjects: 2, failedProjects: 0, itemCount: 7 },
    });
    expect(taskboardSnapshotSchema.safeParse({ ...snapshot, readOnly: false }).success)
      .toBe(false);
  });

  it("covers every work item kind across multiple projects", () => {
    expect(new Set(demoTaskboardSnapshot.items.map((item) => item.kind))).toEqual(
      new Set(["requirement", "task", "defect", "other"]),
    );
    expect(demoTaskboardSnapshot.projects.length).toBeGreaterThan(1);
  });

  it("keeps project catalogs and work items provider neutral", () => {
    const catalog = projectCatalogSchema.parse({
      provider: { providerId: "tapd", displayName: "TAPD", state: "connected" },
      projects: [{
        providerId: "tapd",
        externalId: "50396062",
        name: "FlowRivet 测试项目",
        selected: false,
        available: true,
        source: "discovered",
        lastVerifiedAt: "2026-08-07T00:00:00.000Z",
      }],
      stale: false,
    });
    const item = workItemSchema.parse({
      key: "tapd:50396062:requirement:10001",
      providerId: "tapd",
      externalId: "10001",
      projectExternalId: "50396062",
      projectName: "FlowRivet 测试项目",
      kind: "requirement",
      providerItemType: "story",
      title: "项目发现",
      stage: "todo",
      providerStatus: "planning",
      freshness: "cached",
      completedAt: "2026-08-07T00:00:00.000Z",
      externalUrl: "https://www.tapd.cn/50396062/prong/stories/view/10001",
    });

    expect(item).toMatchObject({
      kind: "requirement",
      freshness: "cached",
      completedAt: "2026-08-07T00:00:00.000Z",
    });
    expect(JSON.stringify(catalog)).not.toMatch(/token|authorization/i);
  });

  it("exposes freshness metadata without exposing internal account keys", () => {
    const snapshot = taskboardSnapshotSchema.parse({
      ...demoTaskboardSnapshot,
      dataFreshness: "mixed",
      freshScopeCount: 1,
      staleScopeCount: 2,
      lastSuccessfulSyncAt: "2026-08-10T01:00:00.000Z",
      lastSyncAttemptAt: "2026-08-10T02:00:00.000Z",
      cacheWarningCode: "cache_write_failed",
      freshnessReasonCode: "provider_unavailable",
    });
    const auth = authResultSchema.parse({
      ok: true,
      connection: {
        tapd: "connected",
        userName: "吴晨杰",
        accountKey: "6081",
      },
    });

    expect(snapshot).toMatchObject({
      dataFreshness: "mixed",
      freshScopeCount: 1,
      staleScopeCount: 2,
      cacheWarningCode: "cache_write_failed",
      freshnessReasonCode: "provider_unavailable",
    });
    expect(auth.connection).not.toHaveProperty("accountKey");
  });

  it("covers every canonical stage", () => {
    expect(new Set(demoTaskboardSnapshot.items.map((item) => item.stage))).toEqual(
      new Set(canonicalStages),
    );
  });

  it("accepts provider-neutral work item detail references", () => {
    expect(workItemDetailRefSchema.parse({
      providerId: "tapd",
      projectExternalId: "50396062",
      providerItemType: "story",
      externalId: "10001",
    })).toEqual({
      providerId: "tapd",
      projectExternalId: "50396062",
      providerItemType: "story",
      externalId: "10001",
    });
    expect(workItemDetailRefSchema.parse({
      providerId: "tapd",
      projectExternalId: "50396062",
      providerItemType: "epic",
      externalId: "10001",
    }).providerItemType).toBe("epic");
    expect(workItemDetailRefSchema.safeParse({
      providerId: "tapd",
      projectExternalId: "50396062",
      providerItemType: "",
      externalId: "10001",
    }).success).toBe(false);
  });

  it("validates normalized work item details and HTTPS links", () => {
    const detail = {
      key: "tapd:50396062:requirement:10001",
      providerId: "tapd",
      projectExternalId: "50396062",
      providerItemType: "story",
      externalId: "10001",
      projectName: "FlowRivet Sandbox",
      kind: "requirement",
      title: "查看工作项详情",
      providerStatus: "planning",
      priority: "High",
      assignees: ["wuchenjie"],
      creator: "alice",
      createdAt: "2026-08-09T01:00:00.000Z",
      updatedAt: "2026-08-10T01:00:00.000Z",
      sanitizedDescriptionHtml: "<p>详情</p>",
      descriptionTruncated: false,
      externalUrl: "https://www.tapd.cn/50396062/prong/stories/view/10001",
    } as const;

    expect(workItemDetailSchema.parse(detail)).toEqual(detail);
    expect(workItemDetailSchema.safeParse({
      ...detail,
      externalUrl: "http://www.tapd.cn/unsafe",
    }).success).toBe(false);
  });
});
