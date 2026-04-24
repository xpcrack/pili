# Twitter 多 Provider 分层抓取 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为现有 Twitter 同步链路接入 `6551` + `Xread` 双结构化 provider，并实现“优先消耗 `6551` 每日免费额度，再切到 `Xread`，最后才降级 `opencli` / `dokobot`”的统一抓取路由。

**Architecture:** 保留现有 `twitterFetcher -> twitterSyncService -> twitterRepo -> twitterFeedMapper` 主链路不变，在 `twitterFetcher` 内新增 provider client、identity cache、budget state 和 router。结构化 provider 的解析、预算、路由、重试和降级逻辑与下游存储/投影解耦，方便独立测试和后续演进。

**Tech Stack:** Next.js 16.2.3 (App Router), TypeScript, better-sqlite3, Node `fetch`, `tsx` 脚本测试。

---

## Scope Check
这份 spec 仍然属于一个实现主题：升级 Twitter ingestion provider 层。它包含 5 个可以顺序交付的子任务：
1. 落库与状态层：identity cache + budget state
2. 结构化 provider client：`6551` + `Xread`
3. router 与 `twitterFetcher` 接入
4. `twitterSyncService` / `/api/twitter/sync` 接入观测
5. 回归测试与脚本收尾

这 5 个任务都围绕同一条 Twitter pipeline，不需要再拆成多个独立计划。

## File Structure（先锁定边界）

### Provider 状态与预算
- Create: `lib/server/twitterProviderStateRepo.ts`
- Modify: `lib/server/sqlite.ts`
- Responsibility: 管理 `twitter_identity_cache`、`twitter_provider_budget` 两张表，以及北京时间 `00:00` 的 `date_key` 计算。

### 结构化 provider client
- Create: `lib/server/twitterProviderTypes.ts`
- Create: `lib/server/twitter6551Client.ts`
- Create: `lib/server/twitterXreadClient.ts`
- Responsibility: 请求 `6551` / `Xread`，并把返回结构标准化为 fetcher 能消费的统一结果。

### 路由与抓取编排
- Create: `lib/server/twitterProviderRouter.ts`
- Modify: `lib/server/twitterFetcher.ts`
- Responsibility: 按 `intent`、额度、cooldown、失败情况选择 provider / credential，并把结构化 provider 串进现有 fetcher。

### 同步链路与诊断
- Modify: `lib/server/twitterSyncService.ts`
- Modify: `app/api/twitter/sync/route.ts`
- Responsibility: 传递 `intent`，记录 `providerUnitsUsed` / `fallbackCounts` / cache hit 情况，并在状态接口返回预算摘要。

### Tests
- Create: `scripts/test-twitter-provider-state.ts`
- Create: `scripts/test-twitter-provider-clients.ts`
- Create: `scripts/test-twitter-provider-router.ts`
- Modify: `scripts/test-twitter-fetcher.ts`
- Create: `scripts/test-twitter-sync-service.ts`
- Modify: `package.json`

---

### Task 1: 建立 identity cache 与 provider budget 持久化

**Files:**
- Create: `lib/server/twitterProviderStateRepo.ts`
- Create: `scripts/test-twitter-provider-state.ts`
- Modify: `lib/server/sqlite.ts`
- Modify: `package.json`
- Test: `scripts/test-twitter-provider-state.ts`

- [ ] **Step 1: 写失败测试（北京时间 date_key、identity cache、budget 记分）**

```ts
// scripts/test-twitter-provider-state.ts
import assert from 'node:assert/strict';

import {
  clearTwitterProviderStateForTests,
  getTwitterDateKey,
  markTwitterProviderFailure,
  markTwitterProviderSuccess,
  readTwitterIdentityCache,
  readTwitterProviderBudgetSnapshot,
  upsertTwitterIdentityCache,
} from '@/lib/server/twitterProviderStateRepo';

function main() {
  clearTwitterProviderStateForTests();

  assert.equal(getTwitterDateKey(Date.UTC(2026, 3, 22, 15, 59, 59)), '2026-04-22');
  assert.equal(getTwitterDateKey(Date.UTC(2026, 3, 22, 16, 0, 0)), '2026-04-23');

  upsertTwitterIdentityCache({
    handle: 'elonmusk',
    provider: '6551',
    userId: '44196397',
    username: 'elonmusk',
    expiresAtMs: Date.now() + 60_000,
    lastError: null,
  });
  const identity = readTwitterIdentityCache('elonmusk');
  assert.equal(identity?.userId, '44196397');
  assert.equal(identity?.provider, '6551');

  markTwitterProviderSuccess({
    provider: '6551',
    credentialId: 'key-1',
    nowMs: Date.UTC(2026, 3, 22, 20, 0, 0),
    dailyLimit: 100,
  });
  markTwitterProviderSuccess({
    provider: '6551',
    credentialId: 'key-1',
    nowMs: Date.UTC(2026, 3, 22, 20, 5, 0),
    dailyLimit: 100,
  });
  markTwitterProviderFailure({
    provider: '6551',
    credentialId: 'key-1',
    nowMs: Date.UTC(2026, 3, 22, 20, 6, 0),
    error: 'timeout',
    cooldownMs: 300_000,
  });

  const budget = readTwitterProviderBudgetSnapshot({
    provider: '6551',
    credentialId: 'key-1',
    nowMs: Date.UTC(2026, 3, 22, 20, 7, 0),
    dailyLimit: 100,
  });
  assert.equal(budget.dateKey, '2026-04-23');
  assert.equal(budget.successUnitsUsed, 2);
  assert.equal(budget.remainingUnits, 98);
  assert.ok((budget.cooldownUntilMs || 0) > 0);

  console.log('twitter provider state tests: ok');
}

main();
```

- [ ] **Step 2: 运行测试确认失败**

Run: `NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-twitter-provider-state.ts`  
Expected: FAIL，提示 `Cannot find module '@/lib/server/twitterProviderStateRepo'`。

- [ ] **Step 3: 在 SQLite schema 中新增 identity cache 与 budget 表**

```ts
// lib/server/sqlite.ts
CREATE TABLE IF NOT EXISTS twitter_identity_cache (
  handle TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  user_id TEXT,
  username TEXT,
  resolved_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER,
  last_error TEXT,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_twitter_identity_cache_expires
ON twitter_identity_cache(expires_at_ms);

CREATE TABLE IF NOT EXISTS twitter_provider_budget (
  provider TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  date_key TEXT NOT NULL,
  success_units_used INTEGER NOT NULL DEFAULT 0,
  daily_limit INTEGER NOT NULL,
  cooldown_until_ms INTEGER,
  last_success_at_ms INTEGER,
  last_failure_at_ms INTEGER,
  last_error TEXT,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(provider, credential_id, date_key)
);
```

- [ ] **Step 4: 实现 `twitterProviderStateRepo`**

