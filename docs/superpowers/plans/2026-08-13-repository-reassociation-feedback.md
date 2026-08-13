# 仓库重新关联与交互反馈 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 FlowRivet 在创建研发分支前可安全修改仓库关联，使系统目录选择器从当前路径开始，并为目录选择、关联成功、失败和锁定提供清晰反馈。

**Architecture:** 扩展现有平台中立 `DirectoryPicker` 合同，用可选路径提示驱动各平台原生初始目录，同时保持路径不进入日志或脚本文本。扩展 GitLab CLI Adapter 的项目精确读取能力，用已保存 projectId 恢复分页外项目；执行服务继续作为仓库替换的最终门禁。React 组件只根据执行记录派生可修改/锁定状态，并通过既有 MCP 工具完成选择和关联。

**Tech Stack:** TypeScript 5.9、Node.js 22、Zod 4、React 19、MCP Apps SDK 1.7.5、PowerShell/Windows Forms、macOS AppleScript、Linux zenity/kdialog、git/glab CLI、Vitest、Testing Library、Playwright

**Source Spec:** `docs/superpowers/specs/2026-08-12-feishu-codex-gitlab-workflow-design.md` 第 9.4、9.5、11、14 节

---

## 文件边界

修改：

- `packages/codex-plugin/src/local-directory/directory-picker.ts`：增加可选初始目录提示。
- `packages/codex-plugin/src/contracts/directory-picker.ts`：扩展 MCP 输入 Schema。
- `packages/codex-plugin/src/local-directory/native-directory-picker.ts`：验证路径提示并映射三平台原生初始位置。
- `packages/codex-plugin/src/server/tools/directory-picker-tools.ts`：透传提示但保持脱敏日志。
- `packages/codex-plugin/src/gitlab/gitlab-adapter.ts`：增加按 projectId 读取项目的端口。
- `packages/codex-plugin/src/gitlab/glab-cli-client.ts`：用固定 `glab api` 参数精确读取当前项目。
- `packages/codex-plugin/src/gitlab/gitlab-service.ts`、`packages/codex-plugin/src/server/tools/gitlab-tools.ts`：暴露项目精确读取工具。
- `packages/codex-plugin/src/executions/execution-service.ts`：锁定后同时保护项目和本地路径，并保留幂等重试。
- `packages/codex-plugin/src/ui/use-work-execution.ts`：恢复当前项目、维护关联反馈和重新打开状态。
- `packages/codex-plugin/src/ui/components/RepositoryDialog.tsx`：初始化项目/路径、目录反馈和稳定提交状态。
- `packages/codex-plugin/src/ui/components/ExecutionSummary.tsx`：显示修改入口、成功状态和锁定原因。
- `packages/codex-plugin/src/ui/components/WorkItemDetailDrawer.tsx`、`packages/codex-plugin/src/ui/App.tsx`：串联重新关联和提示目录。
- `packages/codex-plugin/src/ui/styles.css`：工程控制台式状态、按钮和 reduced-motion 样式。
- `packages/codex-plugin/src/ui/demo-harness.tsx`：覆盖已关联、修改、选择中和锁定场景。
- `packages/codex-plugin/e2e/taskboard.spec.ts`：桌面/窄屏交互与布局验收。
- `docs/user-guide.md`、`docs/operations/codex-plugin-demo.md`：补充修改关联和反馈说明。

测试：

- `packages/codex-plugin/tests/native-directory-picker.test.ts`
- `packages/codex-plugin/tests/directory-picker-tools.test.ts`
- `packages/codex-plugin/tests/glab-cli-client.test.ts`
- `packages/codex-plugin/tests/gitlab-service.test.ts`
- `packages/codex-plugin/tests/server.test.ts`
- `packages/codex-plugin/tests/execution-service.test.ts`
- `packages/codex-plugin/tests/ui.test.tsx`

不新增全局最近目录存储，不引入 Remotion 或其他动画运行时，不改变 GitLab 登录与 Token 管理。

---

### Task 1: 初始目录合同与跨平台 Adapter

**Files:**

