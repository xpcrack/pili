# Pili `GET /api/agent/opportunities` 接入说明

供本机 cronjob agent（如 Hermes）拉取"交易机会候选"清单。pili 在内部做规则粗筛 + 字段精简，让 Hermes 这边的 LLM 直接消化。

## Endpoint

```
GET http://localhost:3001/api/agent/opportunities
Authorization: Bearer <AGENT_API_TOKEN>
```

`AGENT_API_TOKEN` 配置在 pili 的 `.env.local`。同机 cron 调用即可，不需要暴露外网。

## Query 参数

| 参数 | 默认值 | 范围 | 说明 |
|---|---|---|---|
| `since` | 0 | 毫秒戳 | 增量游标。首次传 0，之后用上次响应里的 `nextSince` |
| `limit` | 50 | 1-200 | 单次返回最多条数 |
| `minUsd` | 500 | ≥0 | 单笔交易 USD 阈值，命中即视为机会信号 |
| `minCoHit` | 2 | ≥0 | 同标的同时段跟随钱包数阈值（coHitUserCount 或 coHitAddressCount 任一达标） |
| `minImportance` | 40 | 0-100 | importance.score 阈值（pili 内部 0-100 整数） |
| `actions` | `buy,open,add` | 逗号分隔 | 链上动态 txActionVariant 白名单，备选值：open/add/reduce/close/send |
| `chains` | 空=全部 | 逗号分隔 | 链白名单，如 `solana,bsc` |
| `sources` | `blockchain,telegram` | 逗号分隔 | 数据来源白名单，备选值：blockchain/telegram/twitter |
| `windowHours` | 24 | 1-720 | 最大回看窗口（小时）。`since` 落后超过此窗口时按窗口起算，并在响应里置 `truncated: true` |

## 响应体

```json
{
  "ok": true,
  "nextSince": 1747200876001,
  "hasMore": false,
  "truncated": false,
  "rules": {
    "minUsd": 500,
    "minCoHit": 2,
    "minImportance": 40,
    "actions": ["buy", "open", "add"],
    "chains": [],
    "sources": ["blockchain", "telegram"],
    "windowHours": 24
  },
  "items": [
    {
      "id": "evt_xxx",
      "ts": 1747200876000,
      "source": "blockchain",
      "chain": "solana",
      "action": "open",
      "token": { "symbol": "WIF", "address": "EKpQ..." },
      "wallet": { "label": "聪明钱A", "address": "9zT..." },
      "tradeUsd": 18420,
      "marketCapUsd": 920000000,
      "coHitUsers": 4,
      "coHitAddrs": 6,
      "importance": 78,
      "sentiment": null,
      "text": "建仓 WIF $18.4k",
      "permalink": null
    }
  ]
}
```

字段说明：

- `id` 稳定唯一，Hermes 端可按 id 做幂等
- `nextSince` 下次请求传给 `since` 即可
- `hasMore` 为 true 表示本批 dedup 后超过 `limit` 被截断，建议 Hermes 短时间内重拉一次（用 hasMore=true 时返回的 nextSince，老候选可能丢失。如果担心，按 plan 后续可扩展）
- `truncated` 为 true 表示 `since` 太老被 `windowHours` 强制截断，告诉 Hermes 跳过了历史段
- `importance` 范围 0-100：≥70 high，≥50 important，其余 normal
- `permalink` 仅社交动态有（tweetUrl/telegramPostUrl），链上动态为 null
- `wallet.address` 仅链上有
- `tradeUsd`/`marketCapUsd` 仅链上有

## 粗筛规则（pili 内部已做）

候选需同时满足：

1. 时间窗：`ts >= max(since, now - windowHours*3600_000)`
2. 来源白名单：`source ∈ sources`
3. 链白名单：`chains` 为空或 `chain ∈ chains`
4. 动作白名单（仅链上）：`txActionVariant ∈ actions`
5. **机会信号至少一条**（OR 语义，不是 AND）：
   - `tradeUsd >= minUsd`
   - `coHitUsers >= minCoHit` 或 `coHitAddrs >= minCoHit`
   - `importance >= minImportance`
   - 社交动态含 positive 情感且提到 ticker/合约

> **注意**：四类信号是 **OR** 关系。例如传 `minUsd=50000` **不会**过滤掉小金额条目——只要 importance/coHit 仍命中，条目还是会出现。想精确控制候选量，建议同时调高 `minImportance` 和 `minCoHit`，或者把 Hermes 那边再做一层规则。

同 `chain+tokenAddress` 在 5 分钟内只保留 importance 最高的一条。

## 错误码

- `401 unauthorized`：token 缺失或不对
- `503`：服务端未配 `AGENT_API_TOKEN`
- `400 invalid <param>`：参数非法（NaN、负值、超范围）
- `500`：内部异常

## 推荐频率

每 10 分钟拉一次（pili 当前日均约 50 条候选，单次返回均值 < 5 条）。Hermes 想更保守 30 分钟也行。

## curl 示例

```bash
# 首次拉
curl -H "Authorization: Bearer $AGENT_API_TOKEN" \
     "http://localhost:3001/api/agent/opportunities?limit=10"

# 后续增量
curl -H "Authorization: Bearer $AGENT_API_TOKEN" \
     "http://localhost:3001/api/agent/opportunities?since=1747200876001&limit=50"

# 自定义阈值
curl -H "Authorization: Bearer $AGENT_API_TOKEN" \
     "http://localhost:3001/api/agent/opportunities?minUsd=10000&minCoHit=5&chains=solana&sources=blockchain"
```

## Cursor 维护建议

Hermes 端持久化两个字段：
- 上次成功响应的 `nextSince`
- 已处理过的 `id` 集合（去重用，可只保留最近 N 天）

崩溃重启用上次保存的 `nextSince` 继续。如果想"补历史"，传 `since=0` 会强制按 `windowHours` 回看。
