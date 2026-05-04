# Person/Address Management Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split person management and address management into separate pages while keeping the existing `tracked_users + tracked_addresses` storage and reusing the current address-deletion semantics.

**Architecture:** Add one server-side address-management view model that folds per-user tracked addresses into one flat table, including EVM multi-chain aggregation and latest blockchain activity time. Expose that view through a new `GET /api/addresses` route, build a dedicated `/addresses` page on top of it, then simplify `/manage` so it no longer renders inline address expansion.

**Tech Stack:** Next.js 16 App Router, React 19 client components, TypeScript, Zustand (existing manage page only), `better-sqlite3`, `tsx` script tests, Tailwind utility classes, local Next.js docs in `node_modules/next/dist/docs/`.

---

## File Structure

### New files

- Create: `/Users/xp/vibecoding/pilipili/lib/addressManagement.ts`
  - Pure address-management view model types and row builder.
- Create: `/Users/xp/vibecoding/pilipili/lib/server/addressManagementRepo.ts`
  - Server-only read model that loads tracked users and latest blockchain activity timestamps from SQLite.
- Create: `/Users/xp/vibecoding/pilipili/app/api/addresses/route.ts`
  - New App Router route handler returning flat address rows.
- Create: `/Users/xp/vibecoding/pilipili/app/addresses/page.tsx`
  - Dedicated address management page.
- Create: `/Users/xp/vibecoding/pilipili/scripts/test-address-management.ts`
  - Pure unit-style test for the new row builder.
- Create: `/Users/xp/vibecoding/pilipili/scripts/test-addresses-api.ts`
  - Route integration test with temporary SQLite data.

### Existing files to modify

- Modify: `/Users/xp/vibecoding/pilipili/package.json`
  - Register new script tests and wire them into the aggregate `test` script.
- Modify: `/Users/xp/vibecoding/pilipili/components/TopNav.tsx`
  - Add the new `地址` nav entry and active state.
- Modify: `/Users/xp/vibecoding/pilipili/app/manage/page.tsx`
  - Remove inline address expansion and replace it with an address-count-only cell plus a link to the new page.
- Modify: `/Users/xp/vibecoding/pilipili/scripts/test-manage-users.ts`
  - Lock the new page split contract into source-based tests.

### Existing docs to read before editing page and route files

- `/Users/xp/vibecoding/pilipili/node_modules/next/dist/docs/01-app/01-getting-started/03-layouts-and-pages.md`
- `/Users/xp/vibecoding/pilipili/node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`

---

### Task 1: Add the Pure Address Management View Model

**Files:**
- Create: `/Users/xp/vibecoding/pilipili/lib/addressManagement.ts`
- Create: `/Users/xp/vibecoding/pilipili/scripts/test-address-management.ts`
- Modify: `/Users/xp/vibecoding/pilipili/package.json`
- Test: `/Users/xp/vibecoding/pilipili/scripts/test-address-management.ts`

- [ ] **Step 1: Write the failing pure row-builder test**

