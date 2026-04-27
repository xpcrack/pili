# Telegram Agent Read Authorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Telegram approval-bot flow that issues persistent read tokens for a single `agentName + chatId`, then enforce those tokens through a JSON-only MTProto read CLI with `tail` and `search`.

**Architecture:** Add SQLite-backed pending grants, active grants, and read-audit logs; implement a Telegram approval bot worker around `tgbot_out_token`; then extend the existing GramJS client with chat read/search helpers and gate all external access through a dedicated CLI that validates tokens before touching MTProto. The approval flow and the read flow stay separated so that authorization can be tested without live Telegram access and MTProto read behavior can be tested with stubs.

**Tech Stack:** TypeScript, Next.js server runtime conventions, SQLite via `better-sqlite3`, `tsx` scripts, Telegram Bot API long polling, Telegram MTProto via `telegram`/GramJS

---

### Task 1: Add SQLite schema, token helpers, and grant repositories

**Files:**
- Modify: `/Users/xp/vibecoding/pilipili/lib/server/sqlite.ts`
- Create: `/Users/xp/vibecoding/pilipili/lib/server/telegramAgentGrantRepo.ts`
- Create: `/Users/xp/vibecoding/pilipili/lib/server/telegramAgentToken.ts`
- Test: `/Users/xp/vibecoding/pilipili/scripts/test-telegram-agent-authorization.ts`

- [ ] **Step 1: Write the failing test**

Create `/Users/xp/vibecoding/pilipili/scripts/test-telegram-agent-authorization.ts` with a temporary SQLite database and assertions for pending grants, active grants, token lookup, revocation, and read-log writes:

```ts
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';

async function run() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pilipili-telegram-agent-auth-'));
  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');

  try {
    const {
      savePendingTelegramAgentGrant,
      readPendingTelegramAgentGrantForUser,
      upsertTelegramAgentGrant,
      getTelegramAgentGrantByToken,
      revokeTelegramAgentGrant,
      recordTelegramAgentGrantRead,
      listActiveTelegramAgentGrants,
    } = await import('../lib/server/telegramAgentGrantRepo');
    const { hashTelegramAgentToken } = await import('../lib/server/telegramAgentToken');

    const pending = savePendingTelegramAgentGrant({
      approvalChatId: '-5130530086',
      requestedChatId: '-1001234567890',
      requestedByTelegramUserId: '42',
      requestedByTelegramUsername: 'xp',
    });
    assert.equal(pending.status, 'waiting_agent_name');
    assert.equal(readPendingTelegramAgentGrantForUser('42')?.requestedChatId, '-1001234567890');

    const rawToken = 'tgagt_fixture_token';
    const grant = upsertTelegramAgentGrant({
      approvalChatId: '-5130530086',
      agentName: 'researcher-a',
      chatId: '-1001234567890',
      scope: ['search', 'tail'],
      tokenHash: hashTelegramAgentToken(rawToken),
      tokenPreview: rawToken.slice(0, 8),
      createdByTelegramUserId: '42',
      createdByTelegramUsername: 'xp',
    });
    assert.equal(grant.status, 'active');
    assert.equal(getTelegramAgentGrantByToken(rawToken)?.agentName, 'researcher-a');

    recordTelegramAgentGrantRead({
      grantId: grant.id,
      agentName: grant.agentName,
      chatId: grant.chatId,
      command: 'tail',
      scope: 'tail',
      query: null,
      limitValue: 50,
      resultCount: 12,
      success: true,
      errorCode: null,
    });
    assert.equal(listActiveTelegramAgentGrants().length, 1);

    revokeTelegramAgentGrant({
      agentName: 'researcher-a',
      chatId: '-1001234567890',
      revokedByTelegramUserId: '42',
    });
    assert.equal(getTelegramAgentGrantByToken(rawToken)?.status, 'revoked');

    console.log('PASS telegram agent authorization repo');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

void run().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-telegram-agent-authorization.ts`
Expected: FAIL with missing module errors or missing tables/functions for the new grant repo.

- [ ] **Step 3: Write minimal implementation**

In `/Users/xp/vibecoding/pilipili/lib/server/sqlite.ts`, add the three tables:

