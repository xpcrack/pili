# Feed Importance Score V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist a stable `metadata.importance` score onto every feed activity at ingest time, expose the score in the card UI with Chinese explanations, and provide a one-shot historical backfill that rewrites existing rows without changing sort order.

**Architecture:** Put the pure formula, score bands, and Chinese explanation rows in a shared helper, and put the database-backed history lookup plus chronological batch scoring in a server-only service. Normal single-event ingests score against `events`, snapshot/backfill flows score in ascending timestamp order with a rolling 7-day window, and Telegram monitor gets its own persisted projection columns so monitor-mode feed rows do not lose the score between reads.

**Tech Stack:** Next.js 16 app/router project structure, TypeScript, SQLite via `better-sqlite3`, `tsx` script tests, existing `events`/`activity_feed` repos, existing Telegram monitor persistence

---

## File Map

- `/Users/xp/vibecoding/pilipili/types/index.ts`
  Adds the `ActivityImportance` type and wires `metadata.importance` into every `Activity`.
- `/Users/xp/vibecoding/pilipili/lib/activityImportance.ts`
  Shared pure formula, score band helpers, and Chinese explanation rows for UI display.
- `/Users/xp/vibecoding/pilipili/lib/server/activityImportanceService.ts`
  Server-only history lookup, rolling-window scoring, and helpers that attach importance to `{ user, activity }` rows.
- `/Users/xp/vibecoding/pilipili/lib/server/activityImportanceBackfill.ts`
  Full historical rewrite for `events`, `activity_feed`, `telegram_monitor_tx_states.canonical_activity_json`, and `telegram_monitor_events.projected_activity_json`.
- `/Users/xp/vibecoding/pilipili/lib/server/eventsRepo.ts`
  Central event upsert path; must auto-score rows before writing `metadata_json` and `activity_json`.
- `/Users/xp/vibecoding/pilipili/lib/server/feedSnapshotRepo.ts`
  Chain snapshot mirror path; must batch-score rows before writing `activity_feed`.
- `/Users/xp/vibecoding/pilipili/lib/server/twitterFeedMapper.ts`
  Twitter projector path; must score rows before writing `activity_feed`.
- `/Users/xp/vibecoding/pilipili/lib/server/sqlite.ts`
  Schema migration for `telegram_monitor_events.projected_activity_json`.
- `/Users/xp/vibecoding/pilipili/lib/server/telegramMonitorRepo.ts`
  Stores and reads fallback projected monitor activities.
- `/Users/xp/vibecoding/pilipili/lib/server/telegramMonitorTxStateRepo.ts`
  Stores provisional/canonical scored activities for monitor tx states.
- `/Users/xp/vibecoding/pilipili/lib/server/telegramMonitorFeed.ts`
  Must prefer persisted projected/canonical monitor activities over live reprojection.
- `/Users/xp/vibecoding/pilipili/lib/server/telegramMonitorIngest.ts`
  Must persist the scored provisional monitor activity before event upsert.
- `/Users/xp/vibecoding/pilipili/lib/server/telegramMonitorReconciler.ts`
  Must score the reconciled canonical activity before persisting it.
- `/Users/xp/vibecoding/pilipili/lib/activityCardViewModel.ts`
  Builds the badge text, band label, and Chinese hover explanation for the UI.
- `/Users/xp/vibecoding/pilipili/components/ActivityCard.tsx`
  Renders the always-visible `0-100` badge without affecting feed ordering.
- `/Users/xp/vibecoding/pilipili/scripts/test-activity-importance.ts`
  Pure formula and explanation helper coverage.
- `/Users/xp/vibecoding/pilipili/scripts/test-activity-importance-service.ts`
  DB-backed history and rolling-window scoring coverage.
- `/Users/xp/vibecoding/pilipili/scripts/test-activity-importance-ingest.ts`
  Chain snapshot, direct event, Twitter projector, and Telegram channel ingest coverage.
- `/Users/xp/vibecoding/pilipili/scripts/test-activity-importance-backfill.ts`
  Historical rewrite coverage.
- `/Users/xp/vibecoding/pilipili/scripts/test-telegram-monitor-reconciliation.ts`
  Monitor projected/canonical persistence coverage.
- `/Users/xp/vibecoding/pilipili/scripts/test-activity-card-view-model.ts`
  Badge label and Chinese explanation coverage.
- `/Users/xp/vibecoding/pilipili/scripts/test-feed-page-state.ts`
  Confirms sort order stays timestamp-based even when activities carry importance.
- `/Users/xp/vibecoding/pilipili/package.json`
  Adds dedicated test and backfill scripts.

Do not touch the user’s unrelated local edits in `/Users/xp/vibecoding/pilipili/lib/parsing/core.ts` or `/Users/xp/vibecoding/pilipili/scripts/fixtures/parser-fixtures.ts`.

### Task 1: Add shared importance types, formula helpers, and explanation rows

**Files:**
- Create: `/Users/xp/vibecoding/pilipili/lib/activityImportance.ts`
- Modify: `/Users/xp/vibecoding/pilipili/types/index.ts`
- Create: `/Users/xp/vibecoding/pilipili/scripts/test-activity-importance.ts`
- Modify: `/Users/xp/vibecoding/pilipili/package.json`

- [ ] **Step 1: Write the failing test**

Create `/Users/xp/vibecoding/pilipili/scripts/test-activity-importance.ts` with:

```ts
import assert from 'node:assert/strict';

import {
  buildActivityImportanceExplanationRows,
  computeActivityImportance,
  getActivityImportanceLevelLabel,
} from '@/lib/activityImportance';

function approx(actual: number, expected: number, epsilon = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `expected ${actual} ~= ${expected}`);
}

function run() {
  const freshWhale = computeActivityImportance({
    sourceKind: 'social',
    sourceCount7d: 0,
    socialCount7d: 0,
    walletCount7d: 0,
    totalCount7d: 0,
    historicalMaxAssetUsd: 1_000_000,
  });
  assert.equal(freshWhale.score, 96);
  approx(freshWhale.sourceRarity, 1);
  assert.equal(getActivityImportanceLevelLabel(freshWhale.score), '高重要');

  const missingAsset = computeActivityImportance({
    sourceKind: 'wallet',
    sourceCount7d: 0,
    socialCount7d: 0,
    walletCount7d: 0,
    totalCount7d: 0,
    historicalMaxAssetUsd: null,
  });
  assert.equal(missingAsset.score, 56);
  approx(missingAsset.assetWeight, 0.35);
  approx(missingAsset.dataConfidenceFactor, 0.7);

  const noisyActor = computeActivityImportance({
    sourceKind: 'social',
    sourceCount7d: 3,
    socialCount7d: 3,
    walletCount7d: 8,
    totalCount7d: 11,
    historicalMaxAssetUsd: 50_000,
  });
  const explanation = buildActivityImportanceExplanationRows(noisyActor);
  assert.deepEqual(
    explanation.map((row) => row.label),
    ['同源稀缺分', '资产权重', '总频率因子', '数据可信度因子']
  );
  assert.equal(explanation[0]?.description, '这类消息本身最近有多罕见。推文/TG 看社交频率，链上看钱包频率；越少见越高。');
  assert.equal(explanation[1]?.valueText.includes('50,000'), true);
  assert.equal(getActivityImportanceLevelLabel(noisyActor.score), '普通');

  console.log('activity importance formula tests: ok');
}

run();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `tsx scripts/test-activity-importance.ts`
Expected: FAIL with `Cannot find module '@/lib/activityImportance'` or missing exports.

- [ ] **Step 3: Write minimal implementation**

Create `/Users/xp/vibecoding/pilipili/lib/activityImportance.ts` with:

```ts
import type { Activity } from '@/types';

