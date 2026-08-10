import { describe, expect, it, vi } from "vitest";

import type { WorkItemDetailRef } from "../src/contracts/work-item-detail.js";
import { ProjectProviderError } from "../src/projects/project-management-provider.js";
import { TapdWorkItemDetailProvider } from "../src/work-items/tapd-work-item-detail-provider.js";

const credentials = {
  resolve: vi.fn(async () => ({ token: "personal-token", accountDisplayName: "alice" })),
};

const baseInput = {
  reference: {
    providerId: "tapd",
    projectExternalId: "100",
    providerItemType: "story",
    externalId: "101",
  } as WorkItemDetailRef,
  projectName: "Project A",
  accountDisplayName: "alice",
};

function payload(data: unknown, status = 1) {
  return Response.json({ status, info: status === 1 ? "success" : "failed", data });
}

describe("TAPD work item detail provider", () => {
  it.each([
    ["story", "/stories"],
    ["task", "/tasks"],
    ["bug", "/bugs"],
  ] as const)("requests one %s by workspace and id", async (providerItemType, path) => {
    const row = providerItemType === "bug"
      ? { Bug: { id: "101", workspace_id: "100", title: "Bug", current_owner: "alice", status: "new" } }
      : providerItemType === "task"
        ? { Task: { id: "101", workspace_id: "100", name: "Task", owner: "alice", status: "open" } }
        : { Story: { id: "101", workspace_id: "100", name: "Story", owner: "alice", status: "planning" } };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(payload([row]));
    const provider = new TapdWorkItemDetailProvider({ credentialResolver: credentials, fetcher });

    await provider.getWorkItemDetail({
      ...baseInput,
      reference: { ...baseInput.reference, providerItemType },
    });

    const [request, init] = fetcher.mock.calls[0] ?? [];
    const url = new URL(String(request));
    expect(url.pathname).toBe(path);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      workspace_id: "100",
      id: "101",
      limit: "1",
    });
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer personal-token");
  });

  it("normalizes story fields and sanitizes its description", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(payload([{
      Story: {
        id: 101,
        workspace_id: 100,
        name: "Story detail",
        owner: "bob; alice, carol",
        creator: "dora",
        status: "planning",
        priority_label: "High",
        created: "2026-08-01T01:00:00Z",
        modified: "2026-08-02T01:00:00Z",
        due: "2026-08-20T00:00:00Z",
        completed: "2026-08-21T00:00:00Z",
        description: '<p onclick="bad()">Safe <strong>detail</strong></p><script>bad()</script>',
      },
    }]));
    const provider = new TapdWorkItemDetailProvider({ credentialResolver: credentials, fetcher });

    await expect(provider.getWorkItemDetail(baseInput)).resolves.toEqual({
      key: "tapd:100:requirement:101",
      providerId: "tapd",
      projectExternalId: "100",
      providerItemType: "story",
      externalId: "101",
      projectName: "Project A",
      kind: "requirement",
      title: "Story detail",
      providerStatus: "planning",
      priority: "High",
      assignees: ["bob", "alice", "carol"],
      creator: "dora",
      createdAt: "2026-08-01T01:00:00.000Z",
      updatedAt: "2026-08-02T01:00:00.000Z",
      dueAt: "2026-08-20T00:00:00.000Z",
      completedAt: "2026-08-21T00:00:00.000Z",
      sanitizedDescriptionHtml: "<p>Safe <strong>detail</strong></p>",
      descriptionTruncated: false,
      externalUrl: "https://www.tapd.cn/100/prong/stories/view/101",
    });
  });

  it("normalizes unwrapped bug-specific fields", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(payload([{
      id: "101",
      workspace_id: "100",
      title: "Bug detail",
      current_owner: "alice",
      reporter: "bob",
      status: "resolved",
      priority: "urgent",
      deadline: "2026-08-20T00:00:00Z",
      resolved: "2026-08-19T00:00:00Z",
    }]));
    const provider = new TapdWorkItemDetailProvider({ credentialResolver: credentials, fetcher });

    await expect(provider.getWorkItemDetail({
      ...baseInput,
      reference: { ...baseInput.reference, providerItemType: "bug" },
    })).resolves.toMatchObject({
      kind: "defect",
      creator: "bob",
      priority: "urgent",
      dueAt: "2026-08-20T00:00:00.000Z",
      completedAt: "2026-08-19T00:00:00.000Z",
      externalUrl: "https://www.tapd.cn/100/bugtrace/bugs/view/101",
    });
  });

  it.each([
    ["malice", "wrong assignee"],
    ["malice; bob", "substring assignee"],
  ])("forbids %s as a %s", async (owner) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(payload([{
      Story: { id: "101", workspace_id: "100", name: "Story", owner, status: "planning" },
    }]));
    const provider = new TapdWorkItemDetailProvider({ credentialResolver: credentials, fetcher });

    await expect(provider.getWorkItemDetail(baseInput)).rejects.toMatchObject({
      code: "work_item_detail_forbidden",
    });
  });

  it.each([
    [{ id: "999", workspace_id: "100" }, "different id"],
    [{ id: "101", workspace_id: "999" }, "different workspace"],
  ])("rejects a row with a %s (%s)", async (identity) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(payload([{
      Story: { ...identity, name: "Story", owner: "alice", status: "planning" },
    }]));
    const provider = new TapdWorkItemDetailProvider({ credentialResolver: credentials, fetcher });

    await expect(provider.getWorkItemDetail(baseInput)).rejects.toMatchObject({
      code: "work_item_detail_not_found",
    });
  });

  it.each([401, 403])("maps HTTP %s to provider_unauthorized", async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("denied", { status }));
    const provider = new TapdWorkItemDetailProvider({ credentialResolver: credentials, fetcher });

    await expect(provider.getWorkItemDetail(baseInput)).rejects.toMatchObject({
      code: "provider_unauthorized",
    });
  });

  it.each([
    [new Response("missing", { status: 404 }), "work_item_detail_not_found"],
    [new Response("failed", { status: 503 }), "provider_unavailable"],
    [payload([], 1), "work_item_detail_not_found"],
    [payload({}, 1), "work_item_detail_invalid_response"],
    [payload([], 0), "work_item_detail_invalid_response"],
  ])("maps provider response to %s", async (response, code) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    const provider = new TapdWorkItemDetailProvider({ credentialResolver: credentials, fetcher });

    await expect(provider.getWorkItemDetail(baseInput)).rejects.toMatchObject({ code });
  });

  it("maps network failures and credential errors", async () => {
    const networkProvider = new TapdWorkItemDetailProvider({
      credentialResolver: credentials,
      fetcher: vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")),
    });
    await expect(networkProvider.getWorkItemDetail(baseInput)).rejects.toMatchObject({
      code: "provider_unavailable",
    });

    const disconnectedProvider = new TapdWorkItemDetailProvider({
      credentialResolver: {
        resolve: vi.fn().mockRejectedValue(new ProjectProviderError("provider_not_connected")),
      },
    });
    await expect(disconnectedProvider.getWorkItemDetail(baseInput)).rejects.toMatchObject({
      code: "provider_not_connected",
    });
  });

  it("rejects unsupported provider item types", async () => {
    const provider = new TapdWorkItemDetailProvider({ credentialResolver: credentials });

    await expect(provider.getWorkItemDetail({
      ...baseInput,
      reference: { ...baseInput.reference, providerItemType: "epic" } as WorkItemDetailRef,
    })).rejects.toMatchObject({ code: "work_item_detail_unsupported" });
  });
});
