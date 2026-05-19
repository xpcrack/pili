# Server Asset Sync Conservative Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the current server-side asset collection, peak validation, and sync behavior unchanged while making the asset/sync pipeline easier to read, test, and maintain.

**Architecture:** Preserve the current public entry points and extract three low-risk helper modules: one for pure anomaly rules, one for the asset sync pipeline orchestration, and one for sync-window state calculations. `syncService.ts` remains the orchestration entry point, while duplicated and rule-heavy logic moves into small modules with focused tests.

**Tech Stack:** Next.js 16 server runtime, TypeScript, `better-sqlite3`, `tsx` script tests, Node `24.11.1`

---

## File Structure

### New files

- Create: `/Users/xp/vibecoding/pilipili/lib/server/assetAnomalyRules.ts`
  - Pure constants and rule helpers for asset mismatch, suspicious peaks, and snapshot completeness.
- Create: `/Users/xp/vibecoding/pilipili/lib/server/assetSyncPipeline.ts`
  - Shared orchestration layer for validate → persist → mark-synced → report.
- Create: `/Users/xp/vibecoding/pilipili/lib/server/syncWindowState.ts`
  - Pure sync window option normalization and window-state reducers.
- Create: `/Users/xp/vibecoding/pilipili/scripts/test-asset-anomaly-rules.ts`
  - Pure script test for rule helpers.
- Create: `/Users/xp/vibecoding/pilipili/scripts/test-asset-sync-pipeline.ts`
  - Focused orchestration test for the shared asset pipeline.
- Create: `/Users/xp/vibecoding/pilipili/scripts/test-sync-window-state.ts`
  - Pure script test for sync window reducers.

### Existing files to modify

- Modify: `/Users/xp/vibecoding/pilipili/package.json`
  - Register the new targeted script tests and wire them into the aggregate `test` script if the repo pattern requires it.
- Modify: `/Users/xp/vibecoding/pilipili/lib/server/assetPeakValidation.ts`
  - Replace inline anomaly-rule constants and pure checks with imports from `assetAnomalyRules.ts`.
- Modify: `/Users/xp/vibecoding/pilipili/lib/server/historicalPeakRepair.ts`
  - Reuse shared anomaly rules and shared snapshot-completeness helper.
- Modify: `/Users/xp/vibecoding/pilipili/lib/server/syncService.ts`
  - Import sync-window helpers and the shared asset pipeline, then simplify the orchestration flow.
- Modify: `/Users/xp/vibecoding/pilipili/scripts/backfill-14days-transactions.ts`
  - Reuse the shared asset sync pipeline instead of re-assembling asset persistence inline.

---

### Task 1: Create Isolated Worktree And Verify Baseline

**Files:**
- Modify: `/Users/xp/vibecoding/pilipili/docs/superpowers/plans/2026-05-05-server-asset-sync-conservative-refactor.md`
- Test: `/Users/xp/vibecoding/pilipili/package.json`

- [ ] **Step 1: Verify the project-local worktree directory is ignored**

Run:

```bash
cd /Users/xp/vibecoding/pilipili
git check-ignore -q .worktrees
```

Expected: exit code `0`

- [ ] **Step 2: Create the dedicated branch and worktree**

Run:

```bash
cd /Users/xp/vibecoding/pilipili
git worktree add .worktrees/codex-server-asset-sync-conservative-refactor -b codex/server-asset-sync-conservative-refactor
```

Expected: new worktree created at `/Users/xp/vibecoding/pilipili/.worktrees/codex-server-asset-sync-conservative-refactor`

- [ ] **Step 3: Install dependencies in the new worktree if needed**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-server-asset-sync-conservative-refactor
npm install
```

Expected: install completes without dependency resolution errors

- [ ] **Step 4: Run the baseline verification subset before any code changes**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-server-asset-sync-conservative-refactor
npm run test:address-assets
npm run test:asset-peak-validation
npm run test:asset-peak-audit
NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' npx --yes tsx scripts/test-historical-peak-repair.ts
npm run test:sync-failure-notifier
```

Expected: all commands pass on the baseline branch state

- [ ] **Step 5: Confirm the worktree starts clean**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-server-asset-sync-conservative-refactor
git status --short
```

Expected: no unexpected tracked changes before implementation starts

### Task 2: Extract Shared Asset Anomaly Rules

**Files:**
- Create: `/Users/xp/vibecoding/pilipili/lib/server/assetAnomalyRules.ts`
- Create: `/Users/xp/vibecoding/pilipili/scripts/test-asset-anomaly-rules.ts`
- Modify: `/Users/xp/vibecoding/pilipili/package.json`
- Modify: `/Users/xp/vibecoding/pilipili/lib/server/assetPeakValidation.ts`
- Modify: `/Users/xp/vibecoding/pilipili/lib/server/historicalPeakRepair.ts`
- Test: `/Users/xp/vibecoding/pilipili/scripts/test-asset-anomaly-rules.ts`
- Test: `/Users/xp/vibecoding/pilipili/scripts/test-asset-peak-validation.ts`
- Test: `/Users/xp/vibecoding/pilipili/scripts/test-historical-peak-repair.ts`

- [ ] **Step 1: Write the failing pure anomaly-rules test**

Create `/Users/xp/vibecoding/pilipili/scripts/test-asset-anomaly-rules.ts`:

```ts
import assert from 'node:assert/strict';

