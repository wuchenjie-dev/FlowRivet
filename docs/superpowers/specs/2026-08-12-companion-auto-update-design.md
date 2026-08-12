# FlowRivet Companion 内网自动更新设计

## 1. 背景

FlowRivet 当前由 Codex 插件外壳、本机 Companion、MCP Apps 看板和飞书项目 Provider 组成。源码仓库已经提供 `npm run plugin:update`，用于开发者从当前 checkout 构建、重新安装插件并重启 Companion。该流程依赖 Git、Node.js、源码权限和人工重启 Codex，不适合作为普通用户的日常更新方式。

普通用户需要一条独立的发布链路：管理员在内网 GitLab 构建可信发布包，客户端静默获取新版 Companion 和看板 UI，新打开的看板直接使用新版，且日常更新不要求退出 Codex。

## 2. 目标

- 通过内网 GitLab Generic Package Registry 分发 Windows、Linux 和 macOS 发布包。
- 使用只读 Deploy Token 访问私有制品，并由操作系统凭据库保护 Token。
- 独立 Updater 在后台静默检查、下载、校验、切换和回滚 Companion。
- Companion 与 MCP Apps 看板 UI 同版本发布。
- Codex 插件外壳保持稳定，继续连接固定回环地址 `http://127.0.0.1:43120/mcp`。
- 新打开的看板自动加载当前 Companion 提供的最新版 UI。
- 已打开的看板发现版本变化后引导用户重新打开，通常不需要重启 Codex。
- GitLab、网络或新版本异常不得影响当前可用版本。

## 3. 非目标

- 静默更新 Codex 桌面应用。
- 日常自动修改 Codex 插件 manifest、Skill 或 MCP 连接配置。
- 让已经加载的 MCP App iframe 无条件热替换资源。
- 使用 `git pull`、本机源码构建或 npm 作为普通用户更新链路。
- 第一阶段支持 GitHub、公网镜像、灰度通道或差分包。
- 第一阶段把 Companion 安装成 Windows Service、systemd system service 或 macOS daemon。
- 在静默通道发布不向后兼容的 MCP 工具或 UI 数据协议。

## 4. 用户决策

| 决策 | 结果 |
| --- | --- |
| 发布源 | 内网 GitLab Generic Package Registry |
| Registry 认证 | 项目 Deploy Token，仅授予 `read_package_registry` |
| 更新策略 | 静默检查、下载和切换 |
| 自动更新范围 | Companion 与 MCP Apps 看板 UI |
| Codex 插件 | 稳定外壳，不参与日常自动更新 |
| 客户端实现 | 独立、稳定的 FlowRivet Updater |
| 发布通道 | 第一阶段仅 `stable` |

## 5. 总体架构

```text
GitLab protected tag
  -> GitLab CI cross-platform build
  -> Generic Package Registry
       |- flowrivet-runtime/<semver>/release-manifest.json
       |- flowrivet-runtime/<semver>/flowrivet-windows-x64.zip
       |- flowrivet-runtime/<semver>/flowrivet-linux-x64.tar.gz
       |- flowrivet-runtime/<semver>/flowrivet-macos-arm64.tar.gz
       `- flowrivet-channel/latest/manifest.json

Codex
  `- stable FlowRivet plugin shell
       `- HTTP MCP -> 127.0.0.1:43120
                         |
FlowRivet Updater -------+
  |- read OS credential store
  |- check manifest
  |- download and verify package
  |- switch version / rollback
  `- supervise Companion lifecycle
                         |
                 FlowRivet Companion
                   |- MCP tools
                   |- MCP Apps UI resource
                   |- Feishu Project provider
                   |- cache and notifications
                   `- health and version state
