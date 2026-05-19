# Global Completeness Window Full-Scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a single global `completenessStartMs` contract and an independent backend maintenance system that continuously proves timeline completeness from `start -> now` across `blockchain`, `twitter`, `telegram-bridge`, and `telegram-channel`.

**Architecture:** Introduce a dedicated completeness persistence layer, a central maintenance orchestrator, and one adapter per source. Existing realtime workers continue owning fresh ingest, while the new maintenance worker owns historical proof and strict global aggregation. Feed/status/UI surfaces become readers of unified completeness state instead of inferring completeness from the legacy 7-day feed window plus Twitter cursor state.

**Tech Stack:** Next.js 16 server runtime, TypeScript, `better-sqlite3`, `tsx` script tests, Node `24.11.1`, launchd worker scripts

---

## File Structure

### New files

- Create: `/Users/xp/vibecoding/pilipili/lib/server/completenessTypes.ts`
  - Shared source ids, statuses, checkpoints, run/result types, and pure type guards.
- Create: `/Users/xp/vibecoding/pilipili/lib/server/completenessRepo.ts`
  - Persistence for global state, per-source state, run history, source run history, and durable poke queue.
- Create: `/Users/xp/vibecoding/pilipili/lib/server/completenessStatus.ts`
  - Pure status aggregation and proof-boundary helpers.
- Create: `/Users/xp/vibecoding/pilipili/lib/server/completenessMaintenanceService.ts`
  - Lease-protected orchestration entry point, retry policy, and trigger dedupe.
- Create: `/Users/xp/vibecoding/pilipili/lib/server/completenessMaintenanceWorkerRuntime.ts`
  - Long-running maintenance worker loop with hybrid interval + poke wakeups.
- Create: `/Users/xp/vibecoding/pilipili/lib/server/completenessSourceAdapters/types.ts`
  - Adapter contract for `runStep()` input/output.
- Create: `/Users/xp/vibecoding/pilipili/lib/server/completenessSourceAdapters/blockchain.ts`
  - Blockchain proof adapter built on top of the current feed/snapshot pipeline.
- Create: `/Users/xp/vibecoding/pilipili/lib/server/completenessSourceAdapters/twitter.ts`
  - Twitter proof adapter built on top of cursor/watermark state.
- Create: `/Users/xp/vibecoding/pilipili/lib/server/completenessSourceAdapters/telegramBridge.ts`
  - Telegram bridge historical proof adapter using backward chat pagination.
- Create: `/Users/xp/vibecoding/pilipili/lib/server/completenessSourceAdapters/telegramChannel.ts`
  - Telegram channel historical proof adapter using backward channel pagination.
- Create: `/Users/xp/vibecoding/pilipili/app/api/completeness/route.ts`
  - GET completeness status + POST actions (`run-now`, `retry-source`, `clear-source-checkpoint`).
- Create: `/Users/xp/vibecoding/pilipili/scripts/completeness-maintenance-worker.ts`
  - CLI/launchd entrypoint for the maintenance worker.
- Create: `/Users/xp/vibecoding/pilipili/ops/com.xp.pilipili.completeness-maintenance.plist`
  - launchd job definition for the independent completeness worker.
- Create: `/Users/xp/vibecoding/pilipili/scripts/test-completeness-repo.ts`
  - Repo/state persistence test.
- Create: `/Users/xp/vibecoding/pilipili/scripts/test-completeness-status.ts`
  - Pure global/source status aggregation test.
- Create: `/Users/xp/vibecoding/pilipili/scripts/test-completeness-maintenance-service.ts`
  - Orchestrator retry, checkpoint resume, and strict aggregation test.
- Create: `/Users/xp/vibecoding/pilipili/scripts/test-completeness-source-adapters.ts`
  - Focused adapter-proof semantics test for blockchain/twitter/TG adapters.
- Create: `/Users/xp/vibecoding/pilipili/scripts/test-completeness-api.ts`
  - API contract and system-config completeness field test.

### Existing files to modify

- Modify: `/Users/xp/vibecoding/pilipili/package.json`
  - Register new tests and maintenance worker commands.
- Modify: `/Users/xp/vibecoding/pilipili/lib/server/sqlite.ts`
  - Add completeness tables and ensure-column migration helpers.
- Modify: `/Users/xp/vibecoding/pilipili/lib/server/systemConfigRepo.ts`
  - Persist and normalize `completenessStartMs`.
- Modify: `/Users/xp/vibecoding/pilipili/app/api/system-config/route.ts`
  - Accept and return `completenessStartMs`.
- Modify: `/Users/xp/vibecoding/pilipili/lib/server/feedViewMeta.ts`
  - Read unified completeness status instead of legacy blockchain/Twitter-only inference.
- Modify: `/Users/xp/vibecoding/pilipili/app/api/feed/route.ts`
  - Stop using page-triggered prewarm as the authoritative completeness engine.
- Modify: `/Users/xp/vibecoding/pilipili/app/system/page.tsx`
  - Add completeness controls, per-source status table, and run actions.
- Modify: `/Users/xp/vibecoding/pilipili/lib/server/telegramChannelTypes.ts`
  - Extend chat/channel historical pagination interfaces.
- Modify: `/Users/xp/vibecoding/pilipili/lib/server/telegramGramjsClient.ts`
  - Implement backward bridge/channel pagination parameters.
- Modify: `/Users/xp/vibecoding/pilipili/lib/server/telegramBridgeMtprotoBackfill.ts`
  - Convert latest-N history fetch into resumable bounded backward scans.
- Modify: `/Users/xp/vibecoding/pilipili/lib/server/telegramChannelSync.ts`
  - Separate incremental sync and historical proof scanning.
- Modify: `/Users/xp/vibecoding/pilipili/lib/server/telegramChannelWorkerRuntime.ts`
  - Emit completeness pokes after sync/failure-recovery transitions.
- Modify: `/Users/xp/vibecoding/pilipili/scripts/telegram-bridge.ts`
  - Emit completeness pokes after realtime ingest and lease recovery.
- Modify: `/Users/xp/vibecoding/pilipili/lib/server/twitterSyncService.ts`
  - Expose reusable absolute-start proof helpers for the Twitter adapter.
- Modify: `/Users/xp/vibecoding/pilipili/lib/server/syncLogRepo.ts`
  - Extend `runKind` support to include `completeness`.
- Modify: `/Users/xp/vibecoding/pilipili/app/api/sync/logs/route.ts`
  - Allow polling completeness logs from the system page.

---

## Subagent Execution Order

- Main integrator owns `Task 1` first and creates the clean worktree/baseline.
- `Worker A` owns `Task 2`.
- `Worker B` owns `Task 3` after `Task 2` lands.
- `Worker C` owns `Task 4` and `Task 5` together after `Task 3` lands.
- `Worker D` owns `Task 6` and `Task 7` together after `Task 4` and `Task 5` land.
- Main integrator owns `Task 8` and `Task 9` last.

This order is mandatory because `Task 4` and `Task 5` both modify `lib/server/completenessMaintenanceService.ts` and `scripts/test-completeness-source-adapters.ts`, while `Task 2` and `Task 7` both modify `lib/server/completenessRepo.ts`.

### Task 1: Create A Dedicated Worktree And Verify The Baseline

**Files:**
- Modify: `/Users/xp/vibecoding/pilipili/docs/superpowers/plans/2026-05-05-global-completeness-window-full-scope.md`
- Test: `/Users/xp/vibecoding/pilipili/package.json`

- [ ] **Step 1: Verify the local worktree directory remains ignored**

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
git worktree add .worktrees/codex-global-completeness-window-full-scope -b codex/global-completeness-window-full-scope
```

Expected: worktree created at `/Users/xp/vibecoding/pilipili/.worktrees/codex-global-completeness-window-full-scope`

- [ ] **Step 3: Install dependencies in the new worktree if needed**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-global-completeness-window-full-scope
npm install
```

Expected: install completes without Node engine or dependency resolution errors

- [ ] **Step 4: Run the baseline verification subset before changes**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-global-completeness-window-full-scope
npm run test:system-config-conflict-chat
npm run test:feed-prewarm-service
npm run test:twitter-sync-service
npm run test:telegram-channel-provider
npm run test:telegram-mtproto-upgrades
npm run build
```

Expected: all commands pass on the untouched baseline

- [ ] **Step 5: Confirm the worktree starts clean**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-global-completeness-window-full-scope
git status --short
```

Expected: no unexpected tracked changes

### Task 2: Add The Completeness Schema, Types, And Config Field

**Files:**
- Create: `/Users/xp/vibecoding/pilipili/lib/server/completenessTypes.ts`
- Create: `/Users/xp/vibecoding/pilipili/lib/server/completenessRepo.ts`
- Create: `/Users/xp/vibecoding/pilipili/scripts/test-completeness-repo.ts`
- Modify: `/Users/xp/vibecoding/pilipili/package.json`
- Modify: `/Users/xp/vibecoding/pilipili/lib/server/sqlite.ts`
- Modify: `/Users/xp/vibecoding/pilipili/lib/server/systemConfigRepo.ts`
- Modify: `/Users/xp/vibecoding/pilipili/app/api/system-config/route.ts`
- Test: `/Users/xp/vibecoding/pilipili/scripts/test-completeness-repo.ts`
- Test: `/Users/xp/vibecoding/pilipili/scripts/test-system-config-conflict-chat.ts`

