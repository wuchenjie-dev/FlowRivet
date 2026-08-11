# FlowRivet 本地插件一键更新设计

## 1. 背景

FlowRivet 以本地 Codex 插件和回环地址 Companion 运行。源码更新后，Codex 不会因为刷新看板自动重新加载插件：开发者目前需要手工构建、刷新 `.codex-plugin/plugin.json` 的 cachebuster、重新安装插件、重启 Companion，并在新的 Codex 任务中验证。

该流程容易遗漏。插件缓存可能继续使用旧版本，Companion 进程也可能继续运行旧代码，从而出现“源码已更新，但飞书待办页面仍是旧版”的状态。

## 2. 目标

- 提供正式入口 `flowrivet plugin update`。
- 提供快捷入口 `npm run plugin:update`，复用同一实现。
- 默认更新当前检出的代码；仅显式传入 `--pull` 时拉取 Git 上游。
- 自动构建、刷新插件缓存、重新安装、重启 Companion 并验证健康状态。
- 支持 Windows、Linux 和 macOS。
- 更新后不遗留 Git 脏文件。
- 不自动终止或重启 Codex 桌面应用；明确提示用户重启 Codex 并创建新任务。

## 3. 非目标

- 实现后台自动更新或常驻更新服务。
- 静默覆盖本地 Git 修改、切换分支或解决合并冲突。
- 发布或下载 GitHub Release。
- 修改 Codex marketplace 的业务配置或手工编辑 Codex `config.toml`。
- 在无法确认进程归属时强制终止占用 Companion 端口的进程。
- 让当前已打开的 Codex 任务热加载新的 Skill 或 MCP 工具。

## 4. 用户决策

| 决策 | 结果 |
| --- | --- |
| 命令入口 | CLI 与 npm 双入口，共用实现 |
| Companion | 更新成功后自动安全重启并验证 |
| Git | 默认不拉取；`--pull` 才执行 fast-forward 更新 |
| 平台 | Windows、Linux、macOS |
| Codex 应用 | 不自动重启，输出明确的人工收尾动作 |

## 5. 命令合同

```text
flowrivet plugin update [--pull] [--json]
npm run plugin:update
```

- `--pull`：构建前执行受限 Git 更新。
- `--json`：输出稳定的机器可读结果；默认输出分阶段的人类可读结果。
- 未知参数返回退出码 `2` 和用法说明。
- 更新失败返回非零退出码，且不得输出成功提示。

`npm run plugin:update` 是源码仓库的 bootstrap 入口：它先执行最小 CLI 构建，再运行编译后的 `flowrivet plugin update`。正式 CLI 和 bootstrap 最终调用同一个 `PluginUpdateService`，bootstrap 不复制更新阶段或平台逻辑。

成功结果至少包含：

```json
{
  "ok": true,
  "plugin": "flowrivet",
  "marketplace": "flowrivet-worktree",
  "installedVersion": "0.1.0+codex.<cachebuster>",
  "companion": {
    "host": "127.0.0.1",
    "port": 43120,
    "healthy": true
  },
  "restartCodexRequired": true,
  "newTaskRequired": true
}
```

输出不得包含 Token、授权 URL、验证码、账号、项目、工作项、子进程完整参数、stdout 或 stderr 原文。

## 6. 架构

```text
flowrivet plugin update ─┐
                        ├─> PluginUpdater
npm run plugin:update ──┘       |
                                +─ Source/Git preflight
                                +─ Build runner
                                +─ Codex local plugin installer
                                +─ Companion process manager
                                +─ Health verifier
```

`PluginUpdater` 是唯一编排入口。CLI 参数解析和 npm script 不复制更新逻辑。平台差异封装在 Companion 进程适配器中；构建、cachebuster、插件安装和健康检查保持平台中立。

建议模块边界：

