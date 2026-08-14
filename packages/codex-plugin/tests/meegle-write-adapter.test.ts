import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

import type { MeegleCliClient } from "../src/meegle/meegle-cli-client.js";
import {
  MeegleWriteAdapter,
  MeegleWriteAdapterError,
} from "../src/meegle/meegle-write-adapter.js";
import {
  loadWriteCapabilityManifest,
  type WriteCapabilityManifest,
} from "../src/writeback/write-capability-manifest.js";

const enabledManifest: WriteCapabilityManifest = {
  cliVersion: "1.0.19",
  probeVersion: "1",
  verifiedAt: "2026-08-13T00:00:00.000Z",
  comment: { enabled: true, list: true, create: true, read: true, update: true, repeat: true, cleanup: false },
  fieldTypes: { text: { enabled: true, write: true, read: true, repeat: true, restore: true } },
  state: { enabled: false },
  node: { enabled: false },
  role: { enabled: false },
};

function fakeClient() {
  return {
    listCommentsPage: vi.fn().mockResolvedValue({
      rawByteLength: 50, pagination: { has_more: false }, list: [],
    }),
    listFieldMetadataPage: vi.fn().mockResolvedValue({
      rawByteLength: 50, pagination: { has_more: false }, list: [],
    }),
    listRoleMetadataPage: vi.fn().mockResolvedValue({
      rawByteLength: 50, pagination: { has_more: false }, list: [],
    }),
    listStateTransitions: vi.fn().mockResolvedValue({ rawByteLength: 50, list: [] }),
    listStateRequired: vi.fn().mockResolvedValue({ rawByteLength: 50, list: [] }),
    getNodeFieldMetadata: vi.fn().mockResolvedValue({ rawByteLength: 50, list: [] }),
    getWorkItemFields: vi.fn().mockResolvedValue({ work_item_fields: [] }),
    createComment: vi.fn().mockResolvedValue({ comment_id: "comment-1" }),
    updateComment: vi.fn().mockResolvedValue({ comment_id: "comment-1" }),
    updateWorkItemField: vi.fn().mockResolvedValue({}),
  };
}

function adapter(client = fakeClient(), manifest = enabledManifest) {
  return { client, adapter: new MeegleWriteAdapter(client as unknown as MeegleCliClient, manifest) };
}

