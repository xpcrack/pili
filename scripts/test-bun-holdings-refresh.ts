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
      assetUpdatedAt: 100,
      twitter: undefined,
      telegram: undefined,
    });

    const result = await refreshCurrentHoldings({
      now: () => 1_717_000_000_000,
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
      assetUpdatedAt: 100,
      twitter: undefined,
      telegram: undefined,
    });

    db.exec(`
      CREATE TABLE IF NOT EXISTS telegram_monitor_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        chain TEXT NOT NULL,
        token_address TEXT NOT NULL,
        token_address_lower TEXT NOT NULL,
        raw_text TEXT NOT NULL DEFAULT '',
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        tracked_wallet_address TEXT,
        tracked_wallet_address_lower TEXT
      );
    `);
    db.prepare(
      `INSERT INTO telegram_monitor_events
        (provider, chain, token_address, token_address_lower, raw_text, payload_json,
         created_at, updated_at, tracked_wallet_address, tracked_wallet_address_lower)
       VALUES ('xxyy', 'robinhood', '0xtoken', '0xtoken', '', '{}', 1, 1, ?, ?)`
    ).run(evmAddress, evmAddress.toLowerCase());

    let robinhoodCalls = 0;
    const rhResult = await refreshCurrentHoldings({
      now: () => 1_717_000_000_100,
      fetchAddressAssetDetails: async (address, chain) => {
        if (address === trackedAddress) {
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
        }
        return {
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
        };
      },
      fetchRobinhoodHoldings: async (address) => {
        robinhoodCalls += 1;
        assert.equal(address.toLowerCase(), evmAddress.toLowerCase());
        return {
          ok: true,
          assets: [
            {
              tokenAddress: '0x45242320dbb855eea8fd36804c6487e10e97fcf9',
              symbol: 'TENDIES',
              name: 'TENDIES',
              balance: 1_000_000,
              priceUsd: 0.03,
              valueUsd: 30_000,
              liquidityUsd: 800_000,
            },
            {
              tokenAddress: '0xdeadlowvalue',
              symbol: 'DUST',
              name: 'Dust',
              balance: 1,
              priceUsd: 1,
              valueUsd: 1,
              liquidityUsd: 100_000,
            },
            {
              tokenAddress: '0xdeadlowliq',
              symbol: 'ILLIQ',
              name: 'Illiquid',
              balance: 10,
              priceUsd: 10,
              valueUsd: 100,
              liquidityUsd: 100,
            },
          ],
          error: null,
        };
      },
    });

    assert.equal(robinhoodCalls, 1, 'same EVM 0x should only fetch Robinhood once');
    assert.equal(rhResult.summary.robinhoodWalletCount, 1);
    // Fact table keeps value>=$5 bags even if low-liq (ILLIQ $100 / liq $100).
    // Dust $1 still filtered by MIN_HOLDING_USD. Display may still hide low-liq.
    assert.ok(rhResult.summary.holdingsRowCount >= 2);

    const rhRows = db
      .prepare(
        `SELECT chain, symbol, token_address_lower, value_usd, liquidity_usd, user_id
         FROM current_holdings
         WHERE chain = 'robinhood'
         ORDER BY value_usd DESC`
      )
      .all() as Array<{
      chain: string;
      symbol: string;
      token_address_lower: string;
      value_usd: number;
      liquidity_usd: number | null;
      user_id: string;
    }>;

    assert.equal(rhRows.length, 2);
    assert.equal(rhRows[0]?.symbol, 'TENDIES');
    assert.equal(rhRows[0]?.token_address_lower, '0x45242320dbb855eea8fd36804c6487e10e97fcf9');
    assert.equal(rhRows[0]?.value_usd, 30_000);
    assert.equal(rhRows[0]?.liquidity_usd, 800_000);
    assert.equal(rhRows[0]?.user_id, user.id);
    assert.equal(rhRows[1]?.symbol, 'ILLIQ');
    assert.equal(rhRows[1]?.value_usd, 100);
    assert.equal(rhRows[1]?.liquidity_usd, 100);

    // Failure preserves previous Robinhood cache
    const failed = await refreshCurrentHoldings({
      now: () => 1_717_000_000_200,
      fetchAddressAssetDetails: async (address, chain) => ({
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
      }),
      fetchRobinhoodHoldings: async () => ({
        ok: false,
        assets: [],
        error: '429 RATE_LIMIT_BANNED',
        rateLimited: true,
      }),
    });

    assert.equal(failed.status, 'partial');
    const cachedRh = db
      .prepare(
        `SELECT symbol, value_usd FROM current_holdings WHERE chain = 'robinhood' ORDER BY value_usd DESC`
      )
      .all() as Array<{ symbol: string; value_usd: number }>;
    // Failed RH refresh preserves last-good fact bags (TENDIES + ILLIQ; DUST was never stored)
    assert.equal(cachedRh.length, 2);
    assert.equal(cachedRh[0]?.symbol, 'TENDIES');
    assert.equal(cachedRh[0]?.value_usd, 30_000);
    assert.equal(cachedRh[1]?.symbol, 'ILLIQ');
    assert.equal(cachedRh[1]?.value_usd, 100);

    const rhStatus = db
      .prepare(
        `SELECT status FROM current_holdings_wallet_status
         WHERE chain = 'robinhood' AND tracked_address_lower = ?`
      )
      .get(evmAddress.toLowerCase()) as { status: string } | undefined;
    assert.equal(rhStatus?.status, 'failed');

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
      assetUpdatedAt: 100,
      twitter: undefined,
      telegram: undefined,
    });

    await refreshCurrentHoldings({
      now: () => 1_717_000_000_300,
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
