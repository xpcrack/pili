# Feed 7 天预补齐与多源一致性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现“秒切 + 启动自动补齐近 7 天 + 多源一致性收敛 + 冲突实时 Telegram 通知（可配置群 ID）”。

**Architecture:** 前台读取与后台补齐解耦：前台只读本地快照并支持请求抢占；后台按时间线补齐 7 天并持续写入快照。多源事件统一走 canonical 对账层，冲突落库后按“链上 API 优先、Twitter OpenCLI 优先”收敛，并通过内置 tgbot 逐条实时通知。

**Tech Stack:** Next.js 16.2.3 (App Router), TypeScript, better-sqlite3, Zustand, Node `tsx` 脚本测试。

---

## Scope Check
本 spec 包含 4 个子系统（前台请求调度、后台预补齐、对账冲突仓储、通知与设置）。这些子系统可并行实现，但必须在同一发布窗口集成。该计划将其拆成 6 个任务，每个任务可独立验证并提交。

## File Structure（先锁定边界）

### 前台请求抢占与秒切
- Create: `lib/feed/requestArbiter.ts`
- Modify: `lib/activitiesApi.ts`
- Modify: `hooks/useActivityPolling.ts`
- Responsibility: 管理 foreground/background 请求优先级，允许 foreground 抢占 background。

### 7 天预补齐状态与接口
- Create: `lib/server/feedPrewarmService.ts`
- Create: `app/api/feed/prewarm/route.ts`
- Modify: `app/api/feed/route.ts`
- Modify: `hooks/useActivityPolling.ts`
- Modify: `app/page.tsx`
- Responsibility: 启动自动预补齐、状态计算、进度透出和顶部轻量展示。

### 多源一致性与冲突检测
- Create: `lib/server/sourceReconciliation.ts`
- Modify: `lib/server/eventsRepo.ts`
- Responsibility: 比较同 canonical 事件的归一化结果，生成字段级 diff 与收敛决策。

### 冲突仓储与通知队列
- Modify: `lib/server/sqlite.ts`
- Create: `lib/server/conflictRepo.ts`
- Responsibility: 冲突落库、去重、通知队列、重试状态。

### 配置与系统页
- Modify: `lib/server/systemConfigRepo.ts`
- Modify: `app/api/system-config/route.ts`
- Modify: `app/system/page.tsx`
- Responsibility: 新增 `conflictNotificationTelegramChatId` 配置项并可视化编辑。

### 实时通知与重试
- Create: `lib/server/conflictNotifier.ts`
- Modify: `lib/server/eventsRepo.ts`
- Modify: `lib/server/syncService.ts`
- Responsibility: 逐条实时发送冲突通知，失败指数退避并保留待补发。

### Tests
- Create: `scripts/test-feed-request-arbiter.ts`
- Create: `scripts/test-feed-prewarm-service.ts`
- Create: `scripts/test-source-reconciliation.ts`
- Create: `scripts/test-conflict-repo.ts`
- Create: `scripts/test-system-config-conflict-chat.ts`
- Create: `scripts/test-conflict-notifier.ts`
- Modify: `package.json`（补充测试脚本并接入 `npm test`）

---

### Task 1: 前台请求抢占（实现“秒切”基础）

**Files:**
- Create: `lib/feed/requestArbiter.ts`
- Create: `scripts/test-feed-request-arbiter.ts`
- Modify: `lib/activitiesApi.ts`
- Modify: `hooks/useActivityPolling.ts`
- Test: `scripts/test-feed-request-arbiter.ts`

- [ ] **Step 1: 写失败测试（请求优先级与抢占）**

```ts
// scripts/test-feed-request-arbiter.ts
import assert from 'node:assert/strict';
import { FeedRequestArbiter } from '@/lib/feed/requestArbiter';

function run() {
  const arbiter = new FeedRequestArbiter();

  const bg = arbiter.start('background');
  assert.equal(bg.accepted, true);

  const fg = arbiter.start('foreground');
  assert.equal(fg.accepted, true);
  assert.equal(bg.abortedByPreemption?.(), true);

  const bg2 = arbiter.start('background');
  assert.equal(bg2.accepted, false);
  assert.equal(bg2.reason, 'foreground_inflight');

  fg.finish();
  const fg2 = arbiter.start('foreground');
  assert.equal(fg2.accepted, true);
  fg2.finish();

  console.log('feed request arbiter tests: ok');
}

run();
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx tsx scripts/test-feed-request-arbiter.ts`  
Expected: FAIL，提示 `Cannot find module '@/lib/feed/requestArbiter'`。

- [ ] **Step 3: 实现请求仲裁器**

