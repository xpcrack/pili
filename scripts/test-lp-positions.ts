import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * LP 持仓链路测试：
 * 1. tickToSqrtPriceX96 / amountsForLiquidity 数学（对拍 newone viem 移植前的已知值）
 * 2. poolIdOf keccak 与真实链上 poolId 一致（用 ROP 仓 801660 的实测数据）
 * 3. refreshLpPositions 写表 + 投影 current_holdings（mock fetcher，不触网）
 * 4. readUserHoldingsDetails 合并 LP 行（isLp 标记 + 阈值过滤）
 */

async function run() {
  const { tickToSqrtPriceX96, amountsForLiquidity, _internals } = await import(
    '@/lib/server/robinhoodV4Lp'
  );

  // TickMath 对拍：tick 0 → 2^96
  assert.equal(tickToSqrtPriceX96(0), BigInt(2) ** BigInt(96), 'tick 0 → 2^96');
  // tick 60 = 1.01^... 近似 sqrt(1.0002)：只用符号性质验证（> 2^96 且接近）
  const up = tickToSqrtPriceX96(60);
  const down = tickToSqrtPriceX96(-60);
  assert.ok(up > tickToSqrtPriceX96(0), 'positive tick → sqrtPrice > 1');
  assert.ok(down < tickToSqrtPriceX96(0), 'negative tick → sqrtPrice < 1');

  // full-range position：tickCurrent 在 [lower, upper) 内 → 两侧都有量
  const Q96 = BigInt(2) ** BigInt(96);
  const amounts = amountsForLiquidity(tickToSqrtPriceX96(0), -887220, 887220, BigInt(1e18), 0);
  assert.ok(amounts.amount0 > BigInt(0) && amounts.amount1 > BigInt(0), 'in-range position has both sides');
  // 越界上沿（currentTick >= tickUpper）：amount0 = 0
  const above = amountsForLiquidity(tickToSqrtPriceX96(0), 100, 200, BigInt(1e18), 250);
  assert.equal(above.amount0, BigInt(0), 'above range → amount0 = 0');
  assert.ok(above.amount1 > BigInt(0), 'above range → amount1 only');

  // poolId 对拍（ROP tokenId 801660 的 poolKey 实测 + 链上 PositionInfo 内嵌 poolId 前缀）
  const poolId = _internals.poolIdOf({
    currency0: '0x2e8c31162b855a2ffa90f6f8634643ad6f111e18',
    currency1: '0x98096d17e191b3da1d5f99a6d7b3584351b11e18',
    fee: 9000,
    tickSpacing: 90,
    hooks: '0x0000000000000000000000000000000000000000',
  });
  assert.equal(
    poolId,
    '0x1f1778596d8c1ee3e1eaf64ea83a5e77063b142fa3ef59a7c81e520c516379bc',
    'poolId keccak must match on-chain value',
  );

  // --- refreshLpPositions 端到端（mock，不触网）---
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'pilipili-lp-refresh-'));
  const previousDataDir = process.env.PILIPILI_DATA_DIR;
  const previousDbPath = process.env.PILIPILI_DB_PATH;
  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');

  try {
    const { getDb } = await import('@/lib/server/sqlite');
    const { refreshLpPositions, ensureLpPositionsTable } = await import('@/lib/server/lpPositionsRefresh');
    const { readUserHoldingsDetails } = await import('@/lib/server/userHoldingsDetails');

    const db = getDb();
    // tracked_users 先建（tracked_addresses.user_id 有 FK）
    db.exec(`
      CREATE TABLE IF NOT EXISTS tracked_users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        handle TEXT NOT NULL,
        avatar TEXT NOT NULL,
        twitter TEXT,
        telegram TEXT,
        tags_json TEXT NOT NULL DEFAULT '[]',
        total_asset_usd REAL NOT NULL DEFAULT 0,
        historical_max_asset_usd REAL NOT NULL DEFAULT 0,
        asset_updated_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    db.prepare(
      `INSERT INTO tracked_users (id, name, handle, avatar, created_at, updated_at)
       VALUES ('u1', 'Tester', 'tester', '', 1, 1)`,
    ).run();
    db.exec(`
      CREATE TABLE IF NOT EXISTS tracked_addresses (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        address TEXT NOT NULL,
        address_lower TEXT NOT NULL,
        name TEXT NOT NULL,
        chain TEXT NOT NULL,
        total_asset_usd REAL,
        asset_updated_at INTEGER,
        last_synced_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    db.prepare(
      `INSERT INTO tracked_addresses (id, user_id, address, address_lower, name, chain, total_asset_usd, asset_updated_at, last_synced_at, created_at, updated_at)
       VALUES ('a1', 'u1', '0xWalletLP', '0xwalletlp', '#1', 'robinhood', NULL, NULL, NULL, 1, 1)`,
    ).run();

    // current_holdings 先有一行 OKX spot（真实钱包总有现货余额，如稳定币），
    // 保证 rows.length > 0 走正常合并路径（全表空 = 未 provisioned，应抛错）。
    db.exec(`
      CREATE TABLE IF NOT EXISTS current_holdings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tracked_address TEXT NOT NULL,
        tracked_address_lower TEXT NOT NULL,
        user_id TEXT,
        chain TEXT NOT NULL,
        token_address TEXT NOT NULL,
        token_address_lower TEXT NOT NULL,
        symbol TEXT,
        name TEXT,
        balance REAL,
        price_usd REAL,
        value_usd REAL,
        liquidity_usd REAL,
        source TEXT NOT NULL DEFAULT 'authoritative',
        provisional_updated_at INTEGER,
        authoritative_refreshed_at INTEGER,
        refreshed_at INTEGER NOT NULL,
        UNIQUE(tracked_address_lower, chain, token_address_lower)
      );
    `);
    db.prepare(
      `INSERT INTO current_holdings (tracked_address, tracked_address_lower, user_id, chain, token_address, token_address_lower, symbol, name, balance, price_usd, value_usd, refreshed_at)
       VALUES ('0xWalletLP', '0xwalletlp', 'u1', 'robinhood', '0xusdc', '0xusdc', 'USDC', 'USD Coin', 10, 1, 10, 900_000)`,
    ).run();

    const wallet = '0xwalletlp';
    const position = {
      tokenId: 801660,
      poolId: '0xp00l',
      currency0: '0x2e8c31162b855a2ffa90f6f8634643ad6f111e18',
      currency1: '0x98096d17e191b3da1d5f99a6d7b3584351b11e18',
      fee: 9000,
      feePct: 0.9,
      tickLower: -887220,
      tickUpper: 887220,
      liquidity: '1867664123254122426135695',
      currentTick: 8118,
      sqrtPriceX96: '118895971971098391207573867130',
      amount0Human: 1_000_000,
      amount1Human: 2_000_000,
      token0Symbol: '0x2e8c',
      token1Symbol: '0x9809',
      token0Decimals: 18,
      token1Decimals: 18,
      price0Usd: null,
      price1Usd: null,
      usd0: null,
      usd1: null,
      totalUsd: null,
      name: 'Uniswap V4 0.9% 0x2e8c/0x9809',
      fullRange: true,
    };

    const fetchLpPositionsCalls: string[] = [];
    const result = await refreshLpPositions({
      db,
      now: () => 1_000_000,
      wallets: [{ addressLower: wallet, userId: 'u1' }],
      fetchLpPositions: async (owner: string) => {
        fetchLpPositionsCalls.push(owner);
        // 两次调用（balanceOf 筛选 + 正式扫描）都返回同一结果
        return {
          address: owner,
          balance: 1,
          positions: [position],
          totalUsd: 300_000,
          warnings: [],
        };
      },
      fetchTendiesEthUsd: async () => ({ ethUsd: 3000, tendiesUsd: 0.04 }),
      fetchLegPrice: async (contractAddress: string) => {
        const priceByCa: Record<string, number> = {
          '0x2e8c31162b855a2ffa90f6f8634643ad6f111e18': 0.09,
          '0x98096d17e191b3da1d5f99a6d7b3584351b11e18': 0.04,
        };
        const price = priceByCa[contractAddress.toLowerCase()];
        if (!price) return null;
        return {
          ticker: 'X', name: 'X', price, marketCap: 0,
          liquidity: 1_000_000, priceChange24h: 0, volume24h: 0,
        };
      },
    });

    assert.equal(result.status, 'idle', `refresh status not idle: ${JSON.stringify(result.summary)}`);
    assert.equal(result.summary.positionCount, 1);
    assert.ok(result.summary.totalUsd > 0, 'totalUsd priced via leg prices');

    // 表内容：legs 用 DexScreener 价（AI 0.09 × 1M + BONER 0.04 × 2M = 90k + 80k = 170k）
    ensureLpPositionsTable(db);
    const lpRow = db
      .prepare('SELECT * FROM current_lp_positions WHERE tracked_address_lower = ?')
      .get(wallet) as { total_usd: number | null; symbol: string | null; user_id: string | null };
    assert.ok(lpRow, 'lp row persisted');
    assert.equal(lpRow.user_id, 'u1');
    assert.ok(
      Math.abs((lpRow.total_usd ?? 0) - 170_000) < 1,
      `leg-priced total: expected ~170000, got ${lpRow.total_usd}`,
    );

    // current_holdings 投影
    const projected = db
      .prepare(`SELECT * FROM current_holdings WHERE chain = 'robinhood-lp' AND tracked_address_lower = ?`)
      .get(wallet) as { value_usd: number; symbol: string; source: string } | undefined;
    assert.ok(projected, 'projected row in current_holdings');
    assert.equal(projected.source, 'lp');
    assert.ok(Math.abs(projected.value_usd - 170_000) < 1, 'projected value matches legs');

    // readUserHoldingsDetails 合并 LP 行（isLp=true）
    const { listTrackedUsers } = await import('@/lib/server/trackedUsersRepo');
    void listTrackedUsers;
    const user = {
      id: 'u1',
      name: 'Tester',
      handle: 'tester',
      avatar: '',
      twitter: undefined,
      telegram: undefined,
      addresses: [
        {
          address: '0xWalletLP',
          name: '#1',
          chain: 'base' as const,
          totalAssetUsd: null,
          assetUpdatedAt: null,
        },
      ],
      totalAssetUsd: 0,
      historicalMaxAssetUsd: 0,
      mainstreamAssetUsd: 0,
      assetUpdatedAt: null,
      tags: [],
    };
    const details = await readUserHoldingsDetails(user);
    const lpHolding = details.holdings.find((h) => h.isLp);
    assert.ok(lpHolding, 'LP row merged into holdings details');
    assert.ok(Math.abs(lpHolding.valueUsd - 170_000) < 1, 'LP row valueUsd from lp table');
    assert.equal(lpHolding.chain, 'robinhood');
    assert.ok(lpHolding.tokenAddress.startsWith('lp:uniswap-v4:'), 'LP tokenAddress is lp: prefix');

    // 阈值以下不显示：把价格改小后重刷 → 消失
    await refreshLpPositions({
      db,
      now: () => 2_000_000,
      wallets: [{ addressLower: wallet, userId: 'u1' }],
      fetchLpPositions: async (owner: string) => ({
        address: owner,
        balance: 1,
        positions: [{ ...position, amount0Human: 0.0001, amount1Human: 0.0002 }],
        totalUsd: 0.001,
        warnings: [],
      }),
      fetchTendiesEthUsd: async () => ({ ethUsd: 3000, tendiesUsd: 0.04 }),
      fetchLegPrice: async () => null,
    });
    const details2 = await readUserHoldingsDetails(user);
    assert.ok(!details2.holdings.some((h) => h.isLp), 'dust LP row filtered by threshold');

    // LP 仓位清空（卖出）→ 聚合行从 current_holdings 消失
    await refreshLpPositions({
      db,
      now: () => 3_000_000,
      wallets: [{ addressLower: wallet, userId: 'u1' }],
      fetchLpPositions: async (owner: string) => ({
        address: owner,
        balance: 0,
        positions: [],
        totalUsd: 0,
        warnings: [],
      }),
      fetchTendiesEthUsd: async () => ({ ethUsd: 3000, tendiesUsd: 0.04 }),
      fetchLegPrice: async () => null,
    });
    const stale = db
      .prepare(`SELECT COUNT(*) AS c FROM current_holdings WHERE chain = 'robinhood-lp'`)
      .get() as { c: number };
    assert.equal(stale.c, 0, 'closed LP projection removed from current_holdings');
    const staleLp = db
      .prepare('SELECT COUNT(*) AS c FROM current_lp_positions')
      .get() as { c: number };
    assert.equal(staleLp.c, 0, 'closed LP rows removed from lp table');

    console.log('lp positions tests: ok');
  } finally {
    if (previousDataDir === undefined) {
      delete process.env.PILIPILI_DATA_DIR;
    } else {
      process.env.PILIPILI_DATA_DIR = previousDataDir;
    }
    if (previousDbPath === undefined) {
      delete process.env.PILIPILI_DB_PATH;
    } else {
      process.env.PILIPILI_DB_PATH = previousDbPath;
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
}

void run().catch((error) => {
  console.error(error);
  process.exit(1);
});
