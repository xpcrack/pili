import assert from 'node:assert/strict';

import { buildGmgnAddressUrl } from '@/lib/addressBook';
import { buildAddressManagementRows } from '@/lib/addressManagement';
import type { User } from '@/types';

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

function run() {
  const users = [
    createUser('testuser', 'testuser', [
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
    ]),
    createUser('lanyue', '蓝月', [
      {
        address: 'Aqa8H5hmHe9MFY9sW6widbqEuaYv7q2KnRo25ApPhWhA',
        name: '#2',
        chain: 'solana',
        totalAssetUsd: 40,
        assetUpdatedAt: 400,
      },
    ]),
  ];

  const rows = buildAddressManagementRows(
    users,
    new Map([
      ['bsc:0xabcdef0123456789abcdef0123456789abcdef02', 1700],
      ['ethereum:0xabcdef0123456789abcdef0123456789abcdef02', 2900],
      ['base:0xabcdef0123456789abcdef0123456789abcdef02', 2100],
      ['solana:aqa8h5hmhe9mfy9sw6widbqeuayv7q2knro25apphwha', 4500],
    ])
  );

  assert.equal(rows.length, 2);

  const evmRow = rows.find((row) => row.primaryChain === 'bsc');
  assert.ok(evmRow);
  assert.equal(evmRow.displayName, 'testuser#7');
  assert.deepEqual(evmRow.chains, ['bsc', 'ethereum', 'base']);
  assert.equal(evmRow.primaryChain, 'bsc');
  assert.equal(evmRow.networkLabel, 'EVM地址');
  assert.equal(evmRow.totalAssetUsd, 60);
  assert.equal(evmRow.assetUpdatedAt, 300);
  assert.equal(evmRow.latestActivityAt, 2900);
  assert.equal(
    evmRow.gmgnUrl,
    buildGmgnAddressUrl('bsc', '0xAbCdEf0123456789AbCdEf0123456789AbCdEf02')
  );

  const solanaRow = rows.find((row) => row.primaryChain === 'solana');
  assert.ok(solanaRow);
  assert.equal(solanaRow.displayName, '蓝月#2');
  assert.deepEqual(solanaRow.chains, ['solana']);
  assert.equal(solanaRow.primaryChain, 'solana');
  assert.equal(solanaRow.latestActivityAt, 4500);

  console.log('address management tests: ok');
}

run();
