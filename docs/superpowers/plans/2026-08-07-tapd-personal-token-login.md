# TAPD 个人 Token 登录 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 FlowRivet 看板内完成 TAPD 个人 Token 登录，并使用 Windows DPAPI 安全持久化，支持状态恢复与断开连接。

**Architecture:** Companion 内新增 `CredentialStore`、TAPD 身份验证客户端和认证服务三个边界。MCP 工具只接收一次性 Token 并返回非敏感连接状态；React 登录页调用工具并在成功后切换到仍明确标记为 Demo 的看板。Windows DPAPI 通过固定 PowerShell 脚本和 stdin 处理明文，密文原子写入 `%LOCALAPPDATA%\FlowRivet`。

**Tech Stack:** TypeScript、Node.js 22、PowerShell DPAPI、MCP SDK、React 19、Zod、Vitest、Testing Library、Playwright

---

### Task 1: CredentialStore 与 Windows DPAPI

**Files:**
- Create: `packages/codex-plugin/src/auth/credential-store.ts`
- Create: `packages/codex-plugin/src/auth/windows-dpapi-store.ts`
- Test: `packages/codex-plugin/tests/credential-store.test.ts`

- [ ] **Step 1: 写失败的凭据存储测试**

覆盖：通过 stdin 传递 Token、命令参数不包含 Token、密文原子写入、读取解密、删除凭据、非 Windows 返回 `unsupported_platform`、命令失败不留下明文或临时文件。

- [ ] **Step 2: 运行测试确认 RED**

Run: `npm test --workspace @flowrivet/codex-plugin -- credential-store.test.ts`

Expected: FAIL，因为 `CredentialStore` 和 `WindowsDpapiCredentialStore` 尚不存在。

- [ ] **Step 3: 实现接口与 DPAPI 适配器**

定义：

```ts
export interface CredentialStore {
  readTapdToken(): Promise<string | undefined>;
  writeTapdToken(token: string): Promise<void>;
  deleteTapdToken(): Promise<void>;
}
```

DPAPI 脚本使用 `ProtectedDataProtectionScope.CurrentUser`；Token 只从 stdin 读取。凭据 JSON 只包含版本和 Base64 密文，使用同目录临时文件后 `rename` 原子替换。默认目录为 `%LOCALAPPDATA%\FlowRivet`，权限或 DPAPI 失败统一映射为 `credential_store_failed`。

- [ ] **Step 4: 运行测试确认 GREEN**

Run: `npm test --workspace @flowrivet/codex-plugin -- credential-store.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/codex-plugin/src/auth packages/codex-plugin/tests/credential-store.test.ts
git commit -m "feat(auth): store TAPD token with Windows DPAPI"
```

### Task 2: TAPD 身份验证与认证服务

**Files:**
- Create: `packages/codex-plugin/src/auth/tapd-identity-client.ts`
- Create: `packages/codex-plugin/src/auth/tapd-auth-service.ts`
- Create: `packages/codex-plugin/src/contracts/auth.ts`
- Test: `packages/codex-plugin/tests/tapd-auth-service.test.ts`

- [ ] **Step 1: 写失败的身份验证和状态机测试**

覆盖 `GET https://api.tapd.cn/users/info` 的 Bearer 请求、用户/企业解析、401/403/5xx/网络错误分类，以及登录成功后存储、验证失败不存储、已有凭据恢复、无效凭据返回 `expired`、暂时不可用保留凭据、断开删除。

- [ ] **Step 2: 运行测试确认 RED**

Run: `npm test --workspace @flowrivet/codex-plugin -- tapd-auth-service.test.ts`

Expected: FAIL，因为身份客户端和认证服务尚不存在。

- [ ] **Step 3: 实现最小领域逻辑**

定义稳定错误码 `invalid_token`、`permission_denied`、`tapd_unavailable`、`credential_store_failed`、`unsupported_platform`。`TapdAuthService` 只返回：

```ts
type TapdConnection = {
  tapd: "disconnected" | "connected" | "expired";
  userName?: string;
  companyName?: string;
  errorCode?: AuthErrorCode;
};
```

任何错误对象、日志或返回值都不得包含 Token、Authorization 或 TAPD 响应正文。

- [ ] **Step 4: 运行测试和类型检查**

Run: `npm test --workspace @flowrivet/codex-plugin -- tapd-auth-service.test.ts`