export type ActivityImportanceSourceKind = 'social' | 'wallet';
export type ActivityImportanceLevel = 'normal' | 'important' | 'high';

export interface ActivityImportance {
  version: 1;
  score: number;
  sourceKind: ActivityImportanceSourceKind;
  sourceCount7d: number;
  socialCount7d: number;
  walletCount7d: number;
  totalCount7d: number;
  historicalMaxAssetUsd: number | null;
  sourceRarity: number;
  assetWeight: number;
  totalFrequencyFactor: number;
  dataConfidenceFactor: number;
}

export interface ActivityImportanceInput {
  sourceKind: ActivityImportanceSourceKind;
  sourceCount7d: number;
  socialCount7d: number;
  walletCount7d: number;
  totalCount7d: number;
  historicalMaxAssetUsd: number | null;
}

export interface ActivityImportanceExplanationRow {
  key: 'sourceRarity' | 'assetWeight' | 'totalFrequencyFactor' | 'dataConfidenceFactor';
  label: string;
  valueText: string;
  description: string;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function safeCount(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

export function resolveActivityImportanceSourceKind(activity: Pick<Activity, 'source'>): ActivityImportanceSourceKind {
  return activity.source === 'blockchain' ? 'wallet' : 'social';
}

export function computeActivityImportance(input: ActivityImportanceInput): ActivityImportance {
  const socialCount7d = safeCount(input.socialCount7d);
  const walletCount7d = safeCount(input.walletCount7d);
  const totalCount7d = safeCount(input.totalCount7d);
  const sourceCount7d = safeCount(input.sourceCount7d);
  const hasAsset = typeof input.historicalMaxAssetUsd === 'number' && input.historicalMaxAssetUsd > 0;
  const historicalMaxAssetUsd = hasAsset ? input.historicalMaxAssetUsd : null;

  const sourceRarity = 1 / Math.sqrt(sourceCount7d + 1);
  const assetWeight = hasAsset ? clamp(Math.log10((historicalMaxAssetUsd as number) + 1) / 7, 0, 1) : 0.35;
  const totalFrequencyFactor = clamp(1 - 0.03 * Math.log2(totalCount7d + 1), 0.85, 1);
  const dataConfidenceFactor = hasAsset ? 1 : 0.7;
  const baseScore = 0.7 * sourceRarity + 0.3 * assetWeight;
  const score = Math.round(clamp(baseScore * totalFrequencyFactor * dataConfidenceFactor, 0, 1) * 100);

  return {
    version: 1,
    score,
    sourceKind: input.sourceKind,
    sourceCount7d,
    socialCount7d,
    walletCount7d,
    totalCount7d,
    historicalMaxAssetUsd,
    sourceRarity,
    assetWeight,
    totalFrequencyFactor,
    dataConfidenceFactor,
  };
}

export function getActivityImportanceLevel(score: number): ActivityImportanceLevel {
  if (score >= 70) return 'high';
  if (score >= 40) return 'important';
  return 'normal';
}

export function getActivityImportanceLevelLabel(score: number) {
  const level = getActivityImportanceLevel(score);
  if (level === 'high') return '高重要';
  if (level === 'important') return '重要';
  return '普通';
}

export function buildActivityImportanceExplanationRows(
  importance: ActivityImportance
): ActivityImportanceExplanationRow[] {
  return [
    {
      key: 'sourceRarity',
      label: '同源稀缺分',
      valueText: importance.sourceRarity.toFixed(4),
      description: '这类消息本身最近有多罕见。推文/TG 看社交频率，链上看钱包频率；越少见越高。',
    },
    {
      key: 'assetWeight',
      label: '资产权重',
      valueText:
        importance.historicalMaxAssetUsd === null
          ? '缺失，按 0.35 处理'
          : `${importance.historicalMaxAssetUsd.toLocaleString('en-US')} USD`,
      description: '这个人的历史最高资产有多大；同样低频时，大户分量更重。',
    },
    {
      key: 'totalFrequencyFactor',
      label: '总频率因子',
      valueText: importance.totalFrequencyFactor.toFixed(4),
      description: '这个人最近 7 天整体有多活跃；越活跃，最终分只做轻微下压，不盖过同源稀缺。',
    },
    {
      key: 'dataConfidenceFactor',
      label: '数据可信度因子',
      valueText: importance.dataConfidenceFactor.toFixed(4),
      description: '输入数据是否完整；关键数据缺失时保守降权，避免误判成高重要。',
    },
  ];
}
```

Update `/Users/xp/vibecoding/pilipili/types/index.ts` by adding:

```ts
import type { ActivityImportance } from '@/lib/activityImportance';
```

and inside `Activity['metadata']`:

```ts
    importance?: ActivityImportance;
```

Update `/Users/xp/vibecoding/pilipili/package.json` scripts:

```json
{
  "scripts": {
    "test:activity-importance": "tsx scripts/test-activity-importance.ts"
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `tsx scripts/test-activity-importance.ts`
Expected: PASS with `activity importance formula tests: ok`.

- [ ] **Step 5: Commit**

```bash
git add lib/activityImportance.ts types/index.ts scripts/test-activity-importance.ts package.json
git commit -m "feat: add shared activity importance helpers"
```

### Task 2: Add DB-backed and chronological importance scoring service

**Files:**
- Create: `/Users/xp/vibecoding/pilipili/lib/server/activityImportanceService.ts`
- Create: `/Users/xp/vibecoding/pilipili/scripts/test-activity-importance-service.ts`
- Modify: `/Users/xp/vibecoding/pilipili/package.json`

- [ ] **Step 1: Write the failing test**

Create `/Users/xp/vibecoding/pilipili/scripts/test-activity-importance-service.ts` with:

```ts
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Activity, User } from '@/types';

import './server-only-shim.cjs';

function makeUser(id: string, historicalMaxAssetUsd: number): User {
  return {
    id,
    name: id,
    handle: id,
    avatar: '',
    addresses: [{ address: `${id}-wallet`, name: '#1', chain: 'solana', totalAssetUsd: null, assetUpdatedAt: null }],
    totalAssetUsd: historicalMaxAssetUsd,
    historicalMaxAssetUsd,
    assetUpdatedAt: null,
    tags: [],
  };
}

function makeActivity(id: string, userId: string, timestamp: number, source: Activity['source']): Activity {
  return {
    id,
    userId,
    source,
    type: source === 'blockchain' ? 'transfer' : 'post',
    title: id,
    content: id,
    timestamp,
    metadata:
      source === 'blockchain'
        ? {
            txHash: `${id}-tx`,
            chain: 'solana',
            trackedAddress: `${userId}-wallet`,
            txAction: 'buy',
            token: 'TEST',
            value: '1',
          }
        : {
            tweetId: `${id}-tweet`,
          },
  };
}

async function run() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pilipili-importance-service-'));
  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');

  try {
    const { upsertEventsFromFeedRows } = await import('@/lib/server/eventsRepo');
    const {
      scoreFeedRowsAgainstDatabase,
      scoreFeedRowsChronologically,
    } = await import('@/lib/server/activityImportanceService');

    const quiet = makeUser('quiet', 100_000);
    const noisy = makeUser('noisy', 100_000);
    const base = 1_700_000_000_000;

    upsertEventsFromFeedRows([{ user: quiet, activity: makeActivity('quiet-social-old', quiet.id, base - 6 * 24 * 60 * 60 * 1000, 'twitter') }], 'seed');
    upsertEventsFromFeedRows([{ user: noisy, activity: makeActivity('noisy-social-old', noisy.id, base - 6 * 24 * 60 * 60 * 1000, 'twitter') }], 'seed');
    upsertEventsFromFeedRows([{ user: noisy, activity: makeActivity('noisy-chain-1', noisy.id, base - 10_000, 'blockchain') }], 'seed');
    upsertEventsFromFeedRows([{ user: noisy, activity: makeActivity('noisy-chain-2', noisy.id, base - 9_000, 'blockchain') }], 'seed');
    upsertEventsFromFeedRows([{ user: noisy, activity: makeActivity('noisy-chain-3', noisy.id, base - 8_000, 'blockchain') }], 'seed');

    const [quietTweet] = scoreFeedRowsAgainstDatabase([
      { user: quiet, activity: makeActivity('quiet-new-social', quiet.id, base, 'twitter') },
    ]);
    const [noisyTweet] = scoreFeedRowsAgainstDatabase([
      { user: noisy, activity: makeActivity('noisy-new-social', noisy.id, base, 'twitter') },
    ]);

    assert.ok(quietTweet.activity.metadata.importance, 'quiet tweet should receive importance');
    assert.ok(noisyTweet.activity.metadata.importance, 'noisy tweet should receive importance');
    assert.equal(quietTweet.activity.metadata.importance?.socialCount7d, 1);
    assert.equal(noisyTweet.activity.metadata.importance?.socialCount7d, 1);
    assert.equal(noisyTweet.activity.metadata.importance?.walletCount7d, 3);
    assert.ok(
      (quietTweet.activity.metadata.importance?.score || 0) > (noisyTweet.activity.metadata.importance?.score || 0),
      'same social frequency but higher wallet activity should reduce the social score'
    );

    const chronological = scoreFeedRowsChronologically([
      { user: quiet, activity: makeActivity('batch-1', quiet.id, base + 1_000, 'twitter'), stableId: 'batch-1' },
      { user: quiet, activity: makeActivity('batch-2', quiet.id, base + 2_000, 'twitter'), stableId: 'batch-2' },
      { user: quiet, activity: makeActivity('batch-3', quiet.id, base + 3_000, 'blockchain'), stableId: 'batch-3' },
    ]);
    assert.equal(chronological[0]?.activity.metadata.importance?.sourceCount7d, 0);
    assert.equal(chronological[1]?.activity.metadata.importance?.sourceCount7d, 1);
    assert.equal(chronological[2]?.activity.metadata.importance?.walletCount7d, 0);

    console.log('activity importance service tests: ok');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

void run();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-activity-importance-service.ts`
Expected: FAIL with `Cannot find module '@/lib/server/activityImportanceService'`.

- [ ] **Step 3: Write minimal implementation**

Create `/Users/xp/vibecoding/pilipili/lib/server/activityImportanceService.ts` with:

```ts
import 'server-only';

import {
  computeActivityImportance,
  resolveActivityImportanceSourceKind,
  type ActivityImportance,
} from '@/lib/activityImportance';
import { getDb } from '@/lib/server/sqlite';
import type { Activity, User } from '@/types';

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface FeedImportanceRow {
  user: User;
  activity: Activity;
  stableId?: string;
}

function normalizeSource(source: Activity['source']) {
  return source === 'blockchain' ? 'wallet' : 'social';
}

function withImportance(activity: Activity, importance: ActivityImportance): Activity {
  return {
    ...activity,
    metadata: {
      ...activity.metadata,
      importance,
    },
  };
}

function countHistoryRows(rows: FeedImportanceRow[], row: FeedImportanceRow) {
  const windowStart = row.activity.timestamp - WINDOW_MS;
  let socialCount7d = 0;
  let walletCount7d = 0;

  for (const candidate of rows) {
    if (candidate.user.id !== row.user.id) continue;
    if (candidate.activity.timestamp < windowStart) continue;
    if (candidate.activity.timestamp >= row.activity.timestamp) continue;
    if (normalizeSource(candidate.activity.source) === 'social') socialCount7d += 1;
    if (normalizeSource(candidate.activity.source) === 'wallet') walletCount7d += 1;
  }

  return { socialCount7d, walletCount7d };
}

function scoreOne(row: FeedImportanceRow, socialCount7d: number, walletCount7d: number): FeedImportanceRow {
  const sourceKind = resolveActivityImportanceSourceKind(row.activity);
  const sourceCount7d = sourceKind === 'social' ? socialCount7d : walletCount7d;
  const importance = computeActivityImportance({
    sourceKind,
    sourceCount7d,
    socialCount7d,
    walletCount7d,
    totalCount7d: socialCount7d + walletCount7d,
    historicalMaxAssetUsd:
      typeof row.user.historicalMaxAssetUsd === 'number' && row.user.historicalMaxAssetUsd > 0
        ? row.user.historicalMaxAssetUsd
        : null,
  });

  return {
    ...row,
    activity: withImportance(row.activity, importance),
  };
}

export function scoreFeedRowsChronologically(rows: FeedImportanceRow[]) {
  const ordered = [...rows].sort((left, right) => {
    const timeDelta = left.activity.timestamp - right.activity.timestamp;
    if (timeDelta !== 0) return timeDelta;
    return (left.stableId || left.activity.id).localeCompare(right.stableId || right.activity.id);
  });

  const scored: FeedImportanceRow[] = [];
  for (const row of ordered) {
    const counts = countHistoryRows(scored, row);
    scored.push(scoreOne(row, counts.socialCount7d, counts.walletCount7d));
  }
  return scored;
}

export function scoreFeedRowsAgainstDatabase(rows: FeedImportanceRow[]) {
  const db = getDb();
  const socialCountStmt = db.prepare(
    `SELECT COUNT(1) AS count
     FROM events
     WHERE user_id = ?
       AND timestamp >= ?
       AND timestamp < ?
       AND source IN ('twitter', 'telegram')`
  );
  const walletCountStmt = db.prepare(
    `SELECT COUNT(1) AS count
     FROM events
     WHERE user_id = ?
       AND timestamp >= ?
       AND timestamp < ?
       AND source = 'blockchain'`
  );

  const ordered = [...rows].sort((left, right) => {
    const timeDelta = left.activity.timestamp - right.activity.timestamp;
    if (timeDelta !== 0) return timeDelta;
    return (left.stableId || left.activity.id).localeCompare(right.stableId || right.activity.id);
  });

  const priorScoredBatch: FeedImportanceRow[] = [];
  return ordered.map((row) => {
    const windowStart = row.activity.timestamp - WINDOW_MS;
    const databaseSocialCount = (
      socialCountStmt.get(row.user.id, windowStart, row.activity.timestamp) as { count: number }
    ).count;
    const databaseWalletCount = (
      walletCountStmt.get(row.user.id, windowStart, row.activity.timestamp) as { count: number }
    ).count;
    const batchCounts = countHistoryRows(priorScoredBatch, row);

    const scored = scoreOne(
      row,
      databaseSocialCount + batchCounts.socialCount7d,
      databaseWalletCount + batchCounts.walletCount7d
    );
    priorScoredBatch.push(scored);
    return scored;
  });
}
```

Update `/Users/xp/vibecoding/pilipili/package.json` scripts:

```json
{
  "scripts": {
    "test:activity-importance-service": "NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-activity-importance-service.ts"
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-activity-importance-service.ts`
Expected: PASS with `activity importance service tests: ok`.

- [ ] **Step 5: Commit**

```bash
git add lib/server/activityImportanceService.ts scripts/test-activity-importance-service.ts package.json
git commit -m "feat: add activity importance scoring service"
```

### Task 3: Score normal feed writes before they hit `events` and `activity_feed`

**Files:**
- Modify: `/Users/xp/vibecoding/pilipili/lib/server/eventsRepo.ts`
- Modify: `/Users/xp/vibecoding/pilipili/lib/server/feedSnapshotRepo.ts`
- Modify: `/Users/xp/vibecoding/pilipili/lib/server/twitterFeedMapper.ts`
- Create: `/Users/xp/vibecoding/pilipili/scripts/test-activity-importance-ingest.ts`
- Modify: `/Users/xp/vibecoding/pilipili/package.json`

- [ ] **Step 1: Write the failing test**

Create `/Users/xp/vibecoding/pilipili/scripts/test-activity-importance-ingest.ts` with:

```ts
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Activity, User } from '@/types';

import './server-only-shim.cjs';

function makeUser(id: string): User {
  return {
    id,
    name: id,
    handle: id,
    avatar: '',
    twitter: id,
    addresses: [{ address: `${id}-wallet`, name: '#1', chain: 'solana', totalAssetUsd: null, assetUpdatedAt: null }],
    totalAssetUsd: 250_000,
    historicalMaxAssetUsd: 250_000,
    assetUpdatedAt: null,
    tags: [],
  };
}

function makeChainActivity(id: string, userId: string, timestamp: number): Activity {
  return {
    id,
    userId,
    source: 'blockchain',
    type: 'transfer',
    title: id,
    content: id,
    timestamp,
    metadata: {
      txHash: `${id}-tx`,
      chain: 'solana',
      trackedAddress: `${userId}-wallet`,
      txAction: 'buy',
      token: 'TEST',
      value: '1',
    },
  };
}

async function run() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pilipili-importance-ingest-'));
  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');

  try {
    const { upsertEventsFromFeedRows, readEventsFeed } = await import('@/lib/server/eventsRepo');
    const { upsertFeedSnapshot } = await import('@/lib/server/feedSnapshotRepo');
    const { projectTwitterTweetsToFeed } = await import('@/lib/server/twitterFeedMapper');
    const { createTrackedUser } = await import('@/lib/server/trackedUsersRepo');
    const { ingestTelegramChannelPost } = await import('@/lib/server/telegramChannelIngest');
    const { upsertTelegramChannelSource } = await import('@/lib/server/telegramChannelSourceRepo');
    const { upsertTelegramChannelPost } = await import('@/lib/server/telegramChannelPostRepo');
    const { upsertTwitterTweets } = await import('@/lib/server/twitterRepo');
    const { getDb } = await import('@/lib/server/sqlite');

    const user = createTrackedUser(makeUser('alpha'));
    const timestamp = 1_710_000_000_000;

    upsertEventsFromFeedRows([{ user, activity: makeChainActivity('direct-chain', user.id, timestamp) }], 'test-direct');
    const directEvents = readEventsFeed({ limit: 10, userId: user.id });
    assert.ok(directEvents.feed[0]?.activity.metadata.importance?.score !== undefined);

    upsertFeedSnapshot([{ user, activity: makeChainActivity('snapshot-chain', user.id, timestamp + 1_000) }]);
    const db = getDb();
    const snapshotRow = db.prepare('SELECT activity_json FROM activity_feed WHERE user_id = ? ORDER BY timestamp DESC LIMIT 1').get(user.id) as { activity_json: string };
    assert.ok(JSON.parse(snapshotRow.activity_json).metadata.importance.score !== undefined);

    upsertTwitterTweets([
      {
        tweetId: 'tweet-1',
        authorHandle: user.twitter || 'alpha',
        authorName: user.name,
        fullText: 'alpha says hello',
        createdAtMs: timestamp + 2_000,
        lane: 'timeline',
      },
    ]);
    const projected = projectTwitterTweetsToFeed({ sinceMs: timestamp });
    assert.equal(projected.projectedCount, 1);
    const twitterFeedRow = db.prepare("SELECT activity_json FROM activity_feed WHERE activity_key = 'twitter:tweet-1'").get() as { activity_json: string };
    assert.ok(JSON.parse(twitterFeedRow.activity_json).metadata.importance.score !== undefined);

    const source = upsertTelegramChannelSource({
      userId: user.id,
      channelRef: '@alpha',
    });
    const post = upsertTelegramChannelPost({
      channelChatId: '-100321',
      channelUsername: 'alpha',
      channelTitle: 'Alpha',
      messageId: 1,
      groupedId: null,
      postedAtMs: timestamp + 3_000,
      editDateMs: null,
      text: 'telegram hello',
      textEntities: [],
      media: [],
      linkUrls: [],
      forwardInfo: null,
      views: 0,
      forwards: 0,
      replies: 0,
      raw: { id: 1 },
    });
    const ingestResult = await ingestTelegramChannelPost({
      source,
      post,
      fetchTweetsByIds: async () => ({ provider: 'fixture', tweets: [] }),
    });
    const telegramEvent = readEventsFeed({ limit: 10, userId: user.id, source: 'telegram' });
    assert.ok(ingestResult.projected.activity.metadata.importance?.score !== undefined);
    assert.ok(telegramEvent.feed[0]?.activity.metadata.importance?.score !== undefined);

    console.log('activity importance ingest tests: ok');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

void run();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-activity-importance-ingest.ts`
Expected: FAIL because event/feed/projector writes do not populate `metadata.importance`.

- [ ] **Step 3: Write minimal implementation**

In `/Users/xp/vibecoding/pilipili/lib/server/eventsRepo.ts`, score rows before the transaction:

```ts
import { scoreFeedRowsAgainstDatabase } from '@/lib/server/activityImportanceService';

export function upsertEventsFromFeedRows(rows: Array<{ user: User; activity: Activity }>, ingestSource: string) {
  if (rows.length === 0) return;

  const scoredRows = scoreFeedRowsAgainstDatabase(rows);

  withTransaction(() => {
    // keep the existing SQL/merge logic, but iterate `scoredRows` instead of `rows`
  });
}
```

Keep `mergeActivityForUpsert()` favoring the incoming `importance` by leaving this merge order intact:

```ts
  const mergedMetadata: Activity['metadata'] = {
    ...existing.metadata,
    ...incoming.metadata,
  };
```

In `/Users/xp/vibecoding/pilipili/lib/server/feedSnapshotRepo.ts`, score selected rows before any `activity_feed` write:

```ts
import { scoreFeedRowsChronologically } from '@/lib/server/activityImportanceService';

const scoredRows = scoreFeedRowsChronologically(
  dedupedFeed.map(({ item, index }) => ({
    user: item.user,
    activity: item.activity,
    stableId: buildActivityKey(item, index),
  }))
);
```

Use `scoredRows` for both the local `activity_feed` insert and the later `upsertEventsFromFeedRows(scoredRows, 'feed-snapshot-upsert')`.

In `/Users/xp/vibecoding/pilipili/lib/server/twitterFeedMapper.ts`, score before writing `activity_feed`:

```ts
import { scoreFeedRowsAgainstDatabase } from '@/lib/server/activityImportanceService';

const scoredRows = scoreFeedRowsAgainstDatabase(upsertRows);
const projectedCount = upsertFeedRows(scoredRows);
upsertEventsFromFeedRows(scoredRows, 'twitter-projector');
```

Update `/Users/xp/vibecoding/pilipili/package.json` scripts:

```json
{
  "scripts": {
    "test:activity-importance-ingest": "NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-activity-importance-ingest.ts"
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-activity-importance-ingest.ts`
Expected: PASS with `activity importance ingest tests: ok`.

- [ ] **Step 5: Commit**

```bash
git add lib/server/eventsRepo.ts lib/server/feedSnapshotRepo.ts lib/server/twitterFeedMapper.ts scripts/test-activity-importance-ingest.ts package.json
git commit -m "feat: score normal feed rows at ingest time"
```

### Task 4: Persist scored Telegram monitor activities for both tx-state and fallback paths

**Files:**
- Modify: `/Users/xp/vibecoding/pilipili/lib/server/sqlite.ts`
- Modify: `/Users/xp/vibecoding/pilipili/lib/server/telegramMonitorRepo.ts`
- Modify: `/Users/xp/vibecoding/pilipili/lib/server/telegramMonitorTxStateRepo.ts`
- Modify: `/Users/xp/vibecoding/pilipili/lib/server/telegramMonitorFeed.ts`
- Modify: `/Users/xp/vibecoding/pilipili/lib/server/telegramMonitorIngest.ts`
- Modify: `/Users/xp/vibecoding/pilipili/lib/server/telegramMonitorReconciler.ts`
- Modify: `/Users/xp/vibecoding/pilipili/scripts/test-telegram-monitor-reconciliation.ts`

- [ ] **Step 1: Write the failing test**

Extend `/Users/xp/vibecoding/pilipili/scripts/test-telegram-monitor-reconciliation.ts` with these assertions:

```ts
const txStateAfterIngest = getTelegramMonitorTxState({
  chain: 'solana',
  trackedWalletAddress: TRACKED_SOL_ADDRESS,
  txHash: TX_HASH,
});
assert.ok(txStateAfterIngest?.canonicalActivity?.metadata.importance?.score !== undefined);

const fallbackRows = getDb()
  .prepare(
    `SELECT projected_activity_json
     FROM telegram_monitor_events
     WHERE tx_hash = ?`
  )
  .all(legacyOnlyTxHash) as Array<{ projected_activity_json: string | null }>;
assert.ok(fallbackRows[0]?.projected_activity_json, 'fallback monitor row should persist projected activity json');

const reparsedFallback = await readTelegramMonitorFeed(20);
const fallbackActivity = reparsedFallback.find((item) => item.activity.metadata.txHash === legacyOnlyTxHash);
assert.ok(fallbackActivity?.activity.metadata.importance?.score !== undefined);

const reconciledState = getTelegramMonitorTxState({
  chain: 'solana',
  trackedWalletAddress: TRACKED_SOL_ADDRESS,
  txHash: TX_HASH,
});
assert.ok(reconciledState?.canonicalActivity?.metadata.importance?.score !== undefined);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-telegram-monitor-reconciliation.ts`
Expected: FAIL because `canonical_activity_json` is empty for provisional rows and `telegram_monitor_events` has no `projected_activity_json`.

- [ ] **Step 3: Write minimal implementation**

In `/Users/xp/vibecoding/pilipili/lib/server/sqlite.ts`, add the new column to the create-table definition and migration:

```ts
  projected_activity_json TEXT,
```

and:

```ts
ensureColumn(db, 'telegram_monitor_events', 'projected_activity_json', 'TEXT');
```

In `/Users/xp/vibecoding/pilipili/lib/server/telegramMonitorTxStateRepo.ts`, add a helper that stores a scored provisional activity without changing reconciliation status:

```ts
export function setTelegramMonitorTxStateCanonicalActivity(input: {
  chain: string;
  trackedWalletAddress: string;
  txHash: string;
  activity: Activity;
}) {
  const db = getDb();
  db.prepare(
    `UPDATE telegram_monitor_tx_states
     SET canonical_activity_json = ?,
         updated_at = ?
     WHERE chain = ?
       AND tracked_wallet_address_lower = ?
       AND tx_hash_lower = ?`
  ).run(
    JSON.stringify(input.activity),
    Date.now(),
    normalize(input.chain),
    normalize(input.trackedWalletAddress),
    normalize(input.txHash)
  );
}
```

In `/Users/xp/vibecoding/pilipili/lib/server/telegramMonitorRepo.ts`, add parsing and an updater for fallback events:

```ts
interface TelegramFeedRow {
  projected_activity_json: string | null;
}

export interface TelegramMonitorFeedEvent {
  projectedActivity?: Activity | null;
}

function mapTelegramFeedRow(row: TelegramFeedRow): TelegramMonitorFeedEvent {
  return {
    // keep existing fields,
    projectedActivity: parseJson<Activity | null>(row.projected_activity_json, null),
  };
}

export function updateTelegramMonitorEventProjectedActivity(input: {
  sourceChatId: string | null;
  sourceMessageId: number | null;
  txHash: string | null;
  activity: Activity;
}) {
  const db = getDb();
  db.prepare(
    `UPDATE telegram_monitor_events
     SET projected_activity_json = ?,
         updated_at = ?
     WHERE provider = 'xxyy'
       AND source_chat_id IS ?
       AND source_message_id IS ?
       AND tx_hash IS ?`
  ).run(
    JSON.stringify(input.activity),
    Date.now(),
    input.sourceChatId,
    input.sourceMessageId,
    input.txHash
  );
}
```

In `/Users/xp/vibecoding/pilipili/lib/server/telegramMonitorFeed.ts`, prefer the persisted JSON before reprojection:

```ts
if (event.projectedActivity) {
  const persistedUser = users.find((candidate) => candidate.id === event.projectedActivity?.userId) || null;
  if (persistedUser) {
    return {
      user: persistedUser,
      activity: event.projectedActivity,
    };
  }
}
```

In `/Users/xp/vibecoding/pilipili/lib/server/telegramMonitorIngest.ts`, persist the scored row before `upsertEventsFromFeedRows`:

```ts
import { scoreFeedRowsAgainstDatabase } from '@/lib/server/activityImportanceService';
import { updateTelegramMonitorEventProjectedActivity } from '@/lib/server/telegramMonitorRepo';
import { setTelegramMonitorTxStateCanonicalActivity } from '@/lib/server/telegramMonitorTxStateRepo';

const scoredProjected = projected
  ? scoreFeedRowsAgainstDatabase([projected])[0] || null
  : null;

if (scoredProjected && txState) {
  setTelegramMonitorTxStateCanonicalActivity({
    chain: txState.chain,
    trackedWalletAddress: txState.trackedWalletAddress,
    txHash: txState.txHash,
    activity: scoredProjected.activity,
  });
}

if (scoredProjected && !txState) {
  updateTelegramMonitorEventProjectedActivity({
    sourceChatId,
    sourceMessageId,
    txHash: parsed.txHash,
    activity: scoredProjected.activity,
  });
}

if (scoredProjected) {
  upsertEventsFromFeedRows([scoredProjected], 'telegram-monitor-ingest');
}
```

In `/Users/xp/vibecoding/pilipili/lib/server/telegramMonitorReconciler.ts`, score the canonical activity before persisting it:

```ts
import { scoreFeedRowsAgainstDatabase } from '@/lib/server/activityImportanceService';

const [scoredCanonical] = scoreFeedRowsAgainstDatabase([{ user: trackedUser.user, activity }]);
markTelegramMonitorTxStateReconciled({
  chain: state.chain,
  trackedWalletAddress: state.trackedWalletAddress,
  txHash: state.txHash,
  activity: scoredCanonical.activity,
  source: 'okx-address',
});
upsertEventsFromFeedRows([scoredCanonical], 'telegram-monitor-reconcile');
```

- [ ] **Step 4: Run test to verify it passes**

Run: `NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-telegram-monitor-reconciliation.ts`
Expected: PASS and the temporary DB contains `canonical_activity_json` plus `projected_activity_json` rows with `metadata.importance.score`.

- [ ] **Step 5: Commit**

```bash
git add lib/server/sqlite.ts lib/server/telegramMonitorRepo.ts lib/server/telegramMonitorTxStateRepo.ts lib/server/telegramMonitorFeed.ts lib/server/telegramMonitorIngest.ts lib/server/telegramMonitorReconciler.ts scripts/test-telegram-monitor-reconciliation.ts
git commit -m "feat: persist scored telegram monitor projections"
```

### Task 5: Add full historical importance backfill for existing rows

**Files:**
- Create: `/Users/xp/vibecoding/pilipili/lib/server/activityImportanceBackfill.ts`
- Create: `/Users/xp/vibecoding/pilipili/scripts/backfill-importance-score.ts`
- Create: `/Users/xp/vibecoding/pilipili/scripts/test-activity-importance-backfill.ts`
- Modify: `/Users/xp/vibecoding/pilipili/package.json`

- [ ] **Step 1: Write the failing test**

Create `/Users/xp/vibecoding/pilipili/scripts/test-activity-importance-backfill.ts` with:

```ts
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Activity, User } from '@/types';

import './server-only-shim.cjs';

function makeUser(): User {
  return {
    id: 'backfill-user',
    name: 'backfill-user',
    handle: 'backfill-user',
    avatar: '',
    addresses: [{ address: 'backfill-wallet', name: '#1', chain: 'solana', totalAssetUsd: null, assetUpdatedAt: null }],
    totalAssetUsd: 120_000,
    historicalMaxAssetUsd: 120_000,
    assetUpdatedAt: null,
    tags: [],
  };
}

function makeActivity(id: string, timestamp: number, source: Activity['source']): Activity {
  return {
    id,
    userId: 'backfill-user',
    source,
    type: source === 'blockchain' ? 'transfer' : 'post',
    title: id,
    content: id,
    timestamp,
    metadata:
      source === 'blockchain'
        ? { txHash: `${id}-tx`, chain: 'solana', trackedAddress: 'backfill-wallet', txAction: 'buy', token: 'AAA', value: '1' }
        : { tweetId: `${id}-tweet` },
  };
}

async function run() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pilipili-importance-backfill-'));
  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');

  try {
    const { getDb } = await import('@/lib/server/sqlite');
    const { backfillActivityImportance } = await import('@/lib/server/activityImportanceBackfill');

    const db = getDb();
    const user = makeUser();
    const older = makeActivity('older-social', 1_700_000_000_000, 'twitter');
    const newer = makeActivity('newer-chain', 1_700_000_100_000, 'blockchain');

    db.prepare(
      `INSERT INTO events (
        event_id, source, kind, timestamp, user_id, user_name, chain, address, content, url, action, token, tweet_id, tx_hash, ingest_source, dedup_key, metadata_json, payload_json, user_json, activity_json, indexed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'twitter:older-social-tweet',
      older.source,
      older.type,
      older.timestamp,
      user.id,
      user.name,
      null,
      null,
      older.content,
      null,
      null,
      null,
      older.metadata.tweetId,
      null,
      'seed',
      'twitter:older-social-tweet',
      JSON.stringify(older.metadata),
      JSON.stringify({}),
      JSON.stringify(user),
      JSON.stringify(older),
      Date.now(),
      Date.now(),
      Date.now()
    );

    db.prepare(
      `INSERT INTO activity_feed (
        user_id, activity_key, timestamp, tx_hash_lower, chain, tracked_address_lower, source, type, user_json, activity_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      user.id,
      'newer-chain',
      newer.timestamp,
      'newer-chain-tx',
      'solana',
      'backfill-wallet',
      newer.source,
      newer.type,
      JSON.stringify(user),
      JSON.stringify(newer),
      Date.now()
    );

    db.prepare(
      `INSERT INTO telegram_monitor_tx_states (
        user_id, chain, tracked_wallet_address, tracked_wallet_address_lower, tx_hash, tx_hash_lower, event_time_ms, canonical_activity_json, reconciliation_status, first_seen_at, last_seen_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
    ).run(
      user.id,
      'solana',
      'backfill-wallet',
      'backfill-wallet',
      'monitor-tx',
      'monitor-tx',
      newer.timestamp,
      JSON.stringify(newer),
      Date.now(),
      Date.now(),
      Date.now()
    );

    db.prepare(
      `INSERT INTO telegram_monitor_events (
        provider, source_chat_id, source_message_id, chain, token_address, token_address_lower, tx_hash, tx_hash_lower, event_time_ms, raw_text, message_links_json, payload_json, projected_activity_json, created_at, updated_at
      ) VALUES ('xxyy', '-1001', 1, 'solana', 'token-1', 'token-1', 'fallback-tx', 'fallback-tx', ?, '', '[]', '{}', ?, ?, ?)`
    ).run(
      newer.timestamp,
      JSON.stringify(older),
      Date.now(),
      Date.now()
    );

    await backfillActivityImportance();

    const eventJson = db.prepare("SELECT activity_json FROM events WHERE event_id = 'twitter:older-social-tweet'").get() as { activity_json: string };
    const feedJson = db.prepare("SELECT activity_json FROM activity_feed WHERE activity_key = 'newer-chain'").get() as { activity_json: string };
    const txStateJson = db.prepare("SELECT canonical_activity_json FROM telegram_monitor_tx_states WHERE tx_hash = 'monitor-tx'").get() as { canonical_activity_json: string };
    const fallbackJson = db.prepare("SELECT projected_activity_json FROM telegram_monitor_events WHERE tx_hash = 'fallback-tx'").get() as { projected_activity_json: string };

    assert.ok(JSON.parse(eventJson.activity_json).metadata.importance.score !== undefined);
    assert.ok(JSON.parse(feedJson.activity_json).metadata.importance.score !== undefined);
    assert.ok(JSON.parse(txStateJson.canonical_activity_json).metadata.importance.score !== undefined);
    assert.ok(JSON.parse(fallbackJson.projected_activity_json).metadata.importance.score !== undefined);

    console.log('activity importance backfill tests: ok');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

void run();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-activity-importance-backfill.ts`
Expected: FAIL because the backfill module does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `/Users/xp/vibecoding/pilipili/lib/server/activityImportanceBackfill.ts` with:

```ts
import 'server-only';

import { getDb, withTransaction } from '@/lib/server/sqlite';
import { scoreFeedRowsAgainstDatabase, scoreFeedRowsChronologically, type FeedImportanceRow } from '@/lib/server/activityImportanceService';
import { listTrackedUsers } from '@/lib/server/trackedUsersRepo';
import type { Activity, User } from '@/types';

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function currentUsersById() {
  return new Map(listTrackedUsers().map((user) => [user.id, user] as const));
}

function parseUserFallback(userJson: string, activity: Activity, usersById: Map<string, User>) {
  const parsedUser = parseJson<User>(userJson);
  return usersById.get(activity.userId) || usersById.get(parsedUser.id) || parsedUser;
}

export async function backfillActivityImportance() {
  const db = getDb();
  const usersById = currentUsersById();

  const eventRows = db.prepare('SELECT event_id, user_json, activity_json, timestamp FROM events ORDER BY timestamp ASC, event_id ASC').all() as Array<{
    event_id: string;
    user_json: string;
    activity_json: string;
    timestamp: number;
  }>;
  const scoredEvents = scoreFeedRowsChronologically(
    eventRows.map((row) => {
      const activity = parseJson<Activity>(row.activity_json);
      return {
        user: parseUserFallback(row.user_json, activity, usersById),
        activity,
        stableId: row.event_id,
      } satisfies FeedImportanceRow;
    })
  );

  withTransaction(() => {
    const updateEventStmt = db.prepare(
      `UPDATE events
       SET metadata_json = ?,
           activity_json = ?,
           updated_at = ?
       WHERE event_id = ?`
    );

    scoredEvents.forEach((row, index) => {
      updateEventStmt.run(
        JSON.stringify(row.activity.metadata),
        JSON.stringify(row.activity),
        Date.now() + index,
        eventRows[index]!.event_id
      );
    });
  });

  const feedRows = db.prepare('SELECT id, user_json, activity_json, timestamp FROM activity_feed ORDER BY timestamp ASC, id ASC').all() as Array<{
    id: number;
    user_json: string;
    activity_json: string;
    timestamp: number;
  }>;
  const scoredFeedRows = scoreFeedRowsChronologically(
    feedRows.map((row) => {
      const activity = parseJson<Activity>(row.activity_json);
      return {
        user: parseUserFallback(row.user_json, activity, usersById),
        activity,
        stableId: String(row.id),
      } satisfies FeedImportanceRow;
    })
  );

  withTransaction(() => {
    const updateFeedStmt = db.prepare(
      `UPDATE activity_feed
       SET activity_json = ?
       WHERE id = ?`
    );
    scoredFeedRows.forEach((row, index) => {
      updateFeedStmt.run(JSON.stringify(row.activity), feedRows[index]!.id);
    });
  });

  const txStateRows = db.prepare(
    `SELECT id, user_id, canonical_activity_json
     FROM telegram_monitor_tx_states
     WHERE canonical_activity_json IS NOT NULL
     ORDER BY COALESCE(event_time_ms, updated_at) ASC, id ASC`
  ).all() as Array<{ id: number; user_id: string; canonical_activity_json: string }>;

  withTransaction(() => {
    const updateTxStateStmt = db.prepare(
      `UPDATE telegram_monitor_tx_states
       SET canonical_activity_json = ?,
           updated_at = ?
       WHERE id = ?`
    );

    txStateRows.forEach((row, index) => {
      const activity = parseJson<Activity>(row.canonical_activity_json);
      const user = usersById.get(row.user_id);
      if (!user) return;
      const scored = scoreFeedRowsAgainstDatabase([{ user, activity }])[0];
      if (!scored) return;
      updateTxStateStmt.run(JSON.stringify(scored.activity), Date.now() + index, row.id);
    });
  });

  const fallbackRows = db.prepare(
    `SELECT id, projected_activity_json
     FROM telegram_monitor_events
     WHERE projected_activity_json IS NOT NULL
     ORDER BY COALESCE(event_time_ms, updated_at) ASC, id ASC`
  ).all() as Array<{ id: number; projected_activity_json: string }>;

  withTransaction(() => {
    const updateFallbackStmt = db.prepare(
      `UPDATE telegram_monitor_events
       SET projected_activity_json = ?,
           updated_at = ?
       WHERE id = ?`
    );

    fallbackRows.forEach((row, index) => {
      const activity = parseJson<Activity>(row.projected_activity_json);
      const user = usersById.get(activity.userId);
      if (!user) return;
      const scored = scoreFeedRowsAgainstDatabase([{ user, activity }])[0];
      if (!scored) return;
      updateFallbackStmt.run(JSON.stringify(scored.activity), Date.now() + index, row.id);
    });
  });
}
```

Create `/Users/xp/vibecoding/pilipili/scripts/backfill-importance-score.ts` with:

```ts
import './server-only-shim.cjs';

async function run() {
  const { backfillActivityImportance } = await import('@/lib/server/activityImportanceBackfill');
  await backfillActivityImportance();
  console.log('activity importance backfill: ok');
}

void run();
```

Update `/Users/xp/vibecoding/pilipili/package.json` scripts:

```json
{
  "scripts": {
    "importance:backfill": "NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/backfill-importance-score.ts",
    "test:activity-importance-backfill": "NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-activity-importance-backfill.ts"
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-activity-importance-backfill.ts`
Expected: PASS with `activity importance backfill tests: ok`.

- [ ] **Step 5: Commit**

```bash
git add lib/server/activityImportanceBackfill.ts scripts/backfill-importance-score.ts scripts/test-activity-importance-backfill.ts package.json
git commit -m "feat: add activity importance backfill job"
```

### Task 6: Show the persisted score in the activity card without changing sort order

**Files:**
- Modify: `/Users/xp/vibecoding/pilipili/lib/activityCardViewModel.ts`
- Modify: `/Users/xp/vibecoding/pilipili/components/ActivityCard.tsx`
- Modify: `/Users/xp/vibecoding/pilipili/scripts/test-activity-card-view-model.ts`
- Modify: `/Users/xp/vibecoding/pilipili/scripts/test-feed-page-state.ts`
- Modify: `/Users/xp/vibecoding/pilipili/package.json`

- [ ] **Step 1: Write the failing test**

Extend `/Users/xp/vibecoding/pilipili/scripts/test-activity-card-view-model.ts` by changing the `trade` fixture metadata to include:

```ts
      importance: {
        version: 1,
        score: 88,
        sourceKind: 'wallet',
        sourceCount7d: 0,
        socialCount7d: 0,
        walletCount7d: 0,
        totalCount7d: 0,
        historicalMaxAssetUsd: 2_500_000,
        sourceRarity: 1,
        assetWeight: 0.91,
        totalFrequencyFactor: 1,
        dataConfidenceFactor: 1,
      },
```

and add assertions:

```ts
  assert.equal(trade.importanceBadgeText, '88分');
  assert.equal(trade.importanceLevelLabel, '高重要');
  assert.match(trade.importanceTooltip || '', /同源稀缺分/);
  assert.match(trade.importanceTooltip || '', /总频率因子/);
```

Extend `/Users/xp/vibecoding/pilipili/scripts/test-feed-page-state.ts` by giving each activity an `importance` object and keeping this assertion unchanged:

```ts
  assert.deepEqual(
    globalState.filteredFeed.map((item) => item.activity.id),
    ['new-bob', 'new-alice'],
    'global state should order by timestamp and apply global visible count'
  );
```

- [ ] **Step 2: Run test to verify it fails**

Run: `tsx scripts/test-activity-card-view-model.ts`
Expected: FAIL with missing `importanceBadgeText` / `importanceTooltip` fields.

Run: `tsx scripts/test-feed-page-state.ts`
Expected: PASS before the UI change; keep it in the task as a guard that later edits must not alter ordering.

- [ ] **Step 3: Write minimal implementation**

In `/Users/xp/vibecoding/pilipili/lib/activityCardViewModel.ts`, import the shared helpers and add the derived fields:

```ts
import {
  buildActivityImportanceExplanationRows,
  getActivityImportanceLevel,
  getActivityImportanceLevelLabel,
} from '@/lib/activityImportance';
```

Inside `buildActivityCardViewModel()`:

```ts
  const importance = activity.metadata.importance || null;
  const importanceScore = importance?.score ?? null;
  const importanceLevel = importanceScore === null ? null : getActivityImportanceLevel(importanceScore);
  const importanceLevelLabel = importanceScore === null ? null : getActivityImportanceLevelLabel(importanceScore);
  const importanceBadgeText = importanceScore === null ? null : `${importanceScore}分`;
  const importanceTooltip = importance
    ? buildActivityImportanceExplanationRows(importance)
        .map((row) => `${row.label}: ${row.valueText}\n${row.description}`)
        .join('\n\n')
    : null;
  const importanceBadgeClassName =
    importanceLevel === 'high'
      ? 'bg-rose-500/15 text-rose-200 ring-1 ring-rose-400/35'
      : importanceLevel === 'important'
        ? 'bg-amber-500/15 text-amber-200 ring-1 ring-amber-400/35'
        : 'bg-zinc-800 text-zinc-300 ring-1 ring-zinc-700';
```

and return:

```ts
    importanceBadgeText,
    importanceLevelLabel,
    importanceTooltip,
    importanceBadgeClassName,
```

In `/Users/xp/vibecoding/pilipili/components/ActivityCard.tsx`, import `Badge`:

```ts
import { Badge } from '@/components/ui/badge';
```

and render the always-visible badge near the top-right of the card:

```tsx
  const {
    // keep existing fields,
    importanceBadgeText,
    importanceLevelLabel,
    importanceTooltip,
    importanceBadgeClassName,
  } = buildActivityCardViewModel({
```

```tsx
    <Card
      className={`group relative cursor-pointer gap-0 rounded-none py-0 shadow-none ring-0 transition-all ${
```

```tsx
      <CardContent className="px-3 py-2 pr-14">
        {importanceBadgeText ? (
          <Badge
            variant="secondary"
            className={`absolute right-3 top-2 border-0 text-[10px] font-medium ${importanceBadgeClassName}`}
            title={importanceTooltip || undefined}
          >
            {importanceBadgeText}
          </Badge>
        ) : null}
```

If there is enough room in the user row, also expose the text band without duplicating the tooltip:

```tsx
                  {importanceLevelLabel ? (
                    <span className="truncate text-[11px] text-zinc-500">{importanceLevelLabel}</span>
                  ) : null}
```

Update `/Users/xp/vibecoding/pilipili/package.json` aggregate test command by appending the new scripts without removing the existing suite:

```json
{
  "scripts": {
    "test": "npm run test:admin-auth && npm run test:feed-ordering && npm run test:time-format && npm run test:activity-card-view-model && npm run test:activity-importance && npm run test:activity-importance-service && npm run test:activity-importance-ingest && npm run test:activity-importance-backfill && npm run test:trade-usd && npm run test:events-feed-total && npm run test:feed-request-arbiter && npm run test:feed-client-state && npm run test:feed-completeness-visibility && npm run test:feed-prewarm-service && npm run test:activity-feed-retry && npm run test:global-search-wiring && npm run test:feed-page-state && npm run test:tooling-config && npm run test:search-filters && npm run test:source-reconciliation && npm run test:sync-failure-notifier && npm run test:manage-users && npm run test:tracked-user-validation && npm run test:tracked-address-ownership && npm run test:address-book && npm run test:address-assets && npm run test:conflict-repo && npm run test:system-config-conflict-chat && npm run test:conflict-notifier && npm run test:parser-fixtures && npm run test:telegram-monitor-reconciliation && npm run test:twitter-fetcher && npm run test:twitter-provider-router && npm run test:twitter-provider-clients && npm run test:twitter-provider-state && npm run test:twitter-identity-service && npm run test:twitter-stable-identity && npm run test:twitter-sync-service && npm run test:twitter-relay-coverage && npm run test:twitter-bridge"
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `tsx scripts/test-activity-card-view-model.ts`
Expected: PASS with `activity card view model tests: ok`.

Run: `tsx scripts/test-feed-page-state.ts`
Expected: PASS and the filtered order remains `['new-bob', 'new-alice']`.

- [ ] **Step 5: Commit**

```bash
git add lib/activityCardViewModel.ts components/ActivityCard.tsx scripts/test-activity-card-view-model.ts scripts/test-feed-page-state.ts package.json
git commit -m "feat: show activity importance badges in feed cards"
```