```sql
CREATE TABLE IF NOT EXISTS telegram_agent_pending_grants (
  id TEXT PRIMARY KEY,
  approval_chat_id TEXT NOT NULL,
  requested_chat_id TEXT NOT NULL,
  requested_by_telegram_user_id TEXT NOT NULL,
  requested_by_telegram_username TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_agent_pending_grants_waiting_user
ON telegram_agent_pending_grants(requested_by_telegram_user_id)
WHERE status = 'waiting_agent_name';

CREATE TABLE IF NOT EXISTS telegram_agent_grants (
  id TEXT PRIMARY KEY,
  approval_chat_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  scope_json TEXT NOT NULL DEFAULT '[]',
  token_hash TEXT NOT NULL,
  token_preview TEXT NOT NULL,
  status TEXT NOT NULL,
  created_by_telegram_user_id TEXT NOT NULL,
  created_by_telegram_username TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_by_telegram_user_id TEXT,
  last_used_at INTEGER,
  use_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(agent_name, chat_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_agent_grants_token_hash
ON telegram_agent_grants(token_hash);

CREATE TABLE IF NOT EXISTS telegram_agent_grant_reads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  grant_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  command TEXT NOT NULL,
  scope TEXT NOT NULL,
  query TEXT,
  limit_value INTEGER,
  result_count INTEGER,
  success INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  used_at INTEGER NOT NULL
);
```

Create `/Users/xp/vibecoding/pilipili/lib/server/telegramAgentToken.ts` with deterministic hashing and secure token generation:

```ts
import crypto from 'node:crypto';

export function generateTelegramAgentToken() {
  return crypto.randomBytes(24).toString('base64url');
}

export function hashTelegramAgentToken(token: string) {
  return crypto.createHash('sha256').update(token.trim()).digest('hex');
}
```

Create `/Users/xp/vibecoding/pilipili/lib/server/telegramAgentGrantRepo.ts` with helpers for:

- saving/replacing one pending grant per Telegram user
- reading and cancelling the current pending grant
- upserting an `agentName + chatId` grant
- lookup by raw token via `hashTelegramAgentToken`
- listing active grants
- revoking a grant
- recording a read audit and bumping `last_used_at` / `use_count`

- [ ] **Step 4: Run test to verify it passes**

Run: `NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-telegram-agent-authorization.ts`
Expected: PASS with `PASS telegram agent authorization repo`.

- [ ] **Step 5: Commit**

```bash
git add lib/server/sqlite.ts lib/server/telegramAgentGrantRepo.ts lib/server/telegramAgentToken.ts scripts/test-telegram-agent-authorization.ts
git commit -m "feat: add telegram agent grant storage"
```

### Task 2: Implement approval-bot command service and admin gating

**Files:**
- Create: `/Users/xp/vibecoding/pilipili/lib/server/telegramApprovalAdmin.ts`
- Create: `/Users/xp/vibecoding/pilipili/lib/server/telegramAgentApprovalBot.ts`
- Modify: `/Users/xp/vibecoding/pilipili/lib/server/telegramNotify.ts`
- Test: `/Users/xp/vibecoding/pilipili/scripts/test-telegram-agent-authorization.ts`

- [ ] **Step 1: Write the failing test**

Extend `/Users/xp/vibecoding/pilipili/scripts/test-telegram-agent-authorization.ts` with command-flow assertions that do not hit Telegram:

