import { describe, expect, it, vi } from "vitest";

import { TapdWorkItemProvider } from "../src/work-items/tapd-work-item-provider.js";

const credentials = {
  resolve: vi.fn(async () => ({ token: "personal-token", accountDisplayName: "alice" })),
};

function story(id: string, owner = "alice") {
  return { Story: {
    id,
    workspace_id: "100",
    name: `Story ${id}`,
    owner,
    status: "planning",
    priority: "high",
    due: "2026-08-20",
  } };
}

function payload(data: unknown[], status = 1) {
  return Response.json({ status, info: status === 1 ? "success" : "failed", data });
}

describe("TAPD work item provider", () => {
  it.each([
    ["delta seconds", "120", 120],
    ["HTTP date", "Fri, 07 Aug 2026 12:00:30 GMT", 30],
    ["lower bound", "1", 1],
    ["upper bound", "86400", 86400],
    ["zero", "0", 60],
    ["too large", "86401", 60],
    ["invalid", "later", 60],
    ["missing", undefined, 60],
  ])("maps a 429 Retry-After %s value and stops remaining item types", async (
    _case,
    retryAfter,
    expectedSeconds,
  ) => {
    const headers = retryAfter ? { "retry-after": retryAfter } : undefined;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("limited", { status: 429, headers }),
    );
    const provider = new TapdWorkItemProvider({
      credentialResolver: credentials,
      fetcher,
      clock: () => new Date("2026-08-07T12:00:00.000Z"),
    });

    await expect(provider.listProjectWorkItems({
      projectExternalId: "100",
      projectName: "Project A",
      accountDisplayName: "alice",
    })).resolves.toMatchObject({
      scopes: [
        {
          providerItemType: "story",
          outcome: "error",
          errorCode: "provider_rate_limited",
          retryAfterSeconds: expectedSeconds,
        },
        {
          providerItemType: "task",
          outcome: "error",
          errorCode: "provider_rate_limited",
          retryAfterSeconds: expectedSeconds,
        },
        {
          providerItemType: "bug",
          outcome: "error",
          errorCode: "provider_rate_limited",
          retryAfterSeconds: expectedSeconds,
        },
      ],
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("paginates three item types and maps only the exact assignee", async () => {
    const firstStoryPage = Array.from({ length: 200 }, (_, index) => story(String(index + 1)));
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(payload(firstStoryPage))
      .mockResolvedValueOnce(payload([story("201", "malice; bob")]))
      .mockResolvedValueOnce(payload([{
        Task: {
          id: "301", workspace_id: "100", name: "Task 301", owner: "bob; alice",
          status: "progressing", priority: "middle", due: "2026-08-18",
        },
      }]))
      .mockResolvedValueOnce(payload([{
        id: "401", workspace_id: "100", title: "Bug 401", current_owner: "alice;carol",
        status: "resolved", priority: "urgent", resolved: "2026-08-07T01:00:00Z",
      }, {
        Bug: {
          id: "402", workspace_id: "100", title: "Other owner",
          current_owner: "malice", status: "new",
        },
      }]));
    const provider = new TapdWorkItemProvider({ credentialResolver: credentials, fetcher });

    const result = await provider.listProjectWorkItems({
      projectExternalId: "100",
      projectName: "Project A",
      accountDisplayName: "alice",
    });

    expect(result).toMatchObject({
      scopes: [
        { providerItemType: "story", kind: "requirement", outcome: "success" },
        { providerItemType: "task", kind: "task", outcome: "success" },
        { providerItemType: "bug", kind: "defect", outcome: "success" },
      ],
    });
    const items = (result as unknown as { scopes: Array<{ items: unknown[] }> })
      .scopes.flatMap((scope) => scope.items);
    expect(items).toHaveLength(202);
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ externalId: "301", kind: "task", stage: "in_progress" }),
      expect.objectContaining({
        externalId: "401", kind: "defect", stage: "in_review",
        completedAt: "2026-08-07T01:00:00.000Z",
      }),
    ]));
    expect(items).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ externalId: "201" }),
      expect.objectContaining({ externalId: "402" }),
    ]));
    expect(fetcher).toHaveBeenCalledTimes(4);

    const urls = fetcher.mock.calls.map(([input]) => new URL(String(input)));
    expect(urls.map((url) => url.pathname)).toEqual([
      "/stories", "/stories", "/tasks", "/bugs",
    ]);
    expect(urls[0]?.searchParams.get("workspace_id")).toBe("100");
    expect(urls[0]?.searchParams.get("owner")).toBe("alice");
    expect(urls[0]?.searchParams.get("limit")).toBe("200");
    expect(urls[0]?.searchParams.get("page")).toBe("1");
    expect(urls[1]?.searchParams.get("page")).toBe("2");
    expect(urls[3]?.searchParams.get("current_owner")).toBe("alice");
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("authorization"))
      .toBe("Bearer personal-token");
  });

  it("keeps successful types when one endpoint fails", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(payload([story("1")]))
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(payload([]));
    const provider = new TapdWorkItemProvider({ credentialResolver: credentials, fetcher });

    await expect(provider.listProjectWorkItems({
      projectExternalId: "100",
      projectName: "Project A",
      accountDisplayName: "alice",
    })).resolves.toMatchObject({
      scopes: [
        {
          providerItemType: "story",
          outcome: "success",
          items: [expect.objectContaining({ externalId: "1" })],
        },
        {
          providerItemType: "task",
          outcome: "error",
          items: [],
          errorCode: "work_item_sync_failed",
        },
        { providerItemType: "bug", outcome: "success", items: [] },
      ],
    });
  });

  it.each([401, 403])("maps HTTP %s to provider_unauthorized", async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("denied", { status }),
    );
    const provider = new TapdWorkItemProvider({ credentialResolver: credentials, fetcher });

    await expect(provider.listProjectWorkItems({
      projectExternalId: "100",
      projectName: "Project A",
      accountDisplayName: "alice",
    })).resolves.toMatchObject({
      scopes: [
        { providerItemType: "story", outcome: "error", errorCode: "provider_unauthorized" },
        { providerItemType: "task", outcome: "error", errorCode: "provider_unauthorized" },
        { providerItemType: "bug", outcome: "error", errorCode: "provider_unauthorized" },
      ],
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("maps transport failures to provider_unavailable without omitting scopes", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(payload([]))
      .mockResolvedValueOnce(payload([]));
    const provider = new TapdWorkItemProvider({ credentialResolver: credentials, fetcher });

    await expect(provider.listProjectWorkItems({
      projectExternalId: "100",
      projectName: "Project A",
      accountDisplayName: "alice",
    })).resolves.toMatchObject({
      scopes: [
        { providerItemType: "story", outcome: "error", errorCode: "provider_unavailable" },
        { providerItemType: "task", outcome: "success" },
        { providerItemType: "bug", outcome: "success" },
      ],
    });
  });

  it("retains unknown statuses as todo without dropping the item", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(payload([{ ...story("1").Story, status: "custom_unknown" }]))
      .mockResolvedValueOnce(payload([]))
      .mockResolvedValueOnce(payload([]));
    const provider = new TapdWorkItemProvider({ credentialResolver: credentials, fetcher });

    const result = await provider.listProjectWorkItems({
      projectExternalId: "100",
      projectName: "Project A",
      accountDisplayName: "alice",
    });

    const storyScope = result.scopes.find((scope) => scope.providerItemType === "story");
    expect(storyScope?.items[0]).toMatchObject({
      providerStatus: "custom_unknown",
      stage: "todo",
    });
  });
});
