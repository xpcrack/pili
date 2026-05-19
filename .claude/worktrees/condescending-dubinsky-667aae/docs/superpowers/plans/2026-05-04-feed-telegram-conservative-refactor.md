# Feed + Telegram Conservative Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep current feed and Telegram monitor behavior unchanged while making the client feed pipeline and Telegram feed projection pipeline easier to read, test, and extend.

**Architecture:** Preserve the current public entry points and split the work into two low-risk refactors: a pure client-side feed snapshot pipeline helper and a server-side Telegram feed helper layer. The hook and server entry functions remain orchestration layers, while pure mapping, merge, and dedupe logic move behind named helpers with focused tests.

**Tech Stack:** Next.js 16, React 19, TypeScript, Zustand, better-sqlite3, tsx script tests

---

### Task 1: Create Isolated Worktree And Verify Baseline

**Files:**
- Modify: `docs/superpowers/plans/2026-05-04-feed-telegram-conservative-refactor.md`
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
git worktree add .worktrees/codex-feed-telegram-conservative-refactor -b codex/feed-telegram-conservative-refactor
```

Expected: new worktree created at `.worktrees/codex-feed-telegram-conservative-refactor`

- [ ] **Step 3: Install dependencies if needed in the new worktree**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-feed-telegram-conservative-refactor
npm install
```

Expected: install completes without dependency resolution errors

- [ ] **Step 4: Run the baseline verification subset before any code changes**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-feed-telegram-conservative-refactor
npm run test:activities-api
npm run test:feed-client-state
npm run test:feed-page-state
npm run test:telegram-monitor-reconciliation
npm run build
```

Expected: all commands pass on the baseline branch state

- [ ] **Step 5: Commit nothing and record the clean starting point**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-feed-telegram-conservative-refactor
git status --short
```

Expected: no unexpected tracked changes before implementation begins

### Task 2: Refactor Client Feed Snapshot Pipeline

**Files:**
- Create: `lib/feed/feedClientSnapshot.ts`
- Modify: `hooks/useActivityPolling.ts`
- Modify: `lib/activitiesApi.ts`
- Test: `scripts/test-activities-api.ts`
- Test: `scripts/test-feed-client-state.ts`
- Test: `scripts/test-feed-page-state.ts`

- [ ] **Step 1: Write or extend the failing tests around preserved feed payload users and client-side filtering behavior**

Target assertions:

```ts
assert.equal(Array.isArray(paged.users), true);
assert.equal(paged.users?.[0]?.id, 'server-user-1');

assert.deepEqual(
  filterFeedByExistingUsers(serverFeed, mergedUsers).map((item) => item.user.id),
  ['alice', 'carol']
);
```

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-feed-telegram-conservative-refactor
npm run test:activities-api
npm run test:feed-client-state
```

Expected: at least one test fails for the new refactor target before implementation

- [ ] **Step 2: Create the pure client snapshot helper module**

Create `lib/feed/feedClientSnapshot.ts` with focused helpers shaped like:

```ts
import { type Activity, type User } from '@/types';
import { mergeManageUsersWithServer } from '@/lib/manageUsers';
import { mergeFeedItems, filterFeedByExistingUsers, type FeedItem } from '@/lib/feed/feedItemMerge';
import { type ActivityFeedResponse } from '@/lib/activitiesApi';

export function buildCollectedActivityFeedResult(params: {
  firstPageResult: ActivityFeedResponse | null;
  collectedFeed: Array<{ user: User; activity: Activity }>;
  currentUsers: User[];
  fullDatabaseSearch: boolean;
}): ActivityFeedResponse {
  // Return the final normalized response object used by the hook.
}

export function resolveFeedUsers(currentUsers: User[], resultUsers: User[] | undefined): User[] {
  // Prefer server users when available, but preserve local-only users.
}

export function applyServerFeedSnapshot(params: {
  replace: boolean;
  resultFeed: FeedItem[];
  effectiveUsers: User[];
}): FeedItem[] {
  // Merge-or-replace feed, then drop items whose users are not visible locally.
}
```

- [ ] **Step 3: Run tests to verify the new helper file alone does not change behavior yet**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-feed-telegram-conservative-refactor
npm run test:activities-api
npm run test:feed-client-state
```