```ts
// /Users/xp/vibecoding/pilipili/scripts/test-address-management.ts
import assert from 'node:assert/strict';

import { buildGmgnAddressUrl } from '@/lib/addressBook';
import { buildAddressManagementRows } from '@/lib/addressManagement';
import type { User } from '@/types';

function makeUser(overrides: Partial<User>): User {
  return {
    id: overrides.id || 'user-1',
    name: overrides.name || 'testuser',
    handle: overrides.handle || 'testuser',
    avatar: overrides.avatar || '',
    twitter: overrides.twitter,
    telegram: overrides.telegram,
    addresses: overrides.addresses || [],
    totalAssetUsd: overrides.totalAssetUsd || 0,
    historicalMaxAssetUsd: overrides.historicalMaxAssetUsd || 0,
    assetUpdatedAt: overrides.assetUpdatedAt ?? null,
    tags: overrides.tags || [],
  };
}

function run() {
  const rows = buildAddressManagementRows(
    [
      makeUser({
        id: 'person-1',
        name: 'testuser',
        addresses: [
          {
            address: '0xAbCdEf0123456789AbCdEf0123456789AbCdEf02',
            name: '#7',
            chain: 'bsc',
            totalAssetUsd: 10,
            assetUpdatedAt: 100,
          },
          {
            address: '0xAbCdEf0123456789AbCdEf0123456789AbCdEf02',
            name: '#7',
            chain: 'ethereum',
            totalAssetUsd: 20,
            assetUpdatedAt: 200,
          },
          {
            address: '0xAbCdEf0123456789AbCdEf0123456789AbCdEf02',
            name: '#7',
            chain: 'base',
            totalAssetUsd: 30,
            assetUpdatedAt: 300,
          },
        ],
      }),
      makeUser({
        id: 'person-2',
        name: '蓝月',
        addresses: [
          {
            address: 'Aqa8H5hmHe9MFY9sW6widbqEuaYv7q2KnRo25ApPhWhA',
            name: '#2',
            chain: 'solana',
            totalAssetUsd: 40,
            assetUpdatedAt: 400,
          },
        ],
      }),
    ],
    new Map([
      ['bsc:0xabcdef0123456789abcdef0123456789abcdef02', 1_700],
      ['ethereum:0xabcdef0123456789abcdef0123456789abcdef02', 2_900],
      ['base:0xabcdef0123456789abcdef0123456789abcdef02', 2_100],
      ['solana:aqa8h5hmhe9mfy9sw6widbqe uayv7q2knro25apphwh a'.replace(/\s+/g, ''), 4_500],
    ])
  );

  assert.equal(rows.length, 2, 'same EVM wallet should collapse into one management row');

  const evmRow = rows.find((row) => row.displayName === 'testuser#7');
  assert.ok(evmRow, 'expected aggregated EVM row');
  assert.deepEqual(evmRow?.chains, ['bsc', 'ethereum', 'base']);
  assert.equal(evmRow?.primaryChain, 'bsc');
  assert.equal(evmRow?.networkLabel, 'EVM地址');
  assert.equal(evmRow?.totalAssetUsd, 60);
  assert.equal(evmRow?.assetUpdatedAt, 300);
  assert.equal(evmRow?.latestActivityAt, 2_900);
  assert.equal(
    evmRow?.gmgnUrl,
    buildGmgnAddressUrl('bsc', '0xAbCdEf0123456789AbCdEf0123456789AbCdEf02')
  );

  const solRow = rows.find((row) => row.displayName === '蓝月#2');
  assert.ok(solRow, 'expected solana row');
  assert.deepEqual(solRow?.chains, ['solana']);
  assert.equal(solRow?.primaryChain, 'solana');
  assert.equal(solRow?.latestActivityAt, 4_500);

  console.log('address management tests: ok');
}

run();
```

- [ ] **Step 2: Register the new test command**

```json
// /Users/xp/vibecoding/pilipili/package.json
{
  "scripts": {
    "test:address-management": "tsx scripts/test-address-management.ts",
    "test": "npm run test:admin-auth && npm run test:feed-ordering && npm run test:time-format && npm run test:activity-card-view-model && npm run test:activity-importance && npm run test:activity-importance-service && npm run test:activity-importance-ingest && npm run test:activity-importance-backfill && npm run test:trade-usd && npm run test:events-feed-total && npm run test:feed-request-arbiter && npm run test:feed-query-mode && npm run test:feed-client-state && npm run test:feed-completeness-visibility && npm run test:feed-prewarm-service && npm run test:activities-api && npm run test:activity-feed-retry && npm run test:global-search-wiring && npm run test:feed-page-state && npm run test:user-bar && npm run test:tooling-config && npm run test:node-runtime-policy && npm run test:search-filters && npm run test:source-reconciliation && npm run test:sync-failure-notifier && npm run test:manage-users && npm run test:tracked-user-validation && npm run test:tracked-address-ownership && npm run test:asset-peak-validation && npm run test:asset-peak-audit && npm run test:tracked-user-assets && npm run test:tracked-user-evm-expansion && npm run test:address-book && npm run test:address-management && npm run test:address-assets && npm run test:conflict-repo && npm run test:system-config-conflict-chat && npm run test:conflict-notifier && npm run test:parser-fixtures && npm run test:telegram-monitor-reconciliation && npm run test:twitter-fetcher && npm run test:twitter-provider-router && npm run test:twitter-provider-clients && npm run test:twitter-provider-state && npm run test:twitter-identity-service && npm run test:twitter-stable-identity && npm run test:twitter-sync-service && npm run test:twitter-relay-coverage && npm run test:twitter-bridge"
  }
}
```

