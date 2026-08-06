# Codex TAPD 待办看板 Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Windows Codex 中安装并启用 FlowRivet 私有插件，通过 `open_my_taskboard` 打开一个使用模拟数据、支持拖动和 MCP Apps bridge 调用的全屏 React 待办看板。

**Architecture:** 仓库根目录继续作为 FlowRivet 插件包，`.mcp.json` 将插件连接到本机 Companion 的 Streamable HTTP `/mcp` 端点。`packages/codex-plugin` 内部分为 MCP Server、共享契约和 React UI；MCP Server 内联生产构建后的 UI 资源，并用 MCP Apps 标准的 `_meta.ui.resourceUri` 与 `ui/*` bridge 连接 UI。Phase 0 只使用内存模拟数据，不包含 TAPD OAuth、TAPD API、SQLite 或系统凭据库。

**Tech Stack:** Node.js 22、TypeScript 5.9、React 19、Vite 8、Vitest、Testing Library、MCP TypeScript SDK、MCP Apps SDK、dnd-kit、CSS variables（shadcn 风格）、Playwright。

**Design Spec:** `docs/superpowers/specs/2026-08-06-tapd-my-work-taskboard-design.md`

---

## 文件结构

Phase 0 结束时，插件相关文件应形成以下边界：

```text
.codex-plugin/plugin.json               # 插件元数据及 MCP/Skill 入口
.mcp.json                               # 本地 FlowRivet MCP HTTP 连接
skills/my-tapd-taskboard/SKILL.md        # 引导 Codex 调用看板工具
packages/codex-plugin/
├── package.json                         # server/web/test/build scripts 与依赖
├── tsconfig.json                        # server/shared TypeScript 配置
├── vite.config.ts                       # UI 单文件构建配置
├── vitest.config.ts                     # node + jsdom 测试项目
├── src/
│   ├── contracts/taskboard.ts           # UI 与 MCP 共用的输入输出类型和 schema
│   ├── demo/fixtures.ts                 # 唯一模拟业务数据源
│   ├── server/app.ts                    # MCP tools/resource 注册
│   ├── server/http.ts                   # Streamable HTTP、CORS、健康检查
│   ├── server/index.ts                  # 进程入口、端口与启动日志
│   ├── ui/bridge.ts                     # MCP Apps JSON-RPC bridge
│   ├── ui/taskboard.html                # Vite/MCP Apps HTML 入口
│   ├── ui/main.tsx                      # React 挂载入口
│   ├── ui/demo-harness.tsx              # 仅供 Playwright 的显式模拟宿主
│   ├── ui/styles.css                    # shadcn 风格 token 与响应式布局
│   ├── ui/App.tsx                       # 页面状态组合
│   ├── ui/components/AppHeader.tsx
│   ├── ui/components/ConnectionMenu.tsx
│   ├── ui/components/ProjectSidebar.tsx
│   ├── ui/components/TaskBoard.tsx
│   ├── ui/components/TaskColumn.tsx
│   └── ui/components/WorkItemCard.tsx
├── tests/
│   ├── contracts.test.ts
│   ├── server.test.ts
│   ├── bridge.test.ts
│   └── ui.test.tsx
└── e2e/taskboard.spec.ts
scripts/validate-plugin.ps1             # 插件结构与安装前检查
docs/operations/codex-plugin-demo.md    # 启动、安装、刷新和验收步骤
```

`packages/codex-plugin/dist/` 为构建产物，不提交。MCP Server 启动前必须检测 UI 构建产物是否存在，并在缺失时给出可执行的错误信息。

### Task 1: 建立 Phase 0 的共享契约和模拟数据

**Files:**
- Modify: `packages/codex-plugin/package.json`
- Modify: `packages/codex-plugin/tsconfig.json`
- Create: `packages/codex-plugin/vitest.config.ts`
- Create: `packages/codex-plugin/src/contracts/taskboard.ts`
- Create: `packages/codex-plugin/src/demo/fixtures.ts`
- Create: `packages/codex-plugin/tests/contracts.test.ts`
- Delete: `packages/codex-plugin/src/index.ts`