```ts
// lib/feed/requestArbiter.ts
export type FeedRequestPriority = 'foreground' | 'background';

export interface FeedRequestTicket {
  accepted: boolean;
  reason?: 'foreground_inflight' | 'background_inflight';
  abortedByPreemption?: () => boolean;
  finish: () => void;
}

interface ActiveRequest {
  id: number;
  priority: FeedRequestPriority;
  aborted: boolean;
}

export class FeedRequestArbiter {
  private seq = 0;
  private active: ActiveRequest | null = null;

  start(priority: FeedRequestPriority): FeedRequestTicket {
    const current = this.active;
    if (!current) {
      return this.createAccepted(priority);
    }

    if (current.priority === 'foreground' && priority === 'background') {
      return {
        accepted: false,
        reason: 'foreground_inflight',
        finish: () => undefined,
      };
    }

    if (current.priority === 'background' && priority === 'foreground') {
      current.aborted = true;
      return this.createAccepted(priority, current);
    }

    return {
      accepted: false,
      reason: priority === 'foreground' ? 'foreground_inflight' : 'background_inflight',
      finish: () => undefined,
    };
  }

  private createAccepted(priority: FeedRequestPriority, preempted?: ActiveRequest): FeedRequestTicket {
    const request: ActiveRequest = {
      id: ++this.seq,
      priority,
      aborted: false,
    };
    this.active = request;

    return {
      accepted: true,
      abortedByPreemption: preempted ? () => preempted.aborted : () => false,
      finish: () => {
        if (this.active?.id === request.id) {
          this.active = null;
        }
      },
    };
  }
}
```

- [ ] **Step 4: 接入到拉取链路（foreground 可抢占）**

```ts
// lib/activitiesApi.ts (新增参数并透传 signal)
interface FetchAllActivitiesOptions {
  page?: number;
  pageSize?: number;
  userId?: string | null;
  search?: string | null;
  syncStrategy?: 'refresh' | 'local' | 'backfill';
  backfillScope?: 'global' | 'user';
  backfillUserId?: string | null;
  reason?: string;
  signal?: AbortSignal;
}

// fetch 调用处
response = await fetch(`/api/feed?${query.toString()}`, {
  method,
  headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
  body: method === 'POST' ? JSON.stringify(bodyPayload) : undefined,
  cache: 'no-store',
  signal: options?.signal ?? controller.signal,
});
```

```ts
// hooks/useActivityPolling.ts (使用仲裁器)
import { FeedRequestArbiter } from '@/lib/feed/requestArbiter';

const arbiterRef = useRef(new FeedRequestArbiter());

const priority = syncStrategy === 'local' ? 'foreground' : 'background';
const ticket = arbiterRef.current.start(priority);
if (!ticket.accepted) {
  return {
    feedLength: feedRef.current.length,
    selectedFeedLength: currentSelectedFeedLength,
    totalAvailable: Math.max(feedRef.current.length, summary?.transactionCount ?? 0),
    success: false,
    error: ticket.reason === 'foreground_inflight' ? '前台请求进行中' : '后台请求跳过',
  };
}

const controller = new AbortController();

try {
  const result = await fetchAllActivities(currentUsers, {
    page: 1,
    pageSize: requestLimit,
    userId: selectedUserId,
    search: searchQuery,
    syncStrategy,
    backfillScope: syncStrategy === 'backfill' ? backfillScope : undefined,
    backfillUserId: selectedUserId,
    reason: syncStrategy === 'backfill' ? 'expand-user-backfill-7d' : 'feed-local-read',
    signal: controller.signal,
  });
  // ... existing success path
} finally {
  ticket.finish();
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx tsx scripts/test-feed-request-arbiter.ts`  
Expected: PASS，输出 `feed request arbiter tests: ok`。

- [ ] **Step 6: Commit**

```bash
git add lib/feed/requestArbiter.ts lib/activitiesApi.ts hooks/useActivityPolling.ts scripts/test-feed-request-arbiter.ts
git commit -m "feat(feed): add foreground-preemptive request arbiter for instant switching"
```

---

### Task 2: 启动自动预补齐近 7 天 + 顶部轻量进度

**Files:**
- Create: `lib/server/feedPrewarmService.ts`
- Create: `app/api/feed/prewarm/route.ts`
- Create: `scripts/test-feed-prewarm-service.ts`
- Modify: `app/api/feed/route.ts`
- Modify: `hooks/useActivityPolling.ts`
- Modify: `app/page.tsx`
- Test: `scripts/test-feed-prewarm-service.ts`

- [ ] **Step 1: 写失败测试（预补齐状态计算）**

