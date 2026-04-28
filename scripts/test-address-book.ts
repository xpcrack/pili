import assert from 'node:assert/strict';

import type { User } from '@/types';
import {
  expandTrackedAddresses,
  formatUsersForAddressExport,
  groupAddressesForDisplay,
  inferChainFromAddress,
  isEvmChain,
} from '@/lib/addressBook';
import { isValidTrackedAddress, repairMalformedTrackedAddress } from '@/lib/trackedAddressValidation';

function createUser(name: string, addresses: User['addresses']): User {
  return {
    id: name,
    name,
    handle: name,
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

function run() {
  assert.equal(inferChainFromAddress('0xAbCdEf0123456789AbCdEf0123456789AbCdEf02'), 'bsc');
  assert.equal(inferChainFromAddress('Aqa8H5hmHe9MFY9sW6widbqEuaYv7q2KnRo25ApPhWhA'), 'solana');
  assert.equal(isValidTrackedAddress('0xAbCdEf0123456789AbCdEf0123456789AbCdEf02', 'bsc'), true);
  assert.equal(isValidTrackedAddress('0xAbCdEf0123456789AbCdEf0123456789AbCdEf02#7', 'bsc'), false);
  assert.equal(
    repairMalformedTrackedAddress('0xAbCdEf0123456789AbCdEf0123456789AbCdEf02#7', 'bsc'),
    '0xAbCdEf0123456789AbCdEf0123456789AbCdEf02'
  );

  const expanded = expandTrackedAddresses([
    {
      address: '0xAbCdEf0123456789AbCdEf0123456789AbCdEf02',
      name: '#7',
      chain: 'bsc',
      totalAssetUsd: null,
      assetUpdatedAt: null,
    },
    {
      address: 'Aqa8H5hmHe9MFY9sW6widbqEuaYv7q2KnRo25ApPhWhA',
      name: '#2',
      chain: 'solana',
      totalAssetUsd: null,
      assetUpdatedAt: null,
    },
  ]);

  assert.deepEqual(
    expanded.map((item) => item.chain),
    ['bsc', 'ethereum', 'base', 'solana'],
    '0x 地址应自动展开为 3 条 EVM 跟踪记录'
  );

  const grouped = groupAddressesForDisplay([
    {
      address: '0xAbCdEf0123456789AbCdEf0123456789AbCdEf02',
      name: '#7',
      chain: 'bsc',
      totalAssetUsd: 10,
      assetUpdatedAt: 100,
    },
    {
      address: '0xAbCdEf0123456789AbCdEf0123456789AbCdEf02',
      name: '#7',
      chain: 'ethereum',
      totalAssetUsd: 20,
      assetUpdatedAt: 200,
    },
    {
      address: '0xAbCdEf0123456789AbCdEf0123456789AbCdEf02',
      name: '#7',
      chain: 'base',
      totalAssetUsd: 30,
      assetUpdatedAt: 300,
    },
    {
      address: 'Aqa8H5hmHe9MFY9sW6widbqEuaYv7q2KnRo25ApPhWhA',
      name: '#2',
      chain: 'solana',
      totalAssetUsd: 40,
      assetUpdatedAt: 400,
    },
  ]);

  assert.equal(grouped.length, 2, '人物卡片应把同一个 EVM 地址聚合成一条');
  assert.equal(grouped[0]?.networkLabel, 'EVM地址');
  assert.deepEqual(grouped[0]?.chains.filter(isEvmChain), ['bsc', 'ethereum', 'base']);
  assert.equal(grouped[0]?.totalAssetUsd, 60, '聚合后的 EVM 地址资产应按链汇总');
  assert.equal(grouped[0]?.assetUpdatedAt, 300, '聚合后的更新时间应取最新值');
  assert.equal(grouped[1]?.networkLabel, 'SOL地址');

  const exported = formatUsersForAddressExport([
    createUser('testuser', [
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
        address: '0xAbCdEf0123456789AbCdEf0123456789AbCdEf05',
        name: '#9',
        chain: 'bsc',
        totalAssetUsd: null,
        assetUpdatedAt: null,
      },
      {
        address: '0xAbCdEf0123456789AbCdEf0123456789AbCdEf05',
        name: '#9',
        chain: 'ethereum',
        totalAssetUsd: null,
        assetUpdatedAt: null,
      },
      {
        address: '0xAbCdEf0123456789AbCdEf0123456789AbCdEf05',
        name: '#9',
        chain: 'base',
        totalAssetUsd: null,
        assetUpdatedAt: null,
      },
    ]),
    createUser('蓝月', [
      {
        address: '0x5f9bc316d8473d8c6634bd26f3e0932cd6bf0718',
        name: '#1',
        chain: 'bsc',
        totalAssetUsd: null,
        assetUpdatedAt: null,
      },
      {
        address: '0x5f9bc316d8473d8c6634bd26f3e0932cd6bf0718',
        name: '#1',
        chain: 'ethereum',
        totalAssetUsd: null,
        assetUpdatedAt: null,
      },
      {
        address: '0x5f9bc316d8473d8c6634bd26f3e0932cd6bf0718',
        name: '#1',
        chain: 'base',
        totalAssetUsd: null,
        assetUpdatedAt: null,
      },
      {
        address: 'Aqa8H5hmHe9MFY9sW6widbqEuaYv7q2KnRo25ApPhWhA',
        name: '#2',
        chain: 'solana',
        totalAssetUsd: null,
        assetUpdatedAt: null,
      },
    ]),
  ]);

  assert.equal(
    exported,
    [
      '0xAbCdEf0123456789AbCdEf0123456789AbCdEf02:testuser#7',
      '0xAbCdEf0123456789AbCdEf0123456789AbCdEf05:testuser#9',
      '0x5f9bc316d8473d8c6634bd26f3e0932cd6bf0718:蓝月#1',
      'Aqa8H5hmHe9MFY9sW6widbqEuaYv7q2KnRo25ApPhWhA:蓝月#2',
    ].join('\n'),
    '导出应回到 address:人物名#备注，且不能带链后缀'
  );

  console.log('address book tests: ok');
}

run();
