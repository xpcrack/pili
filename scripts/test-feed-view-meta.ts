import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';

async function run() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pilipili-feed-view-meta-'));
  const previousDbPath = process.env.PILIPILI_DB_PATH;
  const previousDataDir = process.env.PILIPILI_DATA_DIR;
  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');

  try {
    const configuredStartMs = 1_712_000_000_000;
    const requestedEndMs = 1_713_000_000_000;
    const unifiedStartMs = configuredStartMs - 10_000;

    const { saveSystemConfig } = await import('../lib/server/systemConfigRepo');
    const { saveCompletenessSourceState } = await import('../lib/server/completenessRepo');
    const { createTrackedUser } = await import('../lib/server/trackedUsersRepo');
    const { readFeedViewMeta } = await import('../lib/server/feedViewMeta');

    saveSystemConfig({
      completenessStartMs: configuredStartMs,
    });

    const user = createTrackedUser({
      name: 'Unified Coverage User',
      handle: 'unified-coverage-user',
      avatar: 'avatar.png',
      twitter: '@coverage_user',
      twitterUserId: 'coverage-user-id',
      twitterAvatarUrl: 'https://example.com/avatar.png',
      telegram: '@coverage_user',
      addresses: [
        {
          address: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
          name: '#1',
          chain: 'solana',
          totalAssetUsd: null,
          assetUpdatedAt: null,
        },
      ],
      currentChainAssetTotal: 0,
      historicalMaxChainAssetTotal: 0,
      totalAssetUsd: 0,
      historicalMaxAssetUsd: 0,
      assetUpdatedAt: null,
      tags: [],
    });

    saveCompletenessSourceState({
      source: 'blockchain',
      requestedStartMs: configuredStartMs,
      provenStartMs: unifiedStartMs,
      provenEndMs: requestedEndMs,
      status: 'complete',
      failureCount: 0,
      lastSuccessAt: requestedEndMs,
      lastFailureAt: null,
      blockedReason: null,
      checkpointJson: '{"cursor":"blockchain"}',
    });
    saveCompletenessSourceState({
      source: 'twitter',
      requestedStartMs: configuredStartMs,
      provenStartMs: configuredStartMs - 10_000,
      provenEndMs: requestedEndMs - 60_000,
      status: 'complete',
      failureCount: 0,
      lastSuccessAt: requestedEndMs - 60_000,
      lastFailureAt: null,
      blockedReason: null,
      checkpointJson: '{"cursor":"twitter"}',
    });
    saveCompletenessSourceState({
      source: 'telegram-bridge',
      requestedStartMs: configuredStartMs,
      provenStartMs: configuredStartMs - 20_000,
      provenEndMs: requestedEndMs,
      status: 'complete',
      failureCount: 0,
      lastSuccessAt: requestedEndMs,
      lastFailureAt: null,
      blockedReason: null,
      checkpointJson: '{"cursor":"bridge"}',
    });
    saveCompletenessSourceState({
      source: 'telegram-channel',
      requestedStartMs: configuredStartMs,
      provenStartMs: configuredStartMs - 30_000,
      provenEndMs: requestedEndMs,
      status: 'complete',
      failureCount: 0,
      lastSuccessAt: requestedEndMs,
      lastFailureAt: null,
      blockedReason: null,
      checkpointJson: '{"cursor":"channel"}',
    });

    const laggingGlobalMeta = readFeedViewMeta({
      endMs: requestedEndMs,
    });

    assert.equal(laggingGlobalMeta.completenessWindow.startMs, unifiedStartMs);
    assert.equal(laggingGlobalMeta.completenessWindow.endMs, requestedEndMs - 60_000);
    assert.equal(laggingGlobalMeta.completenessWindow.complete, false);

    const laggingSelectedUserMeta = readFeedViewMeta({
      userId: user.id,
      endMs: requestedEndMs,
    });

    assert.equal(laggingSelectedUserMeta.completenessWindow.scope, 'user');
    assert.equal(laggingSelectedUserMeta.completenessWindow.startMs, unifiedStartMs);
    assert.equal(laggingSelectedUserMeta.completenessWindow.endMs, requestedEndMs - 60_000);
    assert.equal(laggingSelectedUserMeta.completenessWindow.complete, false);

    saveCompletenessSourceState({
      source: 'twitter',
      requestedStartMs: configuredStartMs,
      provenStartMs: configuredStartMs - 10_000,
      provenEndMs: requestedEndMs + 60_000,
      status: 'complete',
      failureCount: 0,
      lastSuccessAt: requestedEndMs + 60_000,
      lastFailureAt: null,
      blockedReason: null,
      checkpointJson: '{"cursor":"twitter"}',
    });

    const selectedUserMeta = readFeedViewMeta({
      userId: user.id,
      endMs: requestedEndMs,
    });

    assert.equal(selectedUserMeta.completenessWindow.scope, 'user');
    assert.equal(selectedUserMeta.completenessWindow.startMs, unifiedStartMs);
    assert.equal(selectedUserMeta.completenessWindow.endMs, requestedEndMs);
    assert.equal(selectedUserMeta.completenessWindow.complete, true);

    saveCompletenessSourceState({
      source: 'telegram-channel',
      requestedStartMs: configuredStartMs,
      provenStartMs: configuredStartMs - 30_000,
      provenEndMs: null,
      status: 'complete',
      failureCount: 0,
      lastSuccessAt: requestedEndMs,
      lastFailureAt: null,
      blockedReason: null,
      checkpointJson: '{"cursor":"channel"}',
    });

    const missingRightEdgeProofMeta = readFeedViewMeta({
      endMs: requestedEndMs,
    });

    assert.equal(missingRightEdgeProofMeta.completenessWindow.startMs, unifiedStartMs);
    assert.equal(missingRightEdgeProofMeta.completenessWindow.endMs, null);
    assert.equal(missingRightEdgeProofMeta.completenessWindow.complete, false);

    console.log('feed view meta tests: ok');
  } finally {
    if (previousDbPath === undefined) {
      delete process.env.PILIPILI_DB_PATH;
    } else {
      process.env.PILIPILI_DB_PATH = previousDbPath;
    }

    if (previousDataDir === undefined) {
      delete process.env.PILIPILI_DATA_DIR;
    } else {
      process.env.PILIPILI_DATA_DIR = previousDataDir;
    }

    rmSync(tempDir, { recursive: true, force: true });
  }
}

void run().catch((error) => {
  console.error(error);
  process.exit(1);
});
