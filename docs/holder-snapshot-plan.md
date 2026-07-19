# Top-100 Holder Snapshot System Plan for Pili

## 目标

在 Pili 内实现一个 **Top-100 Holder Snapshot System**，满足两类触发：

1. **交易触发**：当钱包 `CJ5fHkNPf3yd7fKnjv5VtBJTNDAWFiRfLCutpuTAnpis` 发生 `buy/sell` 时，自动抓取该 token 的 top100 holders。
2. **周期触发**：每 6 小时，对该钱包当前仍持有的 token 各抓一次 top100 holders，补足仅靠交易触发拿不到的时间切片。

数据落到 Pili 现有 SQLite：`/Users/xp/vibecoding/pilipili/.data/web3-feed.sqlite`。

---

## 1. 现状勘察结论

### 1.1 Pili 现有运行形态

- Pili 是 **Bun runtime + Hono API + Vite/Next 混合前端** 的项目，SQLite 通过 `better-sqlite3`/`bun:sqlite` 访问。见：
  - `package.json:8-44`
  - `lib/server/sqlite.ts:148-183`
- 主库路径由 `getDb()` 统一解析，默认就是 `.data/web3-feed.sqlite`。见：
  - `lib/server/sqlite.ts:103-127`

### 1.2 runtime task 体系已经存在，适合承载这个功能

- Pili 已有内嵌循环任务系统：
  - `server/runtime-tasks/loopTask.ts:26-181`
  - `server/runtime-tasks/registry.ts:3-31`
  - `server/runtime-context.ts:22-39`
- 默认任务里已经有 `holdings-refresh`，说明“后台循环拉数据并写 SQLite”是现成范式。见：
  - `server/runtime-tasks/defaults.ts:47-82`
- 手动触发某个 runtime task 的 API 已经有：
  - `server/runtime-api.ts:17-27`
  - 可直接 `POST /api/runtime/tasks/:key/run`

### 1.3 现有持仓刷新不是 6h，而是默认 30 分钟

- `holdings-refresh` 的默认 sleep 是 `30 * 60_000`。见：
  - `lib/server/holdingsRefreshRuntime.ts:7-10`
  - `lib/server/holdingsRefreshRuntime.ts:110-117`
  - `lib/server/holdingsRefreshRuntime.ts:473-481`
- `current_holdings` 已是“当前持仓真相表”，用户详情页也已经改为直接读它。见：
  - `lib/server/holdingsRefreshRuntime.ts:119-163`
  - `lib/server/userHoldingsDetails.ts:46-202`

**结论**：代码里没看到“现有 6h holdings cron”；更像是 **30m runtime task 刷 current_holdings**。所以 holder snapshot 的“每 6h”更适合做成 **新的 runtime task 内部 6h bucket 逻辑**，而不是去接一个不存在的外部 cron。

### 1.4 交易相关数据流：有 3 层，但新功能不该挂到最底层

库里已有这些表：

- `raw_transactions`：原始交易载荷缓存
  - `lib/server/sqlite.ts:296-312`
  - upsert：`lib/server/feedSnapshotRepo.ts:762-813`
- `activity_judgments`：交易动作判定（buy/sell/send/receive）
  - `lib/server/sqlite.ts:506-532`
  - upsert：`lib/server/feedSnapshotRepo.ts:815-900`
- `activity_feed`：最终展示层活动流
  - `lib/server/sqlite.ts:534-550`
- `telegram_monitor_tx_states`：更实时、更 token-aware 的交易状态流
  - `lib/server/sqlite.ts:351-396`
  - upsert/更新：`lib/server/telegramMonitorTxStateRepo.ts:514-585`, `596-633`

### 1.5 对“交易触发源”的实际判断

我抽样了目标钱包当前库数据：

- `tracked_addresses` 里已存在目标钱包，chain=`solana`，name=`#1`
- `current_holdings` 里目前这钱包有 2 个 Sol token
- `telegram_monitor_tx_states` 里该钱包有 **218 条** `buy/sell` provisional 记录，其中 **217 条**已带 canonical/reconciled，最新到 **2026-07-09**
- `activity_feed` 里该钱包虽然有 `buy/sell`，但样本最新只到 **2026-05-06**，明显没有 tx_state 新

