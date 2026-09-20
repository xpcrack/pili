# 余额表（current_holdings）更新策略

> 目标：在「及时性」「准确性」「API 调用次数」三者间取得最优平衡。
> 状态：2026-09-20 起 Robinhood 走 OKX Balance `chainIndex=4663`，并进 EVM 那一次 `all-token-balances-by-address`。GMGN `wallet_holdings` 不再刷新 RH。

---

## 1. 现状与成本账本

### 1.1 API 成本（每钱包×链）

| 数据源 | 链 | 每次成本 | 限流约束 |
|---|---|---|---|
| OKX `all-token-balances-by-address` | bsc / eth / base / **robinhood** / sol | **1 次调用**（EVM 四链可逗号拼接：`1,56,8453,4663`），一次返回全币种余额+价格+价值 | 400ms/次，2 并发（`lib/okx.ts`） |
| GMGN `wallet_activity` | 门铃成交解析 | weight=3 | 全局 1 RPS / burst 3 |
| DexScreener liquidity / 现价 | 含 RH（`chainId=robinhood`） | 批量，独立源 | 无硬限流 |

关键结论：**EVM 钱包（含 Robinhood）每刷新 1 次 OKX 调用。** 持仓不再打 GMGN signed `wallet_holdings`。

### 1.2 现有触发机制

| 触发 | 机制 | 频率 | 每次 API |
|---|---|---|---|
| 事件驱动 | doorbell → `enqueueHoldingsRefresh`，priority 100，去抖 10s | 有成交才触发 | 1 OKX |
| 周期对账 | `seedPersistentQueue` 每 5min 播种，`due = last_success + interval` | 静默 4h | 1 OKX |
| 失败重试 | 指数退避 1min → 30min 封顶，10 次死信 | 按需 | 同源 |

消费者：`holdings-refresh`（native=OKX，EVM 任务覆盖 ETH/BSC/Base/RH）。`holdings-refresh-gmgn` 仍注册但不再认领持仓任务。

用户总额：地址簿链写 `tracked_addresses.total_asset_usd`；RH 不是地址簿链，但 `listTrackedUsers` 的 liveTotal 从 `current_holdings` 汇总时 **RH 免流动性过滤**。

### 1.3 已修痛点

1. **RH 余额/价格陈旧**：旧路径走 GMGN，失败后 RPC 只核 last-known 行 × 旧价。现改 OKX 4663。
2. **RH 不进表头**：liveTotal 以前按 `liquidity_usd>=5k` 丢掉 RH。现 RH 行直接计入。
3. **调度浪费**：RH 独立 GMGN 队列（12h / cooldown / 门铃让路）已并进 EVM OKX 请求，零额外调用。

---

## 2. 目标（量化）

| 维度 | 指标 | 目标值 |
|---|---|---|
| 及时性 | 活跃钱包成交后余额可见 | **< 1s**（预测增量）/ **< 60s**（权威回刷） |
| 准确性 | 任何钱包×链有权威快照兜底 | 活跃 30min / 静默 4h 内必有一次快照 |
| 调用次数 | OKX 日均调用 | 从 ~3.5 万/天 降到 **~5-6k/天**（≈83% ↓） |
| 调用次数 | GMGN 持仓（weight-5） | 从 30min 周期改为**纯事件驱动 + 慢速兜底**，静默 RH 不刷 |

---

## 3. 核心设计：三层新鲜度 + 调用预算

### Tier 0 — 预测增量（0 次 API，<1s）

成交事件到达时（doorbell 已解析出 `tokenAmount` + `action` + `priceUsd`），立即对 `current_holdings` 做**展示层临时修正**：

- buy → `balance += tokenAmount`
- sell / send → `balance -= tokenAmount`（不为负，触底标记疑似漏消息）
- `value_usd = balance × priceUsd`（用成交价即时重估）

**关键约束**：Tier 0 是"预测值"，不是权威。它必须：
- 写入独立的 `predicted` 标记/字段，或写入内存缓存，**永远被下一次快照覆盖冲正**；
- 只在两次快照之间生效，快照到达即归零误差；
- 无法覆盖转入/空投/CEX 代买（事件流看不到），这部分误差靠 Tier 2 兜底。

### Tier 1 — 事件驱动快照（按需 1 次 API，去抖 + 最小间隔）

doorbell 触发 `enqueueHoldingsRefresh`（现有机制），但加两个护栏：

1. **min-age 守卫**：每钱包×链维护 `last_sync_at`，事件入队时 `due_at = max(now + debounce, last_sync_at + MIN_REFRESH_AGE_MS)`。默认 `MIN_REFRESH_AGE_MS = 120s`。把"高频钱包 25s/次"硬性压到"最多 2min/次"。
2. **指数退避突发**：同一钱包在 min-age 窗口内持续来事件，`due_at` 用退避因子（×2，封顶到 interval）延后，而不是固定 120s。

效果：活跃钱包权威余额 < 60s-2min 新鲜，但调用次数被封顶。

### Tier 2 — 周期对账（慢速兜底，自适应间隔）

这是**唯一权威锚点**，保证任何钱包（含门铃漏覆盖的）最终一致：

- **活跃钱包**（近 24h 有成交）：interval 保持 30min。
- **静默钱包**（近 24h 无成交）：interval 放宽到 **4h**。
- 活跃判定信号直接读 `events` / `telegram_monitor_events` 的最近成交时间，零额外 API。

理由：静默钱包余额不变（没成交），4h 内不查也依然准确；只有价格变了，而价格走 Tier 0/展示层重估。门铃覆盖率 ≥98%（`live-vs-xxyy-coverage.md`），2% 漏覆盖的余额最坏 4h 后被周期对账纠正——这是可接受的准确性与调用成本的交换。

