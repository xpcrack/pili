# 新闻 Feed 与多 TG 频道绑定 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 支持新闻类信息源（不绑定具体人物、一个用户可关联多个 TG 频道），新闻 Feed 默认隐藏，可手动开关显示。

**Architecture:** 复用现有 User 体系，通过 `"news"` tag 标记新闻类用户；扩展 `User.telegrams` 支持多 TG 频道绑定；`FeedSearchFilters.typeFilters` 增加 `news` 过滤器（默认 `false`）；前端筛选栏增加"新闻"按钮。

**Tech Stack:** Next.js, React, SQLite (better-sqlite3), TypeScript

---

### Task 1: User 类型增加 `telegrams` 字段

**Files:**
- Modify: `types/index.ts:84-105`

- [ ] **Step 1: 在 User 类型中增加 `telegrams` 可选字段**

在 `types/index.ts` 的 `User` interface 中，`telegram` 字段之后添加：

```typescript
telegrams?: string[];
```

- [ ] **Step 2: Commit**

```bash
git add types/index.ts
git commit -m "feat(types): add telegrams field to User type"
```

---

### Task 2: SQLite schema 增加 `telegrams_json` 列 + 迁移

**Files:**
- Modify: `lib/server/sqlite.ts:144-159`
- Modify: `lib/server/trackedUsersRepo.ts`

- [ ] **Step 1: 在 `sqlite.ts` 的 `tracked_users` CREATE TABLE 中增加 `telegrams_json` 列**

在 `telegram TEXT,` 行之后添加：

```sql
telegrams_json TEXT NOT NULL DEFAULT '[]',
```

- [ ] **Step 2: 在 `sqlite.ts` 中添加迁移语句**

在已有的 CREATE TABLE 语句之后（表创建逻辑的末尾），添加 ALTER TABLE 迁移，确保已有数据库也能加上新列：

```typescript
// 在所有 CREATE TABLE / CREATE INDEX 之后添加
try {
  db.exec(`ALTER TABLE tracked_users ADD COLUMN telegrams_json TEXT NOT NULL DEFAULT '[]'`);
} catch {
  // 列已存在，忽略
}
```

- [ ] **Step 3: 在 `trackedUsersRepo.ts` 的 `TrackedUserRow` interface 中增加字段**

```typescript
interface TrackedUserRow {
  // ...existing fields...
  telegrams_json: string;
}
```

- [ ] **Step 4: 在 `trackedUsersRepo.ts` 的 `mapUserRow` 中解析 `telegrams_json`**

在 `mapUserRow` 函数中，`telegram` 之后添加：

```typescript
telegrams: parseTelegramList(row.telegrams_json),
```

在文件顶部（`parseTags` 附近）添加辅助函数：

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

- [ ] **Step 5: 在 `upsertUserRow` 中持久化 `telegrams_json`**

修改 INSERT 语句增加 `telegrams_json` 列，VALUES 增加 `?` 占位符，ON CONFLICT UPDATE 增加 `telegrams_json = excluded.telegrams_json`，`.run()` 调用增加参数 `JSON.stringify(user.telegrams ?? [])`。

具体改动：
- INSERT 列列表：在 `telegram,` 之后加 `telegrams_json,`
- VALUES：在对应 `?,` 之后加 `?,`
- ON CONFLICT SET：在 `telegram = excluded.telegram,` 之后加 `telegrams_json = excluded.telegrams_json,`
- `.run()` 参数：在 `user.telegram ?? null,` 之后加 `JSON.stringify(user.telegrams ?? []),`

- [ ] **Step 6: Commit**

```bash
git add lib/server/sqlite.ts lib/server/trackedUsersRepo.ts
git commit -m "feat(db): add telegrams_json column to tracked_users"
```

---

### Task 3: `bootstrapTelegramChannelSourcesFromTrackedUsers` 支持多 TG

**Files:**
- Modify: `lib/server/telegramChannelSourceRepo.ts:153-200`

- [ ] **Step 1: 修改 bootstrap 函数遍历 `telegram` + `telegrams`**

将现有逻辑从只处理 `user.telegram` 改为处理所有频道。替换 `bootstrapTelegramChannelSourcesFromTrackedUsers` 函数体：

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

### Task 4: `FeedSearchFilters` 增加 `news` 过滤器

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

在 `matchesFeedSearchFilters` 函数中，`telegram` 判断之后添加：

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