- [ ] **Step 3: Run the new test and verify it fails**

Run:

```bash
npm run test:address-management
```

Expected: FAIL with a module or export error because `/Users/xp/vibecoding/pilipili/lib/addressManagement.ts` and `buildAddressManagementRows()` do not exist yet.

- [ ] **Step 4: Implement the pure address-management row builder**

```ts
// /Users/xp/vibecoding/pilipili/lib/addressManagement.ts
import { buildGmgnAddressUrl, groupAddressesForDisplay, isEvmChain } from '@/lib/addressBook';
import type { ChainType, User } from '@/types';

export interface AddressManagementRow {
  userId: string;
  userName: string;
  addressName: string;
  displayName: string;
  address: string;
  primaryChain: ChainType;
  chains: ChainType[];
  networkLabel: 'EVM地址' | 'SOL地址';
  totalAssetUsd: number | null;
  assetUpdatedAt: number | null;
  latestActivityAt: number | null;
  gmgnUrl: string | null;
}

function normalize(value: string) {
  return value.trim().toLowerCase();
}

export function buildAddressManagementRows(
  users: readonly User[],
  latestActivityByChainAddress: ReadonlyMap<string, number>
) {
  const rows: AddressManagementRow[] = [];

  for (const user of users) {
    for (const address of groupAddressesForDisplay(user.addresses)) {
      const chains = address.networkLabel === 'EVM地址'
        ? (['bsc', 'ethereum', 'base'] as const).filter((chain) => address.chains.includes(chain))
        : [address.chain];
      const primaryChain = address.networkLabel === 'EVM地址' ? 'bsc' : address.chain;
      const normalizedAddress = normalize(address.address);

      let latestActivityAt: number | null = null;
      for (const chain of chains) {
        const candidate = latestActivityByChainAddress.get(`${chain}:${normalizedAddress}`) ?? null;
        if (typeof candidate === 'number' && Number.isFinite(candidate)) {
          latestActivityAt = latestActivityAt === null ? candidate : Math.max(latestActivityAt, candidate);
        }
      }

      rows.push({
        userId: user.id,
        userName: user.name,
        addressName: address.name,
        displayName: `${user.name}${address.name}`,
        address: address.address,
        primaryChain,
        chains,
        networkLabel: address.networkLabel,
        totalAssetUsd: typeof address.totalAssetUsd === 'number' ? address.totalAssetUsd : null,
        assetUpdatedAt: typeof address.assetUpdatedAt === 'number' ? address.assetUpdatedAt : null,
        latestActivityAt,
        gmgnUrl: buildGmgnAddressUrl(primaryChain, address.address),
      });
    }
  }

  return rows.sort((left, right) => {
    const nameOrder = left.displayName.localeCompare(right.displayName, 'zh-CN');
    if (nameOrder !== 0) return nameOrder;
    const leftIsEvm = left.chains.some(isEvmChain);
    const rightIsEvm = right.chains.some(isEvmChain);
    if (leftIsEvm !== rightIsEvm) return leftIsEvm ? -1 : 1;
    return left.address.localeCompare(right.address);
  });
}
```

- [ ] **Step 5: Run the test again and verify it passes**

Run:

```bash
npm run test:address-management
```

Expected: PASS with `address management tests: ok`.

- [ ] **Step 6: Commit the pure view-model work**

```bash
git add package.json lib/addressManagement.ts scripts/test-address-management.ts
git commit -m "feat: add address management row builder"
```

### Task 2: Add the Server Read Model and `/api/addresses`

**Files:**
- Read: `/Users/xp/vibecoding/pilipili/node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`
- Create: `/Users/xp/vibecoding/pilipili/lib/server/addressManagementRepo.ts`
- Create: `/Users/xp/vibecoding/pilipili/app/api/addresses/route.ts`
- Create: `/Users/xp/vibecoding/pilipili/scripts/test-addresses-api.ts`
- Modify: `/Users/xp/vibecoding/pilipili/package.json`
- Test: `/Users/xp/vibecoding/pilipili/scripts/test-addresses-api.ts`

