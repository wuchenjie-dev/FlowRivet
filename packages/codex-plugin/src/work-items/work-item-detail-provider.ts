import type {
  WorkItemDetail,
  WorkItemDetailRef,
} from "../contracts/work-item-detail.js";

export const workItemDetailErrorCodes = [
  "provider_not_connected",
  "provider_unauthorized",
  "work_item_detail_forbidden",
  "work_item_detail_not_found",
  "provider_unavailable",
  "work_item_detail_invalid_response",
  "work_item_detail_unsupported",
] as const;

export type WorkItemDetailErrorCode = (typeof workItemDetailErrorCodes)[number];

export interface WorkItemDetailProvider {
  readonly id: string;
  getWorkItemDetail(input: {
    reference: WorkItemDetailRef;
    projectName: string;
    accountDisplayName: string;
  }): Promise<WorkItemDetail>;
}

export class WorkItemDetailProviderError extends Error {
  constructor(readonly code: WorkItemDetailErrorCode) {
    super(code);
    this.name = "WorkItemDetailProviderError";
  }
}
