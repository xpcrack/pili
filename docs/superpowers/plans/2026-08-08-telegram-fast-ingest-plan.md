# Telegram Fast Ingest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make XXYY monitor messages produce a provisional pili Feed row without blocking the Telegram bridge on external historical-price lookups.

**Architecture:** Keep raw monitor persistence, tracked-user matching, and the live-monitor doorbell in the ingest path. Add an explicit fast projection option that builds the provisional Activity synchronously from XXYY fields; retain the existing asynchronous full projection for normal feed reads and canonical repair.

**Tech Stack:** TypeScript, Node 24.11.1, SQLite via better-sqlite3/Bun SQLite, existing npm test scripts.

---

### Task 1: Add the failing fast-ingest regression test

**Files:**
- Create: `scripts/test-telegram-fast-ingest.ts`
- Modify: `package.json:34-35` only if the test needs a dedicated named script; otherwise run it directly with `npx tsx`.

- [ ] **Step 1: Write the failing test**

Create a temporary SQLite data directory, configure `PILI_XXYY_FEED=doorbell`, create one monitored user from the existing `xxyy-bot-to-bot-buy` fixture, replace `globalThis.fetch` with a function that throws, ingest the fixture update, and assert:

```ts
assert.equal(result.projected, true);
assert.equal(result.feedMode, 'doorbell');
assert.equal(provisional.length, 1);
```

The test must restore `globalThis.fetch` and remove its temporary directory in `finally`.

- [ ] **Step 2: Run the test and verify RED**

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

- [ ] **Step 1: Add the option with the existing full path as the default**

Use a small options object, not a global flag. The default must preserve current callers:

```ts
type TelegramMonitorProjectionOptions = {
  resolveTradeAmountUsdAtTx?: boolean;
};
```

When the option is `false`, call `buildActivityFromSnapshotSync(params)`; otherwise call the current async `buildActivityFromSnapshot(params)`.

- [ ] **Step 2: Pass fast mode only from bridge ingest**

Pass `{ resolveTradeAmountUsdAtTx: false }` from the synchronous provisional projection in `ingestTelegramMonitorUpdate`. Leave `readTelegramMonitorFeed` and reconciliation callers unchanged so they retain full enrichment behavior.

- [ ] **Step 3: Run the regression test and verify GREEN**

Run:

```bash
npx tsx scripts/test-telegram-fast-ingest.ts
```

Expected result: PASS, with a provisional event persisted even though every network fetch throws.

### Task 3: Verify existing Telegram behavior

**Files:**
- No production files; only adjust the new test if its fixture setup exposes an existing test isolation issue.

- [ ] **Step 1: Run focused tests**

```bash
npx tsx scripts/test-telegram-doorbell-projection.ts
npx tsx scripts/test-telegram-monitor-reconciliation.ts
npx tsx scripts/test-telegram-fast-ingest.ts
```

Expected result: all commands exit 0. The doorbell test must still show one provisional event, and reconciliation tests must still cover aggregation, deduplication, and canonical replacement.

- [ ] **Step 2: Run the repository check**

```bash
npm run check
```

Expected result: TypeScript, targeted test filters, Bun compatibility tests, and the production build all exit 0.

### Task 4: Final verification and handoff

**Files:**
- No additional files.

- [ ] **Step 1: Inspect the diff**

```bash
git diff --check
git status --short
git diff --stat
```

Confirm that only the fast projection implementation, its regression test, and the design/plan docs changed.

- [ ] **Step 2: Verify runtime state without restarting workers**

```bash
npm run runtime:status
```

Report the fresh test/build evidence and state explicitly whether runtime refresh was performed.
