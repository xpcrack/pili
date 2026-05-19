# 搜索改版与交易筛选设计

日期：2026-04-25

## 背景

当前首页搜索区同时承担了两类职责：

- 普通搜索入口
- 字段语法和键盘补全入口

现状问题：

- 用户需要理解 `person:`、`address:`、`tx:` 等语法，使用成本高
- 搜索框存在方向键、`Enter`、`Tab` 驱动的 suggestion 交互，体验不够直接
- 现有筛选主要围绕搜索词，没有直接暴露“交易 / 转账 / 推特”这类信息类型过滤
- 交易相关信息虽然已有 `quoteAmount`、`quoteToken`、`marketCapAtTxUsd` 等字段，但缺少稳定落盘的“成交当时 USD 金额”，不利于金额筛选和展示

本次改版目标是把搜索改成“直接输入即可筛选”的普通实时搜索，同时补上面向交易信息的类型筛选、成交金额筛选和成交市值筛选。

## 目标

- 去掉字段语法搜索和键盘补全交互
- 保留实时筛选体验，不改成提交式搜索
- 新增 `交易 / 转账 / 推特` 三个多选筛选项，默认全选
- 新增只作用于交易的两个最低值筛选：
  - 最低成交金额（USD）
  - 最低成交市值
- 给每条交易动态补充稳定的“成交当时 USD 金额”字段，供展示和筛选复用
- 保持现有 feed 拉取、展开更多、补历史逻辑不变，尽量把风险收敛在前端筛选和交易落盘字段扩展

## 非目标

- 不重做 `/api/feed` 的接口形态
- 不把本次筛选条件下沉到服务端查询参数
- 不改动 7 天窗口补齐策略
- 不引入新的高级语法搜索
- 不新增独立搜索页面

## 用户决策记录

- 搜索改为普通全文实时搜索，不再支持字段语法
- 三个类型筛选默认全选
- 关键词命中范围限定为：
  - 人物名字
  - 推文内容
  - CA
  - 地址
- 多个关键词之间采用 `OR` 匹配
- 类型口径：
  - `交易` = `txAction` 为 `buy` 或 `sell`
  - `转账` = `txAction` 为 `send` 或 `receive`
  - `推特` = `source` 为 `twitter`
- 三个类型全部取消时，不自动恢复全选，显示空列表并提示用户至少选择一种类型
- 成交金额和成交市值筛选仅对 `交易` 生效
- 成交金额和成交市值都使用“最低值”交互，不做区间，不做预设档位
- 成交金额采用 USD 口径
- 每条交易动态应落盘“成交当时 USD 金额”
- 无法可靠换算 USD 的交易仍然展示，但标记为“金额未知”

## 设计概览

首页搜索区采用“搜索主导 + 筛选条”布局：

1. 第一行是普通搜索框
2. 第二行是筛选条，包含：
   - `交易`
   - `转账`
   - `推特`
3. 交易筛选开启时，可见两个附加输入：
   - 最低成交金额（USD）
   - 最低成交市值

页面行为遵循以下原则：

- 用户输入关键词后立即筛选结果
- 不再出现 suggestion 下拉、字段提示和基于按键的补全行为
- 类型筛选与关键词筛选在同一套前端过滤流水线中执行
- 交易金额和成交市值筛选只影响 `buy/sell` 交易，不影响 `send/receive` 和 `twitter`

## 组件与职责

### 1. 页面状态层

`app/page.tsx` 维护统一筛选状态，替换当前仅有的 `searchInput` 主状态。

建议状态结构：

```ts
interface FeedSearchFilters {
  keyword: string;
  typeFilters: {
    trade: boolean;
    transfer: boolean;
    twitter: boolean;
  };
  minTradeAmountUsd: string;
  minTradeMarketCapUsd: string;
}
```

说明：

- 数值输入在 UI 层先以字符串存储，便于处理中间态输入
- 页面中的搜索框、多选框、金额输入框都只更新这一个状态对象
- “清空筛选”动作会重置关键词和数值输入，并恢复三类默认全选

### 2. 搜索工具层

`lib/smartSearch.ts` 从“字段语法解析 + suggestion 工具”收缩为“普通关键词匹配工具”。

保留职责：

