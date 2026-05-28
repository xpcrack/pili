import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';

function createTempDbDir() {
  return mkdtempSync(path.join(tmpdir(), 'pilipili-bun-holdings-refresh-'));
}

async function run() {
  const tempDir = createTempDbDir();
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
    const trackedAddress = 'FyoBqc6Vf9SpiByTohLP87Ns2rQZoGu534yzQGjLv3Tt';
    const { createTrackedUser } = await import('@/lib/server/trackedUsersRepo');
    const { getDb } = await import('@/lib/server/sqlite');
    const { refreshCurrentHoldings } = await import('@/lib/server/holdingsRefreshRuntime');

    createTrackedUser({
      name: 'Holdings Bun',
      handle: 'holdings-bun',
      avatar: 'holdings-bun.png',
      tags: [],
      addresses: [
        {
          address: trackedAddress,
          name: '#1',
          chain: 'solana',
          totalAssetUsd: 100,
          assetUpdatedAt: 100,
        },
      ],
      totalAssetUsd: 100,
      historicalMaxAssetUsd: 100,
      assetUpdatedAt: 100,
      twitter: undefined,
      telegram: undefined,
    });

    const result = await refreshCurrentHoldings({
      now: () => 1_717_000_000_000,
      fetchAddressAssetDetails: async (address, chain) => {
        assert.equal(address, trackedAddress);
        assert.equal(chain, 'solana');

        return {
          ok: true,
          configured: true,
          totalAssetUsd: 100,
          assets: [
            {
              address,
              chain,
              assetKey: `${chain}:usdc`,
              tokenAddress: 'So11111111111111111111111111111111111111112',
              symbol: 'USDC',
              name: 'USD Coin',
              balance: 100,
              priceUsd: 1,
              valueUsd: 100,
            },
          ],
          error: null,
        };
      },
    });

    assert.equal(result.status, 'idle');
    assert.equal(result.summary.trackedAddressCount, 1);
    assert.equal(result.summary.uniqueTrackedAddressCount, 1);
    assert.equal(result.summary.refreshedWalletCount, 1);
    assert.equal(result.summary.failedWalletCount, 0);
    assert.equal(result.summary.holdingsRowCount, 1);

    const rows = getDb()
      .prepare(
        `SELECT tracked_address, tracked_address_lower, chain, token_address_lower, symbol, value_usd, refreshed_at
         FROM current_holdings`
      )
      .all() as Array<{
      tracked_address: string;
      tracked_address_lower: string;
      chain: string;
      token_address_lower: string;
      symbol: string;
      value_usd: number;
      refreshed_at: number;
    }>;

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.tracked_address, trackedAddress);
    assert.equal(rows[0]?.tracked_address_lower, trackedAddress.toLowerCase());
    assert.equal(rows[0]?.chain, 'solana');
    assert.equal(rows[0]?.token_address_lower, 'So11111111111111111111111111111111111111112');
    assert.equal(rows[0]?.symbol, 'USDC');
    assert.equal(rows[0]?.value_usd, 100);
    assert.equal(rows[0]?.refreshed_at, 1_717_000_000_000);

    console.log('bun holdings refresh tests: ok');
  } finally {
    if (previousDbPath === undefined) {
      delete process.env.PILIPILI_DB_PATH;
    } else {
      process.env.PILIPILI_DB_PATH = previousDbPath;
    }

    if (previousDataDir === undefined) {
      delete process.env.PILIPILI_DATA_DIR;
    } else {
      process.env.PILIPILI_DATA_DIR = previousDataDir;
    }

    if (previousOkxApiKey === undefined) {
      delete process.env.OKX_API_KEY;
    } else {
      process.env.OKX_API_KEY = previousOkxApiKey;
    }

    if (previousOkxSecretKey === undefined) {
      delete process.env.OKX_SECRET_KEY;
    } else {
      process.env.OKX_SECRET_KEY = previousOkxSecretKey;
    }

    if (previousOkxPassphrase === undefined) {
      delete process.env.OKX_API_PASSPHRASE;
    } else {
      process.env.OKX_API_PASSPHRASE = previousOkxPassphrase;
    }

    rmSync(tempDir, { recursive: true, force: true });
  }
}

void run().catch((error) => {
  console.error(error);
  process.exit(1);
});
