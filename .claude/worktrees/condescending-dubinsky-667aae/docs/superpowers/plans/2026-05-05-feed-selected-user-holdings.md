# Feed 选中人物持仓详情 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add selected-user holdings details to Feed by extending `GET /api/users/[id]`, aggregating OKX asset details by `链 + token`, and rendering the filtered holdings table directly under the selected-user summary.

**Architecture:** Keep Feed polling and user-details loading separate. Add one shared user-details contract module, one server-only holdings aggregation service, one route-layer GET handler factory, one client fetch wrapper plus cache-aware hook, and one extracted selected-user panel component that owns the summary + holdings UI while `app/page.tsx` remains the orchestration layer.

**Tech Stack:** Next.js 16 App Router, React 19 client components, TypeScript, `tsx` script tests, `better-sqlite3` data model, Tailwind utility classes, local Next.js docs in `node_modules/next/dist/docs/`.

---

## File Structure

### New files

- Create: `/Users/xp/vibecoding/pilipili/lib/userDetails.ts`
  - Shared selected-user details types and the `5 USD` holdings threshold constant.
- Create: `/Users/xp/vibecoding/pilipili/lib/server/userHoldingsDetails.ts`
  - Server-only OKX holdings aggregation service with partial-failure handling.
- Create: `/Users/xp/vibecoding/pilipili/lib/userDetailsApi.ts`
  - Client fetch wrapper for `GET /api/users/[id]`.
- Create: `/Users/xp/vibecoding/pilipili/hooks/useSelectedUserDetails.ts`
  - Cache-aware selected-user details hook with stale-while-revalidate behavior.
- Create: `/Users/xp/vibecoding/pilipili/components/SelectedUserDetailsPanel.tsx`
  - Extracted selected-user summary + holdings panel UI.
- Create: `/Users/xp/vibecoding/pilipili/scripts/test-user-holdings-details.ts`
  - Pure server-side aggregation test using injected fake OKX responses.
- Create: `/Users/xp/vibecoding/pilipili/scripts/test-user-details-route.ts`
  - Route-layer GET handler test using dependency injection instead of live network calls.
- Create: `/Users/xp/vibecoding/pilipili/scripts/test-user-details-api.ts`
  - Client fetch wrapper test for success and error cases.
- Create: `/Users/xp/vibecoding/pilipili/scripts/test-selected-user-details-hook-contract.ts`
  - Source-contract test for cache-first selected-user details hook behavior.
- Create: `/Users/xp/vibecoding/pilipili/scripts/test-selected-user-details-panel.tsx`
  - Static render test for loading / empty / error / partial / success panel states.
- Create: `/Users/xp/vibecoding/pilipili/scripts/test-feed-selected-user-details-contract.ts`
  - Source-contract test for `app/page.tsx` wiring to the new hook and panel.

### Existing files to modify

- Modify: `/Users/xp/vibecoding/pilipili/app/api/users/[id]/route.ts`
  - Add `GET` support via an injectable handler factory while preserving current `PATCH` and `DELETE`.
- Modify: `/Users/xp/vibecoding/pilipili/app/page.tsx`
  - Replace the inline selected-user summary block with the extracted panel and feed it from the new hook.
- Modify: `/Users/xp/vibecoding/pilipili/package.json`
  - Register new tests and add them to the aggregate `test` script.

### Existing docs to read before editing route and page files

- `/Users/xp/vibecoding/pilipili/node_modules/next/dist/docs/01-app/01-getting-started/03-layouts-and-pages.md`
- `/Users/xp/vibecoding/pilipili/node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`

---

### Task 1: Create The Worktree And Verify The Baseline

**Files:**
- Modify: `docs/superpowers/plans/2026-05-05-feed-selected-user-holdings.md`
- Test: `package.json`

- [ ] **Step 1: Verify the project-local worktree directory is ignored**

Run:

```bash
git check-ignore -q .worktrees
```

Expected: exit code `0`

- [ ] **Step 2: Create the dedicated branch and worktree**

Run:

```bash
git worktree add .worktrees/codex-feed-selected-user-holdings -b codex/feed-selected-user-holdings
```

Expected: new worktree created at `/Users/xp/vibecoding/pilipili/.worktrees/codex-feed-selected-user-holdings`

- [ ] **Step 3: Read the local Next.js docs that apply to this change**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-feed-selected-user-holdings
sed -n '1,200p' node_modules/next/dist/docs/01-app/01-getting-started/03-layouts-and-pages.md
sed -n '1,220p' node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md
```

Expected: docs confirm current App Router page and route-handler conventions

- [ ] **Step 4: Install dependencies in the new worktree if needed**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-feed-selected-user-holdings
npm install
```

Expected: install completes without engine or dependency errors under Node `24.11.1`

- [ ] **Step 5: Run the baseline subset before any code changes**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-feed-selected-user-holdings
npm run test:user-bar
npm run test:manage-users
npm run build
```

Expected: all commands pass on the untouched baseline

- [ ] **Step 6: Confirm the worktree is clean before implementation**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-feed-selected-user-holdings
git status --short
```

Expected: no unexpected tracked changes

---

### Task 2: Add The Shared User-Details Contract And Server Holdings Aggregation

**Files:**
- Create: `/Users/xp/vibecoding/pilipili/lib/userDetails.ts`
- Create: `/Users/xp/vibecoding/pilipili/lib/server/userHoldingsDetails.ts`
- Create: `/Users/xp/vibecoding/pilipili/scripts/test-user-holdings-details.ts`
- Modify: `/Users/xp/vibecoding/pilipili/package.json`
- Test: `/Users/xp/vibecoding/pilipili/scripts/test-user-holdings-details.ts`

- [ ] **Step 1: Write the failing holdings aggregation test**

