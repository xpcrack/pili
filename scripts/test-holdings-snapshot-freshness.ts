import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';

async function run() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pilipili-holdings-freshness-'));
  const previousDbPath = process.env.PILIPILI_DB_PATH;
  const previousDataDir = process.env.PILIPILI_DATA_DIR;
  const previousOkxApiKey = process.env.OKX_API_KEY;
  const previousOkxSecretKey = process.env.OKX_SECRET_KEY;
  const previousOkxPassphrase = process.env.OKX_API_PASSPHRASE;

  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');
  process.env.OKX_API_KEY = 'test-okx-api-key';
  process.env.OKX_SECRET_KEY = 'test-okx-secret-key';
  process.env.OKX_API_PASSPHRASE = 'test-okx-passphrase';

  try {
    const { createTrackedUser } = await import('@/lib/server/trackedUsersRepo');
    const { getDb } = await import('@/lib/server/sqlite');
    const { refreshCurrentHoldings, refreshWalletHoldings } = await import(
      '@/lib/server/holdingsRefreshRuntime'
    );

    const address = 'FyoBqc6Vf9SpiByTohLP87Ns2rQZoGu534yzQGjLv3Tt';
    createTrackedUser({
      name: 'Freshness Fixture',
      handle: 'freshness-fixture',
      avatar: '',
      tags: [],
      addresses: [
        {
          address,
          name: '#1',
          chain: 'solana',
          totalAssetUsd: 1,
          assetUpdatedAt: 1,
        },
      ],
      totalAssetUsd: 1,
      historicalMaxAssetUsd: 1,
      mainstreamAssetUsd: 0,
      assetUpdatedAt: 1,
      twitter: undefined,
      telegram: undefined,
    });

    const userId = (
      getDb().prepare(`SELECT id FROM tracked_users WHERE handle = ?`).get('freshness-fixture') as {
        id: string;
      }
    ).id;
    const emptyLiquidity = async () => new Map();
    const eventSnapshotAt = 1_717_000_001_000;

    await refreshWalletHoldings({
      address,
      chain: 'solana',
      userId,
      now: () => eventSnapshotAt,
      updateTotals: false,
      fetchTokenLiquidity: false,
      fetchAddressAssetDetails: async (wallet, chain) => ({
        ok: true,
        configured: true,
        totalAssetUsd: 900,
        assets: [
          {
            address: wallet,
            chain,
            assetKey: `${chain}:new-event-token`,
            tokenAddress: 'NewEventToken',
            symbol: 'NEW_EVENT',
            name: 'New Event Token',
            balance: 90,
            priceUsd: 10,
            valueUsd: 900,
          },
        ],
        error: null,
      }),
    });

    const staleSweep = await refreshCurrentHoldings({
      now: () => eventSnapshotAt - 100,
      batchFetchLiquidity: emptyLiquidity,
      fetchAddressAssetDetails: async (wallet, chain) => ({
        ok: true,
        configured: true,
        totalAssetUsd: 100,
        assets: [
          {
            address: wallet,
            chain,
            assetKey: `${chain}:old-full-scan-token`,
            tokenAddress: 'OldFullScanToken',
            symbol: 'OLD_FULL_SCAN',
            name: 'Old Full Scan Token',
            balance: 10,
            priceUsd: 10,
            valueUsd: 100,
          },
        ],
        error: null,
      }),
      persistAssetSnapshots: async () => ({
        addressAssets: [],
        userAssets: [],
        blockedUsers: [],
      }),
    });

    assert.equal(staleSweep.status, 'idle');
    const row = getDb()
      .prepare(
        `SELECT symbol, refreshed_at FROM current_holdings
         WHERE tracked_address_lower = ? AND chain = 'solana'`
      )
      .get(address.toLowerCase()) as { symbol: string; refreshed_at: number };
    assert.equal(row.symbol, 'NEW_EVENT');
    assert.equal(row.refreshed_at, eventSnapshotAt);
    console.log('holdings snapshot freshness tests: ok');
  } finally {
    if (previousDbPath === undefined) delete process.env.PILIPILI_DB_PATH;
    else process.env.PILIPILI_DB_PATH = previousDbPath;
    if (previousDataDir === undefined) delete process.env.PILIPILI_DATA_DIR;
    else process.env.PILIPILI_DATA_DIR = previousDataDir;
    if (previousOkxApiKey === undefined) delete process.env.OKX_API_KEY;
    else process.env.OKX_API_KEY = previousOkxApiKey;
    if (previousOkxSecretKey === undefined) delete process.env.OKX_SECRET_KEY;
    else process.env.OKX_SECRET_KEY = previousOkxSecretKey;
    if (previousOkxPassphrase === undefined) delete process.env.OKX_API_PASSPHRASE;
    else process.env.OKX_API_PASSPHRASE = previousOkxPassphrase;
    rmSync(tempDir, { recursive: true, force: true });
  }
}

void run().catch((error) => {
  console.error(error);
  process.exit(1);
});
