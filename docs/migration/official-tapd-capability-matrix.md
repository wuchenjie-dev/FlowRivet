# TAPD 官方 MCP 用户态能力矩阵

## 验证结论

2026-08-05 在 Windows 上使用 `uvx mcp-server-tapd` 验证：

- 官方 MCP Server：`mcp-tapd 1.29.0`。
- Python 运行要求：`>=3.13`；系统默认 Python 3.11 无法解析依赖，`uvx` 可自动选择兼容运行时。
- stdio 初始化和 `tools/list` 成功，共返回 43 个工具。
- 使用个人 TAPD Token 调用 `get_user_participant_projects` 成功。
- 工具支持工作项、评论、项目、成员、自定义字段读取和工作流读取。
- 未发现创建自定义字段、修改工作流或配置 GitLab 仓库关联的工具。

验证过程只输出工具名、Schema 和成功状态，未记录 Token、项目名称、项目 ID、成员或业务数据。

## 能力矩阵

| 能力 | 官方 MCP / API | OAuth scope 候选 | 个人 Token | 用户 OAuth | 管理员 | 普通成员 | 无权限用户 | 当前结论 |
|---|---|---|---|---|---|---|---|---|
| 获取当前用户 | TAPD OAuth resource | `user` | 不适用 | 待验证 | 待验证 | 待验证 | 待验证 | Broker 前置能力 |
| 用户参与项目 | `get_user_participant_projects` | `workspace#read` | 已通过 | 待验证 | 待验证 | 待验证 | 待验证 | 工具存在 |
| 项目信息 | `get_workspace_info` | `workspace#read` | 工具存在 | 待验证 | 待验证 | 待验证 | 待验证 | 需要 `workspace_id` |
| 项目成员与角色 | `get_workspace_users` | `member` / `workspace#read` | 工具存在 | 待验证 | 待验证 | 待验证 | 待验证 | 需确认是否返回可靠角色 |
| 需求和任务读取 | `get_stories_or_tasks` | `story` / `task` | 工具存在 | 待验证 | 待验证 | 待验证 | 待验证 | 需三账号验证 |
| 需求和任务写入 | `create_story_or_task`, `update_story_or_task` | `story` / `task` | 工具存在 | 待验证 | 待验证 | 待验证 | 待验证 | 禁止在能力探测中实写生产项目 |
| 评论读写 | `get_comments`, `create_comments`, `update_comments` | 依附对象 scope | 工具存在 | 待验证 | 待验证 | 待验证 | 待验证 | 需三账号验证 |
| 自定义字段读取 | `get_entity_custom_fields` | `setting` | 工具存在 | 待验证 | 待验证 | 待验证 | 待验证 | 只读工具 |
| 自定义字段创建 | TAPD OpenAPI | `setting` | 未验证 | 待验证 | 待验证 | 应拒绝 | 应拒绝 | 官方 MCP 无对应工具 |
| 工作流读取 | `get_workflows_all_transitions` 等 | `workflow` | 工具存在 | 待验证 | 待验证 | 待验证 | 待验证 | 只读工具 |
| 工作流修改 | 未发现公开 MCP 工具 | `workflow` | 未验证 | 待验证 | 待验证 | 应拒绝 | 应拒绝 | 暂按人工配置处理 |
| GitLab 仓库关联读取 | TAPD 第三方应用信息 API 候选 | `source#read` | 未验证 | 待验证 | 待验证 | 待验证 | 待验证 | 官方 MCP 无明确工具 |
| GitLab 仓库关联配置 | TAPD 管理页面 | `source#write` 候选 | 未验证 | 待验证 | 待验证 | 应拒绝 | 应拒绝 | 暂按管理员人工配置处理 |

## Go/No-Go 状态

当前为 **Blocked / 待外部条件**，不能进入 OAuth Broker 实现：

1. 当前机器没有 TAPD 用户 OAuth Access Token，尚未验证官方 MCP 是否接受该 Token。
2. 尚未创建并安装 FlowRivet TAPD OAuth 测试应用，无法验证最小 scope。
3. 只有一个个人 Token，尚未完成管理员、普通成员、无权限用户矩阵。
4. 尚未证明 TAPD API 能读取项目已关联的 GitLab 仓库稳定标识或 URL。

解除阻塞后重新执行 Task 1。若 OAuth Token 不兼容官方 MCP、项目角色不可可靠识别、仓库关联不可读取，或管理员初始化没有用户态 API/人工路径，则必须重新评审官方贡献、本地适配器或远程业务代理方案。
