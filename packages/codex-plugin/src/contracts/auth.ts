import { z } from "zod";

export const authErrorCodes = [
  "invalid_token",
  "permission_denied",
  "tapd_unavailable",
  "credential_store_failed",
  "unsupported_platform",
  "cache_clear_failed",
  "selection_store_failed",
] as const;

export const tapdConnectionSchema = z.object({
  tapd: z.enum(["disconnected", "connected", "expired"]),
  userName: z.string().optional(),
  companyName: z.string().optional(),
});

export const authResultSchema = z.object({
  ok: z.boolean(),
  connection: tapdConnectionSchema,
  errorCode: z.enum(authErrorCodes).optional(),
});

export type AuthErrorCode = (typeof authErrorCodes)[number];
export type TapdConnection = z.infer<typeof tapdConnectionSchema>;
export type AuthResult = z.infer<typeof authResultSchema>;
