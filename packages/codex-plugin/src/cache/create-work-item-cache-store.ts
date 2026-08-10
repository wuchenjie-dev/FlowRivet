import { join } from "node:path";

import { resolveFlowRivetConfigDirectory } from "../projects/json-project-selection-store.js";
import { SqliteWorkItemCacheStore } from "./sqlite-work-item-cache-store.js";
import {
  WorkItemCacheError,
  type WorkItemCacheStore,
} from "./work-item-cache-store.js";

type SqliteModule = typeof import("node:sqlite");

export function createWorkItemCacheStore(options: {
  directory?: string;
  loadSqlite?: () => Promise<SqliteModule>;
} = {}): WorkItemCacheStore {
  const directory = options.directory ?? resolveFlowRivetConfigDirectory();
  const loadSqlite = options.loadSqlite ?? (() => import("node:sqlite"));
  let delegate: Promise<WorkItemCacheStore> | undefined;

  const getDelegate = async () => {
    delegate ??= loadSqlite().then(
      ({ DatabaseSync }) => new SqliteWorkItemCacheStore({
        path: join(directory, "flowrivet.db"),
        DatabaseSync,
      }),
      () => unavailableStore(),
    );
    try {
      return await delegate;
    } catch (error) {
      delegate = undefined;
      throw error;
    }
  };

  return {
    activateAccount: async (input) => (await getDelegate()).activateAccount(input),
    mergeScopes: async (input) => (await getDelegate()).mergeScopes(input),
    loadActive: async (providerId, now) =>
      (await getDelegate()).loadActive(providerId, now),
    clearActive: async (providerId) => (await getDelegate()).clearActive(providerId),
    purgeExpired: async (now) => (await getDelegate()).purgeExpired(now),
  };
}

function unavailableStore(): WorkItemCacheStore {
  const reject = async (): Promise<never> => {
    throw new WorkItemCacheError("cache_unavailable");
  };
  return {
    activateAccount: reject,
    mergeScopes: reject,
    loadActive: reject,
    clearActive: reject,
    purgeExpired: reject,
  };
}
