# 本机仓库目录选择器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 FlowRivet 仓库关联对话框中提供跨平台系统原生文件夹选择，并把用户选择的绝对路径安全地填入已有仓库或克隆父目录输入框。

**Architecture:** 新增与 UI、GitLab 解耦的 `DirectoryPicker` 端口和 `NativeDirectoryPicker` 平台适配器，复用现有 `BoundedCommandRunner` 的 AbortSignal、超时、输出限制和进程树终止能力。Companion 通过单一只读 MCP 工具暴露选择结果；React 仅在用户点击文件夹按钮时调用工具，并继续使用现有 Repository Workflow 做仓库和路径安全校验。

**Tech Stack:** TypeScript 5.9、Node.js 22、Zod 4、React 19、MCP Apps SDK 1.7.5、PowerShell/Windows Forms、macOS `osascript`、Linux `zenity`/`kdialog`、Vitest、Testing Library、Playwright

**Source Spec:** `docs/superpowers/specs/2026-08-12-feishu-codex-gitlab-workflow-design.md` 第 9.4、11、12、14 节

---

## 文件边界

新增：

- `packages/codex-plugin/src/local-directory/directory-picker.ts`：平台中立端口、结果和稳定错误。
- `packages/codex-plugin/src/local-directory/native-directory-picker.ts`：Windows/macOS/Linux 固定命令适配、单会话锁、取消和绝对路径校验。
- `packages/codex-plugin/src/contracts/directory-picker.ts`：MCP 输入输出 Schema。
- `packages/codex-plugin/src/server/tools/directory-picker-tools.ts`：只读 MCP 工具注册和脱敏日志。
- `packages/codex-plugin/tests/native-directory-picker.test.ts`：三平台命令及状态合同。
- `packages/codex-plugin/tests/directory-picker-tools.test.ts`：工具 Schema、AbortSignal、错误和日志合同。

修改：

- `packages/codex-plugin/src/server/runtime-services.ts`：默认注入本机目录选择器。
- `packages/codex-plugin/src/server/app.ts`：注册目录选择工具。
- `packages/codex-plugin/src/ui/components/RepositoryDialog.tsx`：文件夹按钮、pending/error、取消保值。
- `packages/codex-plugin/src/ui/App.tsx`：调用 `select_local_directory` 并解析结构化结果。
- `packages/codex-plugin/src/ui/styles.css`：输入框与图标按钮稳定布局。
- `packages/codex-plugin/src/ui/demo-harness.tsx`：合成选择成功、取消和失败场景。
- `packages/codex-plugin/tests/ui.test.tsx`、`packages/codex-plugin/tests/server.test.ts`：集成覆盖。
- `packages/codex-plugin/e2e/taskboard.spec.ts`：桌面与移动交互。
- `docs/user-guide.md`、`docs/operations/codex-plugin-demo.md`：普通用户操作与真实验收。

---

### Task 1: 实现平台中立合同和原生 Adapter

**Files:**

- Create: `packages/codex-plugin/src/local-directory/directory-picker.ts`
- Create: `packages/codex-plugin/src/local-directory/native-directory-picker.ts`
- Create: `packages/codex-plugin/tests/native-directory-picker.test.ts`
- Reuse: `packages/codex-plugin/src/process/bounded-command-runner.ts`

- [ ] **Step 1: 写失败的三平台命令合同测试**

测试注入假 Runner、平台、环境和可执行文件发现函数，覆盖：

```ts
await picker.selectDirectory({
  purpose: "existing_repository",
  signal: new AbortController().signal,
});
```

断言 Windows 使用固定 `powershell.exe`、`-NoProfile -STA -NonInteractive -EncodedCommand`，脚本只显示 FolderBrowserDialog：选择成功时只把所选路径写到 stdout 并退出 `0`，用户取消时不写 stdout 并显式退出 `1`；macOS 使用固定 `osascript -e <constant>`；Linux 优先 `zenity --file-selection --directory`，缺失后使用 `kdialog --getexistingdirectory`。不允许把 purpose 或路径拼入脚本。

增加成功、用户取消、缺少选择器、非绝对路径、空输出、命令失败、超时、AbortSignal、输出超限和同步第二请求 `directory_picker_busy`。断言错误对象只有稳定 code，不包含 stdout、stderr 或路径。

- [ ] **Step 2: 运行测试验证 RED**

```powershell
npm test --workspace @flowrivet/codex-plugin -- native-directory-picker.test.ts
```

Expected: FAIL，因为目录选择端口和 Adapter 尚不存在。

- [ ] **Step 3: 实现最小端口和 Adapter**

端口固定为：