- [ ] **Step 1: Write the failing repo/config test**

Create `/Users/xp/vibecoding/pilipili/scripts/test-completeness-repo.ts`:

```ts
import assert from 'node:assert/strict';

import { getDb } from '@/lib/server/sqlite';
import {
  createCompletenessRun,
  finishCompletenessRun,
  queueCompletenessPoke,
  readCompletenessGlobalState,
  readCompletenessSourceStates,
  readPendingCompletenessPokes,
  saveCompletenessGlobalState,
  saveCompletenessSourceState,
} from '@/lib/server/completenessRepo';
import { readSystemConfig, saveSystemConfig } from '@/lib/server/systemConfigRepo';

async function run() {
  const db = getDb();
  db.prepare('DELETE FROM completeness_run_sources').run();
  db.prepare('DELETE FROM completeness_runs').run();
  db.prepare('DELETE FROM completeness_pokes').run();
  db.prepare('DELETE FROM completeness_source_state').run();
  db.prepare('DELETE FROM completeness_global_state').run();

  const savedConfig = saveSystemConfig({ completenessStartMs: 1_700_000_000_000 });
  assert.equal(savedConfig.completenessStartMs, 1_700_000_000_000);
  assert.equal(readSystemConfig().completenessStartMs, 1_700_000_000_000);

  saveCompletenessGlobalState({
    configuredStartMs: 1_700_000_000_000,
    globalProvenStartMs: null,
    status: 'partial',
    activeRunId: null,
    lastSuccessAt: null,
    lastFailureAt: null,
  });

  saveCompletenessSourceState({
    source: 'twitter',
    requestedStartMs: 1_700_000_000_000,
    provenStartMs: null,
    provenEndMs: null,
    status: 'retrying',
    failureCount: 1,
    lastSuccessAt: null,
    lastFailureAt: 1_700_000_100_000,
    blockedReason: null,
    checkpointJson: JSON.stringify({ lane: 'timeline', cursor: 'abc' }),
  });

  const runRow = createCompletenessRun({
    reason: 'test',
    trigger: 'manual',
    configuredStartMs: 1_700_000_000_000,
  });
  finishCompletenessRun(runRow.id, 'partial', {
    globalProvenStartMs: null,
    blockedSources: [],
    partialSources: ['twitter'],
  });

  queueCompletenessPoke({
    trigger: 'ingest',
    sourceHint: 'telegram-bridge',
    reason: 'new-message',
  });

  assert.equal(readCompletenessGlobalState()?.status, 'partial');
  assert.equal(readCompletenessSourceStates().find((row) => row.source === 'twitter')?.status, 'retrying');
  assert.equal(readPendingCompletenessPokes(10)[0]?.sourceHint, 'telegram-bridge');
  assert.equal(
    Number(db.prepare('SELECT COUNT(*) AS count FROM completeness_runs').get() as { count: number }).count,
    1
  );

  console.log('completeness repo tests: ok');
}

void run();
```

- [ ] **Step 2: Register the new repo test and worker commands**

Update `/Users/xp/vibecoding/pilipili/package.json`:

```json
{
  "scripts": {
    "completeness:worker": "NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/completeness-maintenance-worker.ts",
    "test:completeness-repo": "NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-completeness-repo.ts",
    "test:completeness-status": "tsx scripts/test-completeness-status.ts",
    "test:completeness-maintenance-service": "NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-completeness-maintenance-service.ts",
    "test:completeness-source-adapters": "NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-completeness-source-adapters.ts",
    "test:completeness-api": "NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-completeness-api.ts"
  }
}
```

- [ ] **Step 3: Run the repo/config test and verify it fails**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-global-completeness-window-full-scope
npm run test:completeness-repo
```

Expected: FAIL with missing module or missing table/config field errors

- [ ] **Step 4: Implement the shared completeness types**

Create `/Users/xp/vibecoding/pilipili/lib/server/completenessTypes.ts`:

```ts
export const COMPLETENESS_SOURCES = [
  'blockchain',
  'twitter',
  'telegram-bridge',
  'telegram-channel',
] as const;

export type CompletenessSource = (typeof COMPLETENESS_SOURCES)[number];
export type CompletenessStatus = 'idle' | 'running' | 'complete' | 'partial' | 'retrying' | 'blocked';
export type CompletenessTrigger = 'manual' | 'interval' | 'ingest' | 'config-change' | 'recovery';

export interface CompletenessGlobalState {
  configuredStartMs: number | null;
  globalProvenStartMs: number | null;
  status: CompletenessStatus;
  activeRunId: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
}

export interface CompletenessSourceState {
  source: CompletenessSource;
  requestedStartMs: number | null;
  provenStartMs: number | null;
  provenEndMs: number | null;
  status: CompletenessStatus;
  failureCount: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  blockedReason: string | null;
  checkpointJson: string | null;
}

