# 代币表格新增“上次买入”列

代币监控页 `/tokens` 的表格新增一列“上次买入”，展示每个代币在所有 pili 关注地址中最近一次有人买入的相对时间。

## 目标

- 在代币表格中快速看到关注地址最近是否有人买入该代币。
- 按每个代币汇总所有 pili 关注地址，不受前端筛选或选中人物影响。
- 展示格式与现有地址页“上次交易时间”保持一致：`刚刚`、`12m`、`3h`、`5d`，无数据显示 `-`。
- 保持实现轻量，不新增日常运维负担。

## 采用方案

采用服务端按需聚合方案：`/api/tokens` 在返回代币列表和价格数据时，同时从 `events` 表读取每个代币最近一次买入时间，并把 `last_buy_at` 合并到每个 token item。

不新增数据库字段，不新增独立接口，不要求同步任务维护额外缓存。

## 备选方案

1. 服务端按需聚合，合并到 `/api/tokens` 返回值。  
   优点是改动小、数据来源直接、页面只需一次请求；缺点是每次打开或刷新代币页都会执行一次聚合查询。该页面是个人管理工具，当前数据量适合这个方案。

2. 在 `tokens` 表缓存 `last_buy_at`。  
   优点是读取最快；缺点是要新增迁移、回填、同步更新逻辑，也会增加缓存与真实交易数据不一致的风险。本需求只加一列，不值得引入这层复杂度。

3. 新增 `/api/tokens/stats` 聚合接口。  
   优点是接口职责更分离；缺点是前端要多一次请求、处理更多 loading/error 状态。当前页面已经通过 `/api/tokens` 获取完整表格数据，拆接口收益不大。

## 数据来源与计算

数据源使用 `events` 表中的已归档交易活动。

筛选条件：

- `source = 'blockchain'`
- `action = 'buy'`
- `chain` 与代币行的 `chain` 一致
- `activity_json` 中的 `metadata.tokenAddress` 与代币行的 `contract_address` 归一化后匹配

计算方式：

- 对每个 `(chain, tokenAddress)` 取 `MAX(timestamp)`。
- EVM 地址与普通合约地址用小写归一化匹配。
- Solana 地址保持现有链内 token 地址语义，匹配时仍可统一用 trim + lower，避免显示大小写差异影响聚合。
- HyperCore 的 `tokens.contract_address` 表示 token 名称。若现有链上事件没有 `metadata.tokenAddress` 可匹配，则该列显示 `-`；不为 HyperCore 单独增加推断逻辑，避免把 symbol/name 误当唯一标识。

## API 设计

`app/api/tokens/route.ts` 的 GET 返回 item 增加字段：

```ts
last_buy_at: number | null;
```

建议在服务端新增一个小型查询 helper，例如放在 `lib/server/eventsRepo.ts`：

```ts
readLatestBuyAtByToken(tokens: Array<{ chain: string; contractAddress: string }>): Map<string, number>
```

helper 返回 key 为 `${chain}:${normalizedTokenAddress}` 的 `Map`，供 `/api/tokens` 合并数据。这样 token 仓储仍只负责 token 表自身，交易事件聚合留在 events 侧。

## 前端设计

`app/tokens/page.tsx` 中 `Token` interface 增加：

```ts
last_buy_at: number | null;
```

表格新增“上次买入”列，建议放在 `24h` 与 `市值` 之间，便于把价格变化和最近买入行为放在一起阅读。

单元格展示：

- 有值：`formatRelativeTimeCompact(token.last_buy_at)`
- 无值：`-`
- 样式：右对齐、`font-mono`、`text-zinc-300`，与地址页“上次交易时间”保持一致

空列表行的 `colSpan` 需要从 8 调整为 9。

## 错误处理

- 如果聚合查询失败，`/api/tokens` 应保持接口整体失败并返回 500，沿用现有错误处理路径。
- 如果某个 token 没有买入记录，返回 `last_buy_at: null`，前端显示 `-`。
- 价格接口缺数据与最近买入缺数据互不影响；价格仍按现有逻辑显示 `-`。

## 测试与验证

- 添加或扩展服务端测试，覆盖：
  - 多个关注地址买入同一 token 时取最新 timestamp。
  - sell/send/receive 不参与统计。
  - 无买入记录返回 `null`。
  - 不同链相同地址字符串不串数据。
- 添加或扩展前端/路由级验证，确认 `/api/tokens` 返回 `last_buy_at`，页面用 `formatRelativeTimeCompact` 显示。
- 实现后运行 `npm test`；若涉及类型变化，运行 `npx tsc --noEmit`。
- 代码变更后按仓库规则用 `npm run runtime:refresh` 刷新生产 web 进程，前提是构建通过。

## 不涉及

- 不新增 `tokens` 表字段。
- 不新增后台 worker。
- 不改交易入库逻辑。
- 不为 HyperCore 做 symbol/name 模糊匹配。
- 不改变现有排序、选择、导入、删除行为。