- [ ] **Step 1: Read the local Next.js route handler guide before adding the API route**

Run:

```bash
sed -n '1,220p' node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md
```

Expected: Review the App Router route handler conventions for `runtime`, `dynamic`, and `NextResponse`.

- [ ] **Step 2: Write the failing route integration test**

```ts
// /Users/xp/vibecoding/pilipili/scripts/test-addresses-api.ts
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';

function createTempDbDir() {
  return mkdtempSync(path.join(tmpdir(), 'pilipili-addresses-api-'));
}

function insertBlockchainEvent(params: {
  db: import('better-sqlite3').Database;
  eventId: string;
  userId: string;
  userName: string;
  chain: string;
  address: string;
  timestamp: number;
}) {
  const now = Date.now();
  const activityJson = JSON.stringify({
    id: params.eventId,
    userId: params.userId,
    source: 'blockchain',
    type: 'transfer',
    content: 'mock blockchain event',
    timestamp: params.timestamp,
    metadata: {
      chain: params.chain,
      trackedAddress: params.address,
      txAction: 'send',
    },
  });

  params.db.prepare(
    `INSERT INTO events (
      event_id,
      source,
      kind,
      timestamp,
      user_id,
      user_name,
      chain,
      address,
      content,
      metadata_json,
      payload_json,
      user_json,
      activity_json,
      created_at,
      updated_at
    ) VALUES (?, 'blockchain', 'event', ?, ?, ?, ?, ?, 'mock blockchain event', '{}', '{}', ?, ?, ?, ?)`
  ).run(
    params.eventId,
    params.timestamp,
    params.userId,
    params.userName,
    params.chain,
    params.address,
    JSON.stringify({ id: params.userId, name: params.userName }),
    activityJson,
    now,
    now
  );
}

async function run() {
  const tempDir = createTempDbDir();
  const previousDbPath = process.env.PILIPILI_DB_PATH;
  const previousDataDir = process.env.PILIPILI_DATA_DIR;

  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');

  try {
    const { createTrackedUser } = await import('@/lib/server/trackedUsersRepo');
    const { getDb } = await import('@/lib/server/sqlite');
    const route = await import('../app/api/addresses/route');

    const alpha = createTrackedUser({
      name: 'Alpha',
      handle: 'alpha',
      avatar: 'alpha.png',
      tags: [],
      addresses: [
        {
          address: 'testuser_solana_placeholder_1111111111111111',
          name: '#1',
          chain: 'solana',
          totalAssetUsd: 88,
          assetUpdatedAt: 111,
        },
      ],
      totalAssetUsd: 88,
      historicalMaxAssetUsd: 88,
      assetUpdatedAt: 111,
      twitter: undefined,
      telegram: undefined,
    });

    const beta = createTrackedUser({
      name: 'Beta',
      handle: 'beta',
      avatar: 'beta.png',
      tags: [],
      addresses: [
        {
          address: '0x9999999999999999999999999999999999999999',
          name: '#1',
          chain: 'bsc',
          totalAssetUsd: 10,
          assetUpdatedAt: 200,
        },
      ],
      totalAssetUsd: 10,
      historicalMaxAssetUsd: 10,
      assetUpdatedAt: 200,
      twitter: undefined,
      telegram: undefined,
    });

    const db = getDb();
    insertBlockchainEvent({
      db,
      eventId: 'alpha-sol',
      userId: alpha.id,
      userName: 'Alpha',
      chain: 'solana',
      address: 'testuser_solana_placeholder_1111111111111111',
      timestamp: 5_000,
    });
    insertBlockchainEvent({
      db,
      eventId: 'beta-bsc',
      userId: beta.id,
      userName: 'Beta',
      chain: 'bsc',
      address: '0x9999999999999999999999999999999999999999',
      timestamp: 7_000,
    });
    insertBlockchainEvent({
      db,
      eventId: 'beta-eth',
      userId: beta.id,
      userName: 'Beta',
      chain: 'ethereum',
      address: '0x9999999999999999999999999999999999999999',
      timestamp: 9_000,
    });

    const response = await route.GET();
    assert.equal(response.status, 200);

    const payload = await response.json() as {
      ok: boolean;
      rows: Array<{
        displayName: string;
        primaryChain: string;
        latestActivityAt: number | null;
        totalAssetUsd: number | null;
      }>;
    };

    assert.equal(payload.ok, true);
    assert.equal(payload.rows.length, 2);

    const alpha = payload.rows.find((row) => row.displayName === 'Alpha#1');
    assert.equal(alpha?.primaryChain, 'solana');
    assert.equal(alpha?.latestActivityAt, 5_000);
    assert.equal(alpha?.totalAssetUsd, 88);

    const beta = payload.rows.find((row) => row.displayName === 'Beta#1');
    assert.equal(beta?.primaryChain, 'bsc');
    assert.equal(beta?.latestActivityAt, 9_000);
  } finally {
    if (previousDbPath === undefined) delete process.env.PILIPILI_DB_PATH;
    else process.env.PILIPILI_DB_PATH = previousDbPath;
    if (previousDataDir === undefined) delete process.env.PILIPILI_DATA_DIR;
    else process.env.PILIPILI_DATA_DIR = previousDataDir;
    rmSync(tempDir, { recursive: true, force: true });
  }

  console.log('addresses api tests: ok');
}

void run();
```