**结论**：

- **交易触发主信号** 应优先用 `telegram_monitor_tx_states`
- **不要**直接挂 `raw_transactions`：太原始，缺少稳定的 `buy/sell + tokenAddress` 语义
- `activity_feed` 更适合分析展示，不适合做第一触发源

### 1.6 gmgn-cli 返回结构需要做兼容解析

需求里写的是：

- `data.list[]`

但我在本机对 `gmgn-cli token holders --raw` 抽样时，看到的是：

- 顶层直接是 `{"list": [...]}`

因此实现时不要写死 `payload.data.list`，应该兼容：

```ts
const rows = payload?.data?.list ?? payload?.list ?? []
```

这是计划里必须落实的一个点，否则上线就会空解析。

---

## 2. 推荐架构

### 2.1 总体思路

采用 **“检测/入队” 与 “抓取/落库” 解耦** 的方式：

1. 后台 task 轮询新交易事件 / 6h 周期条件
2. 把待抓 token 写入 `holder_snapshot_runs`（状态先记为 `queued`）
3. 同一个 task 或同一模块里的 collector 再按顺序取队列，用 `gmgn-cli` 抓 holders
4. 结果写入 `holder_snapshot_holders`

### 2.2 为什么不在交易热路径里直接调用 gmgn-cli

不建议把 `gmgn-cli` 调用直接塞进：

- `markTelegramMonitorTxStateReconciled(...)`
- `upsertTelegramMonitorTxStateProvisional(...)`
- `syncService` 主链路

原因：

1. **gmgn-cli 是外部命令**，有 IO、超时、格式波动风险
2. 需求明确有 **500ms 节流**，说明它不适合阻塞主交易流
3. 解耦后更容易重试、补跑、手动触发、查状态
4. 未来如果换成 HTTP API 或本地缓存，collector 层更容易替换

### 2.3 v1 设计原则

- **只支持 Solana**，不顺手抽象多链 holder snapshot
- **只服务这个钱包**，不一次扩展到所有 tracked wallet
- **用 SQLite 新表承载队列 + 结果**，不新建独立服务
- **保持单 worker、低并发**，靠顺序处理满足速率限制

---

## 3. 数据库设计

> 推荐：不单独建 queue 表，直接让 `holder_snapshot_runs` 兼任 job/run 记录。

### 3.1 新表：`holder_snapshot_runs`

一行代表一次快照任务（无论来自 trade 还是 6h periodic）。

建议字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | 快照 run id |
| `chain` | TEXT NOT NULL | 先固定 `solana` |
| `token_address` | TEXT NOT NULL | 原始 token 地址 |
| `token_address_lower` | TEXT NOT NULL | Solana 维持原大小写 trim 后值；字段名沿用现有风格 |
| `token_symbol` | TEXT | 触发时看到的 symbol，允许为空 |
| `tracked_wallet_address` | TEXT NOT NULL | 目标钱包原文 |
| `tracked_wallet_address_lower` | TEXT NOT NULL | 小写归一化 |
| `user_id` | TEXT | 从 tracked_addresses 反查到的 user_id |
| `trigger_type` | TEXT NOT NULL | `trade` / `periodic` / `manual` |
| `trigger_source` | TEXT NOT NULL | `telegram_monitor_tx_states` / `current_holdings` / `manual` |
| `trade_action` | TEXT | `buy` / `sell`，仅 trade 触发有值 |
| `tx_hash` | TEXT | 交易哈希，仅 trade 触发有值 |
| `tx_hash_lower` | TEXT | 归一化 tx hash |
| `trade_time_ms` | INTEGER | 交易发生时间 |
| `holdings_refreshed_at` | INTEGER | periodic 触发时，对应 `current_holdings.refreshed_at` |
| `period_bucket_start_ms` | INTEGER | 6h bucket 起点，periodic 去重用 |
| `dedupe_key` | TEXT NOT NULL UNIQUE | 统一去重键 |
| `status` | TEXT NOT NULL | `queued` / `running` / `completed` / `failed` / `skipped` |
| `attempt_count` | INTEGER NOT NULL DEFAULT 0 | 重试次数 |
| `holder_count` | INTEGER | 实际写入 holder 数 |
| `error` | TEXT | 错误摘要 |
| `meta_json` | TEXT NOT NULL DEFAULT '{}' | 命令耗时、gmgn shape、补充信息 |
| `requested_at` | INTEGER NOT NULL | 入队时间 |
| `started_at` | INTEGER | 开始抓取时间 |
| `completed_at` | INTEGER | 完成时间 |
| `updated_at` | INTEGER NOT NULL | 更新时间 |