import {
  DETAIL_TOTAL_MISMATCH_MIN_DELTA_USD,
  DETAIL_TOTAL_MISMATCH_RATIO_LIMIT,
  SUSPICIOUS_PEAK_DELTA_USD,
  SUSPICIOUS_PEAK_RATIO_LIMIT,
  countSnapshotsByUserId,
  isCompleteAssetSnapshotForUser,
  isDetailTotalMismatch,
  isSuspiciousHistoricalPeak,
} from '@/lib/server/assetAnomalyRules';

function run() {
  assert.equal(DETAIL_TOTAL_MISMATCH_RATIO_LIMIT, 2);
  assert.equal(DETAIL_TOTAL_MISMATCH_MIN_DELTA_USD, 50_000);
  assert.equal(SUSPICIOUS_PEAK_RATIO_LIMIT, 2);
  assert.equal(SUSPICIOUS_PEAK_DELTA_USD, 50_000);

  assert.equal(isDetailTotalMismatch(5_250_000, 108_222.77), true);
  assert.equal(isDetailTotalMismatch(200_000, 180_000), false);

  assert.equal(isSuspiciousHistoricalPeak(5_350_000, 195_000), true);
  assert.equal(isSuspiciousHistoricalPeak(180_000, 120_000), false);

  const counts = countSnapshotsByUserId([
    { userId: 'u1', address: 'a1', chain: 'bsc', totalAssetUsd: 1, updatedAt: 1 },
    { userId: 'u1', address: 'a2', chain: 'ethereum', totalAssetUsd: 2, updatedAt: 1 },
    { userId: 'u2', address: 'a3', chain: 'solana', totalAssetUsd: 3, updatedAt: 1 },
  ]);

  assert.equal(counts.get('u1'), 2);
  assert.equal(counts.get('u2'), 1);

  assert.equal(
    isCompleteAssetSnapshotForUser(
      {
        id: 'u1',
        name: 'user-1',
        handle: 'user-1',
        avatar: '',
        twitter: undefined,
        telegram: undefined,
        tags: [],
        totalAssetUsd: 0,
        historicalMaxAssetUsd: 0,
        assetUpdatedAt: null,
        addresses: [
          { address: 'a1', name: '#1', chain: 'bsc', totalAssetUsd: null, assetUpdatedAt: null },
          { address: 'a2', name: '#2', chain: 'ethereum', totalAssetUsd: null, assetUpdatedAt: null },
        ],
      },
      counts
    ),
    true
  );

  console.log('asset anomaly rules tests: ok');
}

run();
```

- [ ] **Step 2: Register the new rule test command**

Update `/Users/xp/vibecoding/pilipili/package.json`:

```json
{
  "scripts": {
    "test:asset-anomaly-rules": "tsx scripts/test-asset-anomaly-rules.ts",
    "test": "npm run test:admin-auth && npm run test:feed-ordering && npm run test:time-format && npm run test:activity-card-social && npm run test:activity-card-view-model && npm run test:activity-card-render && npm run test:activity-importance && npm run test:activity-importance-service && npm run test:activity-importance-ingest && npm run test:activity-importance-backfill && npm run test:trade-usd && npm run test:events-feed-total && npm run test:feed-request-arbiter && npm run test:feed-query-mode && npm run test:feed-client-state && npm run test:feed-completeness-visibility && npm run test:feed-prewarm-service && npm run test:activities-api && npm run test:activity-feed-retry && npm run test:global-search-wiring && npm run test:feed-page-state && npm run test:user-bar && npm run test:tooling-config && npm run test:node-runtime-policy && npm run test:search-filters && npm run test:source-reconciliation && npm run test:sync-failure-notifier && npm run test:manage-users && npm run test:tracked-user-validation && npm run test:tracked-address-ownership && npm run test:asset-anomaly-rules && npm run test:asset-peak-validation && npm run test:asset-peak-audit && npm run test:tracked-user-assets && npm run test:tracked-user-evm-expansion && npm run test:address-book && npm run test:address-management && npm run test:address-assets && npm run test:conflict-repo && npm run test:system-config-conflict-chat && npm run test:conflict-notifier && npm run test:parser-fixtures && npm run test:telegram-monitor-reconciliation && npm run test:twitter-fetcher && npm run test:twitter-provider-router && npm run test:twitter-provider-clients && npm run test:twitter-provider-state && npm run test:twitter-identity-service && npm run test:twitter-stable-identity && npm run test:twitter-sync-service && npm run test:twitter-relay-coverage && npm run test:twitter-bridge"
  }
}
```

- [ ] **Step 3: Run the new rule test and verify it fails**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-server-asset-sync-conservative-refactor
npm run test:asset-anomaly-rules
```

