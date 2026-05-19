# Twitter 推文增强与交易引用补抓设计

日期：2026-04-25

## 背景

当前项目已经具备一套稳定的 Twitter 抓取与 feed 投影链路：

- `twitterSyncService` 负责主动同步
- `twitterRepo` 负责 tweet 落库
- `twitterFeedMapper` 负责把 tweet 投影到 feed
- `eventsRepo` / `activity_feed` 负责统一时间线事件

同时，链上与 Telegram 交易动态已经能稳定进入同一条时间线，但还缺少三类能力：

- 不能从推文中结构化提取 `ticker` / `CA`
- 不能按“推文对某个代币的态度”存储和展示 `positive / negative / neutral`
- 不能把推文英译中后默认展示中文
- 当交易动态里的社媒链接指向某篇 tweet 时，还不能自动补抓 tweet 并纳入时间线

本次目标是在不推翻现有 Twitter 主链路的前提下，补上“推文增强层”和“交易引用 tweet 补抓层”。

## 目标

- 从 tweet 文本中解析 `ticker` / `CA`
- 以“每个代币一条关系”的粒度存储 tweet 对代币的态度：
  - `positive`
  - `negative`
  - `neutral`
- 为 tweet 生成中文译文，并在时间线默认优先展示中文
- 如果交易动态中绑定的社媒链接指向 tweet：
  - 新数据实时补抓
  - 对最近窗口做历史回填
- 同一篇 tweet 即使被多个代币或多笔交易引用，在时间线中仍只出现一次
- 为后续搜索、聚合、统计、告警保留结构化数据基础

## 非目标

- 不重写现有 `twitterFetcher -> twitterRepo -> twitterFeedMapper` 主链路
- 不改动现有 Twitter provider 路由与预算体系
- 不在本期重做首页 feed API 形态
- 不在本期实现复杂的情绪聚合分析面板或告警界面
- 不做全量历史 tweet / 交易引用全表补抓
- 不要求用户手动维护 tweet 与 token 的关系

## 已确认产品决策

- 推文增强结果需要持久化，不能只做前端展示态计算
- sentiment 粒度按“每条推文中的每个代币”分别判定
- 交易引用补抓采用：
  - 新数据实时处理
  - 最近窗口历史回填
- 中文展示采用“中文优先，原文次级显示”
- 同一篇 tweet 若关联多个代币，时间线卡片上直接展示多个 token 标签，每个标签带自己的 sentiment
- 抽取方式采用混合策略：
  - `ticker/CA` 用规则提取
  - sentiment 与英译中由模型生成

## 方案选择

本期采用“推文主表 + 关联表”方案，而不是把全部增强信息硬塞进现有 `activity.metadata`，也不是升级为完整 event graph。

核心原则：

1. tweet 仍然是时间线中的独立事件
2. `tweetId` 仍然是 tweet 的唯一身份
3. tweet 自身信息与“tweet 命中了哪些 token”拆开建模
4. 交易动态只负责表达“引用了哪篇 tweet”，不复制出新的 tweet 事件

## 总体架构

### 1. 保持 tweet 为时间线主事件

现有 `twitterFeedMapper` 继续按 `tweetId` 把 tweet 投影到 feed：

- tweet event key 继续为 `twitter:${tweetId}`
- 同一篇 tweet 在 feed 中只出现一次
- 无论 tweet 来源是主动抓取还是交易引用补抓，最终都汇合到同一套 tweet 存储与投影逻辑

### 2. 引入推文增强层

tweet 主体落库后，不阻塞主链路，异步生成增强信息：

- 中文译文
- 规则提取出的 `ticker/CA`
- 每个 token 自己的 sentiment
- 处理状态与版本信息

这样即使增强失败：

- tweet 本体仍可进入时间线
- 后续可重跑增强而无需重新抓 tweet

### 3. 引入交易引用关系层

交易动态如果包含有效 tweet 链接：

