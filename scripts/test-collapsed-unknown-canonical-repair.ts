/**
 * Focused unit tests for collapsed canonical repair when OKX leaves token=UNKNOWN
 * + native mint (So1111…111), while XXYY provisional still has the real ticker.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';

const TRACKED = 'CJ5fHkNPf3yd7fKnjv5VtBJTNDAWFiRfLCutpuTAnpis';
const TX = '3dtgw8AyJ2yLQtgkannhoSsKUcGb2aPTZfvTTds9uRgqeMgZzqnbRPVwvhN3HQhosmbhYaK3pH92fCTrWmTbdSmL';
const MINT = 'Ge87EtsjwRQbHaqQmKRno69RFTwh9bfSsm99XNxTpump';
const LEGACY_WSOL = 'So11111111111111111111111111111111111111111';
const WSOL = 'So11111111111111111111111111111111111111112';

async function run() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pili-collapse-'));
  const previousDbPath = process.env.PILIPILI_DB_PATH;
  const previousDataDir = process.env.PILIPILI_DATA_DIR;
  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');

  try {
    const { createTrackedUser } = await import('../lib/server/trackedUsersRepo');
    const { repairCollapsedCanonicalActivitySync } = await import('../lib/server/telegramMonitorActivity');
    const { isNativeAsset } = await import('../lib/parsing/core');

    const user = createTrackedUser({
      name: 'Finn',
      handle: 'finn',
      avatar: 'finn.png',
      twitter: undefined,
      telegram: undefined,
      addresses: [
        {
          address: TRACKED,
          name: '#1',
          chain: 'solana',
          totalAssetUsd: null,
          assetUpdatedAt: null,
        },
      ],
      totalAssetUsd: 0,
      historicalMaxAssetUsd: 0,
      mainstreamAssetUsd: 0,
      assetUpdatedAt: null,
      tags: [],
    });

    const baseState = {
      chain: 'solana',
      trackedWalletAddress: TRACKED,
      txHash: TX,
      tokenAddress: MINT,
      tokenSymbol: 'Jimothy',
      provisionalAction: 'buy' as const,
      provisionalActionLabel: '加仓' as const,
      provisionalActionVariant: 'add' as const,
      provisionalQuoteAmount: 1.99,
      provisionalQuoteSymbol: 'SOL',
      provisionalTokenAmount: 14590.72,
      provisionalTokenSymbol: 'Jimothy',
      provisionalPriceUsd: 0.0104,
      provisionalMarketCapUsd: 10_300_000,
      provisionalRawText: 'Token: 14590.72  [Jimothy]',
      provisionalWalletLabel: 'Finn#1',
      provisionalWalletGroupLabel: null,
      provisionalWalletAliasLabel: 'Finn#1',
      eventTimeMs: 1784427565000,
      reconciliationStatus: 'reconciled' as const,
      reconciledSource: 'okx-detail' as const,
    };

    const unknownCanonical = {
      id: `xxyy-monitor:solana:${TRACKED.toLowerCase()}:${TX.toLowerCase()}`,
      userId: user.id,
      source: 'blockchain' as const,
      type: 'transfer' as const,
      title: '收到转账 (Token)',
      content: '收到 0.008 UNKNOWN',
      timestamp: 1784427565000,
      metadata: {
        txHash: TX,
        value: '0.008',
        token: 'UNKNOWN',
        tokenAddress: LEGACY_WSOL,
        chain: 'solana',
        txAction: 'receive' as const,
        trackedAddress: TRACKED,
        displayTokenSymbol: 'UNKNOWN',
        displayTokenAvatarTokenAddress: LEGACY_WSOL,
      },
    };

    const repairedUnknown = repairCollapsedCanonicalActivitySync({
      user,
      state: baseState,
      canonicalActivity: unknownCanonical,
    });
    assert.equal(
      repairedUnknown.metadata.token,
      'Jimothy',
      'UNKNOWN + legacy So1111…111 should repair to provisional Jimothy'
    );
    assert.equal(repairedUnknown.metadata.tokenAddress, MINT);
    assert.equal(
      String(repairedUnknown.metadata.displayTokenSymbol || '').toUpperCase(),
      'JIMOTHY',
      'display ticker should be Jimothy (uppercased by tradeDisplay)'
    );
    assert.equal(repairedUnknown.metadata.txAction, 'buy');
    assert.equal(repairedUnknown.metadata.quoteAmount, '1.99');
    assert.equal(repairedUnknown.metadata.quoteToken, 'SOL');

    const solNativeCanonical = {
      ...unknownCanonical,
      content: '收到 0.008 SOL',
      metadata: {
        ...unknownCanonical.metadata,
        token: 'SOL',
        tokenAddress: WSOL,
        displayTokenSymbol: 'SOL',
        displayTokenAvatarTokenAddress: WSOL,
      },
    };
    const repairedSol = repairCollapsedCanonicalActivitySync({
      user,
      state: baseState,
      canonicalActivity: solNativeCanonical,
    });
    assert.equal(repairedSol.metadata.token, 'Jimothy', 'SOL + WSOL mint should still repair');
    assert.equal(repairedSol.metadata.tokenAddress, MINT);

    const mintOnlyCollapsed = {
      ...unknownCanonical,
      metadata: {
        ...unknownCanonical.metadata,
        token: 'SOMEOTHER',
        tokenAddress: LEGACY_WSOL,
        displayTokenSymbol: 'SOMEOTHER',
      },
    };
    const repairedMintOnly = repairCollapsedCanonicalActivitySync({
      user,
      state: baseState,
      canonicalActivity: mintOnlyCollapsed,
    });
    assert.equal(
      repairedMintOnly.metadata.token,
      'Jimothy',
      'non-native symbol with native mint address should still repair'
    );

    const goodCanonical = {
      ...unknownCanonical,
      content: '买入 14590.72 Jimothy',
      metadata: {
        ...unknownCanonical.metadata,
        token: 'Jimothy',
        tokenAddress: MINT,
        txAction: 'buy' as const,
        displayTokenSymbol: 'Jimothy',
        displayTokenAvatarTokenAddress: MINT,
        quoteAmount: '1.99',
        quoteToken: 'SOL',
      },
    };
    const unchanged = repairCollapsedCanonicalActivitySync({
      user,
      state: baseState,
      canonicalActivity: goodCanonical,
    });
    assert.equal(unchanged.metadata.token, 'Jimothy', 'already-correct canonical should stay Jimothy');
    assert.equal(unchanged.metadata.tokenAddress, MINT);

    // Native provisional must not force-repair.
    const nativeProvisional = repairCollapsedCanonicalActivitySync({
      user,
      state: {
        ...baseState,
        tokenAddress: WSOL,
        tokenSymbol: 'SOL',
        provisionalTokenSymbol: 'SOL',
      },
      canonicalActivity: unknownCanonical,
    });
    assert.equal(
      nativeProvisional.metadata.token,
      'UNKNOWN',
      'when provisional is also native, do not invent a trade token'
    );

    // Synthetic symbol helper expectation via isNativeAsset (reconciler uses this).
    assert.equal(isNativeAsset('solana', '', LEGACY_WSOL), true);
    assert.equal(isNativeAsset('solana', '', WSOL), true);
    assert.equal(isNativeAsset('solana', '', MINT), false);

    console.log('ok - collapsed UNKNOWN/native mint repair cases passed');
  } finally {
    if (previousDbPath === undefined) delete process.env.PILIPILI_DB_PATH;
    else process.env.PILIPILI_DB_PATH = previousDbPath;
    if (previousDataDir === undefined) delete process.env.PILIPILI_DATA_DIR;
    else process.env.PILIPILI_DATA_DIR = previousDataDir;
    rmSync(tempDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
