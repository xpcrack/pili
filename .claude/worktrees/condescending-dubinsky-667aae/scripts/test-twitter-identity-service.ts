import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';

async function run() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pilipili-twitter-identity-service-'));
  const previousDbPath = process.env.PILIPILI_DB_PATH;
  const previousDataDir = process.env.PILIPILI_DATA_DIR;
  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');

  const { resolveTwitterIdentityForHandle, mergeTwitterIdentityIntoUser } = await import(
    '@/lib/server/twitterIdentityService'
  );
  const { upsertTwitterIdentityCache } = await import('@/lib/server/twitterProviderStateRepo');

  try {
    const resolved = await resolveTwitterIdentityForHandle('https://x.com/OldHandle', {
      lookupUser: async (handle) => ({
        provider: 'test-provider',
        user: {
          id: 'stable-user-id',
          handle: handle === 'oldhandle' ? 'newhandle' : handle,
          avatarUrl: 'https://img.example/avatar.jpg',
        },
      }),
    });

    assert.equal(resolved?.userId, 'stable-user-id');
    assert.equal(resolved?.handle, 'newhandle');
    assert.equal(resolved?.avatarUrl, 'https://img.example/avatar.jpg');

    const merged = mergeTwitterIdentityIntoUser(
      {
        name: 'Identity Test',
        handle: 'identity-test',
        avatar: '/api/avatar?twitter=oldhandle',
        twitter: 'oldhandle',
        addresses: [],
        totalAssetUsd: 0,
        historicalMaxAssetUsd: 0,
        assetUpdatedAt: null,
        tags: [],
      },
      resolved
    );

    assert.equal(merged.twitter, 'newhandle');
    assert.equal(merged.twitterUserId, 'stable-user-id');
    assert.equal(merged.twitterAvatarUrl, 'https://img.example/avatar.jpg');
    assert.equal(merged.avatar, 'https://img.example/avatar.jpg');

    const unresolved = mergeTwitterIdentityIntoUser(merged, null);
    assert.equal(unresolved.twitter, 'newhandle');
    assert.equal(unresolved.twitterUserId, 'stable-user-id');

    upsertTwitterIdentityCache({
      handle: 'cachedhandle',
      provider: 'cache-test',
      userId: 'cached-user-id',
      username: 'cachedhandle',
      avatarUrl: 'https://img.example/cached-avatar.jpg',
      expiresAtMs: Date.now() + 60_000,
      lastError: null,
    });

    const cached = await resolveTwitterIdentityForHandle('cachedhandle');
    assert.equal(cached?.userId, 'cached-user-id');
    assert.equal(cached?.avatarUrl, 'https://img.example/cached-avatar.jpg');
  } finally {
    if (typeof previousDbPath === 'string') {
      process.env.PILIPILI_DB_PATH = previousDbPath;
    } else {
      delete process.env.PILIPILI_DB_PATH;
    }
    if (typeof previousDataDir === 'string') {
      process.env.PILIPILI_DATA_DIR = previousDataDir;
    } else {
      delete process.env.PILIPILI_DATA_DIR;
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
}

run().then(() => {
  console.log('twitter identity service tests: ok');
});
