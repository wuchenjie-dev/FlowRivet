# 飞书“我创建的”任务同步调度设计

## 1. 背景

FlowRivet 通过飞书项目 CLI，按“项目 + 工作项类型”执行 MQL，补充仅出现在“我创建的”视图中的工作项。真实环境目前有 9 个最近项目、132 个工作项类型。

现有实现存在两个根因：

- 所有类型都固定查询“完成时间”。大量类型没有该字段，飞书返回 metadata error，导致该类型全部任务同步失败。
- 每次同步最多执行 40 次 created 查询，并按完整项目预留预算。类型数超过剩余预算的项目整轮跳过；单项目超过 40 个类型时会永久饥饿。跳过类型还被计为失败，造成“0 个成功项目、9 个失败项目”的误导结果。

## 2. 目标

- 手动刷新一次覆盖当前账号可见的全部最近项目和工作项类型。
- 自动刷新以有界成本公平轮转，有限轮次内覆盖全部类型。
- 缺少“完成时间”不再阻断活动工作项同步。
- 未在本轮自动扫描的类型保留缓存，但不计为同步失败。
- 真实 CLI、权限、限流、合同解析等错误继续按项目和类型降级。
- 看板能显示本轮扫描范围，避免把轮转误解为全量刷新。

## 3. 非目标

- 不接入未验证的飞书内部接口。
- 不改变飞书项目数据，也不增加写权限。
- 不承诺展示无法取得可靠完成时间的历史完成项。
- 不在本次修改中改变 TAPD Provider。

## 4. 刷新模式

同步输入新增 `refreshMode: "manual" | "automatic"`。

### 4.1 手动模式

以下入口使用 `manual`：

- `open_my_taskboard`
- 用户点击看板刷新按钮
- Codex 显式调用 `refresh_my_work_items` 且未指定自动模式
- 登录完成后的首次看板加载

手动模式扫描完整的类型目录，不应用 40 次类型查询预算。查询继续使用固定并发上限 4，避免瞬时请求放大。单次扫描可能需要几十秒，但结果具有完整覆盖语义。

### 4.2 自动模式

以下入口使用 `automatic`：

- 看板定时刷新
- Companion 后台通知扫描

自动模式每轮最多扫描 40 个类型。类型按稳定的 `(projectKey, typeKey)` 字典序排列；每个账号维护独立游标。每轮从游标的后继位置选择连续类型，允许跨项目边界。

游标保存最后一次已尝试的稳定 `(projectKey, typeKey)`：

- 查询成功或真实查询失败都算“已尝试”，避免坏类型永久阻塞后续类型。
- 目录新增、删除或重排后，如果原 key 仍存在，从其后继继续；如果已删除，从字典序中第一个大于原 key 的项继续，不存在则回绕到首项。
- 只有整批查询完成且同步结束时账号/profile 复核成功，才提交新游标。
- 目录读取失败、身份变化或同步取消不推进游标。
- Companion 重启后游标从序列起点开始；连续运行四轮仍保证覆盖当前 132 个类型。

132 个类型最多经过 4 个连续自动轮次即可全部被扫描。Companion 重启后游标可以从序列起点恢复；只要 Companion 连续运行完整轮次，就不存在永久饥饿。

## 5. 查询合同

### 5.1 基础查询

每个类型的权威基础查询只读取：

- `work_item_id`
- `name`
- `work_item_status`

基础合同支持真实的、结构合法的空结果与非空结果，保持严格 Zod 校验。活动工作项只依赖这三个字段，因此类型缺少“完成时间”时仍能正常进入看板。

### 5.2 完成时间增强

“完成时间”是可选增强能力，不再作为类型查询的准入条件。

- 基础结果中没有完成状态：不执行完成时间增强。
- 存在完成状态：对该类型执行至多一次独立的四字段 MQL，读取 `work_item_id`、`name`、`work_item_status`、`完成时间`，再按工作项 ID 回填完成时间。禁止按工作项逐条读取。
- 自动模式增强查询最多等于本轮扫描类型数，当前上限 40；手动模式最多等于目录类型总数。增强查询与基础查询共享全局并发上限 4。
- 增强字段不存在、权限不足、命令失败、响应不兼容、ID 不匹配或日期非法：保留该类型的全部活动项，丢弃无法证明在七日保留窗口内的完成项；该增强失败只记录脱敏诊断，不产生错误 scope，也不增加 `failedProjects`。
- 获得合法完成时间的完成项继续按现有七日窗口保留。

基础三字段响应与四字段增强响应使用两个独立的严格 Zod 合同。合同允许真实的 `data: {}, list: null` 空结果；只有数据与 list 互相矛盾的伪空结果才 fail closed。混合活动/完成结果合法；缺少必需字段、重复或不匹配 ID、无效日期和多于 50 条必须 fail closed。增强 fail closed 不得回滚已成功的基础结果。

