# FlowRivet 飞书授权会话重构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有“展示验证码并手动检查”的飞书项目登录改造成系统浏览器一键授权、自动检测结果、可在页面刷新后接回且不泄露临时凭据的本地授权会话。

**Architecture:** 保持 FlowRivet Companion 为仅绑定回环地址的本地进程，在 Provider 连接状态之外新增进程级 `ProviderLoginCoordinator`。Meegle Driver 只负责官方 CLI 的 init、单次 poll、Profile 与身份验证，Coordinator 负责会话状态机、浏览器启动、超时、恢复、取消和脱敏快照；React 只轮询会话快照，授权成功后再独立加载看板。

**Tech Stack:** TypeScript 5.9、Node.js 22 `child_process`、Zod 4、MCP SDK/MCP Apps、React 19、Vitest、Testing Library、Playwright、官方 `@lark-project/meegle` CLI

**Source Spec:** `docs/superpowers/specs/2026-08-11-feishu-project-meegle-provider-design.md`

**Execution Skills:** 实施时逐任务使用 `@superpowers:test-driven-development`；每个提交前使用 `@superpowers:verification-before-completion`。任务必须顺序执行，因为公共合同迁移采用“先新增、后切换、最后删除兼容合同”。

---

## 文件职责

新增文件：

- `packages/codex-plugin/src/providers/provider-login-coordinator.ts`：Provider 中立的授权会话状态机、生命周期、幂等、恢复、取消与脱敏。
- `packages/codex-plugin/src/providers/provider-login-driver.ts`：Provider 授权 Driver 和不透明授权尝试合同。
- `packages/codex-plugin/src/providers/system-browser-launcher.ts`：Windows、macOS、Linux 默认浏览器启动与 URL 允许列表校验。
- `packages/codex-plugin/src/observability/provider-login-operation-logger.ts`：只输出授权状态迁移的允许字段。
- `packages/codex-plugin/src/meegle/meegle-login-driver.ts`：把官方 CLI 两阶段设备授权适配成 Provider Login Driver。
- `packages/codex-plugin/src/ui/use-provider-login.ts`：React 授权会话恢复、轮询、取消、重开和竞态保护。
- `packages/codex-plugin/tests/provider-login-coordinator.test.ts`：会话状态机、敏感字段清理、Profile 漂移与时间边界。
- `packages/codex-plugin/tests/system-browser-launcher.test.ts`：三平台固定命令、URL 校验和启动失败。
- `packages/codex-plugin/tests/provider-login-operation-logger.test.ts`：日志允许字段与敏感信息排除。
- `packages/codex-plugin/tests/use-provider-login.test.tsx`：前端 Hook 的恢复、自动轮询和终态行为。

重点修改文件：

- `packages/codex-plugin/src/contracts/providers.ts`：移除连接态 `authorizing`，新增授权会话、错误和工具结果 Schema。
- `packages/codex-plugin/src/providers/provider-auth-service.ts`：连接/断开与临时授权 Driver 解耦。
- `packages/codex-plugin/src/providers/provider-registry.ts`：注册可选的登录 Driver。
- `packages/codex-plugin/src/meegle/meegle-cli-client.ts`：把长轮询登录拆为显式 Profile 的 init 与单次 poll。
- `packages/codex-plugin/src/meegle/meegle-cli-contracts.ts`：保留敏感 CLI 合同仅供服务端内部使用，并补充结构化终态。
- `packages/codex-plugin/src/meegle/meegle-auth-service.ts`：只负责连接状态、身份绑定和 logout，不再保存授权事务。
- `packages/codex-plugin/src/server/runtime-services.ts`：进程级创建并共享 Login Coordinator。
- `packages/codex-plugin/src/server/app.ts`：注册四个授权工具并返回 `requestId`。
- `packages/codex-plugin/src/server/http.ts`、`packages/codex-plugin/src/server/index.ts`：阻止带授权副作用的服务绑定非回环地址。
- `packages/codex-plugin/src/ui/App.tsx`：接入授权 Hook，分离授权成功与首次任务同步。
- `packages/codex-plugin/src/ui/components/FeishuProjectLogin.tsx`：实现一键授权、阶段提示、重开、取消与手动降级。
- `packages/codex-plugin/src/ui/demo-harness.tsx`：模拟授权会话工具和跨刷新恢复。
- `packages/codex-plugin/src/ui/styles.css`：授权状态、手动降级和移动端布局。
- `packages/codex-plugin/e2e/taskboard.spec.ts`：替换旧验证码/手动检查流程，覆盖刷新恢复和无障碍交互。
- `docs/operations/codex-plugin-demo.md`：更新本地授权与真实账号验收流程。

