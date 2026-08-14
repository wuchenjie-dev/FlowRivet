import { projectRefSchema, type ProjectRef } from "../contracts/projects.js";
import { workItemSchema, type WorkItem } from "../contracts/taskboard.js";
import type {
  CacheMergeInput,
  CachedScope,
  CachedSnapshot,
} from "./work-item-cache-store.js";

export type AuthoritativeScopeInventory = NonNullable<
  CacheMergeInput["authoritativeScopeInventories"]
>[number];

export function normalizeAuthoritativeScopeInventories(
  inventories: readonly AuthoritativeScopeInventory[] = [],
): AuthoritativeScopeInventory[] {
  const identities = new Set<string>();
  return inventories.map((inventory) => {
    const projectExternalId = inventory.projectExternalId.trim();
    const providerItemTypePrefix = inventory.providerItemTypePrefix.trim();
    if (!projectExternalId || !providerItemTypePrefix) {
      throw new Error("invalid authoritative scope inventory identity");
    }
    const identity = scopeKey(projectExternalId, providerItemTypePrefix);
    if (identities.has(identity)) {
      throw new Error("duplicate authoritative scope inventory identity");
    }
    identities.add(identity);

    const providerItemTypes = inventory.providerItemTypes.map((value) => value.trim());
    const uniqueTypes = new Set<string>();
    for (const providerItemType of providerItemTypes) {
      if (!providerItemType
        || !providerItemType.startsWith(providerItemTypePrefix)
        || providerItemType.length <= providerItemTypePrefix.length
        || providerItemType === "created:catalog") {
        throw new Error("invalid authoritative scope inventory type");
      }
      if (uniqueTypes.has(providerItemType)) {
        throw new Error("duplicate authoritative scope inventory type");
      }
      uniqueTypes.add(providerItemType);
    }
    return {
      projectExternalId,
      providerItemTypePrefix,
      providerItemTypes: [...uniqueTypes].sort((left, right) => left.localeCompare(right)),
    };
  }).sort((left, right) => left.projectExternalId.localeCompare(right.projectExternalId)
    || left.providerItemTypePrefix.localeCompare(right.providerItemTypePrefix));
}

