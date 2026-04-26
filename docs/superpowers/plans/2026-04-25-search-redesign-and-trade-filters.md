# Search Redesign And Trade Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the feed page's field-based search with simple realtime keyword search, add `交易 / 转账 / 推特` type filters plus trade-only USD amount and market-cap thresholds, and persist a stable per-activity `tradeAmountUsdAtTx` value for filtering and display.

**Architecture:** Keep `/api/feed` and `useActivityPolling` focused on loading the feed, then run the new keyword, type, amount, and market-cap filters entirely on the client. Extend `Activity.metadata` with `tradeAmountUsdAtTx`, compute it once while building blockchain activity rows, and reuse that same value in `ActivityCard` and the new filter helpers so UI behavior stays consistent.

**Tech Stack:** Next.js App Router 16 client components, React 19, TypeScript, tsx script tests, ESLint, Tailwind CSS, existing OKX historical price helpers

---

## File Map

- `/Users/xp/vibecoding/pilipili/types/index.ts`
  - Extend `Activity['metadata']` with `tradeAmountUsdAtTx?: number`.
- `/Users/xp/vibecoding/pilipili/lib/tradeUsd.ts`
  - New focused helper for resolving a trade's USD amount at transaction time.
- `/Users/xp/vibecoding/pilipili/lib/parsing/toActivity.ts`
  - Attach `tradeAmountUsdAtTx` to blockchain activities created from grouped transactions.
- `/Users/xp/vibecoding/pilipili/lib/activityFeed.ts`
  - Backstop amount enrichment before feed verdicts so all buy/sell rows are normalized.
- `/Users/xp/vibecoding/pilipili/lib/server/telegramMonitorFeed.ts`
  - Attach `tradeAmountUsdAtTx` for monitor-projected trade rows.
- `/Users/xp/vibecoding/pilipili/lib/smartSearch.ts`
  - Rewrite to simple keyword and filter helpers; remove field syntax and suggestion logic.
- `/Users/xp/vibecoding/pilipili/app/page.tsx`
  - Replace suggestion-driven search UI with unified local filter state and filter bar.
- `/Users/xp/vibecoding/pilipili/components/ActivityCard.tsx`
  - Show compact USD trade amount or `金额未知` on trade cards.
- `/Users/xp/vibecoding/pilipili/scripts/test-trade-usd.ts`
  - New regression script for trade USD resolution.
- `/Users/xp/vibecoding/pilipili/scripts/test-search-filters.ts`
  - New regression script for keyword, type, and threshold filtering.
- `/Users/xp/vibecoding/pilipili/package.json`
  - Register the new script tests.

### Task 1: Add Trade USD Resolution Helper And Regression Tests

**Files:**
- Create: `/Users/xp/vibecoding/pilipili/lib/tradeUsd.ts`
- Create: `/Users/xp/vibecoding/pilipili/scripts/test-trade-usd.ts`
- Modify: `/Users/xp/vibecoding/pilipili/types/index.ts`
- Modify: `/Users/xp/vibecoding/pilipili/package.json`

- [ ] **Step 1: Write the failing test**

Create `/Users/xp/vibecoding/pilipili/scripts/test-trade-usd.ts` with focused assertions:

