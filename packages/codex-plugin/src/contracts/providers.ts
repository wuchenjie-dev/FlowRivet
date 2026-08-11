import { z } from "zod";

export const providerConnectionStates = [
  "checking",
  "cli_missing",
  "disconnected",
  "authorizing",
  "connected",
  "expired",
  "unavailable",
] as const;

export const providerConnectionSchema = z.object({
  providerId: z.string().min(1),
  displayName: z.string().min(1),
  state: z.enum(providerConnectionStates),
  accountDisplayName: z.string().min(1).optional(),
  tenantDisplayName: z.string().min(1).optional(),
  profileName: z.string().min(1).optional(),
}).strict();

export const providerLoginTransactionSchema = z.object({
  transactionId: z.string().min(1),
  providerId: z.string().min(1),
  verificationUri: z.url().refine((value) => value.startsWith("https://")),
  userCode: z.string().min(1),
  expiresAt: z.iso.datetime(),
}).strict();

export const providerLoginStates = [
  "starting",
  "waiting",
  "verifying",
  "succeeded",
  "failed",
  "expired",
  "cancelled",
] as const;

export const providerLoginErrorCodes = [
  "provider_cli_missing",
  "provider_cli_unsupported",
  "provider_capability_unsupported",
  "provider_browser_launch_failed",
  "provider_login_denied",
  "provider_login_failed",
  "provider_login_expired",
  "provider_login_cancelled",
  "provider_identity_validation_failed",
  "provider_not_connected",
  "provider_unauthorized",
  "provider_unavailable",
  "provider_timeout",
  "provider_output_limit_exceeded",
  "provider_contract_invalid",
] as const;

export const providerLoginRecoveryActions = [
  "open_manually",
  "retry_login",
  "recheck_connection",
  "install_cli",
  "upgrade_cli",
  "none",
] as const;

export const providerLoginErrorSchema = z.object({
  code: z.enum(providerLoginErrorCodes),
  retryable: z.boolean(),
  recoveryAction: z.enum(providerLoginRecoveryActions),
  requestId: z.string().min(1),
}).strict();

const providerLoginManualFallbackSchema = z.object({
  verificationUri: z.url().refine((value) => value.startsWith("https://")),
  userCode: z.string().min(1),
}).strict();

export const providerLoginSnapshotSchema = z.object({
  sessionId: z.string().min(1),
  providerId: z.string().min(1),
  state: z.enum(providerLoginStates),
  startedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  browserLaunch: z.enum(["opened", "manual_required"]),
  error: providerLoginErrorSchema.optional(),
  manualFallback: providerLoginManualFallbackSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.manualFallback && value.browserLaunch !== "manual_required") {
    context.addIssue({
      code: "custom",
      message: "manualFallback requires manual browser launch",
      path: ["manualFallback"],
    });
  }
});

export const providerLoginToolResultSchema = z.object({
  requestId: z.string().min(1),
  session: providerLoginSnapshotSchema,
}).strict();

export const providerLoginLookupResultSchema = z.object({
  requestId: z.string().min(1),
  session: providerLoginSnapshotSchema.optional(),
}).strict();

export const activeProviderSchema = z.object({
  version: z.literal(1),
  activeProviderId: z.string().min(1),
}).strict();

export const providerDescriptorSchema = z.object({
  providerId: z.string().min(1),
  displayName: z.string().min(1),
  loginMode: z.enum(["personal_token", "device_code"]),
  connection: providerConnectionSchema,
  capabilities: z.object({
    projects: z.boolean(),
    details: z.boolean(),
  }).strict(),
}).strict();

export type ProviderConnectionState = (typeof providerConnectionStates)[number];
export type ProviderConnection = z.infer<typeof providerConnectionSchema>;
export type ProviderLoginTransaction = z.infer<typeof providerLoginTransactionSchema>;
export type ProviderLoginState = (typeof providerLoginStates)[number];
export type ProviderLoginErrorCode = (typeof providerLoginErrorCodes)[number];
export type ProviderLoginRecoveryAction = (typeof providerLoginRecoveryActions)[number];
export type ProviderLoginError = z.infer<typeof providerLoginErrorSchema>;
export type ProviderLoginSnapshot = z.infer<typeof providerLoginSnapshotSchema>;
export type ProviderLoginToolResult = z.infer<typeof providerLoginToolResultSchema>;
export type ProviderLoginLookupResult = z.infer<typeof providerLoginLookupResultSchema>;
export type ActiveProvider = z.infer<typeof activeProviderSchema>;
export type ProviderDescriptor = z.infer<typeof providerDescriptorSchema>;