export interface CompletenessPokeRow {
  id: number;
  trigger: CompletenessTrigger;
  sourceHint: CompletenessSource | null;
  reason: string | null;
  createdAt: number;
  claimedAt: number | null;
}
```

- [ ] **Step 5: Add completeness tables and migrations**

Update `/Users/xp/vibecoding/pilipili/lib/server/sqlite.ts` by appending these tables to `SCHEMA_SQL`:

```sql
CREATE TABLE IF NOT EXISTS completeness_global_state (
  singleton_key TEXT PRIMARY KEY,
  configured_start_ms INTEGER,
  global_proven_start_ms INTEGER,
  status TEXT NOT NULL,
  active_run_id INTEGER,
  last_success_at INTEGER,
  last_failure_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS completeness_source_state (
  source TEXT PRIMARY KEY,
  requested_start_ms INTEGER,
  proven_start_ms INTEGER,
  proven_end_ms INTEGER,
  status TEXT NOT NULL,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_success_at INTEGER,
  last_failure_at INTEGER,
  blocked_reason TEXT,
  checkpoint_json TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS completeness_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reason TEXT,
  trigger TEXT NOT NULL,
  configured_start_ms INTEGER,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  global_proven_start_ms INTEGER,
  summary_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS completeness_run_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  requested_start_ms INTEGER,
  proven_start_ms INTEGER,
  proven_end_ms INTEGER,
  status TEXT NOT NULL,
  fetched_count INTEGER NOT NULL DEFAULT 0,
  stored_count INTEGER NOT NULL DEFAULT 0,
  projected_count INTEGER NOT NULL DEFAULT 0,
  blocked_reason TEXT,
  checkpoint_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (run_id) REFERENCES completeness_runs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS completeness_pokes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger TEXT NOT NULL,
  source_hint TEXT,
  reason TEXT,
  claimed_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_completeness_pokes_claimed
ON completeness_pokes(claimed_at, created_at ASC);
```

Also add an `ensureCompletenessSchema(db)` helper and call it from `initializeDb(db)`:

```ts
function ensureCompletenessSchema(db: Database.Database) {
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_completeness_run_sources_run_source
     ON completeness_run_sources(run_id, source)`
  );
}

function initializeDb(db: Database.Database) {
  if (initialized) {
    return;
  }

  db.exec(SCHEMA_SQL);
  ensureTelegramChannelSourceColumns(db);
  ensureTelegramChannelPostSchema(db);
  ensureTelegramMonitorEventColumns(db);
  ensureActivityJudgmentColumns(db);
  ensureTwitterSyncCursorColumns(db);
  ensureTwitterIdentityColumns(db);
  ensureCompletenessSchema(db);
  ensureEventsFtsIndexing(db);
  migrateLegacyJudgments(db);
  initialized = true;
}
```

- [ ] **Step 6: Extend the system config snapshot with `completenessStartMs`**

Update `/Users/xp/vibecoding/pilipili/lib/server/systemConfigRepo.ts`:

```ts
export interface SystemConfigSnapshot {
  telegramUnknownPersonAlertChatId: string | null;
  telegramTradeMonitorSourceChatId: string | null;
  telegramTwitterMonitorSourceChatId: string | null;
  conflictNotificationTelegramChatId: string | null;
  twitterRelayCoveredPollingIntervalMinutes: number;
  twitterUncoveredPollingIntervalMinutes: number;
  completenessStartMs: number | null;
}

function normalizeOptionalTimestamp(value: unknown) {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number.parseInt(value.trim(), 10)
        : Number.NaN;

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.floor(parsed);
}
```

Then add `completenessStartMs` to `normalizeSnapshot()`, `readSystemConfig()`, and `saveSystemConfig()`.

- [ ] **Step 7: Accept the new field in the system-config API**

Update `/Users/xp/vibecoding/pilipili/app/api/system-config/route.ts` so the request body supports `completenessStartMs`:

```ts
type PatchBody = {
  telegramUnknownPersonAlertChatId?: string | null;
  telegramTradeMonitorSourceChatId?: string | null;
  telegramTwitterMonitorSourceChatId?: string | null;
  conflictNotificationTelegramChatId?: string | null;
  twitterRelayCoveredPollingIntervalMinutes?: number | string | null;
  twitterUncoveredPollingIntervalMinutes?: number | string | null;
  completenessStartMs?: number | string | null;
};
```

And forward it into `saveSystemConfig()` using the same null/number/string normalization pattern already used for the polling intervals.

- [ ] **Step 8: Implement the completeness repo**

Create `/Users/xp/vibecoding/pilipili/lib/server/completenessRepo.ts` with these entry points:

```ts
import 'server-only';

import { getDb } from '@/lib/server/sqlite';
import type {
  CompletenessGlobalState,
  CompletenessPokeRow,
  CompletenessSource,
  CompletenessSourceState,
  CompletenessStatus,
  CompletenessTrigger,
} from '@/lib/server/completenessTypes';

const GLOBAL_SINGLETON_KEY = 'global';

export function readCompletenessGlobalState(): CompletenessGlobalState | null { /* map row */ }
export function saveCompletenessGlobalState(input: CompletenessGlobalState): void { /* upsert singleton */ }
export function readCompletenessSourceStates(): CompletenessSourceState[] { /* ordered by source */ }
export function saveCompletenessSourceState(input: CompletenessSourceState): void { /* upsert by source */ }
export function createCompletenessRun(input: {
  reason: string | null;
  trigger: CompletenessTrigger;
  configuredStartMs: number | null;
}) { /* insert running row */ }
export function finishCompletenessRun(
  runId: number,
  status: CompletenessStatus,
  summary: Record<string, unknown>
): void { /* update finish state */ }
export function appendCompletenessRunSource(input: {
  runId: number;
  source: CompletenessSource;
  requestedStartMs: number | null;
  provenStartMs: number | null;
  provenEndMs: number | null;
  status: CompletenessStatus;
  fetchedCount: number;
  storedCount: number;
  projectedCount: number;
  blockedReason: string | null;
  checkpointJson: string | null;
}): void { /* insert row */ }
export function queueCompletenessPoke(input: {
  trigger: CompletenessTrigger;
  sourceHint: CompletenessSource | null;
  reason: string | null;
}): void { /* insert poke */ }
export function readPendingCompletenessPokes(limit: number): CompletenessPokeRow[] { /* oldest unclaimed first */ }
export function claimCompletenessPokes(ids: number[], claimedAt: number): void { /* claim by id */ }
export function deleteClaimedCompletenessPokes(ids: number[]): void { /* delete by id */ }
```

- [ ] **Step 9: Run the focused persistence/config tests**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-global-completeness-window-full-scope
npm run test:completeness-repo
npm run test:system-config-conflict-chat
```

Expected: both commands pass

- [ ] **Step 10: Commit the schema/config foundation**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-global-completeness-window-full-scope
git add package.json lib/server/sqlite.ts lib/server/systemConfigRepo.ts app/api/system-config/route.ts lib/server/completenessTypes.ts lib/server/completenessRepo.ts scripts/test-completeness-repo.ts
git commit -m "feat: add completeness state schema and config"
```

Expected: commit created successfully

### Task 3: Build Pure Status Aggregation And The Core Maintenance Orchestrator

**Files:**
- Create: `/Users/xp/vibecoding/pilipili/lib/server/completenessStatus.ts`
- Create: `/Users/xp/vibecoding/pilipili/lib/server/completenessMaintenanceService.ts`
- Create: `/Users/xp/vibecoding/pilipili/scripts/test-completeness-status.ts`
- Create: `/Users/xp/vibecoding/pilipili/scripts/test-completeness-maintenance-service.ts`
- Modify: `/Users/xp/vibecoding/pilipili/lib/server/syncLogRepo.ts`
- Modify: `/Users/xp/vibecoding/pilipili/app/api/sync/logs/route.ts`
- Test: `/Users/xp/vibecoding/pilipili/scripts/test-completeness-status.ts`
- Test: `/Users/xp/vibecoding/pilipili/scripts/test-completeness-maintenance-service.ts`

- [ ] **Step 1: Write the failing pure aggregation test**

Create `/Users/xp/vibecoding/pilipili/scripts/test-completeness-status.ts`:

```ts
import assert from 'node:assert/strict';

import {
  computeCompletenessGlobalStatus,
  computeGlobalProvenStartMs,
} from '@/lib/server/completenessStatus';

function run() {
  assert.equal(
    computeGlobalProvenStartMs([
      { source: 'blockchain', provenStartMs: 100 },
      { source: 'twitter', provenStartMs: 120 },
      { source: 'telegram-bridge', provenStartMs: 90 },
      { source: 'telegram-channel', provenStartMs: 140 },
    ]),
    140
  );

  assert.equal(
    computeCompletenessGlobalStatus({
      configuredStartMs: 100,
      sources: [
        { source: 'blockchain', status: 'complete', provenStartMs: 90 },
        { source: 'twitter', status: 'partial', provenStartMs: 120 },
        { source: 'telegram-bridge', status: 'complete', provenStartMs: 80 },
        { source: 'telegram-channel', status: 'blocked', provenStartMs: null },
      ],
    }).status,
    'blocked'
  );

  console.log('completeness status tests: ok');
}

run();
```

- [ ] **Step 2: Implement pure completeness aggregation**

Create `/Users/xp/vibecoding/pilipili/lib/server/completenessStatus.ts`:

```ts
import type { CompletenessSource, CompletenessStatus } from '@/lib/server/completenessTypes';

export function computeGlobalProvenStartMs(
  sources: Array<{ source: CompletenessSource; provenStartMs: number | null }>
) {
  const values = sources
    .map((source) => source.provenStartMs)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));

  if (values.length !== sources.length || values.length === 0) {
    return null;
  }

  return Math.max(...values);
}

export function computeCompletenessGlobalStatus(input: {
  configuredStartMs: number | null;
  sources: Array<{ source: CompletenessSource; status: CompletenessStatus; provenStartMs: number | null }>;
}) {
  if (input.sources.some((source) => source.status === 'blocked')) {
    return { status: 'blocked' as const };
  }
  if (input.sources.some((source) => source.status === 'running' || source.status === 'retrying')) {
    return { status: 'retrying' as const };
  }
  if (
    input.configuredStartMs !== null &&
    input.sources.length > 0 &&
    input.sources.every(
      (source) => typeof source.provenStartMs === 'number' && source.provenStartMs <= input.configuredStartMs
    )
  ) {
    return { status: 'complete' as const };
  }
  return { status: 'partial' as const };
}
```

- [ ] **Step 3: Write the failing orchestration test**

Create `/Users/xp/vibecoding/pilipili/scripts/test-completeness-maintenance-service.ts`:

```ts
import assert from 'node:assert/strict';

import { createCompletenessMaintenanceService } from '@/lib/server/completenessMaintenanceService';

async function run() {
  const calls: string[] = [];
  const service = createCompletenessMaintenanceService({
    now: () => 1_700_000_000_000,
    acquireLease: () => true,
    releaseLease: () => undefined,
    readConfigStartMs: () => 100,
    listSourceStates: () => [
      { source: 'blockchain', status: 'partial', provenStartMs: 120, failureCount: 0, checkpointJson: null },
      { source: 'twitter', status: 'complete', provenStartMs: 80, failureCount: 0, checkpointJson: null },
      { source: 'telegram-bridge', status: 'partial', provenStartMs: null, failureCount: 2, checkpointJson: null },
      { source: 'telegram-channel', status: 'complete', provenStartMs: 90, failureCount: 0, checkpointJson: null },
    ],
    runSource: async ({ source }) => {
      calls.push(source);
      if (source === 'telegram-bridge') {
        return {
          source,
          status: 'retrying',
          requestedStartMs: 100,
          provenStartMs: null,
          provenEndMs: 1_700_000_000_000,
          fetchedCount: 0,
          storedCount: 0,
          projectedCount: 0,
          blockedReason: null,
          checkpointJson: JSON.stringify({ beforeMessageId: 88 }),
          progressed: false,
        };
      }
      return {
        source,
        status: 'complete',
        requestedStartMs: 100,
        provenStartMs: 90,
        provenEndMs: 1_700_000_000_000,
        fetchedCount: 10,
        storedCount: 10,
        projectedCount: 10,
        blockedReason: null,
        checkpointJson: null,
        progressed: true,
      };
    },
  });

  const result = await service.runOnce({ trigger: 'manual', reason: 'test-run' });
  assert.deepEqual(calls, ['blockchain', 'telegram-bridge']);
  assert.equal(result.status, 'retrying');
  assert.equal(result.globalProvenStartMs, null);

  console.log('completeness maintenance service tests: ok');
}

void run();
```

- [ ] **Step 4: Implement the central maintenance service**

Create `/Users/xp/vibecoding/pilipili/lib/server/completenessMaintenanceService.ts`:

```ts
import 'server-only';

import { appendSyncLog } from '@/lib/server/syncLogRepo';
import { computeCompletenessGlobalStatus, computeGlobalProvenStartMs } from '@/lib/server/completenessStatus';
import type { CompletenessSource, CompletenessStatus, CompletenessTrigger } from '@/lib/server/completenessTypes';

const MAX_FAILURES_WITHOUT_PROGRESS = 10;

export function createCompletenessMaintenanceService(deps: {
  now?: () => number;
  acquireLease?: () => boolean;
  releaseLease?: () => void;
  readConfigStartMs?: () => number | null;
  listSourceStates?: () => Array<{
    source: CompletenessSource;
    status: CompletenessStatus;
    provenStartMs: number | null;
    failureCount: number;
    checkpointJson: string | null;
  }>;
  runSource?: (input: { source: CompletenessSource; configuredStartMs: number | null }) => Promise<{
    source: CompletenessSource;
    status: CompletenessStatus;
    requestedStartMs: number | null;
    provenStartMs: number | null;
    provenEndMs: number | null;
    fetchedCount: number;
    storedCount: number;
    projectedCount: number;
    blockedReason: string | null;
    checkpointJson: string | null;
    progressed: boolean;
  }>;
}) {
  return {
    async runOnce(input: {
      trigger: CompletenessTrigger;
      reason: string | null;
      source?: CompletenessSource | null;
    }) {
      const acquireLease = deps.acquireLease || (() => true);
      const releaseLease = deps.releaseLease || (() => undefined);
      if (!acquireLease()) {
        return { started: false, status: 'retrying' as const, globalProvenStartMs: null };
      }

      try {
        const configuredStartMs = deps.readConfigStartMs ? deps.readConfigStartMs() : null;
        const currentSources = deps.listSourceStates ? deps.listSourceStates() : [];
        const runnable = currentSources.filter((source) => {
          if (input.source && source.source !== input.source) return false;
          if (source.status === 'blocked') return false;
          if (configuredStartMs === null) return false;
          if (typeof source.provenStartMs === 'number' && source.provenStartMs <= configuredStartMs) return false;
          return true;
        });

        const nextSources = [...currentSources];
        for (const source of runnable) {
          const result = await (deps.runSource as NonNullable<typeof deps.runSource>)({
            source: source.source,
            configuredStartMs,
          });
          const nextFailureCount =
            result.progressed || result.status === 'complete'
              ? 0
              : Math.min(MAX_FAILURES_WITHOUT_PROGRESS, source.failureCount + 1);

          nextSources.splice(
            nextSources.findIndex((item) => item.source === source.source),
            1,
            {
              source: result.source,
              status:
                nextFailureCount >= MAX_FAILURES_WITHOUT_PROGRESS && result.status !== 'complete'
                  ? 'blocked'
                  : result.status,
              provenStartMs: result.provenStartMs,
              failureCount: nextFailureCount,
              checkpointJson: result.checkpointJson,
            }
          );
        }

        const globalProvenStartMs = computeGlobalProvenStartMs(nextSources);
        const { status } = computeCompletenessGlobalStatus({
          configuredStartMs,
          sources: nextSources,
        });

        appendSyncLog({
          runKind: 'completeness',
          level: 'info',
          phase: 'done',
          message: 'completeness maintenance run finished',
          payload: { configuredStartMs, globalProvenStartMs, status },
        });

        return { started: true, status, globalProvenStartMs };
      } finally {
        releaseLease();
      }
    },
  };
}
```

- [ ] **Step 5: Extend the sync-log infrastructure**

Update `/Users/xp/vibecoding/pilipili/lib/server/syncLogRepo.ts`:

```ts
export type SyncRunKind = 'sync' | 'twitter' | 'completeness';
```

Update `/Users/xp/vibecoding/pilipili/app/api/sync/logs/route.ts`:

```ts
function parseRunKind(value: string | null): SyncRunKind | null {
  if (value === 'sync' || value === 'twitter' || value === 'completeness') {
    return value;
  }
  return null;
}
```

- [ ] **Step 6: Run the core service tests**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-global-completeness-window-full-scope
npm run test:completeness-status
npm run test:completeness-maintenance-service
```

Expected: both commands pass

- [ ] **Step 7: Commit the orchestration foundation**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-global-completeness-window-full-scope
git add lib/server/completenessStatus.ts lib/server/completenessMaintenanceService.ts lib/server/syncLogRepo.ts app/api/sync/logs/route.ts scripts/test-completeness-status.ts scripts/test-completeness-maintenance-service.ts
git commit -m "feat: add completeness orchestration core"
```

Expected: commit created successfully

### Task 4: Implement The Blockchain And Twitter Source Adapters

**Files:**
- Create: `/Users/xp/vibecoding/pilipili/lib/server/completenessSourceAdapters/types.ts`
- Create: `/Users/xp/vibecoding/pilipili/lib/server/completenessSourceAdapters/blockchain.ts`
- Create: `/Users/xp/vibecoding/pilipili/lib/server/completenessSourceAdapters/twitter.ts`
- Create: `/Users/xp/vibecoding/pilipili/scripts/test-completeness-source-adapters.ts`
- Modify: `/Users/xp/vibecoding/pilipili/lib/server/twitterSyncService.ts`
- Modify: `/Users/xp/vibecoding/pilipili/lib/server/completenessMaintenanceService.ts`
- Test: `/Users/xp/vibecoding/pilipili/scripts/test-completeness-source-adapters.ts`
- Test: `/Users/xp/vibecoding/pilipili/scripts/test-twitter-sync-service.ts`
- Test: `/Users/xp/vibecoding/pilipili/scripts/test-feed-prewarm-service.ts`

Ownership note: the same worker must own `Task 4` and `Task 5`. They share `lib/server/completenessMaintenanceService.ts` and `scripts/test-completeness-source-adapters.ts`, so they are one execution lane even though the plan keeps them as separate reviewable tasks.

- [ ] **Step 1: Write the failing adapter semantics test**

Create `/Users/xp/vibecoding/pilipili/scripts/test-completeness-source-adapters.ts`:

```ts
import assert from 'node:assert/strict';

import { resolveTwitterSourceProvenStartMs } from '@/lib/server/completenessSourceAdapters/twitter';
import { resolveBlockchainStepWindow } from '@/lib/server/completenessSourceAdapters/blockchain';

function run() {
  assert.equal(
    resolveTwitterSourceProvenStartMs({
      timeline: { coveredSinceMs: 100 },
      replies: { coveredSinceMs: 140 },
    }),
    140
  );

  assert.deepEqual(
    resolveBlockchainStepWindow({
      configuredStartMs: 100,
      currentProvenStartMs: 400,
      endMs: 1_000,
      maxStepMs: 7 * 24 * 60 * 60 * 1000,
    }),
    {
      beginMs: 100,
      endMs: 400,
    }
  );

  console.log('completeness source adapter tests: ok');
}

run();
```

- [ ] **Step 2: Implement the shared adapter contract**

Create `/Users/xp/vibecoding/pilipili/lib/server/completenessSourceAdapters/types.ts`:

```ts
import type { CompletenessSource, CompletenessStatus } from '@/lib/server/completenessTypes';

export interface CompletenessAdapterResult {
  source: CompletenessSource;
  status: CompletenessStatus;
  requestedStartMs: number | null;
  provenStartMs: number | null;
  provenEndMs: number | null;
  fetchedCount: number;
  storedCount: number;
  projectedCount: number;
  blockedReason: string | null;
  checkpointJson: string | null;
  progressed: boolean;
}
```

- [ ] **Step 3: Implement the blockchain adapter**

Create `/Users/xp/vibecoding/pilipili/lib/server/completenessSourceAdapters/blockchain.ts`:

```ts
import 'server-only';

import { buildActivityFeed } from '@/lib/activityFeed';
import { upsertFeedSnapshot, upsertRawTransactions } from '@/lib/server/feedSnapshotRepo';
import { validateAndPersistPeakAssetSnapshots } from '@/lib/server/assetPeakValidation';
import { markAddressesSynced, listTrackedUsers } from '@/lib/server/trackedUsersRepo';

const DEFAULT_BLOCKCHAIN_STEP_MS = 7 * 24 * 60 * 60 * 1000;

export function resolveBlockchainStepWindow(input: {
  configuredStartMs: number;
  currentProvenStartMs: number | null;
  endMs: number;
  maxStepMs?: number;
}) {
  const currentStart = input.currentProvenStartMs ?? input.endMs;
  const beginMs = Math.max(input.configuredStartMs, currentStart - (input.maxStepMs || DEFAULT_BLOCKCHAIN_STEP_MS));
  return {
    beginMs,
    endMs: currentStart,
  };
}

export async function runBlockchainCompletenessStep(input: {
  configuredStartMs: number;
  currentProvenStartMs: number | null;
  endMs: number;
}) {
  const users = listTrackedUsers();
  const window = resolveBlockchainStepWindow(input);
  const result = await buildActivityFeed(users, {
    beginMs: window.beginMs,
    endMs: window.endMs,
    requireTrackedInitiator: true,
  });

  upsertRawTransactions(result.rawTransactions);
  upsertFeedSnapshot(result.feed);
  await validateAndPersistPeakAssetSnapshots({
    users,
    addressAssets: result.addressAssets,
    userAssets: result.userAssets,
  });

  markAddressesSynced(
    result.diagnostics
      .filter((item) => item.ok)
      .map((item) => ({ chain: item.chain, address: item.address, syncedAt: Date.now() }))
  );

  const hasFailures = result.diagnostics.some((item) => !item.ok);
  return {
    source: 'blockchain' as const,
    status: !hasFailures && window.beginMs <= input.configuredStartMs ? 'complete' : 'partial',
    requestedStartMs: input.configuredStartMs,
    provenStartMs: hasFailures ? input.currentProvenStartMs : window.beginMs,
    provenEndMs: input.endMs,
    fetchedCount: result.summary.transactionCount,
    storedCount: result.feed.length,
    projectedCount: result.feed.length,
    blockedReason: null,
    checkpointJson: JSON.stringify(window),
    progressed: !hasFailures && (input.currentProvenStartMs === null || window.beginMs < input.currentProvenStartMs),
  };
}
```

- [ ] **Step 4: Implement the Twitter adapter and reusable proof helper**

Create `/Users/xp/vibecoding/pilipili/lib/server/completenessSourceAdapters/twitter.ts`:

```ts
import 'server-only';

import { readTwitterCursor } from '@/lib/server/twitterRepo';
import { runTwitterSyncAction } from '@/lib/server/twitterSyncService';

export function resolveTwitterSourceProvenStartMs(input: {
  timeline: { coveredSinceMs: number | null };
  replies: { coveredSinceMs: number | null };
}) {
  if (input.timeline.coveredSinceMs === null || input.replies.coveredSinceMs === null) {
    return null;
  }
  return Math.max(input.timeline.coveredSinceMs, input.replies.coveredSinceMs);
}

export async function runTwitterCompletenessStep(input: {
  userId?: string | null;
  configuredStartMs: number;
  nowMs: number;
}) {
  const windowDays = Math.max(1, Math.min(30, Math.ceil((input.nowMs - input.configuredStartMs) / (24 * 60 * 60 * 1000))));
  const syncResult = await runTwitterSyncAction({
    action: 'sync',
    userId: input.userId || null,
    windowDays,
    force: true,
  });

  if (!syncResult.ok) {
    return {
      source: 'twitter' as const,
      status: 'retrying' as const,
      requestedStartMs: input.configuredStartMs,
      provenStartMs: null,
      provenEndMs: input.nowMs,
      fetchedCount: 0,
      storedCount: 0,
      projectedCount: 0,
      blockedReason: syncResult.error,
      checkpointJson: null,
      progressed: false,
    };
  }

  const trackedUsers = (input.userId ? [input.userId] : []).filter(Boolean);
  const candidates = trackedUsers.length > 0 ? trackedUsers : [];
  const proofStarts = candidates.map((userId) =>
    resolveTwitterSourceProvenStartMs({
      timeline: { coveredSinceMs: readTwitterCursor(userId, 'timeline')?.coveredSinceMs ?? null },
      replies: { coveredSinceMs: readTwitterCursor(userId, 'replies')?.coveredSinceMs ?? null },
    })
  );
  const provenStartMs =
    proofStarts.length > 0
      ? proofStarts.reduce<number | null>((best, current) => {
          if (current === null) return null;
          if (best === null) return current;
          return Math.max(best, current);
        }, null)
      : null;

  return {
    source: 'twitter' as const,
    status:
      provenStartMs !== null && provenStartMs <= input.configuredStartMs && syncResult.status !== 'partial'
        ? 'complete'
        : 'partial',
    requestedStartMs: input.configuredStartMs,
    provenStartMs,
    provenEndMs: input.nowMs,
    fetchedCount: Number((syncResult.summary as { fetchedCount?: number }).fetchedCount || 0),
    storedCount: Number((syncResult.summary as { storedCount?: number }).storedCount || 0),
    projectedCount: Number((syncResult.summary as { projectedCount?: number }).projectedCount || 0),
    blockedReason: null,
    checkpointJson: JSON.stringify({ windowDays }),
    progressed: provenStartMs !== null,
  };
}
```

Update `/Users/xp/vibecoding/pilipili/lib/server/twitterSyncService.ts` by exporting the absolute-start helper:

```ts
export function computeWindowDaysFromAbsoluteStart(startMs: number, nowMs = Date.now()) {
  if (!(startMs > 0) || nowMs <= startMs) {
    return 1;
  }

  const DAY_MS = 24 * 60 * 60 * 1000;
  return Math.max(1, Math.min(30, Math.ceil((nowMs - startMs) / DAY_MS)));
}
```

- [ ] **Step 5: Wire the adapters into the orchestrator**

Update `/Users/xp/vibecoding/pilipili/lib/server/completenessMaintenanceService.ts` so `runSource()` dispatches by source id:

```ts
import { runBlockchainCompletenessStep } from '@/lib/server/completenessSourceAdapters/blockchain';
import { runTwitterCompletenessStep } from '@/lib/server/completenessSourceAdapters/twitter';

async function defaultRunSource(input: { source: CompletenessSource; configuredStartMs: number | null }) {
  if (input.configuredStartMs === null) {
    throw new Error('configuredStartMs is required');
  }

  if (input.source === 'blockchain') {
    return runBlockchainCompletenessStep({
      configuredStartMs: input.configuredStartMs,
      currentProvenStartMs: null,
      endMs: Date.now(),
    });
  }

  if (input.source === 'twitter') {
    return runTwitterCompletenessStep({
      configuredStartMs: input.configuredStartMs,
      nowMs: Date.now(),
    });
  }

  throw new Error(`unsupported completeness source: ${input.source}`);
}
```

- [ ] **Step 6: Run the focused adapter and regression tests**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-global-completeness-window-full-scope
npm run test:completeness-source-adapters
npm run test:twitter-sync-service
npm run test:feed-prewarm-service
```

Expected: all commands pass

- [ ] **Step 7: Commit the blockchain/Twitter adapters**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-global-completeness-window-full-scope
git add lib/server/completenessSourceAdapters/types.ts lib/server/completenessSourceAdapters/blockchain.ts lib/server/completenessSourceAdapters/twitter.ts lib/server/completenessMaintenanceService.ts lib/server/twitterSyncService.ts scripts/test-completeness-source-adapters.ts
git commit -m "feat: add completeness blockchain and twitter adapters"
```

Expected: commit created successfully

### Task 5: Upgrade Telegram History Access And Add The Bridge/Channel Adapters

**Files:**
- Create: `/Users/xp/vibecoding/pilipili/lib/server/completenessSourceAdapters/telegramBridge.ts`
- Create: `/Users/xp/vibecoding/pilipili/lib/server/completenessSourceAdapters/telegramChannel.ts`
- Modify: `/Users/xp/vibecoding/pilipili/lib/server/telegramChannelTypes.ts`
- Modify: `/Users/xp/vibecoding/pilipili/lib/server/telegramGramjsClient.ts`
- Modify: `/Users/xp/vibecoding/pilipili/lib/server/telegramBridgeMtprotoBackfill.ts`
- Modify: `/Users/xp/vibecoding/pilipili/lib/server/telegramChannelSync.ts`
- Modify: `/Users/xp/vibecoding/pilipili/lib/server/completenessMaintenanceService.ts`
- Test: `/Users/xp/vibecoding/pilipili/scripts/test-completeness-source-adapters.ts`
- Test: `/Users/xp/vibecoding/pilipili/scripts/test-telegram-channel-provider.ts`
- Test: `/Users/xp/vibecoding/pilipili/scripts/test-telegram-mtproto-upgrades.ts`

- [ ] **Step 1: Extend the Telegram history interfaces**

Update `/Users/xp/vibecoding/pilipili/lib/server/telegramChannelTypes.ts`:

```ts
export interface TelegramChannelSyncClient {
  resolveChannel(input: TelegramChannelResolveInput): Promise<TelegramChannelResolved>;
  listChannelMessages(params: {
    source: TelegramChannelSource;
    resolved: TelegramChannelResolved;
    minMessageId: number | null;
    beforeMessageId?: number | null;
    limit?: number;
  }): Promise<TelegramChannelRemoteMessage[]>;
  listBridgeChatMessages?(params: {
    chatId: string;
    limit: number;
    beforeMessageId?: number | null;
    startMs?: number | null;
    endMs?: number | null;
  }): Promise<import('../../scripts/telegram-bridge-core').TelegramMessageLike[]>;
  disconnect?(): Promise<void>;
}
```

- [ ] **Step 2: Implement backward pagination in the GramJS client**

Update `/Users/xp/vibecoding/pilipili/lib/server/telegramGramjsClient.ts`:

```ts
for await (const message of client.iterMessages(entityRef, {
  limit: params.limit || 50,
  minId: params.minMessageId || 0,
  maxId: params.beforeMessageId || 0,
})) {
  // map and collect
}
```

And for bridge chat history:

```ts
for await (const message of client.iterMessages(entity, {
  limit: params.limit,
  maxId: params.beforeMessageId || 0,
})) {
  const mapped = toBridgeMessage(params.chatId, message as unknown as Record<string, unknown>);
  if (!mapped) continue;
  const messageTimeMs = typeof mapped.date === 'number' ? mapped.date * 1000 : 0;
  if (params.endMs && messageTimeMs > params.endMs) continue;
  if (params.startMs && messageTimeMs < params.startMs) {
    results.push(mapped);
    break;
  }
  results.push(mapped);
}
```

- [ ] **Step 3: Convert bridge backfill into bounded backward history scanning**

Update `/Users/xp/vibecoding/pilipili/lib/server/telegramBridgeMtprotoBackfill.ts` by replacing the current latest-N loop with:

```ts
export async function backfillTelegramBridgeHistory(params: {
  client: TelegramChannelSyncClient;
  limitPerChat?: number;
  beforeMessageIdByChat?: Record<string, number | null>;
  startMs?: number | null;
  endMs?: number | null;
}) {
  // fetch per-chat batches using beforeMessageId
  // ingest newest-to-oldest or oldest-to-newest consistently
  // return oldestScannedMessageIdByChat and oldestScannedMessageTimeMsByChat
}
```

The result object must include:

```ts
{
  chatCount: number;
  fetchedCount: number;
  ingestedCount: number;
  ignoredCount: number;
  oldestScannedMessageIdByChat: Record<string, number | null>;
  oldestScannedMessageTimeMsByChat: Record<string, number | null>;
}
```

- [ ] **Step 4: Split Telegram channel incremental sync from historical proof scanning**

Update `/Users/xp/vibecoding/pilipili/lib/server/telegramChannelSync.ts` by keeping the existing incremental behavior in `syncTelegramChannelSource()` and adding:

```ts
export async function backfillTelegramChannelSourceHistory(params: {
  sourceId: string;
  client: TelegramChannelSyncClient;
  beforeMessageId?: number | null;
  startMs: number;
  endMs: number;
  limit?: number;
  fetchTweetsByIds?: (ids: string[]) => Promise<{ provider: string; tweets: UpsertTwitterTweetInput[] }>;
}) {
  // resolve channel
  // list older messages using beforeMessageId
  // upsert raw posts + ingest
  // return oldestScannedMessageId, oldestScannedMessageTimeMs, storedCount, projectedCount
}
```

- [ ] **Step 5: Implement the Telegram bridge and channel adapters**

Create `/Users/xp/vibecoding/pilipili/lib/server/completenessSourceAdapters/telegramBridge.ts`:

```ts
import 'server-only';

import { backfillTelegramBridgeHistory } from '@/lib/server/telegramBridgeMtprotoBackfill';

export async function runTelegramBridgeCompletenessStep(input: {
  configuredStartMs: number;
  checkpoint: { beforeMessageIdByChat?: Record<string, number | null> } | null;
  client: import('@/lib/server/telegramChannelTypes').TelegramChannelSyncClient;
}) {
  const result = await backfillTelegramBridgeHistory({
    client: input.client,
    limitPerChat: 100,
    beforeMessageIdByChat: input.checkpoint?.beforeMessageIdByChat || {},
    startMs: input.configuredStartMs,
    endMs: Date.now(),
  });

  const provenStartMsValues = Object.values(result.oldestScannedMessageTimeMsByChat).filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value)
  );
  const provenStartMs =
    provenStartMsValues.length === Object.keys(result.oldestScannedMessageTimeMsByChat).length
      ? Math.max(...provenStartMsValues)
      : null;

  return {
    source: 'telegram-bridge' as const,
    status: provenStartMs !== null && provenStartMs <= input.configuredStartMs ? 'complete' : 'partial',
    requestedStartMs: input.configuredStartMs,
    provenStartMs,
    provenEndMs: Date.now(),
    fetchedCount: result.fetchedCount,
    storedCount: result.ingestedCount,
    projectedCount: result.ingestedCount,
    blockedReason: null,
    checkpointJson: JSON.stringify({ beforeMessageIdByChat: result.oldestScannedMessageIdByChat }),
    progressed: result.fetchedCount > 0,
  };
}
```

Create `/Users/xp/vibecoding/pilipili/lib/server/completenessSourceAdapters/telegramChannel.ts`:

```ts
import 'server-only';

import { createTelegramGramjsClient } from '@/lib/server/telegramGramjsClient';
import { listTelegramChannelSources } from '@/lib/server/telegramChannelSourceRepo';
import { backfillTelegramChannelSourceHistory } from '@/lib/server/telegramChannelSync';

export async function runTelegramChannelCompletenessStep(input: {
  configuredStartMs: number;
  checkpointBySourceId: Record<string, { beforeMessageId?: number | null }>;
}) {
  const client = await createTelegramGramjsClient();
  try {
    const enabledSources = listTelegramChannelSources({ enabledOnly: true });
    let provenStartMs: number | null = null;
    let storedCount = 0;
    let projectedCount = 0;
    const nextCheckpointBySourceId: Record<string, { beforeMessageId?: number | null }> = {};

    for (const source of enabledSources) {
      const result = await backfillTelegramChannelSourceHistory({
        sourceId: source.id,
        client,
        beforeMessageId: input.checkpointBySourceId[source.id]?.beforeMessageId ?? null,
        startMs: input.configuredStartMs,
        endMs: Date.now(),
      });
      storedCount += result.storedCount;
      projectedCount += result.projectedCount;
      nextCheckpointBySourceId[source.id] = { beforeMessageId: result.oldestScannedMessageId };
      if (result.oldestScannedMessageTimeMs === null) {
        provenStartMs = null;
      } else {
        provenStartMs = provenStartMs === null ? result.oldestScannedMessageTimeMs : Math.max(provenStartMs, result.oldestScannedMessageTimeMs);
      }
    }

    return {
      source: 'telegram-channel' as const,
      status: provenStartMs !== null && provenStartMs <= input.configuredStartMs ? 'complete' : 'partial',
      requestedStartMs: input.configuredStartMs,
      provenStartMs,
      provenEndMs: Date.now(),
      fetchedCount: storedCount,
      storedCount,
      projectedCount,
      blockedReason: null,
      checkpointJson: JSON.stringify(nextCheckpointBySourceId),
      progressed: storedCount > 0,
    };
  } finally {
    await client.disconnect?.();
  }
}
```

- [ ] **Step 6: Wire the TG adapters into the orchestrator**

Update `/Users/xp/vibecoding/pilipili/lib/server/completenessMaintenanceService.ts`:

```ts
import { runTelegramBridgeCompletenessStep } from '@/lib/server/completenessSourceAdapters/telegramBridge';
import { runTelegramChannelCompletenessStep } from '@/lib/server/completenessSourceAdapters/telegramChannel';

if (input.source === 'telegram-bridge') {
  return runTelegramBridgeCompletenessStep({
    configuredStartMs: input.configuredStartMs,
    checkpoint: null,
    client: await createTelegramGramjsClient(),
  });
}

if (input.source === 'telegram-channel') {
  return runTelegramChannelCompletenessStep({
    configuredStartMs: input.configuredStartMs,
    checkpointBySourceId: {},
  });
}
```

- [ ] **Step 7: Run the Telegram-specific verification subset**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-global-completeness-window-full-scope
npm run test:completeness-source-adapters
npm run test:telegram-channel-provider
npm run test:telegram-mtproto-upgrades
```

Expected: all commands pass

- [ ] **Step 8: Commit the Telegram history + adapter work**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-global-completeness-window-full-scope
git add lib/server/telegramChannelTypes.ts lib/server/telegramGramjsClient.ts lib/server/telegramBridgeMtprotoBackfill.ts lib/server/telegramChannelSync.ts lib/server/completenessSourceAdapters/telegramBridge.ts lib/server/completenessSourceAdapters/telegramChannel.ts lib/server/completenessMaintenanceService.ts
git commit -m "feat: add telegram completeness history adapters"
```

Expected: commit created successfully

### Task 6: Add The Independent Maintenance Worker And Realtime Pokes

**Files:**
- Create: `/Users/xp/vibecoding/pilipili/lib/server/completenessMaintenanceWorkerRuntime.ts`
- Create: `/Users/xp/vibecoding/pilipili/scripts/completeness-maintenance-worker.ts`
- Create: `/Users/xp/vibecoding/pilipili/ops/com.xp.pilipili.completeness-maintenance.plist`
- Modify: `/Users/xp/vibecoding/pilipili/scripts/telegram-bridge.ts`
- Modify: `/Users/xp/vibecoding/pilipili/lib/server/telegramChannelWorkerRuntime.ts`
- Test: `/Users/xp/vibecoding/pilipili/scripts/test-completeness-maintenance-service.ts`
- Test: `/Users/xp/vibecoding/pilipili/scripts/test-twitter-bridge.ts`
- Test: `/Users/xp/vibecoding/pilipili/scripts/test-telegram-channel-provider.ts`

- [ ] **Step 1: Implement the maintenance worker runtime**

Create `/Users/xp/vibecoding/pilipili/lib/server/completenessMaintenanceWorkerRuntime.ts`:

```ts
import 'server-only';

import { readSystemConfig } from '@/lib/server/systemConfigRepo';
import { acquireWorkerLease, releaseWorkerLease, touchWorkerHeartbeat, upsertWorkerStatus } from '@/lib/server/workerStateRepo';
import { createCompletenessMaintenanceService } from '@/lib/server/completenessMaintenanceService';
import { readPendingCompletenessPokes, claimCompletenessPokes, deleteClaimedCompletenessPokes } from '@/lib/server/completenessRepo';

const WORKER_KEY = 'completeness-maintenance';
const LEASE_MS = 90_000;
const HEARTBEAT_MS = 30_000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export async function runCompletenessMaintenanceCycle() {
  const service = createCompletenessMaintenanceService();
  const pokes = readPendingCompletenessPokes(50);
  if (pokes.length > 0) {
    claimCompletenessPokes(pokes.map((poke) => poke.id), Date.now());
    await service.runOnce({ trigger: 'ingest', reason: 'claimed-pokes' });
    deleteClaimedCompletenessPokes(pokes.map((poke) => poke.id));
    return { sleepMs: 1_000 };
  }

  if (readSystemConfig().completenessStartMs) {
    await service.runOnce({ trigger: 'interval', reason: 'periodic-sweep' });
  }

  return { sleepMs: SWEEP_INTERVAL_MS };
}
```

- [ ] **Step 2: Add the worker script and launchd entry**

Create `/Users/xp/vibecoding/pilipili/scripts/completeness-maintenance-worker.ts`:

```ts
import os from 'node:os';
import path from 'node:path';

import { acquireWorkerLease, releaseWorkerLease, touchWorkerHeartbeat, upsertWorkerStatus } from '@/lib/server/workerStateRepo';
import { runCompletenessMaintenanceCycle } from '@/lib/server/completenessMaintenanceWorkerRuntime';

import './server-only-shim.cjs';
import { loadEnvFile } from './telegram-bridge-core';

loadEnvFile(path.join(process.cwd(), '.env.local'));

const WORKER_KEY = 'completeness-maintenance';
const LEASE_MS = 90_000;

function ownerId() {
  return `${os.hostname()}:${process.pid}`;
}

async function run() {
  while (true) {
    if (!acquireWorkerLease({ workerKey: WORKER_KEY, ownerId: ownerId(), leaseMs: LEASE_MS })) {
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      continue;
    }

    const heartbeat = setInterval(() => {
      touchWorkerHeartbeat(WORKER_KEY);
    }, 30_000);

    try {
      upsertWorkerStatus({ workerKey: WORKER_KEY, workerType: WORKER_KEY, status: 'running' });
      const result = await runCompletenessMaintenanceCycle();
      await new Promise((resolve) => setTimeout(resolve, result.sleepMs));
    } finally {
      clearInterval(heartbeat);
      releaseWorkerLease(WORKER_KEY, ownerId());
    }
  }
}

void run();
```

Create `/Users/xp/vibecoding/pilipili/ops/com.xp.pilipili.completeness-maintenance.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.xp.pilipili.completeness-maintenance</string>
    <key>WorkingDirectory</key>
    <string>/Users/xp/vibecoding/pilipili</string>
    <key>ProgramArguments</key>
    <array>
      <string>/Users/xp/.nvm/versions/node/v24.11.1/bin/node</string>
      <string>/Users/xp/vibecoding/pilipili/node_modules/tsx/dist/cli.mjs</string>
      <string>scripts/completeness-maintenance-worker.ts</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
  </dict>
</plist>
```

- [ ] **Step 3: Emit completeness pokes from the realtime bridge worker**

Update `/Users/xp/vibecoding/pilipili/scripts/telegram-bridge.ts`:

```ts
import { queueCompletenessPoke } from '@/lib/server/completenessRepo';

// after successful telegram-monitor or twitter-relay ingest
queueCompletenessPoke({
  trigger: 'ingest',
  sourceHint: result.kind === 'twitter-relay' ? 'telegram-bridge' : 'telegram-bridge',
  reason: 'bridge-message-ingested',
});

// after lease recovery
queueCompletenessPoke({
  trigger: 'recovery',
  sourceHint: 'telegram-bridge',
  reason: 'bridge-lease-recovered',
});
```

- [ ] **Step 4: Emit completeness pokes from the Telegram channel worker runtime**

Update `/Users/xp/vibecoding/pilipili/lib/server/telegramChannelWorkerRuntime.ts`:

```ts
import { queueCompletenessPoke } from '@/lib/server/completenessRepo';

if (result.projectedCount > 0 || result.storedCount > 0) {
  queueCompletenessPoke({
    trigger: 'ingest',
    sourceHint: 'telegram-channel',
    reason: 'channel-sync-progress',
  });
}

if (result.errorCount === 0 && result.sourceCount > 0) {
  queueCompletenessPoke({
    trigger: 'recovery',
    sourceHint: 'telegram-channel',
    reason: 'channel-sync-recovered',
  });
}
```

- [ ] **Step 5: Verify worker-facing regressions**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-global-completeness-window-full-scope
npm run test:completeness-maintenance-service
npm run test:twitter-bridge
npm run test:telegram-channel-provider
```

Expected: all commands pass

- [ ] **Step 6: Commit worker integration**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-global-completeness-window-full-scope
git add lib/server/completenessMaintenanceWorkerRuntime.ts scripts/completeness-maintenance-worker.ts ops/com.xp.pilipili.completeness-maintenance.plist scripts/telegram-bridge.ts lib/server/telegramChannelWorkerRuntime.ts
git commit -m "feat: add completeness worker and realtime pokes"
```

Expected: commit created successfully

### Task 7: Expose Operator APIs And System Controls

**Files:**
- Create: `/Users/xp/vibecoding/pilipili/app/api/completeness/route.ts`
- Create: `/Users/xp/vibecoding/pilipili/scripts/test-completeness-api.ts`
- Modify: `/Users/xp/vibecoding/pilipili/app/system/page.tsx`
- Modify: `/Users/xp/vibecoding/pilipili/lib/server/completenessRepo.ts`
- Test: `/Users/xp/vibecoding/pilipili/scripts/test-completeness-api.ts`
- Test: `/Users/xp/vibecoding/pilipili/package.json`

Sequencing note: do not start `Task 7` until `Tasks 2-6` are merged. The operator API depends on repo functions from `Task 2`, targeted `runOnce()` support from `Task 3`, and source/worker state created by `Tasks 4-6`.

- [ ] **Step 1: Write the failing completeness API test**

Create `/Users/xp/vibecoding/pilipili/scripts/test-completeness-api.ts`:

```ts
import assert from 'node:assert/strict';

import { readSystemConfig, saveSystemConfig } from '@/lib/server/systemConfigRepo';
import { readCompletenessGlobalState, saveCompletenessGlobalState, saveCompletenessSourceState } from '@/lib/server/completenessRepo';

function run() {
  saveSystemConfig({ completenessStartMs: 1_700_000_000_000 });
  saveCompletenessGlobalState({
    configuredStartMs: 1_700_000_000_000,
    globalProvenStartMs: 1_700_000_500_000,
    status: 'partial',
    activeRunId: 7,
    lastSuccessAt: 1_700_000_700_000,
    lastFailureAt: null,
  });
  saveCompletenessSourceState({
    source: 'telegram-channel',
    requestedStartMs: 1_700_000_000_000,
    provenStartMs: null,
    provenEndMs: 1_700_000_700_000,
    status: 'partial',
    failureCount: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    blockedReason: null,
    checkpointJson: JSON.stringify({ sourceA: { beforeMessageId: 88 } }),
  });

  assert.equal(readSystemConfig().completenessStartMs, 1_700_000_000_000);
  assert.equal(readCompletenessGlobalState()?.activeRunId, 7);

  console.log('completeness api tests: ok');
}

run();
```

- [ ] **Step 2: Extend the completeness repo and implement the completeness API route**

First update `/Users/xp/vibecoding/pilipili/lib/server/completenessRepo.ts`:

```ts
export function readCompletenessRecentRuns(limit: number) {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, reason, trigger, configured_start_ms, status, started_at, finished_at, global_proven_start_ms, summary_json
       FROM completeness_runs
       ORDER BY started_at DESC
       LIMIT ?`
    )
    .all(limit);
}

export function resetCompletenessSourceCheckpoint(source: CompletenessSource) {
  const db = getDb();
  db.prepare(
    `UPDATE completeness_source_state
     SET checkpoint_json = NULL,
         failure_count = 0,
         blocked_reason = NULL,
         status = 'partial',
         updated_at = ?
     WHERE source = ?`
  ).run(Date.now(), source);
}
```

Create `/Users/xp/vibecoding/pilipili/app/api/completeness/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/server/apiGuard';
import { createCompletenessMaintenanceService } from '@/lib/server/completenessMaintenanceService';
import {
  readCompletenessGlobalState,
  readCompletenessRecentRuns,
  readCompletenessSourceStates,
  resetCompletenessSourceCheckpoint,
} from '@/lib/server/completenessRepo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({
    ok: true,
    global: readCompletenessGlobalState(),
    sources: readCompletenessSourceStates(),
    runs: readCompletenessRecentRuns(20),
  });
}