Expected: FAIL with a module/export error because `lib/server/assetAnomalyRules.ts` does not exist yet

- [ ] **Step 4: Implement the shared anomaly-rules module**

Create `/Users/xp/vibecoding/pilipili/lib/server/assetAnomalyRules.ts`:

```ts
import type { AddressAssetSnapshot } from '@/lib/activityFeed';
import type { User } from '@/types';

export const LIQUIDITY_RATIO_LIMIT = 0.5;
export const DETAIL_TOTAL_MISMATCH_RATIO_LIMIT = 2;
export const DETAIL_TOTAL_MISMATCH_MIN_DELTA_USD = 50_000;
export const SUSPICIOUS_PEAK_RATIO_LIMIT = 2;
export const SUSPICIOUS_PEAK_DELTA_USD = 50_000;

export function isDetailTotalMismatch(candidateTotalAssetUsd: number, detailTotalAssetUsd: number) {
  if (!(candidateTotalAssetUsd > 0) || !(detailTotalAssetUsd > 0)) {
    return false;
  }

  const larger = Math.max(candidateTotalAssetUsd, detailTotalAssetUsd);
  const smaller = Math.min(candidateTotalAssetUsd, detailTotalAssetUsd);
  const ratio = larger / smaller;
  const deltaUsd = Math.abs(candidateTotalAssetUsd - detailTotalAssetUsd);

  return ratio >= DETAIL_TOTAL_MISMATCH_RATIO_LIMIT && deltaUsd >= DETAIL_TOTAL_MISMATCH_MIN_DELTA_USD;
}

export function isSuspiciousHistoricalPeak(historicalMaxAssetUsd: number, currentTotalAssetUsd: number) {
  if (!(historicalMaxAssetUsd > currentTotalAssetUsd) || !(currentTotalAssetUsd > 0)) {
    return false;
  }

  const ratio = historicalMaxAssetUsd / currentTotalAssetUsd;
  const deltaUsd = historicalMaxAssetUsd - currentTotalAssetUsd;
  return ratio >= SUSPICIOUS_PEAK_RATIO_LIMIT && deltaUsd >= SUSPICIOUS_PEAK_DELTA_USD;
}

export function countSnapshotsByUserId(addressAssets: readonly AddressAssetSnapshot[]) {
  const counts = new Map<string, number>();

  for (const asset of addressAssets) {
    if (!asset.userId) continue;
    counts.set(asset.userId, (counts.get(asset.userId) || 0) + 1);
  }

  return counts;
}

export function isCompleteAssetSnapshotForUser(
  user: Pick<User, 'id' | 'addresses'>,
  snapshotCounts: ReadonlyMap<string, number>
) {
  return (snapshotCounts.get(user.id) || 0) === user.addresses.length;
}
```

- [ ] **Step 5: Rewire the existing validators to consume the shared rules**

Update `/Users/xp/vibecoding/pilipili/lib/server/assetPeakValidation.ts` imports and removals:

```ts
import {
  LIQUIDITY_RATIO_LIMIT,
  isDetailTotalMismatch,
} from '@/lib/server/assetAnomalyRules';
```

And delete the duplicated local declarations:

```ts
const LIQUIDITY_RATIO_LIMIT = 0.5;
const DETAIL_TOTAL_MISMATCH_RATIO_LIMIT = 2; // delete
const DETAIL_TOTAL_MISMATCH_MIN_DELTA_USD = 50_000; // delete

function isDetailTotalMismatch(candidateTotalAssetUsd: number, detailTotalAssetUsd: number) {
  if (!(candidateTotalAssetUsd > 0) || !(detailTotalAssetUsd > 0)) {
    return false;
  }

  const larger = Math.max(candidateTotalAssetUsd, detailTotalAssetUsd);
  const smaller = Math.min(candidateTotalAssetUsd, detailTotalAssetUsd);
  const ratio = larger / smaller;
  const deltaUsd = Math.abs(candidateTotalAssetUsd - detailTotalAssetUsd);

  return ratio >= DETAIL_TOTAL_MISMATCH_RATIO_LIMIT && deltaUsd >= DETAIL_TOTAL_MISMATCH_MIN_DELTA_USD;
}
```

Update `/Users/xp/vibecoding/pilipili/lib/server/historicalPeakRepair.ts` imports:

```ts
import {
  countSnapshotsByUserId,
  isCompleteAssetSnapshotForUser,
  isSuspiciousHistoricalPeak,
} from '@/lib/server/assetAnomalyRules';
```

And replace the inline complete-snapshot and suspicious-peak checks with those shared helpers.

- [ ] **Step 6: Run the focused anomaly-rule verification**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-server-asset-sync-conservative-refactor
npm run test:asset-anomaly-rules
npm run test:asset-peak-validation
NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' npx --yes tsx scripts/test-historical-peak-repair.ts
```

Expected: all commands pass

- [ ] **Step 7: Commit the shared anomaly-rule extraction**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-server-asset-sync-conservative-refactor
git add lib/server/assetAnomalyRules.ts lib/server/assetPeakValidation.ts lib/server/historicalPeakRepair.ts scripts/test-asset-anomaly-rules.ts package.json
git commit -m "refactor: extract shared asset anomaly rules"
```