```ts
export type DirectoryPurpose = "existing_repository" | "clone_parent";
export type DirectorySelection =
  | { outcome: "selected"; absolutePath: string }
  | { outcome: "cancelled" };

export interface DirectoryPicker {
  selectDirectory(input: {
    purpose: DirectoryPurpose;
    signal: AbortSignal;
  }): Promise<DirectorySelection>;
}
```

`NativeDirectoryPicker` 使用实例内 active 标志实现单会话锁，并在 `finally` 清除。所有平台都通过 `BoundedCommandRunner.run`，超时设为 10 分钟，stdout 上限沿用 Runner。Adapter 为已验证的系统选择器设置 `allowExitCodes: [0, 1]`；只有退出码 `1` 且 stdout 为空才映射为用户取消，退出码与输出组合不符合合同时返回 `directory_picker_failed`。成功结果 `trim()` 后必须用当前平台的 `win32.isAbsolute` 或 `posix.isAbsolute` 校验。命令启动/超时/MCP 取消/输出限制映射为规定的稳定错误，不记录路径。

在写 Adapter 前先对当前 Windows 环境执行一次不保存路径的只读探针：确认 `powershell.exe -STA` 能从后台 Companion 同一用户会话显示窗口，点击取消得到退出码 `1`，选择测试目录得到退出码 `0`。macOS/Linux 取消码来自自动化假 Runner 合同，并在具备对应桌面环境时补真实探针；未验证的退出码不得当作取消处理。

- [ ] **Step 4: 运行 GREEN、类型检查和敏感输出检查**

```powershell
npm test --workspace @flowrivet/codex-plugin -- native-directory-picker.test.ts bounded-command-runner.test.ts
npm run typecheck --workspace @flowrivet/codex-plugin
rg -n "console\.|stderr|absolutePath" packages/codex-plugin/src/local-directory
```

Expected: 测试与类型检查通过；除返回合同和局部变量外没有路径日志。

- [ ] **Step 5: Commit and push**

```text
feat(companion): add native directory picker adapters
```

---

### Task 2: 注册 MCP 工具并注入默认运行时

**Files:**

- Create: `packages/codex-plugin/src/contracts/directory-picker.ts`
- Create: `packages/codex-plugin/src/server/tools/directory-picker-tools.ts`
- Create: `packages/codex-plugin/tests/directory-picker-tools.test.ts`
- Modify: `packages/codex-plugin/src/server/runtime-services.ts`
- Modify: `packages/codex-plugin/src/server/app.ts`
- Modify: `packages/codex-plugin/tests/server.test.ts`

- [ ] **Step 1: 写失败的 MCP 合同测试**

Schema：

```ts
export const directorySelectionInputSchema = z.object({
  purpose: z.enum(["existing_repository", "clone_parent"]),
}).strict();

export const directorySelectionSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("selected"), absolutePath: z.string().min(1) }).strict(),
  z.object({ outcome: z.literal("cancelled") }).strict(),
]);
```

断言工具名 `select_local_directory`，`readOnlyHint: true`、`openWorldHint: false`；callback 将 MCP request extra 的 `signal` 原样传给 Picker。成功、取消返回 schema-validated structuredContent；稳定错误只进入 MCP error code。日志只包含 requestId、purpose、platform、outcome、durationMs、errorCode，不出现 absolutePath。

- [ ] **Step 2: 运行测试验证 RED**

```powershell
npm test --workspace @flowrivet/codex-plugin -- directory-picker-tools.test.ts server.test.ts
```

Expected: FAIL，因为工具和运行时服务尚未注册。

- [ ] **Step 3: 实现工具与运行时注入**

为 `RuntimeServices` 增加可选 `directoryPicker`，默认运行时创建 `NativeDirectoryPicker`。`createTaskboardMcpServer` 仅在服务存在时注册工具，保持现有测试的精简注入兼容。工具 callback 使用 `async ({ purpose }, extra)` 并传递 `extra.signal`。

日志器放在工具模块附近，只接收脱敏事件对象；严禁把完整结果或异常对象传给 `console.error`。

- [ ] **Step 4: 验证 GREEN 与服务回归**

```powershell
npm test --workspace @flowrivet/codex-plugin -- directory-picker-tools.test.ts server.test.ts contracts.test.ts
npm run typecheck --workspace @flowrivet/codex-plugin
```

- [ ] **Step 5: Commit and push**

```text
feat(plugin): expose local directory selection tool
```

---

### Task 3: 在仓库对话框接入文件夹选择

**Files:**

- Modify: `packages/codex-plugin/src/ui/components/RepositoryDialog.tsx`
- Modify: `packages/codex-plugin/src/ui/App.tsx`
- Modify: `packages/codex-plugin/src/ui/styles.css`
- Modify: `packages/codex-plugin/tests/ui.test.tsx`

- [ ] **Step 1: 写失败 UI 测试**

覆盖：

