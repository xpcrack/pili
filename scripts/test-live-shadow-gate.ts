/**
 * Unit tests for live-monitor shadow gate (no real DB dependency beyond in-memory).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';

const dataDir = mkdtempSync(path.join(tmpdir(), 'pili-shadow-gate-'));
process.env.PILIPILI_DATA_DIR = dataDir;
process.env.PILI_DISABLE_TELEGRAM_MONITOR_AUTO_RECONCILE = '1';

async function main() {
  const { getDb, withTransaction } = await import('../lib/server/sqlite');
  const { liveMonitorOwnsWalletTx, upsertEventsFromFeedRows } = await import('../lib/server/eventsRepo');
  const typeUser = {
    id: 'user-1',
    name: 'Alice',
    handle: 'alice',
    avatar: '',
    twitter: undefined,
    telegram: undefined,
    addresses: [],
    totalAssetUsd: 0,
    historicalMaxAssetUsd: 0,
    assetUpdatedAt: null,
    tags: [],
  };

  // bootstrap schema
  getDb();

  withTransaction(() => {
    const db = getDb();
    const now = Date.now();
    db.prepare(
      `INSERT INTO events (
         event_id, source, kind, timestamp, user_id, user_name,
         chain, address, content, url, action, token, tweet_id, tx_hash,
         ingest_source, dedup_key, metadata_json, payload_json,
         user_json, activity_json, indexed_at, created_at, updated_at
       ) VALUES (
         ?, 'blockchain', 'transfer', ?, ?, ?,
         ?, ?, ?, NULL, ?, ?, NULL, ?,
         ?, ?, ?, ?,
         ?, ?, ?, ?, ?
       )`
    ).run(
      'live-monitor:solana:wallet1:txhash1:tokenmeme',
      now,
      'user-1',
      'Alice',
      'solana',
      'wallet1',
      'sell meme',
      'sell',
      'MEME',
      'TxHash1',
      'live-monitor-alchemy-gmgn',
      'live-monitor:solana:wallet1:txhash1:tokenmeme',
      JSON.stringify({ tokenAddress: 'TokenMeme', txAction: 'sell', chain: 'solana', trackedAddress: 'wallet1', txHash: 'TxHash1' }),
      '{}',
      JSON.stringify(typeUser),
      JSON.stringify({
        id: 'live-monitor:solana:wallet1:txhash1:tokenmeme',
        userId: 'user-1',
        source: 'blockchain',
        type: 'transfer',
        content: 'sell meme',
        title: 't',
        timestamp: now,
        metadata: {
          chain: 'solana',
          trackedAddress: 'wallet1',
          txHash: 'TxHash1',
          tokenAddress: 'TokenMeme',
          txAction: 'sell',
        },
      }),
      now,
      now,
      now
    );
  });

  assert.equal(
    liveMonitorOwnsWalletTx({
      userId: 'user-1',
      chain: 'solana',
      trackedAddress: 'wallet1',
      txHash: 'TxHash1',
    }),
    true
  );
  assert.equal(
    liveMonitorOwnsWalletTx({
      userId: 'user-1',
      chain: 'solana',
      trackedAddress: 'wallet1',
      txHash: 'other',
    }),
    false
  );

  // conflict shadow must be skipped
  upsertEventsFromFeedRows(
    [
      {
        user: typeUser as any,
        activity: {
          id: 'xxyy-monitor:solana:wallet1:txhash1:weth',
          userId: 'user-1',
          source: 'blockchain',
          type: 'transfer',
          content: 'buy weth',
          title: 't',
          timestamp: Date.now(),
          metadata: {
            chain: 'solana',
            trackedAddress: 'wallet1',
            txHash: 'TxHash1',
            tokenAddress: 'WethMint',
            token: 'WETH',
            txAction: 'buy',
            txActionVariant: 'open',
            importance: { version: 2, score: 0, formulaVersion: 'test' } as any,
          },
        },
      },
    ],
    'telegram-monitor-reconcile'
  );

  const shadow = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM events WHERE event_id LIKE 'xxyy-monitor:%'`)
    .get() as { n: number };
  assert.equal(shadow.n, 0, 'shadow must not be inserted when live owns wallet+tx');

  // non-owned tx still inserts
  const beforeCount = (
    getDb().prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number }
  ).n;
  upsertEventsFromFeedRows(
    [
      {
        user: typeUser as any,
        activity: {
          id: 'xxyy-monitor:solana:wallet1:txhash2:tokenmeme',
          userId: 'user-1',
          source: 'blockchain',
          type: 'transfer',
          content: 'buy meme',
          title: 't',
          timestamp: Date.now(),
          metadata: {
            chain: 'solana',
            trackedAddress: 'wallet1',
            txHash: 'TxHash2',
            tokenAddress: 'TokenMeme',
            token: 'MEME',
            txAction: 'buy',
            txActionVariant: 'open',
            monitorTxAggregateKey: 'xxyy-monitor:solana:wallet1:txhash2:tokenmeme',
            importance: { version: 2, score: 0, formulaVersion: 'test' } as any,
          },
        },
      },
    ],
    'telegram-monitor-reconcile'
  );

  const afterCount = (
    getDb().prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number }
  ).n;
  assert.equal(afterCount, beforeCount + 1, 'telegram row for non-owned tx should insert');
  const allowed = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM events
       WHERE LOWER(COALESCE(tx_hash,'')) = 'txhash2'
         AND ingest_source LIKE 'telegram-monitor%'`
    )
    .get() as { n: number };
  assert.equal(allowed.n, 1, 'telegram row for non-owned tx should insert');

  console.log('shadow-gate tests: ok');
  rmSync(dataDir, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error);
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
  process.exitCode = 1;
});
