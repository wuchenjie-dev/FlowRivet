# FlowRivet 飞书任务到 Codex 与 GitLab 研发闭环 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户从飞书项目个人待办创建或恢复 Codex 执行，完成需求分析或代码开发，并通过本机 `git + glab` 形成分支、MR、Pipeline 和飞书结构化回写闭环。

**Architecture:** 在现有 Companion 中新增独立的 `gitlab`、`executions` 和 `codex` 模块。业务层只依赖类型化 Adapter；GitLab 网络操作全部经 `glab`，本地版本控制经 `git`，飞书读写经 Meegle CLI。`server/app.ts` 只挂载拆分后的工具注册器，React 通过专用 hooks 和组件消费稳定合同。

**Tech Stack:** TypeScript、Node.js 22、React 19、Zod、MCP Apps、Vitest、Testing Library、Playwright、SQLite、Git CLI、GitLab `glab` CLI、Meegle CLI

**Design:** `docs/superpowers/specs/2026-08-12-feishu-codex-gitlab-workflow-design.md`

---

## 文件结构

新增或调整的核心边界如下：

```text
packages/codex-plugin/
├── scripts/
│   ├── probe-glab-contract.mjs              # 真实 glab 合同探针
│   ├── probe-codex-task-bridge.mjs          # Codex 宿主能力探针
│   └── probe-meegle-write-contract.mjs      # 飞书写命令只读/沙箱探针
├── src/
│   ├── process/
│   │   └── bounded-command-runner.ts        # 共享安全子进程执行器
│   ├── gitlab/
│   │   ├── contracts.ts                     # GitLab CLI 内部 Schema
│   │   ├── gitlab-adapter.ts                # 业务接口与错误模型
│   │   ├── glab-cli-client.ts               # glab 命令与 JSON 校验
│   │   ├── git-cli-client.ts                # 本地仓库操作
│   │   └── gitlab-service.ts                # 登录、项目、MR、Pipeline 编排
│   ├── executions/
│   │   ├── contracts.ts                     # 公共执行合同
│   │   ├── execution-store.ts               # 存储接口
│   │   ├── sqlite-execution-store.ts         # SQLite 实现
│   │   ├── execution-service.ts              # 幂等与状态机
│   │   ├── confirmation-service.ts           # 一次性人工门禁
│   │   └── result-writer.ts                  # 飞书结构化回写
│   ├── codex/
│   │   └── task-bridge.ts                    # direct/handoff 宿主边界
│   ├── server/tools/
│   │   ├── gitlab-tools.ts                   # GitLab MCP 工具注册
│   │   └── execution-tools.ts                # 执行与门禁工具注册
│   └── ui/
│       ├── use-gitlab-connection.ts          # GitLab 状态/登录 hook
│       ├── use-work-execution.ts             # 执行状态 hook
│       └── components/
│           ├── GitLabConnection.tsx
│           ├── RepositoryPicker.tsx
│           ├── ExecutionSummary.tsx
│           └── GuardedActionDialog.tsx
└── tests/
    ├── bounded-command-runner.test.ts
    ├── glab-cli-client.test.ts
    ├── git-cli-client.test.ts
    ├── gitlab-service.test.ts
    ├── execution-store.test.ts
    ├── execution-service.test.ts
    ├── confirmation-service.test.ts
    ├── result-writer.test.ts
    └── workflow-e2e.test.ts
```

已有 `packages/codex-plugin/src/meegle/command-runner.ts` 的实现迁移到共享 `process/`，Meegle 只改 import，不改变行为。`server/app.ts` 和 `ui/App.tsx` 不继续承载新增业务细节。

---

### Task 1：固化 `glab`、Codex 宿主与 Meegle 写能力探针

**Files:**
- Create: `packages/codex-plugin/scripts/probe-glab-contract.mjs`
- Create: `packages/codex-plugin/scripts/probe-codex-task-bridge.mjs`
- Create: `packages/codex-plugin/scripts/probe-meegle-write-contract.mjs`
- Create: `docs/abf-poc/2026-08-12-glab-cli-probe.md`
- Create: `docs/abf-poc/2026-08-12-codex-task-bridge-probe.md`
- Create: `docs/abf-poc/2026-08-12-meegle-write-probe.md`
- Modify: `packages/codex-plugin/package.json`
- Test: `packages/codex-plugin/tests/probe-contracts.test.ts`