---

### Task 1: 新增授权会话公共合同并保留迁移兼容性

**Files:**
- Create: `packages/codex-plugin/src/providers/provider-login-driver.ts`
- Modify: `packages/codex-plugin/src/contracts/providers.ts`
- Modify: `packages/codex-plugin/src/providers/provider-auth-service.ts`
- Modify: `packages/codex-plugin/src/providers/provider-registry.ts`
- Modify: `packages/codex-plugin/tests/contracts.test.ts`
- Modify: `packages/codex-plugin/tests/provider-registry.test.ts`

- [ ] **Step 1: 先写授权快照失败测试**

在 `contracts.test.ts` 增加以下核心断言：

```ts
expect(providerLoginSnapshotSchema.parse({
  sessionId: "session-1",
  providerId: "feishu-project",
  state: "waiting",
  startedAt: "2026-08-11T00:00:00.000Z",
  updatedAt: "2026-08-11T00:00:01.000Z",
  expiresAt: "2026-08-11T00:05:00.000Z",
  browserLaunch: "opened",
})).toBeTruthy();
```

同时覆盖 `starting | waiting | verifying | succeeded | failed | expired | cancelled`、可恢复 `provider_browser_launch_failed`、`manualFallback` 仅含 `verificationUri` 和 `userCode`，以及新授权会话 Schema 拒绝 `deviceCode`、`clientId`、Token 和任意 CLI 参数。此任务暂不删除旧 `ProviderLoginTransaction` 与连接态 `authorizing`，确保尚未迁移的 UI 和 MCP Server 继续编译；删除动作固定放在 Task 6。

- [ ] **Step 2: 运行测试确认旧合同失败**

Run:

```powershell
npm test --workspace @flowrivet/codex-plugin -- contracts.test.ts provider-registry.test.ts
```

Expected: FAIL，原因是新授权会话 Schema 和 Driver 合同尚不存在。

- [ ] **Step 3: 实现最小公共合同**

在 `providers.ts` 新增：

```ts
export const providerLoginStates = [
  "starting", "waiting", "verifying", "succeeded", "failed", "expired", "cancelled",
] as const;
```

新增 `providerLoginErrorSchema`、`providerLoginSnapshotSchema`、`providerLoginToolResultSchema` 与 `providerLoginLookupResultSchema`。授权工具结果顶层固定含 `requestId`；查询结果使用可选 `session`，不得用 `null` 和多种空值表达同一语义。旧连接状态数组和 transaction Schema 此时保持原样并标注为迁移兼容合同。

- [ ] **Step 4: 拆分认证服务与登录 Driver 注册位**

新增 `ProviderLoginDriver`，使用 `unknown` 泛型或不透明句柄约束 Provider 私有 attempt。`ProviderRegistration` 新增可选 `login?: ProviderLoginDriver`；`ProviderRegistry.list()` 仍只返回非敏感 Descriptor，不暴露 Driver 或会话。`ProviderAuthService` 的旧 `startLogin/cancelLogin` 暂时保留到 MCP 工具迁移完成。

- [ ] **Step 5: 运行聚焦测试和类型检查**

Run:

```powershell
npm test --workspace @flowrivet/codex-plugin -- contracts.test.ts provider-registry.test.ts
npm run typecheck --workspace @flowrivet/codex-plugin
```

Expected: PASS。新旧合同短暂并存，因此本任务不得修改旧 UI 或服务端行为。

- [ ] **Step 6: 提交合同批次**

```powershell
git add packages/codex-plugin/src/providers/provider-login-driver.ts packages/codex-plugin/src/contracts/providers.ts packages/codex-plugin/src/providers/provider-auth-service.ts packages/codex-plugin/src/providers/provider-registry.ts packages/codex-plugin/tests/contracts.test.ts packages/codex-plugin/tests/provider-registry.test.ts
git commit -m "refactor(auth): separate login sessions from connections"
```