- [ ] **Step 3: Register the route test command**

```json
// /Users/xp/vibecoding/pilipili/package.json
{
  "scripts": {
    "test:addresses-api": "NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-addresses-api.ts",
    "test": "npm run test:admin-auth && npm run test:feed-ordering && npm run test:time-format && npm run test:activity-card-view-model && npm run test:activity-importance && npm run test:activity-importance-service && npm run test:activity-importance-ingest && npm run test:activity-importance-backfill && npm run test:trade-usd && npm run test:events-feed-total && npm run test:feed-request-arbiter && npm run test:feed-query-mode && npm run test:feed-client-state && npm run test:feed-completeness-visibility && npm run test:feed-prewarm-service && npm run test:activities-api && npm run test:activity-feed-retry && npm run test:global-search-wiring && npm run test:feed-page-state && npm run test:user-bar && npm run test:tooling-config && npm run test:node-runtime-policy && npm run test:search-filters && npm run test:source-reconciliation && npm run test:sync-failure-notifier && npm run test:manage-users && npm run test:tracked-user-validation && npm run test:tracked-address-ownership && npm run test:asset-peak-validation && npm run test:asset-peak-audit && npm run test:tracked-user-assets && npm run test:tracked-user-evm-expansion && npm run test:address-book && npm run test:address-management && npm run test:address-assets && npm run test:addresses-api && npm run test:conflict-repo && npm run test:system-config-conflict-chat && npm run test:conflict-notifier && npm run test:parser-fixtures && npm run test:telegram-monitor-reconciliation && npm run test:twitter-fetcher && npm run test:twitter-provider-router && npm run test:twitter-provider-clients && npm run test:twitter-provider-state && npm run test:twitter-identity-service && npm run test:twitter-stable-identity && npm run test:twitter-sync-service && npm run test:twitter-relay-coverage && npm run test:twitter-bridge"
  }
}
```

- [ ] **Step 4: Run the route test and verify it fails**

Run:

```bash
npm run test:addresses-api
```

Expected: FAIL because `/Users/xp/vibecoding/pilipili/app/api/addresses/route.ts` does not exist yet.

- [ ] **Step 5: Implement the server read model and the route**