```ts
import assert from 'node:assert/strict';

import { resolveTradeAmountUsdAtTx } from '@/lib/tradeUsd';

async function run() {
  assert.equal(
    await resolveTradeAmountUsdAtTx({
      chain: 'bsc',
      txTimestampMs: 1_710_000_000_000,
      quoteToken: 'USDT',
      quoteAmount: '1250',
    }),
    1250
  );

  assert.equal(
    await resolveTradeAmountUsdAtTx(
      {
        chain: 'bsc',
        txTimestampMs: 1_710_000_000_000,
        quoteToken: 'BNB',
        quoteAmount: '2',
      },
      {
        fetchHistoricalTokenPrice: async () => ({
          priceUsd: 600,
          candleTimestampMs: 1_710_000_000_000,
          bar: '1m',
        }),
      }
    ),
    1200
  );

  assert.equal(
    await resolveTradeAmountUsdAtTx({
      chain: 'bsc',
      txTimestampMs: 1_710_000_000_000,
      token: 'TOKEN',
      value: '300',
      explicitPriceUsd: 2.5,
    }),
    750
  );

  assert.equal(
    await resolveTradeAmountUsdAtTx({
      chain: 'solana',
      txTimestampMs: 1_710_000_000_000,
      quoteToken: 'SOL',
      quoteAmount: '1',
    }),
    null
  );

  console.log('trade usd tests: ok');
}

void run();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `tsx scripts/test-trade-usd.ts`  
Expected: FAIL because `@/lib/tradeUsd` and `resolveTradeAmountUsdAtTx` do not exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `/Users/xp/vibecoding/pilipili/lib/tradeUsd.ts`:

```ts
import { fetchOkxTokenHistoricalPriceBeforeTimestamp } from '@/lib/okx';

const STABLE_SYMBOLS = new Set(['USDT', 'USDC', 'DAI']);
const WRAPPED_NATIVE_TOKEN_BY_CHAIN: Record<string, Record<string, string>> = {
  bsc: {
    BNB: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    WBNB: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
  },
  solana: {
    SOL: 'So11111111111111111111111111111111111111112',
    WSOL: 'So11111111111111111111111111111111111111112',
  },
};

export async function resolveTradeAmountUsdAtTx(
  params: {
    chain?: string | null;
    txTimestampMs: number;
    token?: string | null;
    value?: string | number | null;
    quoteToken?: string | null;
    quoteAmount?: string | number | null;
    explicitPriceUsd?: number | null;
  },
  deps: {
    fetchHistoricalTokenPrice?: typeof fetchOkxTokenHistoricalPriceBeforeTimestamp;
  } = {}
) {
  const fetchHistoricalTokenPrice = deps.fetchHistoricalTokenPrice ?? fetchOkxTokenHistoricalPriceBeforeTimestamp;
  const quoteToken = (params.quoteToken || '').trim().toUpperCase();
  const quoteAmount = Number.parseFloat(String(params.quoteAmount ?? '').trim().replace(/,/g, ''));
  const tokenSymbol = (params.token || '').trim().toUpperCase();
  const tokenAmount = Number.parseFloat(String(params.value ?? '').trim().replace(/,/g, ''));

  if (STABLE_SYMBOLS.has(quoteToken) && Number.isFinite(quoteAmount) && quoteAmount > 0) {
    return Math.round(quoteAmount * 1_000_000) / 1_000_000;
  }

  if (STABLE_SYMBOLS.has(tokenSymbol) && Number.isFinite(tokenAmount) && tokenAmount > 0) {
    return Math.round(tokenAmount * 1_000_000) / 1_000_000;
  }

  if (typeof params.explicitPriceUsd === 'number' && Number.isFinite(params.explicitPriceUsd) && tokenAmount > 0) {
    return Math.round(tokenAmount * params.explicitPriceUsd * 1_000_000) / 1_000_000;
  }

  const chain = (params.chain || '').trim().toLowerCase();
  const wrappedNativeToken = WRAPPED_NATIVE_TOKEN_BY_CHAIN[chain]?.[quoteToken];
  if (wrappedNativeToken && Number.isFinite(quoteAmount) && quoteAmount > 0) {
    const point = await fetchHistoricalTokenPrice(chain, wrappedNativeToken, params.txTimestampMs);
    if (point?.priceUsd && Number.isFinite(point.priceUsd) && point.priceUsd > 0) {
      return Math.round(quoteAmount * point.priceUsd * 1_000_000) / 1_000_000;
    }
  }

  return null;
}
```

Extend `/Users/xp/vibecoding/pilipili/types/index.ts`:

```ts
tradeAmountUsdAtTx?: number;
```

Register the test in `/Users/xp/vibecoding/pilipili/package.json`:

```json
"test:trade-usd": "tsx scripts/test-trade-usd.ts"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:trade-usd`  
Expected: PASS with `trade usd tests: ok`.

- [ ] **Step 5: Commit**

```bash
git add types/index.ts lib/tradeUsd.ts scripts/test-trade-usd.ts package.json
git commit -m "test(trade): cover transaction usd amount resolution"
```

### Task 2: Attach `tradeAmountUsdAtTx` During Activity Construction

**Files:**
- Modify: `/Users/xp/vibecoding/pilipili/lib/parsing/toActivity.ts`
- Modify: `/Users/xp/vibecoding/pilipili/lib/activityFeed.ts`
- Modify: `/Users/xp/vibecoding/pilipili/lib/server/telegramMonitorFeed.ts`
- Modify: `/Users/xp/vibecoding/pilipili/lib/tradeUsd.ts`

- [ ] **Step 1: Run the new helper regression before wiring call sites**

Run: `npm run test:trade-usd`  
Expected: PASS. This is the safety net before threading the new field through activity producers.

- [ ] **Step 2: Write minimal implementation**

In `/Users/xp/vibecoding/pilipili/lib/parsing/toActivity.ts`, resolve and attach the amount:

```ts
import { resolveTradeAmountUsdAtTx } from '@/lib/tradeUsd';