## 6. 轮转与缓存权威性

自动模式只为本轮实际查询的类型发布成功或错误 scope。未轮到的类型不生成错误 scope。

类型目录成功时，Provider 通过独立合同发布完整的 created 类型清单，用于识别真实删除的类型：

```ts
authoritativeScopeInventories: Array<{
  projectExternalId: string;
  providerItemTypePrefix: "created:";
  providerItemTypes: string[];
}>
```

该清单贯通 `AccountWorkItemQueryResult`、`FreshSyncResult` 和 `CacheMergeInput`。`providerItemTypes` 中每项必须是唯一、完整、非空且符合 `created:<typeKey>` 的 scope 值；清单不包含 `created:catalog` 哨兵。SQLite 只能依据该清单剪除不在清单中的 `created:` scope（包括旧哨兵），禁止再从本轮 `scopes` 反推完整目录。目录读取失败的项目不发布 inventory；目录成功且类型数组为空时，空清单允许清除该项目全部旧 `created:` scope，随后本轮成功的 `created:catalog` scope 可重新写入。

缓存层不得把“未轮到”解释成“类型已删除”。因此类型目录权威性与本轮查询权威性保持分离：

- 完整类型清单决定哪些 created scope 仍属于当前项目。
- 本轮查询结果只替换实际扫描的 scope。
- 未扫描 scope 保留上次成功缓存及原 freshness。
- 真实查询失败保留该 scope 的缓存，并进入失败统计。

手动全量扫描后，每个当前类型都必须产生成功或错误结果，不存在 deferred 状态。

### 6.1 缓存写失败

WorkItemService 在发起 manual 或 automatic 同步前都预读当前账号缓存。SQLite 合并写入失败时，使用预读快照在内存中执行与 SQLite 相同的 inventory 剪枝、项目来源剪枝、权威类型清理和 scope 合并：本轮成功 scope 覆盖旧 scope，失败或未扫描 scope 保留旧数据，已从权威 inventory 删除的 scope 不得残留，最终项目和工作项继续执行稳定去重。该结果返回 `cacheWarningCode`；自动模式不得只返回本轮 40 个类型，手动模式的失败 scope 也必须保留原缓存。

如果预读和写入都失败，则只能返回本轮 live 数据并明确 `cache_read_failed`/`cache_write_failed`；此时不宣称未扫描缓存已保留。

## 7. 进度与错误语义

看板快照增加可选 `createdSyncCoverage`，使用严格判别联合：

```ts
type CreatedSyncCoverage =
  | {
      catalog: "available";
      mode: "manual" | "automatic";
      scannedTypeCount: number;
      totalTypeCount: number;
      complete: boolean;
    }
  | {
      catalog: "partial";
      mode: "manual" | "automatic";
      scannedTypeCount: number;
      knownTypeCount: number;
      failedProjectCount: number;
      complete: false;
    }
  | {
      catalog: "unavailable";
      mode: "manual" | "automatic";
      scannedTypeCount: 0;
      complete: false;
    };
```

`catalog: "available"` 表示全部最近项目的类型目录成功，必须满足 `0 <= scannedTypeCount <= totalTypeCount`，且 `complete` 等价于二者相等。部分项目目录成功、部分失败时使用 `catalog: "partial"`：`0 <= scannedTypeCount <= knownTypeCount`、`failedProjectCount >= 1`，且不得宣称全局 complete。最近项目目录本身失败、一个项目类型目录都无法确认时使用 `catalog: "unavailable"`，不伪造总数。

示例：

- 手动：`已全量扫描 132/132 个类型`
- 自动：`自动刷新已扫描 40/132 个类型`

`failedProjects` 仅由实际执行后失败的 scope 产生。轮转未扫描类型不增加 `failedProjects`，也不设置 `provider_unavailable`。

自动轮转中，未扫描缓存仍可使底层 `dataFreshness` 为 `mixed`、增加 `staleScopeCount`，但 UI 在 `catalog: "available"`、`mode: "automatic"`、`complete: false` 且没有实际同步错误时，显示中性的轮转进度，不展示故障警告。`catalog: "partial"` 必须同时展示已知扫描进度和项目目录失败警告。存在实际查询错误、目录不可用、完全离线或缓存错误时仍展示警告；轮转进度不能掩盖这些错误。

工具输入合同明确如下：

- `open_my_taskboard`：空输入，固定 `manual`。
- `list_my_work_items`：空输入，固定 `manual`。
- `refresh_my_work_items`：可选 `refreshMode`，严格枚举 `manual | automatic`，缺省为 `manual`。
- UI 点击刷新调用 `{ refreshMode: "manual" }`；定时器调用 `{ refreshMode: "automatic" }`。
- 通知监控直接向 synchronizer 传入 `automatic`。

