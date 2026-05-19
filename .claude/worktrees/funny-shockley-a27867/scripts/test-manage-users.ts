import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  ADDRESSES_PAGE_FETCH_URL,
  DELETE_ADDRESS_CONFIRMATION_TEXT,
} from '@/app/addresses/page';
import { TOP_NAV_ACTIVE_VALUES, TOP_NAV_ITEMS } from '@/components/TopNav';
import {
  buildManageServerSyncSignature,
  filterManageUsers,
  getManageAddressDisplayText,
  mergeManageUsersWithServer,
  matchesManageUserSearch,
} from '@/lib/manageUsers';
import { useUsersDataStore } from '@/store/usersDataStore';
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

function readProjectFile(relativePath: string) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
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
  const managePageSource = readProjectFile('app/manage/page.tsx');
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

  const topNavSource = readProjectFile('components/TopNav.tsx');
  const addressesPagePath = path.join(process.cwd(), 'app/addresses/page.tsx');

  assert.equal(fs.existsSync(addressesPagePath), true, 'addresses 页面文件必须存在');

  const addressesPageSource = readProjectFile('app/addresses/page.tsx');

  const originalStoreUsers = useUsersDataStore.getState().users;
  try {
    useUsersDataStore.setState({
      users: [
        makeUser({
          id: 'remove-test',
          addresses: [
            {
              address: '0xAbCdEf0000000000000000000000000000000001',
              name: '#1',
              chain: 'bsc',
              totalAssetUsd: 5,
              assetUpdatedAt: 11,
            },
            {
              address: '0xabcdef0000000000000000000000000000000001',
              name: '#1',
              chain: 'ethereum',
              totalAssetUsd: 7,
              assetUpdatedAt: 12,
            },
          ],
          totalAssetUsd: 12,
          historicalMaxAssetUsd: 20,
          currentChainAssetTotal: 12,
          historicalMaxChainAssetTotal: 20,
        }),
      ],
    });

    useUsersDataStore.getState().removeAddress('remove-test', '0xabcdef0000000000000000000000000000000001');

    const updatedUser = useUsersDataStore.getState().getUserById('remove-test');
    assert.ok(updatedUser, '删除地址后人物记录仍应保留');
    assert.equal(updatedUser.addresses.length, 0, '删除逻辑必须按逻辑地址移除所有 EVM 链变体');
    assert.equal(updatedUser.totalAssetUsd, 0, '删除地址后当前总资产必须同步归零');
    assert.equal(updatedUser.currentChainAssetTotal, 0, '删除地址后 currentChainAssetTotal 必须同步归零');
    assert.equal(updatedUser.historicalMaxAssetUsd, 20, '删除地址不应篡改历史最高资产');
  } finally {
    useUsersDataStore.setState({ users: originalStoreUsers });
  }

  assert.equal(TOP_NAV_ACTIVE_VALUES.includes('addresses'), true, 'TopNav 必须支持 addresses active 态');
  assert.equal(
    TOP_NAV_ITEMS.some((item) => item.href === '/addresses' && item.label === '地址'),
    true,
    'TopNav 必须提供地址导航入口'
  );
  assert.equal(ADDRESSES_PAGE_FETCH_URL, '/api/addresses', 'addresses 页面必须从 /api/addresses 拉数据');
  assert.equal(
    DELETE_ADDRESS_CONFIRMATION_TEXT.includes('删除地址，不会删除人物'),
    true,
    'addresses 页面删除确认文案必须明确说明不会删除人物'
  );
  assert.match(addressesPageSource, /fetch\(/, 'addresses 页面必须主动发起数据拉取');
  assert.match(addressesPageSource, /removeAddress\(/, 'addresses 页面删除成功后必须同步更新本地 store');
  assert.doesNotMatch(managePageSource, /expandedAddressByUserId/, 'manage 页面不应再保留 expandedAddressByUserId');
  assert.doesNotMatch(managePageSource, /toggleAddressExpand/, 'manage 页面不应再保留 toggleAddressExpand');
  assert.doesNotMatch(managePageSource, /ChevronDown/, 'manage 页面不应再保留 ChevronDown');
  assert.doesNotMatch(managePageSource, /ChevronUp/, 'manage 页面不应再保留 ChevronUp');
  assert.match(managePageSource, /href="\/addresses"/, 'manage 页面必须提供跳转 /addresses 的入口');
  assert.match(managePageSource, /追加地址/, 'manage 页面必须保留给现有人物追加地址的入口');
  assert.match(managePageSource, /method:\s*'POST'/, 'manage 页面追加地址必须调用服务端 POST 路由');
  assert.match(
    managePageSource,
    /\/api\/users\/\$\{user\.id\}\/addresses/,
    'manage 页面追加地址必须复用 /api/users/[id]/addresses'
  );

  console.log('manage users tests: ok');
}

run();
