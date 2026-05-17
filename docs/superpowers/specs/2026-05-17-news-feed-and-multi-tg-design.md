# 新闻 Feed 与多 TG 频道绑定

## 背景

当前所有信息源（交易/转账/推特/TG）都绑定到具体人物，每个人最多一个 TG 频道。需要支持"新闻"类信息源：不绑定具体人物、一个用户可关联多个 TG 公开频道，且新闻 Feed 默认隐藏。

## 设计

### 1. 多 TG 频道绑定

**现状**：`User.telegram` 是单个字符串，`bootstrapTelegramChannelSourcesFromTrackedUsers` 为每个 user 创建一个 auto source。

**改动**：
- `User` 类型增加 `telegrams?: string[]`，存放额外的 TG 频道 URL
- `bootstrapTelegramChannelSourcesFromTrackedUsers` 遍历 `telegram` + `telegrams`，为每个频道各创建一个 auto source
- `telegram_channel_sources` 表本身已支持多频道（`user_id + channel_ref_normalized` 联合唯一），无需改表
- manage 页面支持为一个人物添加多个 TG 频道

### 2. 新闻 tag + 默认隐藏

**现状**：`User.tags: string[]` 已存在。`FeedSearchFilters.typeFilters` 有 `trade/transfer/twitter/telegram` 四个布尔值，默认全部 `true`。

**改动**：
- `FeedSearchFilters.typeFilters` 增加 `news: boolean`，**默认 `false`**
- `FeedItemCategory` 增加 `'news'`
- `getFeedItemCategory()` 判断：当 item 的 user 含 `"news"` tag 时 → `'news'`（优先于 telegram 判断）
- `matchesFeedSearchFilters()` 对 `news` category 按 `typeFilters.news` 过滤
- `hasAnyEnabledFeedType()` 增加对 `news` 的检查
- 前端按钮栏增加"新闻"按钮，默认不亮（隐藏），点击点亮显示
- `DEFAULT_FEED_SEARCH_FILTERS.typeFilters.news = false`

### 3. 新闻卡片展示

- 新闻类 Activity 的 `source` 仍为 `'telegram'`，`userId` 指向带 `"news"` tag 的用户
- `ActivityCard` 中：当 user 含 `"news"` tag 时，头像/名字用频道信息（`telegramChannelTitle` / `telegramChannelUsername`）替代 `user.name`
- 在 `activityCardViewModel` 中增加 `isNews` 标记控制展示差异

### 4. 管理页

- manage 页增加"新闻频道"区域，可创建带 `"news"` tag 的用户并添加 TG 频道
- 复用现有 `upsertTelegramChannelSource` API，userId 指向该新闻用户

### 5. 同步

- 现有 `telegramChannelWorker` 已遍历所有 enabled 的 channel source，新闻频道自然被同步
- 入库时 Activity 的 `userId` = 频道对应的 `source.userId`，无需特殊处理
