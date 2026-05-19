# 新闻 Feed 与多 TG 频道绑定

## 背景

当前所有信息源（交易/转账/推特/TG）都绑定到具体人物，每个人最多一个 TG 频道。需要支持"新闻"类信息源：不绑定具体人物、一个用户可关联多个 TG 公开频道，且新闻 Feed 默认隐藏。

同时，下游 Agent 需要按 `channel_type` 区分新闻频道 (`news`) 和 KOL 个人频道 (`social`)，在 `telegram_channel_posts` 表中直接过滤，无需 JOIN 用户表。

## 数据流总览

```
telegram_channel_sources (唯一频道配置源)
  ├─ channel_type: 'news' | 'social'
  ├─ userId → 指向带 "news" tag 的用户 或 普通用户
  │
  ├─→ Channel Worker 管线 (MTProto 轮询)
  │     → telegram_channel_posts (含 channel_type)
  │     → events (Feed 展示)
  │
  └─→ Backfill 管线 (历史回填)
        → telegram_channel_posts (含 channel_type)
        → events (Feed 展示)
```

**关键决策**：`telegram_channel_sources` 是唯一频道配置源。废弃 `SystemConfigSnapshot` 中硬编码的 `telegramTradeMonitorSourceChatId` / `telegramTwitterMonitorSourceChatId`，迁移到 `telegram_channel_sources`。

## 设计

### 1. `telegram_channel_sources` 增加 `channel_type` 列

**现状**：表有 `user_id`, `channel_ref`, `source_kind` 等，无频道类型区分。

**改动**：
- DB: `ALTER TABLE telegram_channel_sources ADD COLUMN channel_type TEXT NOT NULL DEFAULT 'social'`
- `TelegramChannelSource` type 增加 `channelType: 'news' | 'social'`
- `upsertTelegramChannelSource` 接收 `channelType` 参数
- 现有从 user telegram 字段 auto 创建的 source 默认 `'social'`；新闻频道手动创建时设为 `'news'`

### 2. `telegram_channel_posts` 增加 `channel_type` 列

**现状**：表无频道类型区分，Agent 无法高效过滤。

**改动**：
- DB: `ALTER TABLE telegram_channel_posts ADD COLUMN channel_type TEXT NOT NULL DEFAULT 'social'`
- `TelegramChannelPost` type 增加 `channelType: 'news' | 'social'`
- `upsertTelegramChannelPost` 接收 `channelType` 参数
- Channel Worker 和 Backfill 入库时从 source 的 `channelType` 传入

### 3. Backfill 管线统一从 `telegram_channel_sources` 读取频道列表

**现状**：`backfillTelegramBridgeHistory` 从 `SystemConfigSnapshot` 硬编码 2 个 chatId 读取。

**改动**：
- `backfillTelegramBridgeHistory` 改为从 `listTelegramChannelSources({ enabledOnly: true })` 读取
- 废弃 `SystemConfigSnapshot.telegramTradeMonitorSourceChatId` / `telegramTwitterMonitorSourceChatId`（保留字段做迁移兼容）
- 迁移逻辑：首次启动时，如果旧字段有值而 `telegram_channel_sources` 中无对应记录，自动插入

### 4. 多 TG 频道绑定

**现状**：`User.telegram` 是单个字符串，`bootstrapTelegramChannelSourcesFromTrackedUsers` 为每个 user 创建一个 auto source。

**改动**：
- `User` 类型增加 `telegrams?: string[]`，存放额外的 TG 频道 URL
- DB: `tracked_users` 表增加 `telegrams_json TEXT NOT NULL DEFAULT '[]'`
- `bootstrapTelegramChannelSourcesFromTrackedUsers` 遍历 `telegram` + `telegrams`，为每个频道各创建一个 auto source
- manage 页面支持为一个人物添加多个 TG 频道

### 5. 新闻 tag + 默认隐藏

**现状**：`User.tags: string[]` 已存在。`FeedSearchFilters.typeFilters` 有 `trade/transfer/twitter/telegram` 四个布尔值，默认全部 `true`。

**改动**：
- `FeedSearchFilters.typeFilters` 增加 `news: boolean`，**默认 `false`**
- `FeedItemCategory` 增加 `'news'`
- `getFeedItemCategory()` 判断：当 item 的 user 含 `"news"` tag 时 → `'news'`（优先于 telegram 判断）
- `matchesFeedSearchFilters()` 对 `news` category 按 `typeFilters.news` 过滤
- 前端按钮栏增加"新闻"按钮，默认不亮（隐藏），点击点亮显示

### 6. 新闻卡片展示

- 新闻类 Activity 的 `source` 仍为 `'telegram'`，`userId` 指向带 `"news"` tag 的用户
- `ActivityCard` 中：当 user 含 `"news"` tag 时，头像/名字用频道信息替代 `user.name`
- type label 显示"新闻"而非"TG"

### 7. 管理页

- manage 页支持创建带 `"news"` tag 的用户并添加多个 TG 频道
- 复用现有 `upsertTelegramChannelSource` API，`channelType` 传 `'news'`

### 8. Agent 查询支持

- `telegram_channel_posts` 的 `channel_type` 列让 Agent 可直接 `WHERE channel_type = 'news'` 过滤
- `telegramAgentReadService` 可按 `channelType` 过滤，无需 JOIN 用户表
