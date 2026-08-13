# 飞书项目 - Codex - GitLab E2E 验收记录

## 验收范围

目标链路：飞书个人待办 -> 唯一执行记录 -> Codex handoff -> 用户选择 GitLab 仓库 -> 安全工作区 -> `codex/*` 分支 -> push -> MR -> Pipeline -> 结构化结果。

## 已验证合同

| 环节 | 结果 | 说明 |
| --- | --- | --- |
| 飞书项目登录与个人待办读取 | 通过 | 官方 Meegle CLI 设备授权；凭据由 CLI/系统存储管理。 |
| Codex 任务衔接 | 通过，采用 handoff | 当前宿主无稳定的直接创建任务 API，同一工作项恢复同一执行记录。 |
| GitLab 登录与项目读取 | 通过 | `glab` 1.113.0，浏览器 OAuth，账号 `wuchenjie`；不记录 Token。 |
| 本地仓库识别 | 通过 | remote 精确匹配、干净工作树、绝对路径和非空目标保护。 |
| 分支、push、MR、Pipeline | 自动化合同通过 | 仅允许 `codex/*`，禁止默认分支；MR 创建幂等。 |
| 飞书评论写回 | 待隔离实测，默认关闭 | 安全探针框架已就绪；尚未在带测试标记的隔离工作项完成 list/create/read/update/repeat 实测。Meegle CLI 1.0.19 无评论删除命令。 |
| 飞书普通字段写回 | 待逐类型隔离实测，默认关闭 | 只测试显式 `--field-fixture`；每个类型必须写入、读回、相同值重复写和恢复全部成功。 |
| 飞书状态、节点、角色写回 | 只读合同待实测，写入禁止 | 探针只读取 transition/required-fields、节点和角色元数据，不自动执行状态流转或节点、角色修改。 |
| 高风险操作 | 门禁通过 | 合并 MR、重试 Pipeline、关闭任务使用五分钟、单次、绑定用户和目标版本的确认。 |

## 自动化结果

- `workflow-e2e.test.ts` 使用假 `git`/`glab` 串通完整编排，并验证同一工作项不重复创建执行。
- 插件单元、合同和组件测试覆盖登录、账号隔离、仓库保护、MR 幂等、本地回写降级和确认失效。
- Playwright 覆盖桌面与移动视口、详情抽屉、执行进度、长路径、MR 链接、离线与授权恢复。

## 真实环境边界

已完成只读真实探针：飞书账号、GitLab OAuth、GitLab 项目列表、当前仓库 remote、MR 列表和 Pipeline 列表。

Meegle 写探针提供严格隔离确认、测试标题标记、显式字段 fixture、分页上限、脱敏证据和候选 manifest 输出。运行时 manifest 当前所有能力均为关闭且 `verifiedAt` 为空；版本不匹配、文件缺失、schema 异常和未列出字段类型都会保持关闭。候选 manifest 必须人工复核后才能进入运行时文件。

评论探针会对同一随机 marker 执行全分页 list、create 后读回、update 后读回、相同值重复 update 后再次读回。由于 1.0.19 未提供 comment delete，成功的隔离探针会在测试工作项保留一条脱敏 `FLOWRIVET_WRITE_PROBE` 评论；create 调用后出现抛异常、非零/超时等价退出、无效 JSON 或后续阶段失败时，结果要求按固定 marker 人工查找清理，安全输出不包含 nonce 或评论正文。字段探针仍要求写入、读回、重复写和原值恢复全部成功。

未运行 Meegle 真实写探针、未创建真实测试 MR、未重试真实 Pipeline、未合并 MR、未关闭飞书工作项。原因是尚未提供隔离的飞书测试工作项和 GitLab 测试项目；不得用生产工作项或 `cc/flowrivet` 默认分支进行破坏性验收。

## 真实写入验收所需输入

1. 一个可删除的隔离飞书测试项目和工作项，标题包含明确的 `TEST`/`测试` 标记，并分配给测试用户。
2. 一个允许 Developer 推送功能分支和创建 MR 的隔离 GitLab 项目。
3. 项目的默认分支名称和可运行的最小 Pipeline。
4. 对每次合并 MR、重试 Pipeline 或关闭任务的现场单次确认。

验收记录不得包含 Token、OAuth Code、完整任务正文、代码差异或内部敏感数据。

写探针命令接口：

```text
node scripts/probe-meegle-write-contract.mjs --project-key <TEST_PROJECT_KEY> --work-item-id <TEST_WORK_ITEM_ID> --field-fixture text:<FIELD_KEY>:<TEST_VALUE> --confirm-isolated-fixture FLOWRIVET_WRITE_PROBE --output docs/abf-poc/meegle-write-contract-1.0.19.json --manifest-output <TEMP_MANIFEST_PATH>
```

真实探针执行仍待上述隔离目标；在此之前不得复制候选 manifest 或启用任何写能力。