---

### Task 2: 将 Meegle CLI 登录拆成显式 Profile 的两阶段 Driver

**Files:**
- Create: `packages/codex-plugin/src/meegle/meegle-login-driver.ts`
- Create: `packages/codex-plugin/tests/meegle-login-driver.test.ts`
- Modify: `packages/codex-plugin/src/meegle/meegle-cli-client.ts`
- Modify: `packages/codex-plugin/src/meegle/meegle-cli-contracts.ts`
- Modify: `packages/codex-plugin/tests/meegle-cli-client.test.ts`

- [ ] **Step 1: 为 CLI init/poll 和 Profile 固定写失败测试**

将原 `startDeviceLogin` 测试拆成：

```ts
const attempt = await client.initializeDeviceLogin("default", "project.feishu.cn", signal);
expect(runner.run.mock.calls[0]![0].args).toEqual(expect.arrayContaining([
  "--phase", "init", "--profile", "default",
]));
await expect(client.pollDeviceLogin("default", attempt, signal))
  .resolves.toEqual({ state: "pending" });
```

覆盖授权成功、pending、expired、经过探针验证后才允许的 denied、无效结构、取消和命令失败。断言 `MeegleLoginAttempt` 只在服务端内部存在，不能通过公共 Provider Schema 序列化。

- [ ] **Step 2: 运行测试确认失败**

Run:

```powershell
npm test --workspace @flowrivet/codex-plugin -- meegle-cli-client.test.ts meegle-auth-service.test.ts meegle-login-driver.test.ts
```

Expected: FAIL，因为两阶段 API 和 Driver 尚不存在。

- [ ] **Step 3: 实现 CLI 两阶段方法**

`initializeDeviceLogin(profile, host, signal)` 只运行一次 `phase init`，返回内部对象：

```ts
interface MeegleDeviceAttempt {
  profileName: string;
  verificationUri: string;
  verificationUriComplete: string;
  userCode: string;
  clientId: string;
  deviceCode: string;
  intervalSeconds: number;
  expiresAt: string;
}
```

`pollDeviceLogin(profile, attempt, signal)` 只执行一次 `phase poll --once`，返回 `pending | authorized | expired | denied`。所有新命令显式传入捕获的 `--profile`。为保证本批提交后的现有登录仍可用，旧 `startDeviceLogin` 和内部 sleep 暂时保留；Task 5 在 MCP 工具切换后删除。

- [ ] **Step 4: 实现 Meegle Login Driver**

Driver 固定 host 为 `project.feishu.cn`，公开方法包括 `captureProfile`、`initialize`、`poll`、`verifyIdentity` 和 `dispose`。`verifyIdentity` 顺序执行捕获 Profile 的 `auth status` 与 `user me`，只有两者都通过才返回连接身份；Profile 改变返回稳定失败，不得把会话归到新账号。

- [ ] **Step 5: 验证新旧路径短暂并存**

现有 `MeegleAuthService` 和旧 MCP 登录测试必须继续通过，新 Driver 测试独立通过。不得让 Task 2 提交后的本地登录出现 `provider_capability_unsupported`；旧路径的删除与 Server 切换必须在 Task 5 同一提交完成。

- [ ] **Step 6: 运行测试和类型检查**

Run:

```powershell
npm test --workspace @flowrivet/codex-plugin -- meegle-cli-client.test.ts meegle-auth-service.test.ts meegle-login-driver.test.ts
npm run typecheck --workspace @flowrivet/codex-plugin
```

Expected: PASS，且测试不会输出完整 CLI 参数、授权 URL、用户码、设备码或 client ID。

- [ ] **Step 7: 提交 Driver 批次**

```powershell
git add packages/codex-plugin/src/meegle/meegle-login-driver.ts packages/codex-plugin/src/meegle/meegle-cli-client.ts packages/codex-plugin/src/meegle/meegle-cli-contracts.ts packages/codex-plugin/tests/meegle-cli-client.test.ts packages/codex-plugin/tests/meegle-login-driver.test.ts
git commit -m "refactor(meegle): expose bounded login phases"
```

---

### Task 3: 实现安全的系统浏览器启动与回环绑定门禁

