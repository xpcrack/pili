import assert from 'node:assert/strict';

import { renderToStaticMarkup } from 'react-dom/server';

import { formatUsdCompact } from '@/lib/assetFormat';
import { UserBar } from '@/components/UserBar';
import type { User } from '@/types';

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function makeUser(): User {
  return {
    id: 'alice',
    name: 'Alice',
    handle: 'alice',
    avatar: '',
    addresses: [{ address: 'AliceWallet111', name: 'main', chain: 'solana', totalAssetUsd: null, assetUpdatedAt: null }],
    totalAssetUsd: 123_000,
    historicalMaxAssetUsd: 456_000,
    mainstreamAssetUsd: 0,
    assetUpdatedAt: null,
    tags: [],
  };
}

function run() {
  const user = makeUser();
  const markup = renderToStaticMarkup(
    <UserBar
      users={[user]}
      selectedUserId={null}
      latestActivityAtByUser={new Map()}
      onSelectUser={() => {}}
      starredUserIds={{}}
      onToggleStarredUser={() => {}}
    />
  );

  assert.match(
    markup,
    new RegExp(escapeRegExp(formatUsdCompact(user.totalAssetUsd))),
    'user bar should show current total asset in the desktop summary'
  );
  assert.doesNotMatch(
    markup,
    new RegExp(escapeRegExp(formatUsdCompact(user.historicalMaxAssetUsd))),
    'user bar summary row shows current assets, not ATH (ranking moved to current-asset sort)'
  );

  console.log('user bar tests: ok');
}

run();
