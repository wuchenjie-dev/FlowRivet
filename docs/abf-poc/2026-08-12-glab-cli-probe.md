# GitLab glab CLI 合同探针

## 结论

2026-08-12 在 Windows 开发环境安装并登录 `glab 1.113.0` 后，运行 `npm run probe:glab --workspace @flowrivet/codex-plugin`，结果为：

```json
{"ok":true,"capability":"gitlab","version":"1.113.0","auth":true,"projects":true,"mergeRequests":true,"pipelines":true}
```

已验证以下真实合同：

- 自建实例 `gitlab-aiabu.ruijie.com.cn` 的浏览器 OAuth。
- 当前用户可访问项目的 JSON 分页。
- `cc/flowrivet` 的 MR JSON。
- `cc/flowrivet` 的 Pipeline JSON。

实例级 OAuth Application 使用 `http://localhost:7171/auth/redirect`，关闭 Trusted 与 Confidential，仅启用 `openid`、`profile`、`read_user`、`write_repository` 和 `api`。`glab` 将用户凭据保存到 Windows Credential Manager，FlowRivet 不保存 Client Secret 或 Token。

按批准规格，不允许改用 GitLab REST/GraphQL API。GitLab Adapter 与连接 UI 可以进入实施。

探针输出仅包含能力布尔值、CLI 版本和稳定错误码，不记录账号、项目标题、URL、Token 或原始错误正文。
