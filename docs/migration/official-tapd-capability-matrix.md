# TAPD 官方 MCP 用户态能力矩阵

## 验证结论

2026-08-05 在 Windows 上使用 `uvx mcp-server-tapd` 验证：

- 官方 MCP Server：`mcp-tapd 1.29.0`。
- Python 运行要求：`>=3.13`；系统默认 Python 3.11 无法解析依赖，`uvx` 可自动选择兼容运行时。
- stdio 初始化和 `tools/list` 成功，共返回 43 个工具。
- 使用个人 TAPD Token 调用 `get_user_participant_projects` 成功。
- 在 Token 所属源项目中，`get_workspace_info`、`get_workspace_users` 和 `get_entity_custom_fields` 只读调用成功。
- 同一 Token 访问另一测试企业项目时，上述工具均返回 TAPD `422 ParamError`，确认跨企业权限不会被 MCP 绕过。
- `get_workflows_all_transitions` 在有权源项目仍返回内部 `'system'` 键错误，当前版本不能作为可靠工作流检查依据。
- 工具支持工作项、评论、项目、成员、自定义字段读取和工作流读取。
- 未发现创建自定义字段、修改工作流或配置 GitLab 仓库关联的工具。
- 已创建 FlowRivet 开放平台网页应用，并验证研发协作 17 个模块的读写权限配置可持久保存。
- 已验证 OAuth 2.0 回调 URL 可配置为本机回环地址，重复添加时平台返回“已存在该URL”。
- 普通企业不能直接作为未上架应用的测试安装目标；应用必须先完善扩展模块、事件订阅、发布资料和测试版本，并通过平台上架审核。
- 开放平台提供独立的开发者测试企业路径，可免审核验证应用，但每个开发者仅能创建一个；当前按用户选择暂不创建。
- 未上架应用仍可对普通企业发起用户态 OAuth：使用 `scope=story%23read&auth_by=user` 已成功进入公司选择和 FlowRivet 授权确认页，因此 OAuth 权限继承验证不依赖应用安装或上架。
- 用户态授权码交换成功，实际资源类型为 `user`（包含用户和企业标识），不是旧文档示例中的 `workspace`；Broker 已按预期企业校验该资源。
- 同一 OAuth Token 使用 `story#read` 调用需求 API 成功，确认 Token 和 Bearer 鉴权可用。
- `users/info` 和 `workspaces` 在本次 `story#read workspace#read` Token 下均返回 `403 scope limited`；官方 MCP 启动时无条件调用 `users/info`，因此在返回 MCP initialize 响应前以 HTTP 403 退出。

验证过程只输出工具名、Schema 和成功状态，未记录 Token、项目名称、项目 ID、成员或业务数据。

## 能力矩阵

| 能力 | 官方 MCP / API | OAuth scope 候选 | 个人 Token | 用户 OAuth | 管理员 | 普通成员 | 无权限用户 | 当前结论 |
|---|---|---|---|---|---|---|---|---|
| 获取当前用户 | TAPD OAuth resource / `users/info` | `user#read` 候选 | 不适用 | 资源已返回；API 在未申请 `user#read` 时 403 | 待验证 | 待验证 | 待验证 | 官方 MCP 启动的隐式前置能力 |
| 用户参与项目 | `get_user_participant_projects` | `workspace#read` | 已通过 | 待验证 | 待验证 | 待验证 | 待验证 | 工具存在 |
| 项目信息 | `get_workspace_info` | `workspace#read` | 源项目通过、跨企业拒绝 | 待验证 | 待验证 | 待验证 | 已验证跨企业拒绝 | 需要 `workspace_id` |
| 项目成员与角色 | `get_workspace_users` | `member` / `workspace#read` | 源项目通过、跨企业拒绝 | 待验证 | 待验证 | 待验证 | 已验证跨企业拒绝 | 需确认是否返回可靠角色 |
| 需求和任务读取 | `get_stories_or_tasks` | `story#read` / `task#read` | 工具存在 | `story#read` 真实 API 已通过 | 待验证 | 待验证 | 待验证 | 需继续三账号验证 |
| 需求和任务写入 | `create_story_or_task`, `update_story_or_task` | `story` / `task` | 工具存在 | 待验证 | 待验证 | 待验证 | 待验证 | 禁止在能力探测中实写生产项目 |
| 评论读写 | `get_comments`, `create_comments`, `update_comments` | 依附对象 scope | 工具存在 | 待验证 | 待验证 | 待验证 | 待验证 | 需三账号验证 |
| 自定义字段读取 | `get_entity_custom_fields` | `setting` | 源项目通过、跨企业拒绝 | 待验证 | 待验证 | 待验证 | 已验证跨企业拒绝 | 只读工具 |
| 自定义字段创建 | TAPD OpenAPI | `setting` | 未验证 | 待验证 | 待验证 | 应拒绝 | 应拒绝 | 官方 MCP 无对应工具 |
| 工作流读取 | `get_workflows_all_transitions` 等 | `workflow` | `'system'` 键错误 | 待验证 | 待验证 | 待验证 | 待验证 | 官方 MCP 1.29.0 阻塞 |
| 工作流修改 | 未发现公开 MCP 工具 | `workflow` | 未验证 | 待验证 | 待验证 | 应拒绝 | 应拒绝 | 暂按人工配置处理 |
| GitLab 仓库关联读取 | TAPD 第三方应用信息 API 候选 | `source#read` | 未验证 | 待验证 | 待验证 | 待验证 | 待验证 | 官方 MCP 无明确工具 |
| GitLab 仓库关联配置 | TAPD 管理页面 | `source#write` 候选 | 未验证 | 待验证 | 待验证 | 应拒绝 | 应拒绝 | 暂按管理员人工配置处理 |

## Go/No-Go 状态

当前为 **Blocked / 待外部条件**，不能进入 OAuth Broker 实现：

1. TAPD 用户 OAuth Access Token 已成功兑换且需求 API 调用通过；官方 MCP 会在初始化时调用 `users/info`，当前 scope 下返回 403，需要补充并验证 `user#read`，或修复官方 MCP 的启动依赖。
2. FlowRivet TAPD OAuth 应用、普通企业授权、Broker 交换和企业资源校验均已通过；`workspace#read` 对 `workspaces` API 的实际映射仍需澄清。
3. 只有一个个人 Token，尚未完成管理员、普通成员、无权限用户矩阵。
4. 尚未证明 TAPD API 能读取项目已关联的 GitLab 仓库稳定标识或 URL。
5. 官方 MCP `get_workflows_all_transitions` 在有权项目中存在运行时错误，需要上游修复或本地适配。

解除阻塞后重新执行 Task 1。若 OAuth Token 不兼容官方 MCP、项目角色不可可靠识别、仓库关联不可读取，或管理员初始化没有用户态 API/人工路径，则必须重新评审官方贡献、本地适配器或远程业务代理方案。
