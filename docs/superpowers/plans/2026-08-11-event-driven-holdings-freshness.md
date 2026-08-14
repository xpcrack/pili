# Event-Driven Holdings Freshness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a tracked wallet's holdings refresh immediately from a live Feed doorbell and keep event-driven snapshots fresh even while the slow full holdings sweep is running.

**Architecture:** A claimed live-monitor target enqueues the affected wallet×chain before GMGN activity enrichment, so OKX-backed holdings do not wait for Feed reconciliation. The event queue uses a short debounce, skips optional DexScreener work, and only delays Robinhood/GMGN holdings while live doorbells remain active. Full scans remain a fallback and merge by wallet freshness so an older scan cannot overwrite a newer event-driven snapshot.

**Tech Stack:** Node 24.11.1, TypeScript, SQLite/better-sqlite3, tsx test scripts, Bun/Vite production build, PM2 runtime scripts.

---

### Task 1: Add failing regression tests for event-first refresh

**Files:**
- Modify: `scripts/test-live-monitor-holdings-enqueue.ts`
- Modify: `scripts/test-holdings-refresh-queue.ts`

- [ ] **Step 1: Assert the live monitor enqueues before GMGN activity finishes**

Record `order: string[]` in the existing live-monitor fixture. Push `"enqueue"` from `enqueueHoldingsRefresh` and `"activity"` at the beginning of `fetchActivity`. Assert `order[0] === "enqueue"` and keep the existing wallet×chain assertions.

- [ ] **Step 2: Assert an EVM holdings job runs while a doorbell is pending**

Change the existing queue test's pending-doorbell case to expect the Base refresh call to run, with `pendingCount() === 0`. Add a captured `fetchTokenLiquidity` assertion that event-driven jobs pass `false`.

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```bash
npm test -- --filter=live-monitor-holdings-enqueue --verbose
npm test -- --filter=holdings-refresh-queue --verbose
```

Expected: the tests fail because enqueue currently happens only after a nonzero GMGN trade upsert and the queue currently defers every chain while any live doorbell exists.

---

### Task 2: Implement event-driven priority refresh

**Files:**
- Modify: `lib/server/liveMonitorRuntime.ts:394-485`
- Modify: `lib/server/holdingsRefreshQueue.ts:1-195`

- [ ] **Step 1: Enqueue each target's affected chains before activity scanning**

After `buildScanTargets` produces the target list and before `processTarget` starts, call the injected `enqueueHoldingsRefresh` once per unique `target.address × target.chains` with the target user id. Keep the later trade-based enqueue as a deduplicated fallback for Alchemy activity chains not represented by a doorbell.

- [ ] **Step 2: Shorten the default event debounce and skip optional liquidity enrichment**

Set the default trade-triggered debounce to 10 seconds. When invoking `refreshWallet`, pass `fetchTokenLiquidity: false` so a DexScreener outage cannot delay the balance write; the periodic full sweep remains responsible for enrichment.

- [ ] **Step 3: Stop blocking OKX-backed jobs on unrelated live doorbells**

Remove the blanket pending-doorbell early return. Retain the gate only for `robinhood` jobs, because that path shares GMGN with live activity enrichment; it will run after the live doorbell is acknowledged. EVM and Solana jobs must proceed immediately through OKX.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run:

```bash
npm test -- --filter=live-monitor-holdings-enqueue --verbose
npm test -- --filter=holdings-refresh-queue --verbose
npm test -- --filter=live-monitor-reliability --verbose
```

Expected: all focused tests pass, including the existing live-doorbell acknowledgement and timeout behavior.

---

### Task 3: Prevent an older full scan from overwriting a newer event snapshot

**Files:**
- Create: `scripts/test-holdings-snapshot-freshness.ts`
- Modify: `lib/server/holdingsRefreshRuntime.ts:520-570`

- [ ] **Step 1: Write a failing freshness regression**

In a temporary SQLite fixture with one Solana tracked wallet, write a newer wallet snapshot using `refreshWalletHoldings` and then run `refreshCurrentHoldings` with an earlier `now()` value and a different token response for that same wallet. Assert the newer token remains in `current_holdings` after the full scan completes.

- [ ] **Step 2: Run the regression and verify RED**

Run:

```bash
npx tsx scripts/test-holdings-snapshot-freshness.ts
```

Expected: FAIL because `replaceCurrentHoldings` currently deletes and rewrites the entire table with the older full-scan snapshot.

- [ ] **Step 3: Merge full-scan results by wallet freshness**

Replace the full-table delete with a transaction that processes each wallet×chain status independently. For each incoming status, compare its `refreshed_at` with the current maximum for that wallet×chain; skip the incoming rows when the database already has a newer snapshot, otherwise delete and insert only that wallet×chain's rows and status. Preserve the existing failed-wallet last-good rows and keep the partial `replaceWalletHoldings` behavior unchanged.

- [ ] **Step 4: Run the regression and verify GREEN**

Run:

```bash
npx tsx scripts/test-holdings-snapshot-freshness.ts
```

Expected: the isolated freshness test passes; the existing Bun holdings test remains a separate compatibility check.

---

### Task 4: Verify the repository and production web runtime

**Files:**
- Inspect only: all modified files and `git diff`

- [ ] **Step 1: Run targeted tests**

```bash
npm test -- --filter=live-monitor-holdings-enqueue --verbose
npm test -- --filter=holdings-refresh-queue --verbose
npm test -- --filter=live-monitor-reliability --verbose
npx tsx scripts/test-holdings-snapshot-freshness.ts
```

- [ ] **Step 2: Run typecheck and production build**

```bash
npx tsc --noEmit
npm run build
```

- [ ] **Step 3: Run the complete test suite**

```bash
npm test
```

- [ ] **Step 4: Inspect changes and refresh only the production web process**

```bash
git diff --check
git status --short
npm run runtime:status
npm run runtime:refresh
npm run runtime:status
```

The refresh command must succeed after the build; it must not restart `pili-background-worker` by default. Preserve the pre-existing untracked `scripts/remove-daqi-bad-addresses.ts` file.
