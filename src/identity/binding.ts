export interface IdentityBinding {
  tapdUser: string;
  feishuOpenId: string;
}

export interface IdentityBindingResult {
  ok: true;
  detail: string;
}

export function verifyIdentityBinding(binding: IdentityBinding): IdentityBindingResult {
  if (!binding.tapdUser.trim()) throw new Error("TAPD identity is required");
  if (!/^ou_[A-Za-z0-9_-]+$/.test(binding.feishuOpenId)) {
    throw new Error("Feishu identity must use an Open ID");
  }
  return {
    ok: true,
    detail: "TAPD and Feishu POC identities are explicitly bound",
  };
}
