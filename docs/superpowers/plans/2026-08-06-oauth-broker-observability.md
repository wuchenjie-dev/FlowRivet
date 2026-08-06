# OAuth Broker Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 FlowRivet OAuth Broker 增加基于 Pino 的安全 JSON 日志、端到端 requestId 传播和 OAuth 事务关联能力。

**Architecture:** `logging.ts` 负责 Pino 构造、字段脱敏和事务指纹，`request-context.ts` 负责可信 requestId 的提取与生成。HTTP 入口为每个请求创建 child logger，并在 `finish` 时记录统一完成事件；OAuth 领域事件只记录白名单字段，TAPD 上游错误通过类型化错误提供状态分类。

**Tech Stack:** Node.js 22、TypeScript、Pino、Vitest、Node HTTP Server

---

## 文件结构

- Create: `services/oauth-broker/src/logging.ts`：创建 Pino logger、redact 配置和 `transactionRef`。
- Create: `services/oauth-broker/src/request-context.ts`：校验或生成 requestId。
- Create: `services/oauth-broker/tests/logging.test.ts`：验证 JSON 格式、级别和敏感字段脱敏。
- Create: `services/oauth-broker/tests/http-observability.test.ts`：验证响应头、请求完成事件和 OAuth 跨阶段关联。
- Modify: `services/oauth-broker/src/config.ts`：解析和校验 `FLOWRIVET_LOG_LEVEL`。
- Modify: `services/oauth-broker/src/auth/token-exchange.ts`：暴露不含上游响应体的类型化交换错误。
- Modify: `services/oauth-broker/src/index.ts`：注入 logger，记录 HTTP、OAuth 和启动事件。
- Modify: `services/oauth-broker/package.json`、`package-lock.json`：加入 Pino 运行依赖。

### Task 1: Pino 日志基础设施

**Files:**
- Create: `services/oauth-broker/src/logging.ts`
- Create: `services/oauth-broker/tests/logging.test.ts`
- Modify: `services/oauth-broker/src/config.ts`
- Modify: `services/oauth-broker/tests/oauth.test.ts`
- Modify: `services/oauth-broker/package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: 安装 Pino 依赖**

Run: `npm install pino --workspace @flowrivet/oauth-broker`

Expected: `services/oauth-broker/package.json` 出现 `pino`，锁文件只包含该依赖及其传递依赖。

- [ ] **Step 2: 写日志与配置的失败测试**

在 `logging.test.ts` 使用 `PassThrough` 收集 Pino 输出，断言事件是单行 JSON、包含 `event`，且下列 fixture 不出现在序列化结果中：

```ts
const secretFixture = {
  accessToken: "fixture-access-token",
  clientSecret: "fixture-client-secret",
  code: "fixture-code",
  state: "fixture-state",
  codeVerifier: "fixture-verifier",
  headers: { authorization: "Bearer fixture-token" },
};

logger.info({ event: "test.redaction", ...secretFixture });
expect(output).not.toContain("fixture-");
expect(JSON.parse(output).event).toBe("test.redaction");
```

在 `oauth.test.ts` 增加配置断言：缺省 `logLevel === "info"`，非法值抛出 `FLOWRIVET_LOG_LEVEL` 错误。

- [ ] **Step 3: 运行测试并确认红灯**

Run: `npm test --workspace @flowrivet/oauth-broker -- tests/logging.test.ts tests/oauth.test.ts`

Expected: FAIL，原因是 `logging.ts`、`BrokerConfig.logLevel` 和 Pino 依赖尚未实现。

- [ ] **Step 4: 实现最小 logger 与配置校验**

`logging.ts` 应导出：

```ts
import { createHash } from "node:crypto";
import pino, { type DestinationStream, type Logger } from "pino";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type AppLogger = Logger;

export function createLogger(level: LogLevel, destination?: DestinationStream) {
  return pino({
    level,
    redact: {
      paths: [
        "accessToken", "access_token", "clientSecret", "client_secret",
        "authorization", "headers.authorization", "code", "state",
        "codeVerifier", "codeChallenge", "authorizationUrl", "body", "url",
      ],
      censor: "[REDACTED]",
    },
  }, destination);
}

