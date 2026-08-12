export const COMPANION_PRODUCT = "flowrivet-companion" as const;

export interface CompanionHealthIdentity {
  product: typeof COMPANION_PRODUCT;
  pid: number;
  instanceId: string;
  runtimeVersion: string;
  protocolVersion: number;
  uiVersion: string;
}

export interface CompanionInstanceIdentity extends CompanionHealthIdentity {
  version: 1;
  processStartedAt: string;
  host: string;
  port: number;
  startedAt: string;
}

export function isCompanionInstance(value: unknown): value is CompanionInstanceIdentity {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CompanionInstanceIdentity>;
  return candidate.version === 1
    && candidate.product === COMPANION_PRODUCT
    && Number.isInteger(candidate.pid) && (candidate.pid ?? 0) > 0
    && typeof candidate.runtimeVersion === "string"
    && Number.isInteger(candidate.protocolVersion) && (candidate.protocolVersion ?? 0) > 0
    && typeof candidate.uiVersion === "string"
    && typeof candidate.processStartedAt === "string"
    && isLoopbackHost(candidate.host)
    && Number.isInteger(candidate.port) && (candidate.port ?? 0) > 0
    && typeof candidate.instanceId === "string" && candidate.instanceId.length > 0
    && typeof candidate.startedAt === "string";
}

export function isMatchingCompanionHealth(
  health: unknown,
  instance: CompanionInstanceIdentity,
): boolean {
  if (!health || typeof health !== "object") return false;
  const value = health as Record<string, unknown>;
  return value.status === "ok"
    && value.product === COMPANION_PRODUCT
    && value.pid === instance.pid
    && value.instanceId === instance.instanceId
    && value.runtimeVersion === instance.runtimeVersion
    && value.protocolVersion === instance.protocolVersion
    && value.uiVersion === instance.uiVersion;
}

export function isSameProcessStart(expected: string, actual: string): boolean {
  const expectedTime = Date.parse(expected);
  const actualTime = Date.parse(actual);
  return Number.isFinite(expectedTime) && Number.isFinite(actualTime)
    && Math.abs(expectedTime - actualTime) <= 2_000;
}

export function isLoopbackHost(host: unknown): host is string {
  if (typeof host !== "string") return false;
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/gu, "");
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}
