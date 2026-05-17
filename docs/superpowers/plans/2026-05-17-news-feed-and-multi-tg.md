# 新闻 Feed 与多 TG 频道绑定 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 支持新闻类信息源（不绑定具体人物、一个用户可关联多个 TG 频道），新闻 Feed 默认隐藏可手动开关，同时让下游 Agent 能按 `channel_type` 高效过滤。

**Architecture:** 以 `telegram_channel_sources` 为唯一频道配置源，增加 `channel_type` 列；`telegram_channel_posts` 增加 `channel_type` 列供 Agent 直接查询；Backfill 管线统一从 channel sources 读取；User 体系增加 `telegrams` 多频道支持；Feed 通过 `"news"` tag 标识新闻用户，`typeFilters.news` 默认 `false`。

**Tech Stack:** Next.js, React, SQLite (better-sqlite3), TypeScript

---

### Task 1: `telegram_channel_sources` 增加 `channel_type` 列

**Files:**
- Modify: `lib/server/sqlite.ts`
- Modify: `lib/server/telegramChannelTypes.ts`
- Modify: `lib/server/telegramChannelSourceRepo.ts`

- [ ] **Step 1: 在 `sqlite.ts` 的 `telegram_channel_sources` CREATE TABLE 中增加 `channel_type` 列**

在现有列之后添加：

```sql
channel_type TEXT NOT NULL DEFAULT 'social',
```

在迁移区域添加：

```typescript
try {
  db.exec(`ALTER TABLE telegram_channel_sources ADD COLUMN channel_type TEXT NOT NULL DEFAULT 'social'`);
} catch {
  // 列已存在
}
```

- [ ] **Step 2: 在 `TelegramChannelSource` interface 中增加 `channelType` 字段**

在 `lib/server/telegramChannelTypes.ts` 的 `TelegramChannelSource` 中：

```typescript
channelType: 'news' | 'social';
```

- [ ] **Step 3: 在 `telegramChannelSourceRepo.ts` 中适配 `channel_type`**

- `TelegramChannelSourceRow` 增加 `channel_type: string`
- 新增 `normalizeChannelType` 函数：

```typescript
function normalizeChannelType(value: string | null | undefined): 'news' | 'social' {
  return value === 'news' ? 'news' : 'social';
}
```

- `mapRow` 中增加 `channelType: normalizeChannelType(row.channel_type)`
- `upsertTelegramChannelSource` 增加 `channelType?: 'news' | 'social'` 参数，INSERT/UPDATE 中增加 `channel_type` 列
- `listTelegramChannelSources` 的 SELECT 增加 `channel_type`
- `getTelegramChannelSourceById` 的 SELECT 增加 `channel_type`
- `updateTelegramChannelSourceState` 的 SELECT 和 UPDATE 增加 `channel_type`

- [ ] **Step 4: 在 `bootstrapTelegramChannelSourcesFromTrackedUsers` 中，auto source 的 `channelType` 默认 `'social'`**

现有逻辑不变，`upsertTelegramChannelSource` 调用不传 `channelType`，默认 `'social'`。

- [ ] **Step 5: Commit**

```bash
git add lib/server/sqlite.ts lib/server/telegramChannelTypes.ts lib/server/telegramChannelSourceRepo.ts
git commit -m "feat(db): add channel_type column to telegram_channel_sources"
```

---

### Task 2: `telegram_channel_posts` 增加 `channel_type` 列

**Files:**
- Modify: `lib/server/sqlite.ts`
- Modify: `lib/server/telegramChannelTypes.ts`
- Modify: `lib/server/telegramChannelPostRepo.ts`

- [ ] **Step 1: 在 `sqlite.ts` 的 `telegram_channel_posts` CREATE TABLE 中增加 `channel_type` 列**

在 `link_urls_json TEXT NOT NULL DEFAULT '[]',` 之后添加：