**Files:**
- Create: `packages/codex-plugin/src/providers/system-browser-launcher.ts`
- Create: `packages/codex-plugin/tests/system-browser-launcher.test.ts`
- Modify: `packages/codex-plugin/src/server/http.ts`
- Modify: `packages/codex-plugin/src/server/index.ts`
- Modify: `packages/codex-plugin/tests/server.test.ts`

- [ ] **Step 1: 写三平台浏览器和地址校验失败测试**

覆盖：Windows 使用固定 `explorer.exe`，macOS 使用 `/usr/bin/open`，Linux 使用 `xdg-open`；均使用参数数组、`shell: false`、隐藏窗口或 detached，不接受调用方提供可执行文件。拒绝 HTTP、用户名密码 URL、非飞书域名、子域混淆和带控制字符输入。

- [ ] **Step 2: 写非回环 Host 启动失败测试**

```ts
expect(() => assertLoopbackHost("0.0.0.0")).toThrow("FLOWRIVET_MCP_HOST");
expect(() => assertLoopbackHost("10.0.0.8")).toThrow("FLOWRIVET_MCP_HOST");
expect(() => assertLoopbackHost("127.0.0.1")).not.toThrow();
expect(() => assertLoopbackHost("::1")).not.toThrow();
```

保留并扩展 HTTP Origin 测试：非回环 Origin 返回 403；无 Origin 的本地 MCP 客户端仍可调用。

- [ ] **Step 3: 运行测试确认失败**

Run:

```powershell
npm test --workspace @flowrivet/codex-plugin -- system-browser-launcher.test.ts server.test.ts
```

Expected: FAIL，因为启动器与 Host 门禁尚不存在。

- [ ] **Step 4: 实现注入式 SystemBrowserLauncher**

只接受 Driver 生成的 URL 和 Provider 预注册的精确主机集合；首版 Meegle 仅允许探针验证的 `project.feishu.cn` 与 `open.feishu.cn`，不接受通配符或仅按域名后缀匹配。标准化后验证 HTTPS、hostname、默认端口和空凭据字段。启动成功在子进程产生后立即返回 `opened`；同步 spawn 错误或早期 error 事件返回 `manual_required`，不得执行 shell 字符串。

- [ ] **Step 5: 在进程入口强制回环绑定**

把 `isLoopbackHost`/`assertLoopbackHost` 放在无副作用模块中供测试。`index.ts` 在创建 Server 前校验 `FLOWRIVET_MCP_HOST`；当前版本不提供绕过开关。

- [ ] **Step 6: 验证并提交安全边界**

Run:

```powershell
npm test --workspace @flowrivet/codex-plugin -- system-browser-launcher.test.ts server.test.ts
npm run typecheck --workspace @flowrivet/codex-plugin
```

Expected: PASS。

```powershell
git add packages/codex-plugin/src/providers/system-browser-launcher.ts packages/codex-plugin/tests/system-browser-launcher.test.ts packages/codex-plugin/src/server/http.ts packages/codex-plugin/src/server/index.ts packages/codex-plugin/tests/server.test.ts
git commit -m "feat(auth): open login only from loopback companion"
```

---

### Task 4: 实现进程级 ProviderLoginCoordinator 与脱敏日志

**Files:**
- Create: `packages/codex-plugin/src/providers/provider-login-coordinator.ts`
- Create: `packages/codex-plugin/src/observability/provider-login-operation-logger.ts`
- Create: `packages/codex-plugin/tests/provider-login-coordinator.test.ts`
- Create: `packages/codex-plugin/tests/provider-login-operation-logger.test.ts`

- [ ] **Step 1: 写状态机与幂等失败测试**

使用可控 clock、timer、Driver 和 BrowserLauncher 覆盖：同 Provider 重复 start 复用同一活动 `sessionId`；启动顺序为 `starting -> waiting -> verifying -> succeeded`；同一 Provider 新会话替换旧终态；不同 Provider 不共享状态。

- [ ] **Step 2: 写恢复、取消和时间边界失败测试**

