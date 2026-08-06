# OAuth Broker 可观测性设计

## 目标

为 FlowRivet OAuth Broker 增加可用于本地排障和远程日志平台采集的结构化日志。每个 HTTP 请求必须拥有可追踪的 `requestId`，OAuth 授权的创建、回调和兑换阶段必须能够安全关联，同时禁止泄漏任何凭据或一次性授权材料。

本次只覆盖 OAuth Broker。CLI、官方 TAPD MCP 进程和其他服务的统一遥测不在本次范围内。

## 方案

Broker 使用 Pino 向 stdout 输出单行 JSON 日志，不直接写文件，也不引入 pretty transport。容器、进程管理器或部署平台负责采集并按 `level` 分流；启动失败同时由非零进程退出码表达。

日志器由 Broker 入口创建并注入 HTTP 服务。测试可以注入内存日志器，避免依赖全局 console。日志级别由 `FLOWRIVET_LOG_LEVEL` 控制，允许 `debug`、`info`、`warn`、`error`，默认 `info`；非法值应在启动配置校验阶段拒绝。

## 请求关联

每个请求按以下规则产生 `requestId`：

1. 若请求携带单值 `x-request-id`，且只包含 ASCII 字母、数字、点、下划线和短横线，长度为 8 到 128，则复用该值。
2. 其他情况使用 `randomUUID()` 生成新值，禁止把非法输入写入日志。
3. 所有响应，包括 404 和错误响应，均返回 `x-request-id`。
4. 请求 child logger 固定绑定 `requestId`、`method` 和不含查询参数的 `path`。

OAuth 事务跨多个 HTTP 请求，不能只依赖 `requestId`。Broker 对内部 transaction ID 计算 SHA-256，并截取前 16 个十六进制字符作为 `transactionRef`。日志只记录 `transactionRef`，不记录真实 transaction ID、state 或 PKCE 数据。

## 日志事件

所有事件包含 Pino 默认时间、日志级别和稳定的 `event` 字段。

| 事件 | 级别 | 必要字段 |
|---|---|---|
| `broker.started` | info | `host`、`port`、`callbackPath`、`scopes` |
| `http.request.completed` | info | `requestId`、`method`、`path`、`statusCode`、`durationMs` |
| `oauth.transaction.created` | info | `requestId`、`transactionRef`、`expiresAt`、`expectedCompany` |
| `oauth.callback.completed` | info | `requestId`、`transactionRef`、`companyId`、`scope` |
| `oauth.token.redeemed` | info | `requestId`、`transactionRef` |
| `http.request.rejected` | warn | `requestId`、`method`、`path`、`statusCode`、`errorType` |
| `tapd.token_exchange.failed` | error | `requestId`、`transactionRef`、`upstreamStatus`、`errorType` |

`expectedCompany` 只表示是否配置预期企业，不记录输入值。成功回调中的 `companyId` 属于租户关联标识，允许记录；用户 ID 不记录。错误日志使用稳定的错误类别，不直接记录可能包含外部响应或输入数据的原始错误消息。

## 安全边界

Pino 必须配置 redact 作为最后一道保护，至少覆盖下列常见字段及其嵌套形式：

- `accessToken`、`access_token`、`clientSecret`、`client_secret`
- `authorization`、`headers.authorization`
- `code`、`state`、`codeVerifier`、`codeChallenge`
- `authorizationUrl`、完整请求 URL、请求体

业务代码仍遵循白名单字段记录原则，不能把 request、response、Token payload 或异常对象整体交给 logger。回调日志只记录路径，绝不记录查询字符串。

## 错误处理

当前 Broker 把所有异常返回为 400，本次不改变对外错误契约。日志层为已知输入错误、OAuth 状态错误和 TAPD 上游错误分配稳定 `errorType`。日志写入失败不得影响 OAuth 响应；Pino 的同步异常不应从请求处理路径向外传播。

服务启动失败时记录 `broker.start_failed` 后让进程以非零状态退出。成功监听后才记录 `broker.started`，避免产生错误的就绪信号。

## 测试策略

单元和 HTTP 集成测试必须覆盖：

- 无请求头时生成 UUID，并在响应头和日志中保持一致。
- 合法 `x-request-id` 被复用；非法或多值请求头被替换。
- 成功、404 和异常响应均包含 requestId 与完成日志。
- OAuth 三阶段使用相同 `transactionRef`，但使用各自的 requestId。
- 日志不包含 fixture Token、Secret、code、state、verifier、challenge 或完整回调 URL。
- TAPD 交换失败记录上游状态和稳定错误类别，不记录上游响应体。
- `FLOWRIVET_LOG_LEVEL` 默认值和非法值校验。

## 准入与准出

准入标准：现有 OAuth Broker 测试、类型检查和构建通过；日志字段、安全边界和 requestId 规则已在本设计中确认。

准出标准：新增测试先失败后通过；Broker 测试、全仓类型检查和构建通过；人工启动时可看到 `broker.started` JSON；完成一次本地错误请求后，响应头与日志 requestId 一致；对日志样本执行敏感值扫描无命中。