- [ ] **Step 1: 写失败测试，约束探针不得输出凭据且必须返回结构化状态**

```ts
expect(parseProbe(stdout)).toMatchObject({
  ok: expect.any(Boolean),
  capability: expect.any(String),
});
expect(stdout).not.toContain("access_token");
expect(stdout).not.toContain("refresh_token");
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test --workspace @flowrivet/codex-plugin -- probe-contracts.test.ts`

Expected: FAIL，三个探针文件或 package scripts 尚不存在。

- [ ] **Step 3: 实现只读、脱敏探针**

`probe-glab-contract.mjs` 只验证：

```text
glab version
glab auth status --hostname gitlab-aiabu.ruijie.com.cn
glab repo list --mine --page 1 --per-page 2 --output json
glab mr list -R cc/flowrivet --page 1 --per-page 2 --output json
glab ci list -R cc/flowrivet --page 1 --per-page 2 --output json
```

先用 `glab help` 验证实际参数；若命令名或 JSON 开关不同，以已安装版本的官方帮助为准并记录。探针只输出版本、字段名、字段类型和能力布尔值，不输出项目标题、用户资料、URL、Token 或原始错误正文。

`probe-codex-task-bridge.mjs` 检查本地插件宿主是否暴露创建、打开和恢复 Codex 任务的受支持接口，只输出 `direct | handoff`。`probe-meegle-write-contract.mjs` 先读取 `meegle --help` 与相关子命令帮助；只有明确提供沙箱/演练能力时才执行写命令，否则仅记录公开命令合同为 `unsupported`，不得修改真实工作项。

- [ ] **Step 4: 添加脚本入口**

```json
{
  "probe:glab": "node scripts/probe-glab-contract.mjs",
  "probe:codex-task": "node scripts/probe-codex-task-bridge.mjs",
  "probe:meegle-write": "node scripts/probe-meegle-write-contract.mjs"
}
```

- [ ] **Step 5: 运行自动化探针测试**

Run: `npm test --workspace @flowrivet/codex-plugin -- probe-contracts.test.ts`

Expected: PASS；Fixture 中的敏感字段被拒绝或脱敏。

- [ ] **Step 6: 在用户已登录环境运行真实探针并记录结果**

Run: `npm run probe:glab --workspace @flowrivet/codex-plugin`

Expected: JSON 结果明确列出 `auth`、`projects`、`mergeRequests`、`pipelines` 能力。未登录时应返回 `gitlab_not_connected`，不得报通用异常。

Run: `npm run probe:codex-task --workspace @flowrivet/codex-plugin`

Run: `npm run probe:meegle-write --workspace @flowrivet/codex-plugin`

Expected: 两个探针分别给出 `direct | handoff` 和飞书写能力矩阵。

- [ ] **Step 7: 提交探针**

```powershell
git add packages/codex-plugin/scripts packages/codex-plugin/package.json packages/codex-plugin/tests/probe-contracts.test.ts docs/abf-poc
git commit -m "test(integration): probe glab Codex and Meegle contracts"
git push internal HEAD
```

---

### Task 2：提取共享安全命令执行器

**Files:**
- Create: `packages/codex-plugin/src/process/bounded-command-runner.ts`
- Modify: `packages/codex-plugin/src/meegle/command-runner.ts`
- Modify: `packages/codex-plugin/src/meegle/meegle-cli-client.ts`
- Test: `packages/codex-plugin/tests/bounded-command-runner.test.ts`
- Test: `packages/codex-plugin/tests/meegle-cli-client.test.ts`

- [ ] **Step 1: 为共享执行器写失败测试**

覆盖绝对路径发现、Windows `.cmd`、参数换行拒绝、超时、Abort、stdout/stderr 上限、完整进程树终止和退出码映射。

- [ ] **Step 2: 运行新旧测试确认新测试失败**

Run: `npm test --workspace @flowrivet/codex-plugin -- bounded-command-runner.test.ts meegle-cli-client.test.ts`

Expected: FAIL，新共享模块不存在；Meegle 旧测试仍通过。

- [ ] **Step 3: 移动而非复制执行逻辑**

共享接口保持参数数组，不新增 shell 字符串：