Expected: tests still fail only for the unimplemented logic or integration path, not for syntax/type errors

- [ ] **Step 4: Refactor `lib/activitiesApi.ts` to keep response normalization focused and explicit**

Keep `fetchAllActivities()` public behavior intact, but make the payload normalization path preserve `users` explicitly and avoid mixing transport concerns with downstream hook concerns. The normalized shape should continue to include:

```ts
return {
  ok: true,
  feed,
  users: responseUsers,
  total,
  page,
  pageSize,
  hasMore,
  nextCursor,
  historyComplete,
  localQualifiedCount,
  activityBreakdown,
  completenessWindow,
  latestActivityAtByUser,
  diagnostics,
  summary,
  addressAssets,
  userAssets,
  prewarm,
  sync,
  syncTrigger,
} satisfies ActivityFeedResponse;
```

- [ ] **Step 5: Refactor `hooks/useActivityPolling.ts` to use the new helper pipeline**

Refactor the `fetchActivities()` callback so the central flow becomes:

```ts
const result = buildCollectedActivityFeedResult({
  firstPageResult: seededFirstPageResult,
  collectedFeed: collected.items,
  currentUsers,
  fullDatabaseSearch,
});

const effectiveUsers = resolveFeedUsers(currentUsers, result.users);
const mergedFeed = applyServerFeedSnapshot({
  replace,
  resultFeed: result.feed,
  effectiveUsers,
});
```

And keep these side effects in the hook layer:

```ts
usersRef.current = effectiveUsers;
mergeUsersFromServer(result.users ?? effectiveUsers);
setFeed(mergedFeed);
setSummary(result.summary);
setDiagnostics(result.diagnostics);
setHasMore(result.hasMore);
```

- [ ] **Step 6: Run the focused client pipeline verification**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-feed-telegram-conservative-refactor
npm run test:activities-api
npm run test:feed-client-state
npm run test:feed-page-state
```

Expected: all three commands pass

- [ ] **Step 7: Commit the client pipeline refactor**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-feed-telegram-conservative-refactor
git add lib/feed/feedClientSnapshot.ts lib/activitiesApi.ts hooks/useActivityPolling.ts scripts/test-activities-api.ts scripts/test-feed-client-state.ts scripts/test-feed-page-state.ts
git commit -m "refactor: clarify client feed snapshot pipeline"
```

Expected: one focused commit containing only the client pipeline refactor

### Task 3: Refactor Telegram Feed Projection Helpers

**Files:**
- Create: `lib/server/telegramMonitorFeedHelpers.ts`
- Modify: `lib/server/telegramMonitorFeed.ts`
- Test: `scripts/test-telegram-monitor-reconciliation.ts`
- Test: `scripts/test-parser-fixtures.ts`

- [ ] **Step 1: Lock the current Telegram monitor behavior with tests**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-feed-telegram-conservative-refactor
npm run test:telegram-monitor-reconciliation
npm run test:parser-fixtures
```

Expected: pass on baseline before the refactor starts

- [ ] **Step 2: Create the Telegram feed helper module**

Create `lib/server/telegramMonitorFeedHelpers.ts` with focused server-only helpers shaped like:

```ts
import type { Activity, User } from '@/types';
import type { TelegramMonitorFeedRow, BidOnchainEvent } from '@/lib/server/telegramMonitorFeed';
import type { TelegramMonitorFeedEvent } from '@/lib/server/telegramMonitorRepo';

export function buildTrackedAddressIndex(users: User[]) {
  // Preserve existing EVM expansion behavior.
}

export function pickMonitoredUser(/* same matching inputs as today */) {
  // Preserve existing alias/address matching behavior.
}

export function buildTelegramMonitorFeedDedupKey(activity: Activity): string {
  // Preserve current monitor aggregate key > logical tx key > activity.id order.
}

export function dedupeTelegramMonitorFeed(rows: TelegramMonitorFeedRow[], limit: number): TelegramMonitorFeedRow[] {
  // Preserve current "latest timestamp wins" behavior.
}
```

- [ ] **Step 3: Run tests to verify helper extraction scaffolding compiles**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-feed-telegram-conservative-refactor
npm run test:telegram-monitor-reconciliation
```

