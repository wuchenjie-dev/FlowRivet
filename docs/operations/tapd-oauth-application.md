# FlowRivet TAPD OAuth 应用运维

## 已验证配置

- 应用类型：网页应用开发。
- 研发协作权限：POC 阶段 17 个模块读写；正式发布前收敛到 CLI 实际需要的最小 scope。
- 本机开发回调：`http://127.0.0.1:43119/oauth/callback`。
- 普通企业无需安装未上架应用即可进行用户态 OAuth 授权；应用安装和应用商店上架是另一条流程。

## Broker 启动配置

以下变量只配置在 Broker 部署环境：

```text
TAPD_OAUTH_CLIENT_ID=<应用 ID>
TAPD_OAUTH_CLIENT_SECRET=<Secret Manager 注入>
FLOWRIVET_OAUTH_CALLBACK_URI=https://oauth.example.com/oauth/callback
FLOWRIVET_TAPD_SCOPES=story#read workspace#read
PORT=43119
FLOWRIVET_START_OAUTH_BROKER=true
```

生产环境先在 TAPD“应用开发 -> 安全设置 -> 三方应用数据授权”登记完全一致的 HTTPS 回调，再部署 Broker。不得把应用密钥写入 `.env`、镜像、GitHub Actions 或 CLI 配置。

## 授权与撤销

1. CLI 创建本地 PKCE verifier，仅把 challenge 发给 Broker。
2. 用户在 TAPD 选择企业并确认 scope；TAPD 只授予当前用户可访问的资源。
3. Broker 交换授权码，CLI 一次性兑换 Token 并写入操作系统原生凭据库。
4. 用户退出时删除本机 Token；权限变化或 Token 过期时重新授权。
5. 紧急撤销时先轮换 TAPD 应用密钥，再撤销用户授权并重启 Broker。

## 密钥轮换

1. 在部署平台创建新 Secret 版本，不输出明文。
2. 更新 TAPD 应用密钥并滚动重启 Broker。
3. 验证新授权事务成功，旧实例全部退出。
4. 撤销旧 Secret 版本并检查日志中不存在凭据内容。

POC 使用本机 Broker 时，密钥只允许通过当前进程环境注入，验证结束立即关闭进程并清除环境变量。