- 先解析出 `tweetId`
- 建立“该交易事件引用了该 tweet”的关系
- 若本地没有该 tweet，则触发按 `tweetId` 的补抓
- tweet 一旦落库，继续复用现有投影逻辑进入时间线

这保证：

- 同一 tweet 被多笔交易引用时，只会投影一条 tweet 卡片
- 多个 token 指向同一 tweet 时，也不会产生重复 tweet event

## 数据模型设计

### 1. 继续保留 `twitter_tweets`

`twitter_tweets` 继续承载 tweet 主数据：

- `tweet_id`
- 作者、时间、正文
- reply / quote 关系
- 互动指标
- provider 原始 source

本表不新增“每个 token 的 sentiment”字段，避免把多值关系硬编码进单行记录。

### 2. 新增 `twitter_tweet_enrichments`

建议新增一张一对一增强表：

```sql
twitter_tweet_enrichments (
  tweet_id TEXT PRIMARY KEY,
  translation_zh TEXT,
  translation_status TEXT NOT NULL,
  extraction_status TEXT NOT NULL,
  extractor_version TEXT,
  translator_version TEXT,
  last_processed_at_ms INTEGER,
  last_error TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
)
```

职责：

- 保存 tweet 的中文译文
- 保存抽取与翻译状态
- 保存当前增强版本，便于后续 replay
- 保存错误信息，便于排障

状态建议值：

- `pending`
- `processing`
- `succeeded`
- `failed`

### 3. 新增 `twitter_tweet_token_mentions`

建议新增 tweet 与 token 的关系表：

```sql
twitter_tweet_token_mentions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tweet_id TEXT NOT NULL,
  token_address TEXT,
  token_address_lower TEXT,
  token_symbol TEXT,
  chain TEXT,
  match_source TEXT NOT NULL,
  sentiment TEXT NOT NULL,
  confidence REAL,
  rank_in_tweet INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
)
```

职责：

- 记录某篇 tweet 命中了哪个 token
- 对每个 token 单独记录 sentiment
- 标记命中来源：
  - `ticker`
  - `ca`
  - `both`

关系唯一性建议按“同一 tweet 下的规范化 token 身份”控制：

- 若 `token_address_lower` 存在，优先按 `tweet_id + chain + token_address_lower` 去重
- 若只有 ticker 没有 CA，则按 `tweet_id + normalized_symbol` 去重

### 4. 新增 `event_tweet_refs`

建议新增交易事件到 tweet 的引用关系表：

```sql
event_tweet_refs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  tweet_id TEXT NOT NULL,
  ref_source TEXT NOT NULL,
  discovered_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE(event_id, tweet_id)
)
```

职责：

- 表达“某条事件引用了哪篇 tweet”
- 允许后续从交易事件回查引用来源
- 不承担 tweet 投影责任

`ref_source` 建议值：

- `telegram-monitor`
- `blockchain-parser`
- `historical-backfill`

## 数据流设计

### 1. 主动抓取 tweet

现有主动抓取链路保持不变：

1. `twitterSyncService` 调用 `twitterFetcher`
2. `twitterRepo.upsertTwitterTweets` 落库到 `twitter_tweets`
3. `twitterFeedMapper.projectTwitterTweetsToFeed` 投影到 `activity_feed` / `events`
4. 新增异步增强调度，把新 tweet 加入 enrichment 队列

新增原则：

- tweet 本体入库先于增强
- 增强任务失败不影响 tweet 投影

### 2. 交易引用实时补抓

在交易动态生成事件的链路中，增加对 tweet 链接的识别：

1. 从交易原始文本、关联链接或 payload 中提取 URL
2. 如果 URL 是有效 tweet 链接，则解析出 `tweetId`
3. 把交易事件与 `tweetId` 写入 `event_tweet_refs`
4. 如果本地不存在该 tweet：
   - 调用 `twitterFetcher.fetchTweetsByIds({ ids: [tweetId], intent: 'detail' })`
   - 落库到 `twitter_tweets`
   - 投影到 feed
   - 加入 enrichment 队列