建议索引：

- `UNIQUE(dedupe_key)`
- `INDEX idx_holder_snapshot_runs_status_requested(status, requested_at)`
- `INDEX idx_holder_snapshot_runs_wallet_time(tracked_wallet_address_lower, requested_at DESC)`
- `INDEX idx_holder_snapshot_runs_token_time(chain, token_address_lower, requested_at DESC)`
- `INDEX idx_holder_snapshot_runs_trade_tx(chain, tracked_wallet_address_lower, tx_hash_lower)`

### 3.2 新表：`holder_snapshot_holders`

一行代表某次 snapshot 中的一个 holder。

**不要把 63 个字段全部铺平成列。**
推荐做法：

- 把 **后续确定会查** 的字段结构化
- 其余完整保存在 `raw_json`

建议字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | 子表主键 |
| `snapshot_run_id` | INTEGER NOT NULL | FK -> holder_snapshot_runs.id |
| `holder_rank` | INTEGER NOT NULL | 第几名 |
| `address` | TEXT NOT NULL | holder address |
| `account_address` | TEXT | token account 地址 |
| `addr_type` | INTEGER | 源字段 |
| `exchange` | TEXT | 交易所/池标签 |
| `wallet_tag_v2` | TEXT | 例如 TOP1 |
| `name` | TEXT | 名称 |
| `twitter_username` | TEXT | 推特名 |
| `balance` | REAL | 持仓数量 |
| `amount_percentage` | REAL | 占供应比例 |
| `usd_value` | REAL | 当前 USD 价值 |
| `cost` | REAL | 成本 |
| `profit` | REAL | 盈利 |
| `avg_cost` | REAL | 平均成本 |
| `realized_profit` | REAL | 已实现利润 |
| `unrealized_profit` | REAL | 未实现利润 |
| `buy_tx_count_cur` | INTEGER | 当前周期买入次数 |
| `sell_tx_count_cur` | INTEGER | 当前周期卖出次数 |
| `is_new` | INTEGER NOT NULL DEFAULT 0 | 布尔转 0/1 |
| `is_suspicious` | INTEGER NOT NULL DEFAULT 0 | 布尔转 0/1 |
| `raw_json` | TEXT NOT NULL | 整行原始 JSON |
| `created_at` | INTEGER NOT NULL | 创建时间 |

建议索引：

- `UNIQUE(snapshot_run_id, holder_rank)`
- `INDEX idx_holder_snapshot_holders_snapshot(snapshot_run_id, holder_rank)`
- `INDEX idx_holder_snapshot_holders_address(address)`
- `INDEX idx_holder_snapshot_holders_twitter(twitter_username)`

### 3.3 app_state 游标

用 `app_state` 存 2 个状态即可，不必再开表：

- `holder_snapshot_trade_cursor_v1`
  - 记录已扫描到的 `telegram_monitor_tx_states.id`
- `holder_snapshot_periodic_cursor_v1`
  - 记录最近已处理的 6h bucket 起点

---

## 4. 触发设计

## 4.1 交易触发（主触发）

### 推荐数据源

`telegram_monitor_tx_states`

原因：

- 新鲜度明显优于 `activity_feed`
- 已经按 `(chain, tracked_wallet_address_lower, tx_hash_lower, token_address_lower)` 做 token-aware 去重
- 行里已经有：
  - `tracked_wallet_address`
  - `token_address`
  - `token_symbol`
  - `provisional_action`
  - `event_time_ms`
  - `canonical_activity_json`
  - `reconciliation_status`