Expected: one focused commit containing only the shared-rule extraction

### Task 3: Create The Shared Asset Sync Pipeline

**Files:**
- Create: `/Users/xp/vibecoding/pilipili/lib/server/assetSyncPipeline.ts`
- Create: `/Users/xp/vibecoding/pilipili/scripts/test-asset-sync-pipeline.ts`
- Modify: `/Users/xp/vibecoding/pilipili/package.json`
- Modify: `/Users/xp/vibecoding/pilipili/lib/server/syncService.ts`
- Modify: `/Users/xp/vibecoding/pilipili/scripts/backfill-14days-transactions.ts`
- Test: `/Users/xp/vibecoding/pilipili/scripts/test-asset-sync-pipeline.ts`
- Test: `/Users/xp/vibecoding/pilipili/scripts/test-asset-peak-validation.ts`
- Test: `/Users/xp/vibecoding/pilipili/scripts/test-sync-failure-notifier.ts`

- [ ] **Step 1: Write the failing pipeline orchestration test**

Create `/Users/xp/vibecoding/pilipili/scripts/test-asset-sync-pipeline.ts`:

```ts
import assert from 'node:assert/strict';

import { runAssetSyncPipeline } from '@/lib/server/assetSyncPipeline';

async function run() {
  const markCalls: Array<{ chain: string; address: string; syncedAt: number }> = [];

  const result = await runAssetSyncPipeline({
    users: [],
    addressAssets: [
      { userId: 'u1', address: '0xgood', chain: 'bsc', totalAssetUsd: 10, updatedAt: 100 },
      { userId: 'u2', address: '0xbad', chain: 'ethereum', totalAssetUsd: 20, updatedAt: 100 },
    ],
    userAssets: [
      { userId: 'u1', totalValueUsd: 10, totalAssetUsd: 10, updatedAt: 100 },
      { userId: 'u2', totalValueUsd: 20, totalAssetUsd: 20, updatedAt: 100 },
    ],
    diagnostics: [
      {
        userId: 'u1',
        userName: 'good',
        address: '0xgood',
        addressName: '#1',
        chain: 'bsc',
        ok: true,
        transactionCount: 1,
        error: null,
      },
      {
        userId: 'u2',
        userName: 'bad',
        address: '0xbad',
        addressName: '#1',
        chain: 'ethereum',
        ok: false,
        transactionCount: 0,
        error: 'timeout',
      },
    ],
    syncedAt: 1234,
    validateAndPersistPeakAssetSnapshots: async () => ({
      addressAssets: [{ userId: 'u1', address: '0xgood', chain: 'bsc', totalAssetUsd: 10, updatedAt: 100 }],
      userAssets: [{ userId: 'u1', totalValueUsd: 10, totalAssetUsd: 10, updatedAt: 100 }],
      blockedUsers: [
        {
          userId: 'u2',
          userName: 'bad',
          candidateTotalAssetUsd: 20,
          previousHistoricalMaxAssetUsd: 5,
          status: 'detail_total_mismatch',
          reason: 'candidate/detail mismatch',
          topHoldings: [],
        },
      ],
    }),
    markAddressesSynced: (cursors) => {
      markCalls.push(...cursors);
    },
  });

  assert.equal(result.blockedUsers.length, 1);
  assert.deepEqual(markCalls, [{ chain: 'bsc', address: '0xgood', syncedAt: 1234 }]);
  assert.equal(result.persistedUserAssets.length, 1);
  assert.equal(result.persistedUserAssets[0]?.userId, 'u1');

  console.log('asset sync pipeline tests: ok');
}

void run();
```

- [ ] **Step 2: Register the new pipeline test command**

Update `/Users/xp/vibecoding/pilipili/package.json`:

```json
{
  "scripts": {
    "test:asset-sync-pipeline": "tsx scripts/test-asset-sync-pipeline.ts"
  }
}
```

Also append `npm run test:asset-sync-pipeline` into the aggregate `test` script near the other asset-related checks.

- [ ] **Step 3: Run the new pipeline test and verify it fails**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-server-asset-sync-conservative-refactor
npm run test:asset-sync-pipeline
```

Expected: FAIL with a module or export error because `runAssetSyncPipeline()` does not exist yet

- [ ] **Step 4: Implement the shared pipeline module**

Create `/Users/xp/vibecoding/pilipili/lib/server/assetSyncPipeline.ts`:

```ts
import type { AddressDiagnostic } from '@/lib/activityFeed';
import type { AddressAssetSnapshot, UserAssetSnapshot } from '@/lib/activityFeed';
import { markAddressesSynced as defaultMarkAddressesSynced } from '@/lib/server/trackedUsersRepo';
import {
  validateAndPersistPeakAssetSnapshots as defaultValidateAndPersistPeakAssetSnapshots,
  type BlockedPeakSnapshot,
} from '@/lib/server/assetPeakValidation';
import type { User } from '@/types';