Run: `npm run typecheck --workspace @flowrivet/codex-plugin`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/codex-plugin/src/auth packages/codex-plugin/src/contracts/auth.ts packages/codex-plugin/tests/tapd-auth-service.test.ts
git commit -m "feat(auth): validate TAPD personal tokens"
```

### Task 3: MCP 认证工具与动态看板快照

**Files:**
- Modify: `packages/codex-plugin/src/server/app.ts`
- Modify: `packages/codex-plugin/src/contracts/taskboard.ts`
- Modify: `packages/codex-plugin/src/demo/fixtures.ts`
- Test: `packages/codex-plugin/tests/server.test.ts`

- [ ] **Step 1: 写失败的 MCP 合约测试**

覆盖工具列表包含 `get_connection_status`、`login_with_tapd_token`、`disconnect_tapd`；登录工具输入 Token 但输出不含 Token；打开看板时读取真实连接状态；未登录返回空看板而非 Demo 数据；登录后返回明确标记的 Demo 工作项。

- [ ] **Step 2: 运行测试确认 RED**

Run: `npm test --workspace @flowrivet/codex-plugin -- server.test.ts`

Expected: FAIL，因为认证工具尚未注册。

- [ ] **Step 3: 注入认证服务并注册工具**

扩展 `TaskboardMcpServerOptions` 注入 `TapdAuthService`。默认实例使用 Windows DPAPI Store 和 TAPD Identity Client。工具结果使用 Zod 合约，并保持 `open_my_taskboard` 是唯一带 UI Resource 的认证相关工具。

- [ ] **Step 4: 运行 MCP 测试确认 GREEN**

Run: `npm test --workspace @flowrivet/codex-plugin -- server.test.ts`

Expected: PASS，结构化结果不含敏感字段。

- [ ] **Step 5: 提交**

```bash
git add packages/codex-plugin/src/server/app.ts packages/codex-plugin/src/contracts/taskboard.ts packages/codex-plugin/src/demo/fixtures.ts packages/codex-plugin/tests/server.test.ts
git commit -m "feat(plugin): expose TAPD login tools"
```

### Task 4: React Token 登录、恢复与断开

**Files:**
- Create: `packages/codex-plugin/src/ui/components/TapdLogin.tsx`
- Modify: `packages/codex-plugin/src/ui/App.tsx`
- Modify: `packages/codex-plugin/src/ui/components/ConnectionMenu.tsx`
- Modify: `packages/codex-plugin/src/ui/styles.css`
- Modify: `packages/codex-plugin/tests/ui.test.tsx`

- [ ] **Step 1: 写失败的 UI 测试**

覆盖密码输入、空值禁用、提交时禁用、成功后清空并切换看板、失败后清空输入并显示中文错误、expired 重新登录、连接菜单断开。断言 DOM 和错误中不回显 Token。

- [ ] **Step 2: 运行测试确认 RED**

Run: `npm test --workspace @flowrivet/codex-plugin -- ui.test.tsx`

Expected: FAIL，因为登录表单和认证调用尚不存在。

- [ ] **Step 3: 实现登录 UI 和状态流转**

使用密码输入框、`LogIn` 图标和明确状态；不使用浏览器存储。每次提交完成后立即清空 React Token state。成功后展示 Demo 看板及 `Demo 数据` 标识；失败保持登录页。连接菜单提供“断开 TAPD”，成功后清空工作项并回到登录页。

- [ ] **Step 4: 运行插件全量测试和类型检查**

Run: `npm test --workspace @flowrivet/codex-plugin`

Run: `npm run typecheck --workspace @flowrivet/codex-plugin`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/codex-plugin/src/ui packages/codex-plugin/tests/ui.test.tsx
git commit -m "feat(taskboard): add TAPD token login UI"
```

### Task 5: 构建、安全回归与 Windows 实机验收

**Files:**
- Modify: `packages/codex-plugin/e2e/taskboard.spec.ts`
- Modify: `docs/operations/codex-plugin-demo.md`
- Modify: `.codex-plugin/plugin.json`

- [ ] **Step 1: 更新浏览器 E2E 与操作手册**

浏览器 harness 覆盖未登录、无效 Token、登录后 Demo 看板和断开；手册记录个人 Token 本地登录、DPAPI 路径、清理方式和敏感信息禁令。

- [ ] **Step 2: 运行完整自动化验证**

Run: `npm test --workspace @flowrivet/codex-plugin`

Run: `npm run typecheck --workspace @flowrivet/codex-plugin`

Run: `npm run build --workspace @flowrivet/codex-plugin`

Run: `npm run test:e2e --workspace @flowrivet/codex-plugin`

Expected: 全部 PASS；日志、测试输出、构建产物和 Git diff 不包含测试 Token。

- [ ] **Step 3: 运行 Windows 真实 DPAPI 往返测试**

使用随机临时 Token 验证 DPAPI 加密/解密/删除，不调用 TAPD；确认凭据文件中不存在明文。真实 TAPD 登录只在用户提供测试 Token 时执行。

- [ ] **Step 4: 刷新插件 cachebuster 并重新安装**

Run: `python "$env:USERPROFILE\.codex\skills\.system\plugin-creator\scripts\update_plugin_cachebuster.py" .`

Run: `& "$env:USERPROFILE\.codex\plugins\.plugin-appserver\codex.exe" plugin add flowrivet@flowrivet-local`

Expected: `plugin list` 显示新版 `installed, enabled`。

- [ ] **Step 5: 提交**

```bash
git add packages/codex-plugin/e2e/taskboard.spec.ts docs/operations/codex-plugin-demo.md .codex-plugin/plugin.json
git commit -m "docs(auth): document TAPD token login"
```