```ts
export interface CommandRunInput {
  executablePath: string;
  args: string[];
  timeoutMs: number;
  signal?: AbortSignal;
  allowExitCodes?: number[];
  stdin?: string;
  cwd?: string;
  environment?: Record<string, string>;
}
```

只允许显式最小环境；Token 不得由业务输入注入。旧 `meegle/command-runner.ts` 临时 re-export 共享实现，避免大范围同步修改。

- [ ] **Step 4: 运行测试与类型检查**

Run: `npm test --workspace @flowrivet/codex-plugin -- bounded-command-runner.test.ts meegle-cli-client.test.ts`

Run: `npm run typecheck --workspace @flowrivet/codex-plugin`

Expected: PASS。

- [ ] **Step 5: 提交共享执行边界**

```powershell
git add packages/codex-plugin/src/process packages/codex-plugin/src/meegle packages/codex-plugin/tests
git commit -m "refactor(cli): share bounded command runner"
git push internal HEAD
```

---

### Task 3：实现 GitLab 合同与 `glab` 只读客户端

**Files:**
- Create: `packages/codex-plugin/src/contracts/gitlab.ts`
- Create: `packages/codex-plugin/src/gitlab/contracts.ts`
- Create: `packages/codex-plugin/src/gitlab/gitlab-adapter.ts`
- Create: `packages/codex-plugin/src/gitlab/glab-cli-client.ts`
- Test: `packages/codex-plugin/tests/gitlab-contracts.test.ts`
- Test: `packages/codex-plugin/tests/glab-cli-client.test.ts`

- [ ] **Step 1: 写失败 Schema 与客户端测试**

公共连接状态固定为：

```ts
type GitLabConnectionState =
  | "checking"
  | "cli_missing"
  | "cli_unsupported"
  | "disconnected"
  | "connected"
  | "unavailable";
```