```sql
channel_type TEXT NOT NULL DEFAULT 'social',
```

在迁移区域添加：

```typescript
try {
  db.exec(`ALTER TABLE telegram_channel_posts ADD COLUMN channel_type TEXT NOT NULL DEFAULT 'social'`);
} catch {
  // 列已存在
}
```

- [ ] **Step 2: 在 `TelegramChannelPost` interface 中增加 `channelType` 字段**

在 `lib/server/telegramChannelTypes.ts` 的 `TelegramChannelPost` 中：

```typescript
channelType: 'news' | 'social';
```

- [ ] **Step 3: 在 `telegramChannelPostRepo.ts` 中适配 `channel_type`**

- `TelegramChannelPostRow` 增加 `channel_type: string`
- `mapRow` 中增加 `channelType: (row.channel_type === 'news' ? 'news' : 'social') as 'news' | 'social'`
- `upsertTelegramChannelPost` 增加 `channelType?: 'news' | 'social'` 参数，INSERT/UPDATE 中增加 `channel_type` 列，默认 `'social'`
- `getTelegramChannelPostByMessage` 的 SELECT 增加 `channel_type`

- [ ] **Step 4: Commit**

```bash
git add lib/server/sqlite.ts lib/server/telegramChannelTypes.ts lib/server/telegramChannelPostRepo.ts
git commit -m "feat(db): add channel_type column to telegram_channel_posts"
```

---

### Task 3: Channel Worker 入库时传入 `channel_type`

**Files:**
- Modify: `lib/server/telegramChannelSync.ts`

- [ ] **Step 1: 在 `storeAndProjectTelegramChannelMessages` 中传入 `channelType`**

在 `upsertTelegramChannelPost` 调用中增加 `channelType: params.source.channelType`：

```typescript
const stored = upsertTelegramChannelPost({
  channelChatId: params.resolved.channelChatId,
  // ...existing params...
  channelType: params.source.channelType,
});
```

- [ ] **Step 2: Commit**

```bash
git add lib/server/telegramChannelSync.ts
git commit -m "feat(sync): pass channel_type from source to post on ingest"
```

---

### Task 4: User 类型增加 `telegrams` 字段

**Files:**
- Modify: `types/index.ts`

- [ ] **Step 1: 在 `User` interface 中增加 `telegrams` 可选字段**

在 `telegram` 字段之后添加：

```typescript
telegrams?: string[];
```

- [ ] **Step 2: Commit**

```bash
git add types/index.ts
git commit -m "feat(types): add telegrams field to User type"
```

---

### Task 5: DB schema 增加 `telegrams_json` 列 + 持久化适配

**Files:**
- Modify: `lib/server/sqlite.ts`
- Modify: `lib/server/trackedUsersRepo.ts`

- [ ] **Step 1: 在 `sqlite.ts` 的 `tracked_users` CREATE TABLE 中增加 `telegrams_json` 列**

在 `telegram TEXT,` 行之后添加：

```sql
telegrams_json TEXT NOT NULL DEFAULT '[]',
```

在迁移区域添加：

```typescript
try {
  db.exec(`ALTER TABLE tracked_users ADD COLUMN telegrams_json TEXT NOT NULL DEFAULT '[]'`);
} catch {
  // 列已存在
}
```

- [ ] **Step 2: 在 `trackedUsersRepo.ts` 的 `TrackedUserRow` interface 中增加字段**

```typescript
interface TrackedUserRow {
  // ...existing fields...
  telegrams_json: string;
}
```

- [ ] **Step 3: 添加 `parseTelegramList` 辅助函数**

在 `parseTags` 函数附近添加：

