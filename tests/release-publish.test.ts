import { describe, expect, it, vi } from "vitest";

import { publishGenericRelease } from "../scripts/release/publish-generic-package.mjs";

describe("generic package publisher", () => {
  it("uploads immutable files, verifies them, and publishes the channel pointer last", async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      return new Response(init?.method === "PUT" ? undefined : new Uint8Array([1, 2, 3]), { status: init?.method === "PUT" ? 201 : 200 });
    });
    await publishGenericRelease({ baseUrl: "https://gitlab.example", projectId: "7", version: "1.2.3", jobToken: "secret", files: [{ name: "runtime.zip", bytes: new Uint8Array([1, 2, 3]) }], manifestBytes: new Uint8Array([1, 2, 3]), fetch });
    expect(calls.at(-1)).toContain("flowrivet-channel/latest/manifest.json");
    expect(JSON.stringify(calls)).not.toContain("secret");
  });

  it("never updates the channel pointer after an immutable upload failure", async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => { calls.push(String(input)); return new Response(undefined, { status: init?.method === "PUT" ? 500 : 404 }); });
    await expect(publishGenericRelease({ baseUrl: "https://gitlab.example", projectId: "7", version: "1.2.3", jobToken: "secret", files: [{ name: "runtime.zip", bytes: new Uint8Array([1]) }], manifestBytes: new Uint8Array([2]), fetch })).rejects.toThrow("release_upload_failed");
    expect(calls.some((url) => url.includes("flowrivet-channel/latest"))).toBe(false);
  });
});
