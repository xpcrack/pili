# Conservative Codebase Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce duplicated control flow and make the high-churn feed paths easier to read and cheaper to execute without changing public API contracts, database semantics, or displayed results.

**Architecture:** Keep the existing runtime and repository boundaries. Extract pure Telegram update parsing/response helpers first, then isolate provisional projection persistence behind one service function. Preserve `ingestTelegramMonitorUpdate`, `useActivityPolling`, and repository exports as compatibility façades so callers do not change. Defer SQLite schema splitting and large UI component extraction until the smaller refactor has a clean baseline.

**Tech Stack:** Node `24.11.1`, TypeScript, React, Hono/Bun runtime, SQLite via `better-sqlite3`/`bun:sqlite`, repository test runner in `scripts/lib/runTests.ts`.

---

### Task 1: Capture a reproducible baseline

**Files:**
- Modify: `docs/superpowers/plans/2026-08-09-conservative-codebase-refactor-plan.md`
- Test: existing `scripts/test-telegram-fast-ingest.ts`, `scripts/test-telegram-fast-event-upsert.ts`, `scripts/test-trade-display-amount-fallback.ts`

- [ ] **Step 1: Confirm the worktree and runtime baseline**

Run:

```bash
node --version
git status --short
npm test -- --filter=telegram-fast
npm test -- --filter=trade-display-amount-fallback
```

Expected: Node `v24.11.1`, no unrelated worktree changes, and all three focused tests pass.

- [ ] **Step 2: Record the compatibility boundary**

Keep these exports and behavior unchanged throughout the refactor:

```ts
export function ingestTelegramMonitorUpdate(
  body: TelegramUpdateLike,
  channelType?: 'news' | 'social',
): Promise<unknown>;

export function authorizeTelegramMonitorHeaders(headers: Headers): {
  ok: boolean;
  status?: number;
  body?: { ok: false; error: string };
};
```

Also preserve the `doorbell`, `project`, and `off` feed-mode decisions, raw audit writes, provisional event writes, reconciliation scheduling, and tweet-link enrichment rules.

---

### Task 2: Extract pure Telegram update helpers

**Files:**
- Create: `lib/server/telegramMonitorUpdateHelpers.ts`
- Modify: `lib/server/telegramMonitorIngest.ts:70-190`
- Create: `scripts/test-telegram-monitor-update-helpers.ts`

- [ ] **Step 1: Write characterization tests before moving code**

Add tests for message precedence, text extraction, and link ordering:

```ts
const update = {
  update_id: 7,
  message: {
    message_id: 9,
    text: 'message text',
    caption: 'caption text',
    entities: [{ type: 'text_link', url: 'https://xxyy.io/message' }],
    reply_markup: { inline_keyboard: [[{ url: 'https://scan.example/tx' }]] },
  },
  channel_post: { message_id: 10, text: 'channel text' },
};

assert.equal(extractTelegramMessage(update)?.message_id, 9);
assert.equal(extractTelegramMessageText(update.message), 'message text');
assert.deepEqual(collectTelegramMessageLinks(update.message), [
  'https://xxyy.io/message',
  'https://scan.example/tx',
]);
```

- [ ] **Step 2: Run the helper test and verify it fails**

Run:

```bash
npm test -- --filter=telegram-monitor-update-helpers
```

Expected: FAIL because `lib/server/telegramMonitorUpdateHelpers.ts` does not exist yet.

- [ ] **Step 3: Move only the pure helper implementations**

Create the helper module with the existing message shapes and no database or network imports:

```ts
export function extractTelegramMessage(update: TelegramUpdateLike): TelegramMessageLike | null {
  return update.message || update.channel_post || update.edited_message || update.edited_channel_post || null;
}

export function extractTelegramMessageText(message: TelegramMessageLike): string {
  return (
    (typeof message.text === 'string' && message.text.trim()) ||
    (typeof message.caption === 'string' && message.caption.trim()) ||
    ''
  );
}

export function collectTelegramMessageLinks(message: TelegramMessageLike): string[] {
  const links = new Set<string>();
  for (const entity of [...(message.entities || []), ...(message.caption_entities || [])]) {
    if (entity.type === 'text_link' && typeof entity.url === 'string' && entity.url.trim()) {
      links.add(entity.url.trim());
    }
  }
  for (const row of message.reply_markup?.inline_keyboard || []) {
    for (const button of row || []) {
      if (typeof button?.url === 'string' && button.url.trim()) {
        links.add(button.url.trim());
      }
    }
  }
  return [...links];
}
```

Export `TelegramMessageLike` and `TelegramUpdateLike` from this module, import them into `telegramMonitorIngest.ts`, and delete the old local definitions/functions. Do not alter filtering, authorization, or projection code in this task.

- [ ] **Step 4: Run the helper and existing Telegram tests**

Run:

```bash
npm test -- --filter=telegram-monitor-update-helpers
npm test -- --filter=telegram-fast
npm test -- --filter=telegram-doorbell-projection
```

Expected: all focused tests pass with identical projection counts and no network calls in doorbell mode.

- [ ] **Step 5: Commit the isolated extraction**

```bash
git add lib/server/telegramMonitorUpdateHelpers.ts lib/server/telegramMonitorIngest.ts scripts/test-telegram-monitor-update-helpers.ts
git commit -m "refactor: extract telegram update helpers"
```

---

### Task 3: Isolate provisional Telegram projection persistence

**Files:**
- Create: `lib/server/telegramMonitorProjectionService.ts`
- Modify: `lib/server/telegramMonitorIngest.ts:469-662`
- Modify: `scripts/test-telegram-fast-ingest.ts`
- Modify: `scripts/test-telegram-doorbell-projection.ts`

- [ ] **Step 1: Add a characterization test for the service boundary**

Expose one service function whose inputs are already parsed and whose return value only reports projection status:

```ts
const result = await projectAndPersistTelegramMonitorUpdate({
  parsed,
  user: trackedUser,
  sourceChatId: '-100123456',
  sourceMessageId: 611,
  eventTimeMs: fixture.fallbackTimestampMs,
  rawText: fixture.text,
  messageLinks: fixture.linkCandidates,
  feedMode: 'doorbell',
});

assert.equal(result.projected, true);
assert.equal(result.txState?.txHash, fixture.expected.txHash);
```

- [ ] **Step 2: Run the new boundary test and verify it fails**

Run:

```bash
npm test -- --filter=telegram-projection-service
```

Expected: FAIL because the service module/export does not exist.

- [ ] **Step 3: Move the existing projection sequence without changing order**

The new service must preserve this exact order:

1. summarize the provisional transaction;
2. upsert provisional tx state with SQLite retry;
3. project from tx state or raw event with local USD calculation enabled;
4. score only in `project` mode;
5. persist canonical provisional activity to tx state/event;
6. use `upsertTelegramMonitorProvisionalEventFast` in `doorbell` mode and the existing full upsert in `project` mode;
7. fetch linked tweets only in `project` mode;
8. trigger reconciliation only for non-Robinhood `project` mode.

The service signature must be explicit and typed:

```ts
export interface ProjectAndPersistTelegramMonitorUpdateParams {
  parsed: ParseXxyyTelegramResult;
  user: User;
  sourceChatId: string | null;
  sourceMessageId: number | null;
  eventTimeMs: number;
  rawText: string;
  messageLinks: string[];
  feedMode: 'doorbell' | 'project';
}

export interface ProjectAndPersistTelegramMonitorUpdateResult {
  projected: boolean;
  txState: TelegramMonitorTxState | null;
}
```

Keep notification/error handling in `ingestTelegramMonitorUpdate`; the service should throw so the caller can retain its existing doorbell fallback response.

- [ ] **Step 4: Replace the nested block with one service call**

`telegramMonitorIngest.ts` should keep only validation, raw event persistence, doorbell enqueue, feed-mode branching, and response shaping. The former 190-line `try` block becomes one `try` around the service call plus the existing error response.

- [ ] **Step 5: Run projection, fast-ingest, build, and type checks**

Run:

```bash
npm test -- --filter=telegram-projection-service
npm test -- --filter=telegram-fast
npm test -- --filter=telegram-doorbell-projection
npm run build
npx tsc --noEmit
```

Expected: focused tests and build pass; any unrelated baseline TypeScript failures must be listed by file and not hidden.

- [ ] **Step 6: Commit the service extraction**

```bash
git add lib/server/telegramMonitorProjectionService.ts lib/server/telegramMonitorIngest.ts scripts/test-telegram-fast-ingest.ts scripts/test-telegram-doorbell-projection.ts
git commit -m "refactor: isolate telegram provisional projection"
```

---

### Task 4: Make the feed polling hook easier to reason about without changing its public contract

**Files:**
- Create: `hooks/feedPollingTypes.ts`
- Create: `hooks/feedPollingCache.ts`
- Modify: `hooks/useActivityPolling.ts:70-390`
- Create: `scripts/test-feed-polling-cache.ts`

- [ ] **Step 1: Extract stable types and cache operations**

Move `FetchActivitiesOptions`, the return shape currently repeated by `fetchActivities`, and `GlobalFeedCache` into `hooks/feedPollingTypes.ts`. Add pure helpers in `hooks/feedPollingCache.ts`:

```ts
export function captureGlobalFeedCache(params: GlobalFeedCacheInput): GlobalFeedCache;
export function restoreGlobalFeedCache(cache: GlobalFeedCache): FeedPollingAction;
```

These helpers must clone arrays/maps exactly as the current hook does, preserving cursor, revision, summaries, diagnostics, and user activity maps.