```ts
// scripts/test-feed-prewarm-service.ts
import assert from 'node:assert/strict';
import { computePrewarmProgress } from '@/lib/server/feedPrewarmService';

function run() {
  const now = Date.now();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  const eightDaysMs = 8 * 24 * 60 * 60 * 1000;

  const running = computePrewarmProgress({
    now,
    targetBeginMs: now - sevenDaysMs,
    globalEarliestMs: now - 2 * 24 * 60 * 60 * 1000,
    usersTotal: 10,
    usersCovered: 3,
    running: true,
  });
  assert.equal(running.label, '补齐中 3/10 地址（近7天）');

  const done = computePrewarmProgress({
    now,
    targetBeginMs: now - sevenDaysMs,
    globalEarliestMs: now - eightDaysMs,
    usersTotal: 10,
    usersCovered: 10,
    running: false,
  });
  assert.equal(done.label, '近7天已补齐');

  console.log('feed prewarm service tests: ok');
}

run();
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx tsx scripts/test-feed-prewarm-service.ts`  
Expected: FAIL，提示缺少 `lib/server/feedPrewarmService`。

- [ ] **Step 3: 实现预补齐服务与状态计算**

```ts
// lib/server/feedPrewarmService.ts
import 'server-only';

import { getSyncStatus, triggerSync } from '@/lib/server/syncService';
import { listTrackedUsers } from '@/lib/server/trackedUsersRepo';

export interface FeedPrewarmProgressInput {
  now: number;
  targetBeginMs: number;
  globalEarliestMs: number | null;
  usersTotal: number;
  usersCovered: number;
  running: boolean;
}

export function computePrewarmProgress(input: FeedPrewarmProgressInput) {
  const done = typeof input.globalEarliestMs === 'number' && input.globalEarliestMs <= input.targetBeginMs;
  if (done) {
    return {
      done: true,
      label: '近7天已补齐',
    };
  }

  return {
    done: false,
    label: `补齐中 ${input.usersCovered}/${Math.max(1, input.usersTotal)} 地址（近7天）`,
  };
}

export function triggerStartupPrewarmIfNeeded() {
  const status = getSyncStatus();
  const now = Date.now();
  const targetBeginMs = now - 7 * 24 * 60 * 60 * 1000;
  const globalEarliestMs = status.windowState?.globalEarliestMs ?? null;

  const alreadyCovered = typeof globalEarliestMs === 'number' && globalEarliestMs <= targetBeginMs;
  if (alreadyCovered) {
    return { started: false, reason: 'already-covered' as const, status };
  }

  const trigger = triggerSync('startup-prewarm-7d', {
    mode: 'backfill',
    scope: 'global',
    userId: null,
  });

  return { started: trigger.started, reason: 'triggered' as const, trigger, status: getSyncStatus() };
}

export function readPrewarmProgressSnapshot() {
  const status = getSyncStatus();
  const users = listTrackedUsers();
  const covered = users.filter((u) => {
    const earliest = status.windowState?.perUserEarliestMs?.[u.id];
    return typeof earliest === 'number';
  }).length;

  const now = Date.now();
  const targetBeginMs = now - 7 * 24 * 60 * 60 * 1000;
  const progress = computePrewarmProgress({
    now,
    targetBeginMs,
    globalEarliestMs: status.windowState?.globalEarliestMs ?? null,
    usersTotal: users.length,
    usersCovered: covered,
    running: status.running,
  });

  return {
    running: status.running,
    ...progress,
    usersTotal: users.length,
    usersCovered: covered,
  };
}
```

- [ ] **Step 4: 接入 API + 页面轻量状态展示**

```ts
// app/api/feed/prewarm/route.ts
import { NextResponse } from 'next/server';
import { readPrewarmProgressSnapshot, triggerStartupPrewarmIfNeeded } from '@/lib/server/feedPrewarmService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ ok: true, prewarm: readPrewarmProgressSnapshot() });
}

export async function POST() {
  const trigger = triggerStartupPrewarmIfNeeded();
  return NextResponse.json({ ok: true, trigger, prewarm: readPrewarmProgressSnapshot() });
}
```

```ts
// hooks/useActivityPolling.ts (增加 prewarm 状态)
const [prewarmLabel, setPrewarmLabel] = useState<string | null>(null);

useEffect(() => {
  void fetch('/api/feed/prewarm', { method: 'POST', cache: 'no-store' })
    .then((res) => res.json())
    .then((payload) => {
      if (payload?.ok && payload.prewarm?.label) {
        setPrewarmLabel(payload.prewarm.label as string);
      }
    })
    .catch(() => undefined);
}, []);

return {
  // ...existing fields
  prewarmLabel,
};
```