- `PluginUpdateService`：执行状态机和失败边界。
- `PluginSourceLocator`：定位插件根、manifest、marketplace 和 Codex CLI。
- `GitUpdater`：只处理显式 `--pull` 的干净工作区与 fast-forward。
- `PluginInstaller`：执行官方 cachebuster/reinstall 语义并恢复 manifest。
- `CompanionProcessManager`：校验、停止、启动和记录实例。
- `CommandRunner`：使用参数数组运行固定命令，限制输出和超时。

## 7. 更新状态机

```text
preflight
  -> pulling? 
  -> building
  -> installing
  -> stopping_companion
  -> starting_companion
  -> verifying
  -> succeeded

任一阶段 -> failed
```

执行顺序：

1. 定位 FlowRivet 源码、Codex CLI、本地 marketplace 和 Companion 配置。
2. 枚举本地 marketplace，要求恰好一个已安装且启用的 FlowRivet 条目最终解析到本次源码；零个或多个匹配都停止。
3. 恢复或拒绝上一轮未完成的 manifest 安装事务。
4. `--pull` 时校验工作区干净、存在上游分支，并执行 `git pull --ff-only`。
5. `--pull` 成功后执行最小 CLI 构建，并以内部一次性标记重新执行新版更新器；已重执行的进程不得再次拉取或递归重启自身。
6. 构建 FlowRivet CLI 和 Codex 插件。
7. 创建仓库外 manifest 事务日志与备份，再保存原始字节哈希。
8. 使用 Codex 官方 plugin-creator cachebuster helper 临时刷新版本。
9. 执行 `codex plugin add flowrivet@<marketplace>`。
10. 在 `finally` 中原子恢复 manifest 原始字节并删除事务文件。
11. 校验当前 Companion 归属，停止旧实例。
12. 隐藏启动新 Companion，等待 `/health`。
13. 校验已安装插件版本和 Companion 实例。
14. 返回成功结果及“重启 Codex、创建新任务”提示。

只有插件安装成功后才允许停止当前 Companion。构建或安装失败不得影响正在运行的旧服务。

## 8. 插件安装与 cachebuster 事务

更新器遵循 Codex plugin-creator 的本地插件更新规则：保留 `+` 之前的版本前缀，并替换为单一 `+codex.<cachebuster>` 后缀，然后从现有本地 marketplace 重新安装。

更新器不得永久修改 tracked manifest：

1. 以字节形式读取原 manifest，并计算原始 SHA-256。
2. 在 FlowRivet 用户配置目录原子写入备份和事务日志。日志只包含规范化源码路径、备份路径、原始哈希、临时哈希、创建时间和事务状态。
3. 调用官方 `update_plugin_cachebuster.py`。
4. 读取并校验临时版本确实发生变化，记录临时 SHA-256。
5. 调用 Codex CLI 安装。
6. 无论成功、失败、超时或取消，都在 `finally` 中从备份原子恢复原始内容。
7. 恢复后重新读取并核对字节和原始哈希完全一致，再删除备份和事务日志。

若进程被强制终止，下一次 preflight 按以下规则恢复：

- manifest 等于临时哈希：备份路径、源码路径和原始哈希均校验通过后自动恢复。
- manifest 等于原始哈希：视为恢复已完成，只清理事务文件。
- manifest 两者都不匹配：视为用户或其他进程已修改文件，返回 `plugin_manifest_recovery_conflict`，不得覆盖。

事务文件必须限制为当前用户访问，且不得放在源码仓库内。每个源码根同时最多一个更新事务；更新器使用原子创建的锁文件拒绝并发运行。

更新器不手工编辑 marketplace JSON。它通过 Codex CLI 列表和 marketplace 文件只读解析确认：marketplace 是本地源、插件名为 `flowrivet`、source 最终解析到当前源码目录。必须恰好一个已安装且启用的条目满足条件；零匹配返回 `plugin_marketplace_mismatch`，多匹配返回 `plugin_marketplace_ambiguous`，不得自行选择。