项目只暴露 `host`、`projectId`、`pathWithNamespace`、`displayName`、`defaultBranch` 和克隆地址类型，不向 UI 返回凭据 URL。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test --workspace @flowrivet/codex-plugin -- gitlab-contracts.test.ts glab-cli-client.test.ts`

Expected: FAIL，新模块不存在。

- [ ] **Step 3: 实现 CLI 发现、版本、登录状态和项目分页**

`GlabCliClient` 使用 Task 1 验证的确切命令和 JSON Schema。所有 `--hostname` 固定为配置中的允许实例；项目搜索是独立参数。未知字段允许忽略，关键字段缺失时返回 `gitlab_output_invalid`。

- [ ] **Step 4: 验证不含直接 API 实现**

Run: `rg -n "fetch\(|axios|/api/v4|graphql" packages/codex-plugin/src/gitlab`

Expected: 无命中。

- [ ] **Step 5: 运行测试与类型检查**

Run: `npm test --workspace @flowrivet/codex-plugin -- gitlab-contracts.test.ts glab-cli-client.test.ts`

Run: `npm run typecheck --workspace @flowrivet/codex-plugin`

Expected: PASS。

- [ ] **Step 6: 提交只读客户端**

```powershell
git add packages/codex-plugin/src/contracts/gitlab.ts packages/codex-plugin/src/gitlab packages/codex-plugin/tests
git commit -m "feat(gitlab): add glab read adapter"
git push internal HEAD
```

---

### Task 4：接入 GitLab OAuth 登录状态与连接 UI

**Files:**
- Create: `packages/codex-plugin/src/gitlab/gitlab-service.ts`
- Create: `packages/codex-plugin/src/server/tools/gitlab-tools.ts`
- Create: `packages/codex-plugin/src/ui/use-gitlab-connection.ts`
- Create: `packages/codex-plugin/src/ui/components/GitLabConnection.tsx`
- Modify: `packages/codex-plugin/src/server/runtime-services.ts`
- Modify: `packages/codex-plugin/src/server/app.ts`
- Modify: `packages/codex-plugin/src/ui/components/ConnectionMenu.tsx`
- Modify: `packages/codex-plugin/src/ui/App.tsx`
- Test: `packages/codex-plugin/tests/gitlab-service.test.ts`
- Test: `packages/codex-plugin/tests/server.test.ts`
- Test: `packages/codex-plugin/tests/ui.test.tsx`

- [ ] **Step 1: 写失败服务端和 UI 测试**

验证连接菜单不再显示“后续接入”，而是准确展示 CLI 缺失、未登录、已连接和版本不兼容；点击连接只触发类型化工具，不接收 Token。

- [ ] **Step 2: 运行聚焦测试确认失败**

Run: `npm test --workspace @flowrivet/codex-plugin -- gitlab-service.test.ts server.test.ts ui.test.tsx`

Expected: FAIL，GitLab 工具和 UI 不存在。

- [ ] **Step 3: 实现 GitLab 工具注册器**

首批工具：

```text
get_gitlab_connection
start_gitlab_login
recheck_gitlab_connection
list_gitlab_projects
```

`start_gitlab_login` 调用 `glab auth login --hostname ... --web --git-protocol https --use-keyring`。CLI 进程启动后立即返回 `waiting`，后台等待退出并重新检查连接。重复点击复用同一登录会话；不读取或返回 Token。

- [ ] **Step 4: 将服务注入进程级 RuntimeServices**

登录会话必须跨 MCP 请求存活，不能在每次 `createServer()` 时重建。`server/app.ts` 只调用 `registerGitLabTools(server, services)`。

- [ ] **Step 5: 实现连接菜单 UI**

使用 `GitLabConnection` 组件和 hook；支持键盘、live region、安装命令复制和重新检查。登录浏览器由 `glab` 打开，页面不显示授权码或 Client Secret。

- [ ] **Step 6: 运行测试、类型检查和构建**

Run: `npm test --workspace @flowrivet/codex-plugin -- gitlab-service.test.ts server.test.ts ui.test.tsx`

Run: `npm run typecheck --workspace @flowrivet/codex-plugin`

Run: `npm run build --workspace @flowrivet/codex-plugin`

Expected: PASS。

- [ ] **Step 7: 提交登录能力**

```powershell
git add packages/codex-plugin/src packages/codex-plugin/tests
git commit -m "feat(gitlab): connect self-managed account with glab"
git push internal HEAD
```

---

### Task 5：实现执行记录存储与状态机

**Files:**
- Create: `packages/codex-plugin/src/contracts/executions.ts`
- Create: `packages/codex-plugin/src/executions/execution-store.ts`
- Create: `packages/codex-plugin/src/executions/sqlite-execution-store.ts`
- Create: `packages/codex-plugin/src/executions/execution-service.ts`
- Modify: `packages/codex-plugin/src/server/runtime-services.ts`
- Test: `packages/codex-plugin/tests/execution-store.test.ts`
- Test: `packages/codex-plugin/tests/execution-service.test.ts`

- [ ] **Step 1: 写失败合同与迁移测试**

验证唯一键 `providerId + accountKey + workItemKey`、`direct | handoff`、账号隔离、仓库绑定和 `writeback_pending`。SQLite 表使用显式 `schema_version` 和唯一约束。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test --workspace @flowrivet/codex-plugin -- execution-store.test.ts execution-service.test.ts`

Expected: FAIL。

- [ ] **Step 3: 实现原子存储**

```sql
CREATE TABLE executions (
  execution_id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  account_key TEXT NOT NULL,
  work_item_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(provider_id, account_key, work_item_key)
);
```

所有 payload 读写通过 Zod；损坏记录返回稳定错误，不静默覆盖。

- [ ] **Step 4: 实现幂等状态机**

`prepare()` 使用唯一键返回已有记录；非法逆向状态变化拒绝。更换仓库在存在未推送提交或活动 MR 时返回 `execution_repository_locked`。

- [ ] **Step 5: 运行测试与类型检查**

Run: `npm test --workspace @flowrivet/codex-plugin -- execution-store.test.ts execution-service.test.ts`

Run: `npm run typecheck --workspace @flowrivet/codex-plugin`

Expected: PASS。

- [ ] **Step 6: 提交执行核心**

```powershell
git add packages/codex-plugin/src/contracts/executions.ts packages/codex-plugin/src/executions packages/codex-plugin/src/server/runtime-services.ts packages/codex-plugin/tests
git commit -m "feat(executions): persist work item execution state"
git push internal HEAD
```

---

### Task 6：实现 Codex Task Bridge 与“开始/继续处理”