- [ ] **Step 1: 添加最小测试依赖与脚本**

在 `packages/codex-plugin/package.json` 中加入 `zod` 运行依赖及 `vitest` 开发依赖，并定义：

```json
{
  "scripts": {
    "build": "npm run build:server && npm run build:ui",
    "build:server": "tsc -p tsconfig.json",
    "build:ui": "vite build",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

运行 `npm install`，让根目录 `package-lock.json` 记录 workspace 依赖。

- [ ] **Step 2: 编写失败的共享契约测试**

在 `packages/codex-plugin/tests/contracts.test.ts` 验证：

```ts
expect(taskboardSnapshotSchema.parse(demoTaskboardSnapshot)).toMatchObject({
  connection: { tapd: "connected", gitlab: "not_configured" },
  stages: ["todo", "in_progress", "in_review", "done"],
});
expect(new Set(demoTaskboardSnapshot.items.map((item) => item.kind))).toEqual(
  new Set(["story", "task", "bug"]),
);
expect(demoTaskboardSnapshot.projects.length).toBeGreaterThan(1);
```

- [ ] **Step 3: 运行测试并确认失败**

Run: `npm test --workspace @flowrivet/codex-plugin -- contracts.test.ts`

Expected: FAIL，提示 `taskboard` 或 `fixtures` 模块不存在。

- [ ] **Step 4: 实现共享 schema 和单一模拟数据源**

`taskboard.ts` 至少导出：

```ts
export const canonicalStages = ["todo", "in_progress", "in_review", "done"] as const;
export const workItemKinds = ["story", "task", "bug"] as const;
export const connectionStates = ["disconnected", "connecting", "connected", "expired"] as const;

export const taskboardSnapshotSchema = z.object({
  connection: z.object({
    tapd: z.enum(connectionStates),
    gitlab: z.literal("not_configured"),
    userName: z.string().optional(),
    companyName: z.string().optional(),
  }),
  projects: z.array(z.object({ id: z.string(), name: z.string(), count: z.number().int() })),
  stages: z.tuple([
    z.literal("todo"),
    z.literal("in_progress"),
    z.literal("in_review"),
    z.literal("done"),
  ]),
  items: z.array(z.object({
    key: z.string(),
    tapdId: z.string(),
    workspaceId: z.string(),
    workspaceName: z.string(),
    kind: z.enum(workItemKinds),
    title: z.string(),
    stage: z.enum(canonicalStages),
    priority: z.string().optional(),
    dueAt: z.string().optional(),
  })),
  lastSyncedAt: z.string(),
});