export function transactionRef(id: string) {
  return createHash("sha256").update(id).digest("hex").slice(0, 16);
}
```

`config.ts` 使用白名单校验日志级别，不接受任意字符串。

- [ ] **Step 5: 运行测试、类型检查并确认绿灯**

Run: `npm test --workspace @flowrivet/oauth-broker -- tests/logging.test.ts tests/oauth.test.ts`

Expected: PASS。

Run: `npm run typecheck --workspace @flowrivet/oauth-broker`

Expected: PASS。

- [ ] **Step 6: 提交日志基础设施**

```powershell
git add services/oauth-broker/src/logging.ts services/oauth-broker/src/config.ts services/oauth-broker/tests/logging.test.ts services/oauth-broker/tests/oauth.test.ts services/oauth-broker/package.json package-lock.json
git commit -m "feat(auth): add structured broker logging"
```

### Task 2: requestId 传播与 HTTP 完成日志

**Files:**
- Create: `services/oauth-broker/src/request-context.ts`
- Create: `services/oauth-broker/tests/http-observability.test.ts`
- Modify: `services/oauth-broker/src/index.ts`

- [ ] **Step 1: 写 requestId HTTP 集成失败测试**

启动 `createOAuthBroker` 到随机端口并注入内存 logger，至少覆盖：

```ts
const response = await fetch(`${baseUrl}/missing`, {
  headers: { "x-request-id": "client-request-123" },
});
expect(response.headers.get("x-request-id")).toBe("client-request-123");
expect(event("http.request.completed")).toMatchObject({
  requestId: "client-request-123",
  method: "GET",
  path: "/missing",
  statusCode: 404,
});
```

再验证缺失、短值、含空格和多值 requestId 均被 UUID 替换；400 错误响应也必须带相同响应头和完成日志。

- [ ] **Step 2: 运行测试并确认红灯**

Run: `npm test --workspace @flowrivet/oauth-broker -- tests/http-observability.test.ts`

Expected: FAIL，响应头和日志不存在。

- [ ] **Step 3: 实现 request context**

`request-context.ts`：

```ts
import { randomUUID } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

const REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

