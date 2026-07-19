# live-monitor vs XXYY 覆盖率

## 怎么跑

```bash
# 从第一笔 live-monitor 起（推荐 dual 期间）
npx tsx scripts/report-live-vs-xxyy-coverage.ts --since-live

# 或固定窗口
npx tsx scripts/report-live-vs-xxyy-coverage.ts --hours=72
```

逻辑键：`lower(chain)|lower(tx_hash)|lower(wallet)`  
- live 侧：`events` 里 `live-monitor:*` / `ingest_source like live-monitor%` / `metadata.liveSource=alchemy-gmgn`  
- xxyy 侧：`telegram_monitor_events`（不受 events 表 rekey 影响）

## 切源门槛（建议）

| 条件 | 阈值 |
|------|------|
| dual 连续样本 | ≥ 3 天 |
| 非 RH：`both / xxyy` | ≥ 98% |
| sol / bsc / base 各自 | ≥ 95% |
| ethereum 有交易时 | 单独看，不能长期 0 vs 有 |

达标后再：

```bash
# .env.local
PILI_LIVE_SOURCE=alchemy
PILI_LIVE_XXYY_CHAINS=robinhood
```

然后 `runtime:refresh` web（bridge 不需要为切源重启，但 XXYY 过滤在 ingest 里读 env）。

## 2026-07-19 初测（dual 约 8h，自 09:13）

| chain | live | xxyy | both | live_only | xxyy_only | live÷xxyy |
|-------|------|------|------|-----------|-----------|-----------|
| robinhood | ~107 | ~200 | ~105 | 2 | ~95 | ~52% |
| bsc | ~60 | ~62 | ~60 | 0 | ~2 | ~97% |
| solana | ~18 | ~25 | ~18 | 0 | ~7 | ~72% |
| base | ~3 | ~3 | ~3 | 0 | 0 | 100% |
| ethereum | 0 | 0 | 0 | 0 | 0 | n/a |
| **non-RH** | | | | | | **~90%** |

结论：**未达标，保持 dual。**

### 漏因线索
1. **门铃模型**：live-monitor 只对 Alchemy inbox 响铃钱包扫 GMGN；漏门铃 = 漏成交。  
2. **`PILI_ALCHEMY_MANAGE_WATCHLIST` 默认未开**：pili 不写 webhook 地址名单，依赖 newone/飞书。自己钱包（Finn `CJ5f…`）多笔 sol 小额被 XXYY 抓到但 live 无记录 → 优先查 watchlist 是否含该地址 + SOL webhook 是否响铃。  
3. **matched 延迟**（live_created − tg_created）：bsc/sol 平均 <1s，可用；RH 有负值（live 有时更早）。  
4. dual 会把同一笔 rekey 到 `live-monitor:` id，**不要用 events 表 xxyy 行数估 XXYY 覆盖**。

## 回滚

```bash
PILI_LIVE_SOURCE=dual
# 或
PILI_LIVE_SOURCE=xxyy
```
