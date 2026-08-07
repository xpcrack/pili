# Pili Provisional Feed and GMGN Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Make doorbell-mode xxyy trades visible in Pili immediately and keep GMGN as non-duplicating enrichment, while fixing unattainable recovery-bucket costs.

**Architecture:** Doorbell ingest reuses the existing Telegram projection and logical rekey path before ringing GMGN. A later live-monitor event rekeys and merges the same wallet, transaction, and token event. A pure rate-limit helper ensures recovery bucket capacity can eventually satisfy weighted costs.

**Tech Stack:** Node 24.11.1, TypeScript, better-sqlite3, tsx test scripts, Bun and Vite production build.

---

## File Structure

- Create scripts/test-telegram-doorbell-projection.ts for immediate projection and later live reconciliation.
- Modify lib/server/telegramMonitorIngest.ts to reuse provisional projection in doorbell mode.
- Modify lib/server/liveMonitorConfig.ts to document the new doorbell contract.
- Create scripts/test-gmgn-recovery-bucket.ts for the recovery-capacity regression.
- Modify lib/server/gmgnRateLimit.ts to expose and use attainable cost/capacity helpers.

### Task 1: Prove doorbell mode currently omits Feed

**Files:**
- Create: scripts/test-telegram-doorbell-projection.ts

- [ ] **Step 1: Write the failing end-to-end test**

Set these before importing server modules:

    process.env.PILI_XXYY_FEED = "doorbell";
    process.env.PILI_DISABLE_TELEGRAM_MONITOR_AUTO_RECONCILE = "1";

Use a temporary PILIPILI_DATA_DIR. Create a tracked BSC user for wallet 0x1111111111111111111111111111111111111111. Import xxyy-bot-to-bot-buy from scripts/fixtures/parser-fixtures.ts and call ingestTelegramMonitorUpdate with its text, Telegram message timestamp, xxyy link, and BscScan transaction link.

Assert immediately:

    assert.equal(result.feedMode, "doorbell");
    assert.equal(result.projected, true);
    assert.equal(countPendingLiveDoorbells(), 1);
    assert.equal(
      (getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE LOWER(tx_hash)=LOWER(?)")
        .get(txHash) as { n: number }).n,
      1,
    );

Then call upsertLiveMonitorTrades with the same user, wallet, chain, transaction hash, token address, side, and timestamp:

    upsertLiveMonitorTrades({
      user,
      trades: [{
        chain: "bsc",
        wallet,
        txHash,
        tokenAddress,
        tokenSymbol: "共建",
        side: "buy",
        isOpenOrClose: true,
        eventTimeMs,
        costUsd: 84.324708,
        tokenAmount: 23423.53,
        priceUsd: 0.0036,
        marketCapUsd: 3_600_000,
      }],
    });

Assert the transaction still has exactly one event and its final event_id starts with live-monitor:.

- [ ] **Step 2: Run the test and verify RED**

Run:

    npm test -- --filter=telegram-doorbell-projection --verbose

Expected: FAIL because doorbell mode returns projected false and writes no event.

### Task 2: Reuse provisional projection in doorbell mode

**Files:**
- Modify: lib/server/telegramMonitorIngest.ts
- Modify: lib/server/liveMonitorConfig.ts

- [ ] **Step 1: Extract the existing project branch into one helper**

Create this private interface:

    async function projectSavedXxyyEvent(params: {
      parsed: ReturnType<typeof parseXxyyTelegramText>;
      trackedMatch: NonNullable<ReturnType<typeof findTrackedUserMatch>>;
      sourceChatId: string;
      sourceMessageId: string;
      eventTimeMs: number;
      text: string;
      messageLinks: string[];
      enrichTweets: boolean;
      triggerLegacyReconciliation: boolean;
    }): Promise<boolean>

Move the existing provisional summary, tx-state upsert, projectTelegramMonitorTxState or projectTelegramMonitorEvent call, scoring, canonical activity persistence, and upsertEventsFromFeedRows with ingest source telegram-monitor-ingest into this helper.

Keep upsertEventTweetRefAndFetchMissing behind enrichTweets. Keep triggerTelegramMonitorReconciliation behind triggerLegacyReconciliation.

- [ ] **Step 2: Ring first, then project safely before returning from doorbell mode**

    const doorbell = enqueueLiveDoorbell({
      address: ringAddress,
      userId: trackedMatch.user.id,
      chain: parsed.chain,
      source: "xxyy",
    });

    let projected = false;
    try {
      projected = await projectSavedXxyyEvent({
        parsed,
        trackedMatch,
        sourceChatId,
        sourceMessageId,
        eventTimeMs,
        text,
        messageLinks,
        enrichTweets: false,
        triggerLegacyReconciliation: false,
      });
    } catch (error) {
      console.error("[telegram-monitor] provisional projection failed", error);
    }