## 9. Git 行为

默认不执行 Git 命令。`--pull` 必须满足：

- 当前目录属于 Git 工作树。
- 工作区和索引均干净。
- 当前分支存在上游。
- 使用 `git pull --ff-only`，禁止自动 merge、rebase、stash 或 checkout。

任一条件不满足时返回稳定错误，且不进入构建阶段。更新器不创建 Git commit；cachebuster 是临时安装事务，不属于源代码变更。

`git pull --ff-only` 成功后，当前进程不得继续使用拉取前已加载的更新器实现。它先执行最小 CLI 构建，再通过固定 Node.js 可执行文件和参数数组重新执行一次，并传入只在子进程环境中存在的内部重执行标记。新进程跳过 pull 阶段并从 preflight 重新校验；第二次发现重执行请求时返回错误，防止无限递归。

## 10. Companion 实例所有权

Companion 启动时写入本地实例文件：

```json
{
  "version": 1,
  "product": "flowrivet-companion",
  "pid": 12345,
  "processStartedAt": "2026-08-11T11:59:59.500Z",
  "host": "127.0.0.1",
  "port": 43120,
  "instanceId": "random-non-secret-id",
  "startedAt": "2026-08-11T12:00:00.000Z"
}
```

实例文件位于 FlowRivet 用户配置目录，使用限制当前用户访问的原子写入。`/health` 返回相同的 `product`、`pid` 和 `instanceId`，不返回身份或业务数据。

停止条件必须同时满足：

- host 是回环地址。
- 实例文件 PID 仍存在。
- 操作系统报告的进程启动时间与 `processStartedAt` 在平台允许误差内一致，防止 PID 复用。
- `/health` 返回 FlowRivet product 标识。
- `/health` 的 PID 和 instance ID 与实例文件一致。

不匹配时返回 `companion_ownership_unverified`，禁止停止进程。

### 10.1 旧版 Companion 迁移

首次更新时旧 Companion 可能没有实例文件。迁移路径额外要求：

- 端口由本机进程监听。
- 进程是 Node.js。
- 完整命令行匹配 FlowRivet 固定 server 入口。
- 工作目录或入口绝对路径落在本次确认的 FlowRivet 源码目录内。

四项不能全部确认时停止。迁移只用于旧版本；新实例启动后必须写入实例文件，后续更新不得继续依赖命令行猜测。

## 11. 启动与健康验证

- 使用当前 Node.js 可执行文件和固定 `dist/server/index.js` 参数数组启动。
- 继承用户环境，但只显式覆盖 `FLOWRIVET_MCP_HOST` 和 `FLOWRIVET_MCP_PORT`。
- Windows 使用隐藏窗口；Linux/macOS 使用 detached 子进程。
- stdout/stderr 重定向到 FlowRivet 日志目录，结果只返回脱敏日志路径。
- 启动后按短间隔轮询 `/health`，总超时不超过 15 秒。
- 子进程提前退出或健康检查超时均视为失败。
- 健康响应必须通过 Schema，并匹配新 PID 与 instance ID。

更新器不自动启动或终止 Codex 桌面应用。插件安装成功只代表新任务可以加载新版；当前任务仍可能持有旧 Skill、MCP 工具和 UI 注册。

## 12. 错误与恢复

稳定错误至少包括：

