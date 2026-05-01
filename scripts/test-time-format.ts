import assert from 'node:assert/strict';

import { formatTradeAmountUsdLabel } from '@/lib/assetFormat';
import {
  getTradeHeadlineDisplayText,
  isTradeDisplayAction,
  normalizeTradeValueDisplayMode,
} from '@/lib/tradeDisplay';
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

  assert.equal(
    formatTradeAmountUsdLabel(12_500),
    '$12.5K',
    'trade USD labels should use compact USD formatting'
  );

  assert.equal(
    formatTradeAmountUsdLabel(null),
    '金额未知',
    'missing trade USD values should show 金额未知'
  );

  assert.deepEqual(
    ['native', 'usd', 'broken'].map((value) => normalizeTradeValueDisplayMode(value)),
    ['native', 'usd', 'native'],
    'invalid persisted trade value display modes should fall back to native'
  );

  assert.equal(
    getTradeHeadlineDisplayText({
      mode: 'native',
      nativeAmountText: '18.28 SOL',
      tradeAmountUsdAtTx: 1620,
    }),
    '18.28 SOL',
    'native mode should keep the quote token amount as the headline'
  );

  assert.equal(
    getTradeHeadlineDisplayText({
      mode: 'usd',
      nativeAmountText: '18.28 SOL',
      tradeAmountUsdAtTx: 1620,
    }),
    '$1.62K',
    'usd mode should use the compact USD amount as the headline'
  );

  assert.equal(
    getTradeHeadlineDisplayText({
      mode: 'usd',
      nativeAmountText: '18.28 SOL',
      tradeAmountUsdAtTx: null,
    }),
    '金额未知',
    'usd mode should surface unknown trade amounts when usd data is missing'
  );

  assert.equal(
    isTradeDisplayAction({ txActionVariant: 'open' }),
    true,
    'activity cards should treat monitor action variants as trade actions for USD display'
  );

  assert.equal(
    isTradeDisplayAction({ displayActionVariantLabel: '清仓' }),
    true,
    'activity cards should treat monitor display action labels as trade actions for USD display'
  );

  assert.equal(
    isTradeDisplayAction({ txAction: 'send', displayActionVariantLabel: '发送' }),
    false,
    'activity cards should not apply trade USD display to pure sends'
  );

  console.log('time format tests: ok');
}

run();