```tsx
// app/page.tsx (顶部 summary 下方展示)
const { prewarmLabel } = useActivityPolling(selectedUserId, searchInput);

{prewarmLabel && (
  <div className="mb-4 rounded-lg border border-zinc-800/60 bg-zinc-900/50 p-3 text-xs text-zinc-400">
    {prewarmLabel}
  </div>
)}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx tsx scripts/test-feed-prewarm-service.ts`  
Expected: PASS，输出 `feed prewarm service tests: ok`。

- [ ] **Step 6: Commit**

```bash
git add lib/server/feedPrewarmService.ts app/api/feed/prewarm/route.ts app/api/feed/route.ts hooks/useActivityPolling.ts app/page.tsx scripts/test-feed-prewarm-service.ts
git commit -m "feat(feed): add startup 7d prewarm service and lightweight progress label"
```

---

### Task 3: 多源 canonical 对账与冲突决策核心

**Files:**
- Create: `lib/server/sourceReconciliation.ts`
- Create: `scripts/test-source-reconciliation.ts`
- Modify: `lib/server/eventsRepo.ts`
- Test: `scripts/test-source-reconciliation.ts`

- [ ] **Step 1: 写失败测试（字段 diff + winner 规则）**

```ts
// scripts/test-source-reconciliation.ts
import assert from 'node:assert/strict';
import { diffActivityForConflict, chooseConflictWinner } from '@/lib/server/sourceReconciliation';
import type { Activity } from '@/types';

function makeActivity(overrides: Partial<Activity['metadata']>): Activity {
  return {
    id: 'a1',
    userId: 'u1',
    source: 'blockchain',
    type: 'transfer',
    content: 'x',
    timestamp: 1710000000000,
    metadata: {
      chain: 'bsc',
      txHash: '0xabc',
      trackedAddress: '0xwallet',
      token: 'AAA',
      value: '1',
      txAction: 'buy',
      ...overrides,
    },
  };
}

function run() {
  const left = makeActivity({ value: '1', token: 'AAA' });
  const right = makeActivity({ value: '2', token: 'AAA' });

  const diff = diffActivityForConflict(left, right);
  assert.equal(diff.length, 1);
  assert.equal(diff[0]?.field, 'value');

  const onchainWinner = chooseConflictWinner('onchain');
  assert.equal(onchainWinner, 'api');

  const twitterWinner = chooseConflictWinner('twitter');
  assert.equal(twitterWinner, 'opencli');

  console.log('source reconciliation tests: ok');
}

run();
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx tsx scripts/test-source-reconciliation.ts`  
Expected: FAIL，提示缺少 `lib/server/sourceReconciliation`。

- [ ] **Step 3: 实现对账模块**

```ts
// lib/server/sourceReconciliation.ts
import 'server-only';

import type { Activity } from '@/types';

export type ConflictDomain = 'onchain' | 'twitter';
export type ConflictWinner = 'api' | 'opencli';

export interface ConflictFieldDiff {
  field: string;
  left: string;
  right: string;
}

function normalize(value: unknown) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  return JSON.stringify(value);
}

export function diffActivityForConflict(left: Activity, right: Activity): ConflictFieldDiff[] {
  const fields: Array<keyof Activity['metadata']> = [
    'token',
    'tokenAddress',
    'value',
    'quoteToken',
    'quoteAmount',
    'txAction',
    'txActionVariant',
    'displayWalletLabel',
    'displayTradeAmountText',
    'displayTokenSymbol',
    'displayMarketCapText',
  ];

  return fields.flatMap((field) => {
    const l = normalize(left.metadata[field]);
    const r = normalize(right.metadata[field]);
    if (l === r) return [];
    return [{ field, left: l, right: r }];
  });
}

export function chooseConflictWinner(domain: ConflictDomain): ConflictWinner {
  if (domain === 'onchain') {
    return 'api';
  }
  return 'opencli';
}

export function detectConflictDomain(activity: Activity): ConflictDomain {
  return activity.source === 'twitter' ? 'twitter' : 'onchain';
}
```

- [ ] **Step 4: 在 events upsert 流程中挂接冲突检测入口**

