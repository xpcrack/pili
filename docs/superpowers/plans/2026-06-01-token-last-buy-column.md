# Token Last Buy Column Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `上次买入` column to `/tokens` that shows the latest buy time across all pili tracked addresses for each token.

**Architecture:** Keep token list and price lookup in the existing `/api/tokens` route, and add one server-side events aggregation helper that maps `(chain, tokenAddress)` to the latest buy timestamp. The page stays a client component and reuses the existing relative-time formatter, so the visible behavior matches the current address table without adding another data path or cache layer.

**Tech Stack:** TypeScript 5, Next.js 16 App Router route handlers, better-sqlite3, Node 24.11.1, `tsx` test runner via `npm test`, React client components.

---

## Scope Check

This plan implements one focused feature from `docs/superpowers/specs/2026-06-01-token-last-buy-column-design.md`.

- In scope: event aggregation helper, `/api/tokens` payload extension, tokens table UI update, focused tests, build/runtime verification.
- Out of scope: new token tables, new background workers, sync pipeline changes, HyperCore fuzzy matching, unrelated worktree dirt.

The workspace already contains unrelated modified and untracked files. Do not touch them. Only stage and commit the files listed in each task.

Before editing Next route code, read the repo's Next.js route handler docs because this project uses a breaking-change Next build:

```bash
sed -n '1,220p' AGENTS.md
sed -n '1,240p' node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md
git status --short
```

Expected: confirm the runtime rules, note the unrelated dirty files, and keep them out of this plan.

---

## File Structure

### Create

- `scripts/test-events-latest-buy.ts` — focused temp-db test for the new aggregation helper.
- `scripts/test-tokens-api.ts` — route-level test for `/api/tokens` with price fetches stubbed out.

### Modify

- `lib/server/eventsRepo.ts` — add `readLatestBuyAtByToken()` and its small normalization helper.
- `app/api/tokens/route.ts` — merge `last_buy_at` into each token item.
- `app/tokens/page.tsx` — render the new column and keep the empty-state width correct.

### Leave Alone

- `lib/server/tokensRepo.ts`
- `lib/server/priceService.ts`
- `lib/server/dexscreener.ts`
- `lib/server/hypercoreClient.ts`

Those files already do their jobs; the new behavior should hang off the existing route and events repo instead of introducing another abstraction.

---

## Task 1: Add the latest-buy aggregation helper

**Files:**
- Modify: `lib/server/eventsRepo.ts`
- Create: `scripts/test-events-latest-buy.ts`

- [ ] **Step 1: Write the failing test**

Create `scripts/test-events-latest-buy.ts` with a temp-db harness that seeds two tracked users, two buys for the same token on the same chain, and one later non-buy for the same token. The test should import the new helper and fail because it does not exist yet.

