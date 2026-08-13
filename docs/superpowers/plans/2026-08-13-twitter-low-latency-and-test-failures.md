# Goal 计划：Twitter 低延迟改造 + Test failures 排查（2026-08-13）

> 新会话执行用。预算 5,000,000 token。本会话（延迟优化主任务）已交付并提交 `df9ecc0`；剩余未完成工作如下。

## Objective

1. **Twitter 信息源端到端延迟 ≤ 10s 硬上限**（tweet 发布时间 → pili 页面 DOM 渲染，每次探针单次 ≤10s，非平均/P95）。
2. **排查并修复 32 个 pre-existing test failures**（`npm test` 当前 32 失败，用户已确认安排排查）。

用户已决策（本会话 ask）：**Twitter 直接做流式/webhook 改造**，不接受仅参数缓解（下调轮询间隔算「先参数缓解」，已否决）。

## Success criteria

- Twitter 每条 tweet 从发布时间到页面渲染 ≤ 10s，用真实 headed Chrome 探针逐次验证（探针注入器 `scripts/latency-probe-inject.ts`，DB 延迟口径 `events.created_at - timestamp`）。
- `npm run build` 通过、`npm test` 失败数从 32 降到可解释的最小集合（每个剩余失败有归类说明）、`runtime:refresh` 生产替换 + 页面正常（当前基线「119 人·1487 地址·223xxx 动态」）。
- 不破坏 blockchain（已达标 p50 2.1s）与 Telegram（已达标 live ~2.4s）既有优化。

## Verification

- 探针：`NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' ./node_modules/.bin/tsx scripts/latency-probe-inject.ts <tag>`；真实 Chrome（flags `--disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding`）页面内 MutationObserver 记 `window.__probeRenders[tag]`；**headless 定时器节流伪影不可信，一律 headed**。
- 延迟 DB 查询：`SELECT (created_at - timestamp), timestamp FROM events WHERE source='twitter' AND timestamp > ? AND timestamp < created_at ORDER BY created_at DESC`（events 无 posted_at 列，用 timestamp）。
- 逐源验证：twitter（本目标）+ blockchain/telegram 回归确认。

## Boundaries

- Node 24.11.1；PM2 进程：`pili-web-prod`(3013)、`pili-background-worker`、`pili-telegram-bridge`（Bot API + **twitter sync fallback owner**）、`pili-telegram-channel-worker`（MTProto live）、`pili-public-feed`(3014)。
- 禁止破坏性 DB schema / 删用户数据 / 破坏 `.env.local`；重依赖与过度工程化禁止（个人工具，保持轻量）。
- 涉及付费服务（Twitter 官方 API 企业套餐）先停下问用户。
- **不碰既有未提交工作**：`lib/okx.ts`、`lib/server/twitterFetcher.ts`、`lib/server/telegramBotApi.ts`、`scripts/telegram-bridge.ts`、`scripts/lib/workerLifecycle.ts`、`scripts/remove-daqi-bad-addresses.ts`、`.agents/skills/using-superpowers/` 删除、`docs/superpowers/plans/2026-08-11-event-driven-holdings-freshness.md`。
- 项目规则：禁 `ReturnType<typeof fn>` 发布契约（导出具名类型）；禁单表达式小函数（测试 seam/DI 边界除外）；禁 `import("pkg").Type` 内联；禁运行期动态 `import()` 绕静态导入。

## 任务清单（新会话 init 用）

### Phase 1: Twitter 现状调查（先做，快）
- [ ] 读 `lib/server/twitterProviderRouter.ts`：provider 选择逻辑（xread? bearer? noop? 结构 provider 列表），`.env.local` 无 TWITTER_BEARER_TOKEN（注释）
- [ ] 量化：tracked_users 中 twitter 用户数（列 `twitter`）、`twitter_sync_cursor` 用户数/新鲜度分布、`twitter_provider_budget` 限流预算、`twitter_sync_runs` 最近运行耗时/覆盖
- [ ] relay 覆盖率：`scripts/telegram-bridge.ts` 的 relay 路径（doorbell 2s → `ingestTwitterRelayPayload`）；设计文档 `docs/superpowers/plans/2026-04-30-twitter-relay-aware-6551-polling-design.md`
- [ ] 实测当前 twitter 延迟分布（DB 查询）+ 一次 sync run 日志（`[telegram-bridge] twitter-sync fallback` 行）

