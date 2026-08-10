import type { ProjectRef } from "../contracts/projects.js";
import {
  workItemDetailSchema,
  type WorkItemDetail,
  type WorkItemDetailRef,
} from "../contracts/work-item-detail.js";
import {
  WorkItemDetailProviderError,
  type WorkItemDetailProvider,
} from "./work-item-detail-provider.js";

export interface WorkItemDetailRequest {
  reference: WorkItemDetailRef;
  accountDisplayName: string;
  projects: ProjectRef[];
}

export interface WorkItemDetailReader {
  get(input: WorkItemDetailRequest): Promise<WorkItemDetail>;
}

export class WorkItemDetailService implements WorkItemDetailReader {
  constructor(private readonly provider: WorkItemDetailProvider) {}

  async get(input: WorkItemDetailRequest): Promise<WorkItemDetail> {
    if (input.reference.providerId !== this.provider.id) {
      throw new WorkItemDetailProviderError("provider_not_connected");
    }

    const project = input.projects.find((candidate) =>
      candidate.available
      && candidate.providerId === input.reference.providerId
      && candidate.externalId === input.reference.projectExternalId);
    if (!project) {
      throw new WorkItemDetailProviderError("work_item_detail_forbidden");
    }

    const detail = await this.provider.getWorkItemDetail({
      reference: input.reference,
      projectName: project.name,
      accountDisplayName: input.accountDisplayName,
    });
    const parsed = workItemDetailSchema.safeParse(detail);
    if (!parsed.success || !matchesReference(parsed.data, input.reference)) {
      throw new WorkItemDetailProviderError("work_item_detail_invalid_response");
    }
    return parsed.data;
  }
}

function matchesReference(detail: WorkItemDetail, reference: WorkItemDetailRef) {
  return detail.providerId === reference.providerId
    && detail.projectExternalId === reference.projectExternalId
    && detail.providerItemType === reference.providerItemType
    && detail.externalId === reference.externalId;
}