```

MCP Apps 继续承担 Codex 内的展示与交互，但不承担更新本身。独立 Updater 是更新控制面；Companion 是本地运行时和数据面。看板关闭后，Updater 和 Companion 仍可检查版本、同步数据和生成通知。

## 6. 组件边界

### 6.1 稳定 Codex 插件外壳

插件外壳只保留：

- 指向固定本机 MCP 地址的 `.mcp.json`。
- 打开或刷新 FlowRivet 看板的稳定 Skill。
- 长期兼容的 MCP 工具入口。

插件外壳不内置频繁变化的业务 UI。日常 UI 资源由 Companion 的 MCP Server 返回。只有 MCP 地址、插件声明或 Skill 能力发生必要变化时，才单独发布插件升级，并明确提示用户重启 Codex。

### 6.2 FlowRivet Updater

Updater 是小型、低频变化的独立启动器，职责仅包括：

- 启动当前已选中的 Companion。
- 启动时和定时读取 stable manifest。
- 下载并校验匹配当前平台的发布包。
- 管理版本化目录与 `current.json`。
- 停止已验证归属的旧 Companion，启动和验证新 Companion。
- 新版本失败时恢复上一成功版本。
- 清理临时文件和超期旧版本。

Updater 不读取飞书任务内容，不持有飞书登录凭据，也不实现业务 MCP 工具。

第一阶段沿用项目的 TypeScript/Node.js 技术栈，但安装包携带项目私有的固定 Node.js 运行时和生产依赖。Updater 与 Companion 都由该私有运行时启动，不依赖系统 `node`、npm 或用户 `PATH`。CI 对每个平台执行运行时来源校验、许可证归档和包内依赖扫描。

### 6.3 FlowRivet Companion

Companion 继续监听回环地址，负责 MCP、看板 UI、Provider、缓存和通知。它必须通过 `/health` 暴露非敏感运行信息：

```json
{
  "status": "ok",
  "product": "flowrivet-companion",
  "version": "0.2.1",
  "protocolVersion": 1,
  "pid": 12345,
  "instanceId": "random-non-secret-id",
  "uiVersion": "0.2.1"
}
```

### 6.4 GitLab 发布流水线

只有受保护标签，例如 `v0.2.1`，可以触发 stable 发布。CI 必须：

1. 在受控 runner 中执行测试、类型检查和构建。
2. 为支持的平台生成自包含发布包，普通用户无需安装 Git、Node.js 或源码依赖。
3. 生成 SHA-256，并验证包内文件白名单和启动入口。
4. 先串行上传不可变版本包和 `release-manifest.json`，验证可下载后，最后上传单文件 stable 通道指针。
5. 禁止复写已存在的相同语义版本；只允许 `flowrivet-channel/latest/manifest.json` 产生新修订。
6. 使用 GitLab CI `resource_group` 或等价锁串行化 stable 发布，避免两个流水线交错写入通道指针。

## 7. 本机目录与版本切换

建议使用平台用户级应用数据目录：

```text
FlowRivet/
|- updater/
|- versions/
|  |- 0.2.0/
|  `- 0.2.1/
|- downloads/
|- config/
|- logs/
|- current.json
`- update-state.json
```

`current.json` 是原子写入的版本指针：

```json
{
  "version": 1,
  "activeVersion": "0.2.1",
  "previousVersion": "0.2.0",
  "activatedAt": "2026-08-12T08:00:00.000Z"
}
```

Updater 不覆盖正在运行版本的文件。发布包先解压到临时目录，完整校验后原子移动到 `versions/<version>`。默认保留当前版本和上一个成功版本；其他版本在确认稳定后延迟清理。

## 8. 发布清单与通道指针合同

GitLab Generic Package Registry 下载接口要求客户端已知包名、包版本和文件名，Deploy Token 也不用于枚举通用 GitLab API。因此客户端直接读取固定地址：

```text
GET /api/v4/projects/<project-id>/packages/generic/
    flowrivet-channel/latest/manifest.json