const tradeAmountUsdAtTx =
  parsed.txAction === 'buy' || parsed.txAction === 'sell'
    ? await resolveTradeAmountUsdAtTx({
        chain: addressInfo.chain,
        txTimestampMs: parsed.timestamp,
        token: parsed.primaryAsset.symbol,
        value: parsed.primaryAsset.amount,
        quoteToken: parsed.quoteAsset?.token,
        quoteAmount: parsed.quoteAsset?.amount,
      })
    : null;
```

and persist it:

```ts
tradeAmountUsdAtTx: tradeAmountUsdAtTx ?? undefined,
```

In `/Users/xp/vibecoding/pilipili/lib/server/telegramMonitorFeed.ts`, derive the value from monitor price or quote amount:

```ts
const tradeAmountUsdAtTx =
  action === 'buy' || action === 'sell'
    ? await resolveTradeAmountUsdAtTx({
        chain,
        txTimestampMs: eventTimeMs,
        token: tokenSymbol,
        value: typeof tokenAmount === 'number' ? String(tokenAmount) : null,
        quoteToken: quoteSymbol,
        quoteAmount: typeof quoteAmount === 'number' ? String(quoteAmount) : null,
        explicitPriceUsd: event.priceUsd ?? fallbackParsed?.priceUsd ?? null,
      })
    : null;
```

and add:

```ts
tradeAmountUsdAtTx: tradeAmountUsdAtTx ?? undefined,
```

In `/Users/xp/vibecoding/pilipili/lib/activityFeed.ts`, backfill missing values before verdicts:

```ts
if (
  (activity.metadata.txAction === 'buy' || activity.metadata.txAction === 'sell') &&
  typeof activity.metadata.tradeAmountUsdAtTx !== 'number'
) {
  const resolvedTradeAmountUsdAtTx = await resolveTradeAmountUsdAtTx({
    chain: activity.metadata.chain || addressInfo.chain,
    txTimestampMs: activity.timestamp,
    token: activity.metadata.token,
    value: activity.metadata.value,
    quoteToken: activity.metadata.quoteToken,
    quoteAmount: activity.metadata.quoteAmount,
  });

  if (typeof resolvedTradeAmountUsdAtTx === 'number') {
    activity.metadata.tradeAmountUsdAtTx = resolvedTradeAmountUsdAtTx;
  }
}
```

- [ ] **Step 3: Run regression verification**

Run: `npm run test:trade-usd && npm run test:parser-fixtures && npm run test:feed-ordering`  
Expected: PASS. `test:parser-fixtures` proves the parser path still works; `test:feed-ordering` proves the new metadata did not disturb merged trade logic.

- [ ] **Step 4: Run lint on the touched files**

Run: `npx eslint lib/parsing/toActivity.ts lib/activityFeed.ts lib/server/telegramMonitorFeed.ts lib/tradeUsd.ts types/index.ts`  
Expected: PASS with no lint errors.

- [ ] **Step 5: Commit**

```bash
git add lib/parsing/toActivity.ts lib/activityFeed.ts lib/server/telegramMonitorFeed.ts lib/tradeUsd.ts types/index.ts
git commit -m "feat(feed): persist trade usd amounts on trade activities"
```

### Task 3: Replace Field Search With Simple Feed Filter Helpers

**Files:**
- Modify: `/Users/xp/vibecoding/pilipili/lib/smartSearch.ts`
- Create: `/Users/xp/vibecoding/pilipili/scripts/test-search-filters.ts`
- Modify: `/Users/xp/vibecoding/pilipili/package.json`

- [ ] **Step 1: Write the failing test**

Create `/Users/xp/vibecoding/pilipili/scripts/test-search-filters.ts`:

```ts
import assert from 'node:assert/strict';

