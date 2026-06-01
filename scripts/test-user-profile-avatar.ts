import assert from 'node:assert/strict';

import { getUserAvatar } from '@/lib/userProfile';
import type { User } from '@/types';

function makeUser(overrides: Partial<User>): User {
  return {
    id: 'u1',
    name: 'Sen',
    handle: 'sen',
    avatar: '',
    twitter: 'sencrazy_1',
    addresses: [],
    totalAssetUsd: 0,
    historicalMaxAssetUsd: 0,
    assetUpdatedAt: null,
    tags: [],
    ...overrides,
  };
}

function run() {
  const brokenTwitterImage =
    'https://pbs.twimg.com/profile_images/2013985548680253440/svwc0h58_normal.jpg';

  const twitterUserWithBrokenAvatar = makeUser({
    avatar: brokenTwitterImage,
    twitterAvatarUrl: brokenTwitterImage,
  });

  const resolved = getUserAvatar(twitterUserWithBrokenAvatar);

  assert.match(
    resolved,
    /^\/api\/avatar\?/,
    'twitter users should resolve avatar via /api/avatar proxy instead of direct pbs.twimg.com links'
  );

  const plainUser = makeUser({
    twitter: undefined,
    avatar: 'https://example.com/custom.png',
    twitterAvatarUrl: undefined,
  });

  assert.equal(
    getUserAvatar(plainUser),
    'https://example.com/custom.png',
    'non-twitter users should keep explicit custom avatar URLs'
  );

  console.log('user profile avatar tests: ok');
}

run();
