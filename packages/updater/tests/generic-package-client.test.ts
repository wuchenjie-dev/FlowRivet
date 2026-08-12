import { describe, expect, it, vi } from "vitest";

import { GenericPackageClient } from "../src/gitlab/generic-package-client.js";

describe("GitLab Generic Package client", () => {
  it("downloads the fixed channel pointer with a Deploy Token header", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    const client = new GenericPackageClient({
      baseUrl: "https://gitlab.internal.example",
      projectId: "42/path",
      deployToken: "token-value",
      fetch,
    });

    await client.downloadChannelManifest("flowrivet-channel", "latest");

    expect(fetch).toHaveBeenCalledWith(
      "https://gitlab.internal.example/api/v4/projects/42%2Fpath/packages/generic/flowrivet-channel/latest/manifest.json",
      expect.objectContaining({
        headers: expect.objectContaining({ "DEPLOY-TOKEN": "token-value" }),
        redirect: "manual",
      }),
    );
  });

  it("does not leak the token or response body in errors", async () => {
    const client = new GenericPackageClient({
      baseUrl: "https://gitlab.internal.example",
      projectId: "42",
      deployToken: "token-value",
      fetch: async () => new Response("sensitive response body", { status: 403 }),
    });

    await expect(client.downloadReleaseManifest("flowrivet-runtime", "0.2.1"))
      .rejects.toThrow("package_download_rejected");
    try {
      await client.downloadReleaseManifest("flowrivet-runtime", "0.2.1");
    } catch (error) {
      expect(String(error)).not.toMatch(/token-value|sensitive response body/);
    }
  });
});