表定义见：
- `lib/server/sqlite.ts:351-396`

写入/更新见：
- `lib/server/telegramMonitorTxStateRepo.ts:514-585`
- `lib/server/telegramMonitorTxStateRepo.ts:596-633`

### 入队条件

扫描条件建议：

- `chain = 'solana'`
- `tracked_wallet_address_lower = 'cj5fhknpf3yd7fknjv5vtbjtndawfirflcutputanpis'`
- `provisional_action IN ('buy', 'sell')`
- `reconciliation_status = 'reconciled'`
- `canonical_activity_json IS NOT NULL`（尽量用已 canonical 的记录）
- `id > trade_cursor.last_id`

### 去重键

交易触发的 `dedupe_key`：

```text
trade|solana|<wallet_lower>|<tx_hash_lower>|<token_address_norm>
```

这样：

- 同一笔交易只快照一次
- 同一 tx 如果涉及不同 token，仍可分别入队
- 用户同一 token 多次买卖，不会被误合并

### 为什么不直接用 activity_feed 做 trade trigger

`activity_feed` 更适合展示和回放，但不适合做 v1 主触发：

1. 当前样本对目标钱包明显不够新
2. 它是更上层的聚合结果，不如 tx state 贴近交易事实
3. 如果 sync/backfill 有延迟，trade snapshot 会晚很多

### 可选补偿（不是 v1 必做）

如果后续发现 `telegram_monitor_tx_states` 仍会漏单，可再加一条“补偿扫描”：

- 从 `activity_feed` 或 `activity_judgments` 扫同钱包 buy/sell
- 如果该 `(tx_hash, token)` 还没有 `holder_snapshot_runs`，则补入队

**建议先不上**，等 v1 跑一段时间观察漏单率。

---

## 4.2 每 6 小时周期触发

### 数据源

`current_holdings`

理由：

- 这是 Pili 已经维护好的“当前持仓表”
- 已过滤掉小额持仓和低流动性垃圾币
- 用户详情和现有持仓逻辑都已经依赖它

相关实现：
- `lib/server/holdingsRefreshRuntime.ts:119-163`
- `lib/server/holdingsRefreshRuntime.ts:191-244`
- `lib/server/userHoldingsDetails.ts:92-201`

### 触发策略

不是新建系统 cron，而是在 holder snapshot runtime task 内部做 bucket 判断：

```text
bucketStart = floor(nowMs / 21600000) * 21600000
```

当 `bucketStart > lastPeriodicBucketStart` 时：

1. 从 `current_holdings` 读取目标钱包当前所有 `solana` token
2. 按 `(chain, token_address_lower)` 去重
3. 给每个 token 入队一条 `trigger_type='periodic'`

periodic 的 `dedupe_key`：

```text
periodic|solana|<wallet_lower>|<token_address_norm>|<bucket_start_ms>
```

这样可保证：

- 同一 token 每个 6h bucket 只抓一次
- task 重启/手动 run 不会重复插入

### 周期 trigger 的范围

v1 只处理：

- `tracked_address = CJ5fHkNPf3yd7fKnjv5VtBJTNDAWFiRfLCutpuTAnpis`
- `chain = 'solana'`

不默认扩展到所有 tracked wallet，避免意外放大调用量。

---

## 5. 采集与落库逻辑

## 5.1 collector 处理流程

每次 cycle：

1. 先扫 trade trigger，补充 `queued` run
2. 再检查 periodic 6h bucket，补充 `queued` run
3. 领取最早的一条 `queued` run
4. 调 `gmgn-cli token holders --chain sol --address <token> --limit 100 --raw`
5. 解析 payload，写 `holder_snapshot_runs + holder_snapshot_holders`
6. 如果队列还有 backlog，下一轮尽快继续

### 为什么建议“每轮最多处理 1 个 snapshot”

因为 gmgn-cli 已知要限速，且是外部命令。v1 用“慢一点但稳”的策略更合适：

