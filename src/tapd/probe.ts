import type { FlowRivetConfig } from "../config.js";
import type { ProbeResult } from "../doctor.js";

interface TapdProbeOptions {
  fetcher?: typeof fetch;
}

export class TapdDoctorProbe {
  private readonly fetcher: typeof fetch;

  constructor(options: TapdProbeOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
  }

  async checkPersonalAccess(config: FlowRivetConfig): Promise<ProbeResult> {
    return this.check(
      `${config.apiEndpoint}/workspaces/get_workspace_info?workspace_id=${config.sourceWorkspaceId}`,
      `Bearer ${config.personalToken}`,
      `source project ${config.sourceWorkspaceId} is readable`,
    );
  }

  async checkAdminAccess(config: FlowRivetConfig): Promise<ProbeResult> {
    const basic = Buffer.from(`${config.apiUser}:${config.apiPassword}`, "utf8").toString(
      "base64",
    );
    return this.check(
      `${config.apiEndpoint}/stories/custom_fields_settings?workspace_id=${config.sandboxWorkspaceId}`,
      `Basic ${basic}`,
      `sandbox project ${config.sandboxWorkspaceId} field configuration is accessible`,
    );
  }

  private async check(
    url: string,
    authorization: string,
    successDetail: string,
  ): Promise<ProbeResult> {
    try {
      const response = await this.fetcher(url, { headers: { authorization } });
      const payload = (await response.json()) as { status?: number; info?: string };
      if (!response.ok || payload.status !== 1) {
        return {
          ok: false,
          detail: `TAPD access failed (${payload.status ?? response.status}): ${payload.info ?? "unknown error"}`,
        };
      }
      return { ok: true, detail: successDetail };
    } catch (error) {
      return {
        ok: false,
        detail: `TAPD access failed: ${error instanceof Error ? error.message : "unknown error"}`,
      };
    }
  }
}