```ts
// /Users/xp/vibecoding/pilipili/scripts/test-user-holdings-details.ts
import assert from 'node:assert/strict';

import './server-only-shim.cjs';

import {
  readUserHoldingsDetails,
  UserHoldingsDetailsUnavailableError,
} from '@/lib/server/userHoldingsDetails';
import type { User } from '@/types';

function makeUser(addresses: User['addresses']): User {
  return {
    id: 'user-1',
    name: 'testuser',
    handle: 'testuser',
    avatar: '',
    twitter: undefined,
    telegram: undefined,
    addresses,
    totalAssetUsd: 0,
    historicalMaxAssetUsd: 0,
    assetUpdatedAt: null,
    tags: [],
  };
}

async function run() {
  const user = makeUser([
    {
      address: '0xWalletOne',
      name: '#1',
      chain: 'bsc',
      totalAssetUsd: null,
      assetUpdatedAt: null,
    },
    {
      address: '0xWalletTwo',
      name: '#2',
      chain: 'bsc',
      totalAssetUsd: null,
      assetUpdatedAt: null,
    },
    {
      address: 'SoWallet1111111111111111111111111111111111',
      name: '#3',
      chain: 'solana',
      totalAssetUsd: null,
      assetUpdatedAt: null,
    },
  ]);

  const details = await readUserHoldingsDetails(user, {
    now: () => 9_999,
    fetchAddressAssetDetails: async (address, chain) => {
      if (address === '0xWalletOne' && chain === 'bsc') {
        return {
          ok: true,
          configured: true,
          totalAssetUsd: 9,
          assets: [
            {
              address,
              chain,
              assetKey: 'bsc:0xusdt',
              tokenAddress: '0xusdt',
              symbol: 'USDT',
              name: 'Tether USD',
              balance: 3,
              priceUsd: 1,
              valueUsd: 3,
            },
            {
              address,
              chain,
              assetKey: 'bsc:0xwbnb',
              tokenAddress: '0xwbnb',
              symbol: 'WBNB',
              name: 'Wrapped BNB',
              balance: 1,
              priceUsd: 6,
              valueUsd: 6,
            },
          ],
          error: null,
        };
      }

      if (address === '0xWalletTwo' && chain === 'bsc') {
        return {
          ok: true,
          configured: true,
          totalAssetUsd: 9,
          assets: [
            {
              address,
              chain,
              assetKey: 'bsc:0xusdt',
              tokenAddress: '0xusdt',
              symbol: 'USDT',
              name: 'Tether USD',
              balance: 5,
              priceUsd: 1,
              valueUsd: 5,
            },
            {
              address,
              chain,
              assetKey: 'bsc:0xdoge',
              tokenAddress: '0xdoge',
              symbol: 'DOGE',
              name: 'Dogecoin',
              balance: 100,
              priceUsd: 0.04,
              valueUsd: 4,
            },
          ],
          error: null,
        };
      }

      if (address.startsWith('SoWallet') && chain === 'solana') {
        return {
          ok: false,
          configured: true,
          totalAssetUsd: null,
          assets: [],
          error: 'temporary upstream failure',
        };
      }

      return {
        ok: false,
        configured: true,
        totalAssetUsd: null,
        assets: [],
        error: 'unexpected',
      };
    },
  });

  assert.equal(details.holdingsUpdatedAt, 9_999);
  assert.equal(details.summary.visibleCount, 2);
  assert.equal(details.summary.partial, true);
  assert.equal(details.summary.successfulAddressCount, 2);
  assert.equal(details.summary.failedAddressCount, 1);
  assert.deepEqual(
    details.holdings.map((holding) => [holding.chain, holding.symbol, holding.balance, holding.priceUsd, holding.valueUsd]),
    [
      ['bsc', 'USDT', 8, 1, 8],
      ['bsc', 'WBNB', 1, 6, 6],
    ],
    'same-chain same-token holdings should merge, rows under 5 USD should drop, and rows should sort by value desc'
  );

  const empty = await readUserHoldingsDetails(makeUser([]), {
    now: () => 123,
  });
  assert.deepEqual(empty.holdings, []);
  assert.equal(empty.holdingsUpdatedAt, null);
  assert.deepEqual(empty.summary, {
    visibleCount: 0,
    partial: false,
    successfulAddressCount: 0,
    failedAddressCount: 0,
  });

  await assert.rejects(
    () =>
      readUserHoldingsDetails(user, {
        fetchAddressAssetDetails: async () => ({
          ok: false,
          configured: true,
          totalAssetUsd: null,
          assets: [],
          error: 'all failed',
        }),
      }),
    UserHoldingsDetailsUnavailableError,
    'all failed addresses should raise a route-mappable unavailable error'
  );

  console.log('user holdings details tests: ok');
}

void run();
```

- [ ] **Step 2: Register the new server test**

```json
// /Users/xp/vibecoding/pilipili/package.json
{
  "scripts": {
    "test:user-holdings-details": "NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-user-holdings-details.ts",
    "test": "npm run test:admin-auth && npm run test:feed-ordering && npm run test:time-format && npm run test:activity-card-social && npm run test:activity-card-view-model && npm run test:activity-card-render && npm run test:activity-importance && npm run test:activity-importance-service && npm run test:activity-importance-ingest && npm run test:activity-importance-backfill && npm run test:trade-usd && npm run test:events-feed-total && npm run test:feed-request-arbiter && npm run test:feed-query-mode && npm run test:feed-client-state && npm run test:feed-completeness-visibility && npm run test:feed-prewarm-service && npm run test:activities-api && npm run test:activity-feed-retry && npm run test:global-search-wiring && npm run test:feed-page-state && npm run test:user-bar && npm run test:tooling-config && npm run test:node-runtime-policy && npm run test:search-filters && npm run test:source-reconciliation && npm run test:sync-failure-notifier && npm run test:manage-users && npm run test:tracked-user-validation && npm run test:tracked-address-ownership && npm run test:asset-peak-validation && npm run test:asset-peak-audit && npm run test:tracked-user-assets && npm run test:tracked-user-evm-expansion && npm run test:address-book && npm run test:address-management && npm run test:addresses-api && npm run test:address-assets && npm run test:user-holdings-details && npm run test:conflict-repo && npm run test:system-config-conflict-chat && npm run test:conflict-notifier && npm run test:parser-fixtures && npm run test:telegram-monitor-reconciliation && npm run test:twitter-fetcher && npm run test:twitter-provider-router && npm run test:twitter-provider-clients && npm run test:twitter-provider-state && npm run test:twitter-identity-service && npm run test:twitter-stable-identity && npm run test:twitter-sync-service && npm run test:twitter-relay-coverage && npm run test:twitter-bridge"
  }
}
```

- [ ] **Step 3: Run the new test and verify it fails**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-feed-selected-user-holdings
npm run test:user-holdings-details
```

Expected: FAIL because `lib/userDetails.ts` and `lib/server/userHoldingsDetails.ts` do not exist yet

- [ ] **Step 4: Create the shared user-details contract**

```ts
// /Users/xp/vibecoding/pilipili/lib/userDetails.ts
import type { ChainType, User } from '@/types';

export const USER_HOLDINGS_THRESHOLD_USD = 5;

export interface UserHoldingRow {
  chain: ChainType;
  tokenAddress: string;
  symbol: string;
  name: string | null;
  balance: number;
  priceUsd: number;
  valueUsd: number;
}

export interface UserHoldingsSummary {
  visibleCount: number;
  partial: boolean;
  successfulAddressCount: number;
  failedAddressCount: number;
}

export interface UserDetailsSuccessPayload {
  ok: true;
  user: User;
  holdings: UserHoldingRow[];
  holdingsUpdatedAt: number | null;
  holdingsThresholdUsd: typeof USER_HOLDINGS_THRESHOLD_USD;
  holdingsSummary: UserHoldingsSummary;
}

export interface UserDetailsErrorPayload {
  ok: false;
  error: string;
}
```

- [ ] **Step 5: Implement the server-only holdings aggregation service**

```ts
// /Users/xp/vibecoding/pilipili/lib/server/userHoldingsDetails.ts
import 'server-only';

import {
  fetchOkxAddressAssetDetails,
  type OkxAddressAssetDetail,
} from '@/lib/okx';
import {
  USER_HOLDINGS_THRESHOLD_USD,
  type UserHoldingRow,
  type UserHoldingsSummary,
} from '@/lib/userDetails';
import type { User } from '@/types';

type FetchAddressAssetDetails = typeof fetchOkxAddressAssetDetails;

export class UserHoldingsDetailsUnavailableError extends Error {}

interface ReadUserHoldingsDetailsOptions {
  fetchAddressAssetDetails?: FetchAddressAssetDetails;
  now?: () => number;
}

interface ReadUserHoldingsDetailsResult {
  holdings: UserHoldingRow[];
  holdingsUpdatedAt: number | null;
  summary: UserHoldingsSummary;
}

