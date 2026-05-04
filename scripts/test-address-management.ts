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
    createUser('beta-sort', 'Beta', [
      {
        address: 'BetaSol1111111111111111111111111111111111',
        name: '#1',
        chain: 'solana',
        totalAssetUsd: 1,
        assetUpdatedAt: 10,
      },
    ]),
    createUser('alpha-sort', 'Alpha', [
      {
        address: 'AlphaSol111111111111111111111111111111111',
        name: '#1',
        chain: 'solana',
        totalAssetUsd: 2,
        assetUpdatedAt: 20,
      },
    ]),
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
    createUser('same-evm', 'Same', [
      {
        address: '0x0000000000000000000000000000000000000011',
        name: '#1',
        chain: 'bsc',
        totalAssetUsd: 11,
        assetUpdatedAt: 110,
      },
    ]),
    createUser('same-sol', 'Same', [
      {
        address: 'SameSol1111111111111111111111111111111111',
        name: '#1',
        chain: 'solana',
        totalAssetUsd: 12,
        assetUpdatedAt: 120,
      },
    ]),
    createUser('same-addr-2', 'Same', [
      {
        address: '0x0000000000000000000000000000000000000022',
        name: '#2',
        chain: 'bsc',
        totalAssetUsd: 22,
        assetUpdatedAt: 220,
      },
    ]),
    createUser('same-addr-1', 'Same', [
      {
        address: '0x0000000000000000000000000000000000000021',
        name: '#2',
        chain: 'bsc',
        totalAssetUsd: 21,
        assetUpdatedAt: 210,
      },
    ]),
    createUser('nullish', 'Nullish', [
      {
        address: 'NullishSol1111111111111111111111111111111',
        name: '#3',
        chain: 'solana',
        totalAssetUsd: null,
        assetUpdatedAt: null,
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

  assert.equal(rows.length, 9);

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

  const nullishRow = rows.find((row) => row.displayName === 'Nullish#3');
  assert.ok(nullishRow);
  assert.equal(nullishRow.totalAssetUsd, null);
  assert.equal(nullishRow.assetUpdatedAt, null);

  assert.ok(
    rows.findIndex((row) => row.displayName === 'Alpha#1') <
      rows.findIndex((row) => row.displayName === 'Beta#1'),
    'rows should sort by displayName using localeCompare before chain or address tiebreakers'
  );

  const sameNameDifferentChainRows = rows.filter((row) => row.displayName === 'Same#1');
  assert.deepEqual(
    sameNameDifferentChainRows.map((row) => row.primaryChain),
    ['bsc', 'solana'],
    'same displayName rows should place EVM rows before solana rows'
  );

  const sameNameSameChainRows = rows.filter((row) => row.displayName === 'Same#2');
  assert.deepEqual(
    sameNameSameChainRows.map((row) => row.address),
    ['0x0000000000000000000000000000000000000021', '0x0000000000000000000000000000000000000022'],
    'same displayName rows with the same chain type should sort by address'
  );

  console.log('address management tests: ok');
}

run();