覆盖 `get(providerId)` 返回唯一活动或最近终态；会话过期取 CLI `expiresAt` 与 5 分钟上限的较早值并 abort；终态保留 10 分钟后返回空；取消只终止匹配活动会话；未知/过期 session 的 reopen/cancel 返回稳定错误；Companion 内对象重建后不恢复旧内存会话。

- [ ] **Step 3: 写安全与 Profile 漂移失败测试**

断言活动内部记录可以持有不透明 attempt，但所有公开快照、错误、日志和 JSON 都不包含 `clientId`、`deviceCode`、完整授权 URL、用户码（浏览器启动失败的 `manualFallback` 除外）、stdout/stderr 或 Profile 内容。浏览器首次启动失败后，reopen 成功必须改为 `browserLaunch: "opened"` 并立即清除 `manualFallback`。Profile 在 init 后变化时进入 `failed`，不执行身份归属或写入成功状态。

- [ ] **Step 4: 写日志白名单失败测试**

日志只允许 `requestId`、`correlationId`、工具名、Provider ID、CLI 版本、命令类别、状态迁移、结果、稳定错误码、重试次数和耗时。测试传入带敏感字段的 Error/metadata，序列化结果不得出现其值或字段名。

- [ ] **Step 5: 实现 Coordinator 最小状态机**

Coordinator 注入 `clock`、`idFactory`、`setTimeout/clearTimeout`、logger、launcher 和 Driver resolver。每个 Provider 仅一个活动记录；后台 poll 严格使用 Driver 给出的间隔，不因 UI 查询频率加速。浏览器启动失败保持 `waiting`，设置 `browserLaunch: "manual_required"` 与临时 `manualFallback`；任一终态立即调用 `dispose` 并删除内部 attempt。

- [ ] **Step 6: 实现终态与错误映射**

只有 Driver 返回经过验证的 denied 才映射 `provider_login_denied`；未知授权终态为 `provider_login_failed`。授权成功后先进入 `verifying`，身份验证有限重试；网络失败保留 CLI 已写入凭据并提供 `recheck_connection`，不回退成重新授权。

- [ ] **Step 7: 运行测试、检查泄漏并提交**

Run:

```powershell
npm test --workspace @flowrivet/codex-plugin -- provider-login-coordinator.test.ts provider-login-operation-logger.test.ts
rg -n "console\.(log|error)|stdout|stderr|deviceCode|clientId" packages/codex-plugin/src/providers/provider-login-coordinator.ts packages/codex-plugin/src/observability/provider-login-operation-logger.ts
npm run typecheck --workspace @flowrivet/codex-plugin
```

Expected: 测试通过；`rg` 只命中明确的禁止字段过滤或内部清理代码，不命中日志输出载荷。

```powershell
git add packages/codex-plugin/src/providers/provider-login-coordinator.ts packages/codex-plugin/src/observability/provider-login-operation-logger.ts packages/codex-plugin/tests/provider-login-coordinator.test.ts packages/codex-plugin/tests/provider-login-operation-logger.test.ts
git commit -m "feat(auth): coordinate recoverable provider logins"
```

---

### Task 5: 将授权会话接入进程级 Runtime 和 MCP 工具

**Files:**
- Modify: `packages/codex-plugin/src/providers/provider-auth-service.ts`
- Modify: `packages/codex-plugin/src/meegle/meegle-cli-client.ts`
- Modify: `packages/codex-plugin/src/meegle/meegle-auth-service.ts`
- Modify: `packages/codex-plugin/src/server/runtime-services.ts`
- Modify: `packages/codex-plugin/src/server/app.ts`
- Modify: `packages/codex-plugin/tests/meegle-cli-client.test.ts`
- Modify: `packages/codex-plugin/tests/meegle-auth-service.test.ts`
- Modify: `packages/codex-plugin/tests/server.test.ts`
- Modify: `packages/codex-plugin/tests/taskboard-runtime.test.ts`

- [ ] **Step 1: 写 Runtime 共享会话失败测试**

创建两个 MCP Server 实例但注入同一 `RuntimeServices`，从第一个调用 start、第二个调用 get，断言得到相同 `sessionId`。重建 Runtime 后查询为空，再由 `get_provider_connection` 读取 CLI 实际连接状态。

- [ ] **Step 2: 写四个授权工具合同失败测试**

工具集必须包含：

```text
start_provider_login
get_provider_login
reopen_provider_login
cancel_provider_login
```

