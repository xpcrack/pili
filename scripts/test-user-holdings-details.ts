import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';

import type { ChainType, User } from '@/types';

function makeUser(addresses: User['addresses']): User {
  return {
    id: 'user-1',
    name: 'testuser',
    handle: 'testuser',
    avatar: '',
    twitter: undefined,
    telegram: undefined,
    addresses,
    totalAssetUsd: 0,
    historicalMaxAssetUsd: 0,
    mainstreamAssetUsd: 0,
    assetUpdatedAt: null,
    tags: [],
  };
}

function makeAddress(address: string, name: string, chain: ChainType): User['addresses'][number] {
  return {
    address,
    name,
    chain,
    totalAssetUsd: null,
    assetUpdatedAt: null,
  };
}

async function run() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pilipili-user-holdings-details-'));
  const previousDataDir = process.env.PILIPILI_DATA_DIR;
  const previousDbPath = process.env.PILIPILI_DB_PATH;

  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');

  try {
    const { getDb } = await import('@/lib/server/sqlite');
    const {
      readUserHoldingsDetails,
      UserHoldingsDetailsUnavailableError,
    } = await import('@/lib/server/userHoldingsDetails');

    const db = getDb();
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
        refreshed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS current_holdings_wallet_status (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tracked_address TEXT NOT NULL,
        tracked_address_lower TEXT NOT NULL,
        user_id TEXT,
        chain TEXT NOT NULL,
        status TEXT NOT NULL,
        refreshed_at INTEGER NOT NULL
      );
    `);
    const insertHolding = db.prepare(`
      INSERT INTO current_holdings
        (tracked_address, tracked_address_lower, user_id, chain,
         token_address, token_address_lower, symbol, name,
         balance, price_usd, value_usd, refreshed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertWalletStatus = db.prepare(`
      INSERT INTO current_holdings_wallet_status
        (tracked_address, tracked_address_lower, user_id, chain, status, refreshed_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    function seedWalletStatus(input: {
      trackedAddress: string;
      userId?: string | null;
      chain: ChainType;
      status: 'success' | 'failed';
      refreshedAt: number;
    }) {
      insertWalletStatus.run(
        input.trackedAddress,
        input.trackedAddress.toLowerCase(),
        input.userId ?? 'user-1',
        input.chain,
        input.status,
        input.refreshedAt,
      );
    }

    function seedHolding(input: {
      trackedAddress: string;
      userId?: string | null;
      chain: ChainType;
      tokenAddress: string;
      tokenAddressLower?: string;
      symbol: string;
      name: string | null;
      balance: number;
      priceUsd: number;
      valueUsd: number;
      refreshedAt: number;
    }) {
      insertHolding.run(
        input.trackedAddress,
        input.trackedAddress.toLowerCase(),
        input.userId ?? 'user-1',
        input.chain,
        input.tokenAddress,
        input.tokenAddressLower ?? input.tokenAddress.toLowerCase(),
        input.symbol,
        input.name,
        input.balance,
        input.priceUsd,
        input.valueUsd,
        input.refreshedAt,
      );
    }

    const user = makeUser([
      makeAddress('0xWalletOne', '#1', 'bsc'),
      makeAddress('0xWalletTwo', '#2', 'bsc'),
      makeAddress('SoWallet1111111111111111111111111111111111', '#3', 'solana'),
    ]);

    seedHolding({
      trackedAddress: '0xWalletOne',
      chain: 'bsc',
      tokenAddress: '0xusdt',
      symbol: 'USDT',
      name: 'Tether USD',
      balance: 3,
      priceUsd: 1,
      valueUsd: 3,
      refreshedAt: 9_000,
    });
    seedHolding({
      trackedAddress: '0xWalletOne',
      chain: 'bsc',
      tokenAddress: '0xwbnb',
      symbol: 'WBNB',
      name: 'Wrapped BNB',
      balance: 2,
      priceUsd: 3,
      valueUsd: 6,
      refreshedAt: 9_000,
    });
    seedHolding({
      trackedAddress: '0xWalletTwo',
      chain: 'bsc',
      tokenAddress: '0xUSDT',
      tokenAddressLower: '0xusdt',
      symbol: 'USDT',
      name: 'Tether USD',
      balance: 5,
      priceUsd: 1,
      valueUsd: 5,
      refreshedAt: 9_999,
    });
    seedHolding({
      trackedAddress: '0xWalletTwo',
      chain: 'bsc',
      tokenAddress: '0xdoge',
      symbol: 'DOGE',
      name: 'Dogecoin',
      balance: 100,
      priceUsd: 0.04,
      valueUsd: 4,
      refreshedAt: 9_999,
    });

    const details = await readUserHoldingsDetails(user);

    assert.equal(details.holdingsUpdatedAt, 9_999);
    assert.equal(details.summary.visibleCount, 2);
    assert.equal(details.summary.partial, false);
    assert.equal(details.summary.successfulAddressCount, 3);
    assert.equal(details.summary.failedAddressCount, 0);
    assert.deepEqual(
      details.holdings.map((holding) => [
        holding.chain,
        holding.tokenAddress,
        holding.symbol,
        holding.balance,
        holding.priceUsd,
        holding.valueUsd,
      ]),
      [
        ['bsc', '0xusdt', 'USDT', 8, 1, 8],
        ['bsc', '0xwbnb', 'WBNB', 2, 3, 6],
      ],
      'same-chain same-token holdings should merge, rows under 5 USD should drop, and rows should sort by value desc',
    );

    const normalizationUser = makeUser([
      makeAddress('0xWalletThree', '#4', 'bsc'),
      makeAddress('0xWalletFour', '#5', 'bsc'),
      makeAddress('SoWalletCaseOne111111111111111111111111111111', '#6', 'solana'),
      makeAddress('SoWalletCaseTwo111111111111111111111111111111', '#7', 'solana'),
      makeAddress('0xWalletFive', '#8', 'bsc'),
    ]);

    seedHolding({
      trackedAddress: '0xWalletThree',
      chain: 'bsc',
      tokenAddress: ' 0xAbC ',
      tokenAddressLower: '0xabc',
      symbol: 'ABC',
      name: 'Token ABC',
      balance: 2,
      priceUsd: 1,
      valueUsd: 2,
      refreshedAt: 4_000,
    });
    seedHolding({
      trackedAddress: '0xWalletFour',
      chain: 'bsc',
      tokenAddress: '0xabc',
      symbol: 'ABC',
      name: 'Token ABC',
      balance: 4,
      priceUsd: 1,
      valueUsd: 4,
      refreshedAt: 4_321,
    });
    seedHolding({
      trackedAddress: 'SoWalletCaseOne111111111111111111111111111111',
      chain: 'solana',
      tokenAddress: ' SoTokenCase ',
      tokenAddressLower: 'SoTokenCase',
      symbol: 'SOLA',
      name: 'Sol Token A',
      balance: 1,
      priceUsd: 6,
      valueUsd: 6,
      refreshedAt: 4_100,
    });
    seedHolding({
      trackedAddress: 'SoWalletCaseTwo111111111111111111111111111111',
      chain: 'solana',
      tokenAddress: 'sotokenCase',
      tokenAddressLower: 'sotokenCase',
      symbol: 'SOLB',
      name: 'Sol Token B',
      balance: 1,
      priceUsd: 7,
      valueUsd: 7,
      refreshedAt: 4_200,
    });

    seedWalletStatus({
      trackedAddress: '0xWalletThree',
      chain: 'bsc',
      status: 'success',
      refreshedAt: 4_321,
    });
    seedWalletStatus({
      trackedAddress: '0xWalletFour',
      chain: 'bsc',
      status: 'success',
      refreshedAt: 4_321,
    });
    seedWalletStatus({
      trackedAddress: 'SoWalletCaseOne111111111111111111111111111111',
      chain: 'solana',
      status: 'success',
      refreshedAt: 4_321,
    });
    seedWalletStatus({
      trackedAddress: 'SoWalletCaseTwo111111111111111111111111111111',
      chain: 'solana',
      status: 'success',
      refreshedAt: 4_321,
    });
    seedWalletStatus({
      trackedAddress: '0xWalletFive',
      chain: 'bsc',
      status: 'failed',
      refreshedAt: 4_321,
    });

    const normalizationDetails = await readUserHoldingsDetails(normalizationUser);

    assert.equal(normalizationDetails.holdingsUpdatedAt, 4_321);
    assert.equal(normalizationDetails.summary.partial, true);
    assert.equal(normalizationDetails.summary.successfulAddressCount, 4);
    assert.equal(normalizationDetails.summary.failedAddressCount, 1);
    assert.deepEqual(
      normalizationDetails.holdings.map((holding) => [
        holding.chain,
        holding.tokenAddress,
        holding.symbol,
        holding.balance,
        holding.priceUsd,
        holding.valueUsd,
      ]),
      [
        ['solana', 'sotokenCase', 'SOLB', 1, 7, 7],
        ['bsc', '0xabc', 'ABC', 6, 1, 6],
        ['solana', 'SoTokenCase', 'SOLA', 1, 6, 6],
      ],
      'wallet status rows should drive partial failures, EVM token addresses should trim and merge case-insensitively, and Solana token addresses should remain case-sensitive after trimming',
    );

    const empty = await readUserHoldingsDetails(makeUser([]));
    assert.deepEqual(empty.holdings, []);
    assert.equal(empty.holdingsUpdatedAt, null);
    assert.deepEqual(empty.summary, {
      visibleCount: 0,
      partial: false,
      successfulAddressCount: 0,
      failedAddressCount: 0,
    });

    const unknownUserDetails = await readUserHoldingsDetails(makeUser([makeAddress('0xUnknownWallet', '#9', 'bsc')]));
    assert.deepEqual(unknownUserDetails.holdings, []);
    assert.equal(unknownUserDetails.holdingsUpdatedAt, 9_999);
    assert.deepEqual(unknownUserDetails.summary, {
      visibleCount: 0,
      partial: false,
      successfulAddressCount: 0,
      failedAddressCount: 0,
    });

    // Robinhood rows attach by EVM address without a robinhood address-book entry
    seedHolding({
      trackedAddress: '0xWalletOne',
      chain: 'robinhood' as ChainType,
      tokenAddress: '0x45242320dbb855eea8fd36804c6487e10e97fcf9',
      symbol: 'TENDIES',
      name: 'TENDIES',
      balance: 1000,
      priceUsd: 30,
      valueUsd: 30_000,
      refreshedAt: 10_000,
    });
    // liquidity column may be absent in this test schema — set if present
    try {
      db.exec('ALTER TABLE current_holdings ADD COLUMN liquidity_usd REAL');
      db.prepare(
        `UPDATE current_holdings SET liquidity_usd = ? WHERE chain = 'robinhood' AND token_address_lower = ?`
      ).run(800_000, '0x45242320dbb855eea8fd36804c6487e10e97fcf9');
    } catch {
      // column may already exist
      db.prepare(
        `UPDATE current_holdings SET liquidity_usd = ? WHERE chain = 'robinhood' AND token_address_lower = ?`
      ).run(800_000, '0x45242320dbb855eea8fd36804c6487e10e97fcf9');
    }

    const robinhoodUser = makeUser([makeAddress('0xWalletOne', '#1', 'bsc')]);
    const robinhoodDetails = await readUserHoldingsDetails(robinhoodUser);
    const tendies = robinhoodDetails.holdings.find((h) => h.symbol === 'TENDIES');
    assert.ok(tendies, 'Robinhood holding should be returned for EVM address without robinhood address row');
    assert.equal(tendies.chain, 'robinhood');
    assert.equal(tendies.tokenAddress, '0x45242320dbb855eea8fd36804c6487e10e97fcf9');
    assert.equal(tendies.valueUsd, 30_000);
    assert.equal(tendies.liquidityUsd, 800_000);

    db.prepare('DELETE FROM current_holdings').run();
    await assert.rejects(
      () => readUserHoldingsDetails(makeUser([makeAddress('0xUnknownWallet', '#9', 'bsc')])),
      UserHoldingsDetailsUnavailableError,
      'an entirely empty current_holdings table should raise a route-mappable unavailable error',
    );

    console.log('user holdings details tests: ok');
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
