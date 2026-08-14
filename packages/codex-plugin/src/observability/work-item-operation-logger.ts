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
  cacheDiagnosticCodes?: Array<"cache_read_failed" | "cache_write_failed">;
}

export interface WorkItemOperationLogger {
  completed(event: WorkItemOperationEvent): void;
}

export class JsonStderrWorkItemOperationLogger implements WorkItemOperationLogger {
  completed(event: WorkItemOperationEvent): void {
    const serialized: WorkItemOperationEvent = {
      requestId: event.requestId,
      tool: event.tool,
      providerId: event.providerId,
      outcome: event.outcome,
      durationMs: event.durationMs,
      successfulProjects: event.successfulProjects,
      failedProjects: event.failedProjects,
      itemCount: event.itemCount,
      ...(event.dataFreshness ? { dataFreshness: event.dataFreshness } : {}),
      ...(event.freshScopeCount !== undefined ? { freshScopeCount: event.freshScopeCount } : {}),
      ...(event.staleScopeCount !== undefined ? { staleScopeCount: event.staleScopeCount } : {}),
      ...(event.cacheOutcome ? { cacheOutcome: event.cacheOutcome } : {}),
      ...(event.errorCode ? { errorCode: event.errorCode } : {}),
      ...(event.cacheDiagnosticCodes
        ? { cacheDiagnosticCodes: [...event.cacheDiagnosticCodes] }
        : {}),
    };
    process.stderr.write(`${JSON.stringify(serialized)}\n`);
  }
}
