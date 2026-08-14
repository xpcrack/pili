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
    const evmAddress = '0x50f27cdb650879a41fb07038bf2b818845c20e17';
    const { createTrackedUser } = await import('@/lib/server/trackedUsersRepo');
    const { getDb } = await import('@/lib/server/sqlite');
    const { refreshCurrentHoldings, ensureCurrentHoldingsTable } = await import(
      '@/lib/server/holdingsRefreshRuntime'
    );

    // Offline: never hit real DexScreener during holdings writes.
    const batchFetchLiquidity = async () => new Map();

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
      historicalMaxAssetUsd: 200,
      mainstreamAssetUsd: 0,
      assetUpdatedAt: 100,
      twitter: undefined,
      telegram: undefined,
    });

    const holdingsBunUserId = (
      getDb().prepare(`SELECT id FROM tracked_users WHERE handle = ?`).get('holdings-bun') as {
        id: string;
      }
    ).id;

    const result = await refreshCurrentHoldings({
      now: () => 1_717_000_000_000,
      batchFetchLiquidity,
      fetchTokenLiquidity: async () => ({ liquidityUsd: 10_000_000 }),
      fetchAddressAssetDetails: async (address, chain) => {
        assert.equal(address, trackedAddress);
        assert.equal(chain, 'solana');

        return {
          ok: true,
          configured: true,
          totalAssetUsd: 1_104,
          assets: [
            {
              address,
              chain,
              assetKey: `${chain}:usdc`,
              tokenAddress: 'So11111111111111111111111111111111111111112',
              symbol: 'USDC',
              name: 'USD Coin',
              balance: 1_100,
              priceUsd: 1,
              valueUsd: 1_100,
            },
            {
              address,
              chain,
              assetKey: `${chain}:dust`,
              tokenAddress: 'Dust111111111111111111111111111111111111111',
              symbol: 'DUST',
              name: 'Dust',
              balance: 4,
              priceUsd: 1,
              valueUsd: 4,
            },
          ],
          error: null,
        };
      },
      fetchRobinhoodHoldings: async () => {
        throw new Error('solana-only fixture should not call robinhood fetch');
      },
    });

    assert.equal(result.status, 'idle');
    assert.equal(result.summary.trackedAddressCount, 1);
    assert.equal(result.summary.uniqueTrackedAddressCount, 1);
    assert.equal(result.summary.refreshedWalletCount, 1);
    assert.equal(result.summary.failedWalletCount, 0);
    assert.equal(result.summary.holdingsRowCount, 1);
    assert.equal(result.summary.robinhoodWalletCount, 0);

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
    assert.equal(rows[0]?.value_usd, 1_100);
    assert.equal(rows[0]?.refreshed_at, 1_717_000_000_000);

    const refreshedUser = getDb()
      .prepare(`SELECT total_asset_usd, historical_max_asset_usd FROM tracked_users WHERE handle = ?`)
      .get('holdings-bun') as { total_asset_usd: number; historical_max_asset_usd: number };
    assert.equal(refreshedUser.total_asset_usd, 1_104, 'user total should include holdings hidden below $5');
    assert.equal(refreshedUser.historical_max_asset_usd, 1_104, 'complete refresh should raise the shared peak');

    // Robinhood: same EVM 0x across chains + XXYY event → one GMGN call
    const db = getDb();
    const user = createTrackedUser({
      name: 'Rop RH',
      handle: 'rop-rh',
      avatar: 'rop-rh.png',
      tags: [],
      addresses: [
        { address: evmAddress, name: '#2', chain: 'base', totalAssetUsd: 10, assetUpdatedAt: 100 },
        { address: evmAddress, name: '#2', chain: 'ethereum', totalAssetUsd: 10, assetUpdatedAt: 100 },
        { address: evmAddress, name: '#2', chain: 'bsc', totalAssetUsd: 10, assetUpdatedAt: 100 },
      ],
      totalAssetUsd: 30,
      historicalMaxAssetUsd: 30,
      mainstreamAssetUsd: 0,
      assetUpdatedAt: 100,
      twitter: undefined,
      telegram: undefined,
    });

    // Robinhood wallets are owned by the persistent GMGN queue
    // (holdings-refresh-gmgn) since 2026-08-13; the OKX full scan must not
    // re-fetch them (weight-5 signed requests, duplicates the queue).
    let robinhoodCalls = 0;
    const rhScan = await refreshCurrentHoldings({
      now: () => 1_717_000_000_100,
      batchFetchLiquidity,
      fetchAddressAssetDetails: async (address, chain) => ({
        ok: true,
        configured: true,
        totalAssetUsd: 10,
        assets: [
          {
            address,
            chain,
            assetKey: `${chain}:eth`,
            tokenAddress: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
            symbol: 'ETH',
            name: 'Ether',
            balance: 0.01,
            priceUsd: 1000,
            valueUsd: 10,
          },
        ],
        error: null,
      }),
      fetchRobinhoodHoldings: async () => {
        robinhoodCalls += 1;
        return { ok: true, assets: [], error: null };
      },
    });

    assert.equal(robinhoodCalls, 0, 'full scan must not fetch Robinhood wallets (GMGN queue owns them)');
    assert.equal(rhScan.summary.robinhoodWalletCount, 0);
    const rhRowsAfterScan = db
      .prepare(`SELECT COUNT(*) AS n FROM current_holdings WHERE chain = 'robinhood'`)
      .get() as { n: number };
    assert.equal(rhRowsAfterScan.n, 0, 'full scan must not write Robinhood holdings');


    // Partial OKX failure must not raise historical peak for incomplete users
    const partialSol = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
    const partialEvm = '0x1111111111111111111111111111111111111111';
    const partialPeakUser = createTrackedUser({
      name: 'Partial Peak',
      handle: 'partial-peak',
      avatar: 'partial-peak.png',
      tags: [],
      addresses: [
        {
          address: partialSol,
          name: '#1',
          chain: 'solana',
          totalAssetUsd: 50,
          assetUpdatedAt: 100,
        },
        {
          address: partialEvm,
          name: '#2',
          chain: 'base',
          totalAssetUsd: 50,
          assetUpdatedAt: 100,
        },
      ],
      totalAssetUsd: 100,
      historicalMaxAssetUsd: 100,
      mainstreamAssetUsd: 0,
      assetUpdatedAt: 100,
      twitter: undefined,
      telegram: undefined,
    });

    await refreshCurrentHoldings({
      now: () => 1_717_000_000_300,
      batchFetchLiquidity,
      fetchTokenLiquidity: async () => ({ liquidityUsd: 10_000_000 }),
      fetchAddressAssetDetails: async (address, chain) => {
        if (address === partialSol) {
          return {
            ok: true,
            configured: true,
            totalAssetUsd: 5_000,
            assets: [
              {
                address,
                chain,
                assetKey: `${chain}:big`,
                tokenAddress: 'So11111111111111111111111111111111111111112',
                symbol: 'USDC',
                name: 'USD Coin',
                balance: 5_000,
                priceUsd: 1,
                valueUsd: 5_000,
              },
            ],
            error: null,
          };
        }
        if (address === partialEvm) {
          return {
            ok: false,
            configured: true,
            totalAssetUsd: null,
            assets: [],
            error: 'network down',
          };
        }
        return {
          ok: true,
          configured: true,
          totalAssetUsd: 10,
          assets: [
            {
              address,
              chain,
              assetKey: `${chain}:keep`,
              tokenAddress:
                chain === 'solana'
                  ? 'So11111111111111111111111111111111111111112'
                  : '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
              symbol: chain === 'solana' ? 'USDC' : 'ETH',
              name: null,
              balance: 1,
              priceUsd: 10,
              valueUsd: 10,
            },
          ],
          error: null,
        };
      },
      fetchRobinhoodHoldings: async () => ({
        ok: false,
        assets: [],
        error: 'skip',
      }),
    });

    const partialPeak = db
      .prepare(`SELECT total_asset_usd, historical_max_asset_usd FROM tracked_users WHERE id = ?`)
      .get(partialPeakUser.id) as { total_asset_usd: number; historical_max_asset_usd: number };
    assert.equal(partialPeak.total_asset_usd, 100, 'partial user total must stay unchanged');
    assert.equal(partialPeak.historical_max_asset_usd, 100, 'partial refresh must not raise peak');

    ensureCurrentHoldingsTable(db);

    // --- Single-wallet partial refresh (trade-triggered path) ---
    const { refreshWalletHoldings } = await import('@/lib/server/holdingsRefreshRuntime');

    // Seed a second wallet row that must survive partial refresh of wallet A.
    // Valid base58 Solana address (not the same as trackedAddress).
    const otherSol = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';
    const otherUser = createTrackedUser({
      name: 'Other Bag',
      handle: 'other-bag',
      avatar: 'other.png',
      tags: [],
      addresses: [
        {
          address: otherSol,
          name: '#1',
          chain: 'solana',
          totalAssetUsd: 50,
          assetUpdatedAt: 100,
        },
      ],
      totalAssetUsd: 50,
      historicalMaxAssetUsd: 50,
      mainstreamAssetUsd: 0,
      assetUpdatedAt: 100,
      twitter: undefined,
      telegram: undefined,
    });
    db.prepare(
      `INSERT INTO current_holdings
        (tracked_address, tracked_address_lower, user_id, chain, token_address, token_address_lower,
         symbol, name, balance, price_usd, value_usd, liquidity_usd, refreshed_at)
       VALUES (?, ?, ?, 'solana', 'SoKeep', 'SoKeep', 'KEEP', null, 1, 50, 50, 10000, 1)`
    ).run(otherSol, otherSol.toLowerCase(), otherUser.id);

    // Reuse holdings-bun's wallet (already owned) instead of creating a conflicting user.
    db.prepare(
      `INSERT INTO current_holdings
        (tracked_address, tracked_address_lower, user_id, chain, token_address, token_address_lower,
         symbol, name, balance, price_usd, value_usd, liquidity_usd, refreshed_at)
       VALUES (?, ?, ?, 'solana', 'OldToken', 'OldToken', 'OLD', null, 1, 9, 9, 10000, 1)`
    ).run(trackedAddress, trackedAddress.toLowerCase(), holdingsBunUserId);

    const beforeOther = (
      db.prepare(`SELECT COUNT(*) as c FROM current_holdings WHERE tracked_address_lower = ?`).get(
        otherSol.toLowerCase()
      ) as { c: number }
    ).c;
    assert.equal(beforeOther, 1);

    let walletFetchCalls = 0;
    const walletResult = await refreshWalletHoldings({
      address: trackedAddress,
      chain: 'solana',
      userId: holdingsBunUserId,
      now: () => 1_717_000_000_400,
      fetchTokenLiquidity: false,
      fetchAddressAssetDetails: async (address, chain) => {
        walletFetchCalls += 1;
        assert.equal(address, trackedAddress);
        assert.equal(chain, 'solana');
        return {
          ok: true,
          configured: true,
          totalAssetUsd: 2_200,
          assets: [
            {
              address,
              chain,
              assetKey: `${chain}:usdc`,
              tokenAddress: 'So11111111111111111111111111111111111111112',
              symbol: 'USDC',
              name: 'USD Coin',
              balance: 2_200,
              priceUsd: 1,
              valueUsd: 2_200,
            },
            {
              address,
              chain,
              assetKey: `${chain}:dust`,
              tokenAddress: 'Dust111111111111111111111111111111111111111',
              symbol: 'DUST',
              name: 'Dust',
              balance: 2,
              priceUsd: 1,
              valueUsd: 2,
            },
          ],
          error: null,
        };
      },
    });

    assert.equal(walletResult.status, 'idle');
    assert.equal(walletFetchCalls, 1);
    assert.equal(walletResult.holdingsRowCount, 1);
    assert.equal(walletResult.totalAssetUsd, 2_202);

    const walletRows = db
      .prepare(
        `SELECT symbol, value_usd, refreshed_at FROM current_holdings
         WHERE tracked_address_lower = ? AND chain = 'solana'
         ORDER BY value_usd DESC`
      )
      .all(trackedAddress.toLowerCase()) as Array<{
      symbol: string;
      value_usd: number;
      refreshed_at: number;
    }>;
    assert.equal(walletRows.length, 1, 'old bag replaced; dust filtered');
    assert.equal(walletRows[0]?.symbol, 'USDC');
    assert.equal(walletRows[0]?.value_usd, 2_200);
    assert.equal(walletRows[0]?.refreshed_at, 1_717_000_000_400);

    const afterOther = (
      db.prepare(`SELECT COUNT(*) as c FROM current_holdings WHERE tracked_address_lower = ?`).get(
        otherSol.toLowerCase()
      ) as { c: number }
    ).c;
    assert.equal(afterOther, 1, 'partial refresh must not erase other wallets');

    const walletUserTotals = db
      .prepare(`SELECT total_asset_usd FROM tracked_users WHERE id = ?`)
      .get(holdingsBunUserId) as { total_asset_usd: number };
    assert.equal(walletUserTotals.total_asset_usd, 2_202);

    // Failure must not wipe last-good bags
    const failResult = await refreshWalletHoldings({
      address: trackedAddress,
      chain: 'solana',
      userId: holdingsBunUserId,
      now: () => 1_717_000_000_500,
      fetchTokenLiquidity: false,
      fetchAddressAssetDetails: async () => ({
        ok: false,
        configured: true,
        totalAssetUsd: null,
        assets: [],
        error: 'timeout',
      }),
    });
    assert.equal(failResult.status, 'error');
    const stillThere = (
      db.prepare(
        `SELECT COUNT(*) as c FROM current_holdings WHERE tracked_address_lower = ? AND chain = 'solana'`
      ).get(trackedAddress.toLowerCase()) as { c: number }
    ).c;
    assert.equal(stillThere, 1, 'failed refresh preserves previous bags');

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