```ts
// /Users/xp/vibecoding/pilipili/lib/server/addressManagementRepo.ts
import 'server-only';

import { buildAddressManagementRows } from '@/lib/addressManagement';
import { listTrackedUsers } from '@/lib/server/trackedUsersRepo';
import { getDb } from '@/lib/server/sqlite';

function normalize(value: string | null | undefined) {
  return (value || '').trim().toLowerCase();
}

export function readLatestBlockchainActivityByChainAddress() {
  const db = getDb();
  const rows = db.prepare(
    `SELECT chain, LOWER(address) AS address_lower, MAX(timestamp) AS latest_ts
     FROM events
     WHERE source = 'blockchain'
       AND chain IN ('bsc', 'ethereum', 'base', 'solana')
       AND address IS NOT NULL
       AND address != ''
     GROUP BY chain, LOWER(address)`
  ).all() as Array<{ chain: string; address_lower: string; latest_ts: number | null }>;

  const latest = new Map<string, number>();
  for (const row of rows) {
    const chain = normalize(row.chain);
    const addressLower = normalize(row.address_lower);
    if (!chain || !addressLower || typeof row.latest_ts !== 'number') continue;
    latest.set(`${chain}:${addressLower}`, row.latest_ts);
  }
  return latest;
}

export function listAddressManagementRows() {
  return buildAddressManagementRows(
    listTrackedUsers(),
    readLatestBlockchainActivityByChainAddress()
  );
}
```

```ts
// /Users/xp/vibecoding/pilipili/app/api/addresses/route.ts
import { NextResponse } from 'next/server';

import { listAddressManagementRows } from '@/lib/server/addressManagementRepo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return NextResponse.json({
      ok: true,
      rows: listAddressManagementRows(),
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : '读取地址列表失败',
      },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 6: Run the new route test and verify it passes**

Run:

```bash
npm run test:addresses-api
```

Expected: PASS with `addresses api tests: ok`.

- [ ] **Step 7: Commit the new route and read model**

```bash
git add package.json lib/server/addressManagementRepo.ts app/api/addresses/route.ts scripts/test-addresses-api.ts
git commit -m "feat: add address management api"
```

### Task 3: Build the Address Page, Add the Nav Entry, and Simplify `/manage`

**Files:**
- Read: `/Users/xp/vibecoding/pilipili/node_modules/next/dist/docs/01-app/01-getting-started/03-layouts-and-pages.md`
- Create: `/Users/xp/vibecoding/pilipili/app/addresses/page.tsx`
- Modify: `/Users/xp/vibecoding/pilipili/components/TopNav.tsx`
- Modify: `/Users/xp/vibecoding/pilipili/app/manage/page.tsx`
- Modify: `/Users/xp/vibecoding/pilipili/scripts/test-manage-users.ts`
- Test: `/Users/xp/vibecoding/pilipili/scripts/test-manage-users.ts`

- [ ] **Step 1: Read the local Next.js layouts/pages guide before adding the page**

Run:

```bash
sed -n '1,220p' node_modules/next/dist/docs/01-app/01-getting-started/03-layouts-and-pages.md
```

Expected: Review the current App Router page conventions before adding `/addresses`.

- [ ] **Step 2: Extend the manage-page source test so the split contract fails first**

```ts
// /Users/xp/vibecoding/pilipili/scripts/test-manage-users.ts
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ...keep existing imports and helpers...