function mergeHoldingRows(assets: OkxAddressAssetDetail[]) {
  const merged = new Map<string, UserHoldingRow>();

  for (const asset of assets) {
    const existing = merged.get(asset.assetKey);
    if (!existing) {
      merged.set(asset.assetKey, {
        chain: asset.chain,
        tokenAddress: asset.tokenAddress,
        symbol: asset.symbol,
        name: asset.name,
        balance: asset.balance,
        priceUsd: asset.priceUsd,
        valueUsd: asset.valueUsd,
      });
      continue;
    }

    existing.balance += asset.balance;
    existing.valueUsd += asset.valueUsd;
    existing.priceUsd = existing.balance > 0 ? existing.valueUsd / existing.balance : existing.priceUsd;
    if (!existing.name && asset.name) {
      existing.name = asset.name;
    }
    if (!existing.symbol && asset.symbol) {
      existing.symbol = asset.symbol;
    }
  }

  return Array.from(merged.values())
    .filter((holding) => holding.valueUsd >= USER_HOLDINGS_THRESHOLD_USD)
    .sort(
      (left, right) =>
        right.valueUsd - left.valueUsd ||
        left.chain.localeCompare(right.chain) ||
        left.tokenAddress.localeCompare(right.tokenAddress)
    );
}

export async function readUserHoldingsDetails(
  user: User,
  options: ReadUserHoldingsDetailsOptions = {}
): Promise<ReadUserHoldingsDetailsResult> {
  if (user.addresses.length === 0) {
    return {
      holdings: [],
      holdingsUpdatedAt: null,
      summary: {
        visibleCount: 0,
        partial: false,
        successfulAddressCount: 0,
        failedAddressCount: 0,
      },
    };
  }

  const fetchAddressAssetDetails = options.fetchAddressAssetDetails ?? fetchOkxAddressAssetDetails;
  const now = options.now ?? Date.now;
  const settled = await Promise.all(
    user.addresses.map(async (address) => ({
      address,
      result: await fetchAddressAssetDetails(address.address, address.chain),
    }))
  );

  const successful = settled.filter((item) => item.result.ok);
  const failedCount = settled.length - successful.length;

  if (successful.length === 0) {
    throw new UserHoldingsDetailsUnavailableError('该人物全部地址的 OKX 明细读取失败');
  }

  const merged = mergeHoldingRows(successful.flatMap((item) => item.result.assets));

  return {
    holdings: merged,
    holdingsUpdatedAt: now(),
    summary: {
      visibleCount: merged.length,
      partial: failedCount > 0,
      successfulAddressCount: successful.length,
      failedAddressCount: failedCount,
    },
  };
}
```

- [ ] **Step 6: Run the focused server aggregation verification**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-feed-selected-user-holdings
npm run test:user-holdings-details
```

Expected: PASS with `user holdings details tests: ok`

- [ ] **Step 7: Commit the contract and server service slice**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-feed-selected-user-holdings
git add lib/userDetails.ts lib/server/userHoldingsDetails.ts scripts/test-user-holdings-details.ts package.json
git commit -m "feat: add selected user holdings aggregation"
```

Expected: commit created with the new shared contract and server aggregation layer

---

### Task 3: Extend `GET /api/users/[id]` For Selected-User Details

**Files:**
- Modify: `/Users/xp/vibecoding/pilipili/app/api/users/[id]/route.ts`
- Create: `/Users/xp/vibecoding/pilipili/scripts/test-user-details-route.ts`
- Modify: `/Users/xp/vibecoding/pilipili/package.json`
- Test: `/Users/xp/vibecoding/pilipili/scripts/test-user-details-route.ts`

- [ ] **Step 1: Write the failing route-layer GET handler test**

```ts
// /Users/xp/vibecoding/pilipili/scripts/test-user-details-route.ts
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';

import './server-only-shim.cjs';

import { USER_HOLDINGS_THRESHOLD_USD } from '@/lib/userDetails';
import { UserHoldingsDetailsUnavailableError } from '@/lib/server/userHoldingsDetails';
import type { User } from '@/types';

function makeUser(id = 'user-1'): User {
  return {
    id,
    name: 'testuser',
    handle: 'testuser',
    avatar: '',
    twitter: undefined,
    telegram: undefined,
    addresses: [],
    totalAssetUsd: 123,
    historicalMaxAssetUsd: 456,
    assetUpdatedAt: 999,
    tags: ['聪明钱'],
  };
}

async function run() {
  const route = await import('@/app/api/users/[id]/route');
  const user = makeUser();

  const successGet = route.createGetUserDetailsHandler({
    listUsers: () => [user],
    readUserHoldingsDetails: async () => ({
      holdings: [
        {
          chain: 'bsc',
          tokenAddress: '0xusdt',
          symbol: 'USDT',
          name: 'Tether USD',
          balance: 8,
          priceUsd: 1,
          valueUsd: 8,
        },
      ],
      holdingsUpdatedAt: 777,
      summary: {
        visibleCount: 1,
        partial: true,
        successfulAddressCount: 2,
        failedAddressCount: 1,
      },
    }),
  });

  const successResponse = await successGet(
    new NextRequest('http://localhost:3000/api/users/user-1'),
    { params: Promise.resolve({ id: 'user-1' }) }
  );
  assert.equal(successResponse.status, 200);
  assert.deepEqual(await successResponse.json(), {
    ok: true,
    user,
    holdings: [
      {
        chain: 'bsc',
        tokenAddress: '0xusdt',
        symbol: 'USDT',
        name: 'Tether USD',
        balance: 8,
        priceUsd: 1,
        valueUsd: 8,
      },
    ],
    holdingsUpdatedAt: 777,
    holdingsThresholdUsd: USER_HOLDINGS_THRESHOLD_USD,
    holdingsSummary: {
      visibleCount: 1,
      partial: true,
      successfulAddressCount: 2,
      failedAddressCount: 1,
    },
  });

  const notFoundGet = route.createGetUserDetailsHandler({
    listUsers: () => [],
  });
  const notFoundResponse = await notFoundGet(
    new NextRequest('http://localhost:3000/api/users/missing'),
    { params: Promise.resolve({ id: 'missing' }) }
  );
  assert.equal(notFoundResponse.status, 404);
  assert.deepEqual(await notFoundResponse.json(), { ok: false, error: '用户不存在' });

  const unavailableGet = route.createGetUserDetailsHandler({
    listUsers: () => [user],
    readUserHoldingsDetails: async () => {
      throw new UserHoldingsDetailsUnavailableError('该人物全部地址的 OKX 明细读取失败');
    },
  });
  const unavailableResponse = await unavailableGet(
    new NextRequest('http://localhost:3000/api/users/user-1'),
    { params: Promise.resolve({ id: 'user-1' }) }
  );
  assert.equal(unavailableResponse.status, 502);
  assert.deepEqual(await unavailableResponse.json(), {
    ok: false,
    error: '该人物全部地址的 OKX 明细读取失败',
  });

  console.log('user details route tests: ok');
}