**Files:**
- Create: `packages/codex-plugin/src/codex/task-bridge.ts`
- Create: `packages/codex-plugin/src/server/tools/execution-tools.ts`
- Create: `packages/codex-plugin/src/ui/use-work-execution.ts`
- Create: `packages/codex-plugin/src/ui/components/ExecutionSummary.tsx`
- Modify: `packages/codex-plugin/src/ui/components/WorkItemDetailDrawer.tsx`
- Modify: `packages/codex-plugin/src/ui/App.tsx`
- Modify: `packages/codex-plugin/src/server/app.ts`
- Test: `packages/codex-plugin/tests/task-bridge.test.ts`
- Test: `packages/codex-plugin/tests/server.test.ts`
- Test: `packages/codex-plugin/tests/ui.test.tsx`

- [ ] **Step 1: 根据 Task 1 探针结果写失败测试**

若宿主支持 direct，测试创建后返回稳定 `codexTaskId`；否则固定实现 handoff，并测试 `codexHandoffId` 可重复恢复。不得同时声称两种模式成功。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test --workspace @flowrivet/codex-plugin -- task-bridge.test.ts server.test.ts ui.test.tsx`

Expected: FAIL。

- [ ] **Step 3: 实现最小 Task Bridge**

上下文只包含结构化工作项引用、标题、已净化描述、当前执行 ID 和允许的操作列表。外部正文标记为不可信数据；不得注入系统提示或自动批准门禁。

- [ ] **Step 4: 注册执行工具**

```text
prepare_work_item_execution
get_work_item_execution
record_execution_artifact
```

`prepare` 从当前飞书身份取得 `accountKey`，调用执行服务，再创建/恢复 Codex task 或 handoff。

- [ ] **Step 5: 在详情抽屉增加主要命令**

未执行显示“开始处理”，已有记录显示“继续处理”。点击后展示执行类型、状态和 Codex 任务入口；不在此阶段要求选择仓库。

- [ ] **Step 6: 运行测试、类型检查和构建**

Run: `npm test --workspace @flowrivet/codex-plugin -- task-bridge.test.ts server.test.ts ui.test.tsx`

Run: `npm run typecheck --workspace @flowrivet/codex-plugin`

Run: `npm run build --workspace @flowrivet/codex-plugin`

Expected: PASS。

- [ ] **Step 7: 提交任务入口**

```powershell
git add packages/codex-plugin/src packages/codex-plugin/tests
git commit -m "feat(executions): start Codex work from Feishu items"
git push internal HEAD
```

---

### Task 7：实现仓库选择、本地复用与安全克隆

**Files:**
- Create: `packages/codex-plugin/src/gitlab/git-cli-client.ts`
- Create: `packages/codex-plugin/src/ui/components/RepositoryPicker.tsx`
- Modify: `packages/codex-plugin/src/gitlab/gitlab-service.ts`
- Modify: `packages/codex-plugin/src/server/tools/execution-tools.ts`
- Modify: `packages/codex-plugin/src/ui/use-work-execution.ts`
- Modify: `packages/codex-plugin/src/ui/components/ExecutionSummary.tsx`
- Test: `packages/codex-plugin/tests/git-cli-client.test.ts`
- Test: `packages/codex-plugin/tests/repository-workflow.test.ts`
- Test: `packages/codex-plugin/tests/ui.test.tsx`

- [ ] **Step 1: 写失败 Git 安全边界测试**

覆盖 remote URL 规范化、精确项目匹配、脏工作树、错误仓库、默认分支、用户选择父目录、目标目录非空、路径越界和分支名净化。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test --workspace @flowrivet/codex-plugin -- git-cli-client.test.ts repository-workflow.test.ts ui.test.tsx`

Expected: FAIL。

- [ ] **Step 3: 实现只接受参数数组的 GitCliClient**

允许的首批命令：

```text
git remote get-url --all origin
git status --porcelain=v1
git branch --show-current
git rev-parse --show-toplevel
git clone -- <url> <target>
git fetch origin <default-branch>
git switch -c <branch> --track origin/<default-branch>
```

禁止 `reset --hard`、`clean`、force push 和直接切换受保护分支。OAuth 凭据由 `glab`/Git credential helper 提供，不拼进 clone URL。

- [ ] **Step 4: 实现项目分页选择与目录选择合同**

RepositoryPicker 支持搜索、分页、加载/错误/空状态。目录选择必须经宿主受支持的本地目录选择能力；能力不存在时展示明确路径输入并做父目录实路径校验，不能允许任意相对路径逃逸。

