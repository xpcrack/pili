import assert from 'node:assert/strict';

import { getTradeHeadlineDisplayText } from '../lib/tradeDisplay';

assert.equal(
  getTradeHeadlineDisplayText({
    mode: 'usd',
    nativeAmountText: '0.063 BNB',
    tradeAmountUsdAtTx: null,
  }),
  '0.063 BNB',
  'USD mode should fall back to the complete XXYY native amount when USD conversion is unavailable'
);

console.log('trade display amount fallback test: ok');