DEPLOY-TOKEN: <token-from-os-credential-store>
```

`manifest.json` 是 stable 通道指针和发布清单，使用版本化 Schema：

```json
{
  "schemaVersion": 1,
  "channel": "stable",
  "version": "0.2.1",
  "publishedAt": "2026-08-12T07:30:00.000Z",
  "minimumUpdaterVersion": "0.1.0",
  "protocolVersion": 1,
  "releaseSeverity": "normal",
  "packages": {
    "windows-x64": {
      "packageName": "flowrivet-runtime",
      "packageVersion": "0.2.1",
      "file": "flowrivet-windows-x64.zip",
      "size": 12345678,
      "sha256": "hex-digest"
    },
    "linux-x64": {
      "packageName": "flowrivet-runtime",
      "packageVersion": "0.2.1",
      "file": "flowrivet-linux-x64.tar.gz",
      "size": 12345678,
      "sha256": "hex-digest"
    },
    "macos-arm64": {
      "packageName": "flowrivet-runtime",
      "packageVersion": "0.2.1",
      "file": "flowrivet-macos-arm64.tar.gz",
      "size": 12345678,
      "sha256": "hex-digest"
    }
  }
}
```

每个不可变版本包还保存字节一致的 `release-manifest.json`。客户端先读取通道指针，再从指针指定的明确版本路径下载 `release-manifest.json`，要求两份清单的版本、协议和包摘要一致，之后才下载平台包。

Generic Registry 的多文件上传不是原子操作。发布事务必须先完整上传和回读验证 `flowrivet-runtime/<semver>`，最后单独上传 `flowrivet-channel/latest/manifest.json`。如果流水线在最后一步前失败，客户端仍读取旧通道指针；最后一步是单文件写入，不会暴露半套版本制品。

GitLab 默认可能允许相同包名、版本和文件名的重复修订。项目或群组必须默认拒绝 Generic 重复包，并且只为包名 `flowrivet-channel`、包版本 `latest` 配置最窄例外，使其中唯一的 `manifest.json` 可以产生新修订。该例外依赖自建 GitLab 版本的实际正则匹配语义，实施前必须完成 POC；若实例不能安全配置该例外，则改由一个只读内网静态地址托管通道指针，版本制品仍保留在 Generic Registry。

客户端必须拒绝未知高版本 Schema、版本回退、平台不匹配、文件大小超限、摘要缺失和不兼容的 `protocolVersion`。第一阶段使用 GitLab TLS、受保护 CI 和 SHA-256 建立完整性链；后续可在威胁模型需要时增加离线签名，但 Schema 应预留签名字段扩展能力。

## 9. Registry 认证与凭据

Deploy Token 只授予 `read_package_registry`，不得授予仓库写入或 API 管理权限。Token 通过首次安装或管理员配置流程写入：

- Windows Credential Manager。
- macOS Keychain。
- Linux Secret Service；不可用时停止自动配置并给出受控安装指引，不静默回退到明文文件。

下载只使用 GitLab 文档支持的 Generic Package Registry 路径和 `DEPLOY-TOKEN` 请求头，并跟随同源或管理员允许的对象存储重定向。配置文件只保存 GitLab 基础地址、项目 ID、包名、通道和凭据引用，不保存 Token。重定向到非信任来源时不得转发认证头。Token 不得出现在命令行参数、环境变量、日志、崩溃报告或 MCP 响应中。

项目 Deploy Token 被同一安装群体共享，适合第一阶段内网分发，但撤销影响所有客户端。管理员应设置轮换周期；更新器支持先写入新凭据、验证后替换旧凭据。需要个人级审计时，应另行设计用户 Token 或内网更新代理，不在本阶段混入。

## 10. 自动更新状态机

```text
idle
  -> checking
  -> update_available
  -> downloading
  -> verifying
  -> staging
  -> stopping_old
  -> starting_new
  -> health_checking
  -> activated

checking/download/verify failure -> keep_current -> idle
starting/health failure -> rollback -> verify_previous -> idle
```

执行规则：

1. Updater 启动时检查一次，此后默认每 30 分钟检查。
2. 每次定时检查增加稳定随机抖动，避免客户端同时请求 GitLab。
3. 同一时间只允许一个更新事务；下载支持合理重试，但切换阶段不并发。
4. 校验完成前不停止当前 Companion。
5. Updater 使用已有实例文件和 `/health` 双重确认进程归属后停止旧实例。
6. 新 Companion 必须在限定时间内返回匹配版本、实例 ID 和协议版本的健康响应。
7. 健康检查通过后才写入 `current.json` 并标记成功。
8. 启动或健康检查失败时恢复上一版本，并把失败目标版本置于冷却状态，避免循环更新。
9. 更新期间看板最多短暂断连；客户端刷新和 Companion 重连必须可重试。

## 11. Codex 与 MCP Apps 更新体验

日常更新只改变 Companion 和它提供的 UI 资源：

- Companion 为每个 UI 版本注册版本化资源 URI，例如 `ui://flowrivet/taskboard/0.2.1.html`，稳定工具名保持不变。
- Codex 与 Companion 建立新 MCP 会话并重新读取工具元数据后，新打开的看板从当前 Companion 获取版本化 UI。
- 已打开的看板定期读取 `/health` 对应的非敏感版本状态；发现 `uiVersion` 变化后显示“新版已就绪”。
- 用户点击“重新打开看板”，由稳定工具重新创建 MCP App 视图。
- 不强制刷新正在交互的看板，避免丢失展开状态或未完成操作。
- 必须用真实 Codex POC 验证 Companion 重启后宿主是否自动重连并重新读取工具元数据。若宿主仍复用旧工具元数据或资源缓存，则提示重启 Codex，作为低频兜底；不得宣称该宿主版本支持无重启更新。

