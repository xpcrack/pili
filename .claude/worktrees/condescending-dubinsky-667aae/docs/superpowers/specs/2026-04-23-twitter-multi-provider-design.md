# Twitter 多 Provider 分层抓取设计

日期：2026-04-23  
状态：草案（已在 brainstorming 过程中确认）  
负责人：Twitter ingestion pipeline

## 1. 背景与问题
当前 Twitter 主动抓取链路以 `opencli` / `dokobot` 为主。实际问题是：
- 抓取慢，单次请求耗时长。
- 结果不稳定，内容易缺字段或抽取错误。
- 历史补齐、详情回查、增量同步共用同一套弱结构化来源，排障困难。

项目已经具备一套稳定的下游链路：
- `twitterFetcher` 负责统一抓取入口。
- `twitterSyncService` 负责增量同步、回填、补链调度。
- `twitterRepo` / `twitterFeedMapper` 负责落库与 feed 投影。

本期目标不是重写整个 Twitter pipeline，而是把“上游数据源选择与调度”升级为可控、可观测、可按预算分层的 provider 架构。

## 2. 目标与非目标
目标：
- 引入两个结构化 Twitter 服务商：
  - `6551`：有两条 API 凭证，每条凭证每天 100 次免费成功调用额度。
  - `Xread`：付费 API，无每日免费额度。
- 把 `6551` 免费额度优先吃满，再自动切到 `Xread`。
- 保留现有 `opencli` / `dokobot` 作为最终兜底，而非主路径。
- 保持现有 `twitterFetcher -> twitterSyncService -> twitterRepo -> twitterFeedMapper` 主链路不变。
- 新增 `handle -> twitter user id` 缓存，避免每次同步重复解析用户 ID。
- 统一支持三类读取：
  - 增量同步（timeline / replies）
  - 按 `tweetId` 详情回查与补链
  - 历史补齐 / backfill
- 增加 provider 级预算、健康、fallback 观测，便于定位慢、错、额度用尽等问题。

非目标：
- 本期不改 bot2bot relay 入库链路。
- 不要求前台用户录入 `twitter user id`。
- 不重做 feed 投影、活动卡片展示、事件 schema。
- 不把远端分页 cursor 作为主同步状态持久化。

## 3. 已确认产品与运行决策
- 采用方案 1：在 `twitterFetcher` 内新增统一 provider 路由层，而不是重写整个 pipeline。
- `6551` 和 `Xread` 并存，按预算优先级路由。
- `6551` 有两条独立凭证。
- `6551` 每条凭证每天 100 分，按“成功请求次数”本地计分。
- 一次成功请求无论返回 1 条还是 20 条 tweet，本地都只记 1 分。
- `6551` 失败请求不扣本地分。
- `6551` 预算按 `UTC+8` 自然日重置，即北京时间每天 `00:00` 重置。
- `6551` 免费额度优先使用；耗尽后自动切到 `Xread`。
- `Xread` 承接增量同步、详情回查、历史补齐。
- `opencli` / `dokobot` 仅作为最后兜底，不再作为常规主路径。
- `handle -> user_id` 由系统自动解析并缓存，不要求人工维护。
- 新 provider 覆盖范围包括：
  - 增量同步
  - 详情回查 / 补链
  - 历史补齐
- 新 provider 请求失败时：先重试，再 fallback。

## 4. 总体架构
### 4.1 保持单一抓取入口
- `twitterFetcher` 继续作为 Twitter 抓取唯一统一入口。
- 对外接口保持“按用户抓 lane”“按 tweetId 批量抓详情”的抽象，不把上游 provider 差异泄漏到 `twitterSyncService`。
- `twitterSyncService` 继续只关心标准化后的 `UpsertTwitterTweetInput`。

### 4.2 Provider 分层
内部 provider 顺序固定为：
1. `6551-key-1`
2. `6551-key-2`
3. `Xread`
4. `opencli`
5. `dokobot`

含义：
- `6551` 是免费额度池，优先使用。
- `Xread` 是结构化付费主力补位层。
- `opencli` / `dokobot` 是弱结构化最终兜底层。

### 4.3 新增两类持久化状态
- `twitter_identity_cache`
  用于缓存 `handle -> twitter user id`。
- `twitter_provider_budget`
  用于记录 `6551` 两条凭证的每日预算、健康状态、冷却时间。

## 5. Provider 能力边界
### 5.1 6551
作为免费额度优先 provider，承担：
- 根据用户名查询用户资料 / user id
- 获取用户 tweets / replies
- 根据 `tweetId` 获取 tweet 详情

定位：
- 优先用于日常增量同步和详情补链。
- 当额度仍充足时，也允许参与历史补齐。

### 5.2 Xread
作为结构化付费 provider，承担：
- 根据用户名解析 `user_id`
- 获取 timeline / replies
- 根据 `tweetId` 获取详情
- 在 `6551` 额度耗尽或不可用时承接主流量

定位：
- 免费额度用尽后的主路径。
- 历史补齐的大流量承接层。