- 单次 cycle 只处理 1 个 run
- 成功后 sleep 700ms~1000ms
- 没 backlog 时 idle sleep 60s

### 命令调用方式

推荐用 Node/Bun 的 `execFile` / `spawn` 调：

```text
/Users/xp/.nvm/versions/node/v24.11.1/bin/gmgn-cli token holders --chain sol --address <token> --limit 100 --raw
```

不要依赖 PATH 猜测。

### 解析规则

```ts
const payload = JSON.parse(stdout)
const holders = payload?.data?.list ?? payload?.list ?? []
```

写入时要做：

- `Array.isArray(holders)` 校验
- 不足 100 条也允许写入
- 排名优先取源字段 `rank`，没有就 fallback `index + 1`

### 失败处理

`holder_snapshot_runs.status`：

- `queued` → `running` → `completed`
- 调用失败 / JSON parse 失败 → `failed`

`failed` 时记录：

- `attempt_count += 1`
- `error`
- `meta_json` 里写 stdout/stderr 摘要、exit code、耗时

v1 不建议自动无限重试。最多做：

- 后台 task 对 `failed AND attempt_count < 3` 的记录做指数退避重试
- 或者先不自动重试，仅保留手动触发能力

我更推荐 **v1 先不上自动重试**，逻辑更清楚。

### 落库事务边界

一次 snapshot 写库应在一个事务里完成：

1. 更新 `holder_snapshot_runs` 为 `running`
2. 成功抓到后：
   - 清掉该 run 旧的 holder rows（为 retry/重复执行预留）
   - 插入新的 100 条 holder rows
   - 更新 run 为 `completed`

失败则只更新 run 状态，不写 child rows。

---

## 6. runtime task 设计

### 6.1 建议新增一个 task，而不是改 holdings-refresh

新增任务：

- key: `holder-snapshot`
- label: `Holder Snapshot`

放到默认任务里注册，和现有 `holdings-refresh` 并列。位置：

- `server/runtime-tasks/defaults.ts`

原因：

- holder snapshot 与 holdings refresh 关注点不同
- 保持独立状态更好排查
- 可以单独手动 run

### 6.2 task cycle 建议

伪流程：

```text
runHolderSnapshotCycle()
  -> ensure schema
  -> scanNewTradeEventsAndQueueRuns()
  -> maybeQueuePeriodicRunsForCurrentBucket()
  -> processOneQueuedRun()
  -> return { sleepMs, status, detail }
```

### 6.3 sleep 策略

建议：

- 有 backlog：`sleepMs = 1000`
- 没 backlog：`sleepMs = 60000`
- 如果本轮刚完成 periodic enqueue，且 backlog > 0，继续 1000ms

这样 trade 触发延迟约 0~60 秒，可接受；同时不会一直空转。

### 6.4 手动运维入口

已有 runtime API 足够：

- `POST /api/runtime/tasks/holder-snapshot/run`

不必再发明新命令接口。

如果需要 CLI，可额外加一个薄脚本：

- `scripts/run-holder-snapshot-task.ts`

但不是必须。

---

## 7. 查询接口（供复盘分析）

v1 推荐先做 **repo + API**，不急着上 UI。

### 7.1 Repo 层建议函数

新文件：`lib/server/holderSnapshotRepo.ts`

建议提供：

- `ensureHolderSnapshotTables(db?)`
- `queueTradeTriggeredHolderSnapshots(...)`
- `queuePeriodicHolderSnapshots(...)`
- `claimNextQueuedHolderSnapshotRun(...)`
- `completeHolderSnapshotRun(...)`
- `failHolderSnapshotRun(...)`
- `listHolderSnapshotRuns(filters)`
- `getHolderSnapshotRunById(id)`
- `listHolderSnapshotHolders(runId)`
- `listLatestHolderSnapshotsForToken(tokenAddress, limit)`
- `listHolderSnapshotsAroundTrade({ wallet, tokenAddress, txHash })`

### 7.2 API 层建议

#### A. `GET /api/holder-snapshots`

查询快照列表。

建议参数：

- `wallet=`
- `token=`
- `triggerType=`
- `status=`
- `limit=`

