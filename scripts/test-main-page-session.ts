import assert from 'node:assert/strict';

import {
  MAIN_PAGE_ROUTE_PATHS,
  createEmptyMainPageSessionState,
  isMainPageRoutePath,
  toLatestActivityAtByUserMap,
  toLatestActivityAtByUserRecord,
} from '@/lib/mainPageSession';

function run() {
  assert.deepEqual(
    MAIN_PAGE_ROUTE_PATHS,
    ['/', '/manage', '/addresses'],
    '主页面会话缓存必须只覆盖 Feed / 人物 / 地址 三个主路由'
  );

  assert.equal(isMainPageRoutePath('/'), true, 'Feed 路由必须被识别为主页面路由');
  assert.equal(isMainPageRoutePath('/manage'), true, '人物路由必须被识别为主页面路由');
  assert.equal(isMainPageRoutePath('/addresses'), true, '地址路由必须被识别为主页面路由');
  assert.equal(isMainPageRoutePath('/tokens'), false, '代币路由不应进入本轮主页面缓存范围');

  const emptyState = createEmptyMainPageSessionState();
  assert.deepEqual(
    emptyState,
    { feed: null, manage: null, addresses: null },
    '主页面缓存初始状态必须为空对象，不应默认写入伪数据'
  );

  const latestMap = toLatestActivityAtByUserMap({ alice: 1000, bob: 2000, broken: Number.NaN });
  assert.equal(latestMap.get('alice'), 1000, 'latestActivityAt map 必须保留有效时间戳');
  assert.equal(latestMap.get('bob'), 2000, 'latestActivityAt map 必须保留多个用户时间戳');
  assert.equal(latestMap.has('broken'), false, 'latestActivityAt map 必须过滤无效时间戳');

  const roundTripRecord = toLatestActivityAtByUserRecord(
    new Map([
      ['alice', 1000],
      ['bob', 2000],
      ['broken', Number.NaN],
    ])
  );
  assert.deepEqual(
    roundTripRecord,
    { alice: 1000, bob: 2000 },
    'latestActivityAt record 序列化时必须只输出有效时间戳'
  );

  console.log('main page session tests: ok');
}

run();
