import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  createSelectedUserDetailsClearedState,
  createSelectedUserDetailsErrorState,
  createSelectedUserDetailsPendingState,
  createSelectedUserDetailsSuccessState,
} from '@/hooks/useSelectedUserDetails';
import type { UserDetailsSuccessPayload } from '@/lib/userDetails';

function createPayload(id: string): UserDetailsSuccessPayload {
  return {
    ok: true,
    user: {
      id,
      name: '详情用户',
      handle: `user-${id}`,
      avatar: '',
      addresses: [],
      totalAssetUsd: 10,
      historicalMaxAssetUsd: 20,
      assetUpdatedAt: null,
      tags: [],
    },
    holdings: [],
    holdingsUpdatedAt: null,
    holdingsThresholdUsd: 5,
    holdingsSummary: {
      visibleCount: 0,
      partial: false,
      successfulAddressCount: 0,
      failedAddressCount: 0,
    },
  };
}

async function run() {
  const source = readFileSync(new URL('../hooks/useSelectedUserDetails.ts', import.meta.url), 'utf8');
  const cached = createPayload('cached-user');

  assert.deepEqual(createSelectedUserDetailsClearedState(), {
    details: null,
    loading: false,
    refreshing: false,
    error: null,
  });

  assert.deepEqual(createSelectedUserDetailsPendingState(null), {
    details: null,
    loading: true,
    refreshing: false,
    error: null,
  });

  assert.deepEqual(createSelectedUserDetailsPendingState(cached), {
    details: cached,
    loading: false,
    refreshing: true,
    error: null,
  });

  assert.deepEqual(createSelectedUserDetailsSuccessState(cached), {
    details: cached,
    loading: false,
    refreshing: false,
    error: null,
  });

  assert.deepEqual(createSelectedUserDetailsErrorState(cached, '刷新失败'), {
    details: cached,
    loading: false,
    refreshing: false,
    error: '刷新失败',
  });

  assert.deepEqual(createSelectedUserDetailsErrorState(null, '首次加载失败'), {
    details: null,
    loading: false,
    refreshing: false,
    error: '首次加载失败',
  });

  assert.match(
    source,
    /new Map<string,\s*UserDetailsSuccessPayload>\(\)/,
    'hook should allocate a per-user in-memory cache map'
  );
  assert.match(
    source,
    /cacheRef\.current\.get\(userId\)/,
    'hook should read cached details by selected user id'
  );
  assert.match(
    source,
    /cacheRef\.current\.set\(userId,\s*payload\)/,
    'hook should cache successful payloads by selected user id'
  );
  assert.match(
    source,
    /setRefreshing\(Boolean\(cached\)\)/,
    'hook should only enter refreshing mode when cached details already exist'
  );

  console.log('selected user details hook contract tests: ok');
}

void run();
