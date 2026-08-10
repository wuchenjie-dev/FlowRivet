import { describe, expect, it, vi } from "vitest";

import type { ProjectRef } from "../src/contracts/projects.js";
import type { WorkItemDetail } from "../src/contracts/work-item-detail.js";
import {
  WorkItemDetailService,
} from "../src/work-items/work-item-detail-service.js";
import {
  WorkItemDetailProviderError,
  type WorkItemDetailProvider,
} from "../src/work-items/work-item-detail-provider.js";

const reference = {
  providerId: "tapd",
  projectExternalId: "50396062",
  providerItemType: "story" as const,
  externalId: "10001",
};

const detail: WorkItemDetail = {
  key: "tapd:50396062:requirement:10001",
  ...reference,
  projectName: "FlowRivet Sandbox",
  kind: "requirement",
  title: "查看工作项详情",
  providerStatus: "planning",
  assignees: ["wuchenjie"],
  descriptionTruncated: false,
  externalUrl: "https://www.tapd.cn/50396062/prong/stories/view/10001",
};

function project(overrides: Partial<ProjectRef> = {}): ProjectRef {
  return {
    providerId: "tapd",
    externalId: "50396062",
    name: "FlowRivet Sandbox",
    selected: false,
    available: true,
    source: "discovered",
    lastVerifiedAt: "2026-08-10T00:00:00.000Z",
    ...overrides,
  };
}

class FakeProvider implements WorkItemDetailProvider {
  readonly id = "tapd";
  readonly getWorkItemDetail = vi.fn<WorkItemDetailProvider["getWorkItemDetail"]>();
}

describe("work item detail service", () => {
  it("loads detail only from an accessible matching project", async () => {
    const provider = new FakeProvider();
    provider.getWorkItemDetail.mockResolvedValue(detail);
    const service = new WorkItemDetailService(provider);

    await expect(service.get({
      reference,
      accountDisplayName: "wuchenjie",
      projects: [project()],
    })).resolves.toEqual(detail);
    expect(provider.getWorkItemDetail).toHaveBeenCalledWith({
      reference,
      projectName: "FlowRivet Sandbox",
      accountDisplayName: "wuchenjie",
    });
  });

  it.each([
    ["missing project", []],
    ["unavailable project", [project({ available: false })]],
    ["different provider", [project({ providerId: "other" })]],
  ])("rejects a %s before calling the provider", async (_label, projects) => {
    const provider = new FakeProvider();
    const service = new WorkItemDetailService(provider);

    await expect(service.get({
      reference,
      accountDisplayName: "wuchenjie",
      projects,
    })).rejects.toMatchObject({ code: "work_item_detail_forbidden" });
    expect(provider.getWorkItemDetail).not.toHaveBeenCalled();
  });

  it("rejects a provider that is not connected for the reference", async () => {
    const provider = new FakeProvider();
    const service = new WorkItemDetailService(provider);

    await expect(service.get({
      reference: { ...reference, providerId: "other" },
      accountDisplayName: "wuchenjie",
      projects: [project({ providerId: "other" })],
    })).rejects.toMatchObject({ code: "provider_not_connected" });
  });

  it("preserves stable provider error codes", async () => {
    const provider = new FakeProvider();
    provider.getWorkItemDetail.mockRejectedValue(
      new WorkItemDetailProviderError("provider_unavailable"),
    );
    const service = new WorkItemDetailService(provider);

    await expect(service.get({
      reference,
      accountDisplayName: "wuchenjie",
      projects: [project()],
    })).rejects.toMatchObject({ code: "provider_unavailable" });
  });
});