import {
  DEFAULT_FEED_SEARCH_FILTERS,
  getFeedItemCategory,
  hasAnyEnabledFeedType,
  matchesFeedSearchFilters,
} from '@/lib/smartSearch';
import type { Activity, User } from '@/types';

function makeUser(name: string): User {
  return {
    id: name.toLowerCase(),
    name,
    handle: name.toLowerCase(),
    avatar: '',
    addresses: [{ address: '0xabc', name: '#1', chain: 'bsc', totalAssetUsd: null, assetUpdatedAt: null }],
    totalAssetUsd: 0,
    historicalMaxAssetUsd: 0,
    assetUpdatedAt: null,
    tags: [],
  };
}

function makeItem(activity: Partial<Activity>) {
  const user = makeUser('Alice');
  return {
    user,
    activity: {
      id: 'a1',
      userId: user.id,
      source: 'blockchain',
      type: 'transfer',
      content: '',
      timestamp: 1_710_000_000_000,
      metadata: {},
      ...activity,
    } satisfies Activity,
  };
}

const twitterItem = makeItem({
  source: 'twitter',
  type: 'post',
  content: 'launching new memecoin',
  metadata: { tweetId: 't1' },
});

const tradeItem = makeItem({
  content: 'ignored chain text',
  metadata: {
    txAction: 'buy',
    tokenAddress: '0xmoon',
    tradeAmountUsdAtTx: 12_500,
    marketCapAtTxUsd: 2_500_000,
  },
});

const transferItem = makeItem({
  metadata: {
    txAction: 'send',
    fromAddress: '0xabc',
    toAddress: '0xdef',
  },
});

assert.equal(getFeedItemCategory(tradeItem), 'trade');
assert.equal(getFeedItemCategory(transferItem), 'transfer');
assert.equal(getFeedItemCategory(twitterItem), 'twitter');

assert.equal(
  matchesFeedSearchFilters(tradeItem, {
    ...DEFAULT_FEED_SEARCH_FILTERS,
    keyword: 'alice launch 0xmoon',
  }),
  true
);

assert.equal(
  matchesFeedSearchFilters(tradeItem, {
    ...DEFAULT_FEED_SEARCH_FILTERS,
    keyword: 'ignored',
  }),
  false
);

assert.equal(
  matchesFeedSearchFilters(twitterItem, {
    ...DEFAULT_FEED_SEARCH_FILTERS,
    keyword: 'launching',
  }),
  true
);

assert.equal(
  matchesFeedSearchFilters(tradeItem, {
    ...DEFAULT_FEED_SEARCH_FILTERS,
    minTradeAmountUsd: '20000',
  }),
  false
);

assert.equal(
  matchesFeedSearchFilters(
    makeItem({
      metadata: { txAction: 'buy', marketCapAtTxUsd: 2_500_000 },
    }),
    {
      ...DEFAULT_FEED_SEARCH_FILTERS,
      minTradeAmountUsd: '1000',
    }
  ),
  false
);

assert.equal(
  hasAnyEnabledFeedType({ trade: false, transfer: false, twitter: false }),
  false
);