- [ ] **Step 5: 运行测试、类型检查和构建**

Run: `npm test --workspace @flowrivet/codex-plugin -- git-cli-client.test.ts repository-workflow.test.ts ui.test.tsx`

Run: `npm run typecheck --workspace @flowrivet/codex-plugin`

Run: `npm run build --workspace @flowrivet/codex-plugin`

Expected: PASS。

- [ ] **Step 6: 提交仓库工作流**

```powershell
git add packages/codex-plugin/src packages/codex-plugin/tests
git commit -m "feat(executions): bind safe local GitLab workspaces"
git push internal HEAD
```

---

### Task 8：实现分支推送、MR 和 Pipeline 查询

**Files:**
- Modify: `packages/codex-plugin/src/gitlab/glab-cli-client.ts`
- Modify: `packages/codex-plugin/src/gitlab/git-cli-client.ts`
- Modify: `packages/codex-plugin/src/gitlab/gitlab-service.ts`
- Modify: `packages/codex-plugin/src/server/tools/execution-tools.ts`
- Modify: `packages/codex-plugin/src/contracts/executions.ts`
- Test: `packages/codex-plugin/tests/glab-cli-client.test.ts`
- Test: `packages/codex-plugin/tests/development-workflow.test.ts`

- [ ] **Step 1: 写失败幂等与保护测试**

测试分支稳定命名、已存在关联分支复用、错误 remote 拒绝、默认分支推送拒绝、重复 push、重复 MR 创建和 Pipeline Schema。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test --workspace @flowrivet/codex-plugin -- glab-cli-client.test.ts development-workflow.test.ts`

Expected: FAIL。

- [ ] **Step 3: 实现允许的写命令**

```text
git push --set-upstream origin <codex-branch>
glab mr create --repo <project> --source-branch <branch> --target-branch <default> ...
glab mr list --repo <project> --source-branch <branch> --output json
glab ci list --repo <project> --output json
```

MR 描述通过 stdin 或临时受限文件传递，禁止把完整正文放入命令行。创建前按 `executionId` 标记查询现有 MR，确保幂等。

- [ ] **Step 4: 注册开发链路工具**

```text
bind_execution_repository
inspect_execution_workspace
push_execution_branch
create_execution_merge_request
get_execution_pipeline
```

工具不能提交任意 Shell 或任意可执行路径。所有写操作记录 `requestId`、`executionId`、project ID、分支/MR IID 和脱敏结果。

- [ ] **Step 5: 运行测试与类型检查**

Run: `npm test --workspace @flowrivet/codex-plugin -- glab-cli-client.test.ts development-workflow.test.ts server.test.ts`

Run: `npm run typecheck --workspace @flowrivet/codex-plugin`

Expected: PASS。

- [ ] **Step 6: 提交开发链路**

```powershell
git add packages/codex-plugin/src packages/codex-plugin/tests
git commit -m "feat(gitlab): push branches and open merge requests"
git push internal HEAD
```

---

### Task 9：实现一次性确认门禁

**Files:**
- Create: `packages/codex-plugin/src/executions/confirmation-service.ts`
- Create: `packages/codex-plugin/src/ui/components/GuardedActionDialog.tsx`
- Modify: `packages/codex-plugin/src/contracts/executions.ts`
- Modify: `packages/codex-plugin/src/server/tools/execution-tools.ts`
- Modify: `packages/codex-plugin/src/gitlab/glab-cli-client.ts`
- Test: `packages/codex-plugin/tests/confirmation-service.test.ts`
- Test: `packages/codex-plugin/tests/guarded-actions.test.ts`
- Test: `packages/codex-plugin/tests/ui.test.tsx`

- [ ] **Step 1: 写失败门禁测试**

验证无 challenge、错误用户、错误目标、过期、状态版本变化、重复确认和 Companion 重启后全部拒绝。自然语言或工具参数中的 `confirmed: true` 不得绕过 challenge。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test --workspace @flowrivet/codex-plugin -- confirmation-service.test.ts guarded-actions.test.ts ui.test.tsx`

Expected: FAIL。

- [ ] **Step 3: 实现五分钟内存 challenge**