### Task 5: `feedPageState` 适配 `news` 过滤器

**Files:**
- Modify: `lib/feed/feedPageState.ts`

- [ ] **Step 1: 更新 `hasActiveFeedLocalFilters` 包含 `news`**

在 `hasActiveFeedLocalFilters` 函数中，将 `!searchFilters.typeFilters.telegram` 的逻辑改为包含 `news`。由于 `news` 默认 `false`（即不显示新闻不算激活筛选），这里需要特别注意：

当 `news` 为 `true` 时（用户主动开启了新闻），应视为激活了本地筛选。当 `news` 为 `false` 时，这是默认状态，不算激活。

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

注意：其他四个过滤器默认 `true`，`!xxx` 为 `true` 表示被关闭了（偏离默认）；`news` 默认 `false`，`news` 为 `true` 表示被开启了（偏离默认）。两者都是"偏离默认值"的意思。

- [ ] **Step 2: Commit**

```bash
git add lib/feed/feedPageState.ts
git commit -m "feat(feed): adapt feedPageState for news filter"
```

---

### Task 6: Feed 页面增加"新闻"筛选按钮

**Files:**
- Modify: `app/page.tsx:574-608`

- [ ] **Step 1: 在筛选按钮数组中增加 `news` 项**

在 `page.tsx` 中筛选按钮的数组里，`['telegram', 'TG']` 之后添加 `['news', '新闻']`：

```typescript
{[
  ['trade', '交易'],
  ['transfer', '转账'],
  ['twitter', '推特'],
  ['telegram', 'TG'],
  ['news', '新闻'],
].map(([key, label]) => {
```

无需其他改动 — 现有渲染逻辑已通用化，会自动适配新增的 key。

- [ ] **Step 2: Commit**

```bash
git add app/page.tsx
git commit -m "feat(feed): add news filter button"
```

---

### Task 7: 新闻卡片展示适配

**Files:**
- Modify: `lib/activityCardViewModel.ts`
- Modify: `lib/activityCardSocial.ts`
- Modify: `components/ActivityCard.tsx`

- [ ] **Step 1: 在 `activityCardViewModel` 中增加 `isNews` 标记**

在 `buildActivityCardViewModel` 函数中，`isTelegram` 判断之后添加：

```typescript
const isNews = user.tags.includes('news');
```

在返回对象中添加 `isNews`。

- [ ] **Step 2: 修改 `activityCardViewModel` 中新闻卡片的名字/头像逻辑**

新闻卡片应显示频道信息而非用户名。在返回对象中，当 `isNews && isTelegram` 时，覆盖相关显示字段：

```typescript
const newsChannelLabel = isNews && isTelegram
  ? (activity.metadata.telegramChannelTitle || activity.metadata.telegramChannelUsername || '新闻频道')
  : null;
const displayUserName = newsChannelLabel || user.name;
```

然后在返回对象中，将 `displayWalletLabel` 的 fallback（即 `user.name`）替换为 `displayUserName`：

在返回对象中增加：

```typescript
isNews,
newsChannelLabel,
```

- [ ] **Step 3: 修改 `ActivityCard` 组件中新闻卡片的头像/名字显示**

在 `ActivityCard.tsx` 中，从 `buildActivityCardViewModel` 解构中增加 `isNews` 和 `newsChannelLabel`。

对于新闻类 TG 卡片，名字用 `newsChannelLabel` 替代 `user.name`。在非 transfer 卡片的用户名显示处（`<span className="truncate font-semibold text-zinc-300">{user.name}</span>`），改为：

```typescript
<span className="truncate font-semibold text-zinc-300">
  {isNews && newsChannelLabel ? newsChannelLabel : user.name}
</span>
```

- [ ] **Step 4: 修改 `getActivityCardTypeLabel` 让新闻卡片显示"新闻"而非"TG"**

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
  if (params.source === 'twitter') {
    return params.twitterKindLabel;
  }
  // ...rest unchanged