```ts
process.env.TELEGRAM_APPROVAL_ADMIN_USER_IDS = '42';

const { handleTelegramApprovalBotMessage } = await import('../lib/server/telegramAgentApprovalBot');

const replies: string[] = [];
const grantReply = await handleTelegramApprovalBotMessage({
  approvalChatId: '-5130530086',
  text: '/grant -1001234567890',
  fromUserId: '42',
  fromUsername: 'xp',
  sendMessage: async ({ text }) => {
    replies.push(text);
  },
});
assert.equal(grantReply.handled, true);
assert.match(replies[0] || '', /请继续发送/);

const agentReply = await handleTelegramApprovalBotMessage({
  approvalChatId: '-5130530086',
  text: '/agent researcher-a',
  fromUserId: '42',
  fromUsername: 'xp',
  sendMessage: async ({ text }) => {
    replies.push(text);
  },
});
assert.equal(agentReply.handled, true);
assert.match(replies.at(-1) || '', /授权已创建/);
assert.match(replies.at(-1) || '', /researcher-a/);

const accessReply = await handleTelegramApprovalBotMessage({
  approvalChatId: '-5130530086',
  text: '/access agent researcher-a',
  fromUserId: '42',
  fromUsername: 'xp',
  sendMessage: async ({ text }) => {
    replies.push(text);
  },
});
assert.equal(accessReply.handled, true);
assert.match(replies.at(-1) || '', /active chats/);
```

Also add a non-admin check:

```ts
const denied = await handleTelegramApprovalBotMessage({
  approvalChatId: '-5130530086',
  text: '/grant -1009999999999',
  fromUserId: '100',
  fromUsername: 'guest',
  sendMessage: async ({ text }) => {
    replies.push(text);
  },
});
assert.equal(denied.handled, true);
assert.match(replies.at(-1) || '', /无权限|not allowed/i);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-telegram-agent-authorization.ts`
Expected: FAIL because the approval bot handler and admin parser do not exist.

- [ ] **Step 3: Write minimal implementation**

Create `/Users/xp/vibecoding/pilipili/lib/server/telegramApprovalAdmin.ts`:

```ts
export function readTelegramApprovalAdminUserIds() {
  return new Set(
    (process.env.TELEGRAM_APPROVAL_ADMIN_USER_IDS || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

export function isTelegramApprovalAdmin(userId: string) {
  return readTelegramApprovalAdminUserIds().has((userId || '').trim());
}
```

Create `/Users/xp/vibecoding/pilipili/lib/server/telegramAgentApprovalBot.ts` with:

- `handleTelegramApprovalBotMessage`
- strict approval-chat check for `-5130530086`
- `/grant`, `/agent`, `/access`, `/revoke`, `/pending`, `/cancel` parsing
- text replies that match the spec
- token creation via `generateTelegramAgentToken`

Use a dependency-injected sender shape:

```ts
sendMessage: (input: { chatId: string; text: string }) => Promise<void>
```

In `/Users/xp/vibecoding/pilipili/lib/server/telegramNotify.ts`, add an optional HTML-free sender helper that preserves the current behavior:

```ts
export async function sendTelegramTextMessage(params: { chatId: string; text: string }) { ... }
```

No behavior change is required, but keep the function reusable from the approval bot worker.

- [ ] **Step 4: Run test to verify it passes**

Run: `NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-telegram-agent-authorization.ts`
Expected: PASS with command-flow assertions succeeding and one grant created.

- [ ] **Step 5: Commit**

```bash
git add lib/server/telegramApprovalAdmin.ts lib/server/telegramAgentApprovalBot.ts lib/server/telegramNotify.ts scripts/test-telegram-agent-authorization.ts
git commit -m "feat: add telegram approval bot command flow"
```

### Task 3: Add approval-bot long-poll worker and package scripts

**Files:**
- Create: `/Users/xp/vibecoding/pilipili/lib/server/telegramApprovalBotRuntime.ts`
- Create: `/Users/xp/vibecoding/pilipili/scripts/telegram-agent-approval-bot.ts`
- Modify: `/Users/xp/vibecoding/pilipili/package.json`
- Test: `/Users/xp/vibecoding/pilipili/scripts/test-telegram-agent-authorization.ts`

- [ ] **Step 1: Write the failing test**

Extend `/Users/xp/vibecoding/pilipili/scripts/test-telegram-agent-authorization.ts` with a runtime test that stubs `getUpdates` and the handler:

```ts
const { runTelegramApprovalBotCycle } = await import('../lib/server/telegramApprovalBotRuntime');

const seen: string[] = [];
const cycle = await runTelegramApprovalBotCycle({
  approvalChatId: '-5130530086',
  fetchUpdates: async () => [
    {
      update_id: 10,
      message: {
        chat: { id: '-5130530086' },
        from: { id: 42, username: 'xp' },
        text: '/grant -1001234567890',
      },
    },
  ],
  handleMessage: async ({ text }) => {
    seen.push(text);
    return { handled: true };
  },
  readOffset: () => 0,
  saveOffset: () => {},
});
assert.equal(cycle.lastUpdateId, 10);
assert.deepEqual(seen, ['/grant -1001234567890']);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-telegram-agent-authorization.ts`
Expected: FAIL because the runtime/worker entrypoint does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `/Users/xp/vibecoding/pilipili/lib/server/telegramApprovalBotRuntime.ts` with:

- `runTelegramApprovalBotCycle`
- `telegramApi(method, body)` helper using the bot token from `resolveTelegramBotToken()`
- `getUpdates` long polling with:

```ts
allowed_updates: ['message', 'edited_message']
```

- cursor persistence through `readTelegramIngestCursor('telegram-agent-approval-bot')` and `saveTelegramIngestCursor(...)`
- worker status updates via `upsertWorkerStatus`

Create `/Users/xp/vibecoding/pilipili/scripts/telegram-agent-approval-bot.ts` as a thin loop that:

- loads `.env.local`
- calls `deleteWebhook`
- runs `runTelegramApprovalBotCycle()` in a loop
- sleeps briefly on failure

Add package scripts:

```json
"telegram:agent:approval-bot": "NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/telegram-agent-approval-bot.ts",
"test:telegram-agent-authorization": "NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/test-telegram-agent-authorization.ts"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:telegram-agent-authorization`
Expected: PASS and the runtime test records one handled update with `lastUpdateId = 10`.

- [ ] **Step 5: Commit**

```bash
git add lib/server/telegramApprovalBotRuntime.ts scripts/telegram-agent-approval-bot.ts package.json scripts/test-telegram-agent-authorization.ts
git commit -m "feat: add telegram approval bot worker"
```

### Task 4: Extend the GramJS client with read-only chat `tail` and `search`

**Files:**
- Modify: `/Users/xp/vibecoding/pilipili/lib/server/telegramChannelTypes.ts`
- Modify: `/Users/xp/vibecoding/pilipili/lib/server/telegramGramjsClient.ts`
- Test: `/Users/xp/vibecoding/pilipili/scripts/test-telegram-agent-authorization.ts`

- [ ] **Step 1: Write the failing test**

Extend `/Users/xp/vibecoding/pilipili/scripts/test-telegram-agent-authorization.ts` with shape tests for the mapping layer:

```ts
const { mapTelegramMessageToAgentReadItem } = await import('../lib/server/telegramGramjsClient');

const mapped = mapTelegramMessageToAgentReadItem({
  id: 501,
  message: 'alpha beta',
  date: new Date(1710000000000),
  fromId: { userId: 77n },
  sender: {
    id: 77,
    username: 'alice',
    firstName: 'Alice',
    lastName: 'Z',
  },
});

assert.equal(mapped?.messageId, 501);
assert.equal(mapped?.text, 'alpha beta');
assert.equal(mapped?.sender?.username, 'alice');
assert.equal(mapped?.sender?.displayName, 'Alice Z');
```