```ts
interface ConfirmationChallenge {
  challengeId: string;
  operationId: string;
  action: "merge_mr" | "retry_pipeline" | "close_work_item";
  actorKey: string;
  targetVersion: string;
  summary: GuardedActionSummary;
  expiresAt: string;
}
```

challenge 不持久化；进程重启自动失效。执行前重新读取远端可观察状态，计算 `targetVersion` 并比较。

- [ ] **Step 4: 注册门禁工具和 UI**

`prepare_guarded_action` 只生成摘要；`confirm_guarded_action` 必须携带 challenge ID 并消费一次。对话框按钮显示“合并 MR !123”“重试 Pipeline 456”或“关闭飞书任务”，不能只写“确认”。

- [ ] **Step 5: 运行测试、类型检查和构建**

Run: `npm test --workspace @flowrivet/codex-plugin -- confirmation-service.test.ts guarded-actions.test.ts ui.test.tsx`

Run: `npm run typecheck --workspace @flowrivet/codex-plugin`

Run: `npm run build --workspace @flowrivet/codex-plugin`

Expected: PASS。

- [ ] **Step 6: 提交人工门禁**

```powershell
git add packages/codex-plugin/src packages/codex-plugin/tests
git commit -m "feat(safety): guard merge pipeline and task closure"
git push internal HEAD
```

---

### Task 10：实现飞书结构化回写

**Files:**
- Modify: `packages/codex-plugin/src/meegle/meegle-cli-client.ts`
- Create: `packages/codex-plugin/src/executions/result-writer.ts`
- Modify: `packages/codex-plugin/src/server/tools/execution-tools.ts`
- Modify: `packages/codex-plugin/src/contracts/executions.ts`
- Test: `packages/codex-plugin/tests/result-writer.test.ts`
- Test: `packages/codex-plugin/tests/meegle-cli-client.test.ts`
- Test: `packages/codex-plugin/tests/writeback-workflow.test.ts`

- [ ] **Step 1: 根据 Task 1 Meegle 探针结果写失败测试**

只实现探针证明稳定的评论、子任务、字段或节点操作。未支持的能力返回 `feishu_write_capability_unsupported`，不得网页自动化。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test --workspace @flowrivet/codex-plugin -- result-writer.test.ts meegle-cli-client.test.ts writeback-workflow.test.ts`

Expected: FAIL。

- [ ] **Step 3: 实现结构化摘要与幂等标记**

写回正文包含固定机器标记：

```text
<!-- flowrivet:execution=<id>;artifact=<type>;revision=<n> -->
```

正文包含摘要、拆解/分析链接、仓库、分支、MR、测试和 Pipeline 状态。原始工作项正文不修改。重复请求先检查已知 revision 或远端可观察标记。

- [ ] **Step 4: 实现部分失败恢复**

GitLab 已成功、飞书失败时状态进入 `writeback_pending`；重试只重做回写。关闭任务必须经 Task 9 challenge，且飞书节点变化时 challenge 失效。

- [ ] **Step 5: 运行测试与类型检查**

Run: `npm test --workspace @flowrivet/codex-plugin -- result-writer.test.ts meegle-cli-client.test.ts writeback-workflow.test.ts`

Run: `npm run typecheck --workspace @flowrivet/codex-plugin`

Expected: PASS。

- [ ] **Step 6: 提交回写能力**

```powershell
git add packages/codex-plugin/src packages/codex-plugin/tests
git commit -m "feat(feishu): write back execution artifacts"
git push internal HEAD
```

---

### Task 11：完成执行摘要 UI 与浏览器验收

**Files:**
- Modify: `packages/codex-plugin/src/ui/components/ExecutionSummary.tsx`
- Modify: `packages/codex-plugin/src/ui/components/WorkItemDetailDrawer.tsx`
- Modify: `packages/codex-plugin/src/ui/App.tsx`
- Modify: `packages/codex-plugin/src/ui/styles.css`
- Modify: `packages/codex-plugin/src/ui/demo-harness.tsx`
- Test: `packages/codex-plugin/tests/ui.test.tsx`
- Test: `packages/codex-plugin/e2e/taskboard.spec.ts`

- [ ] **Step 1: 写失败交互测试**

覆盖开始/继续处理、分析无需仓库、开发需要选仓库、执行进度、MR/Pipeline 链接、待回写状态和门禁对话框键盘焦点。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test --workspace @flowrivet/codex-plugin -- ui.test.tsx`