console.log('search filter tests: ok');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `tsx scripts/test-search-filters.ts`  
Expected: FAIL because the new exports do not exist in `lib/smartSearch.ts`.

- [ ] **Step 3: Write minimal implementation**

Replace the field-parser exports in `/Users/xp/vibecoding/pilipili/lib/smartSearch.ts` with focused filter helpers:

```ts
import { Activity, User } from '@/types';

export interface FeedSearchFilters {
  keyword: string;
  typeFilters: {
    trade: boolean;
    transfer: boolean;
    twitter: boolean;
  };
  minTradeAmountUsd: string;
  minTradeMarketCapUsd: string;
}

export const DEFAULT_FEED_SEARCH_FILTERS: FeedSearchFilters = {
  keyword: '',
  typeFilters: {
    trade: true,
    transfer: true,
    twitter: true,
  },
  minTradeAmountUsd: '',
  minTradeMarketCapUsd: '',
};

export function getFeedItemCategory(item: { user: User; activity: Activity }) {
  if (item.activity.source === 'twitter') return 'twitter' as const;
  if (item.activity.metadata.txAction === 'buy' || item.activity.metadata.txAction === 'sell') return 'trade' as const;
  if (item.activity.metadata.txAction === 'send' || item.activity.metadata.txAction === 'receive') return 'transfer' as const;
  return 'other' as const;
}

export function hasAnyEnabledFeedType(typeFilters: FeedSearchFilters['typeFilters']) {
  return typeFilters.trade || typeFilters.transfer || typeFilters.twitter;
}

function getKeywordHaystack(item: { user: User; activity: Activity }) {
  const values = [
    item.user.name,
    item.activity.metadata.tokenAddress,
    item.activity.metadata.fromAddress,
    item.activity.metadata.toAddress,
    item.activity.metadata.trackedAddress,
  ];

  if (item.activity.source === 'twitter') {
    values.push(item.activity.content);
  }

  return values
    .map((value) => (value || '').trim().toLowerCase())
    .filter(Boolean);
}

export function matchesFeedSearchFilters(
  item: { user: User; activity: Activity },
  filters: FeedSearchFilters
) {
  const category = getFeedItemCategory(item);
  if (category === 'trade' && !filters.typeFilters.trade) return false;
  if (category === 'transfer' && !filters.typeFilters.transfer) return false;
  if (category === 'twitter' && !filters.typeFilters.twitter) return false;
  if (category === 'other') return false;

  const terms = filters.keyword.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length > 0) {
    const haystack = getKeywordHaystack(item);
    const keywordMatched = terms.some((term) => haystack.some((value) => value.includes(term)));
    if (!keywordMatched) return false;
  }

  if (category !== 'trade') {
    return true;
  }

  const minTradeAmountUsd = Number.parseFloat(filters.minTradeAmountUsd.trim());
  if (Number.isFinite(minTradeAmountUsd) && minTradeAmountUsd > 0) {
    if (
      typeof item.activity.metadata.tradeAmountUsdAtTx !== 'number' ||
      item.activity.metadata.tradeAmountUsdAtTx < minTradeAmountUsd
    ) {
      return false;
    }
  }

  const minTradeMarketCapUsd = Number.parseFloat(filters.minTradeMarketCapUsd.trim());
  if (Number.isFinite(minTradeMarketCapUsd) && minTradeMarketCapUsd > 0) {
    if (
      typeof item.activity.metadata.marketCapAtTxUsd !== 'number' ||
      item.activity.metadata.marketCapAtTxUsd < minTradeMarketCapUsd
    ) {
      return false;
    }
  }

  return true;
}
```

Register the test in `/Users/xp/vibecoding/pilipili/package.json`:

```json
"test:search-filters": "tsx scripts/test-search-filters.ts"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:search-filters`  
Expected: PASS with `search filter tests: ok`.

- [ ] **Step 5: Commit**