type ValidateAndPersist = typeof defaultValidateAndPersistPeakAssetSnapshots;
type MarkAddressesSynced = typeof defaultMarkAddressesSynced;

export async function runAssetSyncPipeline(params: {
  users: User[];
  addressAssets: AddressAssetSnapshot[];
  userAssets: UserAssetSnapshot[];
  diagnostics: AddressDiagnostic[];
  syncedAt?: number;
  validateAndPersistPeakAssetSnapshots?: ValidateAndPersist;
  markAddressesSynced?: MarkAddressesSynced;
}) {
  const validateAndPersistPeakAssetSnapshots =
    params.validateAndPersistPeakAssetSnapshots || defaultValidateAndPersistPeakAssetSnapshots;
  const markAddressesSynced = params.markAddressesSynced || defaultMarkAddressesSynced;

  const validation = await validateAndPersistPeakAssetSnapshots({
    users: params.users,
    addressAssets: params.addressAssets,
    userAssets: params.userAssets,
  });

  const syncedAt =
    typeof params.syncedAt === 'number' && Number.isFinite(params.syncedAt) ? params.syncedAt : Date.now();
  const syncedCursors = params.diagnostics
    .filter((item) => item.ok)
    .map((item) => ({
      chain: item.chain,
      address: item.address,
      syncedAt,
    }));

  markAddressesSynced(syncedCursors);

  return {
    blockedUsers: validation.blockedUsers as BlockedPeakSnapshot[],
    persistedAddressAssets: validation.addressAssets,
    persistedUserAssets: validation.userAssets,
    syncedCursors,
  };
}
```

- [ ] **Step 5: Replace the duplicated asset flow in `syncService.ts` and the backfill script**

In `/Users/xp/vibecoding/pilipili/lib/server/syncService.ts`, replace:

```ts
const assetValidation = await validateAndPersistPeakAssetSnapshots({
  users: targetUsers,
  addressAssets: result.addressAssets,
  userAssets: result.userAssets,
});

const syncedAt = Date.now();
markAddressesSynced(
  result.diagnostics
    .filter((item) => item.ok)
    .map((item) => ({
      chain: item.chain,
      address: item.address,
      syncedAt,
    }))
);
```

With:

```ts
const assetSync = await runAssetSyncPipeline({
  users: targetUsers,
  addressAssets: result.addressAssets,
  userAssets: result.userAssets,
  diagnostics: result.diagnostics,
});
```

And update the warning log payload source:

```ts
if (assetSync.blockedUsers.length > 0) {
  appendSyncLog({
    runKind: 'sync',
    runId,
    level: 'warn',
    phase: 'asset-peak-validation',
    message: 'blocked suspicious peak asset snapshots',
    payload: {
      blockedUserIds: assetSync.blockedUsers.map((item) => item.userId),
      blockedCount: assetSync.blockedUsers.length,
    },
  });
}
```

In `/Users/xp/vibecoding/pilipili/scripts/backfill-14days-transactions.ts`, replace:

```ts
const assetValidation = await validateAndPersistPeakAssetSnapshots({
  users,
  addressAssets: feedResult.addressAssets,
  userAssets: feedResult.userAssets,
});

const syncedAt = Date.now();
markAddressesSynced(
  feedResult.diagnostics
    .filter((item) => item.ok)
    .map((item) => ({
      chain: item.chain,
      address: item.address,
      syncedAt,
    }))
);
```

With:

```ts
const assetSync = await runAssetSyncPipeline({
  users,
  addressAssets: feedResult.addressAssets,
  userAssets: feedResult.userAssets,
  diagnostics: feedResult.diagnostics,
});
```

- [ ] **Step 6: Run the focused pipeline verification**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-server-asset-sync-conservative-refactor
npm run test:asset-sync-pipeline
npm run test:asset-peak-validation
npm run test:sync-failure-notifier
```

Expected: all commands pass

- [ ] **Step 7: Commit the pipeline extraction**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-server-asset-sync-conservative-refactor
git add lib/server/assetSyncPipeline.ts lib/server/syncService.ts scripts/backfill-14days-transactions.ts scripts/test-asset-sync-pipeline.ts package.json
git commit -m "refactor: share asset sync pipeline"
```

Expected: one focused commit containing only the shared pipeline refactor

### Task 4: Extract Sync Window State Helpers

**Files:**
- Create: `/Users/xp/vibecoding/pilipili/lib/server/syncWindowState.ts`
- Create: `/Users/xp/vibecoding/pilipili/scripts/test-sync-window-state.ts`
- Modify: `/Users/xp/vibecoding/pilipili/package.json`
- Modify: `/Users/xp/vibecoding/pilipili/lib/server/syncService.ts`
- Test: `/Users/xp/vibecoding/pilipili/scripts/test-sync-window-state.ts`
- Test: `/Users/xp/vibecoding/pilipili/scripts/test-sync-failure-notifier.ts`

- [ ] **Step 1: Write the failing pure sync-window test**

Create `/Users/xp/vibecoding/pilipili/scripts/test-sync-window-state.ts`:

```ts
import assert from 'node:assert/strict';

