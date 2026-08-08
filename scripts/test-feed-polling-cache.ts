import assert from 'node:assert/strict';

import type { Activity, User } from '../types';
import { captureGlobalFeedCache, restoreGlobalFeedCache } from '../hooks/feedPollingCache';

const user = { id: 'u1', name: 'Finn' } as User;
const activity = { id: 'a1', timestamp: 123 } as Activity;
const feed = [{ user, activity }];
const latestActivityAtByUser = new Map([['u1', 123]]);
const userActivities = new Map([['u1', [activity]]]);

const cache = captureGlobalFeedCache({
  feed,
  nextCursor: 'cursor-1',
  hasMore: true,
  historyComplete: false,
  localQualifiedCount: 1,
  activityBreakdown: null,
  completenessWindow: null,
  summary: null,
  diagnostics: [],
  prewarmLabel: '预热中',
  latestActivityAtByUser,
  userActivities,
  revision: 'rev-1',
});

assert.notEqual(cache.feed, feed);
assert.notEqual(cache.latestActivityAtByUser, latestActivityAtByUser);
assert.notEqual(cache.userActivities, userActivities);
assert.deepEqual(cache.feed, feed);
assert.deepEqual([...cache.latestActivityAtByUser], [['u1', 123]]);
assert.equal(cache.nextCursor, 'cursor-1');
assert.equal(cache.revision, 'rev-1');

const action = restoreGlobalFeedCache(cache);
assert.equal(action.type, 'apply_success');
if (action.type === 'apply_success') {
  assert.deepEqual(action.feed, feed);
  assert.deepEqual([...action.latestActivityAtByUser!], [['u1', 123]]);
  assert.equal(action.hasMore, true);
  assert.equal(action.historyComplete, false);
  assert.equal(action.localQualifiedCount, 1);
  assert.equal(action.prewarmLabel, '预热中');
  assert.equal(action.clearLoading, true);
}

console.log('feed polling cache tests: ok');