```bash
git add lib/smartSearch.ts scripts/test-search-filters.ts package.json
git commit -m "test(search): cover simple keyword and trade filter rules"
```

### Task 4: Rebuild The Feed Page Search Area Around Local Filter State

**Files:**
- Modify: `/Users/xp/vibecoding/pilipili/app/page.tsx`
- Modify: `/Users/xp/vibecoding/pilipili/lib/smartSearch.ts`

- [ ] **Step 1: Read the relevant Next.js 16 client-component guide before editing the page**

Run: `rg -n "client component|use client|forms|input" node_modules/next/dist/docs -g '*.md' | head -n 20`  
Expected: one or more matching local docs under `node_modules/next/dist/docs`, confirming the required Next.js reference check happened before editing the client page.

- [ ] **Step 2: Run current regression tests before the UI rewrite**

Run: `npm run test:search-filters && npm run test:feed-ordering && npm run test:time-format`  
Expected: PASS.

- [ ] **Step 3: Write minimal implementation**

In `/Users/xp/vibecoding/pilipili/app/page.tsx`, replace the old search state:

```ts
const [searchFilters, setSearchFilters] = useState<FeedSearchFilters>(DEFAULT_FEED_SEARCH_FILTERS);
```

Remove these imports and state branches:

```ts
applySuggestionToInput,
buildSearchSuggestionSources,
getSearchSuggestions,
hasActiveSearchQuery,
parseSearchQuery,
```

and all of:

```ts
const [isSuggestionOpen, setIsSuggestionOpen] = useState(false);
const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0);
const parsedSearchQuery = useMemo(() => parseSearchQuery(searchInput), [searchInput]);
const hasSearchQuery = hasActiveSearchQuery(parsedSearchQuery);
```

Keep the polling request unfiltered by the local keyword:

```ts
const {
  feed,
  ...
} = useActivityPolling(selectedUserId, '');
```

Add a derived flag for local UI behavior:

```ts
const hasActiveLocalFilters =
  searchFilters.keyword.trim().length > 0 ||
  !searchFilters.typeFilters.trade ||
  !searchFilters.typeFilters.transfer ||
  !searchFilters.typeFilters.twitter ||
  searchFilters.minTradeAmountUsd.trim().length > 0 ||
  searchFilters.minTradeMarketCapUsd.trim().length > 0;
```

Build the local filtered list from ordered feed rows:

```ts
const orderedFeed = useMemo(() => {
  if (selectedUserId) {
    return prepareUserFeed(selectedUserFeed);
  }
  return prepareGlobalFeed(selectedUserFeed);
}, [selectedUserFeed, selectedUserId]);

const matchedFeed = useMemo(
  () => orderedFeed.filter((item) => matchesFeedSearchFilters(item, searchFilters)),
  [orderedFeed, searchFilters]
);

const filteredFeed = useMemo(() => {
  if (!selectedUserId) return matchedFeed.slice(0, globalVisibleCount);
  return matchedFeed.slice(0, selectedUserVisibleCount);
}, [selectedUserId, matchedFeed, globalVisibleCount, selectedUserVisibleCount]);
```

Update sidebar user filtering to follow `matchedFeed`, not raw `feed`:

```ts
const visibleUserIds = useMemo(() => {
  const ids = new Set<string>();
  for (const item of matchedFeed) {
    ids.add(item.user.id);
  }
  return ids;
}, [matchedFeed]);
```

and keep the old “only narrow the sidebar when filters are active” behavior:

```ts
if (hasActiveLocalFilters) {
  return sorted.filter((user) => visibleUserIds.has(user.id));
}
return sorted;
```

Replace old `hasSearchQuery` branches that changed remote fetch behavior. For example:

```ts
const result = await refetch({
  targetCount: MIN_SELECTED_USER_FEED_ITEMS,
  selectedUserId: user.id,
  syncStrategy: 'local',
});
```

and:

```ts
void refetch({ selectedUserId: null, syncStrategy: 'local' });
```

Keep `resetExpandStateForSearch()` on local filter changes so pagination resets even though the API request no longer uses the keyword.