### Robinhood

- 不再单独调度。EVM `0x` 钱包的 OKX 请求带 `chains=1,56,8453,4663`。
- 静默间隔与其它 EVM 链相同（4h）。
- GMGN 只保留成交解析（`wallet_activity`），不刷持仓。

---

## 4. 关键机制

### 4.1 最小刷新间隔（min-age 守卫）—— 最大的 API 泄漏堵点

```text
事件入队时：
  due_at = max(now + DEBOUNCE_MS, last_sync_at + MIN_REFRESH_AGE_MS)
```

- 现有 `upsertPersistentJob` 只需在计算 `due_at` 时多取一个 `last_sync_at`。
- 常量：`DEBOUNCE_MS = 10_000`（现状）、`MIN_REFRESH_AGE_MS = 120_000`（新增）。
- 直接效果：单钱包刷新频率硬顶到 30 次/天，高频交易不再线性放大 API。

### 4.2 自适应周期间隔 —— 静默钱包省调用

`seedPersistentQueue`（`holdingsRefreshQueue.ts:330-379`）播种时，按钱包最近成交时间选 interval：

- `last_trade < 24h` → 30min
- `else` → 4h

信号来源：`telegram_monitor_events.event_time_ms`（XXYY 已入库）或 `events` 表最近成交，SQL 一次聚合，零 API。

### 4.3 余额与价格解耦 —— 展示层重估（可选增强）

`current_holdings` 存 `balance`（不变）与 `price_usd / value_usd`（快照时点）。价格是连续变化的，余额只在成交时变。展示层可用顶部 ticker 的实时价重估 `value_usd = balance × live_price`，让**价值**新鲜而**余额**只靠成交驱动。

- 这消除了"为了更新价值而去重拉余额"的隐性浪费。
- 属于展示层改动，不阻塞 Tier 0-2 落地。

### 4.4 失败保护（保持现状，是准确性的生命线）

- 拉取失败 → **保留 last-good bags**，绝不因失败把余额清零（`holdingsRefreshRuntime.ts:1058-1059`）。
- 指数退避重试（现有）。
- Tier 0 的预测值永远可被快照覆盖，不参与"真相"判定。

---

## 5. 调用预算账本（估算）

假设 ~721 个 tracked 地址（OKX 注释口径），其中活跃（日成交）约 5%，Robinhood 少数。

| 项 | 现状 | 备注 |
|---|---|---|
| OKX 周期对账 | 静默 4h / 事件去抖 + min-age | EVM 含 RH，零额外调用 |
| GMGN 持仓 | **0** | RH 已离开 `wallet_holdings` |
| DexScreener | 批量补流动性/现价，含 `chainId=robinhood` | 与 GMGN 配额无关 |

---

## 6. 分阶段落地

### Phase 1 — min-age 守卫（最小改动，最大收益）

- `upsertPersistentJob` 计算 `due_at` 时引入 `last_sync_at + MIN_REFRESH_AGE_MS` 下界。
- 只改 `holdingsRefreshQueue.ts`，不动数据源。
- 验证：构造高频事件流，断言刷新次数封顶。

### Phase 2 — 自适应周期间隔

- `seedPersistentQueue` 按最近成交时间分流 interval（30min / 4h）。
- Robinhood 跟 EVM 地址簿走同一 `evm:` 任务，不再 12h 单独车道。

### Phase 3 — Tier 0 预测增量（可选，提升及时性）

- doorbell/成交路径在 enqueue 之外，额外写一层 `predicted` 展示字段（或内存缓存）。
- 展示层读预测值，快照到达即覆盖。
- 验证：成交后 UI 余额 <1s 更新，快照到达后归位。

### Phase 4 — 价格解耦（可选，进一步省调用）

- 展示层用 ticker 实时价重估 `value_usd`。
- 验证：静默钱包价值随行情更新，余额不重拉。

---

## 7. 风险与验证

| 风险 | 缓解 | 验证 |
|---|---|---|
| 门铃漏覆盖（~2%）导致余额最长 4h 才纠偏 | 周期对账仍是硬兜底，不可移除 | `live-vs-xxyy-coverage.md` 覆盖率监控 |
| Tier 0 预测漂移（漏消息/转入不可见） | 预测值非权威，快照必覆盖；触底/超阈值标记疑似漏消息 | 断言快照后预测值归零 |
| min-age 过激导致权威余额滞后 | `MIN_REFRESH_AGE_MS` 可配，默认 120s 保守 | 监控活跃钱包 p95 权威新鲜度 |
| 自适应间隔误判活跃度 | 信号用已入库成交时间，零 API；阈值可调 | 抽查活跃/静默分流正确性 |

**铁律**：无论 Tier 0-1 如何优化，**Tier 2 周期对账永远存在**——它是"漏消息/转入/CEX 代买"这些事件流结构性盲区的唯一纠偏手段。优化的是调用频率，不是删掉锚点。

---

## 附：现有代码锚点

- 队列消费：`lib/server/holdingsRefreshQueue.ts`（`seedPersistentQueue` / `claimPersistentJob` / `runHoldingsRefreshQueueCycle`）
- 单钱包刷新：`lib/server/holdingsRefreshRuntime.ts`（`refreshWalletHoldings`，OKX EVM 含 RH）
- 数据源：`lib/okx.ts`（`CHAIN_TO_OKX_INDEX.robinhood = 4663`）
- 门铃触发：`lib/server/liveMonitorRuntime.ts`（`enqueueHoldingsRefresh`）
- 任务注册：`server/runtime-tasks.ts`（`holdings-refresh`；`holdings-refresh-gmgn` idle）