```ts
// lib/server/eventsRepo.ts (在 mergeActivityForUpsert 前后引入)
import {
  detectConflictDomain,
  diffActivityForConflict,
  chooseConflictWinner,
} from '@/lib/server/sourceReconciliation';

const diff = existingActivity ? diffActivityForConflict(existingActivity, incoming) : [];
if (existingActivity && diff.length > 0) {
  const domain = detectConflictDomain(incoming);
  const winner = chooseConflictWinner(domain);
  // Task 4/6 会把这里接到冲突仓储 + 通知
  console.info('[eventsRepo] conflict detected', { eventId, domain, winner, fields: diff.map((d) => d.field) });
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx tsx scripts/test-source-reconciliation.ts`  
Expected: PASS，输出 `source reconciliation tests: ok`。

- [ ] **Step 6: Commit**

```bash
git add lib/server/sourceReconciliation.ts lib/server/eventsRepo.ts scripts/test-source-reconciliation.ts
git commit -m "feat(reconcile): add canonical conflict diff and winner policy"
```

---

### Task 4: 冲突仓储与通知队列表

**Files:**
- Modify: `lib/server/sqlite.ts`
- Create: `lib/server/conflictRepo.ts`
- Create: `scripts/test-conflict-repo.ts`
- Test: `scripts/test-conflict-repo.ts`

- [ ] **Step 1: 写失败测试（冲突去重与队列入队）**

```ts
// scripts/test-conflict-repo.ts
import assert from 'node:assert/strict';
import { getDb } from '@/lib/server/sqlite';
import {
  upsertConflictRecord,
  enqueueConflictNotification,
  readPendingConflictNotifications,
} from '@/lib/server/conflictRepo';

function run() {
  const db = getDb();
  db.prepare("DELETE FROM feed_conflict_notifications WHERE conflict_key LIKE 'test:%'").run();
  db.prepare("DELETE FROM feed_conflicts WHERE conflict_key LIKE 'test:%'").run();

  const conflictId = upsertConflictRecord({
    conflictKey: 'test:c1',
    domain: 'onchain',
    eventKey: 'e1',
    winner: 'api',
    diffJson: [{ field: 'value', left: '1', right: '2' }],
  });

  const conflictId2 = upsertConflictRecord({
    conflictKey: 'test:c1',
    domain: 'onchain',
    eventKey: 'e1',
    winner: 'api',
    diffJson: [{ field: 'value', left: '1', right: '2' }],
  });

  assert.equal(conflictId2, conflictId);

  enqueueConflictNotification(conflictId, 'test:c1');
  enqueueConflictNotification(conflictId, 'test:c1');

  const pending = readPendingConflictNotifications(10);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.conflictKey, 'test:c1');

  console.log('conflict repo tests: ok');
}

run();
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx tsx scripts/test-conflict-repo.ts`  
Expected: FAIL，提示表或模块不存在。

- [ ] **Step 3: 增加表结构与仓储实现**

```sql
-- lib/server/sqlite.ts (SCHEMA_SQL 追加)
CREATE TABLE IF NOT EXISTS feed_conflicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conflict_key TEXT NOT NULL UNIQUE,
  domain TEXT NOT NULL,
  event_key TEXT NOT NULL,
  winner TEXT NOT NULL,
  diff_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feed_conflicts_created
ON feed_conflicts(created_at DESC);

CREATE TABLE IF NOT EXISTS feed_conflict_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conflict_id INTEGER NOT NULL,
  conflict_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER,
  last_error TEXT,
  sent_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (conflict_id) REFERENCES feed_conflicts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_feed_conflict_notifications_pending
ON feed_conflict_notifications(status, next_retry_at, id);
```

```ts
// lib/server/conflictRepo.ts
import 'server-only';
import { getDb } from '@/lib/server/sqlite';

export function upsertConflictRecord(input: {
  conflictKey: string;
  domain: 'onchain' | 'twitter';
  eventKey: string;
  winner: 'api' | 'opencli';
  diffJson: Array<{ field: string; left: string; right: string }>;
}) {
  const db = getDb();
  const now = Date.now();

  db.prepare(
    `INSERT INTO feed_conflicts (conflict_key, domain, event_key, winner, diff_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(conflict_key) DO UPDATE SET
       domain = excluded.domain,
       event_key = excluded.event_key,
       winner = excluded.winner,
       diff_json = excluded.diff_json,
       updated_at = excluded.updated_at`
  ).run(input.conflictKey, input.domain, input.eventKey, input.winner, JSON.stringify(input.diffJson), now, now);

  const row = db
    .prepare('SELECT id FROM feed_conflicts WHERE conflict_key = ? LIMIT 1')
    .get(input.conflictKey) as { id: number } | undefined;

  if (!row?.id) {
    throw new Error('failed to load conflict row id');
  }

  return row.id;
}

export function enqueueConflictNotification(conflictId: number, conflictKey: string) {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO feed_conflict_notifications (
      conflict_id, conflict_key, status, attempt_count, next_retry_at, created_at, updated_at
     ) VALUES (?, ?, 'pending', 0, ?, ?, ?)
     ON CONFLICT(conflict_key) DO NOTHING`
  ).run(conflictId, conflictKey, now, now, now);
}