- Modify: `packages/codex-plugin/src/local-directory/directory-picker.ts`
- Modify: `packages/codex-plugin/src/contracts/directory-picker.ts`
- Modify: `packages/codex-plugin/src/local-directory/native-directory-picker.ts`
- Modify: `packages/codex-plugin/src/server/tools/directory-picker-tools.ts`
- Test: `packages/codex-plugin/tests/native-directory-picker.test.ts`
- Test: `packages/codex-plugin/tests/directory-picker-tools.test.ts`

- [ ] **Step 1: 写失败的共享合同和 MCP 工具测试**

将期望 API 固定为：

```ts
export interface DirectoryPicker {
  selectDirectory(input: {
    purpose: DirectoryPurpose;
    initialDirectory?: string;
    signal: AbortSignal;
  }): Promise<DirectorySelection>;
}

export const directorySelectionInputSchema = z.object({
  purpose: directoryPurposeSchema,
  initialDirectory: z.string().min(1).optional(),
}).strict();
```

在工具测试中调用 `{ purpose: "existing_repository", initialDirectory: "C:\\work\\flowrivet" }`，断言 Picker 收到相同提示；日志事件和序列化日志均不包含该路径。保留不传字段的向后兼容测试。

- [ ] **Step 2: 写失败的三平台初始位置测试**

向 `NativeDirectoryPicker` 注入 `directoryExists`，覆盖：

- Windows 有效提示通过 stdin 传给固定 PowerShell 脚本，脚本使用 `FolderBrowserDialog.SelectedPath`，owner 为当前前台窗口，`windowsHide: true`；脚本不包含实际路径，不使用 `BrowseForFolder` root 参数。
- macOS 通过 AppleScript argv/default location 使用提示，不把路径插入 script token。
- zenity 使用独立 `--filename=<absolute-directory-with-separator>` token；kdialog 使用独立起始目录 token。
- 相对路径、不存在目录和 `directoryExists` 异常均忽略提示并打开默认位置，而不是返回错误。
- 选择结果仍必须是绝对路径；日志与错误不出现提示或结果路径。

- [ ] **Step 3: 运行 RED**

```powershell
npm test --workspace @flowrivet/codex-plugin -- --run tests/native-directory-picker.test.ts tests/directory-picker-tools.test.ts
```

Expected: FAIL，现有合同没有 `initialDirectory`，Windows 仍使用 `Shell.Application.BrowseForFolder`。

- [ ] **Step 4: 实现最小合同和 Adapter**

`NativeDirectoryPicker` 在调用命令前使用当前平台的 `isAbsolute` 与注入的 `directoryExists` 解析提示。Windows 通过 Runner stdin 把有效路径传给固定脚本，避免出现在命令行或环境变量；macOS/Linux 通过独立 argv token 传递，始终禁止 shell 和字符串拼接。

Windows 固定脚本从 `[Console]::In.ReadToEnd()` 读取初始路径，使用 `System.Windows.Forms.FolderBrowserDialog` 设置 `SelectedPath`；通过固定 C# `IWin32Window` wrapper 包装 `GetForegroundWindow()` 返回的句柄并传给 `ShowDialog(owner)`。只有用户确认时输出 `SelectedPath`；取消退出 `1`。先用不记录路径的真实探针确认隐藏 PowerShell 时对话框可见且 owner 正确，再锁定脚本合同。

- [ ] **Step 5: 运行 GREEN、类型检查与路径泄漏检查**

```powershell
npm test --workspace @flowrivet/codex-plugin -- --run tests/native-directory-picker.test.ts tests/directory-picker-tools.test.ts tests/bounded-command-runner.test.ts
npm run typecheck --workspace @flowrivet/codex-plugin
rg -n "initialDirectory|absolutePath|stdin" packages/codex-plugin/src/local-directory packages/codex-plugin/src/server/tools/directory-picker-tools.ts
```

Expected: 测试和类型检查通过；路径只存在于局部合同和运行环境，不进入日志调用。

- [ ] **Step 6: 提交并推送**

```powershell
git add packages/codex-plugin/src/local-directory/directory-picker.ts packages/codex-plugin/src/contracts/directory-picker.ts packages/codex-plugin/src/local-directory/native-directory-picker.ts packages/codex-plugin/src/server/tools/directory-picker-tools.ts packages/codex-plugin/tests/native-directory-picker.test.ts packages/codex-plugin/tests/directory-picker-tools.test.ts
git commit -m "feat(companion): reopen directory picker at current path"
git push internal codex/feishu-project-provider
```