| 错误码 | 含义 |
| --- | --- |
| `plugin_source_not_found` | 无法定位 FlowRivet 插件源码 |
| `codex_cli_not_found` | 无法定位 Codex CLI |
| `plugin_marketplace_mismatch` | marketplace 未指向当前源码 |
| `plugin_marketplace_ambiguous` | 多个已安装 marketplace 同时指向当前源码 |
| `git_worktree_dirty` | `--pull` 遇到未提交修改 |
| `git_upstream_missing` | 当前分支无上游 |
| `git_fast_forward_failed` | fast-forward 拉取失败 |
| `plugin_build_failed` | 构建失败 |
| `plugin_cachebuster_failed` | 临时版本刷新失败 |
| `plugin_install_failed` | Codex 插件安装失败 |
| `plugin_manifest_restore_failed` | 无法恢复 manifest 原文 |
| `plugin_manifest_recovery_conflict` | 未完成事务与当前 manifest 发生冲突 |
| `plugin_update_in_progress` | 同一源码根已有更新事务运行 |
| `companion_ownership_unverified` | 无法确认端口进程属于 FlowRivet |
| `companion_start_failed` | 新 Companion 提前退出 |
| `companion_health_timeout` | 新 Companion 未在时限内健康 |
| `plugin_version_mismatch` | Codex 安装版本与本次版本不一致 |

恢复原则：

- preflight、Git、构建或安装失败：保留旧 Companion。
- 安装失败：恢复 manifest，不改变已安装版本。
- 停止旧 Companion 后新实例失败：保留诊断日志并返回失败；不得虚报成功。
- manifest 无法恢复是最高优先级错误，即使插件安装已成功也返回失败。

## 13. 测试策略

### 13.1 单元与合同测试

- 默认参数、`--pull`、`--json` 和未知参数。
- 源码、Codex CLI、marketplace 和平台路径定位。
- cachebuster 成功、失败和安装失败时的 manifest 字节恢复。
- 强制中断后的事务恢复、已恢复清理、冲突拒绝和并发锁。
- `--pull` 的干净工作区、脏工作区、无上游和非 fast-forward。
- `--pull` 后只重执行一次新版更新器，不使用拉取前代码继续安装。
- marketplace 零匹配、唯一匹配和多匹配。
- 构建或安装失败时不停止 Companion。
- PID、进程启动时间、端口、product、instance ID 的全部匹配与不匹配组合。
- Windows、Linux、macOS 的固定启动命令与隐藏/detached 选项。
- 新进程健康、提前退出和超时。
- 人类输出、JSON 输出、稳定退出码和敏感字段排除。
- npm script 与 CLI 调用同一实现。

测试注入文件系统、命令 runner、时钟、进程适配器和 HTTP health client，不停止真实进程，也不安装真实插件。

### 13.2 本机端到端验收

1. 记录更新前插件版本和 Companion 实例。
2. 执行 `npm run plugin:update`。
3. 验证已安装版本发生变化。
4. 验证 `127.0.0.1:43120/health` 返回新实例且健康。
5. 验证 Git 工作区保持干净。
6. 重启 Codex，新建任务并打开飞书待办看板。
7. 验证看板使用实时飞书数据且不显示旧 Provider 文案。

真实验收记录只保存版本、阶段、耗时、退出码和聚合结果。

## 14. 准入与准出标准

### 14.1 准入

- 当前 worktree 与远程目标分支一致或明确选择不拉取。
- FlowRivet 插件已通过本地 marketplace 安装。
- Companion 只监听回环地址。
- 现有测试、类型检查和构建通过。

### 14.2 准出

- `flowrivet plugin update` 和 `npm run plugin:update` 均可执行同一更新流程。
- 默认不执行 Git；`--pull` 只允许干净工作区和 fast-forward。
- 更新成功后 manifest 与更新前字节一致，工作区干净。
- 强制中断后能安全恢复临时 manifest；存在并发修改时拒绝覆盖。
- Codex 已安装版本使用新的单一 cachebuster。
- `--pull` 使用拉取后重新构建的更新器继续执行，且最多重执行一次。
- 旧 Companion 只有在所有权确认后才停止。
- 新 Companion 在 15 秒内通过带实例标识的健康检查。
- 失败路径返回稳定错误且不记录敏感信息。
- Windows、Linux、macOS 自动化合同通过。
- 本机真实更新验收通过，并明确要求重启 Codex和创建新任务。