每个结果含唯一 `requestId`。start/reopen 的注解为 `readOnlyHint: false, openWorldHint: true`；get 为只读；cancel 为非只读且 `openWorldHint: false`。reopen/cancel 只接受 `sessionId`，不接受 URL、Profile、host、命令或参数。

- [ ] **Step 3: 运行测试确认失败**

Run:

```powershell
npm test --workspace @flowrivet/codex-plugin -- server.test.ts taskboard-runtime.test.ts
```

Expected: FAIL，因为 Runtime 尚未共享 Coordinator，工具仍返回旧 transaction。

- [ ] **Step 4: 组装默认 Runtime**

创建一个 `MeegleLoginDriver`、一个 `SystemBrowserLauncher` 和一个 `ProviderLoginCoordinator`，将 Driver 注册到 `feishu-project`，Coordinator 存入 `RuntimeServices`。不得在每次 MCP 请求或每个 `McpServer` 内重建。

- [ ] **Step 5: 替换授权工具实现**

`start` 调用 `coordinator.start(providerId, requestId)`；`get` 按当前 Provider 查询；`reopen/cancel` 同时校验当前 Provider 与 `sessionId`。`get_provider_connection` 保持纯连接状态，不读取授权会话。所有异常只返回稳定错误码和 requestId，不透传 CLI Error、stdout 或 stderr。

- [ ] **Step 6: 删除旧服务端登录路径**

在四个新工具测试通过后，删除 `MeegleCliClient.startDeviceLogin`、`MeegleAuthService.loginByProfile/startLogin/cancelLogin` 和 `ProviderAuthService.startLogin/cancelLogin`，同步删除旧测试。`MeegleAuthService` 仅保留连接、身份缓存和 logout；`getConnection()` 不再实际生成 `authorizing`。

- [ ] **Step 7: 验证并提交 MCP 批次**

Run:

```powershell
npm test --workspace @flowrivet/codex-plugin -- server.test.ts taskboard-runtime.test.ts provider-registry.test.ts meegle-cli-client.test.ts meegle-auth-service.test.ts
npm run typecheck --workspace @flowrivet/codex-plugin
```

Expected: PASS。

```powershell
git add packages/codex-plugin/src/providers/provider-auth-service.ts packages/codex-plugin/src/meegle/meegle-cli-client.ts packages/codex-plugin/src/meegle/meegle-auth-service.ts packages/codex-plugin/src/server/runtime-services.ts packages/codex-plugin/src/server/app.ts packages/codex-plugin/tests/meegle-cli-client.test.ts packages/codex-plugin/tests/meegle-auth-service.test.ts packages/codex-plugin/tests/server.test.ts packages/codex-plugin/tests/taskboard-runtime.test.ts
git commit -m "feat(mcp): expose provider login sessions"
```

---

### Task 6: 重构 React 为一键授权和自动恢复

**Files:**
- Create: `packages/codex-plugin/src/ui/use-provider-login.ts`
- Create: `packages/codex-plugin/tests/use-provider-login.test.tsx`
- Modify: `packages/codex-plugin/src/contracts/providers.ts`
- Modify: `packages/codex-plugin/src/ui/App.tsx`
- Modify: `packages/codex-plugin/src/ui/components/FeishuProjectLogin.tsx`
- Modify: `packages/codex-plugin/tests/contracts.test.ts`
- Modify: `packages/codex-plugin/tests/ui.test.tsx`

- [ ] **Step 1: 写 Hook 恢复与自动轮询失败测试**

挂载时先调用 `get_provider_login`；活动会话每 1.5 秒查询；查询未完成时不重叠请求；组件卸载停止 timer；重新挂载接回相同 session。等待 15 秒只把提示切为“仍在等待飞书确认”，不调用任何手动检查工具。

- [ ] **Step 2: 写终态和竞态失败测试**

覆盖 succeeded 后只调用一次 `onConnected`；failed/expired/cancelled 停止轮询并显示唯一恢复动作；过期请求返回不得覆盖较新 session；浏览器启动失败展示临时链接与验证码；正常 waiting 状态 DOM 中不得出现验证码、授权 URL或“检查授权结果”。

- [ ] **Step 3: 运行测试确认失败**

