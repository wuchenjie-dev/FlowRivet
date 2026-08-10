export type WorkItemToolName =
  | "open_my_taskboard"
  | "list_my_work_items"
  | "refresh_my_work_items";

export interface WorkItemOperationEvent {
  requestId: string;
  tool: WorkItemToolName;
  providerId: string;
  outcome: "success" | "partial" | "error";
  durationMs: number;
  successfulProjects: number;
  failedProjects: number;
  itemCount: number;
  dataFreshness?: "live" | "mixed" | "offline";
  freshScopeCount?: number;
  staleScopeCount?: number;
  cacheOutcome?: "hit" | "miss" | "write_success" | "write_error" | "purged";
  errorCode?: string;
}

export interface WorkItemOperationLogger {
  completed(event: WorkItemOperationEvent): void;
}

export class JsonStderrWorkItemOperationLogger implements WorkItemOperationLogger {
  completed(event: WorkItemOperationEvent): void {
    process.stderr.write(`${JSON.stringify(event)}\n`);
  }
}