Expected: FAIL。

- [ ] **Step 3: 完成克制的 shadcn 风格执行 UI**

详情抽屉保持信息密度，不新增嵌套卡片。状态使用图标、文字和紧凑标签；仓库选择为对话框；MR 和 Pipeline 使用明确外链；最长项目路径在窄屏换行，不遮挡按钮。

- [ ] **Step 4: 运行组件测试与构建**

Run: `npm test --workspace @flowrivet/codex-plugin -- ui.test.tsx`

Run: `npm run build --workspace @flowrivet/codex-plugin`

Expected: PASS。

- [ ] **Step 5: 启动本地服务并运行 Playwright**

Run: `npm run test:e2e --workspace @flowrivet/codex-plugin`

Expected: desktop 和 mobile 视口均通过；全屏看板、详情抽屉和仓库对话框无重叠、无水平内容溢出，焦点可恢复。

- [ ] **Step 6: 提交 UI**

```powershell
git add packages/codex-plugin/src/ui packages/codex-plugin/tests/ui.test.tsx packages/codex-plugin/e2e
git commit -m "feat(ui): surface Codex execution workflow"
git push internal HEAD
```

---

### Task 12：全链路 E2E、用户文档与最终验收

**Files:**
- Create: `packages/codex-plugin/tests/workflow-e2e.test.ts`
- Create: `docs/abf-poc/2026-08-12-feishu-codex-gitlab-e2e.md`
- Modify: `docs/user-guide.md`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-12-feishu-codex-gitlab-workflow-design.md`（仅记录已验证版本/合同，不改变批准范围）

- [ ] **Step 1: 用假 CLI 完成自动化全链路测试**

流程：飞书待办 -> prepare -> Codex direct/handoff -> 选仓库 -> 复用/克隆 -> 分支 -> push -> MR -> Pipeline -> 回写。注入失败验证 `glab` 不可用时没有直接 API 降级，飞书回写失败时可恢复。

- [ ] **Step 2: 运行插件全量测试**

Run: `npm test --workspace @flowrivet/codex-plugin`

Expected: PASS。

- [ ] **Step 3: 运行仓库全量验证**

Run: `npm run typecheck`

Run: `npm test`

Run: `npm run build`

Expected: 全部 PASS；已知平台限定测试只能用明确 skip 原因标记。

- [ ] **Step 4: 在隔离账号完成 Windows 真实 E2E**

使用 Developer 测试用户、隔离飞书工作项和 GitLab 项目。禁止在 `cc/flowrivet` 默认分支上做破坏性验证。记录版本、账号角色、测试工作项、测试分支、MR、Pipeline 和回写结果；文档不记录 Token 或完整业务正文。

- [ ] **Step 5: 更新普通用户手册**

说明：安装 `git/glab`、首次 OAuth、开始/继续处理、选择仓库、本地复用/克隆、MR/Pipeline、三类人工确认、退出登录、版本不兼容和常见恢复动作。

- [ ] **Step 6: 检查敏感信息与直接 API 依赖**

Run: `rg -n "glpat-|access_token|refresh_token|client_secret|/api/v4|graphql" packages/codex-plugin docs`

Expected: 只有测试用合成字符串或安全说明；`src/gitlab` 不存在直接 API URL 或网络客户端。

- [ ] **Step 7: 提交验收与文档**

```powershell
git add packages/codex-plugin/tests/workflow-e2e.test.ts docs README.md
git commit -m "docs(workflow): verify Feishu Codex GitLab loop"
git push internal HEAD
```

---

## 实施门禁

1. Task 1 的 `glab` OAuth 或结构化输出探针不通过时，停止 Task 3-4，先明确版本或实例配置；不得转向 GitLab API。
2. Codex Task Bridge 探针只能决定 `direct` 或 `handoff`，不能阻塞 GitLab 基础能力；选择结果必须固定进合同和测试。
3. Meegle 写探针不通过时，Task 10 只能交付本地产物和“复制/打开飞书”恢复入口，不得声明已回写。
4. 每个 Task 完成后必须运行列出的测试、提交并推送，再开始下一个 Task。
5. 真实 E2E 的合并 MR、Pipeline 重试和关闭任务必须继续逐次人工确认，即使测试用户是管理员。