Run:

```powershell
npm test --workspace @flowrivet/codex-plugin -- use-provider-login.test.tsx ui.test.tsx
```

Expected: FAIL，因为 UI 仍使用 transaction 和 `get_provider_connection` 检查授权。

- [ ] **Step 4: 实现 `useProviderLogin`**

Hook 对外只返回安全快照、`pendingAction`、阶段文案、`start`、`reopen`、`cancel` 与 `clearTerminal`。所有工具结果先过 Zod；以递增 sequence 和 sessionId 防止旧请求覆盖新状态。Hook 不写 localStorage/sessionStorage，不持有 CLI 原始输出。

- [ ] **Step 5: 重写 FeishuProjectLogin 状态展示**

首次连接使用不可关闭全页状态；有缓存时使用可关闭 dialog。阶段依次为“正在准备安全授权会话”“请在浏览器中完成飞书授权”“正在确认账号”。15 秒后保留“重新打开授权页”和“取消”。只有 `manual_required` 展示可复制临时入口和备用码。状态更新使用 `aria-live="polite"`，错误 `role="alert"`，所有按钮有可读名称和稳定尺寸。

- [ ] **Step 6: 在 App 中分离授权成功与看板同步**

授权 succeeded 后先调用 `get_provider_connection` 确认 connected，再独立调用 `open_my_taskboard`。同步失败保留 connected 与缓存，显示“已连接，但任务同步失败”；不得重新打开登录页。断开前仍走现有确认流程，并取消当前活动授权会话。

- [ ] **Step 7: 删除迁移兼容合同**

确认 App、Server 和 Meegle 实现均不再引用旧 transaction 后，从 `ProviderConnectionState` 删除 `authorizing`，删除 `providerLoginTransactionSchema`/`ProviderLoginTransaction`。在 `contracts.test.ts` 新增最终断言：连接 Schema 拒绝 `authorizing`，全仓 `rg` 不再命中旧 transaction 类型或“检查授权结果”。

- [ ] **Step 8: 运行 UI 测试和类型检查**

Run:

```powershell
npm test --workspace @flowrivet/codex-plugin -- use-provider-login.test.tsx ui.test.tsx bridge.test.ts
npm run typecheck --workspace @flowrivet/codex-plugin
rg -n "ProviderLoginTransaction|providerLoginTransactionSchema|检查授权结果" packages/codex-plugin/src packages/codex-plugin/tests
```

Expected: 测试与类型检查 PASS；Testing Library 不报告 act、焦点或无障碍名称警告；`rg` 无命中。

- [ ] **Step 9: 提交 React 批次**

```powershell
git add packages/codex-plugin/src/contracts/providers.ts packages/codex-plugin/src/ui/use-provider-login.ts packages/codex-plugin/src/ui/App.tsx packages/codex-plugin/src/ui/components/FeishuProjectLogin.tsx packages/codex-plugin/tests/contracts.test.ts packages/codex-plugin/tests/use-provider-login.test.tsx packages/codex-plugin/tests/ui.test.tsx
git commit -m "feat(ui): automate Feishu browser authorization"
```

---

### Task 7: 更新 Harness、样式与浏览器 E2E

**Files:**
- Modify: `packages/codex-plugin/src/ui/demo-harness.tsx`
- Modify: `packages/codex-plugin/src/ui/styles.css`
- Modify: `packages/codex-plugin/e2e/taskboard.spec.ts`

- [ ] **Step 1: 为 Harness 增加确定性授权状态机**

按调用次数返回 `starting -> waiting -> verifying -> succeeded`，并增加 `manual-browser`、`expired-login` 和 `offline` 场景。Harness 只使用合成 session、账号和 URL；刷新 iframe 后仍由父 Harness 返回同一活动 session。

- [ ] **Step 2: 替换旧 E2E 断言**

删除“输入验证码”和“检查授权结果”测试，新增：一次点击自动进入 waiting；正常流无验证码；15 秒提示变化；刷新 iframe 接回同一 session；成功自动加载看板；手动降级可复制；缓存重连 dialog 可关闭且恢复焦点；首次连接不可关闭。

- [ ] **Step 3: 完成响应式与无障碍样式**