export function mergeWorkItemSnapshot(
  previous: CachedSnapshot | undefined,
  input: CacheMergeInput,
): CachedSnapshot {
  const inventories = normalizeAuthoritativeScopeInventories(
    input.authoritativeScopeInventories,
  );
  const inventoryByIdentity = new Map(inventories.map((inventory) => [
    scopeKey(inventory.projectExternalId, inventory.providerItemTypePrefix),
    inventory,
  ]));
  const inputProjects = new Map(input.projects.map((project) => [
    project.externalId,
    projectRefSchema.parse(project),
  ]));
  const projects = new Map((previous?.projects ?? []).map((project) => [
    project.externalId,
    projectRefSchema.parse(project),
  ]));
  const scopes = new Map((previous?.scopes ?? []).map((scope) => {
    const cached = cachedScope(scope);
    return [scopeKey(cached.projectExternalId, cached.providerItemType), cached];
  }));

  if (input.authoritativeProjects) {
    for (const [key, scope] of scopes) {
      if (!inputProjects.has(scope.projectExternalId)) scopes.delete(key);
    }
    for (const projectExternalId of projects.keys()) {
      if (!inputProjects.has(projectExternalId)) projects.delete(projectExternalId);
    }
  } else if (input.authoritativeProjectScopePrefixes?.length) {
    for (const [key, scope] of scopes) {
      if (!inputProjects.has(scope.projectExternalId)
        && input.authoritativeProjectScopePrefixes.some((prefix) =>
          scope.providerItemType.startsWith(prefix))) {
        scopes.delete(key);
      }
    }
    deleteProjectsWithoutScopes(projects, scopes);
  }

  if (input.authoritativeProviderItemTypes?.length) {
    const authoritativeTypes = new Set(input.authoritativeProviderItemTypes);
    const successfulScopeKeys = new Set(input.scopes
      .filter((scope) => scope.outcome === "success"
        && authoritativeTypes.has(scope.providerItemType))
      .map((scope) => scopeKey(scope.projectExternalId, scope.providerItemType)));
    for (const [key, scope] of scopes) {
      if (authoritativeTypes.has(scope.providerItemType) && !successfulScopeKeys.has(key)) {
        scopes.delete(key);
      }
    }
    deleteProjectsWithoutScopes(projects, scopes);
  }

  for (const authority of input.authoritativeScopePrefixes ?? []) {
    if (inventoryByIdentity.has(scopeKey(
      authority.projectExternalId,
      authority.providerItemTypePrefix,
    ))) continue;
    const retainedTypes = new Set(input.scopes
      .filter((scope) => scope.projectExternalId === authority.projectExternalId
        && scope.providerItemType.startsWith(authority.providerItemTypePrefix))
      .map((scope) => scope.providerItemType));
    for (const [key, scope] of scopes) {
      if (scope.projectExternalId === authority.projectExternalId
        && scope.providerItemType.startsWith(authority.providerItemTypePrefix)
        && !retainedTypes.has(scope.providerItemType)) {
        scopes.delete(key);
      }
    }
  }

  for (const inventory of inventories) {
    const retainedTypes = new Set(inventory.providerItemTypes);
    for (const [key, scope] of scopes) {
      if (scope.projectExternalId === inventory.projectExternalId
        && scope.providerItemType.startsWith(inventory.providerItemTypePrefix)
        && !retainedTypes.has(scope.providerItemType)) {
        scopes.delete(key);
      }
    }
  }

  for (const scope of input.scopes) {
    if (scope.outcome !== "success"
      || isScopeDeletedByInventory(scope, inventories, { allowCatalogSentinel: true })) continue;
    const project = inputProjects.get(scope.projectExternalId);
    if (!project) throw new Error("cache scope references an unknown project");
    const itemKeys = new Set<string>();
    const items = scope.items.map((value) => {
      const parsed = workItemSchema.parse(value);
      if (parsed.providerId !== input.account.providerId
        || parsed.projectExternalId !== scope.projectExternalId
        || parsed.kind !== scope.kind) {
        throw new Error("cache item identity does not match its scope");
      }
      if (itemKeys.has(parsed.key)) throw new Error("duplicate cache item key");
      itemKeys.add(parsed.key);
      return workItemSchema.parse({ ...parsed, freshness: "fresh" });
    }).sort((left, right) => left.key.localeCompare(right.key));
    projects.set(project.externalId, project);
    scopes.set(scopeKey(scope.projectExternalId, scope.providerItemType), {
      projectExternalId: scope.projectExternalId,
      providerItemType: scope.providerItemType,
      kind: scope.kind,
      freshness: "fresh",
      lastSuccessfulSyncAt: input.now.toISOString(),
      items,
    });
  }

  deleteProjectsWithoutScopes(projects, scopes);
  const orderedScopes = [...scopes.values()].sort((left, right) =>
    left.projectExternalId.localeCompare(right.projectExternalId)
      || left.providerItemType.localeCompare(right.providerItemType));
  const lastSuccessfulSyncAt = orderedScopes.reduce<string | undefined>(
    (latest, scope) => !latest || scope.lastSuccessfulSyncAt > latest
      ? scope.lastSuccessfulSyncAt
      : latest,
    undefined,
  );
  return {
    account: {
      providerId: input.account.providerId,
      accountDisplayName: input.account.accountDisplayName,
      ...(input.account.tenantDisplayName
        ? { tenantDisplayName: input.account.tenantDisplayName }
        : {}),
    },
    projects: [...projects.values()].sort((left, right) =>
      left.externalId.localeCompare(right.externalId)),
    scopes: orderedScopes,
    items: orderedScopes.flatMap((scope) => scope.items),
    ...(lastSuccessfulSyncAt ? { lastSuccessfulSyncAt } : {}),
  };
}

export function isScopeDeletedByInventory(
  scope: Pick<CacheMergeInput["scopes"][number], "projectExternalId" | "providerItemType">,
  inventories: AuthoritativeScopeInventory[],
  options: { allowCatalogSentinel?: boolean } = {},
) {
  return inventories.some((inventory) =>
    inventory.projectExternalId === scope.projectExternalId
      && scope.providerItemType.startsWith(inventory.providerItemTypePrefix)
      && (!options.allowCatalogSentinel
        || scope.providerItemType !== `${inventory.providerItemTypePrefix}catalog`)
      && !inventory.providerItemTypes.includes(scope.providerItemType));
}

function cachedScope(scope: CachedScope): CachedScope {
  return {
    ...scope,
    freshness: "cached",
    items: scope.items.map((item): WorkItem =>
      workItemSchema.parse({ ...item, freshness: "cached" })),
  };
}

function deleteProjectsWithoutScopes(
  projects: Map<string, ProjectRef>,
  scopes: Map<string, CachedScope>,
) {
  const projectIds = new Set([...scopes.values()].map((scope) => scope.projectExternalId));
  for (const projectExternalId of projects.keys()) {
    if (!projectIds.has(projectExternalId)) projects.delete(projectExternalId);
  }
}

function scopeKey(projectExternalId: string, providerItemType: string) {
  return `${projectExternalId}\u0000${providerItemType}`;
}