describe("Meegle write adapter", () => {
  it("fully paginates comments with pinned work item context", async () => {
    const { client, adapter: write } = adapter();
    client.listCommentsPage
      .mockResolvedValueOnce({ rawByteLength: 20, pagination: { has_more: true }, list: [{ comment_id: "1" }] })
      .mockResolvedValueOnce({ rawByteLength: 30, pagination: { has_more: false }, list: [{ comment_id: "2" }] });

    await expect(write.listComments("profile", "PROJ", "wi-1")).resolves.toEqual([
      { comment_id: "1" }, { comment_id: "2" },
    ]);
    expect(client.listCommentsPage.mock.calls).toEqual([
      ["profile", "PROJ", "wi-1", 1], ["profile", "PROJ", "wi-1", 2],
    ]);
  });

  it("enforces page, item, and raw stdout byte limits", async () => {
    const pageClient = fakeClient();
    pageClient.listCommentsPage.mockResolvedValue({ rawByteLength: 1, pagination: { has_more: true }, list: [] });
    await expect(adapter(pageClient).adapter.listComments("p", "P", "w"))
      .rejects.toMatchObject({ code: "provider_pagination_limit" });
    expect(pageClient.listCommentsPage).toHaveBeenCalledTimes(100);

    const itemClient = fakeClient();
    itemClient.listCommentsPage.mockResolvedValue({
      rawByteLength: 1, pagination: { has_more: false }, list: Array.from({ length: 10_001 }, () => ({})),
    });
    await expect(adapter(itemClient).adapter.listComments("p", "P", "w"))
      .rejects.toMatchObject({ code: "provider_pagination_limit" });

    const byteClient = fakeClient();
    byteClient.listCommentsPage.mockResolvedValue({
      rawByteLength: 10 * 1024 * 1024 + 1, pagination: { has_more: false }, list: [],
    });
    await expect(adapter(byteClient).adapter.listComments("p", "P", "w"))
      .rejects.toMatchObject({ code: "provider_pagination_limit" });
  });

  it("passes comment content as one argv value and enforces a local UTF-8 byte limit", async () => {
    const { client, adapter: write } = adapter();
    const content = "result; $(danger)\n--profile attacker";
    await expect(write.createComment("profile", "PROJ", "wi-1", content)).resolves.toBe("comment-1");
    expect(client.createComment).toHaveBeenCalledWith("profile", "PROJ", "wi-1", content);
    await expect(write.createComment("profile", "PROJ", "wi-1", "x".repeat(20_000)))
      .resolves.toBe("comment-1");
    await expect(write.createComment("profile", "PROJ", "wi-1", "x".repeat(20_001)))
      .rejects.toMatchObject({ code: "provider_comment_too_long" });
    await expect(write.createComment("profile", "PROJ", "wi-1", "界".repeat(6_667)))
      .rejects.toMatchObject({ code: "provider_comment_too_long" });
    expect(client.createComment).toHaveBeenCalledTimes(2);
    await expect(write.createComment("profile", "PROJ", "wi-1", " \r\n\t"))
      .rejects.toMatchObject({ code: "provider_comment_empty" });
  });

  it("updates exactly one verified field using the Task 2 encoder", async () => {
    const { client, adapter: write } = adapter();
    await write.updateField("profile", "PROJ", "wi-1", "result", { type: "text", value: "done" });
    expect(client.updateWorkItemField).toHaveBeenCalledWith(
      "profile", "PROJ", "wi-1", "result", "done",
    );
  });

  it("exposes single-field reads for write verification", async () => {
    const { client, adapter: write } = adapter();
    await expect(write.getWorkItemFields("profile", "PROJ", "wi-1", ["result"]))
      .resolves.toEqual({ work_item_fields: [] });
    expect(client.getWorkItemFields).toHaveBeenCalledWith(
      "profile", "PROJ", "wi-1", ["result"],
    );
  });

  it("loads the repository default manifest and rejects every write with zero client calls", async () => {
    const client = fakeClient();
    const raw = JSON.parse(readFileSync(new URL(
      "../src/writeback/meegle-write-capabilities.json", import.meta.url,
    ), "utf8"));
    const disabled = loadWriteCapabilityManifest(raw, { cliVersion: "1.0.19", probeVersion: "1" });
    const write = adapter(client, disabled).adapter;

    await expect(write.listFieldMetadata("p", "P", "story")).resolves.toEqual([]);
    client.listFieldMetadataPage.mockClear();

    await expect(write.createComment("p", "P", "w", "content"))
      .rejects.toMatchObject({ code: "provider_write_capability_unsupported" });
    await expect(write.updateComment("p", "P", "w", "comment-1", "content"))
      .rejects.toMatchObject({ code: "provider_write_capability_unsupported" });
    await expect(write.updateField("p", "P", "w", "result", { type: "text", value: "done" }))
      .rejects.toMatchObject({ code: "provider_write_capability_unsupported" });
    await expect(write.transitionState("p", "P", "w", "done", []))
      .rejects.toMatchObject({ code: "provider_write_capability_unsupported" });
    await expect(write.updateNode("p", "P", "w", "node-1", {}))
      .rejects.toMatchObject({ code: "provider_write_capability_unsupported" });
    await expect(write.operateRole("p", "P", "w", "owner", ["user-1"]))
      .rejects.toMatchObject({ code: "provider_write_capability_unsupported" });
    expect(Object.values(client).every((method) => method.mock.calls.length === 0)).toBe(true);
  });

  it("allows metadata reads while independently gating state, node, and role writes", async () => {
    const { client, adapter: write } = adapter();
    client.listStateTransitions.mockResolvedValue({
      rawByteLength: 50, list: [{ state_key: "done" }, { state_key: "closed" }],
    });
    client.listStateRequired
      .mockResolvedValueOnce({ rawByteLength: 20, list: [] })
      .mockResolvedValueOnce({ rawByteLength: 20, list: [] });
    await expect(write.getStateMetadata("p", "P", "w", "story", "user-1")).resolves.toEqual([
      { transition: { state_key: "done" }, requiredFields: [] },
      { transition: { state_key: "closed" }, requiredFields: [] },
    ]);
    expect(client.listStateTransitions).toHaveBeenCalledWith("p", "P", "w", "story", "user-1");
    expect(client.listStateRequired.mock.calls).toEqual([
      ["p", "P", "w", "done"], ["p", "P", "w", "closed"],
    ]);

    await expect(write.transitionState("p", "P", "w", "done", [{ field_key: "required" }]))
      .rejects.toMatchObject({ code: "provider_required_fields_unsupported" });
    await expect(write.updateNode("p", "P", "w", "node-1", {}))
      .rejects.toMatchObject({ code: "provider_write_capability_unsupported" });
    await expect(write.updateRole("p", "P", "w", "owner", ["user-1"]))
      .rejects.toMatchObject({ code: "provider_write_capability_unsupported" });
  });

  it("uses stable adapter errors", () => {
    expect(new MeegleWriteAdapterError("provider_pagination_limit").message)
      .toBe("provider_pagination_limit");
  });
});
