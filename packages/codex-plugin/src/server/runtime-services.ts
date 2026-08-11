import { createWorkItemCacheStore } from "../cache/create-work-item-cache-store.js";
import { MeegleAuthService } from "../meegle/meegle-auth-service.js";
import { MeegleCliClient } from "../meegle/meegle-cli-client.js";
import { MeegleLoginDriver } from "../meegle/meegle-login-driver.js";
import { MeegleWorkItemProvider } from "../meegle/meegle-work-item-provider.js";
import { resolveFlowRivetConfigDirectory } from "../projects/json-project-selection-store.js";
import type { ActiveProviderStore } from "../providers/active-provider-store.js";
import { JsonActiveProviderStore } from "../providers/json-active-provider-store.js";
import { ProviderRegistry } from "../providers/provider-registry.js";
import { ProviderLoginCoordinator } from "../providers/provider-login-coordinator.js";
import { SystemBrowserLauncher } from "../providers/system-browser-launcher.js";
import { JsonStderrProviderLoginOperationLogger } from "../observability/provider-login-operation-logger.js";
import { WorkItemService, type WorkItemSynchronizer } from "../work-items/work-item-service.js";

export interface RuntimeServices {
  registry: ProviderRegistry;
  loginCoordinator: ProviderLoginCoordinator;
  activeProviderStore: ActiveProviderStore;
  workItemServices: Map<string, WorkItemSynchronizer>;
}

export function createDefaultRuntimeServices(
  now: () => Date = () => new Date(),
): RuntimeServices {
  const client = new MeegleCliClient({ clock: now });
  const auth = new MeegleAuthService({ client, clock: now });
  const login = new MeegleLoginDriver(client);
  const workItems = new MeegleWorkItemProvider({ client, clock: now });
  const workItemService = new WorkItemService(
    workItems,
    now,
    createWorkItemCacheStore(),
  );
  const registry = new ProviderRegistry([{
    id: "feishu-project",
    displayName: "飞书项目",
    loginMode: "device_code",
    auth,
    login,
    workItems,
  }]);
  const loginCoordinator = new ProviderLoginCoordinator({
    resolveDriver: (providerId) => registry.get(providerId).login,
    browserLauncher: new SystemBrowserLauncher(),
    logger: new JsonStderrProviderLoginOperationLogger(),
    clock: now,
  });
  return {
    registry,
    loginCoordinator,
    activeProviderStore: new JsonActiveProviderStore({
      directory: resolveFlowRivetConfigDirectory(),
    }),
    workItemServices: new Map([["feishu-project", workItemService]]),
  };
}