void run();
```

- [ ] **Step 2: Register the new route test**

```json
// /Users/xp/vibecoding/pilipili/package.json
{
  "scripts": {
    "test:user-details-route": "NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-user-details-route.ts",
    "test": "npm run test:admin-auth && npm run test:feed-ordering && npm run test:time-format && npm run test:activity-card-social && npm run test:activity-card-view-model && npm run test:activity-card-render && npm run test:activity-importance && npm run test:activity-importance-service && npm run test:activity-importance-ingest && npm run test:activity-importance-backfill && npm run test:trade-usd && npm run test:events-feed-total && npm run test:feed-request-arbiter && npm run test:feed-query-mode && npm run test:feed-client-state && npm run test:feed-completeness-visibility && npm run test:feed-prewarm-service && npm run test:activities-api && npm run test:activity-feed-retry && npm run test:global-search-wiring && npm run test:feed-page-state && npm run test:user-bar && npm run test:tooling-config && npm run test:node-runtime-policy && npm run test:search-filters && npm run test:source-reconciliation && npm run test:sync-failure-notifier && npm run test:manage-users && npm run test:tracked-user-validation && npm run test:tracked-address-ownership && npm run test:asset-peak-validation && npm run test:asset-peak-audit && npm run test:tracked-user-assets && npm run test:tracked-user-evm-expansion && npm run test:address-book && npm run test:address-management && npm run test:addresses-api && npm run test:address-assets && npm run test:user-holdings-details && npm run test:user-details-route && npm run test:conflict-repo && npm run test:system-config-conflict-chat && npm run test:conflict-notifier && npm run test:parser-fixtures && npm run test:telegram-monitor-reconciliation && npm run test:twitter-fetcher && npm run test:twitter-provider-router && npm run test:twitter-provider-clients && npm run test:twitter-provider-state && npm run test:twitter-identity-service && npm run test:twitter-stable-identity && npm run test:twitter-sync-service && npm run test:twitter-relay-coverage && npm run test:twitter-bridge"
  }
}
```

- [ ] **Step 3: Run the new route test and verify it fails**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-feed-selected-user-holdings
npm run test:user-details-route
```

Expected: FAIL because `createGetUserDetailsHandler()` and `GET` do not exist yet

- [ ] **Step 4: Add the injectable GET handler to the existing route file**

```ts
// /Users/xp/vibecoding/pilipili/app/api/users/[id]/route.ts
import { NextRequest, NextResponse } from 'next/server';

import {
  deleteTrackedUser,
  listTrackedUsers,
  TrackedAddressOwnershipConflictError,
  updateTrackedUser,
} from '@/lib/server/trackedUsersRepo';
import {
  readUserHoldingsDetails,
  UserHoldingsDetailsUnavailableError,
} from '@/lib/server/userHoldingsDetails';
import { USER_HOLDINGS_THRESHOLD_USD } from '@/lib/userDetails';
// keep the existing imports below unchanged

interface GetUserDetailsDeps {
  listUsers?: typeof listTrackedUsers;
  readUserHoldingsDetails?: typeof readUserHoldingsDetails;
}

export function createGetUserDetailsHandler(deps: GetUserDetailsDeps = {}) {
  const listUsers = deps.listUsers ?? listTrackedUsers;
  const readDetails = deps.readUserHoldingsDetails ?? readUserHoldingsDetails;

  return async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
    try {
      const { id } = await context.params;
      const user = listUsers().find((candidate) => candidate.id === id) || null;
      if (!user) {
        return NextResponse.json({ ok: false, error: '用户不存在' }, { status: 404 });
      }

      const details = await readDetails(user);
      return NextResponse.json({
        ok: true,
        user,
        holdings: details.holdings,
        holdingsUpdatedAt: details.holdingsUpdatedAt,
        holdingsThresholdUsd: USER_HOLDINGS_THRESHOLD_USD,
        holdingsSummary: details.summary,
      });
    } catch (error) {
      if (error instanceof UserHoldingsDetailsUnavailableError) {
        return NextResponse.json({ ok: false, error: error.message }, { status: 502 });
      }

      const message = error instanceof Error ? error.message : '读取用户详情失败';
      return NextResponse.json({ ok: false, error: message }, { status: 500 });
    }
  };
}

export const GET = createGetUserDetailsHandler();
```

Keep the existing `PATCH` and `DELETE` handlers exactly where they are, below the new GET factory.

- [ ] **Step 5: Run the route verification**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-feed-selected-user-holdings
npm run test:user-details-route
npm run test:user-holdings-details
```

Expected: PASS with both `user details route tests: ok` and `user holdings details tests: ok`

- [ ] **Step 6: Commit the route slice**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-feed-selected-user-holdings
git add app/api/users/[id]/route.ts scripts/test-user-details-route.ts package.json
git commit -m "feat: add selected user details route"
```

Expected: commit created with injectable GET route coverage

---

### Task 4: Add The Client Fetch Wrapper And Cache-Aware Hook

**Files:**
- Create: `/Users/xp/vibecoding/pilipili/lib/userDetailsApi.ts`
- Create: `/Users/xp/vibecoding/pilipili/hooks/useSelectedUserDetails.ts`
- Create: `/Users/xp/vibecoding/pilipili/scripts/test-user-details-api.ts`
- Create: `/Users/xp/vibecoding/pilipili/scripts/test-selected-user-details-hook-contract.ts`
- Modify: `/Users/xp/vibecoding/pilipili/package.json`
- Test: `/Users/xp/vibecoding/pilipili/scripts/test-user-details-api.ts`
- Test: `/Users/xp/vibecoding/pilipili/scripts/test-selected-user-details-hook-contract.ts`

- [ ] **Step 1: Write the failing client fetch-wrapper test**

```ts
// /Users/xp/vibecoding/pilipili/scripts/test-user-details-api.ts
import assert from 'node:assert/strict';

import { fetchUserDetails } from '@/lib/userDetailsApi';

async function run() {
  const originalFetch = globalThis.fetch;
  let capturedUrl: URL | null = null;
  let capturedCache: RequestCache | undefined;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const rawUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    capturedUrl = new URL(rawUrl, 'http://localhost');
    capturedCache = init?.cache;

    return new Response(
      JSON.stringify({
        ok: true,
        user: {
          id: 'user-1',
          name: 'testuser',
          handle: 'testuser',
          avatar: '',
          addresses: [],
          totalAssetUsd: 123,
          historicalMaxAssetUsd: 456,
          assetUpdatedAt: null,
          tags: [],
        },
        holdings: [
          {
            chain: 'bsc',
            tokenAddress: '0xusdt',
            symbol: 'USDT',
            name: 'Tether USD',
            balance: 8,
            priceUsd: 1,
            valueUsd: 8,
          },
        ],
        holdingsUpdatedAt: 888,
        holdingsThresholdUsd: 5,
        holdingsSummary: {
          visibleCount: 1,
          partial: false,
          successfulAddressCount: 1,
          failedAddressCount: 0,
        },
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );
  }) as typeof fetch;

  try {
    const payload = await fetchUserDetails('user-1');
    assert.equal(capturedUrl?.pathname, '/api/users/user-1');
    assert.equal(capturedCache, 'no-store');
    assert.equal(payload.user.id, 'user-1');
    assert.equal(payload.holdings[0]?.symbol, 'USDT');
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: false, error: 'upstream failed' }), {
      status: 502,
      headers: {
        'Content-Type': 'application/json',
      },
    })) as typeof fetch;

  try {
    await assert.rejects(
      () => fetchUserDetails('user-1'),
      /upstream failed/,
      'fetch wrapper should surface route errors'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log('user details api tests: ok');
}

void run();
```

- [ ] **Step 2: Write the failing hook source-contract test**