原则：

- 交易事件与 tweet event 是两条独立时间线项
- 引用关系建立后，同一 tweet 不重复投影

### 3. 最近窗口历史回填

新增最近窗口回填任务，扫描最近窗口内的交易事件：

- 默认窗口建议 `7d`
- 可配置扩展到 `14d` 或 `30d`

回填顺序优先：

1. 找到最近窗口内带 tweet 引用的交易事件
2. 过滤出本地尚未存在 tweet 本体的数据
3. 批量补抓 tweet
4. 投影并加入 enrichment 队列

本期不做默认全量历史回填。

### 4. 增强重跑

增强链路必须支持 replay，而不依赖重新抓 tweet：

- 当规则、模型、prompt 或版本升级时
- 可直接对已有 `twitter_tweets` 重新执行：
  - 规则抽取
  - sentiment 判定
  - 翻译

重跑时：

- 更新 `twitter_tweet_enrichments`
- 全量替换该 tweet 相关的 `twitter_tweet_token_mentions`
- 重新刷新 tweet 在 feed 中的投影 metadata

## 抽取与增强策略

### 1. `ticker/CA` 规则提取

`ticker/CA` 使用确定性规则提取，目标是稳定、可回填、可解释。

建议提取来源包括：

- `$ABC` 形式 ticker
- 明确的 `CA: 0x...` 或 `CA: <sol-address>`
- 文本中独立出现且符合白名单/规则的 ticker
- 已知 tweet URL / 引用内容中的 token 标记

要求：

- 优先降低误判，不追求激进召回
- 对冲突或不确定结果可留空
- 规则版本要写入 enhancement 结果，便于后续 replay

### 2. sentiment 判定

sentiment 由模型按“tweet 中每个 token”分别判断：

- `positive`
- `negative`
- `neutral`

要求：

- 同一条 tweet 可对不同 token 给出不同态度
- 不确定、转述、纯新闻类文本优先落 `neutral`
- 输出结构必须与 token mention 一一对应

### 3. 英译中

tweet 中文翻译由模型生成，并写入 `twitter_tweet_enrichments.translation_zh`。

展示策略：

- 时间线卡片默认先显示中文
- 原文作为次级信息保留
- 若翻译失败，则回退到原文显示

## Feed 投影与搜索设计

### 1. feed 仍然以事件表为主

`readEventsFeed` / `activity_feed` / `events` 仍然是前台列表的读取主入口，不改成直接查 relation 表。

tweet 卡片继续由 `twitter:${tweetId}` 表示唯一身份。

### 2. 投影时附加轻量 metadata

为了让现有前台和搜索逻辑低风险接入，在 tweet 投影到 feed 时，同步把一份轻量增强结果写入 `activity.metadata`。

建议新增以下 metadata 字段：

```ts
translationZh?: string;
translationStatus?: 'pending' | 'processing' | 'succeeded' | 'failed';
mentionedTickers?: string[];
mentionedTokenAddresses?: string[];
tokenSentiments?: Array<{
  tokenSymbol?: string;
  tokenAddress?: string;
  chain?: string;
  sentiment: 'positive' | 'negative' | 'neutral';
  matchSource: 'ticker' | 'ca' | 'both';
}>;
referencedByEventCount?: number;
```

用途：

- tweet 卡片直接渲染中文与 token 标签
- 现有 feed 搜索可较小改动支持 tweet 维度的 `ticker/ca`

### 3. 搜索建议与过滤来源扩展

当前 `smartSearch` 的 `ticker` / `ca` 值主要来自交易 metadata。

设计上需要扩展为：

- 交易 metadata
- tweet 投影 metadata
- 必要时可直接读取 `twitter_tweet_token_mentions`

这样当用户搜索某个 ticker 或 CA 时，可以同时命中：

- 交易动态
- 推文动态

### 4. 聚合与告警走关系表

未来若要做以下能力，不应扫描 `activity_json`：

