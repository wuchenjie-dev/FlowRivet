import { z } from "zod";

import { providerConnectionSchema } from "./providers.js";

export { providerConnectionSchema } from "./providers.js";
export type { ProviderConnection } from "./providers.js";

export const projectErrorCodes = [
  "provider_not_connected",
  "provider_unauthorized",
  "provider_unavailable",
  "provider_capability_unsupported",
  "project_discovery_unavailable",
  "project_not_found",
  "project_forbidden",
  "selection_store_failed",
] as const;

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
export type ProjectRef = z.infer<typeof projectRefSchema>;
export type ProjectCatalogResult = z.infer<typeof projectCatalogSchema>;