### Phase 2: 设计低延迟方案
- [ ] 关键候选：Twitter 官方无低成本 webhook（Account Activity API 企业付费）→ 现实路径三选一/组合：
  a) relay 主路径 + 高频兜底轮询（covered 360min → 大幅下调，断线降级）
  b) uncovered 5min → 15-30s + 用户级增量（watermark 已有）
  c) 6551/自有流式管道（若有可用 API）
- [ ] 限流预算核算（用户数 × 频率 vs provider budget）——**限流是最大风险**，先算账再动手
- [ ] 写方案到本文件下方「方案定稿」区

### Phase 3: 实施
- [ ] 按方案改 `systemConfigRepo` 默认间隔 / `twitterSyncService.shouldSkipAutomaticTwitterUserSync` / `scripts/telegram-bridge.ts` 触发频率
- [ ] build + 单元测试（twitter-sync-service 相关）

### Phase 4: 验证
- [ ] 受控测试：向追踪 twitter 用户注入带已知时间戳的 tweet（或探针注入器），真实 Chrome 测渲染 ≤10s
- [ ] DB 延迟分布确认 + blockchain/telegram 回归
- [ ] `npm run build` + `npm test` + `runtime:refresh` + 页面确认

### Phase 5: Test failures 排查
- [ ] `npm test > /tmp/test-out.txt` 重跑，提取 32 个失败名（`grep -E "  ✗ "`）
- [ ] 逐一定位根因（多数是超时/环境依赖/顺序敏感？），修复或归类
- [ ] 收尾：git 提交（只提交本会话相关改动）

## 关键上下文（陷阱与事实）

- **Twitter 延迟根因（已定位）**：`twitterSyncService.ts` `shouldSkipAutomaticTwitterUserSync` 按 freshness 跳过；`systemConfigRepo.ts` 默认 `DEFAULT_TWITTER_RELAY_COVERED_POLLING_INTERVAL_MINUTES=360`、`DEFAULT_TWITTER_UNCOVERED_POLLING_INTERVAL_MINUTES=5`；当前 app_state 无 system_config 行（用默认）。p50≈378s 是 uncovered 5min 轮询的结果；covered 用户理论延迟 6h（靠 relay 兜底）。
- **twitter sync 触发**：`scripts/telegram-bridge.ts` `startTwitterSyncFallback`（`TWITTER_SYNC_INTERVAL_MS` 默认 60s、floor 15s）+ `app/api/feed/route.ts` 响应性触发（POST/PATCH 时）+ `lib/server/completenessMaintenanceWorkerRuntime.ts`（background worker）。
- **DB**：只读 `file:.data/web3-feed.sqlite?mode=ro`；写入必须 `pragma busy_timeout=10000`（会撞 SQLITE_BUSY）；4+ 写进程竞争是 pre-existing 架构特性（`lib/server/sqlite.ts` busy_timeout 8s + `withSqliteBusyRetry` 指数退避 + `getFastFailWriteDb` 心跳专用），改连接策略有冻结事件循环风险（`syncService.ts` 686 行注释），非必要不动。
- **已完成的延迟优化（勿回归）**：`PILI_LIVE_CYCLE_MS=5000`（blockchain）；Telegram MTProto live（`telegramChannelLive.ts` 常驻 client + updates 长连接，`TELEGRAM_CHANNEL_SYNC_INTERVAL_MS=10000` 兜底并行 3）；`refreshLatestActivityCache` DISTINCT 前缀索引 + SWR 异步刷新；渲染侧真实 Chrome 实测 156–4443ms。
- **.env.local 关键值**：`TELEGRAM_MTPROTO_PROXY=socks5://127.0.0.1:7897`、`PILI_LIVE_CYCLE_MS=5000`、`TELEGRAM_CHANNEL_SYNC_INTERVAL_MS=10000`；`TWITTER_BEARER_TOKEN` 未配置（注释）。
- **PM2 操作**：`pm2 restart pili-telegram-bridge`（twitter sync fallback owner，改脚本后必须重启才生效）；`npm run runtime:refresh` 只换 web 进程。
- **前端轮询**：主页面 5s snapshot polling（硬编码）+ 失败指数退避；`.env.local` `POLLING_INTERVAL=30000` 与硬编码不一致（作用域未确认，非当前目标，勿顺手改）。

