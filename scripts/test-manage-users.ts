import assert from 'node:assert/strict';

import {
  buildManageServerSyncSignature,
  filterManageUsers,
  getManageAddressDisplayText,
  matchesManageUserSearch,
} from '@/lib/manageUsers';
import type { User } from '@/types';

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: overrides.id || 'hong',
    name: overrides.name || '弘哥',
    handle: overrides.handle || 'hong',
    avatar: overrides.avatar || '',
    twitter: overrides.twitter,
    telegram: overrides.telegram,
    addresses: overrides.addresses || [],
    totalAssetUsd: overrides.totalAssetUsd || 0,
    historicalMaxAssetUsd: overrides.historicalMaxAssetUsd || 0,
    assetUpdatedAt: overrides.assetUpdatedAt ?? null,
    tags: overrides.tags || [],
  };
}

function makeAddress(address: string, name = '#2'): User['addresses'][number] {
  return {
    address,
    name,
    chain: 'bsc',
    totalAssetUsd: null,
    assetUpdatedAt: null,
  };
}

function run() {
  const hongAddress = '0x7592ca1ad468ddac5a97a5625c1c55e36338f786';
  const replacementAddress = '0x1111111111111111111111111111111111111111';
  const hong = makeUser({
    twitter: 'hong_x',
    telegram: 'hong_tg',
    tags: ['聪明钱'],
    addresses: [makeAddress(hongAddress, '#2')],
  });

  assert.equal(
    getManageAddressDisplayText(hongAddress),
    hongAddress,
    '管理页地址展示文本必须保留完整地址'
  );
  assert.equal(
    getManageAddressDisplayText(hongAddress).includes('...'),
    false,
    '管理页地址展示文本不能使用省略号缩写'
  );

  assert.equal(matchesManageUserSearch(hong, '弘哥'), true, '搜索应支持人物名');
  assert.equal(matchesManageUserSearch(hong, 'hong_x'), true, '搜索应支持 Twitter');
  assert.equal(matchesManageUserSearch(hong, '聪明钱'), true, '搜索应支持标签');
  assert.equal(matchesManageUserSearch(hong, '#2'), true, '搜索应支持地址别名');
  assert.equal(matchesManageUserSearch(hong, hongAddress), true, '搜索应支持完整地址');
  assert.deepEqual(filterManageUsers([hong], hongAddress), [hong], '完整地址应能过滤出对应人物');
  assert.deepEqual(filterManageUsers([hong], 'not-present'), [], '无匹配搜索应返回空列表');

  const originalSignature = buildManageServerSyncSignature([hong]);
  const sameCountDifferentAddressSignature = buildManageServerSyncSignature([
    makeUser({
      addresses: [makeAddress(replacementAddress, '#2')],
    }),
  ]);
  const sameAddressDifferentAliasSignature = buildManageServerSyncSignature([
    makeUser({
      addresses: [makeAddress(hongAddress, '#3')],
    }),
  ]);

  assert.notEqual(
    originalSignature,
    sameCountDifferentAddressSignature,
    '同步签名必须包含地址内容，不能只看地址数量'
  );
  assert.notEqual(
    originalSignature,
    sameAddressDifferentAliasSignature,
    '同步签名必须包含地址别名，避免服务端别名不同步'
  );

  console.log('manage users tests: ok');
}

run();