- 规范化关键词输入
- 提取词项
- 对 feed item 执行普通搜索匹配

移除职责：

- `person:` / `address:` / `tx:` / `ca:` / `ticker:` / `action:` 解析
- suggestion source 构建
- suggestion 列表生成
- 键盘驱动的 suggestion 应用逻辑

关键词匹配规则：

- 将输入按空格切分为多个词项
- 词项之间采用 `OR`
- 空词项忽略
- 命中范围仅包含：
  - `user.name`
  - `activity.content`（仅当 `activity.source === 'twitter'` 时参与匹配）
  - `activity.metadata.tokenAddress`
  - `activity.metadata.fromAddress`
  - `activity.metadata.toAddress`
  - `activity.metadata.trackedAddress`

### 3. 类型筛选层

新增统一的 feed item 分类函数，建议放在搜索/过滤工具文件中，避免分散在页面里写条件。

分类规则：

- `twitter`
  - `activity.source === 'twitter'`
- `trade`
  - `activity.metadata.txAction === 'buy' || activity.metadata.txAction === 'sell'`
- `transfer`
  - `activity.metadata.txAction === 'send' || activity.metadata.txAction === 'receive'`

说明：

- `trade/transfer` 以业务动作分类，不以“是否来自某个同步通道”分类
- 这意味着 XXYY 监控类交易、普通链上补齐交易，只要最终 activity 上有 `buy/sell/send/receive`，都进入相同筛选口径
- 不能仅通过 `activity.type` 区分 `trade/transfer`，因为当前很多链上 activity 的 `type` 统一为 `transfer`

### 4. 交易数值筛选层

新增两个交易最低值筛选：

- `minTradeAmountUsd`
- `minTradeMarketCapUsd`

规则：

- 只对 `trade` 生效
- `transfer` 和 `twitter` 不受这两个条件影响
- 若用户未填写某项最低值，则该条件不参与过滤
- 若填写了最低值：
  - 交易金额缺失时，不命中金额条件
  - 交易市值缺失时，不命中市值条件
- 当列表中没有任何 `trade` 类型时，这两个条件在结果上等价于不生效，但 UI 仍保留当前输入值

### 5. 卡片展示层

`components/ActivityCard.tsx` 在交易卡片中补充：

- 成交金额：显示紧凑的 USD 文案，例如 `$12.3K`
- 成交市值：继续沿用现有市值展示
- 当成交金额缺失时，显示“金额未知”

展示目标：

- 让用户看到筛选条件对应的字段值
- 保证“筛什么、看什么”一致

## 数据模型设计

### Activity metadata 新增字段

在 `Activity['metadata']` 中新增稳定字段：

```ts
tradeAmountUsdAtTx?: number;
```

语义：

- 表示该笔交易在成交当时对应的 USD 金额
- 仅对 `buy/sell` 类型交易有意义
- 用于交易金额筛选和交易卡片展示

现有字段分工：

- `quoteAmount` / `quoteToken`
  - 原始成交报价信息，保留
- `marketCapAtTxUsd`
  - 成交时市值，继续保留
- `tradeAmountUsdAtTx`
  - 成交时 USD 金额，新增并作为金额筛选主口径

## 数据流

### 1. 拉取层

`/api/feed` 和 `useActivityPolling` 继续负责拉取 feed 数据，不增加新的筛选请求参数。

原因：

- 本次改版核心是交互和本地过滤体验，不是服务端检索优化
- 不改接口可以降低与现有 `refetch`、分页、补历史逻辑的耦合风险
- 当前主 feed 规模足以支撑前端过滤

### 2. 前端过滤顺序

页面拿到 feed 后，统一按以下顺序过滤：

1. 关键词匹配
2. 类型筛选
3. 交易金额筛选
4. 交易市值筛选

建议将这四步组合成单一过滤函数，避免过滤逻辑散落在多个 `useMemo` 中。

### 3. 交易 USD 金额写入时机

在交易 activity 生成或持久化进入 feed 之前，计算 `tradeAmountUsdAtTx` 并写入 activity metadata。

推荐计算策略：