import {
  applyRefreshWindowState,
  createDefaultWindowState,
  mergeRefreshWindowState,
  normalizeSyncOptions,
} from '@/lib/server/syncWindowState';

function run() {
  assert.deepEqual(normalizeSyncOptions(undefined), {
    mode: 'refresh',
    scope: 'global',
    userId: null,
  });

  assert.deepEqual(normalizeSyncOptions({ mode: 'backfill', scope: 'user', userId: '  user-1  ' }), {
    mode: 'backfill',
    scope: 'user',
    userId: 'user-1',
  });

  const state = createDefaultWindowState();
  assert.equal(state.globalEarliestMs, null);

  const next = applyRefreshWindowState(
    [{ id: 'u1' }, { id: 'u2' }] as Array<{ id: string }>,
    1000
  );
  assert.equal(next.globalEarliestMs, 1000);

  const merged = mergeRefreshWindowState(
    state,
    [{ id: 'u1' }] as Array<{ id: string }>,
    2000,
    [{ userId: 'u1', ok: false }] as Array<{ userId: string; ok: boolean }>
  );
  assert.equal(merged.globalAlignment, 'partial');

  console.log('sync window state tests: ok');
}

run();
```

- [ ] **Step 2: Register the new sync-window test command**

Update `/Users/xp/vibecoding/pilipili/package.json`:

```json
{
  "scripts": {
    "test:sync-window-state": "tsx scripts/test-sync-window-state.ts"
  }
}
```

Also append `npm run test:sync-window-state` into the aggregate `test` script near the other sync-related tests.

- [ ] **Step 3: Run the new sync-window test and verify it fails**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-server-asset-sync-conservative-refactor
npm run test:sync-window-state
```

Expected: FAIL with a module/export error because `lib/server/syncWindowState.ts` does not exist yet

- [ ] **Step 4: Implement the sync-window helper module by moving the current reducers intact**

Create `/Users/xp/vibecoding/pilipili/lib/server/syncWindowState.ts` with the current pure implementations extracted from `syncService.ts`:

```ts
import type { AddressDiagnostic } from '@/lib/activityFeed';
import type { FeedBackfillWindowState } from '@/lib/server/feedSnapshotRepo';

export type SyncMode = 'refresh' | 'backfill';
export type BackfillScope = 'global' | 'user';

export interface TriggerSyncOptions {
  mode?: SyncMode;
  scope?: BackfillScope;
  userId?: string | null;
}

function getSuccessfulUserIds(diagnostics: AddressDiagnostic[]) {
  return new Set(
    diagnostics
      .filter((item) => item.ok)
      .map((item) => item.userId)
  );
}

function getFullySuccessfulUserIds(diagnostics: AddressDiagnostic[]) {
  const stats = new Map<string, { hasSuccess: boolean; hasFailure: boolean }>();

  for (const item of diagnostics) {
    const existing = stats.get(item.userId) ?? { hasSuccess: false, hasFailure: false };
    if (item.ok) {
      existing.hasSuccess = true;
    } else {
      existing.hasFailure = true;
    }
    stats.set(item.userId, existing);
  }

  return new Set(
    Array.from(stats.entries())
      .filter(([, value]) => value.hasSuccess && !value.hasFailure)
      .map(([userId]) => userId)
  );
}

export function normalizeSyncOptions(options: TriggerSyncOptions | undefined) {
  const mode: SyncMode = options?.mode === 'backfill' ? 'backfill' : 'refresh';
  const scope: BackfillScope = options?.scope === 'user' ? 'user' : 'global';
  const userId = typeof options?.userId === 'string' && options.userId.trim() ? options.userId.trim() : null;

  if (mode !== 'backfill') {
    return {
      mode,
      scope: 'global' as const,
      userId: null,
    };
  }

  if (scope === 'user' && userId) {
    return {
      mode,
      scope,
      userId,
    };
  }

  return {
    mode,
    scope: 'global' as const,
    userId: null,
  };
}

export function createDefaultWindowState(): FeedBackfillWindowState {
  return {
    globalEarliestMs: null,
    perUserEarliestMs: {},
    perUserHistoryComplete: {},
    perUserLastBackfillAt: {},
    perUserLocalQualifiedCount: {},
    globalAlignment: 'aligned',
    updatedAt: Date.now(),
  };
}

export function applyRefreshWindowState(
  users: Array<{ id: string }>,
  beginMs: number
) {
  const perUserEarliestMs: Record<string, number> = {};
  const perUserHistoryComplete: Record<string, boolean> = {};
  const perUserLastBackfillAt: Record<string, number> = {};
  const perUserLocalQualifiedCount: Record<string, number> = {};

  for (const user of users) {
    perUserEarliestMs[user.id] = beginMs;
    perUserHistoryComplete[user.id] = false;
    perUserLastBackfillAt[user.id] = 0;
    perUserLocalQualifiedCount[user.id] = 0;
  }

  return {
    globalEarliestMs: beginMs,
    perUserEarliestMs,
    perUserHistoryComplete,
    perUserLastBackfillAt,
    perUserLocalQualifiedCount,
    globalAlignment: 'aligned' as const,
    updatedAt: Date.now(),
  } satisfies FeedBackfillWindowState;
}

export function mergeRefreshWindowState(
  current: FeedBackfillWindowState,
  users: Array<{ id: string }>,
  beginMs: number,
  diagnostics: AddressDiagnostic[]
) {
  const nextPerUserEarliest = {
    ...current.perUserEarliestMs,
  };
  const nextPerUserHistoryComplete = {
    ...current.perUserHistoryComplete,
  };
  const nextPerUserLastBackfillAt = {
    ...current.perUserLastBackfillAt,
  };
  const nextPerUserLocalQualifiedCount = {
    ...current.perUserLocalQualifiedCount,
  };

  for (const user of users) {
    if (typeof nextPerUserEarliest[user.id] === 'number') {
      nextPerUserHistoryComplete[user.id] = nextPerUserHistoryComplete[user.id] === true;
      nextPerUserLastBackfillAt[user.id] = nextPerUserLastBackfillAt[user.id] ?? 0;
      nextPerUserLocalQualifiedCount[user.id] = nextPerUserLocalQualifiedCount[user.id] ?? 0;
      continue;
    }
    nextPerUserEarliest[user.id] = beginMs;
    nextPerUserHistoryComplete[user.id] = false;
    nextPerUserLastBackfillAt[user.id] = 0;
    nextPerUserLocalQualifiedCount[user.id] = 0;
  }

  return {
    globalEarliestMs: current.globalEarliestMs ?? beginMs,
    perUserEarliestMs: nextPerUserEarliest,
    perUserHistoryComplete: nextPerUserHistoryComplete,
    perUserLastBackfillAt: nextPerUserLastBackfillAt,
    perUserLocalQualifiedCount: nextPerUserLocalQualifiedCount,
    globalAlignment: diagnostics.some((item) => !item.ok) ? 'partial' : 'aligned',
    updatedAt: Date.now(),
  } satisfies FeedBackfillWindowState;
}

export function applyGlobalBackfillWindowState(
  current: FeedBackfillWindowState,
  users: Array<{ id: string }>,
  beginMs: number,
  diagnostics: AddressDiagnostic[]
) {
  const successfulUserIds = getSuccessfulUserIds(diagnostics);
  const fullySuccessfulUserIds = getFullySuccessfulUserIds(diagnostics);

  const next = {
    ...current,
    perUserEarliestMs: {
      ...current.perUserEarliestMs,
    },
    perUserHistoryComplete: {
      ...current.perUserHistoryComplete,
    },
    perUserLastBackfillAt: {
      ...current.perUserLastBackfillAt,
    },
    perUserLocalQualifiedCount: {
      ...current.perUserLocalQualifiedCount,
    },
    updatedAt: Date.now(),
  };

  if (successfulUserIds.size > 0) {
    next.globalEarliestMs = beginMs;
  }

  for (const user of users) {
    if (!successfulUserIds.has(user.id)) {
      continue;
    }
    next.perUserEarliestMs[user.id] = beginMs;
    next.perUserLastBackfillAt[user.id] = Date.now();
    if (beginMs === 0 && fullySuccessfulUserIds.has(user.id)) {
      next.perUserHistoryComplete[user.id] = true;
    }
  }

  next.globalAlignment = diagnostics.some((item) => !item.ok) ? 'partial' : 'aligned';
  return next;
}

export function applyUserBackfillWindowState(
  current: FeedBackfillWindowState,
  userId: string,
  beginMs: number,
  diagnostics: AddressDiagnostic[]
) {
  const successfulUserIds = getSuccessfulUserIds(diagnostics);
  const fullySuccessfulUserIds = getFullySuccessfulUserIds(diagnostics);
  const hasSuccess = successfulUserIds.has(userId);
  if (!hasSuccess) {
    return {
      ...current,
      updatedAt: Date.now(),
    } satisfies FeedBackfillWindowState;
  }

  return {
    ...current,
    perUserEarliestMs: {
      ...current.perUserEarliestMs,
      [userId]: beginMs,
    },
    perUserHistoryComplete: {
      ...current.perUserHistoryComplete,
      [userId]:
        beginMs === 0 && fullySuccessfulUserIds.has(userId)
          ? true
          : current.perUserHistoryComplete[userId] === true,
    },
    perUserLastBackfillAt: {
      ...current.perUserLastBackfillAt,
      [userId]: Date.now(),
    },
    perUserLocalQualifiedCount: {
      ...current.perUserLocalQualifiedCount,
    },
    updatedAt: Date.now(),
  } satisfies FeedBackfillWindowState;
}
```