返回每次 run 的摘要：

- token
- symbol
- triggerType
- tradeAction
- txHash
- requestedAt
- completedAt
- holderCount

#### B. `GET /api/holder-snapshots/:id`

返回单次 snapshot 明细：

- run 基本信息
- top100 holder rows

#### C. `GET /api/holder-snapshots/compare`

对比两次 snapshot。

参数示例：

- `leftRunId=`
- `rightRunId=`

返回：

- 新进 holder
- 退出 holder
- 持仓占比变化最大的 holder
- 已命名/带 twitter 的 holder 变化

**这个 compare API 可以放到 v1.1**，不是首发必须。

### 7.3 复盘最有用的 SQL 视角

至少要支持这些问题：

1. **我买入时 top holders 是谁？**
2. **我卖出时，那批人还在不在？**
3. **买入时前 10 大里面有多少是 smart money / 有 twitter / 有标签？**
4. **大户成本 (`cost` / `avg_cost`) 在我买入时是高还是低？**
5. **同一 token 在我多次加仓/减仓时，holder 结构怎么变？**

因此结构化字段里，`address / amount_percentage / cost / profit / name / twitter_username / wallet_tag_v2 / raw_json` 都值得保留。

---

## 8. 文件改动计划

## 8.1 修改

### `lib/server/sqlite.ts`

新增 schema：

- `holder_snapshot_runs`
- `holder_snapshot_holders`

如果沿用项目当前风格，也可以：

- 在 `SCHEMA_SQL` 里直接建表
- 再加少量 `ensureColumn(...)` 兼容未来字段演进

### `server/runtime-tasks/defaults.ts`

注册新的默认任务：

- `holder-snapshot`

### `server/runtime-context.ts`

通常无需改逻辑；只要 defaults 注册了新 task，这里会自动接入。

### `package.json`

可选新增脚本：

- `holder-snapshots:stats`
- `holder-snapshots:backfill`（如果后续要做）

v1 不是必须。

## 8.2 新增

### `lib/server/holderSnapshotRepo.ts`

负责：

- 表初始化
- run 入队/领取/完成/失败
- holder rows 插入
- 查询接口
- app_state cursor 读写

### `lib/server/holderSnapshotRuntime.ts`

负责：

- 扫 `telegram_monitor_tx_states` 新 trade
- 扫 6h periodic bucket
- 调 gmgn-cli
- 解析 stdout
- 调 repo 落库
- 返回 runtime task 的 `sleepMs/status/detail`

### `app/api/holder-snapshots/route.ts`

列表查询 API。

### `app/api/holder-snapshots/[id]/route.ts`

单次详情 API。

### `scripts/test-holder-snapshot-repo.ts`

验证：

- schema
- dedupe_key
- periodic bucket 去重
- trade trigger 去重

### `scripts/test-holder-snapshot-runtime.ts`

验证：

- trade cursor 扫描
- periodic enqueue
- payload 兼容 `data.list` / `list`
- collector 成功 / 失败状态迁移

### `docs/holder-snapshot-plan.md`

本文件。

---

## 9. 关键实现细节建议

## 9.1 token address 规范化

Solana 现有代码里很多地方是“保留原大小写，但在 lower 字段里也写原值/trim 后值”。

holder snapshot 里建议保持和 `current_holdings` 一致的心智模型：

- `token_address`：原文 trim 后
- `token_address_lower`：Solana 直接存 trim 后原值（不是 `.toLowerCase()`）

原因：

- Sol 地址大小写敏感于展示
- 现有 `current_holdings` 对 Solana 就没有强制 lowercasing
  - `lib/server/holdingsRefreshRuntime.ts:392-394`

### 9.2 wallet 范围不要“顺手泛化”

v1 明确只做这一个钱包：

- `CJ5fHkNPf3yd7fKnjv5VtBJTNDAWFiRfLCutpuTAnpis`

实现上可以：

- 在 runtime 模块里定义 `const HOLDER_SNAPSHOT_TARGET_WALLET = '...'`
- 然后用 `tracked_addresses` 反查 `user_id`