export async function POST(request: NextRequest) {
  const unauthorizedResponse = requireAdmin(request);
  if (unauthorizedResponse) {
    return unauthorizedResponse;
  }

  const body = (await request.json().catch(() => ({}))) as {
    action?: 'run-now' | 'retry-source' | 'clear-source-checkpoint';
    source?: 'blockchain' | 'twitter' | 'telegram-bridge' | 'telegram-channel';
  };

  if (body.action === 'clear-source-checkpoint' && body.source) {
    resetCompletenessSourceCheckpoint(body.source);
    return NextResponse.json({ ok: true });
  }

  const service = createCompletenessMaintenanceService();
  const result = await service.runOnce({
    trigger: body.action === 'retry-source' ? 'recovery' : 'manual',
    reason: body.action || 'run-now',
    source: body.action === 'retry-source' ? body.source || null : null,
  });
  return NextResponse.json({ ok: true, result });
}
```

- [ ] **Step 3: Extend the system page with completeness controls**

Update `/Users/xp/vibecoding/pilipili/app/system/page.tsx` by adding state for the new config and API payload:

```ts
const [completenessStartMs, setCompletenessStartMs] = useState('');
const [completenessState, setCompletenessState] = useState<{
  global?: {
    configuredStartMs?: number | null;
    globalProvenStartMs?: number | null;
    status?: string;
    activeRunId?: number | null;
  } | null;
  sources?: Array<{
    source: string;
    status: string;
    provenStartMs: number | null;
    provenEndMs: number | null;
    failureCount: number;
    blockedReason: string | null;
  }>;
} | null>(null);
```

Fetch it alongside system config:

```ts
void fetch('/api/completeness', { cache: 'no-store' })
  .then((res) => res.json())
  .then((payload) => {
    if (!payload?.ok) return;
    setCompletenessState(payload);
  })
  .catch(() => undefined);