### 5.3 OpenCLI / Dokobot
作为兼容兜底 provider，承担：
- 在结构化 provider 全部失败时补救性抓取

定位：
- 非默认路径。
- 仅用于降低完全断流风险。

## 6. 路由与预算规则
### 6.1 路由入口
`twitterFetcher` 内部增加一个轻量 `provider router`，专门负责决定当前请求使用哪个 provider / credential。

router 输入至少包含：
- `intent`: `sync | backfill | detail | resolve-id`
- `lane`: `timeline | replies | none`
- `handle`
- `tweetIds`

### 6.2 6551 每日预算规则
对每条 `6551` 凭证，按北京时间自然日维护：
- `daily_limit = 100`
- `success_units_used`
- `remaining_units = daily_limit - success_units_used`

本地计分规则：
- 成功请求：`success_units_used += 1`
- 失败请求：不扣分
- 一次成功请求无论返回多少 tweet，都只算 1 分

日期键生成规则：
- 使用 `Asia/Shanghai` 计算 `date_key`
- 例如 `2026-04-23`
- 到北京时间 `00:00` 后，新的 `date_key` 从 0 开始重新计数

### 6.3 6551 凭证轮换
选择规则：
- 只选择“当日仍有剩余额度”且“不在 cooldown 中”的凭证。
- 两条凭证都可用时，优先选剩余额度更多的那条。
- 若剩余额度相同，优先选最近失败更少或最近成功更新较近的那条。

### 6.4 fallback 规则
对于单次请求：
1. 先选择可用的 `6551` 凭证。
2. `6551` 当前凭证失败后，本地重试 1 到 2 次。
3. 若仍失败，则切换另一条可用 `6551` 凭证。
4. 若两条 `6551` 都额度耗尽、不可用或重试失败，则切到 `Xread`。
5. `Xread` 失败后，再切到 `opencli`。
6. `opencli` 失败后，最后切到 `dokobot`。

fallback 必须是“局部降级”，而不是“一次失败整轮同步全部切 provider”：
- 某个用户某个 lane 失败，只降级该用户该 lane。
- 某批 `tweetIds` 详情回查失败，只降级该批回查。

### 6.5 backfill 的倾向性规则
为了更合理地消耗免费额度，router 允许按 `intent` 调整倾向：
- `sync` / `detail`：尽量优先压满 `6551`
- `backfill`：先试 `6551`，但更容易提前切到 `Xread`

原因：
- 增量同步和详情补链更值得吃免费额度。
- 大窗口 backfill 更关注稳定完成，不应长时间消耗免费额度后再失败。

## 7. Identity Cache 设计
### 7.1 目标
现有 `tracked_users` 只有 `twitter handle`。新结构化 provider 拉 timeline / replies 时通常需要 `user_id`，因此需要独立缓存层。

### 7.2 建议字段
`twitter_identity_cache`
- `handle`
- `provider`
- `user_id`
- `username`
- `resolved_at_ms`
- `expires_at_ms`
- `last_error`
- `updated_at_ms`

### 7.3 行为规则
- 同步前先查缓存。
- 命中且未过期：直接使用缓存的 `user_id`。
- 缓存缺失或过期：先调用 provider 解析，再写回缓存。
- 解析失败时写入短 TTL 负缓存，避免同一轮同步内反复打坏请求。
- `handle` 与 `user_id` 分离存储，不污染 `tracked_users` 现有字段语义。

## 8. 数据流设计
### 8.1 增量同步
- `twitterSyncService` 读取本地 cursor，计算 `sinceMs`。
- 调用 `twitterFetcher.fetchUserTweets({ handle, lane, sinceMs, maxItems, intent: 'sync' })`
- `twitterFetcher` 内部：
  - 先通过 identity cache 拿到 `user_id`
  - 通过 router 选择 provider
  - 拉取 timeline / replies
  - 标准化为 `UpsertTwitterTweetInput`
- 下游继续复用当前逻辑：
  - `twitterRepo.upsertTwitterTweets`
  - `projectTwitterTweetsToFeed`
  - 更新 watermark / cursor

### 8.2 历史补齐 / backfill
- 仍然复用本地 `sinceMs + watermark` 模型，不把远端 cursor 作为主持久化状态。
- 远端分页 cursor 只用于单次 run 内部翻页。
- 每个 lane 连续请求分页，直到满足任一条件：
  - 无更多数据
  - 最老 tweet 已早于 `sinceMs`
  - 达到本轮 `maxItems`
- backfill 与 sync 走同一 provider 框架，只是 `intent = 'backfill'`。

### 8.3 按 tweetId 详情回查 / 补链
- `twitterSyncService` 在补 reply / quote 关联时，调用 `fetchTweetsByIds({ ids, intent: 'detail' })`
- 优先走 `6551`
- `6551` 不可用或额度耗尽时切 `Xread`
- `Xread` 再失败时才切 `opencli` / `dokobot`

