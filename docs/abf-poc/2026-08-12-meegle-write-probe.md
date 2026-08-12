# Meegle CLI 写能力探针

## 结论

2026-08-12 在已安装 Meegle CLI 的 Windows 环境运行 `npm run probe:meegle-write --workspace @flowrivet/codex-plugin`，结果为：

```json
{"ok":true,"capability":"meegle_write","comments":"unsupported","childItems":"unsupported","fields":"unsupported","transitions":"unsupported"}
```

当前公开帮助合同没有证明评论、创建子工作项、字段更新或节点流转的稳定写命令。探针只读取 `meegle --help`，未修改任何真实工作项。

在官方 CLI 提供并通过沙箱验证写合同前，FlowRivet 只能保留本地产物，并提供复制或打开飞书项目的恢复入口；不得宣称结构化结果已回写。
