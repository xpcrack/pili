import assert from 'node:assert/strict';

import './server-only-shim.cjs';

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
    fetchAddressAssetDetails: async (address, chain) => {
      if (address === '0xWalletOne' && chain === 'bsc') {
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
              balance: 1,
              priceUsd: 6,
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
      holding.symbol,
      holding.balance,
      holding.priceUsd,
      holding.valueUsd,
    ]),
    [
      ['bsc', 'USDT', 8, 1, 8],
      ['bsc', 'WBNB', 1, 6, 6],
    ],
    'same-chain same-token holdings should merge, rows under 5 USD should drop, and rows should sort by value desc'
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