### 8.4 relay 链路
- `twitterRelayIngest` 与 bot2bot relay 入库链路本期保持不变。
- 该链路与主动抓取 provider 逻辑解耦，避免风险面扩大。

## 9. 标准化与解析策略
### 9.1 标准化出口
无论使用哪个 provider，都必须统一产出：
- `tweetId`
- `authorHandle`
- `authorName`
- `fullText`
- `createdAtMs`
- `lane`
- `conversationId`
- `replyToTweetId`
- `quoteTweetId`
- 互动指标
- `source`

### 9.2 结构化 provider 优先
- 优先以 `6551` / `Xread` 提供的结构化字段为准。
- 尽量避免再从文本中猜 `replyToTweetId` 或 `quoteTweetId`。
- 只有最终兜底到 `opencli` / `dokobot` 时，才沿用当前文本推断逻辑。

## 10. 错误处理
建议把错误至少分为以下几类：
- `identity_resolution_failed`
- `provider_request_failed`
- `provider_parse_failed`
- `provider_budget_exhausted`
- `provider_cooldown_active`
- `fallback_succeeded`

行为要求：
- 单 provider 失败不应直接终止整轮同步。
- 单个 handle 解析失败不应阻塞其他用户。
- 单批 `tweetIds` 回查失败不应让整个 backfill 直接失效。
- fallback 成功必须在日志中可见，而不是静默吞掉主 provider 失败。

## 11. 观测与诊断
### 11.1 同步汇总
在现有 `providerHits` 基础上增加：
- `providerUnitsUsed`
- `providerFailures`
- `fallbackCounts`
- `identityCacheHit`
- `identityCacheMiss`
- `identityCacheNegativeHit`

### 11.2 日志上下文
每次 provider 调用日志至少带上：
- `provider`
- `credential_id`
- `intent`
- `phase`
- `handle`
- `lane`
- `tweet_count`
- `unit_charged`
- `date_key`

其中 `phase` 至少包括：
- `resolve-id`
- `fetch-lane`
- `fetch-detail`
- `fetch-backfill`

### 11.3 预算可观测性
至少能回答这些问题：
- 今天 `6551-key-1` 用了多少分
- 今天 `6551-key-2` 用了多少分
- 何时开始切到 `Xread`
- 哪类请求最耗免费额度：`sync`、`detail` 还是 `backfill`

## 12. 配置项
建议新增环境变量：
- `TWITTER_6551_API_KEY_1`
- `TWITTER_6551_API_KEY_2`
- `TWITTER_XREAD_BASE_URL`
- `TWITTER_XREAD_API_KEY`
- `TWITTER_PROVIDER_RETRY_MAX`
- `TWITTER_PROVIDER_HTTP_TIMEOUT_MS`

现有：
- `TWITTER_FETCH_PROVIDER`

建议保留，但 `auto` 模式下的新默认顺序改为：
- `6551 -> Xread -> opencli -> dokobot`

## 13. 测试策略
单元测试：
- `6551` / `Xread` 返回结构到标准 tweet 的解析测试
- `handle -> user_id` 解析与缓存测试
- `UTC+8` `date_key` 与每日预算重置测试
- “成功请求记 1 分、失败请求不记分”预算测试
- router 在多 key、cooldown、额度耗尽下的选路测试

集成测试：
- 增量同步优先使用 `6551`，额度不足后切 `Xread`
- 详情补链优先使用 `6551`
- backfill 在预算压力下切 `Xread`
- `6551` 单 key 失败后切另一 key
- 结构化 provider 全失败后降级到 `opencli` / `dokobot`

回归测试：
- `twitterSyncService` 的存储、watermark、投影逻辑不回退
- relay 链路不受影响
- feed 展示与事件生成不回退

## 14. 验收标准
- 日常 Twitter 同步默认优先使用 `6551`，并按本地规则消耗免费额度。
- `6551` 每条凭证每天最多本地记 100 分，按北京时间 `00:00` 重置。
- 两条 `6551` 凭证合计免费额度优先吃满后，系统自动切到 `Xread`。
- `Xread` 不可用时，系统可继续最终降级到 `opencli` / `dokobot`。
- `handle -> user_id` 自动解析并缓存，无需人工补录。
- 增量同步、详情回查、历史补齐均走统一 provider 架构。
- 同步日志中可以清楚看出：
  - 本次用了哪个 provider
  - 是否发生 fallback
  - `6551` 今日已用多少分

## 15. 下一步实施计划范围
后续 implementation plan 应拆成可并行的独立工作流：
1. 新增 `6551` / `Xread` provider client 与标准化解析。
2. 在 `twitterFetcher` 内引入 provider router、retry、fallback。
3. 新增 identity cache 与 provider budget 持久化。
4. 接入 `twitterSyncService` 的 `intent`、lane 与日志上下文。
5. 补充测试夹具、预算测试、router 测试与同步集成测试。
6. 增强 `/api/twitter/sync` 状态与诊断信息，展示 provider 与预算摘要。