```

Send `completenessStartMs` in `saveConfig()`:

```ts
body: JSON.stringify({
  telegramUnknownPersonAlertChatId: alertChatId.trim() || null,
  telegramTradeMonitorSourceChatId: tradeMonitorChatId.trim() || null,
  telegramTwitterMonitorSourceChatId: twitterMonitorChatId.trim() || null,
  conflictNotificationTelegramChatId: conflictAlertChatId.trim() || null,
  twitterRelayCoveredPollingIntervalMinutes: relayCoveredPollingIntervalMinutes.trim(),
  twitterUncoveredPollingIntervalMinutes: uncoveredPollingIntervalMinutes.trim(),
  completenessStartMs: completenessStartMs.trim() || null,
})
```

Render a new section:

```tsx
<section className="rounded-xl border border-zinc-800/60 bg-zinc-900/50 p-5">
  <h2 className="mb-3 text-sm font-medium">全局完备窗口</h2>
  <div className="grid gap-3 md:grid-cols-[16rem_auto_auto] md:items-end">
    <div>
      <Label className="text-zinc-400">completenessStartMs</Label>
      <Input value={completenessStartMs} onChange={(e) => setCompletenessStartMs(e.target.value)} placeholder="Unix ms" />
    </div>
    <Button onClick={() => runCompletenessAction('run-now')}>立即维护</Button>
    <Button variant="outline" onClick={() => refreshCompletenessState()}>刷新状态</Button>
  </div>
  <div className="mt-4 text-sm text-zinc-300">
    <div>全局状态：{completenessState?.global?.status || 'unknown'}</div>
    <div>目标起点：{formatDateTime(completenessState?.global?.configuredStartMs ?? null)}</div>
    <div>共同证明起点：{formatDateTime(completenessState?.global?.globalProvenStartMs ?? null)}</div>
  </div>