```ts
// /Users/xp/vibecoding/pilipili/scripts/test-selected-user-details-hook-contract.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readProjectFile(relativePath: string) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function run() {
  const hookSource = readProjectFile('hooks/useSelectedUserDetails.ts');

  assert.match(
    hookSource,
    /new Map<string,\s*UserDetailsSuccessPayload>\(\)/,
    'selected-user details hook should keep a per-user in-memory payload cache'
  );
  assert.match(
    hookSource,
    /const cached = cacheRef\.current\.get\(userId\)/,
    'selected-user details hook should check cache before forcing a blocking load'
  );
  assert.match(
    hookSource,
    /cacheRef\.current\.set\(userId,\s*payload\)/,
    'selected-user details hook should refresh cached payloads after successful fetches'
  );
  assert.match(
    hookSource,
    /setRefreshing\(Boolean\(cached\)\)/,
    'selected-user details hook should distinguish background refresh from first-load blocking state'
  );

  console.log('selected user details hook contract tests: ok');
}

run();
```

- [ ] **Step 3: Register the new client tests**

```json
// /Users/xp/vibecoding/pilipili/package.json
{
  "scripts": {
    "test:user-details-api": "tsx scripts/test-user-details-api.ts",
    "test:selected-user-details-hook-contract": "tsx scripts/test-selected-user-details-hook-contract.ts",
    "test": "npm run test:admin-auth && npm run test:feed-ordering && npm run test:time-format && npm run test:activity-card-social && npm run test:activity-card-view-model && npm run test:activity-card-render && npm run test:activity-importance && npm run test:activity-importance-service && npm run test:activity-importance-ingest && npm run test:activity-importance-backfill && npm run test:trade-usd && npm run test:events-feed-total && npm run test:feed-request-arbiter && npm run test:feed-query-mode && npm run test:feed-client-state && npm run test:feed-completeness-visibility && npm run test:feed-prewarm-service && npm run test:activities-api && npm run test:activity-feed-retry && npm run test:global-search-wiring && npm run test:feed-page-state && npm run test:user-bar && npm run test:tooling-config && npm run test:node-runtime-policy && npm run test:search-filters && npm run test:source-reconciliation && npm run test:sync-failure-notifier && npm run test:manage-users && npm run test:tracked-user-validation && npm run test:tracked-address-ownership && npm run test:asset-peak-validation && npm run test:asset-peak-audit && npm run test:tracked-user-assets && npm run test:tracked-user-evm-expansion && npm run test:address-book && npm run test:address-management && npm run test:addresses-api && npm run test:address-assets && npm run test:user-holdings-details && npm run test:user-details-route && npm run test:user-details-api && npm run test:selected-user-details-hook-contract && npm run test:conflict-repo && npm run test:system-config-conflict-chat && npm run test:conflict-notifier && npm run test:parser-fixtures && npm run test:telegram-monitor-reconciliation && npm run test:twitter-fetcher && npm run test:twitter-provider-router && npm run test:twitter-provider-clients && npm run test:twitter-provider-state && npm run test:twitter-identity-service && npm run test:twitter-stable-identity && npm run test:twitter-sync-service && npm run test:twitter-relay-coverage && npm run test:twitter-bridge"
  }
}
```

- [ ] **Step 4: Run the new tests and verify they fail**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-feed-selected-user-holdings
npm run test:user-details-api
npm run test:selected-user-details-hook-contract
```

Expected: FAIL because the client fetch wrapper and hook do not exist yet

- [ ] **Step 5: Implement the fetch wrapper**

```ts
// /Users/xp/vibecoding/pilipili/lib/userDetailsApi.ts
import type {
  UserDetailsErrorPayload,
  UserDetailsSuccessPayload,
} from '@/lib/userDetails';

export async function fetchUserDetails(userId: string): Promise<UserDetailsSuccessPayload> {
  const response = await fetch(`/api/users/${encodeURIComponent(userId)}`, {
    cache: 'no-store',
  });
  const payload = (await response.json().catch(() => null)) as
    | UserDetailsSuccessPayload
    | UserDetailsErrorPayload
    | null;

  if (!response.ok || !payload || payload.ok !== true) {
    throw new Error(
      payload && 'error' in payload && typeof payload.error === 'string'
        ? payload.error
        : `HTTP ${response.status}`
    );
  }

  return payload;
}
```

- [ ] **Step 6: Implement the cache-aware selected-user details hook**

```ts
// /Users/xp/vibecoding/pilipili/hooks/useSelectedUserDetails.ts
'use client';

import { useEffect, useRef, useState } from 'react';

import { fetchUserDetails } from '@/lib/userDetailsApi';
import type { UserDetailsSuccessPayload } from '@/lib/userDetails';

export interface SelectedUserDetailsState {
  details: UserDetailsSuccessPayload | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  retry: () => Promise<void>;
}

