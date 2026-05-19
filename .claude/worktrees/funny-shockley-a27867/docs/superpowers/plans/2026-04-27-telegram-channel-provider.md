# Telegram Channel Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Telegram channel provider that stores raw channel posts, projects them into the Feed as Telegram post events, and asynchronously enriches X links found in those posts.

**Architecture:** Add SQLite-backed Telegram channel source and raw post tables, project stored Telegram posts into the existing `events` pipeline, and add a session-based sync script that can backfill and poll public channels. The implementation keeps the existing bot bridge intact and layers the new provider beside it.

**Tech Stack:** Next.js route/runtime conventions, TypeScript, SQLite via `better-sqlite3`, `tsx` scripts, Telegram MTProto client library, existing Feed/events repos

---

### Task 1: Add Telegram channel provider schema and repositories

**Files:**
- Modify: `/Users/xp/vibecoding/pilipili/lib/server/sqlite.ts`
- Create: `/Users/xp/vibecoding/pilipili/lib/server/telegramChannelSourceRepo.ts`
- Create: `/Users/xp/vibecoding/pilipili/lib/server/telegramChannelPostRepo.ts`
- Test: `/Users/xp/vibecoding/pilipili/scripts/test-telegram-channel-provider.ts`

- [ ] **Step 1: Write the failing test**

Add assertions that:

```ts
const source = upsertTelegramChannelSource({
  userId: user.id,
  channelRef: '@jiuyicall',
});
assert.equal(source.channelRef, '@jiuyicall');

const updatedSource = updateTelegramChannelSourceState(source.id, {
  channelChatId: '-100123',
  channelUsername: 'jiuyicall',
  lastMessageId: 42,
  syncStatus: 'ready',
});
assert.equal(updatedSource.lastMessageId, 42);

const post = upsertTelegramChannelPost({
  sourceId: source.id,
  userId: user.id,
  channelChatId: '-100123',
  channelUsername: 'jiuyicall',
  messageId: 42,
  postedAtMs: 1700000000000,
  text: 'hello tg',
  linkUrls: ['https://x.com/foo/status/1'],
  raw: { id: 42 },
});
assert.equal(post.messageId, 42);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-telegram-channel-provider.ts`
Expected: FAIL with missing repository functions or missing tables.

- [ ] **Step 3: Write minimal implementation**

Add the two tables and minimal CRUD helpers for:

- source upsert by `(user_id, channel_ref_normalized)`
- source state update
- source listing
- raw post upsert by `(channel_chat_id, message_id)`

- [ ] **Step 4: Run test to verify it passes**

Run: `NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-telegram-channel-provider.ts`
Expected: PASS for repo persistence assertions.

- [ ] **Step 5: Commit**

```bash
git add lib/server/sqlite.ts lib/server/telegramChannelSourceRepo.ts lib/server/telegramChannelPostRepo.ts scripts/test-telegram-channel-provider.ts
git commit -m "feat: add telegram channel provider storage"
```

### Task 2: Project Telegram raw posts into Feed events

**Files:**
- Modify: `/Users/xp/vibecoding/pilipili/types/index.ts`
- Create: `/Users/xp/vibecoding/pilipili/lib/server/telegramChannelProjector.ts`
- Create: `/Users/xp/vibecoding/pilipili/lib/server/telegramChannelIngest.ts`
- Test: `/Users/xp/vibecoding/pilipili/scripts/test-telegram-channel-provider.ts`

- [ ] **Step 1: Write the failing test**

Add assertions that a stored post becomes a Telegram feed event:

```ts
const projected = projectTelegramChannelPostToFeed({
  user,
  post,
  source,
});
assert.equal(projected.activity.source, 'telegram');
assert.equal(projected.activity.type, 'post');
assert.equal(projected.activity.metadata.telegramMessageId, 42);
assert.equal(projected.activity.metadata.telegramChannelUsername, 'jiuyicall');
```