- 某 token 最近被多少篇 tweet 提到
- 某 token 的 sentiment 分布
- 某 tweet 被多少笔交易引用

这些能力应直接基于：

- `twitter_tweet_token_mentions`
- `event_tweet_refs`

## UI 展示设计

### 1. 时间线 tweet 卡片

tweet 卡片新增以下展示能力：

- 中文译文优先展示
- 原文次级显示
- 多 token 标签并排展示
- 每个 token 标签显示自己的 sentiment

sentiment 文案建议：

- `positive` -> `正面`
- `negative` -> `负面`
- `neutral` -> `中性`

### 2. 同一 tweet 多 token 展示

当一篇 tweet 关联多个 token 时：

- 时间线仍只显示一条 tweet 卡片
- 卡片上直接展示多个 token 标签
- 不折叠成“仅展示主 token”

### 3. 交易事件与 tweet 的关系展示

本期只要求 tweet 能进入时间线并保持唯一，不强制在交易卡片上直接展示 tweet 预览。

但数据层保留：

- 交易事件引用了哪个 `tweetId`
- 该 tweet 被多少交易事件引用

便于后续追加 UI。

## 错误处理与边界

### 1. tweet 抓取失败

如果交易引用解析出了 `tweetId`，但补抓失败：

- 保留 `event_tweet_refs` 或失败记录
- tweet 卡片暂不出现
- 后续由回填或重试任务补齐

### 2. 增强失败

如果 tweet 已抓到，但翻译或 sentiment 失败：

- tweet 仍然投影到 feed
- 前台回退显示原文
- token 标签可为空或保留已有结果
- enhancement 状态标记为 `failed`

### 3. 链接无效

以下链接不应写入引用关系表：

- 只有 profile，没有 `status/<tweetId>`
- 非 tweet 页链接
- `tweetId` 与 URL 不一致
- 非法 `x.com` / `twitter.com` 链接

### 4. 去重规则

必须确保以下场景不重复：

- 主动抓取与交易引用补抓命中同一 tweet
- 多笔交易引用同一 tweet
- 同一条 tweet 中同一 token 被重复抽取

## 测试策略

### 1. 抽取测试

- 只命中 ticker
- 只命中 CA
- 同时命中 ticker 与 CA
- 一条 tweet 命中多个 token
- 普通英文单词误判为 ticker 的防回归

### 2. sentiment 测试

- 一条 tweet 对不同 token 给出不同 sentiment
- 明确看多
- 明确看空
- 公告/转述/不确定语境落 `neutral`

### 3. 关系与去重测试

- 同一 tweet 被主动抓取与交易引用同时命中，仅一条 tweet event
- 多笔交易引用同一 tweet，仅一条 tweet card
- 同一 tweet 下多 token relation 正常展示

### 4. 回填测试

- 新交易到来时实时补抓 tweet
- 最近窗口回填能补齐缺失 tweet
- 已存在 tweet 不重复抓取、不重复投影
- enhancement replay 不依赖重新抓 tweet

## 分阶段实现建议

### Phase 1

- 新增 `twitter_tweet_enrichments`
- 新增 `twitter_tweet_token_mentions`
- tweet 投影 metadata 支持中文与 token 标签
- 对主动抓取到的 tweet 执行增强

### Phase 2

- 新增 `event_tweet_refs`
- 新数据交易引用实时补抓
- 最近窗口历史回填

### Phase 3

- 搜索建议扩展到 tweet token mention
- 增强 replay 工具
- tweet 引用统计与诊断补充

## 风险与取舍

- sentiment 和翻译依赖模型，结果存在波动，因此必须保存版本与状态
- 只做规则抽取会牺牲部分召回，但更适合本期的稳定落盘目标
- 通过把增强与主抓取解耦，可以把失败影响限制在“增强信息缺失”，而不是“tweet 整体缺失”
- 通过把 tweet relation 独立建表，可以避免把未来搜索、聚合、告警都绑死在 `activity_json` 上