## 方案定稿（2026-08-13 新会话调查后定稿）

### 现状量化（Phase 1 实测，非推断）

- **86 个 tracked twitter 用户**（119 总用户）；`twitter_sync_cursor` 172 行 / 86 用户，最近成功 13:53 今日。
- **Relay（streaming）覆盖 20 个 handle**（bot2bot provider，外部监控 bot `xymemebot`/xxyybot 群 -5299035575 推送，展示别名如 Ansem=blknoiz06、Him=himgajria）。7 天活跃：blknoiz06(26)、noteezzy(8)、himgajria(7)、traderpow(6)…；今日仅 blknoiz06/neso 有投递。**66 个 tracked handle 无 relay 覆盖（其中 46 个近 7 天活跃）**。
- **Relay 路径实测 0–1s**（tweet 发布→pili 入库），含一次 89s 异常（监控端自身检测慢）。前端 5s snapshot polling + 渲染 0.2–4s → **relay 覆盖用户端到端 ≤10s 已达标**。
- **轮询路径实测 65s–45min**：sync pass 顺序遍历 86 用户 × 2 lanes（timeline+replies）+ backfill + projection，**单次成功 pass 532–745s（~10min）**；revisit 受 pass 时长约束，5min 名义间隔形同虚设；`database is locked` 间歇性整批失败（busy_timeout 8s，4+ 写进程竞争）。
- **Provider/限流**：6551 4 个 key 今日全部 cooldown（`twitter_6551_http_404`×2、`http_402`×2，daily_limit=100）→ **6551 死**；xread 可用（`65.109.123.54/consumer`，自建 scraper，pili 侧无预算表），当前 ~172 calls/pass ≈ **2.75k calls/day 稳定包络**；noop 兜底。

### 方案（三改，全部本仓库内）

1. **Relay 覆盖时效化**（streaming 主路径加固）：`RELAY_COVERAGE_STALE_MS = 30min`。`runSyncAction` 中 `relayCovered` 需 bot2bot `latestLastSeenAtMs` 在 30min 内，否则视为失联 → 按 uncovered 间隔轮询。修复「covered 用户 relay 静默后仍锁 360min 兜底 → 数小时延迟」陷阱。relay 活跃时维持 360min 兜底 + 0–1s streaming。
2. **Sync pass 并行化**（结构改造）：`SYNC_USER_CONCURRENCY = 6`，用户级并发（lanes 仍串行）。pass ~10min → ~2min，轮询延迟从 pass-duration-bound 变 interval-bound。
3. **Uncovered 间隔 5min → 3min**（systemConfigRepo 默认值；DB 无行，走默认）。配合并行化 → 轮询延迟 ≤ ~3–4min（现状 10–25min，5–8x 改善）。

### 限流预算核算

- **xread 速率**：66 uncovered × 2 lanes / 180s ≈ **0.73 req/s 持续 ≈ 2.5x 实测安全包络**（2.75k→~6.5k calls/day）。可接受。
- **15–30s 目标不可行**：66×2/30s ≈ 4.4 req/s、/15s ≈ 8.8 req/s，远超 scraper session 承受（实测安全包络 ~0.3 req/s 量级），会触发 Twitter 限流/封 session。**硬上限 ≤10s 对全部 86 用户唯一现实路径 = 外部监控 watch list 扩容**（把 66 个 handle 加入 xymemebot/6551 监控关注列表）——pili 侧 streaming 管道已就绪（`app/api/twitter/relay/route.ts` webhook + Telegram relay ingest 同一函数，实测 0–1s），此为外部配置，需用户操作（见最终报告）。

### SLA 声明（诚实）

- **Relay-covered（20）**：≤10s 达标，探针验证 ingest→render。
- **Uncovered（66，46 活跃）**：≤ ~4min（改造后），从 10–25min 降 5–8x；真 ≤10s 需监控覆盖扩容（外部）。
- 验证手段：探针注入器（渲染侧）+ `events.created_at - timestamp`（DB 侧）+ blockchain/telegram 回归。

### 测试影响

- `test-twitter-sync-service.ts`：`testRelayCoveredUserSkipsUntilCoveredIntervalElapsed`（relay 30min 旧 = 恰好边界）需改为「新鲜 relay → skip；陈旧 relay → 按 uncovered 间隔 fetch」，并新增陈旧 relay 用例。

## Phase 5 结果（2026-08-13 新会话）：32 → 10 failures