export function readPendingConflictNotifications(limit: number) {
  const db = getDb();
  const now = Date.now();
  return db.prepare(
    `SELECT n.id, n.conflict_id, n.conflict_key, n.attempt_count, c.domain, c.event_key, c.winner, c.diff_json
     FROM feed_conflict_notifications n
     INNER JOIN feed_conflicts c ON c.id = n.conflict_id
     WHERE n.status = 'pending'
       AND (n.next_retry_at IS NULL OR n.next_retry_at <= ?)
     ORDER BY n.id ASC
     LIMIT ?`
  ).all(now, Math.max(1, Math.floor(limit))) as Array<{
    id: number;
    conflict_id: number;
    conflict_key: string;
    attempt_count: number;
    domain: 'onchain' | 'twitter';
    event_key: string;
    winner: 'api' | 'opencli';
    diff_json: string;
  }>;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx tsx scripts/test-conflict-repo.ts`  
Expected: PASS，输出 `conflict repo tests: ok`。

- [ ] **Step 5: Commit**

```bash
git add lib/server/sqlite.ts lib/server/conflictRepo.ts scripts/test-conflict-repo.ts
git commit -m "feat(conflict): add conflict persistence and notification queue tables"
```

---

### Task 5: 配置项与系统页（新增冲突通知群 ID）

**Files:**
- Modify: `lib/server/systemConfigRepo.ts`
- Modify: `app/api/system-config/route.ts`
- Modify: `app/system/page.tsx`
- Create: `scripts/test-system-config-conflict-chat.ts`
- Test: `scripts/test-system-config-conflict-chat.ts`

- [ ] **Step 1: 写失败测试（配置读写新字段）**

```ts
// scripts/test-system-config-conflict-chat.ts
import assert from 'node:assert/strict';
import { readSystemConfig, saveSystemConfig } from '@/lib/server/systemConfigRepo';

function run() {
  const before = readSystemConfig();

  const saved = saveSystemConfig({
    conflictNotificationTelegramChatId: '-100999888777',
  });
  assert.equal(saved.conflictNotificationTelegramChatId, '-100999888777');

  const again = readSystemConfig();
  assert.equal(again.conflictNotificationTelegramChatId, '-100999888777');

  saveSystemConfig({
    conflictNotificationTelegramChatId: before.conflictNotificationTelegramChatId,
  });

  console.log('system config conflict chat tests: ok');
}

run();
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx tsx scripts/test-system-config-conflict-chat.ts`  
Expected: FAIL，提示 `conflictNotificationTelegramChatId` 不存在。

- [ ] **Step 3: 修改配置仓储和 API 字段**

```ts
// lib/server/systemConfigRepo.ts (SystemConfigSnapshot)
export interface SystemConfigSnapshot {
  telegramUnknownPersonAlertChatId: string | null;
  telegramTradeMonitorSourceChatId: string | null;
  telegramTwitterMonitorSourceChatId: string | null;
  conflictNotificationTelegramChatId: string | null;
}

// normalizeSnapshot return 增加字段
conflictNotificationTelegramChatId: normalizeOptionalString(candidate.conflictNotificationTelegramChatId),

// saveSystemConfig merge 增加字段
conflictNotificationTelegramChatId:
  input.conflictNotificationTelegramChatId !== undefined
    ? normalizeOptionalString(input.conflictNotificationTelegramChatId)
    : current.conflictNotificationTelegramChatId,
```

```ts
// app/api/system-config/route.ts (PATCH body parse)
const config = saveSystemConfig({
  // ...existing fields
  conflictNotificationTelegramChatId:
    body.conflictNotificationTelegramChatId === null
      ? null
      : typeof body.conflictNotificationTelegramChatId === 'string'
        ? body.conflictNotificationTelegramChatId
        : undefined,
});
```

- [ ] **Step 4: 修改系统页表单与保存载荷**

```tsx
// app/system/page.tsx
const [conflictAlertChatId, setConflictAlertChatId] = useState('');

// 初始化加载
setConflictAlertChatId(payload.config?.conflictNotificationTelegramChatId || '');

// 保存
body: JSON.stringify({
  telegramUnknownPersonAlertChatId: alertChatId.trim() || null,
  telegramTradeMonitorSourceChatId: tradeMonitorChatId.trim() || null,
  telegramTwitterMonitorSourceChatId: twitterMonitorChatId.trim() || null,
  conflictNotificationTelegramChatId: conflictAlertChatId.trim() || null,
}),

// UI 输入框（新增）
<div>
  <Label className="text-zinc-400">冲突通知群 Chat ID</Label>
  <Input
    value={conflictAlertChatId}
    onChange={(e) => setConflictAlertChatId(e.target.value)}
    placeholder="例如: -1001234567890"
    className="border-zinc-800 bg-zinc-950"
  />
  <p className="mt-2 text-xs text-zinc-500">用于多源冲突实时逐条通知。</p>
</div>
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx tsx scripts/test-system-config-conflict-chat.ts`  
Expected: PASS，输出 `system config conflict chat tests: ok`。

- [ ] **Step 6: Commit**

```bash
git add lib/server/systemConfigRepo.ts app/api/system-config/route.ts app/system/page.tsx scripts/test-system-config-conflict-chat.ts
git commit -m "feat(system): add configurable telegram chat id for conflict notifications"
```

---

### Task 6: 冲突实时通知（逐条）+ 指数退避重试

**Files:**
- Create: `lib/server/conflictNotifier.ts`
- Create: `scripts/test-conflict-notifier.ts`
- Modify: `lib/server/conflictRepo.ts`
- Modify: `lib/server/eventsRepo.ts`
- Modify: `lib/server/syncService.ts`
- Test: `scripts/test-conflict-notifier.ts`

- [ ] **Step 1: 写失败测试（实时发送 + 重试入队）**

```ts
// scripts/test-conflict-notifier.ts
import assert from 'node:assert/strict';
import { getDb } from '@/lib/server/sqlite';
import { saveSystemConfig } from '@/lib/server/systemConfigRepo';
import {
  upsertConflictRecord,
  enqueueConflictNotification,
  readPendingConflictNotifications,
  markConflictNotificationSent,
  markConflictNotificationRetry,
} from '@/lib/server/conflictRepo';

function run() {
  const db = getDb();
  db.prepare("DELETE FROM feed_conflict_notifications WHERE conflict_key LIKE 'notify:%'").run();
  db.prepare("DELETE FROM feed_conflicts WHERE conflict_key LIKE 'notify:%'").run();

  saveSystemConfig({ conflictNotificationTelegramChatId: '-100123456' });

  const conflictId = upsertConflictRecord({
    conflictKey: 'notify:c1',
    domain: 'twitter',
    eventKey: 'event-1',
    winner: 'opencli',
    diffJson: [{ field: 'content', left: 'a', right: 'b' }],
  });

  enqueueConflictNotification(conflictId, 'notify:c1');
  let pending = readPendingConflictNotifications(10);
  assert.equal(pending.length, 1);
  const notificationId = pending[0]!.id;

  markConflictNotificationRetry(notificationId, 'network', 1);
  pending = readPendingConflictNotifications(10);
  assert.equal(pending.length, 0, 'retry window should delay immediate re-send');

  // 强制可重试
  db.prepare("UPDATE feed_conflict_notifications SET next_retry_at = 0 WHERE id = ?").run(notificationId);

  const reloaded = readPendingConflictNotifications(10);
  assert.equal(reloaded.length, 1);
  markConflictNotificationSent(reloaded[0]!.id);
  assert.equal(readPendingConflictNotifications(10).length, 0);

  console.log('conflict notifier tests: ok');
}

run();
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx tsx scripts/test-conflict-notifier.ts`  
Expected: FAIL，提示 `markConflictNotificationSent/Retry` 不存在。

- [ ] **Step 3: 实现 notifier 与队列状态更新函数**

```ts
// lib/server/conflictRepo.ts (新增)
export function markConflictNotificationSent(notificationId: number) {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `UPDATE feed_conflict_notifications
     SET status = 'sent', sent_at = ?, updated_at = ?
     WHERE id = ?`
  ).run(now, now, notificationId);
}

