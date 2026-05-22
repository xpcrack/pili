import assert from 'node:assert/strict';

import {
  readUserHoldingsDetails,
  UserHoldingsDetailsUnavailableError,
} from '@/lib/server/userHoldingsDetails';
import type { User } from '@/types';

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
    assetUpdatedAt: null,
    tags: [],
  };
}

async function run() {
  const user = makeUser([
    {
      address: '0xWalletOne',
      name: '#1',
      chain: 'bsc',
      totalAssetUsd: null,
      assetUpdatedAt: null,
    },
    {
      address: '0xWalletTwo',
      name: '#2',
      chain: 'bsc',
      totalAssetUsd: null,
      assetUpdatedAt: null,
    },
    {
      address: 'SoWallet1111111111111111111111111111111111',
      name: '#3',
      chain: 'solana',
      totalAssetUsd: null,
      assetUpdatedAt: null,
    },
  ]);

  const details = await readUserHoldingsDetails(user, {
    now: () => 9_999,
    fetchAddressAssetDetails: async (address: any, chain: any) => {
      if (address === '0xWalletOne' && chain === 'bsc') {
        return {
          ok: true,
          configured: true,
          totalAssetUsd: 9,
          assets: [
            {
              address,
              chain,
              assetKey: 'bsc:0xusdt:wallet-two',
              tokenAddress: '0xusdt',
              symbol: 'USDT',
              name: 'Tether USD',
              balance: 3,
              priceUsd: 1,
              valueUsd: 3,
            },
            {
              address,
              chain,
              assetKey: 'bsc:0xwbnb',
              tokenAddress: '0xwbnb',
              symbol: 'WBNB',
              name: 'Wrapped BNB',
              balance: 2,
              priceUsd: 999,
              valueUsd: 6,
            },
          ],
          error: null,
        };
      }

      if (address === '0xWalletTwo' && chain === 'bsc') {
        return {
          ok: true,
          configured: true,
          totalAssetUsd: 9,
          assets: [
            {
              address,
              chain,
              assetKey: 'bsc:0xusdt',
              tokenAddress: '0xusdt',
              symbol: 'USDT',
              name: 'Tether USD',
              balance: 5,
              priceUsd: 1,
              valueUsd: 5,
            },
            {
              address,
              chain,
              assetKey: 'bsc:0xdoge',
              tokenAddress: '0xdoge',
              symbol: 'DOGE',
              name: 'Dogecoin',
              balance: 100,
              priceUsd: 0.04,
              valueUsd: 4,
            },
          ],
          error: null,
        };
      }

      if (address.startsWith('SoWallet') && chain === 'solana') {
        return {
          ok: false,
          configured: true,
          totalAssetUsd: null,
          assets: [],
          error: 'temporary upstream failure',
        };
      }

      return {
        ok: false,
        configured: true,
        totalAssetUsd: null,
        assets: [],
        error: 'unexpected',
      };
    },
  });

  assert.equal(details.holdingsUpdatedAt, 9_999);
  assert.equal(details.summary.visibleCount, 2);
  assert.equal(details.summary.partial, true);
  assert.equal(details.summary.successfulAddressCount, 2);
  assert.equal(details.summary.failedAddressCount, 1);
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
    'same-chain same-token holdings should merge, rows under 5 USD should drop, and rows should sort by value desc'
  );

  const normalizationUser = makeUser([
    {
      address: '0xWalletThree',
      name: '#4',
      chain: 'bsc',
      totalAssetUsd: null,
      assetUpdatedAt: null,
    },
    {
      address: '0xWalletFour',
      name: '#5',
      chain: 'bsc',
      totalAssetUsd: null,
      assetUpdatedAt: null,
    },
    {
      address: 'SoWalletCaseOne111111111111111111111111111111',
      name: '#6',
      chain: 'solana',
      totalAssetUsd: null,
      assetUpdatedAt: null,
    },
    {
      address: 'SoWalletCaseTwo111111111111111111111111111111',
      name: '#7',
      chain: 'solana',
      totalAssetUsd: null,
      assetUpdatedAt: null,
    },
    {
      address: '0xWalletFive',
      name: '#8',
      chain: 'bsc',
      totalAssetUsd: null,
      assetUpdatedAt: null,
    },
  ]);

  const normalizationDetails = await readUserHoldingsDetails(normalizationUser, {
    now: () => 4_321,
    fetchAddressAssetDetails: async (address: any, chain: any) => {
      if (address === '0xWalletThree' && chain === 'bsc') {
        return {
          ok: true,
          configured: true,
          totalAssetUsd: 6,
          assets: [
            {
              address,
              chain,
              assetKey: 'bsc:mixed-upper',
              tokenAddress: ' 0xAbC ',
              symbol: 'ABC',
              name: 'Token ABC',
              balance: 2,
              priceUsd: 1,
              valueUsd: 2,
            },
          ],
          error: null,
        };
      }

      if (address === '0xWalletFour' && chain === 'bsc') {
        return {
          ok: true,
          configured: true,
          totalAssetUsd: 4,
          assets: [
            {
              address,
              chain,
              assetKey: 'bsc:mixed-lower',
              tokenAddress: '0xabc',
              symbol: 'ABC',
              name: 'Token ABC',
              balance: 4,
              priceUsd: 1,
              valueUsd: 4,
            },
          ],
          error: null,
        };
      }

      if (address === 'SoWalletCaseOne111111111111111111111111111111' && chain === 'solana') {
        return {
          ok: true,
          configured: true,
          totalAssetUsd: 6,
          assets: [
            {
              address,
              chain,
              assetKey: 'solana:token-upper',
              tokenAddress: ' SoTokenCase ',
              symbol: 'SOLA',
              name: 'Sol Token A',
              balance: 1,
              priceUsd: 6,
              valueUsd: 6,
            },
          ],
          error: null,
        };
      }

      if (address === 'SoWalletCaseTwo111111111111111111111111111111' && chain === 'solana') {
        return {
          ok: true,
          configured: true,
          totalAssetUsd: 7,
          assets: [
            {
              address,
              chain,
              assetKey: 'solana:token-lower',
              tokenAddress: 'sotokenCase',
              symbol: 'SOLB',
              name: 'Sol Token B',
              balance: 1,
              priceUsd: 7,
              valueUsd: 7,
            },
          ],
          error: null,
        };
      }

      if (address === '0xWalletFive' && chain === 'bsc') {
        throw new Error('temporary fetch exception');
      }

      return {
        ok: false,
        configured: true,
        totalAssetUsd: null,
        assets: [],
        error: 'unexpected',
      };
    },
  });

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
    'thrown address fetches should count as partial failures, EVM token addresses should trim and merge case-insensitively, and Solana token addresses should remain case-sensitive after trimming'
  );

  const empty = await readUserHoldingsDetails(makeUser([]), {
    now: () => 123,
  });
  assert.deepEqual(empty.holdings, []);
  assert.equal(empty.holdingsUpdatedAt, null);
  assert.deepEqual(empty.summary, {
    visibleCount: 0,
    partial: false,
    successfulAddressCount: 0,
    failedAddressCount: 0,
  });

  await assert.rejects(
    () =>
      readUserHoldingsDetails(user, {
        fetchAddressAssetDetails: async () => ({
          ok: false,
          configured: true,
          totalAssetUsd: null,
          assets: [],
          error: 'all failed',
        }),
      }),
    UserHoldingsDetailsUnavailableError,
    'all failed addresses should raise a route-mappable unavailable error'
  );

  console.log('user holdings details tests: ok');
}

void run();