- [ ] **Step 2: Add cache round-trip tests**

Assert that capturing then restoring a representative cache preserves feed order, map contents, cursor, revision, and metadata while producing new array/map instances.

- [ ] **Step 3: Replace inline cache construction/restoration**

Use the helpers in the global-to-user and user-to-global transitions. Do not alter request arbitration, polling intervals, reducer actions, or effect dependency arrays.

- [ ] **Step 4: Verify frontend behavior statically and through the build**

Run:

```bash
npm test -- --filter=feed-polling-cache
npm run build
```

Expected: cache tests pass and the Vite build succeeds.

- [ ] **Step 5: Commit the hook organization change**

```bash
git add hooks/feedPollingTypes.ts hooks/feedPollingCache.ts hooks/useActivityPolling.ts scripts/test-feed-polling-cache.ts
git commit -m "refactor: isolate feed polling cache state"
```

---

### Task 5: Remove only verified dead code and noisy diagnostics

**Files:**
- Inspect: `lib/server/twitterEnrichmentService.ts`, `lib/server/historicalPeakRepair.ts`, `lib/server/activityImportanceBackfill.ts`, `scripts/package.json` references, and all `app/api/**/route.ts` debug routes
- Modify: only files proven unused by import and script checks
- Test: `scripts/test-tooling-config.ts`, relevant route tests

- [ ] **Step 1: Prove each candidate is unused**

Run:

```bash
rg -n "twitterEnrichmentService|historicalPeakRepair|activityImportanceBackfill" . --glob '!node_modules/**' --glob '!.data/**'
```

Keep any file referenced by a package script, dynamic import, route registration, or operational documentation.

- [ ] **Step 2: Delete only proven dead files or replace duplicate debug logging**

Do not remove production error logs, API routes, or backfill scripts merely because they are not imported by application code.

- [ ] **Step 3: Run tooling and build verification**

```bash
npm test -- --filter=tooling-config
npm run build
git diff --check
```

- [ ] **Step 4: Commit the cleanup separately**

```bash
git add <verified-files-only>
git commit -m "chore: remove verified dead code"
```

---

### Task 6: Final verification and runtime handoff

**Files:**
- Inspect: all changed files, `git diff`, PM2 runtime status
- Modify: none unless verification finds a regression

- [ ] **Step 1: Run the focused regression suite**

```bash
npm test -- --filter=telegram-fast
npm test -- --filter=telegram-doorbell-projection
npm test -- --filter=telegram-monitor-update-helpers
npm test -- --filter=telegram-projection-service
npm test -- --filter=feed-polling-cache
npm run build
git diff --check
```

- [ ] **Step 2: Run the existing full check and report known baseline failures**

```bash
npm run check
```

If it fails on pre-existing schema fixture or unrelated TypeScript errors, record the exact files and keep the refactor changes separate from those failures.

- [ ] **Step 3: Inspect production status without restarting workers by default**

```bash
npm run runtime:status
```

Because the current refactor primarily changes worker/server source files, do not restart PM2 workers automatically. Apply a worker restart only when explicitly requested; use `npm run runtime:refresh` only if web bundle files changed and the build passed.

- [ ] **Step 4: Commit the final verified changes**

```bash
git status --short
git log --oneline -5
```

Expected: a clean worktree, each refactor commit visible, and runtime status documented in the handoff.

---

## Scope review

- Covered: high-frequency Telegram ingestion, duplicated update parsing, provisional projection persistence, feed polling cache organization, and verified dead-code cleanup.
- Deliberately deferred: `lib/server/sqlite.ts` schema splitting, `app/manage/page.tsx` component extraction, `components/ActivityCard.tsx` redesign, and `lib/server/twitterFetcher.ts` provider split. These are larger changes with higher regression surface and should be separate plans after this one passes.
- No behavior changes: no API response shape changes, no database migrations, no changes to scoring/reconciliation rules, no changes to PM2 process topology.

## Execution record (2026-08-09)

- Task 1 complete: Node `v24.11.1`; focused baseline tests passed.
- Task 2 complete: `telegramMonitorUpdateHelpers.ts` extracted and characterized; helper, fast ingest, and doorbell tests passed.
- Task 3 complete: `telegramMonitorProjectionService.ts` extracted; projection, fast ingest, doorbell, and production build passed.
- Task 4 complete: feed polling cache/types extracted; cache round-trip test and production build passed.
- Task 5 inspected: all three candidate files are referenced by scripts or runtime imports, so none were deleted.
- Task 6 verification: production build passed; the Telegram suite is `13 pass / 3 pre-existing fixture or schema failures`; `npm run check` remains blocked by the existing repository-wide TypeScript errors listed in its output.
- Runtime policy: no PM2 worker restart was performed for this refactor; use the existing runtime refresh/restart rules when deploying a desired stage.
