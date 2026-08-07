# FlowRivet 固定任务与全屏看板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户从固定在 Codex 左侧栏的专用任务重复打开 FlowRivet 看板，并让看板自动请求全屏、失败时可手动重试。

**Architecture:** 固定任务使用 Codex 原生任务能力，只承担稳定入口，不依赖插件自定义导航。MCP Apps bridge 封装宿主全屏能力检测和 `ui/request-display-mode` 请求；React 看板初始化后自动请求一次，并在非全屏或失败状态显示手动按钮。

**Tech Stack:** TypeScript、React 19、MCP Apps SDK、Vitest、Testing Library、Playwright、Codex desktop task API

---

### Task 1: MCP Apps 全屏桥接

**Files:**
- Modify: `packages/codex-plugin/src/ui/bridge.ts`
- Test: `packages/codex-plugin/tests/bridge.test.ts`

- [ ] **Step 1: 写失败的 bridge 合约测试**

覆盖宿主声明 `fullscreen` 时发送 `ui/request-display-mode`，宿主未声明时不发送请求并返回 `unsupported`，以及宿主拒绝请求时向调用方传播错误。

- [ ] **Step 2: 运行测试并确认按预期失败**

Run: `npm test --workspace @flowrivet/codex-plugin -- bridge.test.ts`

Expected: FAIL，因为 `McpAppsBridge` 尚无 `getDisplayState` 和 `requestFullscreen`。

- [ ] **Step 3: 实现最小 bridge API**

在初始化结果的 host context 上判断 `availableDisplayModes` 和当前 `displayMode`，新增：

```ts
type DisplayState = {
  canFullscreen: boolean;
  isFullscreen: boolean;
};

getDisplayState(): DisplayState;
requestFullscreen(): Promise<DisplayState>;
```

`requestFullscreen` 仅在宿主支持时调用 SDK `app.requestDisplayMode({ mode: "fullscreen" })`，并根据返回 mode 更新状态。

- [ ] **Step 4: 运行 bridge 测试并确认通过**

Run: `npm test --workspace @flowrivet/codex-plugin -- bridge.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交 bridge 变更**

```bash
git add packages/codex-plugin/src/ui/bridge.ts packages/codex-plugin/tests/bridge.test.ts
git commit -m "feat(plugin): add fullscreen display bridge"
```

### Task 2: 自动全屏与手动兜底按钮

**Files:**
- Modify: `packages/codex-plugin/src/ui/App.tsx`
- Modify: `packages/codex-plugin/src/ui/components/AppHeader.tsx`
- Modify: `packages/codex-plugin/src/ui/styles.css`
- Test: `packages/codex-plugin/tests/ui.test.tsx`

- [ ] **Step 1: 写失败的 UI 行为测试**

覆盖首次渲染自动请求全屏、失败后显示非阻塞提示、点击“全屏打开”可重试，以及宿主不支持时不展示不可用按钮。

- [ ] **Step 2: 运行测试并确认按预期失败**

Run: `npm test --workspace @flowrivet/codex-plugin -- ui.test.tsx`

Expected: FAIL，因为页面尚未调用全屏 bridge，也没有全屏按钮。

- [ ] **Step 3: 实现最小 UI**

`App` 在挂载时自动调用一次 `requestFullscreen`；仅当 `canFullscreen && !isFullscreen` 时给 `AppHeader` 传入全屏命令。请求失败保留内嵌看板并显示 toast。`AppHeader` 使用 Lucide `Maximize2` 图标按钮和明确 tooltip。

- [ ] **Step 4: 运行 UI 测试和插件全量测试**

Run: `npm test --workspace @flowrivet/codex-plugin`

Expected: PASS。

- [ ] **Step 5: 提交 UI 变更**

```bash
git add packages/codex-plugin/src/ui/App.tsx packages/codex-plugin/src/ui/components/AppHeader.tsx packages/codex-plugin/src/ui/styles.css packages/codex-plugin/tests/ui.test.tsx
git commit -m "feat(taskboard): request fullscreen with fallback"
```

### Task 3: 构建、浏览器验收与固定任务

**Files:**
- Modify if needed: `packages/codex-plugin/e2e/taskboard.spec.ts`
- Modify: `docs/operations/codex-plugin-demo.md`

- [ ] **Step 1: 补充 E2E 或操作文档断言**

验证看板在不支持 MCP host 全屏的 harness 中保持可用，并记录“FlowRivet 待办看板”固定任务的用途和重新打开方式。

- [ ] **Step 2: 运行类型检查、构建和 E2E**

Run: `npm run typecheck --workspace @flowrivet/codex-plugin`

Run: `npm run build --workspace @flowrivet/codex-plugin`

Run: `npm run test:e2e --workspace @flowrivet/codex-plugin`

Expected: 全部 PASS，桌面和窄窗口无重叠、空白或不可达按钮。

- [ ] **Step 3: 在 Codex 创建专用任务**

创建任务名“FlowRivet 待办看板”，启动提示为“打开我的 TAPD 待办看板”，工作目录为 `F:\codes\workspace\FlowRivet`。将其固定到左侧栏；若客户端 API 不开放程序化固定，则创建任务后明确提示用户点击固定图标完成最后一步。

- [ ] **Step 4: 提交验收和文档变更**

```bash
git add packages/codex-plugin/e2e/taskboard.spec.ts docs/operations/codex-plugin-demo.md
git commit -m "docs(taskboard): document pinned fullscreen workflow"
```

