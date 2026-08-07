import { describe, expect, it } from "vitest";

import { projectCatalogSchema } from "../src/contracts/projects.js";
import {
  canonicalStages,
  taskboardSnapshotSchema,
  workItemSchema,
} from "../src/contracts/taskboard.js";
import { demoTaskboardSnapshot } from "../src/demo/fixtures.js";

describe("taskboard demo contract", () => {
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
      completedAt: "2026-08-07T00:00:00.000Z",
      externalUrl: "https://www.tapd.cn/50396062/prong/stories/view/10001",
    });

    expect(item).toMatchObject({
      kind: "requirement",
      completedAt: "2026-08-07T00:00:00.000Z",
    });
    expect(JSON.stringify(catalog)).not.toMatch(/token|authorization/i);
  });

  it("covers every canonical stage", () => {
    expect(new Set(demoTaskboardSnapshot.items.map((item) => item.stage))).toEqual(
      new Set(canonicalStages),
    );
  });
});