export type TaskboardSnapshot = z.infer<typeof taskboardSnapshotSchema>;
```

`fixtures.ts` 只导出一个通过 schema 校验的 `demoTaskboardSnapshot`，包含至少 2 个项目、三种工作项和四个阶段。

- [ ] **Step 5: 运行测试和类型检查**

Run: `npm test --workspace @flowrivet/codex-plugin -- contracts.test.ts`

Expected: PASS。

Run: `npm run typecheck --workspace @flowrivet/codex-plugin`

Expected: PASS。

- [ ] **Step 6: 提交共享契约**

```powershell
git add package-lock.json packages/codex-plugin/package.json packages/codex-plugin/tsconfig.json packages/codex-plugin/vitest.config.ts packages/codex-plugin/src/contracts/taskboard.ts packages/codex-plugin/src/demo/fixtures.ts packages/codex-plugin/tests/contracts.test.ts packages/codex-plugin/src/index.ts
git commit -m "feat(taskboard): define demo board contract"
```

### Task 2: 实现 MCP Apps Server 和 UI Resource

**Files:**
- Modify: `packages/codex-plugin/package.json`
- Create: `packages/codex-plugin/src/server/app.ts`
- Create: `packages/codex-plugin/src/server/http.ts`
- Create: `packages/codex-plugin/src/server/index.ts`
- Create: `packages/codex-plugin/tests/server.test.ts`

- [ ] **Step 1: 安装 MCP 运行依赖**

添加 `@modelcontextprotocol/sdk`、`@modelcontextprotocol/ext-apps`，并加入：

```json
{
  "scripts": {
    "start": "node dist/server/index.js",
    "dev:server": "node --watch dist/server/index.js"
  }
}
```

Run: `npm install`

Expected: 根目录 `package-lock.json` 更新成功。

- [ ] **Step 2: 编写失败的 MCP 合约测试**

`server.test.ts` 使用 MCP SDK 的 in-memory transport 创建 client/server 对，断言：

```ts
expect(toolNames).toEqual(expect.arrayContaining(["open_my_taskboard", "demo_ping"]));
expect(resource.mimeType).toBe("text/html;profile=mcp-app");
expect(openResult.structuredContent).toEqual(demoTaskboardSnapshot);
expect(openTool._meta?.ui?.resourceUri).toBe("ui://flowrivet/taskboard.html");
expect(pingResult.structuredContent).toMatchObject({ ok: true });
```

另测 UI bundle 不存在时，resource read 返回明确错误，并包含 `npm run build:ui --workspace @flowrivet/codex-plugin`。

- [ ] **Step 3: 运行测试并确认失败**

Run: `npm test --workspace @flowrivet/codex-plugin -- server.test.ts`

Expected: FAIL，提示 `createTaskboardMcpServer` 不存在。

- [ ] **Step 4: 实现工具与资源注册**

在 `app.ts`：

- 定义 `TASKBOARD_RESOURCE_URI = "ui://flowrivet/taskboard.html"`。
- 用 `registerAppResource` 注册 `text/html;profile=mcp-app` 资源。
- 仅 `open_my_taskboard` 携带 `_meta.ui.resourceUri`。
- `open_my_taskboard` 返回完整 `structuredContent` 和简短 model-readable `content`。
- `demo_ping` 接收可选 `message`，返回 `{ ok: true, message, repliedAt }`，不触发 UI 重挂载。
- 从 `dist/ui/taskboard.html` 读取构建结果，不在 server 源码复制 HTML。

- [ ] **Step 5: 实现 Streamable HTTP 适配层**

`http.ts` 必须暴露可测试的 `createTaskboardHttpServer()`：

- `GET /health` 返回 `{ "status": "ok" }`。
- `/mcp` 支持 `POST`、`GET`、`DELETE` 和 `OPTIONS`。
- Phase 0 使用无 session 的 Streamable HTTP JSON response 模式。
- CORS 只允许回环地址来源；未知路径返回 404。
- 每个 MCP 请求创建独立 server/transport，并在响应关闭时释放。

`index.ts` 只负责读取 `FLOWRIVET_MCP_HOST`（默认 `127.0.0.1`）和 `FLOWRIVET_MCP_PORT`（默认 `43120`）、启动服务及输出一行端点日志。

- [ ] **Step 6: 运行 MCP 测试与类型检查**

Run: `npm test --workspace @flowrivet/codex-plugin -- server.test.ts`

Expected: PASS。

Run: `npm run typecheck --workspace @flowrivet/codex-plugin`

Expected: PASS。

- [ ] **Step 7: 提交 MCP Server**

```powershell
git add package-lock.json packages/codex-plugin/package.json packages/codex-plugin/src/server/app.ts packages/codex-plugin/src/server/http.ts packages/codex-plugin/src/server/index.ts packages/codex-plugin/tests/server.test.ts
git commit -m "feat(taskboard): expose demo MCP app"
```

### Task 3: 实现标准 MCP Apps bridge

**Files:**
- Modify: `packages/codex-plugin/package.json`
- Create: `packages/codex-plugin/src/ui/bridge.ts`
- Create: `packages/codex-plugin/tests/bridge.test.ts`

- [ ] **Step 1: 配置 jsdom 测试环境**

加入 `jsdom`，并让 `vitest.config.ts` 按 `tests/bridge.test.ts` 和 `tests/ui.test.tsx` 使用 `jsdom`，server tests 继续使用 `node`。

- [ ] **Step 2: 编写失败的 bridge 测试**

测试必须覆盖：

```ts
const bridge = createMcpAppsBridge(fakeParentWindow);
const initialized = bridge.initialize({ name: "flowrivet-taskboard", version: "0.1.0" });
dispatchRpcResponseFor("ui/initialize");
await initialized;
expect(postedMethods()).toEqual(["ui/initialize", "ui/notifications/initialized"]);