MCP Apps 是 Codex 内的主要看板载体，但不是后台更新器。它只在页面打开时运行，不能替代常驻 Updater 或 Companion。

## 12. 兼容性策略

静默更新要求连续版本向后兼容：

- 稳定 MCP 工具名和基础输入输出字段不得删除或改变含义。
- 新字段必须可选，旧 UI 遇到未知字段必须忽略。
- 新 Companion 至少兼容上一个 stable UI 合同。
- 新 UI 至少兼容上一个 stable Companion 合同，或在加载前明确阻止切换。
- `protocolVersion` 不兼容时，Updater 不激活新版本，并显示需要升级插件外壳的提示。
- 插件外壳升级采用单独流程，不伪装成 Companion 静默更新。

CI 应维护当前 stable 与候选版本的双向合同测试，而不只测试候选版本自身。

## 13. 错误、恢复与可观测性

稳定错误至少包括：

| 错误码 | 处理 |
| --- | --- |
| `update_registry_unreachable` | 保持当前版本，按退避策略重试 |
| `update_credentials_missing` | 保持当前版本，显示管理员配置提示 |
| `update_credentials_rejected` | 停止重试一段时间，提示轮换 Token |
| `update_manifest_invalid` | 拒绝更新并记录 requestId |
| `update_platform_unsupported` | 保持当前版本，不下载 |
| `update_package_download_failed` | 清理或保留可恢复临时文件后重试 |
| `update_package_integrity_failed` | 删除包并冻结该版本 |
| `update_protocol_incompatible` | 不激活，提示插件外壳升级 |
| `update_companion_ownership_unverified` | 不停止现有进程 |
| `update_companion_start_failed` | 回滚上一成功版本 |
| `update_companion_health_failed` | 回滚上一成功版本 |
| `update_rollback_failed` | 保留证据并显示需要人工处理的阻塞状态 |

日志只记录时间、`requestId`、当前版本、目标版本、平台、阶段、耗时和稳定错误码。不得记录 Deploy Token、认证响应正文、任务数据、用户身份或完整内部 URL 查询参数。

GitLab 不可达、Token 过期、下载失败和校验失败均不得停止当前 Companion。只有完整包已验证且回滚路径可用时，才进入进程切换阶段。

## 14. 安装、启动与自更新边界

首次安装由受控安装包完成：

1. 安装稳定插件外壳。
2. 安装 Updater 和初始 Companion。
3. 写入非敏感 Registry 配置。
4. 通过安全输入将 Deploy Token 写入凭据库。
5. 注册用户级开机启动项并启动 Updater。
6. 验证 Companion `/health` 和 Codex MCP 连接。

第一阶段固定使用用户级启动机制：Windows Task Scheduler 在用户登录时隐藏启动，macOS 使用用户 `LaunchAgent`，Linux 使用 `systemd --user`。安装器必须同时提供幂等注册、状态检查和卸载；Linux 环境没有用户级 systemd 时明确报告不支持自动启动，不静默创建未受管理的后台进程。

Updater 自身不进入第一阶段的静默更新范围，以降低引导程序自替换风险。Updater 协议预留 `minimumUpdaterVersion`：遇到更高最低版本时，继续运行当前 Companion 并提示管理员升级安装器。后续如确需 Updater 自更新，应使用双启动器或平台安装器单独设计。

开发者仍可使用现有 `npm run plugin:update` 验证源码 checkout。普通用户手册不得把该命令作为产品更新方式。

## 15. 测试策略

### 15.1 单元与合同测试

