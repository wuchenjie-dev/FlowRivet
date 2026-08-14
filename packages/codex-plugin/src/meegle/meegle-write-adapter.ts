import type { SupportedFieldValue } from "../contracts/writeback.js";
import { encodeFieldValue } from "../writeback/field-value-codec.js";
import type { WriteCapabilityManifest } from "../writeback/write-capability-manifest.js";
import type { MeegleCliClient } from "./meegle-cli-client.js";

const MAX_PAGES = 100;
const MAX_ITEMS = 10_000;
const MAX_RAW_BYTES = 10 * 1024 * 1024;
// Local safety bound; the remote Meegle comment limit is not probe-verified.
export const MAX_COMMENT_UTF8_BYTES = 20_000;

export type MeegleWriteAdapterErrorCode =
  | "provider_write_capability_unsupported"
  | "provider_required_fields_unsupported"
  | "provider_comment_empty"
  | "provider_comment_too_long"
  | "provider_pagination_limit";

export class MeegleWriteAdapterError extends Error {
  constructor(readonly code: MeegleWriteAdapterErrorCode) {
    super(code);
    this.name = "MeegleWriteAdapterError";
  }
}

export class MeegleWriteAdapter {
  constructor(
    private readonly client: MeegleCliClient,
    private readonly capabilities: WriteCapabilityManifest,
  ) {}

  listComments(profile: string, projectKey: string, workItemId: string) {
    return this.collectPages((page) => this.client.listCommentsPage(
      profile, projectKey, workItemId, page,
    ));
  }

  listFieldMetadata(profile: string, projectKey: string, workItemType: string) {
    return this.collectPages((page) => this.client.listFieldMetadataPage(
      profile, projectKey, workItemType, page,
    ));
  }

  listRoleMetadata(profile: string, projectKey: string, workItemType: string) {
    return this.collectPages((page) => this.client.listRoleMetadataPage(
      profile, projectKey, workItemType, page,
    ));
  }

  getWorkItemFields(
    profile: string, projectKey: string, workItemId: string, fieldKeys: readonly string[],
  ) {
    return this.client.getWorkItemFields(profile, projectKey, workItemId, fieldKeys);
  }

  async getStateMetadata(
    profile: string, projectKey: string, workItemId: string,
    workItemType: string, userKey: string,
  ) {
    const transitions = await this.client.listStateTransitions(
      profile, projectKey, workItemId, workItemType, userKey,
    );
    enforceUnpagedLimits(transitions.rawByteLength, transitions.list.length);
    let rawBytes = transitions.rawByteLength;
    let itemCount = transitions.list.length;
    const metadata = [];
    for (const transition of transitions.list) {
      const stateKey = transition.state_key;
      if (typeof stateKey !== "string" || stateKey.length === 0) {
        throw new MeegleWriteAdapterError("provider_pagination_limit");
      }
      const required = await this.client.listStateRequired(
        profile, projectKey, workItemId, stateKey,
      );
      rawBytes += required.rawByteLength;
      itemCount += required.list.length;
      enforceUnpagedLimits(rawBytes, itemCount);
      metadata.push({ transition, requiredFields: required.list });
    }
    return metadata;
  }

  async getStateRequired(
    profile: string, projectKey: string, workItemId: string, stateKey: string,
  ) {
    const required = await this.client.listStateRequired(
      profile, projectKey, workItemId, stateKey,
    );
    enforceUnpagedLimits(required.rawByteLength, required.list.length);
    return required.list;
  }

  async getNodeFieldMetadata(profile: string, projectKey: string, workItemType: string) {
    const metadata = await this.client.getNodeFieldMetadata(profile, projectKey, workItemType);
    enforceUnpagedLimits(metadata.rawByteLength, metadata.list.length);
    return metadata.list;
  }

  async createComment(profile: string, projectKey: string, workItemId: string, content: string) {
    this.requireCapability(this.capabilities.comment.enabled);
    validateComment(content);
    const result = await this.client.createComment(profile, projectKey, workItemId, content);
    return result.comment_id;
  }

  async updateComment(
    profile: string, projectKey: string, workItemId: string,
    commentId: string, content: string,
  ) {
    this.requireCapability(this.capabilities.comment.enabled);
    validateComment(content);
    const result = await this.client.updateComment(
      profile, projectKey, workItemId, commentId, content,
    );
    return result.comment_id;
  }

  async updateField(
    profile: string, projectKey: string, workItemId: string,
    fieldKey: string, value: SupportedFieldValue,
  ) {
    const capability = value.type === "user" || value.type === "multi-user"
      ? undefined
      : this.capabilities.fieldTypes[value.type];
    this.requireCapability(capability?.enabled === true);
    await this.client.updateWorkItemField(
      profile, projectKey, workItemId, fieldKey, encodeFieldValue(value),
    );
  }

  async transitionState(
    _profile: string, _projectKey: string, _workItemId: string,
    _stateKey: string, requiredFields: ReadonlyArray<unknown>,
  ): Promise<never> {
    if (requiredFields.length > 0) {
      throw new MeegleWriteAdapterError("provider_required_fields_unsupported");
    }
    this.requireCapability(this.capabilities.state.enabled);
    throw new MeegleWriteAdapterError("provider_write_capability_unsupported");
  }

  async updateNode(
    _profile: string, _projectKey: string, _workItemId: string,
    _nodeId: string, _value: unknown,
  ): Promise<never> {
    this.requireCapability(this.capabilities.node.enabled);
    throw new MeegleWriteAdapterError("provider_write_capability_unsupported");
  }

  async updateRole(
    _profile: string, _projectKey: string, _workItemId: string,
    _roleKey: string, _userKeys: string[],
  ): Promise<never> {
    this.requireCapability(this.capabilities.role.enabled);
    throw new MeegleWriteAdapterError("provider_write_capability_unsupported");
  }

  operateRole(
    profile: string, projectKey: string, workItemId: string,
    roleKey: string, userKeys: string[],
  ) {
    return this.updateRole(profile, projectKey, workItemId, roleKey, userKeys);
  }

  private async collectPages(
    load: (page: number) => Promise<{
      rawByteLength: number;
      pagination: { has_more: boolean };
      list: Array<Record<string, unknown>>;
    }>,
  ) {
    const items: Array<Record<string, unknown>> = [];
    let rawBytes = 0;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const result = await load(page);
      rawBytes += result.rawByteLength;
      items.push(...result.list);
      enforceUnpagedLimits(rawBytes, items.length);
      if (!result.pagination.has_more) return items;
    }
    throw new MeegleWriteAdapterError("provider_pagination_limit");
  }

  private requireCapability(enabled: boolean) {
    if (!enabled) {
      throw new MeegleWriteAdapterError("provider_write_capability_unsupported");
    }
  }
}

function enforceUnpagedLimits(rawBytes: number, itemCount: number) {
  if (rawBytes > MAX_RAW_BYTES || itemCount > MAX_ITEMS) {
    throw new MeegleWriteAdapterError("provider_pagination_limit");
  }
}

function validateComment(content: string) {
  if (content.trim().length === 0) {
    throw new MeegleWriteAdapterError("provider_comment_empty");
  }
  if (Buffer.byteLength(content, "utf8") > MAX_COMMENT_UTF8_BYTES) {
    throw new MeegleWriteAdapterError("provider_comment_too_long");
  }
}