function run() {
  const managePageSource = readFileSync(join(process.cwd(), 'app/manage/page.tsx'), 'utf8');
  const topNavSource = readFileSync(join(process.cwd(), 'components/TopNav.tsx'), 'utf8');
  const addressesPagePath = join(process.cwd(), 'app/addresses/page.tsx');

  assert.equal(existsSync(addressesPagePath), true, '地址管理页必须存在');
  const addressesPageSource = readFileSync(addressesPagePath, 'utf8');

  assert.match(
    topNavSource,
    /active: 'feed' \\| 'manage' \\| 'addresses' \\| 'system'/,
    'TopNav 必须新增 addresses 激活态'
  );
  assert.match(
    topNavSource,
    /NavLink href=\"\\/addresses\" label=\"地址\"/,
    'TopNav 必须暴露地址页入口'
  );
  assert.match(
    addressesPageSource,
    /fetch\\('\\/api\\/addresses'/,
    '地址页必须从服务端平铺视图读取地址数据'
  );
  assert.match(
    addressesPageSource,
    /删除地址，不会删除人物/,
    '地址页删除确认文案必须明确说明只删地址'
  );
  assert.doesNotMatch(
    managePageSource,
    /expandedAddressByUserId|toggleAddressExpand|ChevronDown|ChevronUp/,
    '人物页不应继续保留内联地址展开状态和展开图标'
  );
  assert.match(
    managePageSource,
    /href=\"\\/addresses\"|Link href=\"\\/addresses\"/,
    '人物页应提供进入地址页的入口'
  );

  // ...keep existing assertions...
}
```

- [ ] **Step 3: Run the source test and verify it fails**

Run:

```bash
npm run test:manage-users
```

Expected: FAIL because the address page does not exist, `TopNav` does not have the `地址` entry, and `/manage` still renders inline address expansion.

- [ ] **Step 4: Implement the page, nav, and manage-page cleanup**

```tsx
// /Users/xp/vibecoding/pilipili/app/addresses/page.tsx
'use client';

import { useEffect, useState } from 'react';
import { AlertCircle, Copy, ExternalLink, Trash2 } from 'lucide-react';

import { TopNav } from '@/components/TopNav';
import { Button } from '@/components/ui/button';
import { formatUsdCompact } from '@/lib/assetFormat';
import { formatRelativeTimeCompact } from '@/lib/timeFormat';
import type { AddressManagementRow } from '@/lib/addressManagement';

export default function AddressesPage() {
  const [rows, setRows] = useState<AddressManagementRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);

  const loadRows = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/addresses', { cache: 'no-store' });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok || !Array.isArray(payload.rows)) {
        throw new Error(payload?.error || `HTTP ${response.status}`);
      }
      setRows(payload.rows as AddressManagementRow[]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadRows();
  }, []);

  const handleCopy = async (address: string) => {
    await navigator.clipboard.writeText(address);
    setCopiedAddress(address);
    window.setTimeout(() => {
      setCopiedAddress((current) => (current === address ? null : current));
    }, 1200);
  };

  const handleExport = async () => {
    const payload = rows.map((row) => `${row.address}:${row.displayName}`).join('\n');
    if (!payload) return;
    await navigator.clipboard.writeText(payload);
  };

  const handleDelete = async (row: AddressManagementRow) => {
    if (!window.confirm(`删除地址，不会删除人物。\\n\\n确认删除 ${row.displayName} 吗？`)) {
      return;
    }

    const key = `${row.userId}:${row.address}`;
    setDeletingKey(key);
    try {
      const response = await fetch(`/api/users/${row.userId}/addresses`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ address: row.address }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error || `HTTP ${response.status}`);
      }
      await loadRows();
    } finally {
      setDeletingKey(null);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950">
      <TopNav active="addresses" />
      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8">
        <section className="flex flex-wrap items-center gap-3">
          <Button onClick={() => void handleExport()} className="bg-zinc-800 text-zinc-100 hover:bg-zinc-700">
            <Copy className="mr-1 h-4 w-4" />
            导出全部地址
          </Button>
        </section>

        <section className="overflow-x-auto rounded-xl border border-zinc-800/70 bg-zinc-900/40">
          <table className="w-full table-auto text-sm">
            <thead className="bg-zinc-900/90 text-zinc-300">
              <tr className="border-b border-zinc-800/80">
                <th className="px-2 py-2.5 text-left font-medium">名字</th>
                <th className="px-2 py-2.5 text-left font-medium">地址</th>
                <th className="px-2 py-2.5 text-right font-medium">上次交易时间</th>
                <th className="px-2 py-2.5 text-right font-medium">总资产</th>
                <th className="px-2 py-2.5 text-center font-medium">GMGN</th>
                <th className="px-2 py-2.5 text-center font-medium">删除</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const deleting = deletingKey === `${row.userId}:${row.address}`;
                return (
                  <tr key={`${row.userId}:${row.address}`} className="border-b border-zinc-800/70 text-zinc-200">
                    <td className="px-2 py-2.5">{row.displayName}</td>
                    <td className="px-2 py-2.5">
                      <button
                        onClick={() => void handleCopy(row.address)}
                        className="max-w-[320px] truncate font-mono text-left text-xs text-zinc-400 hover:text-zinc-200"
                      >
                        {row.address}
                        {copiedAddress === row.address ? ' · 已复制' : ''}
                      </button>
                    </td>
                    <td className="px-2 py-2.5 text-right font-mono">
                      {row.latestActivityAt ? formatRelativeTimeCompact(row.latestActivityAt) : '-'}
                    </td>
                    <td className="px-2 py-2.5 text-right font-mono">
                      {typeof row.totalAssetUsd === 'number' ? formatUsdCompact(row.totalAssetUsd) : '-'}
                    </td>
                    <td className="px-2 py-2.5 text-center">
                      {row.gmgnUrl ? (
                        <a href={row.gmgnUrl} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300">
                          <ExternalLink className="inline h-4 w-4" />
                        </a>
                      ) : (
                        '-'
                      )}
                    </td>
                    <td className="px-2 py-2.5 text-center">
                      <button
                        onClick={() => void handleDelete(row)}
                        disabled={deleting}
                        className="rounded p-1 text-zinc-600 hover:bg-red-500/10 hover:text-red-400 disabled:opacity-50"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        {!loading && rows.length === 0 ? (
          <div className="rounded-xl border-2 border-dashed border-zinc-800 py-16 text-center">
            <AlertCircle className="mx-auto mb-3 h-12 w-12 text-zinc-600" />
            <p className="mb-2 text-zinc-500">暂无地址</p>
            <p className="text-sm text-zinc-600">先到人物页导入或新建人物地址。</p>
          </div>
        ) : null}
      </main>
    </div>
  );
}
```

```tsx
// /Users/xp/vibecoding/pilipili/components/TopNav.tsx
interface TopNavProps {
  active: 'feed' | 'manage' | 'addresses' | 'system';
  rightSlot?: React.ReactNode;
}

