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
