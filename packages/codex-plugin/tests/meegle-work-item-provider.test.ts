import { describe, expect, it, vi } from "vitest";

import type { MeegleMyWorkPage, MeegleUser } from "../src/meegle/meegle-cli-contracts.js";
import { MeegleCliError, type MeegleMyWorkAction } from "../src/meegle/meegle-cli-client.js";
import {
  MeegleWorkItemProvider,
  type MeegleWorkItemClient,
} from "../src/meegle/meegle-work-item-provider.js";

const now = new Date("2026-08-11T00:00:00.000Z");
const identity: MeegleUser = {
  name_cn: "Example User",
  name_en: "Example User",
  user_key: "user_example",
};

class FakeClient implements MeegleWorkItemClient {
  readonly getCurrentProfile = vi.fn(async () => "default");
  readonly getCurrentUser = vi.fn(async () => identity);
  readonly getMyWorkPage = vi.fn<MeegleWorkItemClient["getMyWorkPage"]>();
}

function rawItem(id: number, options: {
  project?: string;
  type?: string;
  node?: string;
  finish?: string;
} = {}): NonNullable<MeegleMyWorkPage["list"]>[number] {
  const project = options.project ?? "PROJ";
  return {
    ...(options.finish ? { finish_time: { finish_time: options.finish } } : {}),
    node_info: {
      node_name: options.node ?? "Planning",
      node_state_key: options.node ?? "planning",
    },
    project_key: project,
    project_name: `Project ${project}`,
    schedule: null,
    state_info: { end_state_key_name: "", start_state_key_name: "" },
    work_item_info: {
      work_item_id: id,
      work_item_name: `Item ${id}`,
      work_item_type_key: options.type ?? "task",
    },
  };
}

function pages(entries: Partial<Record<MeegleMyWorkAction, MeegleMyWorkPage[]>>) {
  return async (_profile: string, action: MeegleMyWorkAction, pageNum: number) =>
    entries[action]?.[pageNum - 1] ?? { list: null, total: 0 };
}

describe("Meegle work item provider", () => {
  it("fully paginates, deduplicates active work, and derives projects", async () => {
    const client = new FakeClient();
    const firstPage = Array.from({ length: 50 }, (_, index) => rawItem(index + 1));
    client.getMyWorkPage.mockImplementation(pages({
      this_week: [
        { list: firstPage, total: 51 },
        { list: [rawItem(51, { project: "SECOND", type: "story" })], total: 51 },
      ],
      overdue: [{ list: [rawItem(1)], total: 1 }],
      done: [{ list: null, total: 0 }],
    }));
    const provider = new MeegleWorkItemProvider({ client, clock: () => now });

    const result = await provider.listAccountWorkItems({ accountDisplayName: "Example User" });

    expect(result.projects.map((project) => project.externalId)).toEqual(["PROJ", "SECOND"]);
    const items = result.scopes.flatMap((scope) => scope.items);
    expect(items).toHaveLength(51);
    expect(items.find((item) => item.externalId === "1")?.providerStatus)
      .toContain("overdue");
    expect(client.getMyWorkPage).toHaveBeenCalledWith("default", "this_week", 2);
    expect(client.getCurrentProfile).toHaveBeenCalledTimes(2);
    expect(client.getCurrentUser).toHaveBeenCalledTimes(2);
  });

  it("continues past an exact 50-item total until an empty page confirms termination", async () => {
    const client = new FakeClient();
    client.getMyWorkPage.mockImplementation(pages({
      this_week: [
        { list: Array.from({ length: 50 }, (_, index) => rawItem(index + 1)), total: 50 },
        { list: null, total: 50 },
      ],
    }));

    await new MeegleWorkItemProvider({ client, clock: () => now })
      .listAccountWorkItems({ accountDisplayName: "Example User" });

    expect(client.getMyWorkPage).toHaveBeenCalledWith("default", "this_week", 2);
  });

  it("keeps only trusted completions from the inclusive seven-day window", async () => {
    const client = new FakeClient();
    client.getMyWorkPage.mockImplementation(pages({
      done: [{
        list: [
          rawItem(1, { finish: "2026-08-04T00:00:00.000Z", node: "done" }),
          rawItem(2, { finish: "2026-08-03T23:59:59.999Z", node: "done" }),
          rawItem(3, { node: "done" }),
        ],
        total: 3,
      }],
    }));

    const result = await new MeegleWorkItemProvider({ client, clock: () => now })
      .listAccountWorkItems({ accountDisplayName: "Example User" });

    expect(result.scopes.flatMap((scope) => scope.items).map((item) => item.externalId))
      .toEqual(["1"]);
  });

  it("returns error scopes for one failed action while preserving successful actions", async () => {
    const client = new FakeClient();
    client.getMyWorkPage.mockImplementation(async (_profile, action) => {
      if (action === "overdue") throw new MeegleCliError("provider_unavailable");
      return action === "this_week"
        ? { list: [rawItem(1)], total: 1 }
        : { list: null, total: 0 };
    });

    const result = await new MeegleWorkItemProvider({ client, clock: () => now })
      .listAccountWorkItems({ accountDisplayName: "Example User" });

    expect(result.scopes.some((scope) => scope.outcome === "success" && scope.items.length === 1))
      .toBe(true);
    expect(result.scopes.filter((scope) => scope.outcome === "error"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          providerItemType: "mywork:overdue:task",
          errorCode: "provider_unavailable",
        }),
      ]));
  });

  it("rejects results when profile or stable identity changes during synchronization", async () => {
    const profileClient = new FakeClient();
    profileClient.getCurrentProfile
      .mockResolvedValueOnce("profile-a")
      .mockResolvedValueOnce("profile-b");
    profileClient.getMyWorkPage.mockImplementation(pages({}));
    await expect(new MeegleWorkItemProvider({ client: profileClient, clock: () => now })
      .listAccountWorkItems({ accountDisplayName: "Example User" }))
      .rejects.toMatchObject({ code: "provider_unauthorized" });

    const identityClient = new FakeClient();
    identityClient.getCurrentUser
      .mockResolvedValueOnce(identity)
      .mockResolvedValueOnce({ ...identity, user_key: "other_user" });
    identityClient.getMyWorkPage.mockImplementation(pages({}));
    await expect(new MeegleWorkItemProvider({ client: identityClient, clock: () => now })
      .listAccountWorkItems({ accountDisplayName: "Example User" }))
      .rejects.toMatchObject({ code: "provider_unauthorized" });
  });

  it("drops invalid stable IDs and maps unknown active metadata conservatively", async () => {
    const client = new FakeClient();
    const invalid = rawItem(1);
    invalid.project_key = "";
    client.getMyWorkPage.mockImplementation(pages({
      this_week: [{
        list: [invalid, rawItem(2, { type: "custom", node: "unknown-state" })],
        total: 2,
      }],
    }));

    const result = await new MeegleWorkItemProvider({ client, clock: () => now })
      .listAccountWorkItems({ accountDisplayName: "Example User" });
    const items = result.scopes.flatMap((scope) => scope.items);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "other", stage: "todo" });
  });
});