---

### Task 2: 精确恢复项目与仓库锁定语义

**Files:**

- Modify: `packages/codex-plugin/src/gitlab/gitlab-adapter.ts`
- Modify: `packages/codex-plugin/src/gitlab/glab-cli-client.ts`
- Modify: `packages/codex-plugin/src/gitlab/contracts.ts`
- Modify: `packages/codex-plugin/src/gitlab/gitlab-service.ts`
- Modify: `packages/codex-plugin/src/server/tools/gitlab-tools.ts`
- Modify: `packages/codex-plugin/src/executions/execution-service.ts`
- Test: `packages/codex-plugin/tests/glab-cli-client.test.ts`
- Test: `packages/codex-plugin/tests/gitlab-service.test.ts`
- Test: `packages/codex-plugin/tests/server.test.ts`
- Test: `packages/codex-plugin/tests/execution-service.test.ts`

- [ ] **Step 1: 写失败的项目精确读取合同测试**

给 `GitLabAdapter` 增加：

```ts
getProject(projectId: string): Promise<GitLabProject>;
```

期望 `GlabCliClient` 使用固定 token：

```ts
["api", "projects/123", "--hostname", host, "--method", "GET"]
```

projectId 只允许十进制数字，避免把存储内容扩展成任意 API 路径。响应继续通过共享项目 Schema 且 URL 必须无凭据 HTTPS。现有 `BoundedCommandRunner` 不暴露 stderr，因此不根据 CLI 错误文本区分 404；任何精确读取失败都映射为稳定 `gitlab_unavailable`，UI 保留当前只读关联并要求重新选择。`GlabCliClient.run` 不得再把所有 `api` 命令失败都映射为未登录：只有 `getConnection` 的用户探针可在调用点映射为 `gitlab_not_connected`，项目读取失败不能改变连接身份状态。

- [ ] **Step 2: 写失败的锁定语义测试**

在 `execution-service.test.ts` 覆盖：

```ts
await service.bindRepository(id, repository("cc/one", { branch: "codex/item" }));
await expect(service.bindRepository(id, sameRepository)).resolves.toEqual(current);
await expect(service.bindRepository(id, { ...sameRepository, localPath: "C:\\other" }))
  .rejects.toMatchObject({ code: "execution_repository_locked" });
await expect(service.bindRepository(id, repository("cc/two")))
  .rejects.toMatchObject({ code: "execution_repository_locked" });
```

同时覆盖只有 MR、没有 branch 的旧记录。

- [ ] **Step 3: 运行 RED**

```powershell
npm test --workspace @flowrivet/codex-plugin -- --run tests/glab-cli-client.test.ts tests/gitlab-service.test.ts tests/server.test.ts tests/execution-service.test.ts
```

- [ ] **Step 4: 实现最小 Adapter、工具与门禁**

注册只读 `get_gitlab_project` 工具，输入为 `projectId`。服务层不缓存、不持久化新项目数据。读取失败只返回稳定错误，不泄露 CLI stderr。`bindRepository` 在存在 branch 或 mergeRequestIid 时比较 `projectId`、`projectPath`、`localPath` 三元组：完全相同直接返回当前记录，任一变化拒绝；活动前继续允许覆盖。

- [ ] **Step 5: 运行 GREEN 与完整合同回归**

```powershell
npm test --workspace @flowrivet/codex-plugin -- --run tests/glab-cli-client.test.ts tests/gitlab-service.test.ts tests/server.test.ts tests/execution-service.test.ts
npm run typecheck --workspace @flowrivet/codex-plugin
```

- [ ] **Step 6: 提交并推送**

```powershell
git add packages/codex-plugin/src/gitlab/gitlab-adapter.ts packages/codex-plugin/src/gitlab/glab-cli-client.ts packages/codex-plugin/src/gitlab/contracts.ts packages/codex-plugin/src/gitlab/gitlab-service.ts packages/codex-plugin/src/server/tools/gitlab-tools.ts packages/codex-plugin/src/executions/execution-service.ts packages/codex-plugin/tests/glab-cli-client.test.ts packages/codex-plugin/tests/gitlab-service.test.ts packages/codex-plugin/tests/server.test.ts packages/codex-plugin/tests/execution-service.test.ts
git commit -m "fix(workflow): protect active repository associations"
git push internal codex/feishu-project-provider
```

