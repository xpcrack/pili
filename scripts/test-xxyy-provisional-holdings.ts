import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';

const WALLET = '0x1111111111111111111111111111111111111111';
const TOKEN = '0x2222222222222222222222222222222222222222';

async function main() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pilipili-provisional-holdings-'));
  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');
  process.env.HOLDINGS_MIN_REFRESH_AGE_MS = '0';
  try {
    const { getDb } = await import('@/lib/server/sqlite');
    const { applyXxyyProvisionalHolding } = await import('@/lib/server/xxyyProvisionalHoldings');
    const { refreshWalletHoldings } = await import('@/lib/server/holdingsRefreshRuntime');
    const { parseOkxAddressAssetsByChain } = await import('@/lib/okx');
    const db = getDb();

    const parsedMulti = parseOkxAddressAssetsByChain(WALLET, ['ethereum', 'bsc', 'base', 'robinhood'], {
      data: [{
        tokenAssets: [
          { chainIndex: '1', tokenAddress: '0x3333333333333333333333333333333333333333', symbol: 'E', balance: '2', price: '3', valueUsd: '6' },
          { chainIndex: '56', tokenAddress: TOKEN, symbol: 'B', balance: '4', price: '5', valueUsd: '20' },
          { chainIndex: '8453', tokenAddress: '0x4444444444444444444444444444444444444444', symbol: 'A', balance: '6', price: '7', valueUsd: '42' },
          { chainIndex: '4663', tokenAddress: '0xab093def657f15df31b33922a95e047add645b29', symbol: 'SHROOM', balance: '10', price: '15', valueUsd: '150' },
        ],
      }],
    });
    assert.deepEqual(
      Object.fromEntries(Object.entries(parsedMulti.assetsByChain).map(([chain, assets]) => [chain, assets.length])),
      { ethereum: 1, bsc: 1, base: 1, robinhood: 1 },
      'chainIndex 4663 must land on robinhood in the same OKX payload',
    );

    const apply = (
      eventKey: string,
      eventTimeMs: number,
      tokenAmount: number | null,
      priceUsd: number | null,
      action: 'buy' | 'sell' = 'buy',
      actionVariant: 'add' | 'reduce' | 'close' = action === 'buy' ? 'add' : 'reduce',
    ) =>
      applyXxyyProvisionalHolding({
        db,
        eventKey,
        address: WALLET,
        userId: 'u1',
        chain: 'bsc',
        tokenAddress: TOKEN,
        tokenSymbol: 'TEST',
        tokenAmount,
        priceUsd,
        action,
        actionVariant,
        eventTimeMs,
      });

    assert.equal(apply('tx:1', 1_000, 10, 2).applied, true);
    assert.equal(apply('tx:2', 2_000, 5, 2).applied, true);
    assert.equal(apply('tx:1', 1_000, 10, 2).duplicate, true);
    let row = db.prepare(
      `SELECT balance, value_usd, source FROM current_holdings
       WHERE tracked_address_lower = ? AND chain = 'bsc' AND token_address_lower = ?`
    ).get(WALLET, TOKEN) as { balance: number; value_usd: number; source: string };
    assert.deepEqual(row, { balance: 15, value_usd: 30, source: 'xxyy_provisional' });

    const old = apply('tx:old', 1_500, 99, 2);
    assert.equal(old.applied, false);
    assert.equal(old.verification, 'immediate');
    row = db.prepare(
      `SELECT balance, value_usd, source FROM current_holdings
       WHERE tracked_address_lower = ? AND chain = 'bsc' AND token_address_lower = ?`
    ).get(WALLET, TOKEN) as typeof row;
    assert.equal(row.balance, 15, 'out-of-order feed must not mutate the provisional balance');

    assert.equal(apply('tx:sell', 2_500, 4, 2, 'sell', 'reduce').applied, true);
    row = db.prepare(
      `SELECT balance, value_usd, source FROM current_holdings
       WHERE tracked_address_lower = ? AND chain = 'bsc' AND token_address_lower = ?`
    ).get(WALLET, TOKEN) as typeof row;
    assert.equal(row.balance, 11);
    assert.equal(apply('tx:close', 2_600, 11, 2, 'sell', 'close').applied, true);
    row = db.prepare(
      `SELECT balance, value_usd, source FROM current_holdings
       WHERE tracked_address_lower = ? AND chain = 'bsc' AND token_address_lower = ?`
    ).get(WALLET, TOKEN) as typeof row;
    assert.equal(row.balance, 0, 'Sell All must clear immediately');

    const ambiguous = apply('tx:missing-price', 3_000, 1, null);
    assert.equal(ambiguous.applied, false);
    assert.equal(ambiguous.verification, 'immediate');
    const jobs = db.prepare(
      `SELECT wallet_chain, COUNT(*) AS n FROM holdings_refresh_jobs GROUP BY wallet_chain`
    ).all() as Array<{ wallet_chain: string; n: number }>;
    assert.deepEqual(jobs, [{ wallet_chain: `evm:${WALLET}`, n: 1 }], 'EVM feed burst must coalesce to one verification job');

    let multiCalls = 0;
    const refreshed = await refreshWalletHoldings({
      db,
      address: WALLET,
      chain: 'evm',
      userId: 'u1',
      now: () => 5_000,
      updateTotals: false,
      fetchAddressAssetDetailsMulti: async () => {
        multiCalls += 1;
        const ethAsset = {
          address: WALLET,
          chain: 'ethereum' as const,
          assetKey: 'ethereum:0x3333333333333333333333333333333333333333',
          tokenAddress: '0x3333333333333333333333333333333333333333',
          symbol: 'ETHBAG',
          name: null,
          balance: 2,
          priceUsd: 10,
          valueUsd: 20,
        };
        const rhAsset = {
          address: WALLET,
          chain: 'robinhood' as const,
          assetKey: 'robinhood:0xab093def657f15df31b33922a95e047add645b29',
          tokenAddress: '0xab093def657f15df31b33922a95e047add645b29',
          symbol: 'SHROOM',
          name: null,
          balance: 10_000_000,
          priceUsd: 0.015,
          valueUsd: 150_000,
        };
        return {
          ok: true as const,
          configured: true,
          totalAssetUsd: 170_020,
          assets: [ethAsset, rhAsset],
          assetsByChain: { ethereum: [ethAsset], bsc: [], base: [], solana: [], robinhood: [rhAsset] },
          chainSuccess: { ethereum: true, bsc: true, base: true, solana: false, robinhood: true },
          error: null,
        };
      },
    });
    assert.equal(refreshed.status, 'idle');
    assert.equal(multiCalls, 1, 'ETH/BSC/Base/Robinhood must share one OKX request');
    assert.equal(
      (db.prepare(`SELECT COUNT(*) AS n FROM current_holdings WHERE tracked_address_lower = ? AND chain = 'bsc'`).get(WALLET) as { n: number }).n,
      0,
      'an authoritative empty BSC snapshot clears BSC only',
    );
    const eth = db.prepare(
      `SELECT balance, source, authoritative_refreshed_at FROM current_holdings
       WHERE tracked_address_lower = ? AND chain = 'ethereum'`
    ).get(WALLET) as { balance: number; source: string; authoritative_refreshed_at: number };
    assert.deepEqual(eth, { balance: 2, source: 'authoritative', authoritative_refreshed_at: 5_000 });
    const shroom = db.prepare(
      `SELECT balance, value_usd, source FROM current_holdings
       WHERE tracked_address_lower = ? AND chain = 'robinhood'`
    ).get(WALLET) as { balance: number; value_usd: number; source: string };
    assert.deepEqual(shroom, { balance: 10_000_000, value_usd: 150_000, source: 'authoritative' });
    console.log('xxyy provisional holdings tests: ok');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
