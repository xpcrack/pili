# Telegram Channel Provider Design

## Goal

为已录入的 Telegram 公开频道建立一条独立的数据源链路，让频道原帖尽快进入 Feed 并落库；当帖子里包含 X/Twitter 链接时，复用现有 Twitter 富化链路做异步补充。

## Problem

当前项目中的 Telegram 集成只覆盖了两类场景：

- 通过 bot bridge 接收特定聊天里的新消息。
- 解析 XXYY 交易播报并投影成链上事件。

用户资料中的 `telegram` 字段目前只是个人资料链接，不会触发任何抓取逻辑。因此，像“旧亿 call”这样的公开频道，即使已经录入到用户资料中，也不会自动进入 Feed。

## Requirements

### Functional

1. 支持把用户资料中的 Telegram 句柄当作频道 source 候选。
2. 支持为某个用户显式配置一个 Telegram 频道 source，并记录同步状态。
3. 支持实时或准实时抓取频道新帖，尽快落库并出现在 Feed。
4. 支持保存 Telegram 原始帖子数据，便于回补、排查和二次投影。
5. 支持提取帖子中的 X/Twitter 链接，并异步触发现有推文富化逻辑。
6. 支持幂等入库和重复投影去重。
7. 支持用户 session 可用时进行历史回补。

### Non-Functional

1. 不破坏现有 `telegram-monitor` 和 `twitter-relay` 链路。
2. 不依赖前端轮询公共网页。
3. 在无 Telegram user session 时，代码应能明确报出“能力未就绪”的状态，而不是静默失败。
4. 继续使用现有 SQLite、worker status、events/feed 投影模式。

## Constraints

- 仅有 `TELEGRAM_API_ID` 和 `TELEGRAM_API_HASH` 还不足以直接拉频道历史；需要用户侧 MTProto session。
- 这次设计优先支持“公开频道原帖 + X 链接富化”，不覆盖群聊评论流、评论区线程、媒体下载、转发源反查的完整能力。
- 这次设计不引入新的前端系统管理 UI，先走 env + 脚本 + repo 内状态存储。

## Architecture

新增一条独立于 bot bridge 的 Telegram channel provider：

1. `telegramSession` 负责解析环境变量和读取本地 session。
2. `telegramChannelSourceRepo` 负责管理频道 source 和同步游标。
3. `telegramChannelPostRepo` 负责保存原始帖子。
4. `telegramChannelIngest` 负责把原始帖子投影为 `Activity` 并写入 `events`。
5. `telegramChannelProjector` 负责构造统一的 Telegram Feed activity。
6. `telegramChannelSync` 负责回补和拉新。
7. `scripts/telegram-channel-login.ts` 负责一次性建立 user session。
8. `scripts/telegram-channel-sync.ts` 负责手动/定时执行回补和同步。

## Data Model

### `telegram_channel_sources`

记录“哪个用户绑定了哪个 Telegram source”。

字段：

- `id`
- `user_id`
- `channel_ref`
- `channel_ref_normalized`
- `channel_title`
- `channel_username`
- `channel_chat_id`
- `access_hash`
- `enabled`
- `sync_status`
- `last_message_id`
- `last_synced_at_ms`
- `last_error`
- `created_at`
- `updated_at`

`channel_ref` 初始可直接存 `@jiuyicall`。后续一旦解析到真实 channel id 和 access hash，就写回表中。

### `telegram_channel_posts`

记录 Telegram 原始帖子，作为事实表。

字段：

- `id`
- `source_id`
- `user_id`
- `channel_chat_id`
- `channel_username`
- `message_id`
- `grouped_id`
- `posted_at_ms`
- `edit_date_ms`
- `text`
- `text_entities_json`
- `media_json`
- `link_urls_json`
- `forward_info_json`
- `views`
- `forwards`
- `replies`
- `raw_json`
- `created_at`
- `updated_at`

唯一键：

- `(channel_chat_id, message_id)`

## Feed Projection

Telegram 频道帖子将投影为：

- `source: 'telegram'`
- `type: 'post'`
- `title: 'Telegram 频道发帖'`
- `content: 帖子正文`

新增 metadata：

- `telegramChatId`
- `telegramChannelUsername`
- `telegramChannelTitle`
- `telegramMessageId`
- `telegramPostUrl`
- `telegramGroupedId`
- `telegramViews`
- `telegramForwards`
- `telegramReplies`
- `telegramLinkUrls`
- `telegramSyncSource`

已有 metadata 复用：

- `rawText`
- `media`
- `tweetUrl`
- `tweetId`
- `likes` / `replies` 仅在语义合理时映射

其中：

- `tweetUrl` / `tweetId` 不直接由 Telegram 原帖填写。
- 帖子中的 X 链接会通过 `event_tweet_refs` 关联到后续富化结果。

## Sync Flow

### Bootstrapping

1. 从 `tracked_users` 读取 `telegram` 字段。
2. 将明显像频道/用户名的值同步到 `telegram_channel_sources`。
3. 若用户已经手动配置过 source，则不覆盖。

### Backfill

1. 读取 source。
2. 用 MTProto client 解析 channel entity。
3. 倒序拉取最近若干条历史消息。
4. 对每条消息写入 `telegram_channel_posts`。
5. 立即投影到 `events`。
6. 更新 `last_message_id` 与 `last_synced_at_ms`。

### Incremental Poll

1. 读取 source 当前游标。
2. 获取大于 `last_message_id` 的新消息。
3. 原始帖幂等写入。
4. 投影到 `events`。
5. 提取 X 链接并触发 tweet ref 富化。
6. 更新 worker status 和 source 状态。

## Session Strategy

最小可行实现采用 Telegram user session：

- env:
  - `TELEGRAM_API_ID`
  - `TELEGRAM_API_HASH`
  - `TELEGRAM_SESSION_STRING`
- 脚本：
  - `telegram-channel-login.ts` 通过手机号登录并输出 session string

如果 `TELEGRAM_SESSION_STRING` 缺失：

- 允许仓库启动
- 同步脚本和同步服务返回明确错误
- 不影响其他 source

## X/Twitter Enrichment

对每条 Telegram 原帖：

1. 提取正文、实体和按钮中的 X/Twitter URL。
2. 过滤出状态页链接。
3. 使用现有 `upsertEventTweetRefAndFetchMissing`。
4. 异步补充 tweet 内容，不阻塞 Telegram 原帖进入 Feed。

## Error Handling

- session 缺失：标记 source `sync_status = 'auth_required'`
- channel 不存在或无访问权限：标记 `sync_status = 'unavailable'`
- Telegram API 限流：记录 `last_error`，下次继续
- 单条消息解析失败：跳过该条并保留原始 `raw_json`

## Testing

1. repo 层测试：
   - source upsert / state update / last message cursor
   - raw post upsert 幂等
2. projector 测试：
   - Telegram 原帖 -> Activity 映射
3. ingest 测试：
   - 原帖入库后写入 `events`
   - 帖子中的 X 链接能建立 tweet refs
4. sync 层测试：
   - 使用 stub client 模拟历史回补和增量拉新

## Rollout

Phase 1:

- schema
- repo
- projector
- ingest
- login/sync scripts
- 单频道手动同步

Phase 2:

- 定时 worker
- 自动从 `tracked_users.telegram` 衍生 source
- worker status / diagnostics

## Out of Scope

- 评论区抓取
- 下载 Telegram 图片/视频二进制
- 所有转发源的完整反查
- 前端 system 配置页的 Telegram source 管理界面