Keep this task focused on the pure mapping helper so the test stays offline and deterministic. The service-level behavior of `listAgentChatMessages` and `searchAgentChatMessages` will be exercised with stubs in Task 5.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:telegram-agent-authorization`
Expected: FAIL because the mapping helper and client methods do not exist.

- [ ] **Step 3: Write minimal implementation**

In `/Users/xp/vibecoding/pilipili/lib/server/telegramChannelTypes.ts`, add:

```ts
export interface TelegramAgentReadItem {
  messageId: number;
  date: number;
  text: string;
  sender: {
    id: string | null;
    username: string | null;
    displayName: string | null;
  } | null;
}
```

Extend `TelegramChannelSyncClient` with:

```ts
listAgentChatMessages?(params: { chatId: string; limit: number }): Promise<TelegramAgentReadItem[]>;
searchAgentChatMessages?(params: { chatId: string; query: string; limit: number }): Promise<{
  searchMode: 'telegram' | 'recent-scan';
  items: TelegramAgentReadItem[];
}>;
```

In `/Users/xp/vibecoding/pilipili/lib/server/telegramGramjsClient.ts`, add:

- `mapTelegramMessageToAgentReadItem`
- `listAgentChatMessages`
- `searchAgentChatMessages`

Use GramJS `iterMessages(entity, { limit })` for `tail` and `iterMessages(entity, { search: query, limit })` for `search`. If `search` throws an unsupported-mode error, fall back to fetching a recent window and applying:

```ts
item.text.toLowerCase().includes(query.toLowerCase())
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:telegram-agent-authorization`
Expected: PASS with the mapping helper returning `messageId = 501` and sender metadata.

- [ ] **Step 5: Commit**

```bash
git add lib/server/telegramChannelTypes.ts lib/server/telegramGramjsClient.ts scripts/test-telegram-agent-authorization.ts
git commit -m "feat: add telegram agent read mtproto helpers"
```

### Task 5: Build the token-gated read service and CLI

**Files:**
- Create: `/Users/xp/vibecoding/pilipili/lib/server/telegramAgentReadService.ts`
- Create: `/Users/xp/vibecoding/pilipili/scripts/telegram-agent-read.ts`
- Modify: `/Users/xp/vibecoding/pilipili/package.json`
- Test: `/Users/xp/vibecoding/pilipili/scripts/test-telegram-agent-authorization.ts`

- [ ] **Step 1: Write the failing test**

Extend `/Users/xp/vibecoding/pilipili/scripts/test-telegram-agent-authorization.ts` with service-level assertions:

```ts
const { runTelegramAgentRead } = await import('../lib/server/telegramAgentReadService');

const okTail = await runTelegramAgentRead({
  mode: 'tail',
  chatId: '-1001234567890',
  token: rawToken,
  limit: 2,
  client: {
    async listAgentChatMessages() {
      return [{ messageId: 1, date: 1710000000, text: 'hello', sender: null }];
    },
    async searchAgentChatMessages() {
      return { searchMode: 'telegram', items: [] };
    },
    async resolveChannel() {
      throw new Error('unused');
    },
    async listChannelMessages() {
      return [];
    },
  },
});
assert.equal(okTail.ok, true);
assert.equal(okTail.mode, 'tail');
assert.equal(okTail.items.length, 1);

const mismatch = await runTelegramAgentRead({
  mode: 'tail',
  chatId: '-1009999999999',
  token: rawToken,
  limit: 2,
  client: stubClient,
});
assert.equal(mismatch.ok, false);
assert.equal(mismatch.error, 'chat_mismatch');

const revoked = await runTelegramAgentRead({
  mode: 'search',
  chatId: '-1001234567890',
  token: rawToken,
  query: 'hello',
  limit: 2,
  client: stubClient,
});
assert.equal(revoked.ok, false);
assert.equal(revoked.error, 'grant_revoked');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:telegram-agent-authorization`
Expected: FAIL because the read service and CLI do not exist.

- [ ] **Step 3: Write minimal implementation**

Create `/Users/xp/vibecoding/pilipili/lib/server/telegramAgentReadService.ts` with:

- `runTelegramAgentRead`
- token lookup and status check
- `chatId` equality enforcement
- scope enforcement
- `limit` clamping:

```ts
const safeTailLimit = Math.min(Math.max(limit || 50, 1), 200);
const safeSearchLimit = Math.min(Math.max(limit || 20, 1), 100);
```

- audit writes via `recordTelegramAgentGrantRead`
- JSON result unions:

```ts
type TelegramAgentReadResult =
  | { ok: true; mode: 'tail'; chatId: string; grant: { agentName: string; scope: string[] }; items: TelegramAgentReadItem[] }
  | { ok: true; mode: 'search'; chatId: string; query: string; searchMode: 'telegram' | 'recent-scan'; grant: { agentName: string; scope: string[] }; items: TelegramAgentReadItem[] }
  | { ok: false; error: 'invalid_token' | 'grant_not_found' | 'grant_revoked' | 'chat_mismatch' | 'scope_denied' | 'query_required' | 'telegram_auth_unavailable' | 'telegram_chat_unavailable' };