- manifest Schema、平台选择、版本比较和未知 Schema 拒绝。
- 凭据库成功、缺失、拒绝和敏感信息排除。
- 下载中断、大小限制、SHA-256 不匹配和临时目录清理。
- 原子版本指针写入、并发锁、崩溃恢复和磁盘空间不足。
- 当前/上一版本保留与旧版本清理。
- Companion 所有权、停止、启动、健康检查和回滚。
- 失败版本冷却，防止重启后重复更新。
- 旧 UI/新 Companion 和新 UI/旧 Companion 合同。
- 版本化 MCP App 资源 URI，以及新 MCP 会话返回当前 `uiVersion`。
- 日志和 MCP 响应不包含凭据及业务数据。

### 15.2 CI 发布验证

- 受保护标签以外不能发布 stable。
- 所有目标平台包通过构建、测试、启动和 `/health` 验证。
- 包摘要与 manifest 一致。
- 同一版本不可覆盖，Generic 重复包策略符合通道指针例外约束。
- 发布任务通过资源锁串行执行。
- 所有版本包和版本清单成功上传、回读并校验后，才更新单文件 stable 通道指针。
- 通道指针更新前失败时，客户端下载到的仍是上一份完整清单。
- 候选版本通过与当前 stable 的兼容性矩阵。

### 15.3 三平台端到端验收

每个平台至少验证：

1. 初始安装后 Codex 能打开看板。
2. 发布新版后客户端在检查周期内静默下载和激活。
3. 新打开看板显示新版 UI 和版本号。
4. 已打开看板显示“新版已就绪”，重新打开后更新。
5. GitLab 断网、Token 失效、包损坏和磁盘不足不影响旧版。
6. 新 Companion 启动失败或健康异常时自动回滚。
7. 更新切换时缓存、飞书登录状态和通知记录保持可用。
8. 重启操作系统后仍启动已确认的成功版本。
9. 在真实 Codex 中记录 Companion 切换后是否自动重建 MCP 会话、读取新版资源 URI；不支持时验证重启兜底提示准确出现。

## 16. 准入与准出标准

### 16.1 准入

- GitLab 项目已启用 Generic Package Registry 和受保护标签。
- 自建 GitLab 已验证 Generic 重复包策略：版本包不可覆盖，仅 `flowrivet-channel/latest` 允许新修订；否则已提供只读静态通道指针地址。
- stable 发布具有跨流水线串行锁。
- CI runner 覆盖目标平台，或采用经过验证的等价构建环境。
- Deploy Token 仅具有 `read_package_registry`。
- 当前 stable 插件外壳使用固定回环 MCP 地址。
- Companion `/health` 已提供版本、协议和实例身份。
- 当前 stable 与候选版本的兼容性合同已定义。
- 三平台凭据库和用户级启动机制已选定并可自动化测试。
- 目标平台发布包已包含并固定私有 Node.js 运行时，不依赖系统 Node.js 或 npm。

### 16.2 准出

- 普通用户无需 Git、Node.js、源码目录或 `npm run plugin:update`。
- Updater 可从私有 Registry 鉴权、检查、下载和校验三平台包。
- 客户端通过固定通道指针找到明确的不可变版本，不依赖 Deploy Token 调用通用包枚举 API。
- Token 只存在于操作系统凭据库，不出现在文件、参数和日志中。
- 新包校验完成前当前 Companion 持续可用。
- 新版健康后才激活；失败时自动恢复上一成功版本。
- GitLab 和网络故障不影响当前看板。
- 在支持 MCP 自动重连和工具元数据刷新的 Codex 版本中，新打开的看板使用新版 UI；已打开看板提供明确重开入口。
- 日常 Companion/UI 更新通常不要求退出 Codex；真实 POC 不满足缓存前提时，产品准确提示重启，不虚报无重启能力。
- 不兼容协议不会进入静默更新，且给出明确插件升级提示。
- Windows、Linux、macOS 的真实端到端更新与回滚验收通过。
- 发布、更新、回滚和凭据异常均具有脱敏日志与 requestId。

## 17. 后续阶段

第一阶段稳定后再评估：

- `beta` 灰度通道和按设备稳定标识分批发布。
- 发布包离线签名与密钥轮换。
- 内网更新代理，消除客户端共享 Deploy Token。
- Updater 自更新和平台安装器升级。
- 增量包与带宽优化。

这些能力不影响第一阶段的稳定插件外壳、独立 Updater、版本化 Companion 和 GitLab Registry 四个核心边界。