不要一开始做成“所有 tracked solana wallet 自动抓”，否则调用量和噪音都会放大。

### 9.3 status/detail 对外可观测性

runtime task 的 `detail` 建议带：

- `queuedRunCount`
- `lastQueuedTradeId`
- `lastPeriodicBucketStartMs`
- `lastProcessedRunId`
- `lastError`

这样 `/api/runtime/status` 就能直接看 holder snapshot worker 在干什么。

### 9.4 数据量评估

按需求给的估算：

- 单个 holder 约 1878 bytes 原始数据
- 100 holders ≈ 188 KB / snapshot 原始体量

如果每天抓几十次，SQLite 增长是可接受的，但要注意：

- 不要再额外存整份 response_json + 每行 raw_json 双份大对象
- 推荐只存：
  - run 级 `meta_json`
  - row 级 `raw_json`

这样既保留原始信息，又避免重复膨胀。

---

## 10. 推荐实施顺序

### Phase 1：存储与 repo

1. 在 `lib/server/sqlite.ts` 加新表
2. 新建 `lib/server/holderSnapshotRepo.ts`
3. 跑 repo 层测试，确认：
   - trade dedupe
   - periodic dedupe
   - holder rows 插入/查询

### Phase 2：runtime worker

1. 新建 `lib/server/holderSnapshotRuntime.ts`
2. 实现：
   - trade scan
   - periodic scan
   - claim/process queued run
3. 在 `server/runtime-tasks/defaults.ts` 注册 `holder-snapshot`
4. 跑 runtime 测试，mock gmgn-cli

### Phase 3：API / 复盘接口

1. `GET /api/holder-snapshots`
2. `GET /api/holder-snapshots/:id`
3. 先满足查询，暂不上 UI

### Phase 4：实盘验证

1. 手动对当前 2 个持仓 token 触发 periodic snapshot
2. 手动造一个 trade-triggered queued run
3. 检查：
   - queued → completed 是否正确
   - top100 是否入库
   - API 是否能读出来
   - `/api/runtime/status` 是否可观测

---

## 11. 这版方案的核心取舍

### 选型结论

#### 交易触发源

- **选**：`telegram_monitor_tx_states`
- **不选**：`raw_transactions`
- **暂不选**：`activity_feed` 作为主触发

#### 周期触发源

- **选**：`current_holdings`
- **方式**：holder snapshot task 自己做 6h bucket
- **不依赖**：不存在/未发现的外部 6h cron

#### 存储模型

- **选**：`runs + holders` 双表
- **不选**：单表全铺平 63 列
- **不选**：新建独立项目/独立数据库

#### 执行模型

- **选**：runtime task + SQLite queue 状态
- **不选**：交易热路径里同步 shell out gmgn-cli

---

## 12. 风险与注意事项

1. **gmgn-cli 输出 shape 漂移**
   - 已观察到 `list` vs `data.list` 不一致
   - parser 必须兼容两种

2. **交易漏触发风险**
   - v1 主依赖 `telegram_monitor_tx_states`
   - 若某些交易不会进入这张表，后续要补二级 detector

3. **current_holdings 刷新频率与 periodic snapshot 频率不同**
   - 当前 holdings 默认 30m 刷一次
   - 6h snapshot 读的是最近一次 holdings 结果，不是链上即时余额
   - 这通常可接受，因为 6h snapshot 的目标是复盘补切片，不是高频风控

4. **Solana 地址规范化**
   - 不要盲目 lowercase token 地址
   - 需跟现有 Solana 处理方式保持一致

---

## 13. 最终建议

按 Pili 当前代码形态，**最稳的落地方式** 是：

- 新增一个 `holder-snapshot` runtime task
- 用 `telegram_monitor_tx_states` 做 trade trigger
- 用 `current_holdings` 做 6h periodic trigger
- 用 `holder_snapshot_runs` 做入队/去重/状态管理
- 用 `holder_snapshot_holders` 存 top100 明细
- 先做 repo + runtime + API，不急着做 UI

这样改动范围集中、和现有 Pili 架构一致、可观测性也最好。
