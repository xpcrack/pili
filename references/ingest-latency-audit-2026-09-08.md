# 通知延迟全链路审计与吞吐修复（2026-09-09）

## 问题
用户发现「同车交易提醒」从链上成交到 Bark 收到延迟 1-3h+（案例：0xed2a…d1
ENCORE 20:18:35 成交 → 22:23 bridge 落库；8U $SOCK 21:07:16 成交 → 22:56 落库）。

## 审计工具
`scripts/oneoff/latency-audit-2026-09-08.ts`（只读，跑两个库）：
- pili `telegram_monitor_events`: `event_time_ms`(TG 消息时间) → `created_at`(落库) = **入桥延迟**
- newone `events`: `occurred_at` → `created_at`（注意：occurred_at≈created_at，混 ISO UTC 与本地时间文本格式）
- newone `alerts`: 事件 → Bark 投递

## 延迟画像（审计实测）

### 按天（入桥延迟）
| 日期 | n | avg | max | 模式 |
|---|---|---|---|---|
| 09-09 | 289 | 27min | 1.14h | backlog 消化期（昨夜断流余波） |
| 09-08 | 4106 | 62min | 3.13h | **断流 2h+**（Clash 7897 隧道挂） |
| 09-07 | 4667 | **3.10h** | 5.86h | 断流/消化混合 |
| 09-06 | 5079 | 10min | 1.12h | 稳态仍偏高 |
| 09-05 | 3963 | 8min | 51min | 稳态仍偏高 |
| 09-02 | 5116 | 7min | 1.70h | 稳态 |
| 08-30 | 2893 | **44s** | 23min | **健康基线** |
| 08-29 | 3251 | 102s | 22min | 健康 |

**近 14 天全体：p50=2.0m，p90=2.11h，p99=5.49h** —— 约 10% 事件延迟 >2h。

### 三种模式（近 24h 逐小时）
- **正常期**：avg 3-30s（09-08 13:00-18:00 多个 10min 桶）
- **断流期**：avg 1-2h（09-08 19:00-23:00，getUpdates 隧道级断流）
- **消化期**：avg 27-40min（重启后 backlog 串行追赶）

## 根因（按贡献排序）

### 1. pili-telegram-bridge 消化吞吐不足（结构性，主因）
主循环 `for (update of updates) { await processUpdate(update) }` 串行，
每条含 projection + sqlite 写（cursor/lease/status 每条 2-3 次写）。
实测稳态消化 ~5-6 条/min；xxyy 群高峰生产 ~6 条/min+。
→ **高峰期消化速率 ≈ 生产速率，任何抖动（网络、GMGN 富化慢、sqlite busy）
都变成积压，且积压永不追平**。昨夜 backlog ~500 条，40min 才消化完。

### 2. Clash 7897 隧道偶发断流（已在 5c34cec 修复告警+代理池）
- 09-08 19:00-22:23 断流 2h+，bridge 只是静默重试，无告警。
- 已加：代理池 failover（`TELEGRAM_BOT_API_PROXY_POOL=7897,17890,17891`）
  + 连续 5 次 getUpdates 失败 Bark。

### 3. GMGN wallet_activity 拉取延迟（另一路径，独立问题）
8U $SOCK 那笔在 newone 侧的 raw_observations（provider=gmgn）gap 3h8min，
与 bridge 无关——GMGN 活动拉取被冷却/调度卡住。诊断归入 open questions
（不动 GMGN 限速架构）。

## 修复（本 commit）

### 吞吐：批内并发 ingest（`scripts/telegram-bridge.ts`）
- worker 池并发，`TELEGRAM_INGEST_CONCURRENCY` 配置（默认 3）
- offset/cursor **批级提交**：一批只写 1 次 cursor + 1 次 status + 1 次 poke
  （原来每条 2-3 次写），sqlite 写放大降 ~70%
- offset 取本批 `max(update_id)+1`，Telegram 语义允许整批确认
- 单条失败仍不卡批（保留 8/12 死锁教训）

### 告警：lag watchdog（同文件）
- 每批采样「TG 消息时间 → 处理时间」平均 lag（`message.date`）
- 连续 `TELEGRAM_LAG_ALERT_BATCHES`(默认3) 批 avg lag ≥
  `TELEGRAM_LAG_ALERT_SEC`(默认300s=5min) → Bark「⚠️ pili TG 通道积压」
- 30min REALERT 节流；低滞后批清零计数
- 测试：`scripts/test-telegram-bridge-lag-watchdog.ts`（6 个断言场景）

## 验证
- `npx tsx scripts/lib/runTests.ts --root=scripts --filter=telegram` → 19 PASS
- lag watchdog 单测 PASS
- 部署后观察：正常期入桥 lag 应 <10s；backlog 消化速率应 >15 条/min（并发3 × 单条~2s）

## Open questions（保守起见未动，留给用户决策）
1. **并发上限与 sqlite 写冲突**：并发 3 时 processUpdate 内部仍可能撞
   busy（`withSqliteBusyRetry` 有 3 次重试兜底）。若日志出现大量 busy
   retry，降到 2 或改批量写。观察指标：`[bridge] update N failed` 频率。
2. **GMGN wallet_activity 拉取延迟**（3h8min 案例）：是 newone worker 的
   self fast lane/全量扫描被 GMGN 冷却卡住，还是 backfill 排队？需要独立
   审计（`~/.config/gmgn/request-events.jsonl` 13:07-16:15 UTC 窗口有
   201 ok / 40 network err / 2 banned——网络抖动+限速叠加）。不建议动
   GMGN 限速参数，建议给 newone 侧也加「ingest 落后 >5min」Bark 告警。
3. **稳态 avg 8-10min 的日子（09-05/06）**：比健康基线（08-30 的 44s）
   高一个量级但无明显断流，可能是富化 API 慢或消息量增长。持续观察
   watchdog 告警频率再决定。

## 相关
- `references/tg-bridge-outage-2026-09-08.md`（断流复盘）
- `scripts/oneoff/latency-audit-2026-09-08.ts`（审计脚本，可重跑）