Update search UI to a simple text field plus filter bar:

```tsx
<Input
  value={searchFilters.keyword}
  onChange={(event) => {
    setSearchFilters((current) => ({ ...current, keyword: event.target.value }));
    resetExpandStateForSearch();
  }}
  placeholder="搜索人物名字、推文内容、CA 或地址"
  className="h-9 border-zinc-700 bg-zinc-950 text-zinc-100 placeholder:text-zinc-500"
/>
```

Add type toggles:

```tsx
{[
  ['trade', '交易'],
  ['transfer', '转账'],
  ['twitter', '推特'],
].map(([key, label]) => {
  const typedKey = key as keyof FeedSearchFilters['typeFilters'];
  const active = searchFilters.typeFilters[typedKey];
  return (
    <button
      key={key}
      type="button"
      onClick={() => {
        setSearchFilters((current) => ({
          ...current,
          typeFilters: {
            ...current.typeFilters,
            [typedKey]: !current.typeFilters[typedKey],
          },
        }));
        resetExpandStateForSearch();
      }}
      className={active ? 'bg-zinc-700 text-zinc-100' : 'bg-zinc-950 text-zinc-400'}
    >
      {label}
    </button>
  );
})}
```

Show the trade-only inputs when the trade filter is enabled:

```tsx
{searchFilters.typeFilters.trade ? (
  <div className="grid gap-2 sm:grid-cols-2">
    <Input
      value={searchFilters.minTradeAmountUsd}
      onChange={(event) =>
        setSearchFilters((current) => ({ ...current, minTradeAmountUsd: event.target.value }))
      }
      placeholder="最低成交金额（USD）"
    />
    <Input
      value={searchFilters.minTradeMarketCapUsd}
      onChange={(event) =>
        setSearchFilters((current) => ({ ...current, minTradeMarketCapUsd: event.target.value }))
      }
      placeholder="最低成交市值"
    />
  </div>
) : null}
```

Add the helper line below the trade-only inputs:

```tsx
{searchFilters.typeFilters.trade &&
(searchFilters.minTradeAmountUsd.trim() || searchFilters.minTradeMarketCapUsd.trim()) ? (
  <p className="text-xs text-zinc-500">交易金额和成交市值筛选仅对交易生效</p>
) : null}
```

Add the empty-state guards:

```tsx
{!hasAnyEnabledFeedType(searchFilters.typeFilters) ? (
  <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-sm text-amber-300">
    请至少选择一种类型
  </div>
) : null}
```

and:

```tsx
{hasAnyEnabledFeedType(searchFilters.typeFilters) && matchedFeed.length === 0 ? (
  <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/50 p-4 text-sm text-zinc-400">
    {searchFilters.keyword.trim()
      ? '没有匹配的人物、推文内容、CA 或地址'
      : '当前筛选条件下没有结果'}
  </div>
) : null}
```

- [ ] **Step 4: Run verification**

Run: `npm run test:search-filters && npm run test:feed-ordering && npm run test:time-format && npx eslint app/page.tsx lib/smartSearch.ts`  
Expected: PASS with no suggestion-related lint errors.

- [ ] **Step 5: Commit**

```bash
git add app/page.tsx lib/smartSearch.ts
git commit -m "feat(feed): replace advanced search with local filter bar"
```

### Task 5: Show Trade USD Amounts On Cards And Finish End-To-End Verification

**Files:**
- Modify: `/Users/xp/vibecoding/pilipili/components/ActivityCard.tsx`
- Modify: `/Users/xp/vibecoding/pilipili/lib/assetFormat.ts`
- Modify: `/Users/xp/vibecoding/pilipili/scripts/test-time-format.ts`

- [ ] **Step 1: Write the failing test**

Add a dedicated formatter assertion to `/Users/xp/vibecoding/pilipili/scripts/test-time-format.ts`:

```ts
import { formatTradeAmountUsdLabel } from '@/lib/assetFormat';

assert.equal(
  formatTradeAmountUsdLabel(12_500),
  '$12.5K',
  'trade usd amounts should render with compact USD text'
);

assert.equal(
  formatTradeAmountUsdLabel(null),
  '金额未知',
  'missing trade usd amounts should render as 金额未知'
);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:time-format`  
Expected: FAIL because `formatTradeAmountUsdLabel` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

In `/Users/xp/vibecoding/pilipili/lib/assetFormat.ts`, add:

```ts
export function formatTradeAmountUsdLabel(value: number | null | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return '金额未知';
  }

  return formatUsdCompact(value);
}
```

In `/Users/xp/vibecoding/pilipili/components/ActivityCard.tsx`, derive the new label:

```ts
import { formatTokenAmount, formatTradeAmountUsdLabel } from '@/lib/assetFormat';

const tradeAmountUsdAtTx =
  typeof activity.metadata.tradeAmountUsdAtTx === 'number' &&
  Number.isFinite(activity.metadata.tradeAmountUsdAtTx) &&
  activity.metadata.tradeAmountUsdAtTx > 0
    ? activity.metadata.tradeAmountUsdAtTx
    : null;

const tradeAmountUsdLabel =
  isTradeAction
    ? formatTradeAmountUsdLabel(tradeAmountUsdAtTx)
    : null;
```

Render it next to the existing trade details:

```tsx
{isTradeAction ? (
  <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
    {tradeAmountUsdLabel ? <span>{tradeAmountUsdLabel}</span> : null}
    {marketCapLabel ? <span>{marketCapLabel}</span> : null}
  </div>
) : null}
```

Do not show the USD trade amount block for `send/receive` or twitter rows.

- [ ] **Step 4: Run full verification and a manual browser check**

Run:

```bash
npm run test:trade-usd && \
npm run test:search-filters && \
npm run test:feed-ordering && \
npm run test:time-format && \
npx eslint app/page.tsx components/ActivityCard.tsx lib/smartSearch.ts lib/tradeUsd.ts lib/activityFeed.ts lib/parsing/toActivity.ts lib/server/telegramMonitorFeed.ts types/index.ts scripts/test-trade-usd.ts scripts/test-search-filters.ts
```

Expected: PASS.

Then manually verify in the in-app browser on the feed page:

- typing a keyword filters immediately
- tweet text matches only on twitter rows
- chain `content` text does not act as a keyword match target
- toggling all three type filters off shows `请至少选择一种类型`
- setting `最低成交金额（USD）` hides trades with smaller or unknown `tradeAmountUsdAtTx`
- setting `最低成交市值` hides trades with smaller or unknown `marketCapAtTxUsd`
- trade cards show compact USD amount or `金额未知`

- [ ] **Step 5: Commit**

```bash
git add components/ActivityCard.tsx lib/assetFormat.ts app/page.tsx lib/smartSearch.ts lib/tradeUsd.ts lib/activityFeed.ts lib/parsing/toActivity.ts lib/server/telegramMonitorFeed.ts types/index.ts scripts/test-trade-usd.ts scripts/test-search-filters.ts package.json
git commit -m "feat(feed): add trade amount filters and card display"
```

## Self-Review

- Spec coverage:
  - simple realtime keyword search is covered in Task 3 and Task 4
  - `交易 / 转账 / 推特` type filters are covered in Task 3 and Task 4
  - trade-only minimum USD amount and market-cap filters are covered in Task 3 and Task 4
  - persisting `tradeAmountUsdAtTx` is covered in Task 1 and Task 2
  - showing `金额未知` on trade cards is covered in Task 5
  - keeping server feed loading untouched is covered by Task 4's `useActivityPolling(selectedUserId, '')` change
- Placeholder scan:
  - no `TODO`, `TBD`, or undefined helper names remain
  - all test commands, file paths, and commit commands are concrete
- Type consistency:
  - `tradeAmountUsdAtTx` is the single metadata field name used across helper, feed logic, filters, and card rendering
  - `FeedSearchFilters` and `typeFilters.trade/transfer/twitter` are used consistently across tests and page state