### 已修复（22 个，提交 `……`）

1. **测试库 schema 缺口（12 个）**：`current_holdings.liquidity_usd` 只由运行时 ALTER 添加，SCHEMA_SQL 缺失 → 新建测试库 `listTrackedUsers` 抛 `no such column`。修复：`lib/server/sqlite.ts` SCHEMA_SQL 的 `current_holdings` CREATE TABLE 补列（运行时 ALTER 已 try/catch 幂等）。波及：activity-importance-backfill/ingest、address-management-repo、addresses-api、asset-peak-audit、bid-users-api、user-details-route、twitter-enrichment/relay-coverage 等。
2. **trackedUsersCache 10s TTL 写后不失效（4 个）**：`invalidateTrackedUsersCache` 导出但从未调用；创建/更新/删除后同窗口读到旧列表（PATCH 404、改名不回显、删地址后列表残留）。修复：`lib/server/trackedUsersRepo.ts` 全部写路径（create/update/delete/add/remove/import）失效缓存；`updateTrackedUser`/`addTrackedAddresses` 写后重读前二次失效；`feishuEnablementSync` 直接 SQL 写后统一失效。波及：bid-sync-route-triggers、twitter-stable-identity、feishu-enablement-sync（+测试内 stamped 实例主动失效）。
3. **events-feed-total（1 个）**：cursor 页 total 断言是旧契约；代码有意跳过 cursor COUNT（perf，`total=feed.length` + hasMore）。更新测试断言匹配该契约。
4. **time-format（1 个）**：`1c40141` 有意让 usd 模式在 USD 缺失时回退 native 金额（keep xxyy amounts），测试未同步。更新断言。
5. **twitter-linked-ingest（1 个）**：fixture 先天缺陷——`trackedWalletAddress` 只从 xxyy.io 链接 `?wallet=` 解析，消息从未含该链接 → 永远 unknown-tracked-user。补 View 按钮链接。
6. **manage-users（1 个）**：store 归一化把 `historicalMaxAssetUsd` 重置为当前总额（删地址后峰值清零）。修复 `applyUserUpdates`/`applyAddressCollectionUpdate` 保留峰值。
7. **运行时文档（3 个）**：AGENTS.md 加 `<!-- BEGIN:runtime-rules -->` 块 + worker 不默认重启句；README 加 `## Runtime Setup`/`## Getting Started`（契约文案）；test-runtime-mode 的 channel-worker 断言更新为现行生产拓扑（MTProto worker 是 pm2 应用）。

### 剩余 10 个（归类，全部指向用户未提交/半成品工作）

| 测试 | 归类 |
|---|---|
| asset-peak-validation | 用户工作树已改此测试（git diff：OKX Connection:close 断言）→ 未完成 |
| bun-holdings-refresh、historical-peak-repair、tracked-user-assets | peaks/holdings 簇：`validateAndPersistPeakAssetSnapshots` 语义（$5 流动性、峰值降级）与 `lib/okx.ts` 未提交改造同域 |
| user-bar、selected-user-details-panel | 侧边栏改造半成品：`User.mainstreamAssetUsd` 已提交但构造点未接（tsc 110 错），UserBar 仍渲染当前总额 |
| parser-fixtures、parser-fixtures-isolation | `8af1511` snapshot 提交的 fixture 期望 vs 后续 judgment 管道重构（0 judgments） |
| telegram-channel-provider、telegram-mtproto-upgrades | telegram 通道域：`telegramBotApi.ts`/`telegram-bridge.ts` 工作树未提交改造同域 |

> 边界遵守：未触碰计划列出的未提交文件（okx.ts/twitterFetcher.ts/telegramBotApi.ts/telegram-bridge.ts/workerLifecycle.ts/remove-daqi…）。tsc 110 错为 HEAD 既有（mainstreamAssetUsd 半成品），非本会话引入。

## 参考

- 已提交 `df9ecc0`（本会话延迟优化：feed 渲染 + Telegram 即时化 + 探针工具）
- 探针工具：`scripts/latency-probe-inject.ts`（events 表插入 + bump revision，`ingest_source='latency-probe'`，用完删：`DELETE FROM events WHERE ingest_source='latency-probe'`）
- twitter 相关测试：`npm run test:twitter-sync-service`、`test:twitter-provider-router`、`test:twitter-relay-coverage`