```ts
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Activity, User } from '@/types';
import './server-only-shim.cjs';

function makeUser(id: string, address: string): User {
  return {
    id,
    name: id,
    handle: id,
    avatar: '',
    addresses: [
      {
        address,
        name: '#1',
        chain: 'bsc',
        totalAssetUsd: null,
        assetUpdatedAt: null,
      },
    ],
    totalAssetUsd: 0,
    historicalMaxAssetUsd: 0,
    assetUpdatedAt: null,
    tags: [],
  };
}

function makeBuyActivity(params: {
  txHash: string;
  timestamp: number;
  trackedAddress: string;
  tokenAddress: string;
}): Activity {
  return {
    id: `buy:${params.txHash}`,
    userId: 'temp-user',
    source: 'blockchain',
    type: 'transfer',
    title: '买入资产',
    content: '买入资产',
    timestamp: params.timestamp,
    metadata: {
      txHash: params.txHash,
      chain: 'bsc',
      txAction: 'buy',
      trackedAddress: params.trackedAddress,
      tokenAddress: params.tokenAddress,
      token: 'TEST',
    },
  };
}

function makeSellActivity(params: {
  txHash: string;
  timestamp: number;
  trackedAddress: string;
  tokenAddress: string;
}): Activity {
  return {
    id: `sell:${params.txHash}`,
    userId: 'temp-user',
    source: 'blockchain',
    type: 'transfer',
    title: '卖出资产',
    content: '卖出资产',
    timestamp: params.timestamp,
    metadata: {
      txHash: params.txHash,
      chain: 'bsc',
      txAction: 'sell',
      trackedAddress: params.trackedAddress,
      tokenAddress: params.tokenAddress,
      token: 'TEST',
    },
  };
}

async function run() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pilipili-events-latest-buy-'));
  const previousDbPath = process.env.PILIPILI_DB_PATH;
  const previousDataDir = process.env.PILIPILI_DATA_DIR;
  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');

  try {
    const { createTrackedUser } = await import('@/lib/server/trackedUsersRepo');
    const { upsertEventsFromFeedRows, readLatestBuyAtByToken } = await import('@/lib/server/eventsRepo');

    const tokenAddress = '0xaaaa000000000000000000000000000000000001';
    const otherTokenAddress = '0xbbbb000000000000000000000000000000000002';

    const userA = createTrackedUser({
      name: 'A',
      handle: 'a',
      avatar: '',
      tags: [],
      addresses: [
        { address: '0x1111111111111111111111111111111111111111', name: '#1', chain: 'bsc', totalAssetUsd: null, assetUpdatedAt: null },
      ],
      totalAssetUsd: 0,
      historicalMaxAssetUsd: 0,
      assetUpdatedAt: null,
      twitter: undefined,
      telegram: undefined,
    });
    const userB = createTrackedUser({
      name: 'B',
      handle: 'b',
      avatar: '',
      tags: [],
      addresses: [
        { address: '0x2222222222222222222222222222222222222222', name: '#1', chain: 'bsc', totalAssetUsd: null, assetUpdatedAt: null },
      ],
      totalAssetUsd: 0,
      historicalMaxAssetUsd: 0,
      assetUpdatedAt: null,
      twitter: undefined,
      telegram: undefined,
    });

    upsertEventsFromFeedRows(
      [{ user: userA, activity: makeBuyActivity({ txHash: '0x1', timestamp: 1_000, trackedAddress: userA.addresses[0]!.address, tokenAddress }) }],
      'test'
    );
    upsertEventsFromFeedRows(
      [{ user: userB, activity: makeBuyActivity({ txHash: '0x2', timestamp: 2_500, trackedAddress: userB.addresses[0]!.address, tokenAddress }) }],
      'test'
    );
    upsertEventsFromFeedRows(
      [{ user: userA, activity: makeSellActivity({ txHash: '0x3', timestamp: 4_000, trackedAddress: userA.addresses[0]!.address, tokenAddress }) }],
      'test'
    );
    upsertEventsFromFeedRows(
      [{ user: userA, activity: makeBuyActivity({ txHash: '0x4', timestamp: 3_000, trackedAddress: userA.addresses[0]!.address, tokenAddress: otherTokenAddress }) }],
      'test'
    );

    const result = readLatestBuyAtByToken([
      { chain: 'bsc', contractAddress: tokenAddress },
      { chain: 'bsc', contractAddress: otherTokenAddress },
    ]);

    assert.equal(result.get('bsc:0xaaaa000000000000000000000000000000000001'), 2_500);
    assert.equal(result.get('bsc:0xbbbb000000000000000000000000000000000002'), 3_000);
    assert.equal(result.has('bsc:0xcccc000000000000000000000000000000000003'), false);

    console.log('events latest buy tests: ok');
  } finally {
    if (previousDbPath === undefined) delete process.env.PILIPILI_DB_PATH;
    else process.env.PILIPILI_DB_PATH = previousDbPath;

    if (previousDataDir === undefined) delete process.env.PILIPILI_DATA_DIR;
    else process.env.PILIPILI_DATA_DIR = previousDataDir;

    rmSync(tempDir, { recursive: true, force: true });
  }
}

void run();
```

