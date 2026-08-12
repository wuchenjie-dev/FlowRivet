import { createWorkItemCacheStore } from "../cache/create-work-item-cache-store.js";
import { createNotificationStore } from "../notifications/create-notification-store.js";
import type { NotificationStore } from "../notifications/notification-store.js";
import { NativeSystemNotifier } from "../notifications/system-notifier.js";
import {
  parseNotificationInterval,
  WorkItemNotificationMonitor,
} from "../notifications/work-item-notification-monitor.js";
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
import { createDefaultGitLabService, type GitLabOperations } from "../gitlab/gitlab-service.js";
import { createExecutionStore } from "../executions/create-execution-store.js";
import { ExecutionService } from "../executions/execution-service.js";
import { resolveExecutable } from "../process/bounded-command-runner.js";
import { GitCliClient } from "../gitlab/git-cli-client.js";
import { RepositoryWorkflow, type RepositoryPreparer } from "../gitlab/repository-workflow.js";

export interface RuntimeServices {
  registry: ProviderRegistry;
  loginCoordinator: ProviderLoginCoordinator;
  activeProviderStore: ActiveProviderStore;
  workItemServices: Map<string, WorkItemSynchronizer>;
  notificationStore: NotificationStore;
  notificationMonitor: Pick<WorkItemNotificationMonitor, "start" | "stop">;
  gitLabService?: GitLabOperations;
  executionService?: ExecutionService;
  repositoryWorkflow?: RepositoryPreparer;
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
  const activeProviderStore = new JsonActiveProviderStore({
    directory: resolveFlowRivetConfigDirectory(),
  });
  const workItemServices = new Map([["feishu-project", workItemService]]);
  const notificationStore = createNotificationStore();
  const notificationMonitor = new WorkItemNotificationMonitor({
    activeProvider: async () => (await activeProviderStore.load({
      registeredProviderIds: registry.ids(),
    })).activeProviderId,
    resolveProvider: (providerId) => ({
      auth: registry.get(providerId).auth,
      synchronizer: workItemServices.get(providerId) ?? (() => {
        throw new Error("work_item_service_not_registered");
      })(),
    }),
    store: notificationStore,
    notifier: new NativeSystemNotifier(),
    clock: now,
    intervalSeconds: parseNotificationInterval(
      process.env.FLOWRIVET_NOTIFICATION_INTERVAL_SECONDS,
    ),
  });
  let git: GitCliClient | undefined;
  const repositoryWorkflow = new RepositoryWorkflow({
    git: {
      async inspect(path) {
        git ??= new GitCliClient({ executablePath: await resolveExecutable({ command: "git" }) });
        return git.inspect(path);
      },
      async clone(url, target) {
        git ??= new GitCliClient({ executablePath: await resolveExecutable({ command: "git" }) });
        return git.clone(url, target);
      },
    },
  });
  return {
    registry,
    loginCoordinator,
    activeProviderStore,
    workItemServices,
    notificationStore,
    notificationMonitor,
    gitLabService: createDefaultGitLabService(),
    executionService: new ExecutionService({ store: createExecutionStore() }),
    repositoryWorkflow,
  };
}