</section>
```

- [ ] **Step 4: Run the API/UI-oriented verification subset**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-global-completeness-window-full-scope
npm run test:completeness-api
npm run build
```

Expected: both commands pass

- [ ] **Step 5: Commit the operator surface**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-global-completeness-window-full-scope
git add app/api/completeness/route.ts app/system/page.tsx scripts/test-completeness-api.ts lib/server/completenessRepo.ts
git commit -m "feat: add completeness operator api and system ui"
```

Expected: commit created successfully

### Task 8: Switch Feed Completeness Reads To Unified State And Finalize Verification

**Files:**
- Modify: `/Users/xp/vibecoding/pilipili/lib/server/feedViewMeta.ts`
- Modify: `/Users/xp/vibecoding/pilipili/app/api/feed/route.ts`
- Modify: `/Users/xp/vibecoding/pilipili/lib/server/feedPrewarmService.ts`
- Test: `/Users/xp/vibecoding/pilipili/scripts/test-feed-prewarm-service.ts`
- Test: `/Users/xp/vibecoding/pilipili/scripts/test-feed-completeness-visibility.ts`
- Test: `/Users/xp/vibecoding/pilipili/package.json`

- [ ] **Step 1: Replace legacy completeness-window inference in `feedViewMeta.ts`**

Update `/Users/xp/vibecoding/pilipili/lib/server/feedViewMeta.ts`:

```ts
import { readCompletenessGlobalState, readCompletenessSourceStates } from '@/lib/server/completenessRepo';

