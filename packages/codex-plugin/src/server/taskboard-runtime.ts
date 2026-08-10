import {
  createDefaultWorkItemSynchronizer,
  createTaskboardMcpServer,
  type TaskboardMcpServerOptions,
} from "./app.js";
import type { WorkItemSynchronizer } from "../work-items/work-item-service.js";

type DefaultServer = ReturnType<typeof createTaskboardMcpServer>;

export interface TaskboardRuntime<TServer = DefaultServer> {
  createServer(): TServer;
}

export function createTaskboardRuntime<TServer = DefaultServer>(
  options: TaskboardMcpServerOptions = {},
  factories: {
    createWorkItemSynchronizer?: () => WorkItemSynchronizer;
    createMcpServer?: (options: TaskboardMcpServerOptions) => TServer;
  } = {},
): TaskboardRuntime<TServer> {
  const workItemService = options.workItemService
    ?? (factories.createWorkItemSynchronizer ?? (() =>
      createDefaultWorkItemSynchronizer(options.now)))();
  const createMcpServer = factories.createMcpServer
    ?? (createTaskboardMcpServer as (options: TaskboardMcpServerOptions) => TServer);

  return {
    createServer: () => createMcpServer({ ...options, workItemService }),
  };
}