- [ ] **Step 5: Update `syncService.ts` to import the window helpers and delete the duplicated local copies**

Add imports:

```ts
import {
  applyGlobalBackfillWindowState,
  applyRefreshWindowState,
  applyUserBackfillWindowState,
  createDefaultWindowState,
  mergeRefreshWindowState,
  normalizeSyncOptions,
  type TriggerSyncOptions,
} from '@/lib/server/syncWindowState';
```

Then delete the local declarations now provided by the helper module:

```ts
type SyncMode = 'refresh' | 'backfill';
type BackfillScope = 'global' | 'user';

interface TriggerSyncOptions {
  mode?: SyncMode;
  scope?: BackfillScope;
  userId?: string | null;
}
```

And remove these exact local blocks from `syncService.ts` after the imports compile cleanly:

- `function getSuccessfulUserIds(diagnostics: AddressDiagnostic[])`
- `function getFullySuccessfulUserIds(diagnostics: AddressDiagnostic[])`
- `function normalizeSyncOptions(options: TriggerSyncOptions | undefined)`
- `function createDefaultWindowState()`
- `function applyRefreshWindowState(users: ReturnType<typeof listTrackedUsers>, beginMs: number)`
- `function mergeRefreshWindowState(current: FeedBackfillWindowState, users: ReturnType<typeof listTrackedUsers>, beginMs: number, diagnostics: AddressDiagnostic[])`
- `function applyGlobalBackfillWindowState(current: FeedBackfillWindowState, users: ReturnType<typeof listTrackedUsers>, beginMs: number, diagnostics: AddressDiagnostic[])`
- `function applyUserBackfillWindowState(current: FeedBackfillWindowState, userId: string, beginMs: number, diagnostics: AddressDiagnostic[])`

- [ ] **Step 6: Run the focused sync-window verification**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-server-asset-sync-conservative-refactor
npm run test:sync-window-state
npm run test:sync-failure-notifier
```

Expected: all commands pass

- [ ] **Step 7: Commit the sync-window extraction**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-server-asset-sync-conservative-refactor
git add lib/server/syncWindowState.ts lib/server/syncService.ts scripts/test-sync-window-state.ts package.json
git commit -m "refactor: extract sync window state helpers"
```

Expected: one focused commit containing only the window-state extraction

### Task 5: Run Final Verification And Review The Refactor Boundaries

**Files:**
- Modify: `/Users/xp/vibecoding/pilipili/lib/server/assetPeakValidation.ts`
- Modify: `/Users/xp/vibecoding/pilipili/lib/server/historicalPeakRepair.ts`
- Modify: `/Users/xp/vibecoding/pilipili/lib/server/syncService.ts`
- Modify: `/Users/xp/vibecoding/pilipili/scripts/backfill-14days-transactions.ts`
- Test: `/Users/xp/vibecoding/pilipili/package.json`

- [ ] **Step 1: Run the full targeted verification subset**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-server-asset-sync-conservative-refactor
npm run test:asset-anomaly-rules
npm run test:asset-sync-pipeline
npm run test:sync-window-state
npm run test:address-assets
npm run test:asset-peak-validation
npm run test:asset-peak-audit
NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' npx --yes tsx scripts/test-historical-peak-repair.ts
npm run test:sync-failure-notifier
npm run build
```

Expected: all commands pass

- [ ] **Step 2: Review the diff to ensure the refactor stayed inside the agreed scope**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-server-asset-sync-conservative-refactor
git diff --stat
git diff -- lib/server/syncService.ts lib/server/assetPeakValidation.ts lib/server/historicalPeakRepair.ts scripts/backfill-14days-transactions.ts
```

Expected: only the planned server asset/sync files and new tests/helpers are changed

- [ ] **Step 3: Confirm no stale duplicate logic remains**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-server-asset-sync-conservative-refactor
rg -n "DETAIL_TOTAL_MISMATCH_RATIO_LIMIT|SUSPICIOUS_PEAK_RATIO_LIMIT|applyRefreshWindowState\\(|markAddressesSynced\\(" lib scripts
```

Expected:
- anomaly thresholds only live in `lib/server/assetAnomalyRules.ts`
- sync-window reducers only live in `lib/server/syncWindowState.ts`
- asset synced marking in `syncService.ts` and `backfill-14days-transactions.ts` now goes through `runAssetSyncPipeline()`

- [ ] **Step 4: Commit the final integration pass**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-server-asset-sync-conservative-refactor
git add lib/server/assetAnomalyRules.ts lib/server/assetSyncPipeline.ts lib/server/syncWindowState.ts lib/server/assetPeakValidation.ts lib/server/historicalPeakRepair.ts lib/server/syncService.ts scripts/backfill-14days-transactions.ts scripts/test-asset-anomaly-rules.ts scripts/test-asset-sync-pipeline.ts scripts/test-sync-window-state.ts package.json
git commit -m "refactor: simplify server asset sync flow"
```

Expected: final integration commit recorded after green verification