export function readFeedViewMeta(options?: { userId?: string | null; endMs?: number | null }) {
  const userId = typeof options?.userId === 'string' && options.userId.trim() ? options.userId.trim() : null;
  const completenessGlobal = readCompletenessGlobalState();
  const completenessSources = readCompletenessSourceStates();
  const startMs = completenessGlobal?.globalProvenStartMs ?? null;
  const endMs = normalizeTimestamp(options?.endMs);

  return {
    activityBreakdown: userId ? readActivityBreakdownByUser(userId) : null,
    completenessWindow: {
      scope: userId ? 'user' : 'global',
      startMs,
      endMs,
      label: buildCompletenessLabel(startMs, endMs),
      complete: completenessGlobal?.status === 'complete' && completenessSources.every((source) => source.status === 'complete'),
    },
  };
}
```

- [ ] **Step 2: Stop treating `/api/feed` prewarm as the authoritative completeness trigger**

Update `/Users/xp/vibecoding/pilipili/app/api/feed/route.ts` so it reads but does not own completeness:

```ts
const prewarm = readPrewarmProgressSnapshot();
const completeness = readCompletenessGlobalState();

return {
  ok: true,
  prewarm,
  completeness: {
    status: completeness?.status || 'idle',
    configuredStartMs: completeness?.configuredStartMs ?? null,
    globalProvenStartMs: completeness?.globalProvenStartMs ?? null,
  },
  // existing feed payload
};
```

Do not add new calls that trigger `triggerSync()` or `runTwitterSyncAction()` for completeness ownership. Leave the refresh/backfill behavior as responsiveness-only legacy behavior.

- [ ] **Step 3: Demote feed prewarm to a non-authoritative UX helper**

Update `/Users/xp/vibecoding/pilipili/lib/server/feedPrewarmService.ts` by adding an early exit:

```ts
import { readSystemConfig } from '@/lib/server/systemConfigRepo';

