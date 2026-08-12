import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import type { WorkItemDetailRef } from "../src/contracts/work-item-detail.js";
import { MeegleWorkItemDetailProvider } from "../src/meegle/meegle-work-item-detail-provider.js";

const reference: WorkItemDetailRef = {
  providerId: "feishu-project",
  projectExternalId: "PROJ",
  providerItemType: "story",
  externalId: "10001",
};

describe("Meegle work item detail provider", () => {
  it("normalizes and sanitizes the common detail fields", async () => {
    const fixture = JSON.parse(await readFile(new URL("./fixtures/meegle/workitem-get.json", import.meta.url), "utf8"));
    const client = {
      getCurrentProfile: vi.fn(async () => "default"),
      getWorkItem: vi.fn(async () => fixture),
    };
    const provider = new MeegleWorkItemDetailProvider({ client });

    await expect(provider.getWorkItemDetail({
      reference,
      projectName: "Example Project",
      accountDisplayName: "Example Owner",
    })).resolves.toEqual(expect.objectContaining({
      ...reference,
      key: "feishu-project:PROJ:story:10001",
      title: "Example requirement",
      providerStatus: "Planning",
      priority: "High",
      assignees: ["Example Owner"],
      creator: "Example Creator",
      createdAt: "2026-08-10T01:00:00.000Z",
      updatedAt: "2026-08-12T02:00:00.000Z",
      startedAt: "2026-08-11T01:00:00.000Z",
      dueAt: "2026-08-20T01:00:00.000Z",
      sanitizedDescriptionHtml: "<p>Example <strong>description</strong></p>",
      descriptionTruncated: false,
      externalUrl: "https://project.feishu.cn/example-project/story/detail/10001",
    }));
    expect(client.getWorkItem).toHaveBeenCalledWith("default", "PROJ", "10001");
  });

  it("rejects details that do not match the requested stable identity", async () => {
    const fixture = JSON.parse(await readFile(new URL("./fixtures/meegle/workitem-get.json", import.meta.url), "utf8"));
    fixture.work_item_attribute.work_item_id = "20002";
    const provider = new MeegleWorkItemDetailProvider({ client: {
      getCurrentProfile: async () => "default",
      getWorkItem: async () => fixture,
    } });

    await expect(provider.getWorkItemDetail({
      reference,
      projectName: "Example Project",
      accountDisplayName: "Example Owner",
    })).rejects.toMatchObject({ code: "work_item_detail_invalid_response" });
  });
});
