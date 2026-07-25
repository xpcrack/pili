# Live Monitor — Alchemy 门铃 + GMGN（pili Feed）

## 数据流

```text
tracked_users
  → (可选) pili 自有 Alchemy webhook 地址同步
  → ADDRESS_ACTIVITY → CF inbox（可与 newone 共用收件箱 URL）
  ↘
XXYY TG（bridge）→ 只写审计 + live_doorbell_queue（不解析买卖腿）
  ↘
runtime task `live-monitor` 合并门铃
  → GMGN portfolio activity（唯一成交解析）
  → events id = live-monitor:{chain}:{wallet}:{tx}:{token}
```

## 环境变量

| 变量 | 说明 |
|------|------|
| `PILI_LIVE_SOURCE` | `dual` / `alchemy` / `xxyy`。未设时：有 inbox url+token → dual，否则 xxyy |
| `PILI_XXYY_FEED` | `doorbell`（默认，alchemy/dual）/ `project`（旧 XXYY 直写 feed）/ `off` |
| `PILI_LIVE_DOORBELL_DEBOUNCE_MS` | XXYY 门铃 trailing debounce，默认 2000 |
| `PILI_LIVE_XXYY_CHAINS` | 仅 `PILI_XXYY_FEED=project` 时生效；alchemy 默认 `robinhood` |
| `PILI_ALCHEMY_INBOX_URL` | CF inbox 根 URL（可回退 `NEWONE_ALCHEMY_INBOX_URL`） |
| `PILI_ALCHEMY_PULL_TOKEN` | pull Bearer（可回退 NEWONE） |
| `PILI_ALCHEMY_WEBHOOK_API_KEY` | Notify 名单 API（可回退 NEWONE） |
| `PILI_ALCHEMY_WEBHOOK_{ETH,BASE,BSC,SOL,RH}` | **必须 pili 专用 webhook id**，勿与 newone 共用 |
| `PILI_LIVE_CYCLE_MS` | 默认 15000 |
| `PILI_LIVE_MIN_COST_USD` | GMGN 过滤，默认 0 |
| `PILI_LIVE_LOOKBACK_SEC` | GMGN after_ts 窗口，默认 7200 |
| `PILI_LIVE_WATCHLIST_EVERY_MS` | 名单同步间隔，默认 15m |

## Gate 0 — Robinhood

Address Activity 是否支持 RH 以 **Alchemy Dashboard** 为准。  
公开 Notify network 枚举可能仍无 RH。无 RH webhook 时：

- 四链走 Alchemy+GMGN
- `PILI_LIVE_SOURCE=alchemy` + `PILI_LIVE_XXYY_CHAINS=robinhood` 保留 XXYY 只吃 RH

## 切换建议

1. dual + 不设 `PILI_LIVE_XXYY_CHAINS` → 双写对比  
2. dual + `PILI_LIVE_XXYY_CHAINS=robinhood` → 非 RH 只靠 live  
3. alchemy + RH webhook 或 RH 仍 xxyy  
4. 回滚：`PILI_LIVE_SOURCE=xxyy`

**切源前先跑覆盖率**（见 [live-vs-xxyy-coverage.md](./live-vs-xxyy-coverage.md)）：

```bash
npx tsx scripts/report-live-vs-xxyy-coverage.ts --since-live
```

门槛：dual ≥3 天、非 RH `both/xxyy ≥ 98%`、sol/bsc/base 各自 ≥95%。未达标保持 dual。

## 代码

- `lib/server/alchemyWatchlist.ts` / `alchemyInbox.ts`
- `lib/server/gmgnWalletActivity.ts`
- `lib/server/liveMonitor{Config,Ingest,Runtime}.ts`
- runtime key: `live-monitor`
- 测试: `scripts/test-live-monitor-core.ts`
- 覆盖率: `scripts/report-live-vs-xxyy-coverage.ts`
