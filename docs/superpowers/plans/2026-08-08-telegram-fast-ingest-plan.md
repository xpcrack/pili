# Telegram Fast Ingest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make XXYY monitor messages produce a provisional pili Feed row without blocking the Telegram bridge on external historical-price lookups or per-message SQLite history scans, while retaining the complete XXYY amount in USD/native display.

**Architecture:** Keep raw monitor persistence, tracked-user matching, and the live-monitor doorbell in the ingest path. Add an explicit fast projection option that builds the provisional Activity synchronously from XXYY fields; use a minimal provisional `events` writer in doorbell mode; retain the existing asynchronous full projection and normal writer for feed reads and canonical repair.

**Tech Stack:** TypeScript, Node 24.11.1, SQLite via better-sqlite3/Bun SQLite, existing npm test scripts.

---

### Task 1: Add the failing fast-ingest regression test

**Files:**
- Create: `scripts/test-telegram-fast-ingest.ts`
- Modify: `package.json:34-35` only if the test needs a dedicated named script; otherwise run it directly with `npx tsx`.

- [x] **Step 1: Write the failing test**

Create a temporary SQLite data directory, configure `PILI_XXYY_FEED=doorbell`, create one monitored user from the existing `xxyy-bot-to-bot-buy` fixture, replace `globalThis.fetch` with a function that throws, ingest the fixture update, and assert:

```ts
assert.equal(result.projected, true);
assert.equal(result.feedMode, 'doorbell');
assert.equal(provisional.length, 1);
```

The test must restore `globalThis.fetch` and remove its temporary directory in `finally`.

- [x] **Step 2: Run the test and verify RED**

Run:

```bash
npx tsx scripts/test-telegram-fast-ingest.ts
```

Expected result before implementation: FAIL because the current async Activity builder reaches the throwing fetch, the doorbell fail-soft branch returns `projected: false`, and no provisional `events` row is persisted.

### Task 2: Implement an explicit fast projection mode

**Files:**
- Modify: `lib/server/telegramMonitorFeed.ts:59-92` to accept `resolveTradeAmountUsdAtTx?: boolean`, defaulting to `true`; use `buildActivityFromSnapshotSync` when it is `false`.
- Modify: `lib/server/telegramMonitorFeed.ts:279-337` to pass the option through `projectTelegramMonitorTxState` and `projectTelegramMonitorEvent`.
- Modify: `lib/server/telegramMonitorIngest.ts:508-514` to call `projectTelegramMonitorTxState`/`projectTelegramMonitorEvent` with `resolveTradeAmountUsdAtTx: false` for the doorbell hot path.

- [x] **Step 1: Add the option with the existing full path as the default**

Use a small options object, not a global flag. The default must preserve current callers:

```ts
type TelegramMonitorProjectionOptions = {
  resolveTradeAmountUsdAtTx?: boolean;
};
```

When the option is `false`, call `buildActivityFromSnapshotSync(params)`; otherwise call the current async `buildActivityFromSnapshot(params)`.

- [x] **Step 2: Pass fast mode only from bridge ingest**

Pass `{ resolveTradeAmountUsdAtTx: false }` from the synchronous provisional projection in `ingestTelegramMonitorUpdate`. Leave `readTelegramMonitorFeed` and reconciliation callers unchanged so they retain full enrichment behavior.

- [x] **Step 3: Run the regression test and verify GREEN**

Run:

```bash
npx tsx scripts/test-telegram-fast-ingest.ts
```

Expected result: PASS, with a provisional event persisted even though every network fetch throws.

### Task 2A: Keep the fast path complete and lightweight

**Files:**
- Modify: `lib/tradeUsd.ts` and `lib/server/telegramMonitorActivity.ts` to calculate USD locally from stable quotes or XXYY token price × quantity.
- Modify: `lib/server/eventsRepo.ts` and `lib/server/telegramMonitorIngest.ts` to skip historical importance scans and complex canonical conflict work for provisional doorbell writes.
- Modify: `lib/tradeDisplay.ts` to fall back to the XXYY native quote when USD is not available.
- Create: `scripts/test-telegram-fast-event-upsert.ts` and `scripts/test-trade-display-amount-fallback.ts`.

- [x] Add failing tests for local USD derivation, lightweight provisional writing, and native display fallback.
- [x] Implement the minimum production changes and keep canonical/live-monitor writes on the existing full path.
- [x] Preserve non-blocking BID feed push behavior.

### Task 3: Verify existing Telegram behavior

**Files:**
- No production files; only adjust the new test if its fixture setup exposes an existing test isolation issue.

- [x] **Step 1: Run focused tests**

```bash
npx tsx scripts/test-telegram-doorbell-projection.ts
npx tsx scripts/test-telegram-monitor-reconciliation.ts
npx tsx scripts/test-telegram-fast-ingest.ts
```

The changed-path tests pass. The repository-wide Telegram filter still has three unrelated baseline failures (`liquidity_usd` schema fixture errors and an existing MTProto fixture error).

- [x] **Step 2: Run the repository check**

```bash
npm run check
```

The production build passes. The repository TypeScript/check baseline remains non-green for unrelated existing errors.

### Task 4: Final verification and handoff

**Files:**
- No additional files.

- [x] **Step 1: Inspect the diff**

```bash
git diff --check
git status --short
git diff --stat
```

Confirm that only the fast projection implementation, its regression test, and the design/plan docs changed.

- [ ] **Step 2: Verify runtime state after the user-requested bridge restart**

```bash
npm run runtime:status
```

Report the fresh test/build evidence and state explicitly whether runtime refresh was performed.