Return projected rather than false. Because raw persistence and doorbell enqueue happen first, a false result or thrown projection error cannot lose the GMGN fallback signal.

- [ ] **Step 3: Preserve legacy project mode**

Replace the old inline project block with the same helper using enrichTweets true and triggerLegacyReconciliation true.

- [ ] **Step 4: Update mode documentation**

Change the doorbell description in liveMonitorConfig.ts to: write provisional xxyy Feed, ring live-monitor, then let GMGN enrich and reconcile.

- [ ] **Step 5: Run focused tests and verify GREEN**

    npm test -- --filter=telegram-doorbell-projection --verbose
    npm test -- --filter=live-shadow-gate --verbose
    npm test -- --filter=parser-fixtures --verbose

Expected: all focused tests pass. The new test proves one immediate event and one final reconciled event.

- [ ] **Step 6: Commit provisional projection**

    git add scripts/test-telegram-doorbell-projection.ts lib/server/telegramMonitorIngest.ts lib/server/liveMonitorConfig.ts
    git commit -m "fix: project xxyy doorbells into Feed immediately"

### Task 3: Make weighted recovery costs attainable

**Files:**
- Create: scripts/test-gmgn-recovery-bucket.ts
- Modify: lib/server/gmgnRateLimit.ts

- [ ] **Step 1: Write the failing pure test**

    import assert from "node:assert/strict";
    import {
      gmgnEffectiveCost,
      gmgnBucketCapacity,
    } from "../lib/server/gmgnRateLimit";

    const signedRecoveryCost = gmgnEffectiveCost(3, 0.3);
    assert.equal(signedRecoveryCost, 10);
    assert.ok(gmgnBucketCapacity({
      configuredBurst: 3,
      recoveryFactor: 0.3,
      effectiveCost: signedRecoveryCost,
    }) >= signedRecoveryCost);
    console.log("gmgn recovery bucket tests: ok");

- [ ] **Step 2: Run the test and verify RED**

Run:

    npm test -- --filter=gmgn-recovery-bucket --verbose

Expected: FAIL because the helper exports do not exist.

- [ ] **Step 3: Implement and use the pure helpers**

    export function gmgnEffectiveCost(cost: number, recoveryFactor: number) {
      return recoveryFactor < 1 ? cost / recoveryFactor : cost;
    }

    export function gmgnBucketCapacity(input: {
      configuredBurst: number;
      recoveryFactor: number;
      effectiveCost: number;
    }) {
      const recoveryBurst = input.recoveryFactor >= 1
        ? input.configuredBurst
        : Math.min(input.configuredBurst, 2);
      return Math.max(recoveryBurst, input.effectiveCost);
    }

Use both helpers in acquireGmgnGlobalToken. This keeps recovery slow because tokens must refill to the weighted cost, but removes the impossible effectiveCost greater than burst capacity state.

- [ ] **Step 4: Run focused reliability tests and verify GREEN**

    npm test -- --filter=gmgn-recovery-bucket --verbose
    npm test -- --filter=live-monitor-reliability --verbose
    npm test -- --filter=holdings-refresh-queue --verbose

Expected: all focused tests pass.

- [ ] **Step 5: Commit recovery fix**

    git add scripts/test-gmgn-recovery-bucket.ts lib/server/gmgnRateLimit.ts
    git commit -m "fix: make GMGN recovery pacing attainable"

### Task 4: Build and roll out Pili

- [ ] **Step 1: Verify the required runtime and production build**

    node --version
    npm run build

Expected: Node v24.11.1 and a successful Vite build.

- [ ] **Step 2: Refresh only the production web process if the HTTP ingest path requires replacement**

    npm run runtime:refresh

Expected: pili-web-prod gets a new PID; workers remain unchanged.

- [ ] **Step 3: Restart pili-background-worker only after explicit user authorization**

    pm2 restart pili-background-worker

Expected: only the affected worker gets a new PID.

- [ ] **Step 4: Verify a fresh xxyy event end to end**

Verify one raw telegram_monitor_events row, one immediate events row, one pending or claimed doorbell, and no duplicate after GMGN enrichment.

- [ ] **Step 5: Observe GMGN metrics**

Verify live activity stays prioritized, weighted recovery eventually acquires, and GMGN_COOLDOWN messages do not re-arm cooldown.