Also assert ingest writes an `events` row with `ingest_source = 'telegram-channel'`.

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-telegram-channel-provider.ts`
Expected: FAIL because projector/ingest code does not exist.

- [ ] **Step 3: Write minimal implementation**

Implement:

- `projectTelegramChannelPostToFeed`
- `ingestTelegramChannelPost`
- metadata extensions in `Activity`

Use an activity id like:

```ts
`telegram:${post.channelChatId}:${post.messageId}`
```

- [ ] **Step 4: Run test to verify it passes**

Run: `NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-telegram-channel-provider.ts`
Expected: PASS and `events` contains one `telegram-channel` row.

- [ ] **Step 5: Commit**

```bash
git add types/index.ts lib/server/telegramChannelProjector.ts lib/server/telegramChannelIngest.ts scripts/test-telegram-channel-provider.ts
git commit -m "feat: project telegram channel posts into feed"
```

### Task 3: Reuse tweet ref enrichment for Telegram posts

**Files:**
- Modify: `/Users/xp/vibecoding/pilipili/lib/server/telegramChannelIngest.ts`
- Test: `/Users/xp/vibecoding/pilipili/scripts/test-telegram-channel-provider.ts`

- [ ] **Step 1: Write the failing test**

Add a Telegram post containing an X link:

```ts
const post = upsertTelegramChannelPost({
  ...basePost,
  messageId: 99,
  text: 'see https://x.com/cryptojiuyi/status/1234567890',
  linkUrls: ['https://x.com/cryptojiuyi/status/1234567890'],
  raw: { id: 99 },
});
await ingestTelegramChannelPost({
  post,
  user,
  source,
  fetchTweetsByIds: async () => [],
});
const refs = db.prepare('SELECT event_id, tweet_id FROM event_tweet_refs WHERE event_id = ?').all(`telegram:-100123:99`);
assert.equal(refs.length, 1);
assert.equal(refs[0].tweet_id, '1234567890');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-telegram-channel-provider.ts`
Expected: FAIL because no tweet refs are created.

- [ ] **Step 3: Write minimal implementation**

After event upsert, call the existing tweet-ref helper with post links:

```ts
await upsertEventTweetRefAndFetchMissing({
  eventId: projected.activity.id,
  tweetUrls: post.linkUrls,
  refSource: 'telegram-channel',
  fetchTweetsByIds,
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-telegram-channel-provider.ts`
Expected: PASS and one `event_tweet_refs` row exists.

- [ ] **Step 5: Commit**

```bash
git add lib/server/telegramChannelIngest.ts scripts/test-telegram-channel-provider.ts
git commit -m "feat: enrich telegram channel posts with linked tweets"
```

### Task 4: Add Telegram client session helpers

**Files:**
- Create: `/Users/xp/vibecoding/pilipili/lib/server/telegramClientConfig.ts`
- Create: `/Users/xp/vibecoding/pilipili/scripts/telegram-channel-login.ts`
- Modify: `/Users/xp/vibecoding/pilipili/package.json`
- Test: `/Users/xp/vibecoding/pilipili/scripts/test-telegram-channel-provider.ts`

- [ ] **Step 1: Write the failing test**

Add assertions for config parsing:

```ts
process.env.TELEGRAM_API_ID = '12345';
process.env.TELEGRAM_API_HASH = 'hash';
process.env.TELEGRAM_SESSION_STRING = 'session';
const config = readTelegramClientConfig();
assert.equal(config.apiId, 12345);
assert.equal(config.apiHash, 'hash');
assert.equal(config.sessionString, 'session');
```

Also assert that missing session marks config as unavailable for history sync.

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-telegram-channel-provider.ts`
Expected: FAIL because config helper does not exist.

- [ ] **Step 3: Write minimal implementation**

Implement:

- config parser
- explicit `ready` / `authRequired` state
- login script scaffolding that prints a session string after successful interactive login
- package script entries

- [ ] **Step 4: Run test to verify it passes**

Run: `NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-telegram-channel-provider.ts`
Expected: PASS for config parsing.

- [ ] **Step 5: Commit**

```bash
git add lib/server/telegramClientConfig.ts scripts/telegram-channel-login.ts package.json scripts/test-telegram-channel-provider.ts
git commit -m "feat: add telegram client session setup"
```

### Task 5: Add channel sync service with stub-friendly client interface

**Files:**
- Create: `/Users/xp/vibecoding/pilipili/lib/server/telegramChannelSync.ts`
- Create: `/Users/xp/vibecoding/pilipili/scripts/telegram-channel-sync.ts`
- Modify: `/Users/xp/vibecoding/pilipili/package.json`
- Test: `/Users/xp/vibecoding/pilipili/scripts/test-telegram-channel-provider.ts`

- [ ] **Step 1: Write the failing test**

Add a stub client test:

```ts
const stubClient = {
  async resolveChannel(ref: string) {
    return {
      chatId: '-100123',
      username: 'jiuyicall',
      title: '旧亿 call',
      accessHash: 'abc',
    };
  },
  async listChannelMessages() {
    return [
      {
        messageId: 101,
        postedAtMs: 1700000001000,
        text: 'new channel post',
        linkUrls: [],
        raw: { id: 101 },
      },
    ];
  },
};
const result = await syncTelegramChannelSource({ sourceId: source.id, client: stubClient });
assert.equal(result.storedCount, 1);
assert.equal(result.projectedCount, 1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-telegram-channel-provider.ts`
Expected: FAIL because sync service does not exist.

- [ ] **Step 3: Write minimal implementation**

Implement a sync service that:

- loads the source
- resolves the channel
- persists resolved identity
- fetches messages newer than `last_message_id`
- stores raw posts
- ingests them
- updates source state

- [ ] **Step 4: Run test to verify it passes**

Run: `NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-telegram-channel-provider.ts`
Expected: PASS with one stored/projected message.

- [ ] **Step 5: Commit**

```bash
git add lib/server/telegramChannelSync.ts scripts/telegram-channel-sync.ts package.json scripts/test-telegram-channel-provider.ts
git commit -m "feat: add telegram channel sync service"
```

### Task 6: Verify ActivityCard and Feed compatibility for Telegram posts

**Files:**
- Modify: `/Users/xp/vibecoding/pilipili/components/ActivityCard.tsx`
- Test: `/Users/xp/vibecoding/pilipili/scripts/test-telegram-channel-provider.ts`

- [ ] **Step 1: Write the failing test**

Add assertions that projected Telegram posts include enough metadata for UI rendering:

```ts
assert.equal(typeof projected.activity.content, 'string');
assert.equal(projected.activity.content.includes('channel post'), true);
assert.equal(projected.activity.metadata.telegramPostUrl, 'https://t.me/jiuyicall/101');
```

This catches missing projection fields before UI adjustment.

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-telegram-channel-provider.ts`
Expected: FAIL because Telegram post URL metadata is not present.

- [ ] **Step 3: Write minimal implementation**

Ensure projector fills Telegram-specific metadata and adjust `ActivityCard` only if needed so Telegram posts can open source links and display properly without breaking Twitter cards.

- [ ] **Step 4: Run test to verify it passes**

Run: `NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-telegram-channel-provider.ts`
Expected: PASS and no regressions to existing Telegram monitor display behavior.

- [ ] **Step 5: Commit**

```bash
git add components/ActivityCard.tsx lib/server/telegramChannelProjector.ts scripts/test-telegram-channel-provider.ts
git commit -m "feat: surface telegram channel post metadata in feed"
```

### Task 7: End-to-end verification and rollout notes

**Files:**
- Modify: `/Users/xp/vibecoding/pilipili/package.json`
- Create: `/Users/xp/vibecoding/pilipili/scripts/test-telegram-channel-sync-live.ts`
- Test: `/Users/xp/vibecoding/pilipili/scripts/test-telegram-channel-provider.ts`

- [ ] **Step 1: Write the failing test**

Add a smoke script entry that exits non-zero when session config is missing or sync cannot run:

```ts
const config = readTelegramClientConfig();
assert.equal(Boolean(config.apiId), true);
assert.equal(Boolean(config.apiHash), true);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-telegram-channel-sync-live.ts`
Expected: FAIL with explicit auth/session guidance when session is missing.

- [ ] **Step 3: Write minimal implementation**

Add:

- a smoke test script for real sync
- package commands such as `telegram:channel:login`, `telegram:channel:sync`, and `test:telegram-channel-provider`
- clear stderr messages for missing session or inaccessible channel

- [ ] **Step 4: Run test to verify it passes**

Run: `NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-telegram-channel-provider.ts`
Expected: PASS

Run: `NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-telegram-channel-sync-live.ts`
Expected: PASS if session exists, otherwise FAIL with clear setup instructions.

- [ ] **Step 5: Commit**

```bash
git add package.json scripts/test-telegram-channel-provider.ts scripts/test-telegram-channel-sync-live.ts
git commit -m "chore: add telegram channel sync verification commands"
```