export function resolveRequestId(headers: IncomingHttpHeaders) {
  const value = headers["x-request-id"];
  return typeof value === "string" && REQUEST_ID.test(value) ? value : randomUUID();
}
```

扩展 `createOAuthBroker(config, options?)`，允许注入 `logger` 和 `now`。请求开始时设置响应头并创建 child logger；用 `response.once("finish")` 记录 `http.request.completed`，路径必须来自解析后的 `url.pathname`。

- [ ] **Step 4: 实现拒绝日志**

catch 分支记录 `http.request.rejected`，只写 `errorType` 白名单分类，不传入原始异常对象或输入值。保留现有 400 响应契约。

- [ ] **Step 5: 运行测试、类型检查并确认绿灯**

Run: `npm test --workspace @flowrivet/oauth-broker -- tests/http-observability.test.ts`

Expected: PASS。

Run: `npm run typecheck --workspace @flowrivet/oauth-broker`

Expected: PASS。

- [ ] **Step 6: 提交 requestId 与访问日志**

```powershell
git add services/oauth-broker/src/request-context.ts services/oauth-broker/src/index.ts services/oauth-broker/tests/http-observability.test.ts
git commit -m "feat(auth): correlate broker HTTP requests"
```

### Task 3: OAuth 事务关联与 TAPD 上游错误日志

**Files:**
- Modify: `services/oauth-broker/src/index.ts`
- Modify: `services/oauth-broker/src/auth/token-exchange.ts`
- Modify: `services/oauth-broker/tests/http-observability.test.ts`
- Modify: `services/oauth-broker/tests/oauth.test.ts`

- [ ] **Step 1: 写 OAuth 事件失败测试**

通过注入可控的 token exchange 函数完成创建、回调和兑换三次 HTTP 请求，断言三个业务事件使用不同 requestId、相同 `transactionRef`，且输出不包含 transaction ID、state、code、verifier、challenge、access token 或完整回调 URL。

```ts
expect(events.map(({ event }) => event)).toEqual(expect.arrayContaining([
  "oauth.transaction.created",
  "oauth.callback.completed",
  "oauth.token.redeemed",
]));
expect(new Set(oauthEvents.map(({ transactionRef }) => transactionRef)).size).toBe(1);
```

- [ ] **Step 2: 写上游失败日志测试**

让 token endpoint 返回 503 和带敏感 fixture 的响应体，断言 `tapd.token_exchange.failed` 包含 `upstreamStatus: 503`、稳定 `errorType`，但日志不含响应体和 OAuth 输入。

- [ ] **Step 3: 运行测试并确认红灯**

Run: `npm test --workspace @flowrivet/oauth-broker -- tests/http-observability.test.ts tests/oauth.test.ts`

Expected: FAIL，OAuth 事件、交换依赖注入和类型化错误尚不存在。

- [ ] **Step 4: 实现类型化交换错误**

`token-exchange.ts` 新增 `TapdTokenExchangeError`，只保存 `upstreamStatus` 和固定 `errorType = "tapd_token_exchange_failed"`。不得保存响应体、Authorization 或请求数据。

- [ ] **Step 5: 实现 OAuth 生命周期事件**

创建事务后计算并记录 `transactionRef`；回调通过 `getByState` 返回的内部 ID 得到相同指纹；兑换从输入 transaction ID 计算相同指纹。成功事件只使用 spec 的白名单字段。捕获 `TapdTokenExchangeError` 时额外记录 error 级别的上游事件，通用拒绝事件仍由统一 catch 产生。

- [ ] **Step 6: 运行测试和类型检查**

Run: `npm test --workspace @flowrivet/oauth-broker`

Expected: PASS。

Run: `npm run typecheck --workspace @flowrivet/oauth-broker`

Expected: PASS。

- [ ] **Step 7: 提交 OAuth 审计日志**

```powershell
git add services/oauth-broker/src/index.ts services/oauth-broker/src/auth/token-exchange.ts services/oauth-broker/tests/http-observability.test.ts services/oauth-broker/tests/oauth.test.ts
git commit -m "feat(auth): trace OAuth broker lifecycle"
```

### Task 4: 启动日志与端到端验收

**Files:**
- Modify: `services/oauth-broker/src/index.ts`
- Modify: `services/oauth-broker/tests/http-observability.test.ts`
- Modify: `docs/architecture/oauth-broker.md`

- [ ] **Step 1: 写启动事件失败测试**

把进程入口的监听逻辑提取为可测试的 `startOAuthBroker`，注入 logger。断言只在 `listening` 后记录 `broker.started`，监听错误记录 `broker.start_failed`；启动事件只能包含 host、port、callbackPath 和 scopes。

- [ ] **Step 2: 运行测试并确认红灯**

Run: `npm test --workspace @flowrivet/oauth-broker -- tests/http-observability.test.ts`

Expected: FAIL，`startOAuthBroker` 和启动事件尚不存在。

- [ ] **Step 3: 实现启动日志并更新运行文档**

默认绑定 `127.0.0.1`，在 `listening` 事件记录 `broker.started`。进程入口捕获启动错误，记录 `broker.start_failed` 并设置非零退出码。文档补充 JSON 样例、`FLOWRIVET_LOG_LEVEL` 和 requestId 排障方式，样例使用虚构值。

- [ ] **Step 4: 运行全量自动验证**

Run: `npm test --workspace @flowrivet/oauth-broker`

Expected: PASS。

Run: `npm run typecheck`

Expected: PASS。

Run: `npm run build`

Expected: PASS。

Run: `git diff --check`

Expected: PASS。

- [ ] **Step 5: 执行本地运行验收**

使用测试 Secret 在单独 PowerShell 进程启动 Broker，等待 `broker.started`。请求 `/missing` 并传入 `x-request-id: acceptance-request-001`，确认：

- 响应为 404，响应头为 `acceptance-request-001`。
- 日志存在同 requestId 的 `http.request.completed`。
- 日志中不存在环境 Secret、Authorization、查询参数或请求体。

- [ ] **Step 6: 提交启动与运行文档**

```powershell
git add services/oauth-broker/src/index.ts services/oauth-broker/tests/http-observability.test.ts docs/architecture/oauth-broker.md
git commit -m "feat(auth): log broker startup"
```

- [ ] **Step 7: 最终确认**

Run: `git status --short`

Expected: 无输出。

Run: `git log -4 --oneline`

Expected: 显示本计划的四个独立提交，提交顺序与任务一致。
