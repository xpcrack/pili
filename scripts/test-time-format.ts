import assert from 'node:assert/strict';

import {
  formatAbsoluteTimeCompact,
  getRelativeTimeState,
  normalizeFeedTimeDisplayMode,
} from '@/lib/timeFormat';

function run() {
  const minuteMs = 60_000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  const now = 1_700_000_000_000;

  assert.deepEqual(
    getRelativeTimeState(now - 30_000, now),
    {
      label: '刚刚',
      nextUpdateInMs: 30_000,
    },
    'fresh activities should stay at 刚刚 until the one-minute boundary'
  );

  assert.deepEqual(
    getRelativeTimeState(now - 90_000, now),
    {
      label: '1m',
      nextUpdateInMs: 30_000,
    },
    'minute labels should roll over on the next minute boundary'
  );

  assert.deepEqual(
    getRelativeTimeState(now - (2 * hourMs + 5 * minuteMs), now),
    {
      label: '2h',
      nextUpdateInMs: 55 * minuteMs,
    },
    'hour labels should roll over on the next hour boundary'
  );

  assert.deepEqual(
    getRelativeTimeState(now - (3 * dayMs + 2 * hourMs), now),
    {
      label: '3d',
      nextUpdateInMs: 22 * hourMs,
    },
    'day labels should roll over on the next day boundary'
  );

  assert.deepEqual(
    getRelativeTimeState(0, now),
    {
      label: '暂无动态',
      nextUpdateInMs: null,
    },
    'invalid timestamps should not schedule refreshes'
  );

  assert.equal(
    formatAbsoluteTimeCompact(new Date('2026-04-23T14:06:54.000Z').getTime()),
    '04-23 22:06',
    'absolute feed timestamps should use MM-DD HH:mm in local time'
  );

  assert.deepEqual(
    ['relative', 'absolute', 'broken'].map((value) => normalizeFeedTimeDisplayMode(value)),
    ['relative', 'absolute', 'relative'],
    'invalid persisted display modes should fall back to relative'
  );

  console.log('time format tests: ok');
}

run();