```

Create `/Users/xp/vibecoding/pilipili/scripts/telegram-agent-read.ts` with a tiny argv parser:

```ts
const mode = argv[0];
const chatId = readFlag('--chat-id');
const token = readFlag('--token');
const query = readFlag('--query');
const limit = Number.parseInt(readFlag('--limit') || '', 10);
```

Print only JSON:

```ts
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
```

Add package script:

```json
"telegram:agent:read": "NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/telegram-agent-read.ts"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:telegram-agent-authorization`
Expected: PASS with `ok: true` for the matching token/chat pair and `chat_mismatch`/`grant_revoked` for the negative cases.

- [ ] **Step 5: Commit**

```bash
git add lib/server/telegramAgentReadService.ts scripts/telegram-agent-read.ts package.json scripts/test-telegram-agent-authorization.ts
git commit -m "feat: add token-gated telegram agent read cli"
```

### Task 6: Wire the new tests into tooling and verify end-to-end developer ergonomics

**Files:**
- Modify: `/Users/xp/vibecoding/pilipili/scripts/test-tooling-config.ts`
- Modify: `/Users/xp/vibecoding/pilipili/package.json`
- Test: `/Users/xp/vibecoding/pilipili/scripts/test-tooling-config.ts`

- [ ] **Step 1: Write the failing test**

In `/Users/xp/vibecoding/pilipili/scripts/test-tooling-config.ts`, add a tooling assertion that `package.json` exposes the new targeted test command:

```ts
assert.equal(
  typeof packageJson.scripts['test:telegram-agent-authorization'],
  'string',
  'package.json should expose a telegram agent authorization test command'
);
```

If the full `npm test` suite is intentionally kept smaller, add the assertion against `packageJson.scripts['test:telegram-agent-authorization']` instead and update the expectation string accordingly.

- [ ] **Step 2: Run test to verify it fails**

Run: `tsx scripts/test-tooling-config.ts`
Expected: FAIL because the new script is not yet referenced by the tooling checks.

- [ ] **Step 3: Write minimal implementation**

Update `/Users/xp/vibecoding/pilipili/package.json` and `/Users/xp/vibecoding/pilipili/scripts/test-tooling-config.ts` so the new command is present and checked. Keep the main `test` script unchanged and assert the targeted script entry directly:

```ts
assert.equal(
  typeof packageJson.scripts['test:telegram-agent-authorization'],
  'string',
  'package.json should expose a telegram agent authorization test command'
);
```

- [ ] **Step 4: Run verification commands**

Run these commands in order:

```bash
npm run test:telegram-agent-authorization
tsx scripts/test-tooling-config.ts
```

Expected:

- `test:telegram-agent-authorization` prints `PASS telegram agent authorization repo`
- `test-tooling-config` prints its normal PASS output with the new assertion satisfied

- [ ] **Step 5: Commit**

```bash
git add package.json scripts/test-tooling-config.ts
git commit -m "test: cover telegram agent authorization tooling"
```

## Self-Review

### Spec coverage

- Approval-group-only flow: covered by Task 2 and Task 3.
- Two-step `/grant` -> `/agent` flow: covered by Task 2.
- Persistent `agentName + chatId` grants with token rotation and revocation: covered by Task 1 and Task 2.
- `tail` / `search` CLI with JSON output and token checks: covered by Task 4 and Task 5.
- Audit logging and use counters: covered by Task 1 and Task 5.
- Package-level developer ergonomics for running the new tests: covered by Task 3 and Task 6.

### Placeholder scan

- No `TODO`, `TBD`, or “implement later” placeholders remain.
- Every code-changing step names exact files and includes concrete snippets.
- Every verification step includes an exact command and expected outcome.

### Type consistency

- Grant status values stay `waiting_agent_name | completed | cancelled` for pending rows and `active | revoked` for formal grants.
- Read modes stay `tail | search`.
- Error codes stay `invalid_token | grant_not_found | grant_revoked | chat_mismatch | scope_denied | query_required | telegram_auth_unavailable | telegram_chat_unavailable`.
