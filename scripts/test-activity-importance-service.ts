import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Activity, User } from '@/types';

import './server-only-shim.cjs';

function makeUser(id: string, historicalMaxAssetUsd: number): User {
  return {
    id,
    name: id,
    handle: id,
    avatar: '',
    addresses: [{ address: `${id}-wallet`, name: '#1', chain: 'solana', totalAssetUsd: null, assetUpdatedAt: null }],
    totalAssetUsd: historicalMaxAssetUsd,
    historicalMaxAssetUsd,
    assetUpdatedAt: null,
    tags: [],
  };
}

function makeActivity(id: string, userId: string, timestamp: number, source: Activity['source']): Activity {
  return {
    id,
    userId,
    source,
    type: source === 'blockchain' ? 'transfer' : 'post',
    title: id,
    content: id,
    timestamp,
    metadata:
      source === 'blockchain'
        ? {
            txHash: `${id}-tx`,
            chain: 'solana',
            trackedAddress: `${userId}-wallet`,
            txAction: 'buy',
            token: 'TEST',
            value: '1',
          }
        : {
            tweetId: `${id}-tweet`,
          },
  };
}

async function run() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pilipili-importance-service-'));
  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');

  try {
    const { upsertEventsFromFeedRows } = await import('@/lib/server/eventsRepo');
    const {
      scoreFeedRowsAgainstDatabase,
      scoreFeedRowsChronologically,
    } = await import('@/lib/server/activityImportanceService');

    const quiet = makeUser('quiet', 100_000);
    const noisy = makeUser('noisy', 100_000);
    const base = 1_700_000_000_000;

    upsertEventsFromFeedRows([{ user: quiet, activity: makeActivity('quiet-social-old', quiet.id, base - 6 * 24 * 60 * 60 * 1000, 'twitter') }], 'seed');
    upsertEventsFromFeedRows([{ user: noisy, activity: makeActivity('noisy-social-old', noisy.id, base - 6 * 24 * 60 * 60 * 1000, 'twitter') }], 'seed');
    upsertEventsFromFeedRows([{ user: noisy, activity: makeActivity('noisy-chain-1', noisy.id, base - 10_000, 'blockchain') }], 'seed');
    upsertEventsFromFeedRows([{ user: noisy, activity: makeActivity('noisy-chain-2', noisy.id, base - 9_000, 'blockchain') }], 'seed');
    upsertEventsFromFeedRows([{ user: noisy, activity: makeActivity('noisy-chain-3', noisy.id, base - 8_000, 'blockchain') }], 'seed');

    const [quietTweet] = scoreFeedRowsAgainstDatabase([
      { user: quiet, activity: makeActivity('quiet-new-social', quiet.id, base, 'twitter') },
    ]);
    const [noisyTweet] = scoreFeedRowsAgainstDatabase([
      { user: noisy, activity: makeActivity('noisy-new-social', noisy.id, base, 'twitter') },
    ]);

    assert.ok(quietTweet.activity.metadata.importance, 'quiet tweet should receive importance');
    assert.ok(noisyTweet.activity.metadata.importance, 'noisy tweet should receive importance');
    assert.equal(quietTweet.activity.metadata.importance?.socialCount7d, 1);
    assert.equal(noisyTweet.activity.metadata.importance?.socialCount7d, 1);
    assert.equal(noisyTweet.activity.metadata.importance?.walletCount7d, 3);
    assert.ok(
      (quietTweet.activity.metadata.importance?.score || 0) > (noisyTweet.activity.metadata.importance?.score || 0),
      'same social frequency but higher wallet activity should reduce the social score'
    );

    const chronological = scoreFeedRowsChronologically([
      { user: quiet, activity: makeActivity('batch-1', quiet.id, base + 1_000, 'twitter'), stableId: 'batch-1' },
      { user: quiet, activity: makeActivity('batch-2', quiet.id, base + 2_000, 'twitter'), stableId: 'batch-2' },
      { user: quiet, activity: makeActivity('batch-3', quiet.id, base + 3_000, 'blockchain'), stableId: 'batch-3' },
    ]);
    assert.equal(chronological[0]?.activity.metadata.importance?.sourceCount7d, 0);
    assert.equal(chronological[1]?.activity.metadata.importance?.sourceCount7d, 1);
    assert.equal(chronological[2]?.activity.metadata.importance?.walletCount7d, 0);

    const descending = scoreFeedRowsChronologically([
      { user: quiet, activity: makeActivity('desc-3', quiet.id, base + 33_000, 'twitter') },
      { user: quiet, activity: makeActivity('desc-2', quiet.id, base + 32_000, 'twitter') },
      { user: quiet, activity: makeActivity('desc-1', quiet.id, base + 31_000, 'twitter') },
    ]);
    assert.deepEqual(
      descending.map((row) => row.activity.id),
      ['desc-1', 'desc-2', 'desc-3'],
      'chronological scoring should always process oldest to newest'
    );
    assert.equal(descending[0]?.activity.metadata.importance?.sourceCount7d, 0);
    assert.equal(descending[1]?.activity.metadata.importance?.sourceCount7d, 1);
    assert.equal(descending[2]?.activity.metadata.importance?.sourceCount7d, 2);

    const equalTimestamp = scoreFeedRowsChronologically([
      {
        user: quiet,
        activity: makeActivity('same-ts-b', quiet.id, base + 40_000, 'twitter'),
        stableId: 'stable-b',
      },
      {
        user: quiet,
        activity: makeActivity('same-ts-a', quiet.id, base + 40_000, 'twitter'),
        stableId: 'stable-a',
      },
    ]);
    assert.deepEqual(
      equalTimestamp.map((row) => row.activity.id),
      ['same-ts-a', 'same-ts-b'],
      'rows with equal timestamps should be stably ordered by stableId'
    );

    upsertEventsFromFeedRows(
      [{ user: quiet, activity: makeActivity('overlap-seeded', quiet.id, base + 50_000, 'twitter') }],
      'seed'
    );
    const overlap = scoreFeedRowsAgainstDatabase([
      { user: quiet, activity: makeActivity('overlap-seeded', quiet.id, base + 50_000, 'twitter') },
      { user: quiet, activity: makeActivity('overlap-fresh', quiet.id, base + 51_000, 'twitter') },
    ]);
    assert.equal(
      overlap[1]?.activity.metadata.importance?.socialCount7d,
      2,
      'persisted overlap rows should not be double-counted by batch history'
    );

    console.log('activity importance service tests: ok');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

void run();
