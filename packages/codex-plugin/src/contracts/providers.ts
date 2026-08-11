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
export type ActiveProvider = z.infer<typeof activeProviderSchema>;
export type ProviderDescriptor = z.infer<typeof providerDescriptorSchema>;