export function useSelectedUserDetails(selectedUserId: string | null): SelectedUserDetailsState {
  const cacheRef = useRef(new Map<string, UserDetailsSuccessPayload>());
  const requestIdRef = useRef(0);
  const [details, setDetails] = useState<UserDetailsSuccessPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadUserDetails(userId: string, preferCache: boolean) {
    const requestId = ++requestIdRef.current;
    const cached = cacheRef.current.get(userId);

    if (preferCache && cached) {
      setDetails(cached);
      setError(null);
      setLoading(false);
      setRefreshing(Boolean(cached));
    } else {
      setLoading(true);
      setRefreshing(false);
      setError(null);
    }

    try {
      const payload = await fetchUserDetails(userId);
      if (requestId !== requestIdRef.current) {
        return;
      }

      cacheRef.current.set(userId, payload);
      setDetails(payload);
      setError(null);
    } catch (nextError) {
      if (requestId !== requestIdRef.current) {
        return;
      }

      if (!cached) {
        setDetails(null);
      }
      setError(nextError instanceof Error ? nextError.message : '读取持仓失败');
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }

  useEffect(() => {
    if (!selectedUserId) {
      setDetails(null);
      setLoading(false);
      setRefreshing(false);
      setError(null);
      return;
    }

    void loadUserDetails(selectedUserId, true);
  }, [selectedUserId]);

  return {
    details,
    loading,
    refreshing,
    error,
    retry: async () => {
      if (!selectedUserId) {
        return;
      }
      await loadUserDetails(selectedUserId, false);
    },
  };
}
```

- [ ] **Step 7: Run the focused client verification**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-feed-selected-user-holdings
npm run test:user-details-api
npm run test:selected-user-details-hook-contract
```

Expected: PASS with `user details api tests: ok` and `selected user details hook contract tests: ok`

- [ ] **Step 8: Commit the client fetch and hook slice**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-feed-selected-user-holdings
git add lib/userDetailsApi.ts hooks/useSelectedUserDetails.ts scripts/test-user-details-api.ts scripts/test-selected-user-details-hook-contract.ts package.json
git commit -m "feat: add selected user details client hook"
```

Expected: commit created with the fetch wrapper and cache-aware hook

---

### Task 5: Extract The Selected-User Panel And Wire It Into Feed

**Files:**
- Create: `/Users/xp/vibecoding/pilipili/components/SelectedUserDetailsPanel.tsx`
- Create: `/Users/xp/vibecoding/pilipili/scripts/test-selected-user-details-panel.tsx`
- Create: `/Users/xp/vibecoding/pilipili/scripts/test-feed-selected-user-details-contract.ts`
- Modify: `/Users/xp/vibecoding/pilipili/app/page.tsx`
- Modify: `/Users/xp/vibecoding/pilipili/package.json`
- Test: `/Users/xp/vibecoding/pilipili/scripts/test-selected-user-details-panel.tsx`
- Test: `/Users/xp/vibecoding/pilipili/scripts/test-feed-selected-user-details-contract.ts`

- [ ] **Step 1: Write the failing panel render test**

```tsx
// /Users/xp/vibecoding/pilipili/scripts/test-selected-user-details-panel.tsx
import assert from 'node:assert/strict';

import { renderToStaticMarkup } from 'react-dom/server';

import { SelectedUserDetailsPanel } from '@/components/SelectedUserDetailsPanel';
import type { User } from '@/types';

function makeUser(): User {
  return {
    id: 'user-1',
    name: 'testuser',
    handle: 'testuser',
    avatar: '',
    addresses: [],
    totalAssetUsd: 123_000,
    historicalMaxAssetUsd: 456_000,
    assetUpdatedAt: null,
    tags: ['聪明钱'],
  };
}

function run() {
  const user = makeUser();

  const loadingMarkup = renderToStaticMarkup(
    <SelectedUserDetailsPanel
      user={user}
      matchedFeedCount={12}
      hasMore={true}
      activityBreakdown={{ twitterCount: 3, tradeCount: 4 }}
      completenessWindow={{ scope: 'user', startMs: 1, endMs: 2, label: '近 7 天', complete: true }}
      hasAnyActiveFilter={false}
      onBack={() => {}}
      details={null}
      detailsLoading={true}
      detailsRefreshing={false}
      detailsError={null}
      onRetry={() => {}}
    />
  );
  assert.match(loadingMarkup, /持仓明细/);
  assert.match(loadingMarkup, /正在读取持仓/);

  const errorMarkup = renderToStaticMarkup(
    <SelectedUserDetailsPanel
      user={user}
      matchedFeedCount={12}
      hasMore={false}
      activityBreakdown={{ twitterCount: 3, tradeCount: 4 }}
      completenessWindow={null}
      hasAnyActiveFilter={true}
      onBack={() => {}}
      details={null}
      detailsLoading={false}
      detailsRefreshing={false}
      detailsError="读取持仓失败"
      onRetry={() => {}}
    />
  );
  assert.match(errorMarkup, /读取持仓失败/);
  assert.match(errorMarkup, /重试/);

  const emptyMarkup = renderToStaticMarkup(
    <SelectedUserDetailsPanel
      user={user}
      matchedFeedCount={12}
      hasMore={false}
      activityBreakdown={{ twitterCount: 3, tradeCount: 4 }}
      completenessWindow={null}
      hasAnyActiveFilter={true}
      onBack={() => {}}
      details={{
        ok: true,
        user,
        holdings: [],
        holdingsUpdatedAt: 999,
        holdingsThresholdUsd: 5,
        holdingsSummary: {
          visibleCount: 0,
          partial: false,
          successfulAddressCount: 1,
          failedAddressCount: 0,
        },
      }}
      detailsLoading={false}
      detailsRefreshing={false}
      detailsError={null}
      onRetry={() => {}}
    />
  );
  assert.match(emptyMarkup, /暂无 &gt;= 5 USD 的持仓/);

  const successMarkup = renderToStaticMarkup(
    <SelectedUserDetailsPanel
      user={user}
      matchedFeedCount={12}
      hasMore={true}
      activityBreakdown={{ twitterCount: 3, tradeCount: 4 }}
      completenessWindow={{ scope: 'user', startMs: 1, endMs: 2, label: '近 7 天', complete: true }}
      hasAnyActiveFilter={false}
      onBack={() => {}}
      details={{
        ok: true,
        user,
        holdings: [
          {
            chain: 'bsc',
            tokenAddress: '0xusdt',
            symbol: 'USDT',
            name: 'Tether USD',
            balance: 8,
            priceUsd: 1,
            valueUsd: 8,
          },
        ],
        holdingsUpdatedAt: 999,
        holdingsThresholdUsd: 5,
        holdingsSummary: {
          visibleCount: 1,
          partial: true,
          successfulAddressCount: 2,
          failedAddressCount: 1,
        },
      }}
      detailsLoading={false}
      detailsRefreshing={true}
      detailsError={null}
      onRetry={() => {}}
    />
  );
  assert.match(successMarkup, /已隐藏/);
  assert.match(successMarkup, /部分地址读取失败，结果可能不完整/);
  assert.match(successMarkup, /USDT/);
  assert.match(successMarkup, /BSC/);

  console.log('selected user details panel tests: ok');
}

run();
```

- [ ] **Step 2: Write the failing page wiring contract test**

```ts
// /Users/xp/vibecoding/pilipili/scripts/test-feed-selected-user-details-contract.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readProjectFile(relativePath: string) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function run() {
  const pageSource = readProjectFile('app/page.tsx');

  assert.match(
    pageSource,
    /import \{ SelectedUserDetailsPanel \} from '@\/components\/SelectedUserDetailsPanel'/,
    'feed page should import the extracted selected-user panel'
  );
  assert.match(
    pageSource,
    /useSelectedUserDetails\(selectedUserId\)/,
    'feed page should request selected-user details from the dedicated hook'
  );
  assert.match(
    pageSource,
    /<SelectedUserDetailsPanel[\s\S]*details=\{selectedUserDetails\}/,
    'feed page should pass fetched details into the extracted panel'
  );
  assert.match(
    pageSource,
    /detailsLoading=\{selectedUserDetailsLoading\}/,
    'feed page should wire the panel loading state from the selected-user details hook'
  );

  console.log('feed selected user details contract tests: ok');
}

run();
```

- [ ] **Step 3: Register the new panel and page wiring tests**

```json
// /Users/xp/vibecoding/pilipili/package.json
{
  "scripts": {
    "test:selected-user-details-panel": "tsx scripts/test-selected-user-details-panel.tsx",
    "test:feed-selected-user-details-contract": "tsx scripts/test-feed-selected-user-details-contract.ts",
    "test": "npm run test:admin-auth && npm run test:feed-ordering && npm run test:time-format && npm run test:activity-card-social && npm run test:activity-card-view-model && npm run test:activity-card-render && npm run test:activity-importance && npm run test:activity-importance-service && npm run test:activity-importance-ingest && npm run test:activity-importance-backfill && npm run test:trade-usd && npm run test:events-feed-total && npm run test:feed-request-arbiter && npm run test:feed-query-mode && npm run test:feed-client-state && npm run test:feed-completeness-visibility && npm run test:feed-prewarm-service && npm run test:activities-api && npm run test:activity-feed-retry && npm run test:global-search-wiring && npm run test:feed-page-state && npm run test:user-bar && npm run test:tooling-config && npm run test:node-runtime-policy && npm run test:search-filters && npm run test:source-reconciliation && npm run test:sync-failure-notifier && npm run test:manage-users && npm run test:tracked-user-validation && npm run test:tracked-address-ownership && npm run test:asset-peak-validation && npm run test:asset-peak-audit && npm run test:tracked-user-assets && npm run test:tracked-user-evm-expansion && npm run test:address-book && npm run test:address-management && npm run test:addresses-api && npm run test:address-assets && npm run test:user-holdings-details && npm run test:user-details-route && npm run test:user-details-api && npm run test:selected-user-details-hook-contract && npm run test:selected-user-details-panel && npm run test:feed-selected-user-details-contract && npm run test:conflict-repo && npm run test:system-config-conflict-chat && npm run test:conflict-notifier && npm run test:parser-fixtures && npm run test:telegram-monitor-reconciliation && npm run test:twitter-fetcher && npm run test:twitter-provider-router && npm run test:twitter-provider-clients && npm run test:twitter-provider-state && npm run test:twitter-identity-service && npm run test:twitter-stable-identity && npm run test:twitter-sync-service && npm run test:twitter-relay-coverage && npm run test:twitter-bridge"
  }
}
```

- [ ] **Step 4: Run the new panel and page tests and verify they fail**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-feed-selected-user-holdings
npm run test:selected-user-details-panel
npm run test:feed-selected-user-details-contract
```

