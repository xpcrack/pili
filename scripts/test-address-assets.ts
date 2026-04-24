import assert from 'node:assert/strict';

import type { User } from '@/types';
import { collectAddressAssetSnapshots } from '@/lib/addressAssetSnapshots';

function createUser(id: string, name: string, addresses: User['addresses']): User {
  return {
    id,
    name,
    handle: id,
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
  const calls: Array<{ address: string; chain: string }> = [];
  const users = [
    createUser('testuser', 'testuser', [
      {
        address: '0xAbCdEf0123456789AbCdEf0123456789AbCdEf02',
        name: '#7',
        chain: 'bsc',
        totalAssetUsd: null,
        assetUpdatedAt: null,
      },
      {
        address: '0xAbCdEf0123456789AbCdEf0123456789AbCdEf02',
        name: '#7',
        chain: 'ethereum',
        totalAssetUsd: null,
        assetUpdatedAt: null,
      },
      {
        address: '0xAbCdEf0123456789AbCdEf0123456789AbCdEf02',
        name: '#7',
        chain: 'base',
        totalAssetUsd: null,
        assetUpdatedAt: null,
      },
      {
        address: 'Aqa8H5hmHe9MFY9sW6widbqEuaYv7q2KnRo25ApPhWhA',
        name: '#8',
        chain: 'solana',
        totalAssetUsd: null,
        assetUpdatedAt: null,
      },
    ]),
  ];

  const result = await collectAddressAssetSnapshots(users, async (address, chain) => {
    calls.push({ address, chain });

    if (chain === 'bsc') {
      return { ok: true, configured: true, totalAssetUsd: 10, error: null };
    }
    if (chain === 'ethereum') {
      return { ok: true, configured: true, totalAssetUsd: 20, error: null };
    }
    if (chain === 'base') {
      return { ok: true, configured: true, totalAssetUsd: 30, error: null };
    }
    if (chain === 'solana') {
      return { ok: true, configured: true, totalAssetUsd: 40, error: null };
    }

    return { ok: false, configured: true, totalAssetUsd: null, error: 'unexpected' };
  });

  assert.deepEqual(
    calls.map((item) => item.chain),
    ['bsc', 'ethereum', 'base', 'solana'],
    '应按展开后的三条 EVM 链分别抓取资产'
  );
  assert.equal(result.addressAssets.length, 4);
  assert.deepEqual(
    result.addressAssets.map((item) => `${item.chain}:${item.totalAssetUsd}`),
    ['bsc:10', 'ethereum:20', 'base:30', 'solana:40']
  );
  assert.equal(result.userAssets.length, 1);
  assert.equal(result.userAssets[0]?.totalAssetUsd, 100, '人物总资产应汇总三条 EVM 链和其它链');

  const partial = await collectAddressAssetSnapshots(users, async (_address, chain) => {
    if (chain === 'ethereum') {
      return { ok: false, configured: true, totalAssetUsd: null, error: 'fail' };
    }
    if (chain === 'bsc') {
      return { ok: true, configured: true, totalAssetUsd: 10, error: null };
    }
    if (chain === 'base') {
      return { ok: true, configured: true, totalAssetUsd: 30, error: null };
    }
    return { ok: true, configured: true, totalAssetUsd: 40, error: null };
  });

  assert.equal(partial.addressAssets.length, 3, '失败链不应写入无效资产快照');
  assert.equal(partial.userAssets[0]?.totalAssetUsd, 80, '人物总资产应汇总成功链的结果');

  console.log('address asset tests: ok');
}

void run();
