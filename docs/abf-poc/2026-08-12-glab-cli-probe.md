# GitLab glab CLI 合同探针

## 结论

2026-08-12 在 Windows 开发环境运行 `npm run probe:glab --workspace @flowrivet/codex-plugin`，结果为：

```json
{"ok":false,"capability":"gitlab","errorCode":"gitlab_cli_missing"}
```

当前机器未安装 GitLab 官方 `glab` CLI，因此尚未验证以下真实合同：

- 自建实例 `gitlab-aiabu.ruijie.com.cn` 的浏览器 OAuth。
- 当前用户可访问项目的 JSON 分页。
- `cc/flowrivet` 的 MR JSON。
- `cc/flowrivet` 的 Pipeline JSON。

按批准规格，不允许改用 GitLab REST/GraphQL API。安装并登录 `glab` 后必须重新运行本探针，通过后才能进入 GitLab Adapter 与连接 UI 实施。

探针输出仅包含能力布尔值、CLI 版本和稳定错误码，不记录账号、项目标题、URL、Token 或原始错误正文。