// inside the nav links section
<NavLink href="/" label="Feed" active={active === 'feed'} />
<NavLink href="/manage" label="人物" active={active === 'manage'} />
<NavLink href="/addresses" label="地址" active={active === 'addresses'} />
<NavLink href="/system" label="系统" active={active === 'system'} />
```

```tsx
// /Users/xp/vibecoding/pilipili/app/manage/page.tsx
import Link from 'next/link';
// remove: Fragment, ChevronDown, ChevronUp
// remove: expandedAddressByUserId state and toggleAddressExpand()

// replace the address count cell
<td className="px-2 py-2.5">
  <div className="flex flex-col gap-1">
    <span className="inline-flex w-fit items-center rounded border border-zinc-700/70 bg-zinc-950/80 px-1.5 py-0.5 text-[11px] text-zinc-300">
      {displayAddresses.length} 个地址
    </span>
    <Link href="/addresses" className="text-[11px] text-blue-400 hover:text-blue-300 hover:underline">
      去地址页查看
    </Link>
  </div>
</td>

// delete the expanded <tr> block that rendered per-user address details
```

- [ ] **Step 5: Run the updated tests and the build**

Run:

```bash
npm run test:manage-users
npm run test:address-management
npm run test:addresses-api
npm run build
```

Expected:

- `manage users tests: ok`
- `address management tests: ok`
- `addresses api tests: ok`
- `next build` completes without App Router page/route errors

- [ ] **Step 6: Commit the UI split**

```bash
git add components/TopNav.tsx app/manage/page.tsx app/addresses/page.tsx scripts/test-manage-users.ts
git commit -m "feat: split person and address management pages"
```

---

## Self-Review

### 1. Spec coverage

- Separate person page and address page: covered in Task 3.
- Keep existing storage and address ownership rules: covered in Task 2 by reusing `listTrackedUsers()` and `DELETE /api/users/[id]/addresses`.
- Add a flat BID-style address list with name, address, last transaction, assets, GMGN, delete: covered in Tasks 1-3.
- Keep EVM as one logical row and pin GMGN to `bsc`: covered in Tasks 1 and 2.
- Remove manage-page inline address expansion: covered in Task 3.
- Keep person record after deleting its last address: covered by reusing existing deletion semantics in Task 2 and exercised end-to-end in Task 3.

### 2. Placeholder scan

- No `TODO`, `TBD`, or “implement later” markers remain.
- Every task includes exact file paths, commands, and code blocks.

### 3. Type consistency

- `AddressManagementRow`, `buildAddressManagementRows()`, and `listAddressManagementRows()` use the same names across tests, repo, route, and page.
- `primaryChain`, `latestActivityAt`, and `displayName` keep the same property names everywhere.
