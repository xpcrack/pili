import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';

async function main() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pilipili-holdings-queue-'));
  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');
  process.env.HOLDINGS_REFRESH_INTERVAL_MS = '60000';

  try {
    const { getDb } = await import('@/lib/server/sqlite');
    const { enqueueHoldingsRefresh, runHoldingsRefreshQueueCycle } = await import(
      '@/lib/server/holdingsRefreshQueue'
    );
    const db = getDb();
    db.prepare(
      `INSERT INTO tracked_users (id, name, handle, avatar, total_asset_usd,
         historical_max_asset_usd, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, 0, ?, ?)`
    ).run('u1', 'Queue User', 'queue-user', '', 1, 1);
    db.prepare(
      `INSERT INTO tracked_addresses (
         id, user_id, address, address_lower, name, chain, created_at, updated_at, monitoring_enabled
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`
    ).run('a1', 'u1', 'WalletScheduled', 'walletscheduled', 'scheduled', 'base', 1, 1);

    const calls: string[] = [];
    const refreshWallet = async (params: { address: string; chain: string }) => {
      calls.push(`${params.chain}:${params.address.toLowerCase()}`);
      return {
        status: 'idle' as const,
        chain: 'base' as const,
        holdingsRowCount: 1,
        filteredOutHoldingCount: 0,
        totalAssetUsd: 10,
        lastError: null,
      };
    };

    enqueueHoldingsRefresh({ address: 'WalletEvent', chain: 'base', userId: 'u1' });
    db.prepare(`UPDATE holdings_refresh_jobs SET due_at_ms = 1000 WHERE wallet_chain = 'evm:walletevent'`).run();
    await runHoldingsRefreshQueueCycle({ db, now: () => 1000, refreshWallet });
    assert.equal(calls[0], 'evm:walletevent', 'event priority must beat scheduled stale work');

    await runHoldingsRefreshQueueCycle({ db, now: () => 1000, refreshWallet });
    assert.equal(calls[1], 'evm:walletscheduled', 'scheduled wallet must be processed incrementally');

    enqueueHoldingsRefresh({ address: 'WalletRestart', chain: 'base', userId: 'u1' });
    const persisted = db.prepare(
      `SELECT wallet_chain FROM holdings_refresh_jobs WHERE wallet_chain = 'evm:walletrestart'`
    ).get() as { wallet_chain: string } | undefined;
    assert.equal(persisted?.wallet_chain, 'evm:walletrestart', 'enqueue must survive process memory loss');

    let failCalls = 0;
    db.prepare(`UPDATE holdings_refresh_jobs SET due_at_ms = 2000 WHERE wallet_chain = 'evm:walletrestart'`).run();
    await runHoldingsRefreshQueueCycle({
      db,
      now: () => 2000,
      refreshWallet: async () => {
        failCalls += 1;
        return {
          status: 'error' as const,
          chain: 'base' as const,
          holdingsRowCount: 0,
          filteredOutHoldingCount: 0,
          totalAssetUsd: null,
          lastError: 'temporary failure',
        };
      },
    });
    const failed = db.prepare(
      `SELECT attempts, due_at_ms, lease_token FROM holdings_refresh_jobs
       WHERE wallet_chain = 'evm:walletrestart'`
    ).get() as { attempts: number; due_at_ms: number; lease_token: string | null };
    assert.equal(failCalls, 1);
    assert.equal(failed.attempts, 1);
    assert.equal(failed.due_at_ms, 62000);
    assert.equal(failed.lease_token, null, 'failed jobs must release their lease');

    enqueueHoldingsRefresh({ address: 'WalletTrailing', chain: 'base', userId: 'u1' });
    db.prepare(`UPDATE holdings_refresh_jobs SET due_at_ms = 70000 WHERE wallet_chain = 'evm:wallettrailing'`).run();
    let trailingEvent = false;
    await runHoldingsRefreshQueueCycle({
      db,
      now: (() => {
        let calls = 0;
        return () => (calls++ === 0 ? 70000 : 70001);
      })(),
      refreshWallet: async () => {
        if (!trailingEvent) {
          trailingEvent = true;
          enqueueHoldingsRefresh({ address: 'WalletTrailing', chain: 'base', userId: 'u1' });
        }
        return {
          status: 'idle' as const,
          chain: 'base' as const,
          holdingsRowCount: 1,
          filteredOutHoldingCount: 0,
          totalAssetUsd: 10,
          lastError: null,
        };
      },
    });
    const trailing = db.prepare(
      `SELECT priority, due_at_ms, lease_token FROM holdings_refresh_jobs
       WHERE wallet_chain = 'evm:wallettrailing'`
    ).get() as { priority: number; due_at_ms: number; lease_token: string | null };
    assert.equal(trailing.priority, 100, 'an event arriving in-flight must retain priority');
    assert.ok(trailing.due_at_ms < 70001 + 60000, 'an in-flight event must request a trailing run');
    assert.equal(trailing.lease_token, null);

    db.prepare(`UPDATE holdings_refresh_jobs SET due_at_ms = 90000 WHERE due_at_ms <= 80000`).run();
    enqueueHoldingsRefresh({ address: 'WalletNativeLane', chain: 'solana', userId: 'u1' });
    enqueueHoldingsRefresh({ address: 'WalletGmgnLane', chain: 'robinhood', userId: 'u1' });
    db.prepare(
      `UPDATE holdings_refresh_jobs SET due_at_ms = 80000
       WHERE wallet_chain IN ('solana:walletnativelane', 'robinhood:walletgmgnlane')`
    ).run();
    const laneCalls: string[] = [];
    const laneRefresh = async (params: { address: string; chain: string }) => {
      laneCalls.push(`${params.chain}:${params.address.toLowerCase()}`);
      return {
        status: 'idle' as const,
        chain: params.chain as 'solana' | 'robinhood',
        holdingsRowCount: 1,
        filteredOutHoldingCount: 0,
        totalAssetUsd: 10,
        lastError: null,
      };
    };
    await runHoldingsRefreshQueueCycle({
      db,
      now: () => 80000,
      provider: 'native',
      refreshWallet: laneRefresh,
    });
    assert.deepEqual(laneCalls, ['solana:walletnativelane'], 'native lane must not claim GMGN work');
    await runHoldingsRefreshQueueCycle({
      db,
      now: () => 80000,
      provider: 'gmgn',
      cooldownRemainingMs: () => 0,
      pendingLiveDoorbells: () => 0,
      refreshWallet: laneRefresh,
    });
    assert.deepEqual(
      laneCalls,
      ['solana:walletnativelane', 'robinhood:walletgmgnlane'],
      'GMGN lane must claim only Robinhood work'
    );

    // min-age guard: a wallet refreshed within HOLDINGS_MIN_REFRESH_AGE_MS must
    // not be re-claimed even when its job is due — caps event-driven refresh rate.
    process.env.HOLDINGS_MIN_REFRESH_AGE_MS = '120000';
    enqueueHoldingsRefresh({ address: 'WalletMinAge', chain: 'base', userId: 'u1' });
    db.prepare(`UPDATE holdings_refresh_jobs SET due_at_ms = 0 WHERE wallet_chain = 'evm:walletminage'`).run();
    let minAgeCalls = 0;
    const minAgeRefresh = async (params: { address: string; chain: string }) => {
      minAgeCalls += 1;
      return {
        status: 'idle' as const,
        chain: params.chain as 'base',
        holdingsRowCount: 1,
        filteredOutHoldingCount: 0,
        totalAssetUsd: 10,
        lastError: null,
      };
    };
    await runHoldingsRefreshQueueCycle({ db, now: () => 1000, refreshWallet: minAgeRefresh });
    assert.equal(minAgeCalls, 1, 'initial refresh must run once');
    db.prepare(`UPDATE holdings_refresh_jobs SET due_at_ms = 2000 WHERE wallet_chain = 'evm:walletminage'`).run();
    await runHoldingsRefreshQueueCycle({ db, now: () => 2000, refreshWallet: minAgeRefresh });
    assert.equal(minAgeCalls, 1, 'min-age guard must block a refresh within the window');
    db.prepare(`UPDATE holdings_refresh_jobs SET due_at_ms = 121000 WHERE wallet_chain = 'evm:walletminage'`).run();
    await runHoldingsRefreshQueueCycle({ db, now: () => 121000, refreshWallet: minAgeRefresh });
    assert.equal(minAgeCalls, 2, 'refresh must resume once min-age has elapsed');

    console.log('holdings persistent refresh queue tests: ok');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
