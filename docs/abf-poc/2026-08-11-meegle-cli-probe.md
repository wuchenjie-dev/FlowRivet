# 飞书项目 Meegle CLI 合同探针

## 结论

本次探针通过。FlowRivet 可以只依赖飞书项目官方 Meegle CLI 完成用户授权与个人工作项读取，不需要在运行时接入远程 MCP，也不需要保存飞书项目 Token。

探针同时发现了必须写入实现合同的限制：个人工作台空结果返回 `list: null`；响应只有 `total`，没有分页游标；工作台和详情响应都不提供工作项 URL。因此首版必须完整分页后在本地过滤最近 7 天完成项，并允许工作项没有外链。

## 验证环境

| 项目 | 结果 |
| --- | --- |
| 日期 | 2026-08-11 |
| 操作系统 | Windows |
| Node.js | 22.x |
| 官方包 | `@lark-project/meegle@1.0.19` |
| CLI 版本 | `1.0.19` |
| 站点 | `project.feishu.cn` |
| 最低兼容版本 | 首版固定为 `1.0.19`，更高版本仍需通过 Schema 校验 |

Windows 全局安装同时产生 PowerShell shim `meegle.ps1` 和包内原生 `meegle-win32-x64.exe`。运行时应优先解析并固定原生可执行文件；仍需用测试覆盖 npm `.cmd` shim，以支持不同 Node 安装方式。

## 命令合同

### Profile

`meegle config profile current --format json` 在 `1.0.19` 中仍输出单行纯文本 Profile 名，而不是 JSON。客户端必须按经过长度限制的单行文本解析，不能套用 JSON Schema。

### 登录状态与身份

未登录时，`meegle auth status --format json` 返回非零退出码和结构化 JSON：

```json
{
  "authenticated": false,
  "host": "project.feishu.cn",
  "reason": "no local token"
}
```

已登录时返回 `authenticated`、`expires_in_minutes` 和 `host`。`meegle user me --format json` 返回 `avatar_url`、`email`、`name_cn`、`name_en`、`user_key`。FlowRivet 只使用稳定 `user_key` 做账号隔离，显示名仅用于界面，不写日志。

### 设备码授权

CLI 提供稳定的两阶段机器可读协议：

1. `auth login --device-code --phase init --format json` 返回 `client_id`、`device_code`、`expires_in`、`interval`、`user_code`、`verification_uri`、`verification_uri_complete`。
2. `auth login --device-code --phase poll --once --format json` 在等待时返回 `authorization_pending`，成功时返回 `status: ok` 和非敏感成功消息，过期时返回 `expired_token`。

授权地址、设备码、用户码只允许存在于内存事务中，不得进入日志、Fixture 或配置文件。

### 个人工作台

`meegle inspect mywork.todo` 证明：

- `action` 必填，枚举为 `todo`、`done`、`overdue`、`this_week`。
- `page_num` 必填，从 1 开始，每页 50 条。
- `asset_key` 只在服务端要求选择工作区时传入。

真实脱敏探针得到的分页合同：

- 响应顶层为 `{ list, total }`，没有 `pagination`、`has_more` 或 `next_page_token`。
- 空页的 `list` 是 `null`，不是空数组。
- 超出尾页后 `list` 为 `null`，`total` 仍是总数。
- 终止条件为 `list == null` 或当前页条数小于 50；同时校验累计条数不超过 `total`。
- 每个 action 仍保留 1,000 页和 50,000 条的硬上限。

本次账号的 `this_week` 与 `overdue` 为空，未得到活跃工作项实例；`done` 有数据，并包含：

- `project_key`、`project_name`
- `work_item_info.work_item_id`、`work_item_name`、`work_item_type_key`
- `node_info.node_name`、`node_state_key`
- `state_info.start_state_key_name`、`end_state_key_name`
- `finish_time.finish_time`
- 可空的 `schedule`

字段 `state_info.start_state_key_name` 和 `end_state_key_name` 始终存在，但真实工作项中可能为空字符串；Schema 只校验其为字符串，阶段归一化不得依赖其非空。

完成时间可解析，样本按完成时间倒序，但公开命令没有日期过滤参数。单个账号样本不足以把排序当成服务端保证，所以首版完整分页后再过滤最近 7 天，不按时间提前停止。

### 详情与外链

默认 `workitem get` 可补充工作项创建/更新时间、项目 simple name、模板、类型和状态，但仍不返回工作项 URL。首版不猜测 URL 路径，也不为此执行额外详情请求：共享合同允许 `externalUrl` 缺失，界面在缺失时禁用外链操作。

## 错误分类

- 未登录：`auth status` 退出码 1，仍返回结构化 `authenticated: false`。
- 等待、成功和设备码过期：设备码轮询返回结构化状态。
- CLI 未找到、超时、输出过大、无效 JSON 和其他非零退出由 FlowRivet Runner 映射为稳定 Provider 错误码。
- 未验证 401、403、429、5xx 和断网的稳定 JSON 形状；这些错误不得通过本地化 stderr 文本猜测，无法可靠分类时统一为 `provider_unavailable`。

## 脱敏规则

仓库中的 Fixture 只保留已验证的字段名、嵌套和标量类型，所有用户、项目、工作项、租户、URL、设备码与 Token 均使用合成值或直接省略。真实 CLI stdout/stderr 未写入仓库。
