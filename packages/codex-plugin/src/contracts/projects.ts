import { z } from "zod";

export const projectErrorCodes = [
  "provider_not_connected",
  "provider_unauthorized",
  "provider_unavailable",
  "project_discovery_unavailable",
  "project_not_found",
  "project_forbidden",
  "selection_store_failed",
] as const;

export const providerConnectionSchema = z.object({
  providerId: z.string().min(1),
  displayName: z.string().min(1),
  state: z.enum(["disconnected", "connected", "expired"]),
  accountDisplayName: z.string().optional(),
  tenantDisplayName: z.string().optional(),
});

export const projectRefSchema = z.object({
  providerId: z.string().min(1),
  externalId: z.string().min(1),
  name: z.string().min(1),
  prettyName: z.string().optional(),
  selected: z.boolean(),
  available: z.boolean(),
  source: z.enum(["discovered", "manual"]),
  lastVerifiedAt: z.iso.datetime(),
});

export const projectCatalogSchema = z.object({
  provider: providerConnectionSchema,
  projects: z.array(projectRefSchema),
  stale: z.boolean(),
  errorCode: z.enum(projectErrorCodes).optional(),
});

export type ProjectErrorCode = (typeof projectErrorCodes)[number];
export type ProviderConnection = z.infer<typeof providerConnectionSchema>;
export type ProjectRef = z.infer<typeof projectRefSchema>;
export type ProjectCatalogResult = z.infer<typeof projectCatalogSchema>;