---

### Task 3: 重新关联 UI 与明确反馈

**Files:**

- Modify: `packages/codex-plugin/src/ui/use-work-execution.ts`
- Modify: `packages/codex-plugin/src/ui/components/RepositoryDialog.tsx`
- Modify: `packages/codex-plugin/src/ui/components/ExecutionSummary.tsx`
- Modify: `packages/codex-plugin/src/ui/components/WorkItemDetailDrawer.tsx`
- Modify: `packages/codex-plugin/src/ui/App.tsx`
- Modify: `packages/codex-plugin/src/ui/styles.css`
- Test: `packages/codex-plugin/tests/ui.test.tsx`

- [ ] **Step 1: 写失败的重新打开与分页外恢复测试**

从带 `gitlab` 且无 branch/MR 的执行记录打开详情，断言：

- 执行摘要显示“仓库已关联”和“修改仓库关联”。
- 点击后先加载首页；当前 projectId 不在首页时调用 `get_gitlab_project`，将精确项目置顶并预选。
- 对话框以当前 `localPath` 初始化“复用本地仓库”，确认前不丢失输入。
- 精确查找失败时显示“当前关联项目无法读取，请重新选择”，保留当前关联只读信息，不伪造 option。

- [ ] **Step 2: 写失败的目录与提交反馈测试**

断言第二次点击目录按钮调用：

```ts
bridge.callTool("select_local_directory", {
  purpose: "existing_repository",
  initialDirectory: "C:\\work\\flowrivet",
});
```

pending 时按钮 accessible name 为“等待系统选择”，`aria-busy=true` 且重复点击无第二次调用；selected 后用 `role=status` 显示“目录已选择”。提交时主按钮显示“正在关联...”，所有会改变项目/模式/路径的控件禁用；失败后恢复控件并保留值；成功后关闭弹窗，摘要显示成功状态。

- [ ] **Step 3: 写失败的锁定与可访问性测试**

带 branch 或 MR 的记录显示不可用“仓库关联已锁定”和原因说明，不暴露可点击修改入口。用键盘 Tab 验证未锁定修改按钮与目录按钮可达；状态不只依赖颜色。测试 `prefers-reduced-motion` 对应 class/样式合同。

- [ ] **Step 4: 运行 RED**

```powershell
npm test --workspace @flowrivet/codex-plugin -- --run tests/ui.test.tsx
```

- [ ] **Step 5: 实现状态与视觉**

`RepositoryDialog` 接收 `initialRepository?: ExecutionRepository` 与解析后的 `initialProject?: GitLabProject`，只在 dialog mount 时初始化，避免异步项目列表覆盖用户正在编辑的表单。目录反馈使用组件内请求序号和短暂状态；定时器在卸载时清理。

`ExecutionSummary` 根据 `Boolean(gitlab?.branch || gitlab?.mergeRequestIid)` 派生锁定状态。视觉保持现有 `--surface`、`--border`、`--accent` 变量，用 Lucide `GitBranch`、`FolderOpen`、`LoaderCircle`、`Check`、`LockKeyhole`；按钮和状态区域设置稳定最小尺寸，过渡限制在 background/border/transform 160–220ms，并在 `prefers-reduced-motion` 下关闭。

- [ ] **Step 6: 运行 GREEN、类型与生产构建**

```powershell
npm test --workspace @flowrivet/codex-plugin -- --run tests/ui.test.tsx tests/bridge.test.ts
npm run typecheck --workspace @flowrivet/codex-plugin
npm run build --workspace @flowrivet/codex-plugin
```

- [ ] **Step 7: 提交并推送**

```powershell
git add packages/codex-plugin/src/ui/use-work-execution.ts packages/codex-plugin/src/ui/components/RepositoryDialog.tsx packages/codex-plugin/src/ui/components/ExecutionSummary.tsx packages/codex-plugin/src/ui/components/WorkItemDetailDrawer.tsx packages/codex-plugin/src/ui/App.tsx packages/codex-plugin/src/ui/styles.css packages/codex-plugin/tests/ui.test.tsx
git commit -m "feat(ui): make repository associations editable and clear"
git push internal codex/feishu-project-provider
```

