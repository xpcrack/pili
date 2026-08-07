# Newone Co-Ride Holdings Pacing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Eliminate GMGN wallet_holdings bursts by routing every newone co-ride refresh through one paced, deduplicated scheduler.

**Architecture:** A pure in-memory scheduler owns pending wallets, one active claim, per-wallet dedupe timestamps, and a post-completion dispatch gap. Feed-triggered and periodic paths both enqueue work into it; a read-only Pili SQLite probe defers dispatch while live doorbells exist.

**Tech Stack:** Bun, TypeScript, bun:test, Bun SQLite, existing @newone/adapters holdings runner.

---

## File Structure

- Create /Users/xp/vibecoding/newone/packages/adapters/src/co-ride-holdings-scheduler.ts for the pure state machine.
- Create /Users/xp/vibecoding/newone/packages/adapters/src/co-ride-holdings-scheduler.test.ts for fake-time tests.
- Modify /Users/xp/vibecoding/newone/packages/adapters/src/pili-feed-runner.ts and its test to count live doorbells.
- Modify /Users/xp/vibecoding/newone/apps/worker/src/index.ts so every co-ride path uses the scheduler.
- Modify /Users/xp/vibecoding/newone/packages/core/src/config.ts and config/default.yaml for pacing settings.

### Task 1: Build the scheduler with TDD

**Files:**
- Create: /Users/xp/vibecoding/newone/packages/adapters/src/co-ride-holdings-scheduler.test.ts
- Create: /Users/xp/vibecoding/newone/packages/adapters/src/co-ride-holdings-scheduler.ts

- [ ] **Step 1: Write the failing scheduler tests**

    import { describe, expect, test } from "bun:test";
    import { CoRideHoldingsScheduler } from "./co-ride-holdings-scheduler";

    describe("CoRideHoldingsScheduler", () => {
      test("claims one wallet and waits 25 seconds after completion", () => {
        const q = new CoRideHoldingsScheduler({ dispatchGapMs: 25_000, dedupeMs: 600_000 });
        expect(q.enqueue(["WalletA", "WalletB"], 1_000)).toBe(2);
        expect(q.claim({ nowMs: 1_000, cooldownRemainingMs: 0, pendingDoorbells: 0 }))
          .toEqual({ status: "claimed", wallet: "walleta" });
        expect(q.claim({ nowMs: 1_001, cooldownRemainingMs: 0, pendingDoorbells: 0 }).status)
          .toBe("active");
        q.complete("walleta", 2_000);
        expect(q.claim({ nowMs: 26_999, cooldownRemainingMs: 0, pendingDoorbells: 0 }).status)
          .toBe("paced");
        expect(q.claim({ nowMs: 27_000, cooldownRemainingMs: 0, pendingDoorbells: 0 }))
          .toEqual({ status: "claimed", wallet: "walletb" });
      });

      test("deduplicates active, pending, and recently completed wallets", () => {
        const q = new CoRideHoldingsScheduler({ dispatchGapMs: 25_000, dedupeMs: 600_000 });
        expect(q.enqueue(["WalletA", "walleta"], 1_000)).toBe(1);
        q.claim({ nowMs: 1_000, cooldownRemainingMs: 0, pendingDoorbells: 0 });
        expect(q.enqueue(["WALLETA"], 2_000)).toBe(0);
        q.complete("walleta", 3_000);
        expect(q.enqueue(["walleta"], 602_999)).toBe(0);
        expect(q.enqueue(["walleta"], 603_000)).toBe(1);
      });

      test("retains work during cooldown and doorbell backlog", () => {
        const q = new CoRideHoldingsScheduler({ dispatchGapMs: 25_000, dedupeMs: 600_000 });
        q.enqueue(["walleta"], 1_000);
        expect(q.claim({ nowMs: 2_000, cooldownRemainingMs: 60_000, pendingDoorbells: 0 }).status)
          .toBe("cooldown");
        expect(q.claim({ nowMs: 62_000, cooldownRemainingMs: 0, pendingDoorbells: 1 }).status)
          .toBe("doorbells");
        expect(q.claim({ nowMs: 63_000, cooldownRemainingMs: 0, pendingDoorbells: 0 }).status)
          .toBe("claimed");
      });

      test("requeues a failed wallet without immediate retry", () => {
        const q = new CoRideHoldingsScheduler({ dispatchGapMs: 25_000, dedupeMs: 600_000 });
        q.enqueue(["walleta"], 1_000);
        q.claim({ nowMs: 1_000, cooldownRemainingMs: 0, pendingDoorbells: 0 });
        q.fail("walleta", 2_000);
        expect(q.size).toBe(1);
        expect(q.claim({ nowMs: 26_999, cooldownRemainingMs: 0, pendingDoorbells: 0 }).status)
          .toBe("paced");
        expect(q.claim({ nowMs: 27_000, cooldownRemainingMs: 0, pendingDoorbells: 0 }).status)
          .toBe("claimed");
      });
    });