## 8. 并发与边界

- created 基础查询并发上限：4。
- 自动模式每轮基础查询上限：40。
- 手动模式基础查询数量：当前稳定类型序列的完整长度。
- 单类型结果仍限制为 50 条；服务返回大于 50 时继续 fail closed，直到取得真实分页合同。
- 类型目录维持 10 分钟成功缓存；失败的项目元数据下一轮立即重试。
- 账号或 profile 变化后，不复用目录、游标或缓存权威性。
- 同账号并发同步继续由 WorkItemService single-flight 协调；不同刷新模式不得错误共享同一个 in-flight 结果。

### 8.1 同账号串行化

同一 provider/account 的同步必须串行，manual 与 automatic 不得并发执行，因此实际 created CLI 并发总数不会超过 4：

- 两个并发 automatic 请求共享同一个 promise，游标只推进一次。
- 两个并发 manual 请求共享同一个 promise。
- automatic 到达时若 manual 正在运行，可复用 manual 全量结果，不推进自动游标。
- manual 到达时若 automatic 正在运行，等待 automatic 完成后再执行全量 manual；多个等待 manual 合并为一次。
- 不同账号继续独立执行，状态和游标不得串用。

## 9. 测试与验收

### 9.1 单元与集成测试

- 无“完成时间”字段的类型，其活动项查询成功。
- 完成时间增强失败时保留活动项，不产生类型失败。
- 手动模式对 132 个类型执行 132 次基础查询。
- 自动模式连续轮次按 `40 + 40 + 40 + 12` 覆盖 132 个类型，无重复饥饿。
- 47 个类型的单项目可以跨自动轮次完成扫描。
- 未扫描类型不生成错误 scope，并保留已有缓存。
- 类型目录 inventory 包含 132 个类型而本轮只扫描 40 个时，另外 92 个缓存不被删除。
- 类型目录删除一个类型时只删除对应 created scope；空权威目录清除全部 created scope；目录失败不删除任何 created scope。
- 强制 SQLite 写失败时，自动刷新仍通过预读快照保留未扫描项。
- 手动刷新存在失败 scope 且 SQLite 写失败时，仍通过预读快照保留该 scope 原缓存。
- inventory 删除类型且 SQLite 写失败时，内存合并同样删除旧类型，不因 fallback 复活。
- 某个实际查询失败时只保留该类型缓存，并准确增加失败统计。
- 目录删除类型仍会清除对应 created 缓存。
- manual 与 automatic 不错误复用 single-flight。
- manual/automatic 重叠时同账号串行、同模式合并、总查询并发不超过 4，游标只推进一次。
- 游标覆盖新增、删除、重排、回绕、全错误、身份变化与 Companion 重启。
- 看板按钮、定时器和通知监控分别传递正确刷新模式。
- server 工具合同验证 `refreshMode` 缺省为 manual、非法值被拒绝。
- 覆盖信息验证自动未完成无错误、自动未完成有错误、手动完成、目录失败和完全离线五种 UI 状态及可访问文案。
- 覆盖信息验证部分项目目录成功/部分失败时使用 `partial`，展示已知进度且不宣称完整。
- 基础与增强合同都接受合法空结果、拒绝结构矛盾的伪空结果。
- 无完成项时增强调用为 0；存在完成项时每个类型最多增强 1 次，基础与增强共享并发上限 4。
- 增强覆盖重复或不匹配 ID、无效日期、畸形字段、合法空结果和超过 50 条；所有增强失败均保留活动项且不产生错误 scope。
- 多节点工作项和 created/mywork 跨来源去重行为保持不变。

### 9.2 真实验收

在已授权的飞书账号上执行：

1. 手动刷新覆盖当前 9 个最近项目和 132 个类型。
2. `需求管理系统 / 解法设计 / 需求测试-TEST` 出现在看板中。
3. 原先因缺少“完成时间”失败的类型能够同步活动项。
4. 原先因 40 次整项目预算延期的项目，在手动刷新中被实际查询。
5. `failedProjects` 不再包含仅因轮转未扫描的项目。
6. 自动模式连续轮次的扫描进度按预期推进。

## 10. 安全与可观测性

- 日志只记录刷新模式、项目 key、类型 key、扫描数量、错误码和耗时，不记录任务正文、人员、凭据或 MQL 返回内容。
- MQL 项目名和类型名继续经过反引号及控制字符校验，命令继续以 argv、`shell: false` 执行。
- 覆盖进度是非敏感运行元数据，可返回给看板和 Codex。
