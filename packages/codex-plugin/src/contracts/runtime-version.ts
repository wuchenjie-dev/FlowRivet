import { z } from "zod";

export const FLOWRIVET_PROTOCOL_VERSION = 1;

const semanticVersionSchema = z.string().regex(
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u,
  "Expected a semantic version",
);

export const runtimeVersionSchema = z.object({
  version: semanticVersionSchema,
  protocolVersion: z.int().positive(),
  uiVersion: semanticVersionSchema,
}).strict();

export type RuntimeVersion = z.infer<typeof runtimeVersionSchema>;

export function resolveRuntimeVersion(
  environment: Record<string, string | undefined> = process.env,
): RuntimeVersion {
  const version = environment.FLOWRIVET_RUNTIME_VERSION ?? "0.1.0";
  return runtimeVersionSchema.parse({
    version,
    protocolVersion: FLOWRIVET_PROTOCOL_VERSION,
    uiVersion: environment.FLOWRIVET_UI_VERSION ?? version,
  });
}
