import type { ProjectRef } from "../contracts/projects.js";
import type { WorkItem } from "../contracts/taskboard.js";
import {
  WorkItemProviderError,
  type WorkItemProvider,
} from "./work-item-provider.js";

export interface WorkItemSyncInput {
  accountDisplayName: string;
  projects: ProjectRef[];
}

export interface WorkItemSyncSnapshot {
  items: WorkItem[];
  projects: Array<ProjectRef & { count: number }>;
  summary: {
    successfulProjects: number;
    failedProjects: number;
    itemCount: number;
  };
}

export interface WorkItemSynchronizer {
  sync(input: WorkItemSyncInput): Promise<WorkItemSyncSnapshot>;
}

export class WorkItemService implements WorkItemSynchronizer {
  private inFlight?: Promise<WorkItemSyncSnapshot>;

  constructor(
    private readonly provider: WorkItemProvider,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  sync(input: WorkItemSyncInput): Promise<WorkItemSyncSnapshot> {
    if (this.inFlight) return this.inFlight;
    const operation = this.performSync(input);
    this.inFlight = operation.finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async performSync(input: WorkItemSyncInput): Promise<WorkItemSyncSnapshot> {
    const projects = input.projects.filter((project) => project.available);
    const results = new Map<string, WorkItem[]>();
    let successfulProjects = 0;
    let failedProjects = 0;
    let usableProjects = 0;
    let nextIndex = 0;

    const consumeNextProject = async (): Promise<void> => {
      while (nextIndex < projects.length) {
        const project = projects[nextIndex++];
        if (!project) return;
        try {
          const result = await this.provider.listProjectWorkItems({
            projectExternalId: project.externalId,
            projectName: project.name,
            accountDisplayName: input.accountDisplayName,
          });
          const successfulScopes = result.scopes.filter((scope) => scope.outcome === "success");
          const failedScopes = result.scopes.length - successfulScopes.length;
          results.set(project.externalId, successfulScopes.flatMap((scope) => scope.items));
          if (failedScopes === 0) {
            successfulProjects += 1;
          } else {
            failedProjects += 1;
          }
          if (successfulScopes.length > 0) usableProjects += 1;
        } catch {
          failedProjects += 1;
          results.set(project.externalId, []);
        }
      }
    };

    const workerCount = Math.min(4, projects.length);
    await Promise.all(Array.from({ length: workerCount }, consumeNextProject));
    if (projects.length > 0 && usableProjects === 0) {
      throw new WorkItemProviderError("work_item_sync_failed");
    }

    const cutoff = this.clock().getTime() - 7 * 24 * 60 * 60 * 1000;
    const items = [...results.values()]
      .flat()
      .filter((item) => item.stage !== "done"
        || Boolean(item.completedAt && new Date(item.completedAt).getTime() >= cutoff))
      .sort(compareItems);
    const counts = new Map<string, number>();
    for (const item of items) {
      counts.set(item.projectExternalId, (counts.get(item.projectExternalId) ?? 0) + 1);
    }
    const countedProjects = projects
      .map((project) => ({ ...project, count: counts.get(project.externalId) ?? 0 }))
      .sort((left, right) => left.name.localeCompare(right.name)
        || left.externalId.localeCompare(right.externalId));

    return {
      items,
      projects: countedProjects,
      summary: {
        successfulProjects,
        failedProjects,
        itemCount: items.length,
      },
    };
  }
}

function compareItems(left: WorkItem, right: WorkItem) {
  return left.projectName.localeCompare(right.projectName)
    || left.kind.localeCompare(right.kind)
    || left.externalId.localeCompare(right.externalId);
}