Expected: either current pass state remains or failures point only to incomplete integration, not type/syntax issues

- [ ] **Step 4: Refactor `projectTelegramMonitorEvent()` and `projectTelegramMonitorTxState()` to use shared helpers**

Keep the public signatures unchanged, but route shared behavior through extracted helpers. Preserve logic equivalent to:

```ts
const users = params.users || listTrackedUsers();
const trackedAddressIndex = buildTrackedAddressIndex(users);
const matched = pickMonitoredUser({
  eventWalletAliasLabel: event.walletAliasLabel || event.walletLabel,
  trackedWalletAddress: event.trackedWalletAddress,
  chain,
  users,
  trackedAddressIndex,
});
```

and:

```ts
if (params.state.reconciliationStatus === 'reconciled' && params.state.canonicalActivity) {
  const repairedCanonicalActivity = await repairCollapsedCanonicalActivity({ ... });
  persistHealedTelegramMonitorActivity({ ... });
  return { user, activity: repairedCanonicalActivity };
}
```

- [ ] **Step 5: Refactor `readTelegramMonitorFeed()` dedupe and fallback persistence flow**

Split the orchestration so the high-level function reads like:

```ts
const stateFeed = await projectRecentTelegramMonitorTxStates(limit, users);
const fallbackProjection = await projectFallbackTelegramMonitorEvents(limit, users);
await persistMissingProjectedFallbackActivities(fallbackProjection.persistCandidates);
return dedupeTelegramMonitorFeed(
  [...stateFeed, ...fallbackProjection.rows],
  limit
);
```

The implementation must preserve:
- scoring fallback rows before persistence
- `updateTelegramMonitorEventProjectedActivityIfMissing()` usage
- current dedupe precedence

- [ ] **Step 6: Run the focused Telegram verification**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-feed-telegram-conservative-refactor
npm run test:telegram-monitor-reconciliation
npm run test:parser-fixtures
```

Expected: both commands pass

- [ ] **Step 7: Commit the Telegram projection refactor**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-feed-telegram-conservative-refactor
git add lib/server/telegramMonitorFeedHelpers.ts lib/server/telegramMonitorFeed.ts scripts/test-telegram-monitor-reconciliation.ts scripts/test-parser-fixtures.ts
git commit -m "refactor: clarify telegram monitor feed projection"
```

Expected: one focused commit containing only the Telegram projection refactor

### Task 4: Final Integration Verification

**Files:**
- Modify: `docs/superpowers/plans/2026-05-04-feed-telegram-conservative-refactor.md`
- Test: `package.json`

- [ ] **Step 1: Run the final verification subset after both refactors**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-feed-telegram-conservative-refactor
npm run test:activities-api
npm run test:feed-client-state
npm run test:feed-page-state
npm run test:telegram-monitor-reconciliation
npm run test:parser-fixtures
npm run build
```

Expected: all commands pass

- [ ] **Step 2: Run targeted follow-up tests if the diff touched related behavior**

Conditional commands:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-feed-telegram-conservative-refactor
npm run test:search-filters
npm run test:events-feed-total
```

Expected: run them if the refactor touched feed search/filtering or events total/readback behavior

- [ ] **Step 3: Review the final diff for scope drift**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-feed-telegram-conservative-refactor
git diff --stat origin/$(git rev-parse --abbrev-ref HEAD | sed 's#^codex/##' >/dev/null 2>&1 || true)
git status --short
```

Expected: only feed/telegram conservative refactor files are changed

- [ ] **Step 4: Prepare handoff summary**

Capture:

```ts
const summary = {
  clientPipeline: [
    'request/normalize/user-sync/feed-apply steps now explicit',
    'feed payload users preserved end-to-end',
  ],
  telegramProjection: [
    'projection/fallback persistence/dedupe split into named helpers',
    'read behavior unchanged, tests preserved',
  ],
  verification: [
    'focused tests pass',
    'build passes',
  ],
};
```

- [ ] **Step 5: Do not merge yet; hand off for final branch-finishing flow**

Run:

```bash
cd /Users/xp/vibecoding/pilipili/.worktrees/codex-feed-telegram-conservative-refactor
git log --oneline --decorate -n 5
```

Expected: the branch is ready for the later finishing/PR step, but no merge is performed in this task

