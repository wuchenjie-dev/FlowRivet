export interface DevelopmentGit {
  inspect(path: string): Promise<{ clean: boolean; branch: string; remotes: Array<{ remoteName: string; projectPath: string }> }>;
  push(input: { cwd: string; remoteName: string; branch: string }): Promise<void>;
  createBranch(input: { cwd: string; remoteName: string; defaultBranch: string; branch: string }): Promise<void>;
}
export interface DevelopmentGlab {
  findMergeRequest(projectPath: string, branch: string): Promise<{ iid: number; webUrl: string } | undefined>;
  createMergeRequest(input: { projectPath: string; branch: string; defaultBranch: string; title: string; description: string }): Promise<{ iid: number; webUrl: string }>;
  getPipeline(projectPath: string, branch: string): Promise<{ id: string; status: string; sha: string; webUrl: string } | undefined>;
}

export class DevelopmentWorkflow {
  constructor(private readonly options: { git: DevelopmentGit; glab: DevelopmentGlab }) {}
  async push(input: { localPath: string; projectPath: string; branch: string; defaultBranch: string }) {
    if (input.branch === input.defaultBranch || !input.branch.startsWith("codex/")) throw new Error("development_default_branch_forbidden");
    const inspected = await this.options.git.inspect(input.localPath);
    if (!inspected.clean) throw new Error("repository_worktree_dirty");
    if (inspected.branch !== input.branch) throw new Error("development_branch_mismatch");
    const matches = inspected.remotes.filter((remote) => remote.projectPath === input.projectPath);
    if (matches.length !== 1) throw new Error("repository_remote_mismatch");
    await this.options.git.push({ cwd: input.localPath, remoteName: matches[0]!.remoteName, branch: input.branch });
  }
  async createBranch(input: { localPath: string; projectPath: string; defaultBranch: string; branch: string }) {
    const inspected = await this.options.git.inspect(input.localPath);
    if (!inspected.clean) throw new Error("repository_worktree_dirty");
    const matches = inspected.remotes.filter((remote) => remote.projectPath === input.projectPath);
    if (matches.length !== 1) throw new Error("repository_remote_mismatch");
    if (inspected.branch === input.branch) return;
    await this.options.git.createBranch({ cwd: input.localPath, remoteName: matches[0]!.remoteName, defaultBranch: input.defaultBranch, branch: input.branch });
  }
  async openMergeRequest(input: { projectPath: string; branch: string; defaultBranch: string; title: string; description: string }) {
    return await this.options.glab.findMergeRequest(input.projectPath, input.branch)
      ?? this.options.glab.createMergeRequest(input);
  }
  getPipeline(projectPath: string, branch: string) { return this.options.glab.getPipeline(projectPath, branch); }
}
export type DevelopmentOperations = Pick<DevelopmentWorkflow, "createBranch" | "push" | "openMergeRequest" | "getPipeline">;

export function branchForExecution(externalId: string, _title: string) {
  const safeId = externalId.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 60) || "item";
  return `codex/${safeId}-work-item`;
}
