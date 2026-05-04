import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildManageServerSyncSignature,
  filterManageUsers,
  getManageAddressDisplayText,
  mergeManageUsersWithServer,
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
  const managePageSource = readFileSync(join(process.cwd(), 'app/manage/page.tsx'), 'utf8');
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
  assert.match(
    managePageSource,
    /toggleSort\('totalCount7d'\)[\s\S]*?近7天总动态/,
    '管理页总动态列必须改为近 7 天口径，并使用独立的 7 天排序键'
  );
  assert.doesNotMatch(
    managePageSource,
    /toggleSort\('totalCountAll'\)[\s\S]*?(累计动态数量|总动态数量)/,
    '管理页总动态列不应继续使用累计口径或旧的模糊表头'
  );
  assert.match(
    managePageSource,
    /fetch\(`\/api\/users\/\$\{[a-zA-Z0-9_.]+\}`,\s*\{[\s\S]*method:\s*'DELETE'/,
    '管理页删除人物必须调用服务端 DELETE 接口，避免只删本地又被服务端回灌'
  );
  assert.doesNotMatch(
    managePageSource,
    /onClick=\{\(\) => deleteUser\(user\.id\)\}/,
    '管理页删除人物不能再直接只删本地 store'
  );

  const localOnly = makeUser({
    id: 'local-only',
    name: 'Local Only',
    handle: 'local-only',
    addresses: [makeAddress('0x2222222222222222222222222222222222222222', '#1')],
  });
  const localProfit = makeUser({
    id: 'profit-id',
    name: 'profit',
    handle: 'profit',
    totalAssetUsd: 10,
    historicalMaxAssetUsd: 12,
    addresses: [
      makeAddress('G5nxEXuFMfV74DSnsrSatqCW32F34XUnBeq3PfDS7w5E', '#1'),
      makeAddress('0x3333333333333333333333333333333333333333', '#2'),
    ],
  });
  const serverProfit = makeUser({
    id: 'profit-id',
    name: 'profit',
    handle: 'profit',
    totalAssetUsd: 99,
    historicalMaxAssetUsd: 99,
    addresses: [makeAddress('G5nxEXuFMfV74DSnsrSatqCW32F34XUnBeq3PfDS7w5E', '#1')],
  });
  const serverEcaeth = makeUser({
    id: 'ecaeth-id',
    name: 'ecaeth',
    handle: 'ecaeth',
    addresses: [makeAddress('0x4444444444444444444444444444444444444444', '#1')],
  });

  const mergedUsers = mergeManageUsersWithServer([localOnly, localProfit], [serverProfit, serverEcaeth]);
  const mergedProfit = mergedUsers.find((user) => user.id === 'profit-id');

  assert.deepEqual(
    mergedUsers.map((user) => user.handle),
    ['profit', 'ecaeth', 'local-only'],
    '服务端人物应回灌到管理页本地用户列表，同时保留本地独有人物'
  );
  assert.equal(mergedProfit?.totalAssetUsd, 99, '服务端同 id 用户应覆盖本地旧的资产快照');
  assert.deepEqual(
    mergedProfit?.addresses.map((address) => address.address),
    ['G5nxEXuFMfV74DSnsrSatqCW32F34XUnBeq3PfDS7w5E', '0x3333333333333333333333333333333333333333'],
    '同 id 用户应保留本地尚未同步到服务端的额外地址'
  );

  console.log('manage users tests: ok');
}

run();