export function markConflictNotificationRetry(notificationId: number, error: string, attemptCount: number) {
  const db = getDb();
  const now = Date.now();
  const safeAttempt = Math.max(1, Math.floor(attemptCount));
  const nextRetryAt = now + Math.min(5 * 60_000, 2 ** safeAttempt * 1000);
  db.prepare(
    `UPDATE feed_conflict_notifications
     SET status = 'pending',
         attempt_count = ?,
         next_retry_at = ?,
         last_error = ?,
         updated_at = ?
     WHERE id = ?`
  ).run(safeAttempt, nextRetryAt, error.slice(0, 1000), now, notificationId);
}
```

```ts
// lib/server/conflictNotifier.ts
import 'server-only';

import { readSystemConfig } from '@/lib/server/systemConfigRepo';
import { sendTelegramTextMessage } from '@/lib/server/telegramNotify';
import {
  readPendingConflictNotifications,
  markConflictNotificationSent,
  markConflictNotificationRetry,
} from '@/lib/server/conflictRepo';

export async function flushConflictNotifications(limit = 20) {
  const config = readSystemConfig();
  const chatId = config.conflictNotificationTelegramChatId?.trim() || '';
  if (!chatId) {
    return { sent: 0, skipped: 0, reason: 'missing-chat-id' as const };
  }

  const pending = readPendingConflictNotifications(limit);
  let sent = 0;

  for (const item of pending) {
    const diff = JSON.parse(item.diff_json) as Array<{ field: string; left: string; right: string }>;
    const text = [
      '⚠️ 多源解析冲突',
      `事件: ${item.event_key}`,
      `域: ${item.domain}`,
      `最终采用: ${item.winner}`,
      `冲突字段: ${diff.map((d) => d.field).join(', ') || 'none'}`,
    ].join('\n');

    const result = await sendTelegramTextMessage({ chatId, text });
    if (result.ok) {
      markConflictNotificationSent(item.id);
      sent += 1;
    } else {
      markConflictNotificationRetry(item.id, result.reason, item.attempt_count + 1);
    }
  }

  return { sent, skipped: pending.length - sent, reason: 'ok' as const };
}
```

- [ ] **Step 4: 在事件写入链路与同步完成节点触发实时发送**

```ts
// lib/server/eventsRepo.ts (检测到 diff 后落库并立刻 flush)
import { upsertConflictRecord, enqueueConflictNotification } from '@/lib/server/conflictRepo';
import { flushConflictNotifications } from '@/lib/server/conflictNotifier';