```

在 `ActivityCard.tsx` 中调用处增加 `isNews` 参数：

```typescript
const typeLabel = getActivityCardTypeLabel({
  source: activity.source,
  activityType: activity.type,
  twitterKindLabel,
  isNews,
});
```

- [ ] **Step 5: Commit**

```bash
git add lib/activityCardViewModel.ts lib/activityCardSocial.ts components/ActivityCard.tsx
git commit -m "feat(card): display channel info for news-tagged activities"
```

---

### Task 8: 管理页支持多 TG 和新闻用户创建

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

更新 `resetForm` 和 `formData` 初始值：

```typescript
const [formData, setFormData] = useState<ProfileFormState>({
  name: '',
  handle: '',
  twitter: '',
  telegram: '',
  telegrams: '',
  tags: '',
});
```

```typescript
const resetForm = () => {
  setFormData({ name: '', handle: '', twitter: '', telegram: '', telegrams: '', tags: '' });
  setAddressText('');
};
```

- [ ] **Step 2: 在 `handleSave` 中处理 `telegrams` 字段**

在 `addUser` 调用中增加 `telegrams`：

```typescript
addUser({
  name: formData.name.trim(),
  handle: formData.handle.trim(),
  avatar: buildUserAvatar(formData.handle.trim(), normalizedTwitter),
  twitter: normalizedTwitter || undefined,
  telegram: formData.telegram.trim() || undefined,
  telegrams: formData.telegrams.split(',').map((t) => t.trim()).filter(Boolean),
  addresses: expandTrackedAddresses(parsedAddresses),
  totalAssetUsd: 0,
  historicalMaxAssetUsd: 0,
  assetUpdatedAt: null,
  tags: formData.tags.split(',').map((tag) => tag.trim()).filter(Boolean),
});
```

- [ ] **Step 3: 在创建表单中增加"额外TG频道"输入框**

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

- [ ] **Step 4: 在用户列表表格中显示 `telegrams`**

在 TG 列中，当用户有 `telegrams` 时显示额外数量。修改 TG 列的显示逻辑：

```tsx
<td className="px-2 py-2.5">
  {telegramUrl ? (
    <div className="space-y-1">
      <a
        href={telegramUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="truncate text-blue-400 hover:text-blue-300 hover:underline"
      >
        {telegramDisplayText || '-'}
      </a>
      {user.telegrams && user.telegrams.length > 0 ? (
        <div className="text-[11px] text-zinc-500">
          +{user.telegrams.length} 频道
        </div>
      ) : null}
    </div>
  ) : (
    <span className="text-zinc-600">-</span>
  )}
</td>
```

- [ ] **Step 5: Commit**

```bash
git add app/manage/page.tsx
git commit -m "feat(manage): support multiple TG channels and telegrams field"
```

---

### Task 9: API 层适配 `telegrams` 字段

**Files:**
- Modify: `app/api/users/route.ts`
- Modify: `lib/server/userPayload.ts`

- [ ] **Step 1: 检查 `userPayload.ts` 的 `sanitizeUsersPayload` 是否需要处理 `telegrams`**

查看 `sanitizeUsersPayload` 函数，确保 `telegrams` 字段被正确传递（不做额外清理，只保留数组结构）。如果该函数对 User 字段做了白名单过滤，需增加 `telegrams`。

- [ ] **Step 2: 确认 `POST /api/users` 的 `createTrackedUser` 调用包含 `telegrams`**

在 `app/api/users/route.ts` 的 `POST` handler 中，`createTrackedUser` 的参数需包含 `telegrams: source.telegrams`。

- [ ] **Step 3: Commit**

```bash
git add app/api/users/route.ts lib/server/userPayload.ts
git commit -m "feat(api): pass telegrams field through user creation pipeline"
```

---

### Task 10: usersDataStore 适配 `telegrams`

**Files:**
- Modify: `store/usersDataStore.ts`

- [ ] **Step 1: 确认 store 的 `addUser` / `addUsers` / `updateUser` 正确传递 `telegrams`**

检查 zustand store，确保 `telegrams` 字段在 `User` 对象操作时不被丢弃。

- [ ] **Step 2: Commit**

```bash
git add store/usersDataStore.ts
git commit -m "feat(store): ensure telegrams field preserved in user operations"
```

---

### Task 11: 集成验证

- [ ] **Step 1: 启动 dev server 验证编译通过**

```bash
npm run build
```

Expected: 编译成功，无类型错误

- [ ] **Step 2: 手动验证核心流程**

1. 打开 manage 页面，创建一个带 `news` tag 的用户，添加 TG 频道
2. 打开 feed 页面，确认新闻按钮存在且默认不亮
3. 点击"新闻"按钮，确认新闻 feed 出现
4. 确认新闻卡片显示频道名而非用户名
5. 确认新闻卡片的 type label 显示"新闻"而非"TG"

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: news feed with multi-TG channel support — integration verified"
```