1. 两种模式都显示文件夹图标按钮，accessible name 分别为“选择本地仓库文件夹”和“选择克隆父文件夹”。
2. existing 调用 `{ purpose: "existing_repository" }`；clone 调用 `{ purpose: "clone_parent" }`。
3. selected 填入输入框但不自动提交；cancelled 保留原值；错误显示稳定中文恢复文案并保留手动输入。
4. pending 时按钮显示忙碌状态并禁用重复点击；切换模式或关闭 dialog 后晚到响应不能覆盖新状态。
5. 键盘可聚焦按钮，图标有 tooltip；390x844 与 1440x900 输入和按钮不重叠。

- [ ] **Step 2: 运行测试验证 RED**

```powershell
npm test --workspace @flowrivet/codex-plugin -- ui.test.tsx
```

- [ ] **Step 3: 实现 UI 最小改动**

`RepositoryDialog` 新增：

```ts
onSelectDirectory: (
  purpose: "existing_repository" | "clone_parent",
) => Promise<{ outcome: "selected"; absolutePath: string } | { outcome: "cancelled" }>;
```

在组件内维护 `selectingDirectory`、`directoryError` 和请求序号。文件夹按钮使用 Lucide `FolderOpen` 图标；路径输入与按钮放入固定 grid，不改变 dialog 宽度。App 调用 `bridge.callTool("select_local_directory", { purpose })`，用共享 Schema 解析 structuredContent；MCP error 映射为简短中文文案，不显示内部命令。

- [ ] **Step 4: 验证 GREEN、类型和构建**

```powershell
npm test --workspace @flowrivet/codex-plugin -- ui.test.tsx bridge.test.ts
npm run typecheck --workspace @flowrivet/codex-plugin
npm run build --workspace @flowrivet/codex-plugin
```

- [ ] **Step 5: Commit and push**

```text
feat(ui): select repository directories natively
```

---

### Task 4: Demo、E2E、文档和 Windows 真实验收

**Files:**

- Modify: `packages/codex-plugin/src/ui/demo-harness.tsx`
- Modify: `packages/codex-plugin/e2e/taskboard.spec.ts`
- Modify: `docs/user-guide.md`
- Modify: `docs/operations/codex-plugin-demo.md`

- [ ] **Step 1: 扩展 Demo Harness 和 Playwright**

Harness 只返回合成路径 `C:\\workspace\\example`，支持 selected/cancelled/unavailable 三种场景。Playwright 验证文件夹按钮、模式对应 purpose、选择后填值但不提交、取消保值、错误时可手填，以及桌面/移动无外层溢出。

- [ ] **Step 2: 运行浏览器验证**

```powershell
npm run test:e2e --workspace @flowrivet/codex-plugin
```

Expected: 全部通过，新增用例在桌面与移动视口通过。

- [ ] **Step 3: 更新普通用户和运维文档**

说明两种目录含义、文件夹按钮、手动输入降级、路径校验错误；运维手册增加 Windows 原生选择、取消、无路径日志和 macOS/Linux 合同验收。文档不得出现真实本机路径。

- [ ] **Step 4: 执行完整验证**

```powershell
npm test
npm run typecheck --workspace @flowrivet/codex-plugin
npm run build --workspace @flowrivet/codex-plugin
npm run test:e2e --workspace @flowrivet/codex-plugin
git diff --check
```

- [ ] **Step 5: 提交并安装本机插件**

```text
docs(workflow): document native repository selection
```

```powershell
npm run plugin:update -- --adopt-legacy-companion --json
```

- [ ] **Step 6: Windows 真实验收**

重载新插件后：

1. 打开一条研发任务并进入仓库对话框。
2. “复用本地仓库”选择一个测试 Git 仓库，确认路径填入且关联校验通过。
3. “克隆到父目录”选择测试父目录，确认目标仓库按现有工作流准备。
4. 系统对话框取消后原输入不变。
5. 保持选择器打开时关闭 App，确认选择器/子进程被清理。
6. 检查 `companion.log` 只有 purpose/outcome/requestId，不含所选路径。

---

## Definition of Done

- 用户可通过文件夹图标选择已有仓库或克隆父目录，不必手输绝对路径。
- 目录选择只能由明确点击触发，取消和失败不破坏当前表单。
- 选择器结果不绕过 Repository Workflow 的 absolute path、Git remote 和克隆目标校验。
- Windows 原生对话框通过真实验收；macOS/Linux 固定命令、取消和错误合同通过自动化测试。
- MCP 取消能终止选择器进程；同一时刻只存在一个选择会话。
- 日志、测试 Fixture、文档和错误不包含真实本机路径或目录内容。
- 全仓测试、类型检查、生产构建和 Playwright 通过。
- 每个 Task 独立提交并推送 `codex/feishu-project-provider`，最终工作区干净。