复用现有 shadcn 风格色彩和 8px 以内圆角。授权面板在 390x844、900x700、1440x900 下无外层横向溢出；长 URL/错误码换行；按钮文字不挤压；spinner 不改变布局尺寸；dialog 不嵌套卡片。

- [ ] **Step 4: 构建并运行 Playwright**

Run:

```powershell
npm run build --workspace @flowrivet/codex-plugin
npm run test:e2e --workspace @flowrivet/codex-plugin
```

Expected: 所有 Playwright 用例 PASS；桌面和移动截图非空，无控件重叠、裁切或页面级横向溢出。

- [ ] **Step 5: 提交 E2E 批次**

```powershell
git add packages/codex-plugin/src/ui/demo-harness.tsx packages/codex-plugin/src/ui/styles.css packages/codex-plugin/e2e/taskboard.spec.ts
git commit -m "test(auth): cover recoverable browser login"
```

---

### Task 8: 真实账号验收、文档与全量回归

**Files:**
- Modify: `docs/operations/codex-plugin-demo.md`
- Create: `docs/abf-poc/2026-08-11-feishu-auth-session-results.md`

- [ ] **Step 1: 更新本地使用说明**

记录前置条件：Node.js 22、Meegle CLI >= 1.0.19、Companion 仅监听 `127.0.0.1`。用户只需点击“连接飞书项目”，系统浏览器授权后页面自动继续；只有浏览器启动失败才使用临时手动入口。说明 Companion 重启后会根据 CLI 实际状态恢复，而不会恢复内存会话。

- [ ] **Step 2: 在 Windows 用真实账号执行完整 E2E**

先确认当前 Profile，启动本地 Companion 和 Codex 插件；从未登录状态点击一次连接，在系统默认浏览器点击一次授权。授权等待期间刷新看板，确认 sessionId 不变；CLI 报告成功后 2 秒内 UI 进入 connected；随后自动拉取 `this_week`、`overdue`、`done` 并与脱敏 CLI 计数核对。

- [ ] **Step 3: 执行异常验收**

分别验证：默认浏览器启动失败进入手动降级；取消和 5 分钟过期停止轮询；断网后保留凭据和缓存；授权成功但首次同步失败仍显示 connected；切换 CLI Profile 后旧会话失败且不污染账号；非回环 `FLOWRIVET_MCP_HOST=0.0.0.0` 启动失败。

- [ ] **Step 4: 记录脱敏结果**

结果文档只记录日期、平台、CLI 版本、场景、耗时范围、PASS/FAIL 和稳定错误码。不得记录姓名、Profile、项目、工作项、授权 URL、验证码、设备码、client ID、Token、stdout 或 stderr。

- [ ] **Step 5: 运行全量验证**

Run:

```powershell
npm test --workspace @flowrivet/codex-plugin
npm run typecheck --workspace @flowrivet/codex-plugin
npm run build --workspace @flowrivet/codex-plugin
npm run test:e2e --workspace @flowrivet/codex-plugin
git diff --check
git status --short
```

Expected: 单元、类型、构建和浏览器 E2E 全部 PASS；`git diff --check` 无错误；工作区只包含本任务文档结果。

- [ ] **Step 6: 提交验收文档**

```powershell
git add docs/operations/codex-plugin-demo.md docs/abf-poc/2026-08-11-feishu-auth-session-results.md
git commit -m "docs(auth): record local Feishu login acceptance"
```

---

## 完成条件

- Provider 连接状态与临时授权会话完全分离，`authorizing` 不再出现在连接合同。
- 正常用户路径只有一次 FlowRivet 连接点击和一次飞书网页授权点击，无验证码输入和手动检查。
- 页面刷新、面板关闭和 MCP Server 重建可在同一 Companion 进程内接回会话；Companion 重启按 CLI 真实状态恢复。
- 临时敏感字段只存在于 Coordinator 活动记录，终态立即清除，不进入 React、缓存、磁盘、日志或 MCP 错误。
- Companion 拒绝非回环绑定，浏览器启动器不能执行调用方提供的 URL、命令或参数。
- 授权成功与首次任务同步独立；同步失败不撤销 connected。
- Windows 真实账号 E2E、跨平台启动器单测、单元测试、类型检查、构建和 Playwright 全部通过。