1. 若 `quoteToken` 为稳定币且 `quoteAmount` 可解析，直接使用 `quoteAmount`
2. 若 `quoteToken` 为原生币且 `quoteAmount` 可解析，使用成交当时的原生币 USD 价格换算
3. 若可从现有解析结果或监控源拿到稳定 USD 价格信息，直接使用
4. 若仍无法可靠换算，则不写入该字段

说明：

- 目标是“入库时计算一次”，而不是“筛选时重复回算”
- 这样后续筛选、展示、排序都可以复用同一个稳定值

## 与现有同步链路的关系

本次不改变以下行为：

- refresh 仍然拉最近 7 天
- backfill 仍然每次向前补 7 天
- `buildActivityFeed(..., { requireTrackedInitiator: true })` 的主链路保持不变
- `activity_feed` / `events` 的写入链路保持不变，只是在 activity metadata 中新增金额字段

影响点仅限于：

- 交易 activity metadata 扩展
- 首页 UI 状态重构
- feed 过滤逻辑重构
- 卡片展示补充

## 空状态与文案

### 类型全关闭

当 `交易 / 转账 / 推特` 全部取消勾选时：

- 列表显示为空
- 顶部或结果区显示提示：
  - `请至少选择一种类型`

### 搜索无命中

当输入关键词但无匹配结果时：

- 显示提示：
  - `没有匹配的人物、推文内容、CA 或地址`

### 交易筛选提示

当设置了 `最低成交金额` 或 `最低成交市值` 时：

- 在筛选区或结果说明中提示：
  - `交易金额和成交市值筛选仅对交易生效`

### 金额未知交易

当某条 `trade` 没有可靠 `tradeAmountUsdAtTx` 时：

- 卡片继续展示
- 金额位置显示：
  - `金额未知`
- 若用户设置了最低成交金额，则该交易不命中金额条件

### 市值未知交易

当某条 `trade` 没有可靠 `marketCapAtTxUsd` 时：

- 卡片可继续展示
- 若用户设置了最低成交市值，则该交易不命中市值条件

## 受影响文件

预计至少涉及：

- `app/page.tsx`
- `lib/smartSearch.ts`
- `components/ActivityCard.tsx`
- `types/index.ts`
- 交易 activity 生成或补齐链路相关文件：
  - `lib/activityFeed.ts`
  - `lib/parsing/toActivity.ts`
  - `lib/server/telegramMonitorFeed.ts`

若 `lib/smartSearch.ts` 在删除字段语法后仍显得职责混乱，应顺手拆分为更聚焦的普通搜索/过滤工具文件，但不做与本需求无关的大重构。

## 测试策略

### 单元测试

重点覆盖：

- 关键词 OR 匹配
- 命中范围仅限人物名字、推文内容、CA、地址
- 类型映射：
  - `buy/sell -> 交易`
  - `send/receive -> 转账`
  - `twitter -> 推特`
- 最低成交金额筛选
- 最低成交市值筛选
- 金额未知 / 市值未知的边界行为

### 页面行为验证

至少覆盖以下场景：

- 关键词输入后结果实时变化
- 字段语法和 suggestion 下拉不再出现
- 三个类型全部取消时显示空状态提示
- 仅勾选 `交易` 时，`buy/sell` 结果保留，`send/receive/twitter` 被排除
- 同时输入关键词、勾选类型、设置金额门槛和市值门槛时，组合过滤结果正确
- 金额未知交易在无金额筛选时可见，在有金额门槛时被排除

## 风险与注意事项

- 当前搜索逻辑有一部分分散在页面状态与工具函数之间，重构时应避免出现“双重过滤”
- 现有链上 activity 的 `type` 不足以区分交易与转账，必须以 `txAction` 为准
- 金额筛选的主口径是新增的 `tradeAmountUsdAtTx`，不要继续让前端临时回算原生币价格
- 金额未知和市值未知的交易需要在 UI 文案上明确，否则用户会误解为筛选失效

## 推荐实现顺序

1. 扩展 `Activity.metadata`，为交易补 `tradeAmountUsdAtTx`
2. 更新交易 activity 生成和落盘链路，确保新字段进入 feed
3. 重构搜索工具，移除字段语法和 suggestion 逻辑
4. 在 `app/page.tsx` 引入统一筛选状态与过滤流水线
5. 更新 `ActivityCard` 展示成交金额和金额未知状态
6. 补单测与页面行为验证