export function triggerStartupPrewarmIfNeeded(deps?: TriggerStartupPrewarmDeps) {
  const completenessStartMs = readSystemConfig().completenessStartMs;
  if (typeof completenessStartMs === 'number' && Number.isFinite(completenessStartMs)) {
    return { started: false, reason: 'completeness-worker-authoritative' as const, status: getSyncStatus() };
  }

  // existing prewarm behavior
}
```

- [ ] **Step 4: Run the end-to-end verification subset**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-global-completeness-window-full-scope
npm run test:feed-prewarm-service
npm run test:feed-completeness-visibility
npm run test:completeness-repo
npm run test:completeness-status
npm run test:completeness-maintenance-service
npm run test:completeness-source-adapters
npm run test:completeness-api
npm run test:twitter-sync-service
npm run test:telegram-channel-provider
npm run test:telegram-mtproto-upgrades
npm run build
```

Expected: all commands pass

- [ ] **Step 5: Perform a final manual smoke check**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-global-completeness-window-full-scope
npm run dev
```

Then verify in the browser:

```text
1. Open http://localhost:3005/system
2. Save a completenessStartMs value
3. Trigger “立即维护”
4. Confirm per-source rows render and incomplete TG sources block global complete
5. Open http://localhost:3005/ and confirm the feed completeness banner reads from unified completeness state
```

Expected: system page shows the configured start, the proven start, and strict per-source status; feed page no longer implies completeness purely from legacy 7-day prewarm

- [ ] **Step 6: Commit the read-model switch and verification**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-global-completeness-window-full-scope
git add lib/server/feedViewMeta.ts app/api/feed/route.ts lib/server/feedPrewarmService.ts
git commit -m "feat: route feed completeness through unified maintenance state"
```

Expected: commit created successfully

### Task 9: Final Review, Full Test Pass, And Execution Handoff

**Files:**
- Modify: `/Users/xp/vibecoding/pilipili/docs/superpowers/plans/2026-05-05-global-completeness-window-full-scope.md`
- Test: `/Users/xp/vibecoding/pilipili/package.json`

- [ ] **Step 1: Run the full project test suite**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-global-completeness-window-full-scope
npm test
```

Expected: all registered tests pass

- [ ] **Step 2: Run the production build one more time**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-global-completeness-window-full-scope
npm run build
```

Expected: build succeeds without Next.js runtime or type errors

- [ ] **Step 3: Review the final diff**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-global-completeness-window-full-scope
git status --short
git diff --stat
```

Expected: only intended tracked files are modified

- [ ] **Step 4: Create the integration commit**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-global-completeness-window-full-scope
git add .
git commit -m "feat: add unified completeness maintenance system"
```

Expected: final integration commit created successfully

- [ ] **Step 5: Handoff for subagent-driven execution**

Run:

```text
Dispatch subagents in this order:
- Main integrator: Task 1
- Worker A: Task 2
- Worker B: Task 3 (after Task 2)
- Worker C: Task 4 + Task 5 (same worker, after Task 3)
- Worker D: Task 6 + Task 7 (same worker, after Task 4 + Task 5)
- Main integrator: Task 8 + Task 9
```

Expected: no overlapping write ownership on `lib/server/completenessMaintenanceService.ts`, `lib/server/completenessRepo.ts`, or `scripts/test-completeness-source-adapters.ts` before the final integration task

---

## Spec Coverage Check

- Global configured start, strict global status, and non-shrinking promise are implemented by Tasks 2, 3, and 7.
- Independent backend maintenance worker is implemented by Task 6.
- All four source adapters are covered by Tasks 4 and 5.
- Realtime worker poke integration is covered by Task 6.
- Feed/status/operator read-model changes are covered by Tasks 7 and 8.
- Verification requirements are covered by Tasks 1, 4, 5, 8, and 9.

## Notes For The Integrator

- Do not claim completeness from Telegram history until backward pagination crosses the configured start.
- Do not let `/api/feed` or startup prewarm reclaim ownership of historical completeness.
- Keep the configured start immutable unless the operator explicitly changes it through system config.
- Prefer extending existing repos/services where they already own the data, but keep completeness-specific policy in the new completeness modules instead of spreading it back through `syncService.ts`, `feedPrewarmService.ts`, or the current TG workers.