---

### Task 4: Demo、E2E、文档与真实验收

**Files:**

- Modify: `packages/codex-plugin/src/ui/demo-harness.tsx`
- Modify: `packages/codex-plugin/e2e/taskboard.spec.ts`
- Modify: `docs/user-guide.md`
- Modify: `docs/operations/codex-plugin-demo.md`

- [ ] **Step 1: 扩展 Demo Harness 与 Playwright 场景**

增加 `repository-linked`、`repository-selecting`、`repository-binding`、`repository-locked` 合成状态。Playwright 在 1440x900 与 390x844 验证：文案不溢出、按钮不因状态文字变化造成弹窗宽度改变、路径与按钮不重叠、锁定原因可见、键盘焦点可见。

- [ ] **Step 2: 运行浏览器 RED/GREEN**

先写断言并确认当前 harness 失败，再实现场景：

```powershell
npm run test:e2e --workspace @flowrivet/codex-plugin
```

- [ ] **Step 3: 更新用户与运维文档**

用户手册说明创建分支前修改、创建后锁定、再次选择从当前路径开始，以及 pending/success/error 含义。运维文档增加 Windows 无 PowerShell、初始目录、路径脱敏和 Companion 更新验收；不写真实本机路径。

- [ ] **Step 4: 完整自动化验证**

```powershell
npm test --workspace @flowrivet/codex-plugin
npm run typecheck --workspace @flowrivet/codex-plugin
npm run build --workspace @flowrivet/codex-plugin
npm run test:e2e --workspace @flowrivet/codex-plugin
git diff --check
```

- [ ] **Step 5: 提交并推送**

```powershell
git add packages/codex-plugin/src/ui/demo-harness.tsx packages/codex-plugin/e2e/taskboard.spec.ts docs/user-guide.md docs/operations/codex-plugin-demo.md
git commit -m "docs(workflow): cover repository reassociation feedback"
git push internal codex/feishu-project-provider
```

- [ ] **Step 6: 更新本地插件并检查运行态**

```powershell
npm run plugin:update
Invoke-RestMethod http://127.0.0.1:43120/health | ConvertTo-Json -Compress
```

确认 Companion PID 已更新且健康；刷新当前看板即可加载新 UI。若 Codex 宿主缓存旧 MCP 资源，仅新建任务，不把重启整个 Codex 作为默认步骤。

- [ ] **Step 7: Windows 真实验收**

1. 关联一个无 branch/MR 的真实测试执行，成功后看到“仓库已关联”。
2. 点击“修改仓库关联”，确认当前 GitLab 项目与本地路径已预选。
3. 点击文件夹按钮，确认只出现系统文件夹窗口、没有 PowerShell，初始位置为当前路径且能向上浏览。
4. 取消后路径保持；重新选择后出现“目录已选择”；关联失败保留全部输入。
5. 修改成功后执行 ID 不变、仓库更新。
6. 为执行创建测试 branch 后，确认 UI 显示锁定，直接调用工具修改项目或本地路径返回 `execution_repository_locked`，相同关联重试成功。
7. 检查 `companion.log` 不包含初始路径、最终路径或目录内容。

---

## Definition of Done

- 创建研发分支或 MR 前，用户能重新打开、预选并修改仓库关联；活动后 UI 与服务端共同锁定。
- 已关联项目不在首个 50 条结果时仍能通过 projectId 精确恢复；读取失败不伪造项目数据。
- 再次选择文件夹从当前存在目录开始；无效提示不阻断选择；Windows 不显示 PowerShell且可向上浏览。
- 目录选择、关联中、成功、失败和锁定均有可见、可访问、不跳动的反馈；reduced-motion 生效。
- 路径提示与选择结果不进入日志、文档 Fixture 或错误文本。
- 单元、合同、React、生产构建和 Playwright 全部通过，Windows 真实 E2E 完成。
- 四个逻辑阶段独立提交并推送 `codex/feishu-project-provider`，最终工作区干净。
