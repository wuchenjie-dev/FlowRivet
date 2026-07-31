import type { FlowRivetConfig } from "./config.js";

export interface ProbeResult {
  ok: boolean;
  detail: string;
}

export interface DoctorProbe {
  checkPersonalAccess(config: FlowRivetConfig): Promise<ProbeResult>;
  checkAdminAccess(config: FlowRivetConfig): Promise<ProbeResult>;
}

export interface DoctorCheck extends ProbeResult {
  code: "CONFIG_ISOLATED" | "PERSONAL_AUTH" | "ADMIN_AUTH";
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

export async function runDoctor(
  config: FlowRivetConfig,
  probe: DoctorProbe,
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [
    {
      code: "CONFIG_ISOLATED",
      ok:
        config.sourceWorkspaceId !== config.sandboxWorkspaceId ||
        config.allowLiveWrites,
      detail:
        config.sourceWorkspaceId !== config.sandboxWorkspaceId
          ? "source and sandbox projects are isolated"
          : "live writes explicitly enabled",
    },
    { code: "PERSONAL_AUTH", ...(await probe.checkPersonalAccess(config)) },
    { code: "ADMIN_AUTH", ...(await probe.checkAdminAccess(config)) },
  ];

  return { ok: checks.every((check) => check.ok), checks };
}
