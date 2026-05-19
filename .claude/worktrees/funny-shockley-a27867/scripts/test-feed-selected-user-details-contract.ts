import assert from 'node:assert/strict';
import {
  buildSelectedUserDetailsPanelProps,
} from '@/app/page';
import type { UserDetailsSuccessPayload } from '@/lib/userDetails';
import type { User } from '@/types';

function makeUser(): User {
  return {
    id: 'selected-user',
    name: 'testuser',
    handle: 'testuser',
    avatar: '',
    addresses: [],
    totalAssetUsd: 123_400,
    historicalMaxAssetUsd: 456_700,
    assetUpdatedAt: null,
    tags: ['Alpha'],
  };
}

function makeDetails(user: User): UserDetailsSuccessPayload {
  return {
    ok: true,
    user,
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
  const retrySelectedUserDetails = () => {};

  assert.equal(
    buildSelectedUserDetailsPanelProps({
      selectedUser: null,
      onBack: () => {},
      matchedFeedCount: 0,
      hasMore: false,
      activityBreakdown: null,
      selectedUserDetails: null,
      selectedUserDetailsLoading: false,
      selectedUserDetailsRefreshing: false,
      selectedUserDetailsError: null,
      retrySelectedUserDetails,
    }),
    null,
    'helper should return null when there is no selected user'
  );

  const selectedUser = makeUser();
  const selectedUserDetails = makeDetails(selectedUser);
  const props = buildSelectedUserDetailsPanelProps({
    selectedUser,
    onBack: () => {},
    matchedFeedCount: 7,
    hasMore: true,
    activityBreakdown: {
      twitterCount: 3,
      tradeCount: 4,
    },
    selectedUserDetails,
    selectedUserDetailsLoading: true,
    selectedUserDetailsRefreshing: false,
    selectedUserDetailsError: '读取失败',
    retrySelectedUserDetails,
  });

  assert.ok(props, 'helper should build panel props when a selected user exists');
  assert.equal(props?.selectedUser, selectedUser);
  assert.equal(props?.matchedFeedCount, 7);
  assert.equal(props?.hasMore, true);
  assert.deepEqual(props?.activityBreakdown, {
    twitterCount: 3,
    tradeCount: 4,
  });
  assert.equal(props?.details, selectedUserDetails);
  assert.equal(props?.detailsLoading, true);
  assert.equal(props?.detailsRefreshing, false);
  assert.equal(props?.detailsError, '读取失败');
  assert.equal(props?.onRetryDetails, retrySelectedUserDetails);

  console.log('feed selected user details contract tests: ok');
}

void run();