- [ ] **Step 2: Run the test and verify RED**

Run:

    cd /Users/xp/vibecoding/newone
    bun test packages/adapters/src/co-ride-holdings-scheduler.test.ts

Expected: FAIL because the scheduler module does not exist.

- [ ] **Step 3: Implement the minimal scheduler**

    export type CoRideClaimResult =
      | { status: "claimed"; wallet: string }
      | { status: "empty" | "active" | "cooldown" | "doorbells" | "paced" };

    export class CoRideHoldingsScheduler {
      private pending = new Map<string, number>();
      private lastCompleted = new Map<string, number>();
      private activeWallet: string | null = null;
      private nextAllowedAtMs = 0;

      constructor(private readonly opts: { dispatchGapMs: number; dedupeMs: number }) {}

      get size() { return this.pending.size; }

      enqueue(wallets: string[], nowMs = Date.now()) {
        let added = 0;
        for (const raw of wallets) {
          const wallet = String(raw || "").trim().toLowerCase();
          if (wallet.length < 8 || wallet === this.activeWallet || this.pending.has(wallet)) continue;
          const last = this.lastCompleted.get(wallet) ?? 0;
          if (last > 0 && nowMs - last < this.opts.dedupeMs) continue;
          this.pending.set(wallet, nowMs);
          added += 1;
        }
        return added;
      }

      claim(input: { nowMs?: number; cooldownRemainingMs: number; pendingDoorbells: number }): CoRideClaimResult {
        const nowMs = input.nowMs ?? Date.now();
        if (this.activeWallet) return { status: "active" };
        if (this.pending.size === 0) return { status: "empty" };
        if (input.cooldownRemainingMs > 0) return { status: "cooldown" };
        if (input.pendingDoorbells > 0) return { status: "doorbells" };
        if (nowMs < this.nextAllowedAtMs) return { status: "paced" };
        const wallet = this.pending.keys().next().value as string;
        this.pending.delete(wallet);
        this.activeWallet = wallet;
        return { status: "claimed", wallet };
      }

      complete(wallet: string, nowMs = Date.now()) {
        const normalized = wallet.trim().toLowerCase();
        if (this.activeWallet === normalized) this.activeWallet = null;
        this.lastCompleted.set(normalized, nowMs);
        this.nextAllowedAtMs = Math.max(this.nextAllowedAtMs, nowMs + this.opts.dispatchGapMs);
      }

      fail(wallet: string, nowMs = Date.now()) {
        const normalized = wallet.trim().toLowerCase();
        if (this.activeWallet === normalized) this.activeWallet = null;
        this.pending.set(normalized, nowMs);
        this.nextAllowedAtMs = Math.max(this.nextAllowedAtMs, nowMs + this.opts.dispatchGapMs);
      }
    }

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the Task 1 test command again. Expected: 4 tests pass.

- [ ] **Step 5: Commit only the scheduler files**

    cd /Users/xp/vibecoding/newone
    git add packages/adapters/src/co-ride-holdings-scheduler.ts packages/adapters/src/co-ride-holdings-scheduler.test.ts
    git commit -m "fix: pace co-ride holdings refreshes"

### Task 2: Add a Pili live-doorbell probe

**Files:**
- Modify: /Users/xp/vibecoding/newone/packages/adapters/src/pili-feed-runner.ts
- Modify: /Users/xp/vibecoding/newone/packages/adapters/src/pili-feed-runner.test.ts
- Modify: /Users/xp/vibecoding/newone/packages/adapters/src/index.ts

- [ ] **Step 1: Add a failing temporary-database test**

    test("countPiliPendingLiveDoorbells counts every queued row", () => {
      const pili = new Database(piliPath);
      pili.run("CREATE TABLE live_doorbell_queue (wallet_lower TEXT PRIMARY KEY)");
      pili.run("INSERT INTO live_doorbell_queue(wallet_lower) VALUES ('a'), ('b')");
      pili.close();
      expect(countPiliPendingLiveDoorbells(piliPath)).toBe(2);
    });

- [ ] **Step 2: Run the test and verify RED**

Run:

    cd /Users/xp/vibecoding/newone
    bun test packages/adapters/src/pili-feed-runner.test.ts

Expected: FAIL because countPiliPendingLiveDoorbells is not exported.

