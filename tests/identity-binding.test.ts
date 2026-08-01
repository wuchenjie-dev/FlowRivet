import { describe, expect, it } from "vitest";

import { verifyIdentityBinding } from "../src/identity/binding.js";

describe("verifyIdentityBinding", () => {
  it("accepts an explicit TAPD username and Feishu Open ID", () => {
    expect(
      verifyIdentityBinding({
        tapdUser: "wuchenjie",
        feishuOpenId: "ou_1234567890abcdef",
      }),
    ).toEqual({
      ok: true,
      detail: "TAPD and Feishu POC identities are explicitly bound",
    });
  });

  it("rejects a display name in place of a stable Feishu ID", () => {
    expect(() =>
      verifyIdentityBinding({
        tapdUser: "wuchenjie",
        feishuOpenId: "吴陈杰",
      }),
    ).toThrow("Feishu identity must use an Open ID");
  });
});