- [ ] **Step 2: Run the test and confirm it fails**

Run:

```bash
npm test -- --filter=events-latest-buy
```

Expected: fail with an error that points at the missing helper export or an empty result, proving the test is exercising the right seam.

- [ ] **Step 3: Implement the minimal helper**

In `lib/server/eventsRepo.ts`, add a small normalizer and the aggregation helper. Keep it close to the existing `readLatestActivityAtByUser()` function so the file stays organized by read-model helpers.

```ts
function normalizeTokenAddress(value: string | null | undefined) {
  return (value || '').trim().toLowerCase();
}

export function readLatestBuyAtByToken(tokens: Array<{ chain: string; contractAddress: string }>) {
  const requested = tokens
    .map((token) => ({ chain: (token.chain || '').trim().toLowerCase(), contractAddress: normalizeTokenAddress(token.contractAddress) }))
    .filter((token) => token.chain && token.contractAddress);

  if (requested.length === 0) {
    return new Map<string, number>();
  }

  const db = getDb();
  const valuesSql = requested.map(() => '(?, ?)').join(', ');
  const params = requested.flatMap((token) => [token.chain, token.contractAddress]);

  const rows = db
    .prepare(
      `WITH requested_tokens(chain, token_address_lower) AS (
         VALUES ${valuesSql}
       )
       SELECT
         e.chain AS chain,
         LOWER(COALESCE(json_extract(e.activity_json, '$.metadata.tokenAddress'), '')) AS token_address_lower,
         MAX(e.timestamp) AS latest_ts
       FROM events e
       JOIN requested_tokens rt
         ON rt.chain = e.chain
        AND rt.token_address_lower = LOWER(COALESCE(json_extract(e.activity_json, '$.metadata.tokenAddress'), ''))
       WHERE e.source = 'blockchain'
         AND e.action = 'buy'
         AND e.user_id IS NOT NULL
         AND e.user_id != ''
       GROUP BY e.chain, token_address_lower`
    )
    .all(...params) as Array<{ chain: string; token_address_lower: string; latest_ts: number | null }>;

  const latestByToken = new Map<string, number>();
  for (const row of rows) {
    const ts = typeof row.latest_ts === 'number' && Number.isFinite(row.latest_ts) ? row.latest_ts : null;
    if (!ts) continue;
    latestByToken.set(`${row.chain}:${row.token_address_lower}`, ts);
  }

  return latestByToken;
}
```

- [ ] **Step 4: Run the test again and confirm it passes**

Run:

```bash
npm test -- --filter=events-latest-buy
```

Expected: pass, proving the helper returns the latest buy timestamp and ignores later non-buy activity.

- [ ] **Step 5: Commit**

```bash
git add lib/server/eventsRepo.ts scripts/test-events-latest-buy.ts
git commit -m "feat: add latest buy aggregation"
```

---

## Task 2: Wire the helper into `/api/tokens`

**Files:**
- Modify: `app/api/tokens/route.ts`
- Create: `scripts/test-tokens-api.ts`

- [ ] **Step 1: Write the failing route test**

Create `scripts/test-tokens-api.ts` with a temp-db setup, two tokens in the `tokens` table, one latest buy timestamp for only one token, and a stubbed `global.fetch` that returns a fixed DexScreener payload so the route never hits the network.