```typescript
function parseTelegramList(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: 在 `mapUserRow` 中解析 `telegrams_json`**

在 `telegram: row.telegram || undefined,` 之后添加：

```typescript
telegrams: parseTelegramList(row.telegrams_json),
```

- [ ] **Step 5: 在 `upsertUserRow` 中持久化 `telegrams_json`**

修改 INSERT 语句：在 `telegram,` 之后加 `telegrams_json,`，VALUES 加 `?,`，ON CONFLICT UPDATE 加 `telegrams_json = excluded.telegrams_json,`，`.run()` 调用在 `user.telegram ?? null,` 之后加 `JSON.stringify(user.telegrams ?? []),`。

- [ ] **Step 6: Commit**

```bash
git add lib/server/sqlite.ts lib/server/trackedUsersRepo.ts
git commit -m "feat(db): add telegrams_json column to tracked_users"
```

---

### Task 6: `bootstrapTelegramChannelSourcesFromTrackedUsers` 支持多 TG

**Files:**
- Modify: `lib/server/telegramChannelSourceRepo.ts`

- [ ] **Step 1: 修改 bootstrap 函数遍历 `telegram` + `telegrams`**

替换 `bootstrapTelegramChannelSourcesFromTrackedUsers` 函数体：

```typescript
export function bootstrapTelegramChannelSourcesFromTrackedUsers() {
  return withTransaction(() => {
    let count = 0;
    const db = getDb();
    for (const user of listTrackedUsers()) {
      const allChannels = [
        normalizeOptional(user.telegram),
        ...(user.telegrams || []).map((t) => normalizeOptional(t)),
      ].filter((t): t is string => t.length > 0);

      const autoSources = db
        .prepare(
          `SELECT id, channel_ref_normalized
           FROM telegram_channel_sources
           WHERE user_id = ?
             AND source_kind = 'auto'`
        )
        .all(user.id) as Array<{ id: string; channel_ref_normalized: string }>;

      const currentNormalized = new Set(
        allChannels.map((ch) => normalizeChannelRef(ch).channelRefNormalized).filter(Boolean)
      );

      for (const channel of allChannels) {
        const normalized = normalizeChannelRef(channel).channelRefNormalized;
        if (!normalized) continue;
        upsertTelegramChannelSource({
          userId: user.id,
          channelRef: channel,
          sourceKind: 'auto',
        });
        count += 1;
      }

      for (const staleSource of autoSources) {
        if (currentNormalized.has(staleSource.channel_ref_normalized)) {
          continue;
        }
        db.prepare(
          `UPDATE telegram_channel_sources
           SET enabled = 0,
               channel_title = null,
               channel_username = null,
               channel_chat_id = null,
               access_hash = null,
               sync_status = 'pending',
               last_message_id = null,
               last_synced_at_ms = null,
               last_error = null,
               updated_at = ?
           WHERE id = ?`
        ).run(Date.now(), staleSource.id);
      }
    }
    return count;
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add lib/server/telegramChannelSourceRepo.ts
git commit -m "feat(telegram): bootstrap channel sources from multiple TG channels per user"
```

---

### Task 7: Backfill 管线统一从 `telegram_channel_sources` 读取

**Files:**
- Modify: `lib/server/telegramBridgeMtprotoBackfill.ts`

- [ ] **Step 1: 修改 `backfillTelegramBridgeHistory` 从 channel sources 读取目标**

将 `targets` 的构建逻辑从硬编码 SystemConfig 改为从 `telegram_channel_sources` 读取：

```typescript
import { listTelegramChannelSources } from '@/lib/server/telegramChannelSourceRepo';

// 在函数内部，替换原来的 targets 构建逻辑：
const channelSources = listTelegramChannelSources({ enabledOnly: true });
const targets = channelSources
  .filter((source) => source.channelChatId)
  .map((source) => ({
    chatId: source.channelChatId!,
    mode: source.channelType === 'news' ? 'telegram-monitor' as const : 'telegram-monitor' as const,
    channelType: source.channelType,
    label: source.channelTitle || source.channelRef,
  }));
```

注意：所有频道统一走 `telegram-monitor` mode（即 `ingestTelegramMonitorUpdate`），因为 backfill 管线走的是 `telegram_channel_posts` 入库路径。原来的 `twitter-relay` mode 频道在迁移后改为 `telegram-monitor` mode。

- [ ] **Step 2: 将 `channelType` 传递给 ingest 调用**

在 backfill 的 ingest 循环中，把 `channelType` 传递给 `ingestTelegramMonitorUpdate`：

```typescript
const payload = await ingestTelegramMonitorUpdate(message, target.channelType);
```

- [ ] **Step 3: Commit**

```bash
git add lib/server/telegramBridgeMtprotoBackfill.ts
git commit -m "feat(backfill): read channel targets from telegram_channel_sources instead of SystemConfig"
```

---

### Task 8: `ingestTelegramMonitorUpdate` 接收 `channelType` 参数

**Files:**
- Modify: `lib/server/telegramMonitorIngest.ts`

- [ ] **Step 1: 修改函数签名增加可选 `channelType` 参数**

```typescript
export async function ingestTelegramMonitorUpdate(
  update: TelegramUpdateLike,
  channelType?: 'news' | 'social',
)
```

- [ ] **Step 2: 在 ingest 逻辑中，当写入 `telegram_channel_posts` 时传入 `channelType`**

找到 ingest 中存储 channel post 的位置，传入 `channelType`。如果 ingest 不直接写 `telegram_channel_posts`（而是写 `telegram_monitor_events`），则在 event metadata 中记录 `channel_type`，供后续查询使用。

- [ ] **Step 3: Commit**

```bash
git add lib/server/telegramMonitorIngest.ts
git commit -m "feat(ingest): accept channelType parameter for news/social classification"
```

---

### Task 9: `FeedSearchFilters` 增加 `news` 过滤器

**Files:**
- Modify: `lib/smartSearch.ts`

- [ ] **Step 1: 在 `FeedSearchFilters.typeFilters` 中增加 `news` 字段**

```typescript
export interface FeedSearchFilters {
  keyword: string;
  typeFilters: {
    trade: boolean;
    transfer: boolean;
    twitter: boolean;
    telegram: boolean;
    news: boolean;
  };
  minTradeAmountUsd: string;
  minTradeMarketCapUsd: string;
}
```

- [ ] **Step 2: 更新 `DEFAULT_FEED_SEARCH_FILTERS`，`news` 默认 `false`**

```typescript
export const DEFAULT_FEED_SEARCH_FILTERS: FeedSearchFilters = {
  keyword: '',
  typeFilters: {
    trade: true,
    transfer: true,
    twitter: true,
    telegram: true,
    news: false,
  },
  minTradeAmountUsd: '',
  minTradeMarketCapUsd: '',
};
```

- [ ] **Step 3: `FeedItemCategory` 增加 `'news'`**

```typescript
export type FeedItemCategory = 'trade' | 'transfer' | 'twitter' | 'telegram' | 'news' | 'other';
```

- [ ] **Step 4: 修改 `getFeedItemCategory` 识别新闻类型**

```typescript
export function getFeedItemCategory(item: FeedItem): FeedItemCategory {
  if (item.user.tags.includes('news')) {
    return 'news';
  }
  if (item.activity.source === 'twitter') {
    return 'twitter';
  }
  if (item.activity.source === 'telegram') {
    return 'telegram';
  }
  if (isTradeDisplayAction(item.activity.metadata)) {
    return 'trade';
  }
  const action = item.activity.metadata.txAction;
  if (action === 'send' || action === 'receive') {
    return 'transfer';
  }
  return 'other';
}
```

- [ ] **Step 5: 修改 `matchesFeedSearchFilters` 处理 `news` category**

在 `telegram` 判断之后添加：

```typescript
if (category === 'news' && !filters.typeFilters.news) {
  return false;
}
```

- [ ] **Step 6: 修改 `hasAnyEnabledFeedType` 增加 `news` 检查**

```typescript
export function hasAnyEnabledFeedType(typeFilters: FeedSearchFilters['typeFilters']) {
  return typeFilters.trade || typeFilters.transfer || typeFilters.twitter || typeFilters.telegram || typeFilters.news;
}
```

- [ ] **Step 7: Commit**

```bash
git add lib/smartSearch.ts
git commit -m "feat(search): add news type filter (default hidden)"
```

---

### Task 10: `feedPageState` 适配 `news` 过滤器

**Files:**
- Modify: `lib/feed/feedPageState.ts`

- [ ] **Step 1: 更新 `hasActiveFeedLocalFilters` 包含 `news`**

```typescript
export function hasActiveFeedLocalFilters(searchFilters: FeedSearchFilters) {
  return (
    searchFilters.keyword.trim().length > 0 ||
    !searchFilters.typeFilters.trade ||
    !searchFilters.typeFilters.transfer ||
    !searchFilters.typeFilters.twitter ||
    !searchFilters.typeFilters.telegram ||
    searchFilters.typeFilters.news ||
    searchFilters.minTradeAmountUsd.trim().length > 0 ||
    searchFilters.minTradeMarketCapUsd.trim().length > 0
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add lib/feed/feedPageState.ts
git commit -m "feat(feed): adapt feedPageState for news filter"
```

---

### Task 11: Feed 页面增加"新闻"筛选按钮

**Files:**
- Modify: `app/page.tsx`

- [ ] **Step 1: 在筛选按钮数组中增加 `news` 项**

在 `['telegram', 'TG']` 之后添加 `['news', '新闻']`：

```typescript
{[
  ['trade', '交易'],
  ['transfer', '转账'],
  ['twitter', '推特'],
  ['telegram', 'TG'],
  ['news', '新闻'],
].map(([key, label]) => {
```

- [ ] **Step 2: Commit**

```bash
git add app/page.tsx
git commit -m "feat(feed): add news filter button"
```

---

### Task 12: 新闻卡片展示适配

**Files:**
- Modify: `lib/activityCardViewModel.ts`
- Modify: `lib/activityCardSocial.ts`
- Modify: `components/ActivityCard.tsx`

- [ ] **Step 1: 在 `activityCardViewModel` 中增加 `isNews` 标记**

在 `buildActivityCardViewModel` 中，`isTelegram` 之后添加：

```typescript
const isNews = user.tags.includes('news');
```

计算频道标签：

```typescript
const newsChannelLabel = isNews && isTelegram
  ? (activity.metadata.telegramChannelTitle || activity.metadata.telegramChannelUsername || '新闻频道')
  : null;
```

在返回对象中增加 `isNews` 和 `newsChannelLabel`。

- [ ] **Step 2: 修改 `getActivityCardTypeLabel` 让新闻卡片显示"新闻"**

在 `lib/activityCardSocial.ts` 的 `getActivityCardTypeLabel` 中增加 `isNews` 参数：

```typescript
export function getActivityCardTypeLabel(params: {
  source: Activity['source'];
  activityType: Activity['type'];
  twitterKindLabel: string | null;
  isNews?: boolean;
}) {
  if (params.isNews) {
    return '新闻';
  }
  // ...rest unchanged
```

- [ ] **Step 3: 在 `ActivityCard.tsx` 中使用 `isNews` 和 `newsChannelLabel`**

- 从 `buildActivityCardViewModel` 解构增加 `isNews` 和 `newsChannelLabel`
- 用户名显示处替换为 `{isNews && newsChannelLabel ? newsChannelLabel : user.name}`
- `getActivityCardTypeLabel` 调用增加 `isNews`

- [ ] **Step 4: Commit**

```bash
git add lib/activityCardViewModel.ts lib/activityCardSocial.ts components/ActivityCard.tsx
git commit -m "feat(card): display channel info for news-tagged activities"
```

---

### Task 13: 管理页支持多 TG 和新闻用户创建

**Files:**
- Modify: `app/manage/page.tsx`

- [ ] **Step 1: 在 `ProfileFormState` 中增加 `telegrams` 字段**

```typescript
interface ProfileFormState {
  name: string;
  handle: string;
  twitter: string;
  telegram: string;
  telegrams: string;
  tags: string;
}
```

更新 `resetForm` 和初始值增加 `telegrams: ''`。

- [ ] **Step 2: 在 `handleSave` 中处理 `telegrams` 字段**

在 `addUser` 调用中增加：

```typescript
telegrams: formData.telegrams.split(',').map((t) => t.trim()).filter(Boolean),
```

- [ ] **Step 3: 在创建表单中增加"额外 TG 频道"输入框**

在 Telegram 输入框之后添加：

```tsx
<div className="space-y-2">
  <Label className="text-zinc-300">额外 TG 频道</Label>
  <Input
    value={formData.telegrams}
    onChange={(e) => setFormData({ ...formData, telegrams: e.target.value })}
    placeholder="多个频道用逗号分隔，例如: channel1, channel2"
    className="border-zinc-800 bg-zinc-950 text-zinc-100"
  />
</div>
```

- [ ] **Step 4: 在用户列表表格中显示额外频道数量**

在 TG 列中，`telegramUrl` 显示之后：

```tsx
{user.telegrams && user.telegrams.length > 0 ? (
  <div className="text-[11px] text-zinc-500">
    +{user.telegrams.length} 频道
  </div>
) : null}
```

- [ ] **Step 5: Commit**

```bash
git add app/manage/page.tsx
git commit -m "feat(manage): support multiple TG channels and news tag"
```

---

### Task 14: API 层适配 `telegrams` 字段

**Files:**
- Modify: `app/api/users/route.ts`
- Modify: `lib/server/userPayload.ts`

- [ ] **Step 1: 确认 `sanitizeUsersPayload` 正确传递 `telegrams`**

检查 `userPayload.ts`，确保 `telegrams` 字段在白名单/清理逻辑中不被丢弃。

- [ ] **Step 2: 确认 `POST /api/users` 的 `createTrackedUser` 包含 `telegrams`**

在 `app/api/users/route.ts` 的 `createTrackedUser` 调用中确保有 `telegrams: source.telegrams`。

- [ ] **Step 3: Commit**

```bash
git add app/api/users/route.ts lib/server/userPayload.ts
git commit -m "feat(api): pass telegrams field through user creation pipeline"
```

---

### Task 15: Agent 查询支持按 `channelType` 过滤

**Files:**
- Modify: `lib/server/telegramAgentReadService.ts`

- [ ] **Step 1: 在 Agent 查询接口中增加 `channelType` 过滤参数**

查询 `telegram_channel_posts` 时，如果传入 `channelType`，添加 `WHERE channel_type = ?` 条件。

- [ ] **Step 2: Commit**

```bash
git add lib/server/telegramAgentReadService.ts
git commit -m "feat(agent): support channelType filter in read queries"
```

---

### Task 16: 集成验证

- [ ] **Step 1: 编译验证**

```bash
npm run build
```

Expected: 编译成功，无类型错误

- [ ] **Step 2: 手动验证核心流程**

1. 启动应用，确认数据库迁移成功（新列已添加）
2. 在 manage 页面创建带 `news` tag 的用户，添加 TG 频道
3. 在 feed 页面确认"新闻"按钮存在且默认不亮
4. 点击"新闻"按钮，确认新闻 feed 出现
5. 确认新闻卡片显示频道名和"新闻"标签
6. 确认 `telegram_channel_posts` 表中新闻帖子的 `channel_type = 'news'`
7. 确认 Agent 查询按 `channelType` 过滤正常

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: news feed with multi-TG and channel_type — integration verified"
```