const ping = bridge.callTool("demo_ping", { message: "hello" });
dispatchRpcResponseFor("tools/call", { structuredContent: { ok: true } });
await expect(ping).resolves.toMatchObject({ structuredContent: { ok: true } });
```

同时验证：只接受 `event.source === window.parent`、错误 response 会 reject、dispose 后移除监听器、`ui/notifications/tool-result` 可订阅。

- [ ] **Step 3: 运行测试并确认失败**

Run: `npm test --workspace @flowrivet/codex-plugin -- bridge.test.ts`

Expected: FAIL，提示 `createMcpAppsBridge` 不存在。

- [ ] **Step 4: 实现最小 bridge**

`bridge.ts` 使用 MCP Apps 标准 JSON-RPC over `postMessage`：

- `ui/initialize` 使用当前官方协议版本，并在成功后发送 `ui/notifications/initialized`。
- `tools/call` 统一走自增 request ID 与 pending map。
- 对工具结果通知提供 subscribe/unsubscribe。
- 提供请求超时和 dispose，避免 iframe 重挂载后遗留 Promise。
- 不使用 `window.openai`，Phase 0 先验证可移植标准。

- [ ] **Step 5: 运行 bridge 测试**

Run: `npm test --workspace @flowrivet/codex-plugin -- bridge.test.ts`

Expected: PASS。

- [ ] **Step 6: 提交 bridge**

```powershell
git add package-lock.json packages/codex-plugin/package.json packages/codex-plugin/vitest.config.ts packages/codex-plugin/src/ui/bridge.ts packages/codex-plugin/tests/bridge.test.ts
git commit -m "feat(taskboard): add MCP Apps bridge"
```

### Task 4: 构建 shadcn 风格的 React 看板

**Files:**
- Modify: `packages/codex-plugin/package.json`
- Create: `packages/codex-plugin/vite.config.ts`
- Create: `packages/codex-plugin/src/ui/main.tsx`
- Create: `packages/codex-plugin/src/ui/taskboard.html`
- Create: `packages/codex-plugin/src/ui/App.tsx`
- Create: `packages/codex-plugin/src/ui/styles.css`
- Create: `packages/codex-plugin/src/ui/components/AppHeader.tsx`
- Create: `packages/codex-plugin/src/ui/components/ConnectionMenu.tsx`
- Create: `packages/codex-plugin/src/ui/components/ProjectSidebar.tsx`
- Create: `packages/codex-plugin/src/ui/components/TaskBoard.tsx`
- Create: `packages/codex-plugin/src/ui/components/TaskColumn.tsx`
- Create: `packages/codex-plugin/src/ui/components/WorkItemCard.tsx`
- Create: `packages/codex-plugin/tests/ui.test.tsx`

- [ ] **Step 1: 安装 React UI 依赖**

加入 `react`、`react-dom`、`@dnd-kit/core`、`@dnd-kit/sortable`、`lucide-react`；开发依赖加入 Vite、React plugin、`vite-plugin-singlefile`、Testing Library、`@testing-library/user-event` 和 React 类型。同步修改 `tsconfig.json`，包含 `src/**/*.tsx`、DOM lib 和 `react-jsx`，使 UI 和 server 共用严格类型检查。

Run: `npm install`

Expected: workspace 安装成功且无 peer dependency error。

- [ ] **Step 2: 编写失败的页面状态测试**

`ui.test.tsx` 至少验证：

- connected snapshot 显示四列、两个项目、三种工作项和最后同步时间。
- 点击项目仅显示该项目卡片，点击“全部待办”恢复。
- disconnected snapshot 不显示空看板，显示“登录 TAPD”主操作。
- expired snapshot 显示缓存过期提示并禁用拖动。
- GitLab 始终显示“后续接入”，没有可点击的假登录按钮。
- 点击“测试连接”调用 `demo_ping` 并显示成功或失败结果。

- [ ] **Step 3: 运行 UI 测试并确认失败**

Run: `npm test --workspace @flowrivet/codex-plugin -- ui.test.tsx`

Expected: FAIL，提示 `App` 不存在。

- [ ] **Step 4: 实现页面布局与视觉 token**

实现已确认的布局 B：

- 顶部固定高度工具栏：FlowRivet、TAPD 状态、最后同步、刷新、连接菜单。
- 左侧固定/可收缩项目导航：全部待办、即将到期、已逾期、项目列表与数量。
- 主区使用四个稳定列轨道；窄窗口改为横向滚动，不压缩卡片文字。
- 卡片显示 TAPD ID、标题、类型图标、优先级、项目与到期时间。
- CSS 使用中性背景、白色表面、细边框、最多 8px 圆角、零字距、清晰焦点环；不使用渐变和嵌套卡片。
- 所有图标按钮使用 lucide 图标并带 `aria-label` 与 tooltip/title。

- [ ] **Step 5: 接入工具结果与演示调用**

`main.tsx` 初始化 bridge，订阅 `ui/notifications/tool-result`，用 `taskboardSnapshotSchema` 校验 `structuredContent` 后渲染。开发/测试模式允许通过显式 prop 注入 snapshot 和 bridge；生产模式不得静默回落到 mock，工具结果无效时显示错误状态。

连接菜单中的“测试连接”通过 `bridge.callTool("demo_ping", ...)` 调用 server，页面显示“本地 Companion 已响应”及时间。

- [ ] **Step 6: 实现前端模拟拖动**

- 只在 connected 状态启用 dnd-kit。
- 拖动后仅更新当前 UI 实例内的 stage，并显示“Demo：未写入 TAPD”。
- 不调用 `move_work_item`，避免 Phase 0 形成虚假写入能力。
- 支持键盘拖动传感器，卡片和列具有可读 aria label。

- [ ] **Step 7: 运行 UI 测试、类型检查和生产构建**

Run: `npm test --workspace @flowrivet/codex-plugin -- ui.test.tsx`

Expected: PASS。

Run: `npm run typecheck --workspace @flowrivet/codex-plugin`

Expected: PASS。

Run: `npm run build --workspace @flowrivet/codex-plugin`

Expected: PASS，并由 `vite-plugin-singlefile` 生成一个可内联的 `packages/codex-plugin/dist/ui/taskboard.html`，脚本和样式均已内联，HTML 不引用本机绝对路径或外部 CDN。

- [ ] **Step 8: 提交 React 看板**

```powershell
git add package-lock.json packages/codex-plugin/package.json packages/codex-plugin/vite.config.ts packages/codex-plugin/src/ui packages/codex-plugin/tests/ui.test.tsx
git commit -m "feat(taskboard): render interactive demo board"
```

### Task 5: 将本地 MCP 接入 FlowRivet 插件

**Files:**
- Modify: `.codex-plugin/plugin.json`
- Create: `.mcp.json`
- Create: `skills/my-tapd-taskboard/SKILL.md`
- Create: `scripts/validate-plugin.ps1`
- Create: `tests/plugin-package.test.ts`

- [ ] **Step 1: 编写失败的插件包测试**

`tests/plugin-package.test.ts` 读取真实文件并断言：

```ts
expect(plugin.name).toBe("flowrivet");
expect(plugin.mcpServers).toBe("./.mcp.json");
expect(plugin.skills).toBe("./skills/");
expect(mcp.mcpServers.flowrivet.type).toBe("http");
expect(mcp.mcpServers.flowrivet.url).toBe("http://127.0.0.1:43120/mcp");
expect(skill).toContain("open_my_taskboard");
```

另断言 manifest、MCP 配置和 Skill 不包含 Token、Secret、固定用户信息或 `[TODO:`。

- [ ] **Step 2: 运行测试并确认失败**

Run: `npm run test:legacy -- tests/plugin-package.test.ts`

Expected: FAIL，提示 `.mcp.json` 或 Skill 不存在。

- [ ] **Step 3: 配置插件 MCP 与 Skill**

`.codex-plugin/plugin.json` 增加：

```json
{
  "skills": "./skills/",
  "mcpServers": "./.mcp.json"
}
```

把 starter prompt 改为 Phase 0 能真正完成的三项：打开我的 TAPD 待办看板、检查本地 Companion、演示看板交互。

`.mcp.json` 只声明本机 HTTP server：

```json
{
  "mcpServers": {
    "flowrivet": {
      "type": "http",
      "url": "http://127.0.0.1:43120/mcp"
    }
  }
}
```

`SKILL.md` 明确：用户要求查看“我的 TAPD 待办/看板”时调用 `open_my_taskboard`；Phase 0 数据为 Demo，不声称已同步 TAPD；工具不可达时提示启动 Companion。

- [ ] **Step 4: 实现可重复的插件校验脚本**

`scripts/validate-plugin.ps1`：

1. 执行生产构建。
2. 调用 `plugin-creator/scripts/validate_plugin.py` 校验仓库根插件。
3. 检查 `/health` 和 MCP endpoint 所需端口未被错误进程占用。
4. 输出下一步安装/刷新命令，不修改用户 marketplace。

脚本通过参数接收 plugin-creator skill 根路径，不能硬编码某个缓存版本目录。

- [ ] **Step 5: 运行插件包验证**

Run: `npm run test:legacy -- tests/plugin-package.test.ts`

Expected: PASS。

Run: `powershell -ExecutionPolicy Bypass -File scripts/validate-plugin.ps1 -PluginCreatorRoot "$env:USERPROFILE\.codex\skills\.system\plugin-creator"`

Expected: manifest 校验、构建与静态检查均 PASS。

- [ ] **Step 6: 提交插件接线**

```powershell
git add .codex-plugin/plugin.json .mcp.json skills/my-tapd-taskboard/SKILL.md scripts/validate-plugin.ps1 tests/plugin-package.test.ts
git commit -m "feat(plugin): connect FlowRivet taskboard MCP"
```

### Task 6: 增加浏览器 E2E 和响应式视觉验证

**Files:**
- Modify: `packages/codex-plugin/package.json`
- Create: `packages/codex-plugin/playwright.config.ts`
- Create: `packages/codex-plugin/e2e/taskboard.spec.ts`
- Create: `packages/codex-plugin/src/ui/demo-harness.tsx`

- [ ] **Step 1: 安装并配置 Playwright**

添加 `@playwright/test`。`demo-harness.tsx` 实现一个最小 MCP Apps 模拟宿主：在 iframe 外响应 `ui/initialize`、`tools/call` 并发送 `ui/notifications/tool-result`，使 E2E 验证的是生产 `taskboard.html` 和真实 postMessage bridge，而不是绕过 bridge 直接给 React 注入数据。Playwright 配置启动静态预览服务，harness 通过显式 query 参数选择 `connected`、`disconnected`、`expired` 场景；harness 不进入插件生产资源。

- [ ] **Step 2: 编写 E2E 场景**

覆盖：

1. 1440x900 显示完整左侧导航和四列，无水平页面溢出。
2. 900x700 主区列可横向滚动，顶部操作和侧栏文字不重叠。
3. disconnected 状态只显示登录入口，不显示误导性空列。
4. 卡片从“待处理”拖到“进行中”，列计数更新并出现 Demo 提示。
5. 键盘可以聚焦卡片、连接菜单、刷新和项目筛选。
6. 页面截图非空；采样主区像素不能全部为单一背景色。

- [ ] **Step 3: 运行 E2E 并修复仅限 Phase 0 的问题**

Run: `npm run test:e2e --workspace @flowrivet/codex-plugin`

Expected: Chromium 全部 PASS，截图写入测试临时输出而非仓库。

Run: `npm run build --workspace @flowrivet/codex-plugin`

Expected: PASS。

- [ ] **Step 4: 提交 E2E**

```powershell
git add package-lock.json packages/codex-plugin/package.json packages/codex-plugin/playwright.config.ts packages/codex-plugin/src/ui/demo-harness.tsx packages/codex-plugin/e2e/taskboard.spec.ts
git commit -m "test(taskboard): cover demo board workflows"
```

### Task 7: 完成私有插件安装与 Windows Codex 验收

**Files:**
- Create: `docs/operations/codex-plugin-demo.md`
- Modify: `README.md`

- [ ] **Step 1: 编写运行手册**

`codex-plugin-demo.md` 记录：

- 前置条件：Node 22、Windows Codex、插件能力可用。
- `npm install`、构建、启动 Companion 的准确命令。
- `GET http://127.0.0.1:43120/health` 的预期输出。
- 使用 plugin-creator 创建/更新个人 marketplace 的命令；禁止手改 marketplace。
- 插件 cachebuster、重新安装、启用和新建 Codex 任务的步骤。
- “打开我的 TAPD 待办看板”的验收提示词。
- 常见失败：端口占用、MCP 不可达、UI bundle 缺失、旧插件缓存。
- 明确标注所有卡片均为 Demo 数据，尚未读取或写入 TAPD。

注意：当前 `~/.agents/plugins/marketplace.json` 含占位元数据，实施时必须先用 plugin-creator 工具修复或创建一个合法的独立本地 marketplace，不能在计划中假定它可直接复用。

- [ ] **Step 2: 更新 README 的 Phase 0 入口**

README 只增加简短的“Codex 看板 Demo”入口，链接运行手册和设计规格，不复制整套命令。

- [ ] **Step 3: 执行完整自动化验证**

Run: `npm test`

Expected: 所有 legacy、workspace、MCP、UI 测试 PASS。

Run: `npm run typecheck`

Expected: PASS。

Run: `npm run build`

Expected: PASS。

Run: `npm run test:e2e --workspace @flowrivet/codex-plugin`

Expected: PASS。

- [ ] **Step 4: 启动本地 Companion 并验证协议**

Run: `npm start --workspace @flowrivet/codex-plugin`

Expected: 输出 `http://127.0.0.1:43120/mcp`，进程保持运行。

Run: `Invoke-RestMethod http://127.0.0.1:43120/health`

Expected: `status` 为 `ok`。

使用 MCP Inspector 调用 `demo_ping` 和 `open_my_taskboard`，确认 tools/list、resources/read 和结构化结果正确。

- [ ] **Step 5: 安装并在 Windows Codex 中验收**

按 plugin-creator 的 marketplace/update 流程执行，不直接编辑用户配置：

1. 验证或创建合法的本地 marketplace entry。
2. 安装 `flowrivet` 并启用插件。
3. 新建 Codex 任务，输入“打开我的 TAPD 待办看板”。
4. 验证 `open_my_taskboard` 被调用并显示非空 UI。
5. 验证项目筛选、连接菜单、`demo_ping`、鼠标拖动和键盘操作。
6. 截取 Codex 宿主中的桌面和窄窗口截图，检查空白、裁剪、重叠和控制台错误。

若 Codex 当前版本能发现工具但不能渲染 MCP Apps UI，Phase 0 判定不通过：记录客户端版本、工具结果、resource MIME、控制台/日志和同一 MCP 在 MCP Inspector 或 ChatGPT 中的对照结果，再决定等待 Codex 支持或调整承载面；不得把独立浏览器页面冒充 Codex 插件页面。

- [ ] **Step 6: 提交运行手册**

```powershell
git add README.md docs/operations/codex-plugin-demo.md
git commit -m "docs(plugin): document Codex demo validation"
```

- [ ] **Step 7: 最终检查**

Run: `git status --short`

Expected: 无输出。

记录最终验证命令、Codex 客户端版本、插件版本、截图路径及未通过项。只有 Windows Codex 内真实 UI 渲染与 bridge 调用成功，Phase 0 才满足规格准出标准并允许开始 Phase 1。