```ts
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NextRequest } from 'next/server';
import './server-only-shim.cjs';

function makeDexScreenerResponse(address: string) {
  return {
    schemaVersion: '1.0.0',
    pairs: [
      {
        chainId: 'bsc',
        pairAddress: '0xpair',
        baseToken: {
          address,
          name: 'Token One',
          symbol: 'ONE',
        },
        quoteToken: {
          address: '0xwbnb',
          name: 'Wrapped BNB',
          symbol: 'WBNB',
        },
        priceUsd: '1.23',
        priceChange: { m5: 0, h1: 0, h6: 0, h24: 2.34 },
        liquidity: { usd: 1234 },
        volume: { m5: 0, h1: 0, h6: 0, h24: 0 },
        fdv: 1000,
        marketCap: 2000,
        pairCreatedAt: 0,
      },
    ],
  };
}

async function run() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pilipili-tokens-api-'));
  const previousDbPath = process.env.PILIPILI_DB_PATH;
  const previousDataDir = process.env.PILIPILI_DATA_DIR;
  const originalFetch = globalThis.fetch;

  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');

  globalThis.fetch = (async (input: string | URL | Request) => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(rawUrl, 'http://localhost');

    if (url.pathname.startsWith('/latest/dex/tokens/')) {
      return new Response(JSON.stringify(makeDexScreenerResponse('0xaaaa000000000000000000000000000000000001')), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    throw new Error(`unexpected fetch: ${url.toString()}`);
  }) as typeof fetch;

  try {
    const { createTrackedUser } = await import('@/lib/server/trackedUsersRepo');
    const { addToken } = await import('@/lib/server/tokensRepo');
    const { upsertEventsFromFeedRows } = await import('@/lib/server/eventsRepo');
    const route = await import('../app/api/tokens/route');

    const user = createTrackedUser({
      name: 'Token Tester',
      handle: 'token-tester',
      avatar: '',
      tags: [],
      addresses: [
        { address: '0x1111111111111111111111111111111111111111', name: '#1', chain: 'bsc', totalAssetUsd: null, assetUpdatedAt: null },
      ],
      totalAssetUsd: 0,
      historicalMaxAssetUsd: 0,
      assetUpdatedAt: null,
      twitter: undefined,
      telegram: undefined,
    });

    addToken('bsc', '0xaaaa000000000000000000000000000000000001', ['alpha']);
    addToken('bsc', '0xbbbb000000000000000000000000000000000002', ['beta']);

    upsertEventsFromFeedRows(
      [
        {
          user,
          activity: {
            id: 'buy-1',
            userId: user.id,
            source: 'blockchain',
            type: 'transfer',
            title: '买入资产',
            content: '买入资产',
            timestamp: 1_000,
            metadata: {
              txHash: '0x1',
              chain: 'bsc',
              txAction: 'buy',
              trackedAddress: user.addresses[0]!.address,
              tokenAddress: '0xaaaa000000000000000000000000000000000001',
              token: 'ONE',
            },
          },
        },
        {
          user,
          activity: {
            id: 'buy-2',
            userId: user.id,
            source: 'blockchain',
            type: 'transfer',
            title: '买入资产',
            content: '买入资产',
            timestamp: 2_000,
            metadata: {
              txHash: '0x2',
              chain: 'bsc',
              txAction: 'buy',
              trackedAddress: user.addresses[0]!.address,
              tokenAddress: '0xaaaa000000000000000000000000000000000001',
              token: 'ONE',
            },
          },
        },
      ],
      'test'
    );

    const response = await route.GET(new NextRequest('http://localhost/api/tokens'));
    assert.equal(response.status, 200);

    const payload = (await response.json()) as {
      items: Array<{
        chain: string;
        contract_address: string;
        price: number | null;
        last_buy_at: number | null;
      }>;
    };

    const first = payload.items.find((item) => item.contract_address === '0xaaaa000000000000000000000000000000000001');
    const second = payload.items.find((item) => item.contract_address === '0xbbbb000000000000000000000000000000000002');

    assert.equal(first?.price, 1.23);
    assert.equal(first?.last_buy_at, 2_000);
    assert.equal(second?.last_buy_at, null);

    console.log('tokens api tests: ok');
  } finally {
    globalThis.fetch = originalFetch;

    if (previousDbPath === undefined) delete process.env.PILIPILI_DB_PATH;
    else process.env.PILIPILI_DB_PATH = previousDbPath;

    if (previousDataDir === undefined) delete process.env.PILIPILI_DATA_DIR;
    else process.env.PILIPILI_DATA_DIR = previousDataDir;

    rmSync(tempDir, { recursive: true, force: true });
  }
}

void run();
```

