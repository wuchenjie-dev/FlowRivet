import {
  createDefaultWorkItemSynchronizer,
  createTaskboardMcpServer,
  type TaskboardMcpServerOptions,
} from "./app.js";
import type { WorkItemSynchronizer } from "../work-items/work-item-service.js";
import {
  createDefaultRuntimeServices,
  type RuntimeServices,
} from "./runtime-services.js";

type DefaultServer = ReturnType<typeof createTaskboardMcpServer>;

export interface TaskboardRuntime<TServer = DefaultServer> {
  createServer(): TServer;
}

export function createTaskboardRuntime<TServer = DefaultServer>(
  options: TaskboardMcpServerOptions = {},
  factories: {
    createWorkItemSynchronizer?: () => WorkItemSynchronizer;
    createRuntimeServices?: () => RuntimeServices;
    createMcpServer?: (options: TaskboardMcpServerOptions) => TServer;
  } = {},
): TaskboardRuntime<TServer> {
  const legacyOverrides = options.workItemService !== undefined
    || options.authService !== undefined
    || options.projectCatalog !== undefined
    || factories.createWorkItemSynchronizer !== undefined;
  const runtimeServices = options.runtimeServices
    ?? (legacyOverrides ? undefined : (factories.createRuntimeServices
      ?? (() => createDefaultRuntimeServices(options.now)))());
  const workItemService = runtimeServices ? undefined : options.workItemService
    ?? (factories.createWorkItemSynchronizer ?? (() =>
      createDefaultWorkItemSynchronizer(options.now)))();
  const createMcpServer = factories.createMcpServer
    ?? (createTaskboardMcpServer as (options: TaskboardMcpServerOptions) => TServer);

  return {
    createServer: () => createMcpServer({
      ...options,
      ...(runtimeServices ? { runtimeServices } : {}),
      ...(workItemService ? { workItemService } : {}),
    }),
  };
}
