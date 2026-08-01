interface TapdTraceClientOptions {
  endpoint: string;
  workspaceId: string;
  personalToken: string;
  fetcher?: typeof fetch;
}

export interface RequirementCommit {
  commitId: string;
  repositoryUrl: string;
  ref: string;
  scmType: string;
}

export interface RequirementTraceReader {
  getRequirementCommits(requirementId: string): Promise<RequirementCommit[]>;
}

export class TapdTraceClient implements RequirementTraceReader {
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: TapdTraceClientOptions) {
    this.endpoint = options.endpoint.replace(/\/$/, "");
    this.fetcher = options.fetcher ?? fetch;
  }

  async getRequirementCommits(requirementId: string): Promise<RequirementCommit[]> {
    const query = new URLSearchParams({
      workspace_id: this.options.workspaceId,
      type: "story",
      object_id: requirementId,
      limit: "200",
    });
    const response = await this.fetcher(`${this.endpoint}/code_commit_infos?${query}`, {
      headers: { authorization: `Bearer ${this.options.personalToken}` },
    });
    const payload = (await response.json()) as {
      status: number;
      info: string;
      data: unknown[];
    };
    if (!response.ok || payload.status !== 1) {
      throw new Error(
        `TAPD code trace failed (${payload.status || response.status}): ${payload.info || "unknown error"}`,
      );
    }
    return payload.data.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const record = entry as Record<string, unknown>;
      return [{
        commitId: String(record.commit_id ?? ""),
        repositoryUrl: String(record.web_url ?? ""),
        ref: String(record.ref ?? ""),
        scmType: String(record.git_env ?? "unknown"),
      }];
    });
  }
}