- [ ] **Step 3: Implement a fail-open read-only probe**

    export function countPiliPendingLiveDoorbells(sqlitePath: string): number {
      let pili;
      try {
        pili = openPiliReadonly(sqlitePath);
        const row = pili.query("SELECT COUNT(1) AS n FROM live_doorbell_queue").get() as { n?: number } | null;
        return Math.max(0, Number(row?.n || 0));
      } catch {
        return 0;
      } finally {
        try { pili?.close(); } catch {}
      }
    }

Ensure packages/adapters/src/index.ts exports pili-feed-runner and the scheduler.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the Task 2 test command again. Expected: all pili-feed-runner tests pass.

- [ ] **Step 5: Commit the probe files**

    cd /Users/xp/vibecoding/newone
    git add packages/adapters/src/pili-feed-runner.ts packages/adapters/src/pili-feed-runner.test.ts packages/adapters/src/index.ts
    git commit -m "fix: defer holdings for Pili doorbells"

### Task 3: Route all co-ride refreshes through one scheduler

**Files:**
- Modify: /Users/xp/vibecoding/newone/apps/worker/src/index.ts
- Modify: /Users/xp/vibecoding/newone/packages/core/src/config.ts
- Modify: /Users/xp/vibecoding/newone/config/default.yaml

- [ ] **Step 1: Add typed configuration**

Add these optional WorkerConfig fields and defaults:

    co_ride_holdings_dispatch_gap_ms: 25000
    co_ride_holdings_dedupe_ms: 600000
    co_ride_holdings_concurrency: 1
    co_ride_feed_holdings_wallets: 1

- [ ] **Step 2: Instantiate one scheduler**

    const coRideHoldingsScheduler = new CoRideHoldingsScheduler({
      dispatchGapMs: Math.max(Number((cfg as any).worker?.co_ride_holdings_dispatch_gap_ms ?? 25_000), 25_000),
      dedupeMs: Math.max(Number((cfg as any).worker?.co_ride_holdings_dedupe_ms ?? 600_000), 60_000),
    });

Replace coRideFeedPending, coRideFeedDueAt, and coRideFeedLastRun mutations with scheduler.enqueue(wallets, Date.now()).

- [ ] **Step 3: Replace batch flush with one scheduler claim**

    const sqlitePath = String(cfg.adapters?.pili?.sqlite_path || "").trim();
    const claim = coRideHoldingsScheduler.claim({
      nowMs: Date.now(),
      cooldownRemainingMs: getGmgnCooldownState().remainingMs,
      pendingDoorbells: sqlitePath ? countPiliPendingLiveDoorbells(sqlitePath) : 0,
    });
    if (claim.status !== "claimed") return;

    try {
      const summary = await runCoRideHoldingsSync(db, {
        wallets: [claim.wallet],
        max_wallets: 1,
        pause_ms: 0,
        concurrency: 1,
      });
      if (summary.errors.length > 0) coRideHoldingsScheduler.fail(claim.wallet, Date.now());
      else coRideHoldingsScheduler.complete(claim.wallet, Date.now());
    } catch (error) {
      coRideHoldingsScheduler.fail(claim.wallet, Date.now());
      throw error;
    }

Call this flush attempt once per normal worker tick. The scheduler enforces pacing.

Log claimed wallet, pending count, completion time, and failure requeue. Log cooldown, doorbell, and paced deferrals only when the reason changes so a production observation can distinguish safe deferral from a stuck queue without flooding PM2 logs.

- [ ] **Step 4: Remove the independent periodic batch path**

At co_ride_holdings_sync_ms, call listCandidateWallets(db, 1, { stale_positive_ms }), enqueue its single address, and let the same flush path execute it. Delete syncCoRideHoldings and syncCoRideHoldingsUncoordinated so no runner bypasses the scheduler.

- [ ] **Step 5: Run focused checks**

    cd /Users/xp/vibecoding/newone
    bun test packages/adapters/src/co-ride-holdings-scheduler.test.ts packages/adapters/src/pili-feed-runner.test.ts packages/adapters/src/co-ride-holdings-runner.test.ts
    bun run typecheck

Expected: focused tests pass and typecheck exits 0.

- [ ] **Step 6: Commit worker integration**

    cd /Users/xp/vibecoding/newone
    git add apps/worker/src/index.ts packages/core/src/config.ts config/default.yaml
    git commit -m "fix: serialize newone co-ride holdings"

### Task 4: Roll out and observe

- [ ] **Step 1:** Record the current cooldown and last 30 minutes of GMGN request metrics.
- [ ] **Step 2:** After explicit user authorization, run pm2 restart newone-worker and verify only that worker gets a new PID.
- [ ] **Step 3:** Observe at least three minutes; completed co-ride runs must contain one wallet and be at least 25 seconds apart.
- [ ] **Step 4:** Verify no new local wallet_holdings ban in the observation window. Never clear cooldown manually.
