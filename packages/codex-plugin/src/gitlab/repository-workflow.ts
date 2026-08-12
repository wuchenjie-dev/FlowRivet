import { readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import type { GitLabProject } from "../contracts/gitlab.js";

interface GitWorkspaceClient {
  inspect(path: string): Promise<{ originProjectPath: string; clean: boolean; remotes?: Array<{ remoteName: string; projectPath: string }> }>;
  clone(url: string, target: string): Promise<void>;
}
export type RepositoryPreparer = Pick<RepositoryWorkflow, "prepare">;

export class RepositoryWorkflow {
  constructor(private readonly options: { git: GitWorkspaceClient }) {}

  async prepare(input: { project: GitLabProject; localPath?: string; parentDirectory?: string }) {
    if (input.localPath) {
      if (!isAbsolute(input.localPath)) throw new Error("repository_path_invalid");
      const inspected = await this.options.git.inspect(input.localPath);
      const matches = (inspected.remotes ?? [{ remoteName: "origin", projectPath: inspected.originProjectPath }])
        .filter((remote) => remote.projectPath === input.project.pathWithNamespace);
      if (matches.length !== 1) throw new Error("repository_remote_mismatch");
      if (!inspected.clean) throw new Error("repository_worktree_dirty");
      return { localPath: input.localPath, reused: true };
    }
    if (!input.parentDirectory || !isAbsolute(input.parentDirectory)) throw new Error("repository_parent_invalid");
    const parent = await realpath(input.parentDirectory);
    const leaf = safeLeaf(input.project.pathWithNamespace);
    const target = resolve(parent, leaf);
    const pathFromParent = relative(parent, target);
    if (!pathFromParent || pathFromParent.startsWith("..") || isAbsolute(pathFromParent)) {
      throw new Error("repository_target_invalid");
    }
    if (await exists(target)) {
      const contents = await readdir(target);
      if (contents.length > 0) throw new Error("repository_target_not_empty");
    }
    await this.options.git.clone(input.project.httpUrl, target);
    return { localPath: target, reused: false };
  }
}

function safeLeaf(projectPath: string) {
  const leaf = basename(projectPath);
  if (!/^[a-zA-Z0-9_.-]+$/u.test(leaf) || leaf === "." || leaf === "..") {
    throw new Error("repository_target_invalid");
  }
  return leaf;
}
async function exists(path: string) { try { return (await stat(path)).isDirectory(); } catch { return false; } }
