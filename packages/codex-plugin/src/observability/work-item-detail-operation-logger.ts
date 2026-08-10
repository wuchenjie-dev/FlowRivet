import type { ProviderWorkItemType } from "../contracts/work-item-detail.js";

export interface WorkItemDetailOperationEvent {
  requestId: string;
  tool: "get_work_item_detail";
  providerId: string;
  providerItemType: ProviderWorkItemType;
  outcome: "success" | "error";
  durationMs: number;
  errorCode?: string;
}

export interface WorkItemDetailOperationLogger {
  completed(event: WorkItemDetailOperationEvent): void;
}

export class JsonStderrWorkItemDetailOperationLogger
implements WorkItemDetailOperationLogger {
  completed(event: WorkItemDetailOperationEvent): void {
    process.stderr.write(`${JSON.stringify(event)}\n`);
  }
}