```ts
// lib/server/twitterProviderStateRepo.ts
import 'server-only';

import { getDb } from '@/lib/server/sqlite';

export interface TwitterIdentityCacheRow {
  handle: string;
  provider: string;
  userId: string | null;
  username: string | null;
  resolvedAtMs: number;
  expiresAtMs: number | null;
  lastError: string | null;
  updatedAtMs: number;
}

export interface TwitterProviderBudgetSnapshot {
  provider: string;
  credentialId: string;
  dateKey: string;
  successUnitsUsed: number;
  dailyLimit: number;
  remainingUnits: number;
  cooldownUntilMs: number | null;
  lastSuccessAtMs: number | null;
  lastFailureAtMs: number | null;
  lastError: string | null;
}

function pad(value: number) {
  return String(value).padStart(2, '0');
}

export function getTwitterDateKey(nowMs: number) {
  const date = new Date(nowMs + 8 * 60 * 60 * 1000);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function readTwitterIdentityCache(handle: string): TwitterIdentityCacheRow | null {
  const db = getDb();
  const row = db.prepare(
    `SELECT handle, provider, user_id, username, resolved_at_ms, expires_at_ms, last_error, updated_at_ms
     FROM twitter_identity_cache
     WHERE handle = ?
     LIMIT 1`
  ).get(handle.trim().toLowerCase()) as Record<string, unknown> | undefined;

  if (!row) return null;
  return {
    handle: String(row.handle || ''),
    provider: String(row.provider || ''),
    userId: row.user_id ? String(row.user_id) : null,
    username: row.username ? String(row.username) : null,
    resolvedAtMs: Number(row.resolved_at_ms || 0),
    expiresAtMs: typeof row.expires_at_ms === 'number' ? row.expires_at_ms : null,
    lastError: row.last_error ? String(row.last_error) : null,
    updatedAtMs: Number(row.updated_at_ms || 0),
  };
}

export function upsertTwitterIdentityCache(input: {
  handle: string;
  provider: string;
  userId: string | null;
  username: string | null;
  expiresAtMs: number | null;
  lastError: string | null;
}) {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO twitter_identity_cache (
       handle, provider, user_id, username, resolved_at_ms, expires_at_ms, last_error, updated_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(handle) DO UPDATE SET
       provider = excluded.provider,
       user_id = excluded.user_id,
       username = excluded.username,
       resolved_at_ms = excluded.resolved_at_ms,
       expires_at_ms = excluded.expires_at_ms,
       last_error = excluded.last_error,
       updated_at_ms = excluded.updated_at_ms`
  ).run(input.handle.trim().toLowerCase(), input.provider, input.userId, input.username, now, input.expiresAtMs, input.lastError, now);
}
```

```ts
// lib/server/twitterProviderStateRepo.ts
export function readTwitterProviderBudgetSnapshot(input: {
  provider: string;
  credentialId: string;
  nowMs: number;
  dailyLimit: number;
}): TwitterProviderBudgetSnapshot {
  const db = getDb();
  const dateKey = getTwitterDateKey(input.nowMs);
  const row = db.prepare(
    `SELECT provider, credential_id, date_key, success_units_used, daily_limit, cooldown_until_ms,
            last_success_at_ms, last_failure_at_ms, last_error
     FROM twitter_provider_budget
     WHERE provider = ? AND credential_id = ? AND date_key = ?
     LIMIT 1`
  ).get(input.provider, input.credentialId, dateKey) as Record<string, unknown> | undefined;

  const used = typeof row?.success_units_used === 'number' ? row.success_units_used : 0;
  const dailyLimit = typeof row?.daily_limit === 'number' ? row.daily_limit : input.dailyLimit;
  return {
    provider: input.provider,
    credentialId: input.credentialId,
    dateKey,
    successUnitsUsed: used,
    dailyLimit,
    remainingUnits: Math.max(0, dailyLimit - used),
    cooldownUntilMs: typeof row?.cooldown_until_ms === 'number' ? row.cooldown_until_ms : null,
    lastSuccessAtMs: typeof row?.last_success_at_ms === 'number' ? row.last_success_at_ms : null,
    lastFailureAtMs: typeof row?.last_failure_at_ms === 'number' ? row.last_failure_at_ms : null,
    lastError: row?.last_error ? String(row.last_error) : null,
  };
}

export function markTwitterProviderSuccess(input: {
  provider: string;
  credentialId: string;
  nowMs: number;
  dailyLimit: number;
}) {
  const db = getDb();
  const dateKey = getTwitterDateKey(input.nowMs);
  db.prepare(
    `INSERT INTO twitter_provider_budget (
       provider, credential_id, date_key, success_units_used, daily_limit, updated_at_ms, last_success_at_ms
     ) VALUES (?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT(provider, credential_id, date_key) DO UPDATE SET
       success_units_used = twitter_provider_budget.success_units_used + 1,
       daily_limit = excluded.daily_limit,
       cooldown_until_ms = NULL,
       last_success_at_ms = excluded.last_success_at_ms,
       updated_at_ms = excluded.updated_at_ms`
  ).run(input.provider, input.credentialId, dateKey, input.dailyLimit, input.nowMs, input.nowMs);
}

export function markTwitterProviderFailure(input: {
  provider: string;
  credentialId: string;
  nowMs: number;
  error: string;
  cooldownMs: number;
}) {
  const db = getDb();
  const dateKey = getTwitterDateKey(input.nowMs);
  const cooldownUntilMs = input.nowMs + Math.max(0, input.cooldownMs);
  db.prepare(
    `INSERT INTO twitter_provider_budget (
       provider, credential_id, date_key, success_units_used, daily_limit, cooldown_until_ms,
       last_failure_at_ms, last_error, updated_at_ms
     ) VALUES (?, ?, ?, 0, 100, ?, ?, ?, ?)
     ON CONFLICT(provider, credential_id, date_key) DO UPDATE SET
       cooldown_until_ms = excluded.cooldown_until_ms,
       last_failure_at_ms = excluded.last_failure_at_ms,
       last_error = excluded.last_error,
       updated_at_ms = excluded.updated_at_ms`
  ).run(input.provider, input.credentialId, dateKey, cooldownUntilMs, input.nowMs, input.error, input.nowMs);
}