- [ ] **Step 2: Run the route test and confirm it fails**

Run:

```bash
npm test -- --filter=tokens-api
```

Expected: fail because `/api/tokens` does not yet return `last_buy_at`.

- [ ] **Step 3: Wire the helper into the route**

In `app/api/tokens/route.ts`, import `readLatestBuyAtByToken()` and merge its result into each token item before returning JSON.

```ts
import { listTokens, addToken, deleteTokens, bulkImportTokens, type TokenChain } from '@/lib/server/tokensRepo';
import { getBatchTokenPrices } from '@/lib/server/priceService';
import { readLatestBuyAtByToken } from '@/lib/server/eventsRepo';

// ...

const latestBuyByToken = readLatestBuyAtByToken(
  tokens.map((token) => ({ chain: token.chain, contractAddress: token.contract_address }))
);

const tokensWithPrice = tokens.map((token) => {
  const key = `${token.chain}:${token.contract_address.trim().toLowerCase()}`;
  const priceData = prices.get(key);

  return {
    ...token,
    price: priceData?.price ?? null,
    market_cap: priceData?.marketCap ?? null,
    price_change_24h: priceData?.priceChange24h ?? null,
    ticker: priceData?.ticker ?? null,
    last_buy_at: latestBuyByToken.get(key) ?? null,
  };
});
```

- [ ] **Step 4: Run the route test again and confirm it passes**

Run:

```bash
npm test -- --filter=tokens-api
```

Expected: pass, proving the API payload now carries the last buy timestamp without breaking the price payload.

- [ ] **Step 5: Commit**

```bash
git add app/api/tokens/route.ts scripts/test-tokens-api.ts
git commit -m "feat: expose latest buy time in tokens api"
```

---

## Task 3: Render the new column in the tokens table

**Files:**
- Modify: `app/tokens/page.tsx`

- [ ] **Step 1: Update the page to use the new field**

Keep the component client-side, extend the token type, and render the new column with the same compact relative-time format the address table already uses.

```tsx
import { formatRelativeTimeCompact } from '@/lib/timeFormat';

interface Token {
  id: number;
  chain: string;
  contract_address: string;
  tags: string;
  imported_at: number;
  price: number | null;
  market_cap: number | null;
  price_change_24h: number | null;
  ticker: string | null;
  last_buy_at: number | null;
}

// ...

<th className="px-3 py-3 text-right">上次买入</th>
// keep `24h` before it or after it depending on the existing visual order, but do not add a card or second table

<td className="px-3 py-3 text-right font-mono text-zinc-300">
  {typeof token.last_buy_at === 'number' && token.last_buy_at > 0
    ? formatRelativeTimeCompact(token.last_buy_at)
    : '-'}
</td>

// Update the empty-state row:
<td colSpan={9} className="px-3 py-8 text-center text-zinc-500">
```

Do not change sorting, bulk import, delete behavior, or the current button layout.

- [ ] **Step 2: Run a full build to catch type and JSX regressions**

Run:

```bash
npm run build
```

Expected: pass. This catches both the new field typing and any table column-count mistakes.

- [ ] **Step 3: Refresh the production web process and verify the UI**

Run:

```bash
npm run runtime:refresh
```

Then open `/tokens` in the in-app browser or local browser and confirm:

- the table has an `上次买入` column,
- rows with buys show `刚刚` / `12m` / `3h` / `5d` style labels,
- tokens without buys show `-`,
- the empty state still centers correctly.

- [ ] **Step 4: Commit**

```bash
git add app/tokens/page.tsx
git commit -m "feat: show latest buy time in tokens table"
```

---

## Verification Gate

After the three tasks finish, rerun the focused checks once more if anything drifted during the edits:

```bash
npm test -- --filter=events-latest-buy
npm test -- --filter=tokens-api
npm run build
```

Only after those pass should the worker claim the feature is done or hand off to the production refresh flow.