Expected: FAIL because the panel file does not exist and `app/page.tsx` does not use it yet

- [ ] **Step 5: Create the extracted selected-user panel component**

```tsx
// /Users/xp/vibecoding/pilipili/components/SelectedUserDetailsPanel.tsx
'use client';

import { ArrowLeft } from 'lucide-react';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { formatTokenAmount, formatUsd, formatUsdCompact } from '@/lib/assetFormat';
import { formatAbsoluteTimeCompact } from '@/lib/timeFormat';
import { getUserAvatar } from '@/lib/userProfile';
import type { ActivityBreakdown, CompletenessWindow } from '@/lib/activitiesApi';
import type { UserDetailsSuccessPayload } from '@/lib/userDetails';
import type { User } from '@/types';

interface SelectedUserDetailsPanelProps {
  user: User;
  matchedFeedCount: number;
  hasMore: boolean;
  activityBreakdown: ActivityBreakdown | null;
  completenessWindow: CompletenessWindow | null;
  hasAnyActiveFilter: boolean;
  onBack: () => void;
  details: UserDetailsSuccessPayload | null;
  detailsLoading: boolean;
  detailsRefreshing: boolean;
  detailsError: string | null;
  onRetry: () => void;
}

function getChainLabel(chain: string) {
  if (chain === 'bsc') return 'BSC';
  if (chain === 'solana') return 'SOL';
  if (chain === 'ethereum') return 'ETH';
  if (chain === 'base') return 'BASE';
  return chain.toUpperCase();
}

export function SelectedUserDetailsPanel(props: SelectedUserDetailsPanelProps) {
  const {
    user,
    matchedFeedCount,
    hasMore,
    activityBreakdown,
    completenessWindow,
    hasAnyActiveFilter,
    onBack,
    details,
    detailsLoading,
    detailsRefreshing,
    detailsError,
    onRetry,
  } = props;

  return (
    <div className="mb-6 rounded-xl border border-zinc-800/50 bg-zinc-900/50 p-4">
      <div className="flex items-center gap-4">
        <button onClick={onBack} className="flex items-center gap-2 text-zinc-400 transition-colors hover:text-zinc-200">
          <ArrowLeft className="h-4 w-4" />
          <span className="text-sm">返回</span>
        </button>

        <div className="h-6 w-px bg-zinc-800" />

        <Avatar className="h-10 w-10">
          <AvatarImage src={getUserAvatar(user)} alt={user.name} />
          <AvatarFallback className="bg-zinc-800 text-zinc-400">
            {user.name.slice(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>

        <div>
          <h2 className="font-medium text-zinc-100">{user.name}</h2>
          <p className="text-sm text-zinc-500">@{user.handle}</p>
        </div>

        <div className="rounded-lg border border-zinc-800/70 bg-zinc-950/50 px-3 py-1.5 text-xs text-zinc-300">
          <div className="text-zinc-500">总资产</div>
          <div className="text-sm font-medium text-zinc-100">{formatUsdCompact(user.totalAssetUsd)}</div>
        </div>

        <div className="rounded-lg border border-zinc-800/70 bg-zinc-950/50 px-3 py-1.5 text-xs text-zinc-300">
          <div className="text-zinc-500">历史最高</div>
          <div className="text-sm font-medium text-zinc-100">{formatUsdCompact(user.historicalMaxAssetUsd)}</div>
        </div>

        <div className="rounded-lg border border-zinc-800/70 bg-zinc-950/50 px-3 py-1.5 text-xs text-zinc-300">
          <div className="text-zinc-500">已加载结果</div>
          <div className="text-sm font-medium text-zinc-100">
            {matchedFeedCount}
            <span className="ml-2 text-xs text-zinc-500">{hasMore ? '可继续加载' : '已显示全部'}</span>
          </div>
        </div>

        <div className="rounded-lg border border-zinc-800/70 bg-zinc-950/50 px-3 py-1.5 text-xs text-zinc-300">
          <div className="text-zinc-500">动态拆分</div>
          <div className="text-sm font-medium text-zinc-100">
            推特 {activityBreakdown?.twitterCount ?? 0} 条 / 交易 {activityBreakdown?.tradeCount ?? 0} 笔
          </div>
        </div>

        {!hasAnyActiveFilter ? (
          <div className="rounded-lg border border-zinc-800/70 bg-zinc-950/50 px-3 py-1.5 text-xs text-zinc-300">
            <div className="text-zinc-500">个人完备起点</div>
            <div className="text-sm font-medium text-zinc-100">{completenessWindow?.label || '尚未建立'}</div>
            <div className={`mt-1 text-[11px] ${completenessWindow?.complete ? 'text-emerald-400' : 'text-zinc-500'}`}>
              {completenessWindow?.complete ? '窗口已建立' : '等待建立窗口'}
            </div>
          </div>
        ) : null}

        <div className="ml-auto flex items-center gap-2">
          {user.tags.map((tag) => (
            <span key={tag} className="rounded bg-zinc-800/50 px-2 py-0.5 text-xs text-zinc-400">
              {tag}
            </span>
          ))}
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-zinc-800/70 bg-zinc-950/60">
        <div className="flex items-center justify-between border-b border-zinc-800/70 px-4 py-3">
          <div>
            <div className="text-sm font-medium text-zinc-100">持仓明细</div>
            <div className="text-xs text-zinc-500">
              已隐藏 &lt; {details?.holdingsThresholdUsd ?? 5} USD 持仓
              {details?.holdingsUpdatedAt ? ` · 更新于 ${formatAbsoluteTimeCompact(details.holdingsUpdatedAt)}` : ''}
              {detailsRefreshing ? ' · 后台刷新中' : ''}
            </div>
          </div>
          {detailsError ? (
            <Button onClick={onRetry} className="h-8 bg-zinc-800 px-3 text-xs text-zinc-100 hover:bg-zinc-700">
              重试
            </Button>
          ) : null}
        </div>

        {detailsLoading && !details ? (
          <div className="px-4 py-6 text-sm text-zinc-400">正在读取持仓...</div>
        ) : detailsError && !details ? (
          <div className="px-4 py-6 text-sm text-red-300">{detailsError}</div>
        ) : details && details.holdings.length === 0 ? (
          <div className="px-4 py-6 text-sm text-zinc-400">
            暂无 &gt;= {details.holdingsThresholdUsd} USD 的持仓
          </div>
        ) : details ? (
          <div className="overflow-x-auto">
            {details.holdingsSummary.partial ? (
              <div className="border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 text-xs text-amber-300">
                部分地址读取失败，结果可能不完整
              </div>
            ) : null}
            <table className="w-full min-w-[720px] table-auto text-sm">
              <thead className="bg-zinc-900/80 text-zinc-400">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">链</th>
                  <th className="px-4 py-2 text-left font-medium">Token</th>
                  <th className="px-4 py-2 text-right font-medium">数量</th>
                  <th className="px-4 py-2 text-right font-medium">单价</th>
                  <th className="px-4 py-2 text-right font-medium">价值</th>
                </tr>
              </thead>
              <tbody>
                {details.holdings.map((holding) => (
                  <tr key={`${holding.chain}:${holding.tokenAddress}`} className="border-t border-zinc-800/70 text-zinc-200">
                    <td className="px-4 py-3 font-mono text-xs text-zinc-400">{getChainLabel(holding.chain)}</td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-zinc-100">{holding.symbol}</div>
                      <div className="text-xs text-zinc-500">{holding.name || holding.tokenAddress}</div>
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-zinc-300">{formatTokenAmount(holding.balance)}</td>
                    <td className="px-4 py-3 text-right font-mono text-zinc-300">{formatUsd(holding.priceUsd)}</td>
                    <td className="px-4 py-3 text-right font-mono text-zinc-100">{formatUsdCompact(holding.valueUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Replace the inline selected-user block in `app/page.tsx` with the new panel**

Add the imports near the top:

```ts
import { SelectedUserDetailsPanel } from '@/components/SelectedUserDetailsPanel';
import { useSelectedUserDetails } from '@/hooks/useSelectedUserDetails';
```

Create the hook state after `selectedUser`:

```ts
const {
  details: selectedUserDetails,
  loading: selectedUserDetailsLoading,
  refreshing: selectedUserDetailsRefreshing,
  error: selectedUserDetailsError,
  retry: retrySelectedUserDetails,
} = useSelectedUserDetails(selectedUserId);
```

Replace the current inline `selectedUser && (` block with:

```tsx
{selectedUser && (
  <SelectedUserDetailsPanel
    user={selectedUser}
    matchedFeedCount={matchedFeed.length}
    hasMore={hasMore}
    activityBreakdown={activityBreakdown}
    completenessWindow={completenessWindow}
    hasAnyActiveFilter={hasAnyActiveFilter}
    onBack={handleBackToAll}
    details={selectedUserDetails}
    detailsLoading={selectedUserDetailsLoading}
    detailsRefreshing={selectedUserDetailsRefreshing}
    detailsError={selectedUserDetailsError}
    onRetry={() => {
      void retrySelectedUserDetails();
    }}
  />
)}
```

And remove the now-obsolete inline selected-user summary markup that starts with:

```tsx
{selectedUser && (
  <div className="mb-6 flex items-center gap-4 rounded-xl border border-zinc-800/50 bg-zinc-900/50 p-4">
```

- [ ] **Step 7: Run the focused Feed UI verification**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-feed-selected-user-holdings
npm run test:selected-user-details-panel
npm run test:feed-selected-user-details-contract
npm run test:selected-user-details-hook-contract
npm run test:user-details-api
```

Expected: PASS with all four focused UI/client tests green

- [ ] **Step 8: Commit the extracted panel slice**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-feed-selected-user-holdings
git add components/SelectedUserDetailsPanel.tsx app/page.tsx scripts/test-selected-user-details-panel.tsx scripts/test-feed-selected-user-details-contract.ts package.json
git commit -m "feat: show selected user holdings in feed"
```

Expected: commit created with the Feed UI integration

---

### Task 6: Run Final Verification And Leave A Clean Handoff

**Files:**
- Modify: `/Users/xp/vibecoding/pilipili/package.json`
- Test: `scripts/test-user-holdings-details.ts`
- Test: `scripts/test-user-details-route.ts`
- Test: `scripts/test-user-details-api.ts`
- Test: `scripts/test-selected-user-details-hook-contract.ts`
- Test: `scripts/test-selected-user-details-panel.tsx`
- Test: `scripts/test-feed-selected-user-details-contract.ts`
- Test: `scripts/test:user-bar`

- [ ] **Step 1: Run the full feature-specific verification suite**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-feed-selected-user-holdings
npm run test:user-holdings-details
npm run test:user-details-route
npm run test:user-details-api
npm run test:selected-user-details-hook-contract
npm run test:selected-user-details-panel
npm run test:feed-selected-user-details-contract
npm run test:user-bar
```

Expected: every targeted command passes

- [ ] **Step 2: Run a production build for type and route safety**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-feed-selected-user-holdings
npm run build
```

Expected: Next.js build completes without route-handler, App Router, or type errors

- [ ] **Step 3: Inspect the final diff**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-feed-selected-user-holdings
git status --short
git diff --stat
```

Expected: only the planned files are modified and the diff matches the selected-user holdings feature scope

- [ ] **Step 4: Create the final handoff commit if anything remains unstaged**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-feed-selected-user-holdings
git add lib/userDetails.ts lib/server/userHoldingsDetails.ts app/api/users/[id]/route.ts lib/userDetailsApi.ts hooks/useSelectedUserDetails.ts components/SelectedUserDetailsPanel.tsx app/page.tsx scripts/test-user-holdings-details.ts scripts/test-user-details-route.ts scripts/test-user-details-api.ts scripts/test-selected-user-details-hook-contract.ts scripts/test-selected-user-details-panel.tsx scripts/test-feed-selected-user-details-contract.ts package.json
git commit -m "chore: finalize selected user holdings delivery"
```

Expected: either a final clean commit is created or Git reports there is nothing left to commit because the earlier task commits already covered the whole change

---

## Self-Review

### Spec coverage

- Extend `GET /api/users/[id]`:
  - Covered in Task 3.
- Aggregate holdings by `链 + token`:
  - Covered in Task 2.
- Filter out `< 5 USD` rows:
  - Covered in Task 2 and rendered in Task 5.
- Sort by `valueUsd desc`:
  - Covered in Task 2 tests and implementation.
- Show the holdings table under the selected-user summary in Feed:
  - Covered in Task 5.
- Handle loading / empty / error / partial:
  - Covered in Task 5 render tests and component implementation.
- Keep Feed polling separate from user details:
  - Covered in Task 4 and Task 5 through separate API wrapper + hook.

No spec requirement is left without a corresponding task.

### Placeholder scan

- No `TODO`, `TBD`, or “implement later” markers remain.
- Every task lists concrete files, test commands, and code snippets.
- No step says “write tests” or “handle errors” without showing what that means.

### Type consistency

- Shared payload types live in `lib/userDetails.ts` and are reused by:
  - `lib/server/userHoldingsDetails.ts`
  - `app/api/users/[id]/route.ts`
  - `lib/userDetailsApi.ts`
  - `hooks/useSelectedUserDetails.ts`
  - `components/SelectedUserDetailsPanel.tsx`
- The plan consistently uses:
  - `UserHoldingRow`
  - `UserDetailsSuccessPayload`
  - `USER_HOLDINGS_THRESHOLD_USD`
  - `readUserHoldingsDetails()`
  - `createGetUserDetailsHandler()`
  - `useSelectedUserDetails()`

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-05-feed-selected-user-holdings.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