if (existingActivity && diff.length > 0) {
  const domain = detectConflictDomain(incoming);
  const winner = chooseConflictWinner(domain);
  const conflictKey = `${eventId}:${diff.map((d) => `${d.field}:${d.left}->${d.right}`).join('|')}`;

  const conflictId = upsertConflictRecord({
    conflictKey,
    domain,
    eventKey: eventId,
    winner,
    diffJson: diff,
  });
  enqueueConflictNotification(conflictId, conflictKey);
  void flushConflictNotifications(10);
}
```

```ts
// lib/server/syncService.ts (runSync 成功后再冲刷一次 pending)
import { flushConflictNotifications } from '@/lib/server/conflictNotifier';

await flushConflictNotifications(50);
```

- [ ] **Step 5: 运行测试与回归**

Run: `npx tsx scripts/test-conflict-notifier.ts`  
Expected: PASS，输出 `conflict notifier tests: ok`。

Run: `npm run test`  
Expected: 所有现有脚本 + 新增脚本通过。

- [ ] **Step 6: Commit**

```bash
git add lib/server/conflictNotifier.ts lib/server/conflictRepo.ts lib/server/eventsRepo.ts lib/server/syncService.ts scripts/test-conflict-notifier.ts package.json
git commit -m "feat(conflict): realtime telegram conflict alerts with retry queue"
```

---

## Final Verification Checklist（执行末尾）
- [ ] `npx tsx scripts/test-feed-request-arbiter.ts`
- [ ] `npx tsx scripts/test-feed-prewarm-service.ts`
- [ ] `npx tsx scripts/test-source-reconciliation.ts`
- [ ] `npx tsx scripts/test-conflict-repo.ts`
- [ ] `npx tsx scripts/test-system-config-conflict-chat.ts`
- [ ] `npx tsx scripts/test-conflict-notifier.ts`
- [ ] `npm run test`
- [ ] 手工验证：切人秒切（补齐中连续切换 10 次不粘旧 feed）
- [ ] 手工验证：顶部显示 `补齐中 x/y 地址（近7天）`，完成后显示 `近7天已补齐`
- [ ] 手工验证：构造冲突后 TG 群收到逐条通知

## Spec Self-Review
1. **Spec coverage:**
- 秒切：Task 1
- 启动自动补齐 + 顶部轻量进度：Task 2
- 多源一致性 + 冲突收敛规则：Task 3
- 冲突持久化与去重：Task 4
- 通知群 ID 设置：Task 5
- 实时推送 + 重试：Task 6

2. **Placeholder scan:**
- 已检查，无 `TBD/TODO/implement later` 等占位描述。

3. **Type consistency:**
- 冲突域统一为 `'onchain' | 'twitter'`；赢家统一为 `'api' | 'opencli'`；配置键统一为 `conflictNotificationTelegramChatId`。