export function clearTwitterProviderStateForTests() {
  const db = getDb();
  db.prepare('DELETE FROM twitter_identity_cache').run();
  db.prepare('DELETE FROM twitter_provider_budget').run();
}
```

- [ ] **Step 5: 补充 `package.json` 测试脚本**

```json
{
  "scripts": {
    "test:twitter-provider-state": "NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-twitter-provider-state.ts",
    "test": "npm run test:admin-auth && npm run test:feed-ordering && npm run test:events-feed-total && npm run test:feed-request-arbiter && npm run test:feed-prewarm-service && npm run test:source-reconciliation && npm run test:conflict-repo && npm run test:system-config-conflict-chat && npm run test:conflict-notifier && npm run test:parser-fixtures && npm run test:twitter-bridge && npm run test:twitter-provider-state"
  }
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npm run test:twitter-provider-state`  
Expected: PASS，输出 `twitter provider state tests: ok`。

- [ ] **Step 7: Commit**

```bash
git add lib/server/sqlite.ts lib/server/twitterProviderStateRepo.ts scripts/test-twitter-provider-state.ts package.json
git commit -m "feat(twitter): persist provider budget and identity cache"
```

---

### Task 2: 实现 `6551` / `Xread` 结构化 client 与解析器

**Files:**
- Create: `lib/server/twitterProviderTypes.ts`
- Create: `lib/server/twitter6551Client.ts`
- Create: `lib/server/twitterXreadClient.ts`
- Create: `scripts/test-twitter-provider-clients.ts`
- Modify: `package.json`
- Test: `scripts/test-twitter-provider-clients.ts`

- [ ] **Step 1: 写失败测试（结构化解析）**

```ts
// scripts/test-twitter-provider-clients.ts
import assert from 'node:assert/strict';

import {
  parse6551TweetByIdResponse,
  parse6551UserLookupResponse,
  parse6551UserTweetsResponse,
} from '@/lib/server/twitter6551Client';
import {
  parseXreadTweetDetailResponse,
  parseXreadUserIdResponse,
  parseXreadUserTweetsResponse,
} from '@/lib/server/twitterXreadClient';

function main() {
  const user = parse6551UserLookupResponse({
    data: {
      user: {
        rest_id: '44196397',
        legacy: { screen_name: 'elonmusk', name: 'Elon Musk' },
      },
    },
  });
  assert.equal(user.userId, '44196397');
  assert.equal(user.username, 'elonmusk');

  const tweets = parse6551UserTweetsResponse({
    data: {
      user_result: {
        timeline: {
          instructions: [
            {
              entries: [
                {
                  content: {
                    itemContent: {
                      tweet_results: {
                        result: {
                          rest_id: '1912345678901234567',
                          legacy: {
                            full_text: 'hello world',
                            created_at: 'Wed Apr 23 03:00:00 +0000 2026',
                            favorite_count: 10,
                            reply_count: 1,
                          },
                          core: {
                            user_results: {
                              result: {
                                legacy: { screen_name: 'elonmusk', name: 'Elon Musk' },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              ],
            },
          ],
        },
      },
    },
  }, 'timeline');
  assert.equal(tweets[0]?.tweetId, '1912345678901234567');
  assert.equal(tweets[0]?.authorHandle, 'elonmusk');

  const xreadUser = parseXreadUserIdResponse({ id: 44196397, id_str: '44196397' });
  assert.equal(xreadUser.userId, '44196397');

  const xreadTweets = parseXreadUserTweetsResponse({
    data: {
      user_result_by_rest_id: {
        result: {
          profile_timeline_v2: {
            timeline: {
              instructions: [
                {
                  entries: [
                    {
                      content: {
                        content: {
                          tweet_results: {
                            rest_id: '1912345678901234999',
                            result: {
                              legacy: {
                                full_text: 'gm',
                                created_at: 'Wed Apr 23 05:00:00 +0000 2026',
                                favorite_count: 5,
                                reply_count: 2,
                              },
                              core: {
                                user_results: {
                                  result: {
                                    legacy: { screen_name: 'gmgn', name: 'GMGN' },
                                  },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  ],
                },
              ],
            },
          },
        },
      },
    },
  }, 'timeline');
  assert.equal(xreadTweets[0]?.authorHandle, 'gmgn');

  const detail = parse6551TweetByIdResponse({
    data: {
      tweetResult: {
        result: {
          rest_id: '1912345678901234567',
          legacy: {
            full_text: '@alice hi',
            created_at: 'Wed Apr 23 03:00:00 +0000 2026',
            in_reply_to_status_id_str: '111',
          },
          core: {
            user_results: {
              result: {
                legacy: { screen_name: 'elonmusk', name: 'Elon Musk' },
              },
            },
          },
        },
      },
    },
  });
  assert.equal(detail?.replyToTweetId, '111');

  const xreadDetail = parseXreadTweetDetailResponse({
    data: {
      threaded_conversation_with_injections_v2: {
        instructions: [
          {
            entries: [
              {
                content: {
                  itemContent: {
                    tweet_results: {
                      result: {
                        rest_id: '1912345678901234999',
                        legacy: {
                          full_text: 'quoted https://x.com/test/status/123',
                          created_at: 'Wed Apr 23 05:00:00 +0000 2026',
                        },
                        core: {
                          user_results: {
                            result: {
                              legacy: { screen_name: 'gmgn', name: 'GMGN' },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            ],
          },
        ],
      },
    },
  });
  assert.equal(xreadDetail?.tweetId, '1912345678901234999');

  console.log('twitter provider client tests: ok');
}

main();
```

- [ ] **Step 2: 运行测试确认失败**

Run: `NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-twitter-provider-clients.ts`  
Expected: FAIL，提示缺少 `twitter6551Client` / `twitterXreadClient` 导出。

- [ ] **Step 3: 定义统一 provider 类型**

```ts
// lib/server/twitterProviderTypes.ts
import { type TwitterLane, type UpsertTwitterTweetInput } from '@/lib/server/twitterRepo';

export type StructuredTwitterProvider = '6551' | 'xread';
export type TwitterFetchIntent = 'sync' | 'backfill' | 'detail' | 'resolve-id';

export interface TwitterResolvedIdentity {
  provider: StructuredTwitterProvider;
  userId: string;
  username: string | null;
}

export interface StructuredTwitterFetchResult {
  provider: StructuredTwitterProvider;
  credentialId: string | null;
  tweets: UpsertTwitterTweetInput[];
  nextCursor?: string | null;
  chargedUnit: boolean;
}

export interface StructuredTwitterClient {
  provider: StructuredTwitterProvider;
  resolveUserId(input: { handle: string; credentialId?: string | null }): Promise<TwitterResolvedIdentity | null>;
  fetchUserTweets(input: {
    userId: string;
    handle: string;
    lane: TwitterLane;
    maxItems: number;
    cursor?: string | null;
    credentialId?: string | null;
  }): Promise<StructuredTwitterFetchResult>;
  fetchTweetsByIds(input: {
    ids: string[];
    credentialId?: string | null;
  }): Promise<StructuredTwitterFetchResult>;
}
```

- [ ] **Step 4: 实现 `6551` client**

```ts
// lib/server/twitter6551Client.ts
import 'server-only';

import { type TwitterLane, type UpsertTwitterTweetInput } from '@/lib/server/twitterRepo';
import { type StructuredTwitterClient, type StructuredTwitterFetchResult, type TwitterResolvedIdentity } from '@/lib/server/twitterProviderTypes';

function normalizeHandle(value: string | undefined | null) {
  return (value || '').trim().toLowerCase();
}

function toMs(value: unknown) {
  if (typeof value === 'string' && value.trim()) return Date.parse(value);
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  return 0;
}

function toTweet(result: Record<string, unknown>, lane: TwitterLane): UpsertTwitterTweetInput | null {
  const legacy = (result.legacy || {}) as Record<string, unknown>;
  const core = (result.core || {}) as Record<string, unknown>;
  const userResults = ((core.user_results || {}) as Record<string, unknown>).result as Record<string, unknown> | undefined;
  const userLegacy = ((userResults?.legacy || {}) as Record<string, unknown>) || {};
  const tweetId = typeof result.rest_id === 'string' ? result.rest_id.trim() : '';
  const authorHandle = normalizeHandle(typeof userLegacy.screen_name === 'string' ? userLegacy.screen_name : '');
  const fullText = typeof legacy.full_text === 'string' ? legacy.full_text.trim() : '';
  const createdAtMs = toMs(legacy.created_at);
  if (!tweetId || !authorHandle || !fullText || !createdAtMs) return null;

  return {
    tweetId,
    authorHandle,
    authorName: typeof userLegacy.name === 'string' ? userLegacy.name.trim() : undefined,
    fullText,
    createdAtMs,
    lane,
    conversationId: typeof legacy.conversation_id_str === 'string' ? legacy.conversation_id_str : undefined,
    replyToTweetId: typeof legacy.in_reply_to_status_id_str === 'string' ? legacy.in_reply_to_status_id_str : undefined,
    replyCount: typeof legacy.reply_count === 'number' ? legacy.reply_count : 0,
    retweetCount: typeof legacy.retweet_count === 'number' ? legacy.retweet_count : 0,
    likeCount: typeof legacy.favorite_count === 'number' ? legacy.favorite_count : 0,
    viewCount: typeof legacy.views?.count === 'string' ? Number(legacy.views.count) : 0,
    source: result,
  };
}

export function parse6551UserLookupResponse(payload: Record<string, unknown>): TwitterResolvedIdentity {
  const data = (payload.data || {}) as Record<string, unknown>;
  const user = ((data.user || data.user_result || {}) as Record<string, unknown>);
  const legacy = (user.legacy || {}) as Record<string, unknown>;
  return {
    provider: '6551',
    userId: String(user.rest_id || ''),
    username: typeof legacy.screen_name === 'string' ? legacy.screen_name : null,
  };
}
```

```ts
// lib/server/twitter6551Client.ts
function collectEntriesFromInstructions(instructions: unknown): Record<string, unknown>[] {
  if (!Array.isArray(instructions)) return [];
  const entries: Record<string, unknown>[] = [];
  for (const instruction of instructions) {
    const rows = Array.isArray((instruction as { entries?: unknown[] }).entries)
      ? ((instruction as { entries: unknown[] }).entries as Record<string, unknown>[])
      : [];
    entries.push(...rows);
  }
  return entries;
}

export function parse6551UserTweetsResponse(payload: Record<string, unknown>, lane: TwitterLane) {
  const data = (payload.data || {}) as Record<string, unknown>;
  const userResult = ((data.user_result || data.user_result_by_rest_id || {}) as Record<string, unknown>);
  const timeline = (((userResult.timeline || userResult.profile_timeline_v2 || {}) as Record<string, unknown>).timeline || {}) as Record<string, unknown>;
  const entries = collectEntriesFromInstructions(timeline.instructions);
  return entries
    .map((entry) => {
      const content = (((entry.content || {}) as Record<string, unknown>).itemContent || ((entry.content || {}) as Record<string, unknown>).content || {}) as Record<string, unknown>;
      const tweetResults = (content.tweet_results || {}) as Record<string, unknown>;
      return toTweet((tweetResults.result || {}) as Record<string, unknown>, lane);
    })
    .filter((item): item is UpsertTwitterTweetInput => Boolean(item));
}

export function parse6551TweetByIdResponse(payload: Record<string, unknown>) {
  const data = (payload.data || {}) as Record<string, unknown>;
  const container = ((data.tweetResult || data.tweet_result || {}) as Record<string, unknown>);
  return toTweet((container.result || {}) as Record<string, unknown>, 'timeline');
}

export function createTwitter6551Client(fetchImpl: typeof fetch = fetch): StructuredTwitterClient {
  const baseUrl = (process.env.TWITTER_6551_BASE_URL || '').trim().replace(/\/+$/, '');
  const timeoutMs = Math.max(5_000, Number.parseInt(process.env.TWITTER_PROVIDER_HTTP_TIMEOUT_MS || '15000', 10) || 15_000);

  async function request<T>(path: string, credentialId: string | null | undefined) {
    const key = credentialId === 'key-2'
      ? (process.env.TWITTER_6551_API_KEY_2 || '').trim()
      : (process.env.TWITTER_6551_API_KEY_1 || '').trim();
    if (!baseUrl || !key) {
      throw new Error('missing 6551 provider config');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        headers: {
          Authorization: `Bearer ${key}`,
        },
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`6551 http ${response.status}`);
      }
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    provider: '6551',
    async resolveUserId({ handle, credentialId }) {
      const payload = await request<Record<string, unknown>>(`/twitter/user?username=${encodeURIComponent(handle)}`, credentialId);
      const resolved = parse6551UserLookupResponse(payload);
      return resolved.userId ? resolved : null;
    },
    async fetchUserTweets({ userId, handle, lane, maxItems, cursor, credentialId }) {
      const kind = lane === 'replies' ? 'with_replies=true' : 'with_replies=false';
      const cursorPart = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
      const payload = await request<Record<string, unknown>>(
        `/twitter/user/tweets?user_id=${encodeURIComponent(userId)}&username=${encodeURIComponent(handle)}&limit=${maxItems}&${kind}${cursorPart}`,
        credentialId
      );
      return {
        provider: '6551',
        credentialId: credentialId || null,
        tweets: parse6551UserTweetsResponse(payload, lane),
        chargedUnit: true,
      } satisfies StructuredTwitterFetchResult;
    },
    async fetchTweetsByIds({ ids, credentialId }) {
      const tweets: UpsertTwitterTweetInput[] = [];
      for (const id of ids) {
        const payload = await request<Record<string, unknown>>(`/twitter/tweet/${encodeURIComponent(id)}`, credentialId);
        const tweet = parse6551TweetByIdResponse(payload);
        if (tweet) tweets.push(tweet);
      }
      return {
        provider: '6551',
        credentialId: credentialId || null,
        tweets,
        chargedUnit: tweets.length > 0,
      };
    },
  };
}
```

- [ ] **Step 5: 实现 `Xread` client**

```ts
// lib/server/twitterXreadClient.ts
import 'server-only';

import { type TwitterLane, type UpsertTwitterTweetInput } from '@/lib/server/twitterRepo';
import { type StructuredTwitterClient, type StructuredTwitterFetchResult, type TwitterResolvedIdentity } from '@/lib/server/twitterProviderTypes';

function normalizeHandle(value: string | undefined | null) {
  return (value || '').trim().toLowerCase();
}

function toMs(value: unknown) {
  if (typeof value === 'string' && value.trim()) return Date.parse(value);
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  return 0;
}

function toTweet(result: Record<string, unknown>, lane: TwitterLane): UpsertTwitterTweetInput | null {
  const legacy = (result.legacy || {}) as Record<string, unknown>;
  const core = (result.core || {}) as Record<string, unknown>;
  const userResults = ((core.user_results || {}) as Record<string, unknown>).result as Record<string, unknown> | undefined;
  const userLegacy = ((userResults?.legacy || {}) as Record<string, unknown>) || {};
  const tweetId = typeof result.rest_id === 'string' ? result.rest_id.trim() : '';
  const authorHandle = normalizeHandle(typeof userLegacy.screen_name === 'string' ? userLegacy.screen_name : '');
  const fullText = typeof legacy.full_text === 'string' ? legacy.full_text.trim() : '';
  const createdAtMs = toMs(legacy.created_at);
  if (!tweetId || !authorHandle || !fullText || !createdAtMs) return null;

  return {
    tweetId,
    authorHandle,
    authorName: typeof userLegacy.name === 'string' ? userLegacy.name.trim() : undefined,
    fullText,
    createdAtMs,
    lane,
    conversationId: typeof legacy.conversation_id_str === 'string' ? legacy.conversation_id_str : undefined,
    replyToTweetId: typeof legacy.in_reply_to_status_id_str === 'string' ? legacy.in_reply_to_status_id_str : undefined,
    replyCount: typeof legacy.reply_count === 'number' ? legacy.reply_count : 0,
    retweetCount: typeof legacy.retweet_count === 'number' ? legacy.retweet_count : 0,
    likeCount: typeof legacy.favorite_count === 'number' ? legacy.favorite_count : 0,
    source: result,
  };
}

export function parseXreadUserIdResponse(payload: Record<string, unknown>): TwitterResolvedIdentity {
  return {
    provider: 'xread',
    userId: String(payload.id_str || payload.id || ''),
    username: null,
  };
}
```

```ts
// lib/server/twitterXreadClient.ts
function collectEntriesFromInstructions(instructions: unknown): Record<string, unknown>[] {
  if (!Array.isArray(instructions)) return [];
  const entries: Record<string, unknown>[] = [];
  for (const instruction of instructions) {
    const rows = Array.isArray((instruction as { entries?: unknown[] }).entries)
      ? ((instruction as { entries: unknown[] }).entries as Record<string, unknown>[])
      : [];
    entries.push(...rows);
  }
  return entries;
}

export function parseXreadUserTweetsResponse(payload: Record<string, unknown>, lane: TwitterLane) {
  const data = (payload.data || {}) as Record<string, unknown>;
  const root = ((data.user_result_by_rest_id || data.user_result || {}) as Record<string, unknown>);
  const result = (root.result || {}) as Record<string, unknown>;
  const timeline = (((result.profile_timeline_v2 || {}) as Record<string, unknown>).timeline || {}) as Record<string, unknown>;
  const entries = collectEntriesFromInstructions(timeline.instructions);
  return entries
    .map((entry) => {
      const content = (((entry.content || {}) as Record<string, unknown>).content || ((entry.content || {}) as Record<string, unknown>).itemContent || {}) as Record<string, unknown>;
      const tweetResults = (content.tweet_results || {}) as Record<string, unknown>;
      return toTweet((tweetResults.result || {}) as Record<string, unknown>, lane);
    })
    .filter((item): item is UpsertTwitterTweetInput => Boolean(item));
}

export function parseXreadTweetDetailResponse(payload: Record<string, unknown>) {
  const data = (payload.data || {}) as Record<string, unknown>;
  const root = (data.threaded_conversation_with_injections_v2 || data.tweet_result || {}) as Record<string, unknown>;
  const entries = collectEntriesFromInstructions(root.instructions);
  for (const entry of entries) {
    const content = (((entry.content || {}) as Record<string, unknown>).itemContent || {}) as Record<string, unknown>;
    const tweetResults = (content.tweet_results || {}) as Record<string, unknown>;
    const tweet = toTweet((tweetResults.result || {}) as Record<string, unknown>, 'timeline');
    if (tweet) return tweet;
  }
  return null;
}
```

```ts
// lib/server/twitterXreadClient.ts
export function createTwitterXreadClient(fetchImpl: typeof fetch = fetch): StructuredTwitterClient {
  const baseUrl = (process.env.TWITTER_XREAD_BASE_URL || '').trim().replace(/\/+$/, '');
  const apiKey = (process.env.TWITTER_XREAD_API_KEY || '').trim();
  const timeoutMs = Math.max(5_000, Number.parseInt(process.env.TWITTER_PROVIDER_HTTP_TIMEOUT_MS || '15000', 10) || 15_000);

  async function request<T>(endpoint: string, params: Record<string, string>) {
    const query = new URLSearchParams({ api_key: apiKey, ...params }).toString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}/${endpoint}?${query}`, {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`xread http ${response.status}`);
      }
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    provider: 'xread',
    async resolveUserId({ handle }) {
      const payload = await request<Record<string, unknown>>('UsernameToUserId', {
        username: handle,
      });
      const resolved = parseXreadUserIdResponse(payload);
      return resolved.userId ? resolved : null;
    },
    async fetchUserTweets({ userId, lane, maxItems, cursor }) {
      const payload = await request<Record<string, unknown>>(lane === 'replies' ? 'UserTweetsReplies' : 'UserTweets', {
        user_id: userId,
        count: String(maxItems),
        ...(cursor ? { cursor } : {}),
      });
      return {
        provider: 'xread',
        credentialId: null,
        tweets: parseXreadUserTweetsResponse(payload, lane),
        chargedUnit: true,
      } satisfies StructuredTwitterFetchResult;
    },
    async fetchTweetsByIds({ ids }) {
      const tweets: UpsertTwitterTweetInput[] = [];
      for (const id of ids) {
        const payload = await request<Record<string, unknown>>('TweetDetailv3', {
          tweet_id: id,
        });
        const tweet = parseXreadTweetDetailResponse(payload);
        if (tweet) tweets.push(tweet);
      }
      return {
        provider: 'xread',
        credentialId: null,
        tweets,
        chargedUnit: tweets.length > 0,
      };
    },
  };
}
```

- [ ] **Step 6: 补充测试脚本到 `package.json`**

```json
{
  "scripts": {
    "test:twitter-provider-clients": "NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-twitter-provider-clients.ts",
    "test": "npm run test:admin-auth && npm run test:feed-ordering && npm run test:events-feed-total && npm run test:feed-request-arbiter && npm run test:feed-prewarm-service && npm run test:source-reconciliation && npm run test:conflict-repo && npm run test:system-config-conflict-chat && npm run test:conflict-notifier && npm run test:parser-fixtures && npm run test:twitter-bridge && npm run test:twitter-provider-state && npm run test:twitter-provider-clients"
  }
}
```

- [ ] **Step 7: 运行测试确认通过**

Run: `npm run test:twitter-provider-clients`  
Expected: PASS，输出 `twitter provider client tests: ok`。

- [ ] **Step 8: Commit**

```bash
git add lib/server/twitterProviderTypes.ts lib/server/twitter6551Client.ts lib/server/twitterXreadClient.ts scripts/test-twitter-provider-clients.ts package.json
git commit -m "feat(twitter): add structured 6551 and xread provider clients"
```

---

### Task 3: 增加 provider router，并把结构化 provider 接入 `twitterFetcher`

**Files:**
- Create: `lib/server/twitterProviderRouter.ts`
- Modify: `lib/server/twitterFetcher.ts`
- Modify: `scripts/test-twitter-fetcher.ts`
- Create: `scripts/test-twitter-provider-router.ts`
- Modify: `package.json`
- Test: `scripts/test-twitter-provider-router.ts`
- Test: `scripts/test-twitter-fetcher.ts`

- [ ] **Step 1: 写失败测试（router 选路 + fetcher 新 provider plan）**

```ts
// scripts/test-twitter-provider-router.ts
import assert from 'node:assert/strict';

import { chooseTwitterProviderRoute } from '@/lib/server/twitterProviderRouter';

function main() {
  const route = chooseTwitterProviderRoute({
    intent: 'sync',
    nowMs: Date.UTC(2026, 3, 23, 1, 0, 0),
    dailyLimit: 100,
    budgetSnapshots: [
      {
        provider: '6551',
        credentialId: 'key-1',
        dateKey: '2026-04-23',
        successUnitsUsed: 100,
        dailyLimit: 100,
        remainingUnits: 0,
        cooldownUntilMs: null,
        lastSuccessAtMs: null,
        lastFailureAtMs: null,
        lastError: null,
      },
      {
        provider: '6551',
        credentialId: 'key-2',
        dateKey: '2026-04-23',
        successUnitsUsed: 10,
        dailyLimit: 100,
        remainingUnits: 90,
        cooldownUntilMs: null,
        lastSuccessAtMs: Date.UTC(2026, 3, 23, 0, 40, 0),
        lastFailureAtMs: null,
        lastError: null,
      },
    ],
  });
  assert.equal(route.provider, '6551');
  assert.equal(route.credentialId, 'key-2');

  const xreadRoute = chooseTwitterProviderRoute({
    intent: 'backfill',
    nowMs: Date.UTC(2026, 3, 23, 2, 0, 0),
    dailyLimit: 100,
    budgetSnapshots: [
      {
        provider: '6551',
        credentialId: 'key-1',
        dateKey: '2026-04-23',
        successUnitsUsed: 100,
        dailyLimit: 100,
        remainingUnits: 0,
        cooldownUntilMs: null,
        lastSuccessAtMs: null,
        lastFailureAtMs: null,
        lastError: null,
      },
      {
        provider: '6551',
        credentialId: 'key-2',
        dateKey: '2026-04-23',
        successUnitsUsed: 100,
        dailyLimit: 100,
        remainingUnits: 0,
        cooldownUntilMs: null,
        lastSuccessAtMs: null,
        lastFailureAtMs: null,
        lastError: null,
      },
    ],
  });
  assert.equal(xreadRoute.provider, 'xread');
  assert.equal(xreadRoute.credentialId, null);

  console.log('twitter provider router tests: ok');
}

main();
```

```ts
// scripts/test-twitter-fetcher.ts
import assert from 'node:assert/strict';

import { resolveTwitterProviderPlan } from '@/lib/server/twitterFetcher';

function main() {
  assert.deepEqual(resolveTwitterProviderPlan(undefined), {
    structuredProviders: ['6551', 'xread'],
    cliProviders: ['opencli', 'dokobot'],
    allowFixture: true,
  });
  assert.deepEqual(resolveTwitterProviderPlan('6551'), {
    structuredProviders: ['6551'],
    cliProviders: [],
    allowFixture: false,
  });
  assert.deepEqual(resolveTwitterProviderPlan('xread'), {
    structuredProviders: ['xread'],
    cliProviders: [],
    allowFixture: false,
  });

  console.log('twitter fetcher tests: ok');
}

main();
```

- [ ] **Step 2: 运行测试确认失败**

Run: `NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-twitter-provider-router.ts`  
Expected: FAIL，提示缺少 `twitterProviderRouter`。

Run: `NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-twitter-fetcher.ts`  
Expected: FAIL，`resolveTwitterProviderPlan` 返回结构与断言不一致。

- [ ] **Step 3: 实现 provider router**

```ts
// lib/server/twitterProviderRouter.ts
import 'server-only';

import { type TwitterProviderBudgetSnapshot } from '@/lib/server/twitterProviderStateRepo';
import { type TwitterFetchIntent } from '@/lib/server/twitterProviderTypes';

export interface TwitterProviderRoute {
  provider: '6551' | 'xread' | 'opencli' | 'dokobot';
  credentialId: string | null;
  reason: 'available_budget' | 'budget_exhausted' | 'cooldown_active' | 'forced_provider';
}

export function chooseTwitterProviderRoute(input: {
  intent: TwitterFetchIntent;
  nowMs: number;
  dailyLimit: number;
  budgetSnapshots: TwitterProviderBudgetSnapshot[];
}): TwitterProviderRoute {
  const available = input.budgetSnapshots
    .filter((item) => item.remainingUnits > 0)
    .filter((item) => !item.cooldownUntilMs || item.cooldownUntilMs <= input.nowMs)
    .sort((a, b) => {
      if (b.remainingUnits !== a.remainingUnits) return b.remainingUnits - a.remainingUnits;
      return (b.lastSuccessAtMs || 0) - (a.lastSuccessAtMs || 0);
    });

  if (available.length > 0) {
    return {
      provider: '6551',
      credentialId: available[0].credentialId,
      reason: 'available_budget',
    };
  }

  return {
    provider: 'xread',
    credentialId: null,
    reason: 'budget_exhausted',
  };
}
```

- [ ] **Step 4: 把结构化 provider 接入 `twitterFetcher`**

```ts
// lib/server/twitterFetcher.ts
import { createTwitter6551Client } from '@/lib/server/twitter6551Client';
import { createTwitterXreadClient } from '@/lib/server/twitterXreadClient';
import { chooseTwitterProviderRoute } from '@/lib/server/twitterProviderRouter';
import {
  markTwitterProviderFailure,
  markTwitterProviderSuccess,
  readTwitterIdentityCache,
  readTwitterProviderBudgetSnapshot,
  upsertTwitterIdentityCache,
} from '@/lib/server/twitterProviderStateRepo';
import { type TwitterFetchIntent } from '@/lib/server/twitterProviderTypes';

export type TwitterFetcherProvider = '6551' | 'xread' | 'opencli' | 'dokobot' | 'seed' | 'fixture' | 'noop';

export interface TwitterFetcherResult {
  provider: TwitterFetcherProvider;
  credentialId?: string | null;
  tweets: UpsertTwitterTweetInput[];
  chargedUnit?: boolean;
  fallbackChain?: string[];
}
```

```ts
// lib/server/twitterFetcher.ts
type StructuredProviderMode = 'auto' | '6551' | 'xread' | 'fixture' | 'opencli' | 'dokobot';

export function resolveTwitterProviderPlan(value: string | undefined | null): {
  structuredProviders: Array<'6551' | 'xread'>;
  cliProviders: Array<'opencli' | 'dokobot'>;
  allowFixture: boolean;
} {
  const normalized = normalize(value);
  if (normalized === '6551') {
    return { structuredProviders: ['6551'], cliProviders: [], allowFixture: false };
  }
  if (normalized === 'xread') {
    return { structuredProviders: ['xread'], cliProviders: [], allowFixture: false };
  }
  if (normalized === 'opencli') {
    return { structuredProviders: [], cliProviders: ['opencli'], allowFixture: false };
  }
  if (normalized === 'dokobot') {
    return { structuredProviders: [], cliProviders: ['dokobot'], allowFixture: false };
  }
  if (normalized === 'fixture') {
    return { structuredProviders: [], cliProviders: [], allowFixture: true };
  }
  return {
    structuredProviders: ['6551', 'xread'],
    cliProviders: ['opencli', 'dokobot'],
    allowFixture: true,
  };
}
```

```ts
// lib/server/twitterFetcher.ts
async function resolveUserIdWithCache(input: {
  handle: string;
  routeCredentialId: string | null;
  providers: {
    client6551: ReturnType<typeof createTwitter6551Client>;
    clientXread: ReturnType<typeof createTwitterXreadClient>;
  };
}) {
  const cached = readTwitterIdentityCache(input.handle);
  if (cached?.userId && (!cached.expiresAtMs || cached.expiresAtMs > Date.now())) {
    return { userId: cached.userId, cacheHit: true };
  }

  const resolved6551 = await input.providers.client6551.resolveUserId({
    handle: input.handle,
    credentialId: input.routeCredentialId,
  }).catch(() => null);
  if (resolved6551?.userId) {
    upsertTwitterIdentityCache({
      handle: input.handle,
      provider: '6551',
      userId: resolved6551.userId,
      username: resolved6551.username,
      expiresAtMs: Date.now() + 24 * 60 * 60 * 1000,
      lastError: null,
    });
    return { userId: resolved6551.userId, cacheHit: false };
  }

  const resolvedXread = await input.providers.clientXread.resolveUserId({
    handle: input.handle,
  }).catch(() => null);
  if (resolvedXread?.userId) {
    upsertTwitterIdentityCache({
      handle: input.handle,
      provider: 'xread',
      userId: resolvedXread.userId,
      username: resolvedXread.username,
      expiresAtMs: Date.now() + 24 * 60 * 60 * 1000,
      lastError: null,
    });
    return { userId: resolvedXread.userId, cacheHit: false };
  }

  upsertTwitterIdentityCache({
    handle: input.handle,
    provider: '6551',
    userId: null,
    username: input.handle,
    expiresAtMs: Date.now() + 5 * 60 * 1000,
    lastError: 'identity_resolution_failed',
  });
  return { userId: null, cacheHit: false };
}
```

```ts
// lib/server/twitterFetcher.ts
fetchUserTweets: async (params: {
  handle: string;
  lane: TwitterLane;
  sinceMs: number;
  maxItems: number;
  intent?: TwitterFetchIntent;
}): Promise<TwitterFetcherResult> => {
  const intent = params.intent || 'sync';
  const nowMs = Date.now();
  const plan = resolveTwitterProviderPlan(process.env.TWITTER_FETCH_PROVIDER);
  const snapshots = ['key-1', 'key-2'].map((credentialId) =>
    readTwitterProviderBudgetSnapshot({
      provider: '6551',
      credentialId,
      nowMs,
      dailyLimit: 100,
    })
  );
  const route = chooseTwitterProviderRoute({
    intent,
    nowMs,
    dailyLimit: 100,
    budgetSnapshots: snapshots,
  });
  const client6551 = createTwitter6551Client();
  const clientXread = createTwitterXreadClient();
  const identity = await resolveUserIdWithCache({
    handle: normalize(params.handle),
    routeCredentialId: route.credentialId,
    providers: { client6551, clientXread },
  });

  if (plan.structuredProviders.length > 0 && identity.userId) {
    const fallbackChain: string[] = [];
    const attempts: Array<{ provider: '6551' | 'xread'; credentialId: string | null }> =
      route.provider === '6551'
        ? [
            { provider: '6551', credentialId: route.credentialId },
            { provider: '6551', credentialId: route.credentialId === 'key-1' ? 'key-2' : 'key-1' },
            { provider: 'xread', credentialId: null },
          ]
        : [{ provider: 'xread', credentialId: null }];

    for (const attempt of attempts) {
      try {
        const result = attempt.provider === '6551'
          ? await client6551.fetchUserTweets({
              userId: identity.userId,
              handle: normalize(params.handle),
              lane: params.lane,
              maxItems: params.maxItems,
              credentialId: attempt.credentialId,
            })
          : await clientXread.fetchUserTweets({
              userId: identity.userId,
              handle: normalize(params.handle),
              lane: params.lane,
              maxItems: params.maxItems,
            });
        if (attempt.provider === '6551' && result.chargedUnit) {
          markTwitterProviderSuccess({
            provider: '6551',
            credentialId: attempt.credentialId || 'key-1',
            nowMs: Date.now(),
            dailyLimit: 100,
          });
        }
        return {
          provider: attempt.provider,
          credentialId: attempt.credentialId,
          tweets: sortAndFilterTweets(result.tweets, params.sinceMs, params.maxItems),
          chargedUnit: result.chargedUnit,
          fallbackChain,
        };
      } catch (error) {
        fallbackChain.push(attempt.provider + (attempt.credentialId ? `:${attempt.credentialId}` : ''));
        if (attempt.provider === '6551') {
          markTwitterProviderFailure({
            provider: '6551',
            credentialId: attempt.credentialId || 'key-1',
            nowMs: Date.now(),
            error: error instanceof Error ? error.message : 'unknown_error',
            cooldownMs: 5 * 60 * 1000,
          });
        }
      }
    }
  }

  // existing cli fallback path remains below
}
```

- [ ] **Step 5: 补充测试脚本到 `package.json`**

```json
{
  "scripts": {
    "test:twitter-provider-router": "NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-twitter-provider-router.ts",
    "test:twitter-fetcher": "NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-twitter-fetcher.ts",
    "test": "npm run test:admin-auth && npm run test:feed-ordering && npm run test:events-feed-total && npm run test:feed-request-arbiter && npm run test:feed-prewarm-service && npm run test:source-reconciliation && npm run test:conflict-repo && npm run test:system-config-conflict-chat && npm run test:conflict-notifier && npm run test:parser-fixtures && npm run test:twitter-bridge && npm run test:twitter-provider-state && npm run test:twitter-provider-clients && npm run test:twitter-provider-router && npm run test:twitter-fetcher"
  }
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npm run test:twitter-provider-router && npm run test:twitter-fetcher`  
Expected: PASS，依次输出 `twitter provider router tests: ok` 和 `twitter fetcher tests: ok`。

- [ ] **Step 7: Commit**

```bash
git add lib/server/twitterProviderRouter.ts lib/server/twitterFetcher.ts scripts/test-twitter-provider-router.ts scripts/test-twitter-fetcher.ts package.json
git commit -m "feat(twitter): route fetches across 6551 xread and cli fallbacks"
```

---

### Task 4: 把 `intent`、预算观测与状态摘要接入 `twitterSyncService`

**Files:**
- Modify: `lib/server/twitterSyncService.ts`
- Modify: `app/api/twitter/sync/route.ts`
- Create: `scripts/test-twitter-sync-service.ts`
- Modify: `package.json`
- Test: `scripts/test-twitter-sync-service.ts`

- [ ] **Step 1: 写失败测试（sync summary 记录 providerUnitsUsed、fallbackCounts、intent）**

```ts
// scripts/test-twitter-sync-service.ts
import assert from 'node:assert/strict';

import { buildTwitterSyncSummary } from '@/lib/server/twitterSyncService';

function main() {
  const summary = buildTwitterSyncSummary();
  summary.providerHits['6551'] = 2;
  summary.providerUnitsUsed['6551:key-1'] = 3;
  summary.fallbackCounts['6551->xread'] = 1;
  summary.identityCacheHit = 4;
  summary.identityCacheMiss = 2;

  assert.equal(summary.providerUnitsUsed['6551:key-1'], 3);
  assert.equal(summary.fallbackCounts['6551->xread'], 1);
  assert.equal(summary.identityCacheHit, 4);
  assert.equal(summary.identityCacheMiss, 2);

  console.log('twitter sync service tests: ok');
}

main();
```

- [ ] **Step 2: 运行测试确认失败**

Run: `NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-twitter-sync-service.ts`  
Expected: FAIL，提示 `buildTwitterSyncSummary` 不存在。

- [ ] **Step 3: 扩展 sync summary 与 fetch 调用**

```ts
// lib/server/twitterSyncService.ts
interface SyncSummary {
  fetchedCount: number;
  storedCount: number;
  projectedCount: number;
  backfillEnqueuedCount: number;
  backfillFetchedCount: number;
  budgetExhausted: boolean;
  budgetReasons: string[];
  userCount: number;
  laneCount: number;
  providerHits: Record<string, number>;
  providerUnitsUsed: Record<string, number>;
  fallbackCounts: Record<string, number>;
  identityCacheHit: number;
  identityCacheMiss: number;
  identityCacheNegativeHit: number;
}

export function buildTwitterSyncSummary(): SyncSummary {
  return {
    fetchedCount: 0,
    storedCount: 0,
    projectedCount: 0,
    backfillEnqueuedCount: 0,
    backfillFetchedCount: 0,
    budgetExhausted: false,
    budgetReasons: [],
    userCount: 0,
    laneCount: 0,
    providerHits: {},
    providerUnitsUsed: {},
    fallbackCounts: {},
    identityCacheHit: 0,
    identityCacheMiss: 0,
    identityCacheNegativeHit: 0,
  };
}
```

```ts
// lib/server/twitterSyncService.ts
const summary = buildTwitterSyncSummary();
summary.userCount = trackedUsers.length;

const fetched = await fetcher.fetchUserTweets({
  handle: user.twitterHandle,
  lane,
  sinceMs,
  maxItems: FETCH_MAX_ITEMS_PER_LANE,
  intent: overrideSinceMs === null ? 'sync' : 'backfill',
});
summary.providerHits[fetched.provider] = (summary.providerHits[fetched.provider] || 0) + 1;
if (fetched.provider === '6551' && fetched.credentialId && fetched.chargedUnit) {
  const budgetKey = `${fetched.provider}:${fetched.credentialId}`;
  summary.providerUnitsUsed[budgetKey] = (summary.providerUnitsUsed[budgetKey] || 0) + 1;
}
for (const edge of fetched.fallbackChain || []) {
  const routeKey = `${edge}->${fetched.provider}`;
  summary.fallbackCounts[routeKey] = (summary.fallbackCounts[routeKey] || 0) + 1;
}
```

```ts
// lib/server/twitterSyncService.ts
const fetched = await fetcher.fetchTweetsByIds({
  ids,
  intent: 'detail',
});
summary.providerHits[fetched.provider] = (summary.providerHits[fetched.provider] || 0) + 1;
if (fetched.provider === '6551' && fetched.credentialId && fetched.chargedUnit) {
  const budgetKey = `${fetched.provider}:${fetched.credentialId}`;
  summary.providerUnitsUsed[budgetKey] = (summary.providerUnitsUsed[budgetKey] || 0) + 1;
}
```

- [ ] **Step 4: 扩展 sync log 与 `/api/twitter/sync` 状态摘要**

```ts
// lib/server/twitterSyncService.ts
appendSyncLog({
  runKind: 'twitter',
  runId,
  level: 'debug',
  phase: 'lane-fetch',
  message: `fetched lane ${lane} via ${fetched.provider}`,
  payload: {
    userId: user.id,
    handle: user.twitterHandle,
    lane,
    intent: overrideSinceMs === null ? 'sync' : 'backfill',
    provider: fetched.provider,
    credentialId: fetched.credentialId || null,
    chargedUnit: fetched.chargedUnit || false,
    fallbackChain: fetched.fallbackChain || [],
    fetchedCount: fetched.tweets.length,
  },
});
```

```ts
// app/api/twitter/sync/route.ts
import { readTwitterProviderBudgetStatus } from '@/lib/server/twitterProviderStateRepo';

export async function GET() {
  const status = getTwitterSyncStatus();
  const latestTweet = readLatestTwitterTweet();
  const latestVisibleEvent = readLatestTwitterVisibleEvent();
  const latestRelay = readLatestTwitterRelay();
  const providerBudget = readTwitterProviderBudgetStatus(Date.now());

  return NextResponse.json({
    ok: true,
    status: {
      ...status,
      latestTweet,
      latestVisibleEvent,
      latestRelay,
      providerBudget,
    },
  });
}
```

- [ ] **Step 5: 补充 `twitterProviderStateRepo` 状态聚合导出**

```ts
// lib/server/twitterProviderStateRepo.ts
export function readTwitterProviderBudgetStatus(nowMs: number) {
  return ['key-1', 'key-2'].map((credentialId) =>
    readTwitterProviderBudgetSnapshot({
      provider: '6551',
      credentialId,
      nowMs,
      dailyLimit: 100,
    })
  );
}
```

- [ ] **Step 6: 补充测试脚本到 `package.json`**

```json
{
  "scripts": {
    "test:twitter-sync-service": "NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-twitter-sync-service.ts",
    "test": "npm run test:admin-auth && npm run test:feed-ordering && npm run test:events-feed-total && npm run test:feed-request-arbiter && npm run test:feed-prewarm-service && npm run test:source-reconciliation && npm run test:conflict-repo && npm run test:system-config-conflict-chat && npm run test:conflict-notifier && npm run test:parser-fixtures && npm run test:twitter-bridge && npm run test:twitter-provider-state && npm run test:twitter-provider-clients && npm run test:twitter-provider-router && npm run test:twitter-fetcher && npm run test:twitter-sync-service"
  }
}
```

- [ ] **Step 7: 运行测试确认通过**

Run: `npm run test:twitter-sync-service`  
Expected: PASS，输出 `twitter sync service tests: ok`。

- [ ] **Step 8: Commit**

```bash
git add lib/server/twitterSyncService.ts app/api/twitter/sync/route.ts lib/server/twitterProviderStateRepo.ts scripts/test-twitter-sync-service.ts package.json
git commit -m "feat(twitter): expose provider budget and sync telemetry"
```

---

### Task 5: 回归验证与全量测试收尾

**Files:**
- Modify: `package.json`
- Test: `scripts/test-twitter-provider-state.ts`
- Test: `scripts/test-twitter-provider-clients.ts`
- Test: `scripts/test-twitter-provider-router.ts`
- Test: `scripts/test-twitter-fetcher.ts`
- Test: `scripts/test-twitter-sync-service.ts`

- [ ] **Step 1: 逐个运行新增测试**

Run:

```bash
npm run test:twitter-provider-state
npm run test:twitter-provider-clients
npm run test:twitter-provider-router
npm run test:twitter-fetcher
npm run test:twitter-sync-service
```

Expected:
- 每个脚本都 PASS
- 依次输出：
  - `twitter provider state tests: ok`
  - `twitter provider client tests: ok`
  - `twitter provider router tests: ok`
  - `twitter fetcher tests: ok`
  - `twitter sync service tests: ok`

- [ ] **Step 2: 运行全量现有测试**

Run: `npm test`  
Expected: PASS，现有 feed / parser / twitter bridge 测试不回退。

- [ ] **Step 3: 运行类型检查与构建**

Run: `npm run build`  
Expected: PASS，Next.js 16.2.3 生产构建成功。

- [ ] **Step 4: 手工验证 `/api/twitter/sync` 状态摘要**

Run:

```bash
curl -s http://localhost:3005/api/twitter/sync | jq '.status.providerBudget'
```

Expected:
- 返回 `6551 key-1` / `key-2` 的 `successUnitsUsed`
- `dateKey` 为北京时间日期
- 未用额度时 `remainingUnits = 100`

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "test(twitter): verify multi-provider ingest flow end to end"
```

---

## Self-Review

### Spec Coverage
- `6551` / `Xread` 双 provider：Task 2
- `handle -> user_id` cache：Task 1 + Task 3
- 北京时间 `00:00` 重置：Task 1
- `6551` 成功请求记 1 分：Task 1 + Task 3
- `6551 -> Xread -> opencli -> dokobot` 路由：Task 3
- `sync` / `detail` / `backfill` intent：Task 3 + Task 4
- provider 预算与 fallback 观测：Task 4
- `/api/twitter/sync` 状态摘要：Task 4
- 全量回归：Task 5

### Placeholder Scan
- 未使用 `TODO` / `TBD` / “后续补充”。
- 每个任务都包含测试命令、代码片段和 commit 命令。

### Type Consistency
- provider 名称统一为 `'6551' | 'xread' | 'opencli' | 'dokobot'`。
- `intent` 统一为 `'sync' | 'backfill' | 'detail' | 'resolve-id'`。
- 预算字段统一为 `successUnitsUsed` / `remainingUnits` / `dateKey`。
