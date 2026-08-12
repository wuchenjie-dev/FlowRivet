import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  gitLabConnectionSchema,
  gitLabLoginResultSchema,
  gitLabProjectPageSchema,
} from "../../contracts/gitlab.js";
import type { GitLabOperations } from "../../gitlab/gitlab-service.js";

export function registerGitLabTools(server: McpServer, service: GitLabOperations) {
  registerAppTool(server, "get_gitlab_connection", {
    title: "检查 GitLab 连接",
    description: "通过本地 glab 检查 GitLab 登录状态，不读取凭据。",
    inputSchema: {}, outputSchema: gitLabConnectionSchema.shape,
    annotations: { readOnlyHint: true, openWorldHint: true }, _meta: {},
  }, async () => ({ structuredContent: await service.getConnection(), content: [] }));
  registerAppTool(server, "recheck_gitlab_connection", {
    title: "重新检查 GitLab 连接",
    description: "重新检查本地 glab 登录状态。",
    inputSchema: {}, outputSchema: gitLabConnectionSchema.shape,
    annotations: { readOnlyHint: true, openWorldHint: true }, _meta: {},
  }, async () => ({ structuredContent: await service.getConnection(), content: [] }));
  registerAppTool(server, "start_gitlab_login", {
    title: "连接 GitLab",
    description: "由本地 glab 打开浏览器完成 OAuth 登录。",
    inputSchema: {}, outputSchema: gitLabLoginResultSchema.shape,
    annotations: { readOnlyHint: false, openWorldHint: true }, _meta: {},
  }, async () => ({ structuredContent: await service.startLogin(), content: [] }));
  registerAppTool(server, "list_gitlab_projects", {
    title: "列出 GitLab 项目",
    description: "列出当前 glab 用户有成员权限的 GitLab 项目。",
    inputSchema: {
      page: z.number().int().positive().default(1),
      perPage: z.number().int().min(1).max(100).default(50),
    },
    outputSchema: gitLabProjectPageSchema.shape,
    annotations: { readOnlyHint: true, openWorldHint: true }, _meta: {},
  }, async ({ page, perPage }) => ({
    structuredContent: await service.listProjects({ page, perPage }), content: [],
  }));
}
