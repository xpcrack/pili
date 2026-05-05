import assert from 'node:assert/strict';

import { renderToStaticMarkup } from 'react-dom/server';

import { SelectedUserDetailsPanel } from '@/components/SelectedUserDetailsPanel';
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
    tags: ['Alpha', 'Whale'],
  };
}

function makeDetails(
  overrides: Partial<UserDetailsSuccessPayload> = {}
): UserDetailsSuccessPayload {
  const user = makeUser();

  return {
    ok: true,
    user,
    holdings: [
      {
        chain: 'bsc',
        tokenAddress: '0xusdt',
        symbol: 'USDT',
        name: 'Tether USD',
        balance: 321.1234,
        priceUsd: 1,
        valueUsd: 321.1234,
      },
    ],
    holdingsUpdatedAt: 123_456,
    holdingsThresholdUsd: 5,
    holdingsSummary: {
      visibleCount: 1,
      partial: false,
      successfulAddressCount: 1,
      failedAddressCount: 0,
    },
    ...overrides,
    user,
  };
}

function renderPanel(props: Partial<React.ComponentProps<typeof SelectedUserDetailsPanel>> = {}) {
  const selectedUser = makeUser();

  return renderToStaticMarkup(
    <SelectedUserDetailsPanel
      selectedUser={selectedUser}
      onBack={() => {}}
      matchedFeedCount={7}
      hasMore={true}
      activityBreakdown={{ twitterCount: 3, tradeCount: 4 }}
      details={null}
      detailsLoading={false}
      detailsRefreshing={false}
      detailsError={null}
      onRetryDetails={() => {}}
      {...props}
    />
  );
}

function run() {
  const loadingMarkup = renderPanel({ detailsLoading: true });
  assert.match(loadingMarkup, /正在加载持仓明细/, 'panel should show the loading state when details are pending');
  assert.match(loadingMarkup, /持仓明细/, 'panel should render the holdings section title during loading');
  assert.match(loadingMarkup, /已隐藏 &lt; 5 USD 持仓/, 'panel should show the hidden threshold helper text');

  const errorMarkup = renderPanel({ detailsError: '读取失败', detailsLoading: false });
  assert.match(errorMarkup, /读取失败/, 'panel should show the error text when details request fails');
  assert.match(errorMarkup, />重试</, 'panel should render a retry button when details request fails without cached data');

  const emptyMarkup = renderPanel({
    details: makeDetails({
      holdings: [],
      holdingsUpdatedAt: null,
      holdingsSummary: {
        visibleCount: 0,
        partial: false,
        successfulAddressCount: 1,
        failedAddressCount: 0,
      },
    }),
  });
  assert.match(emptyMarkup, /暂无 &gt;= 5 USD 的持仓/, 'panel should show the empty state for successful empty holdings');

  const partialSuccessMarkup = renderPanel({
    detailsRefreshing: true,
    details: makeDetails({
      holdingsSummary: {
        visibleCount: 1,
        partial: true,
        successfulAddressCount: 1,
        failedAddressCount: 1,
      },
    }),
  });
  assert.match(partialSuccessMarkup, /正在后台刷新持仓明细/, 'panel should show background refreshing copy when cached details refresh');
  assert.match(partialSuccessMarkup, /部分地址读取失败，结果可能不完整/, 'panel should show a partial warning');
  assert.match(partialSuccessMarkup, /更新于/, 'panel should show the holdings updated timestamp when present');
  assert.match(partialSuccessMarkup, /<th[^>]*>链<\/th>/, 'panel should render the chain column');
  assert.match(partialSuccessMarkup, /<th[^>]*>Token<\/th>/, 'panel should render the token column');
  assert.match(partialSuccessMarkup, /<th[^>]*>数量<\/th>/, 'panel should render the balance column');
  assert.match(partialSuccessMarkup, /<th[^>]*>单价<\/th>/, 'panel should render the price column');
  assert.match(partialSuccessMarkup, /<th[^>]*>价值<\/th>/, 'panel should render the value column');
  assert.match(partialSuccessMarkup, />USDT</, 'panel should render holdings rows');
  assert.match(partialSuccessMarkup, /Tether USD/, 'panel should render the token name secondary text');

  console.log('selected user details panel tests: ok');
}

run();
