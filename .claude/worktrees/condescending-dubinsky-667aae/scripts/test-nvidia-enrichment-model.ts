import './server-only-shim.cjs';

import assert from 'node:assert/strict';

import { NvidaQwenEnrichmentModel, isLikelyEnglish } from '../lib/server/nvidiaEnrichmentModel';

const API_KEY = process.env.NVIDIA_API_KEY;

async function main() {
  if (!API_KEY) {
    console.log('SKIP: NVIDIA_API_KEY not set');
    return;
  }

  const model = new NvidaQwenEnrichmentModel({ apiKey: API_KEY });

  // Test 1: English tweet with $BTC and $ETH
  console.log('\n--- Test 1: English tweet with $BTC and $ETH ---');
  const result1 = await model.enrichTweet({
    tweetId: 'test-1',
    text: 'Very bullish on $BTC right now! The halving is coming. But $ETH looks weak, might dump further.',
    mentions: [
      { tokenSymbol: 'BTC', tokenAddress: null, matchSource: 'ticker' as const },
      { tokenSymbol: 'ETH', tokenAddress: null, matchSource: 'ticker' as const },
    ],
  });
  console.log('Result 1:', JSON.stringify(result1, null, 2));
  assert.ok(result1.translationZh, 'Translation should not be null for English tweet');
  assert.ok(
    result1.translationZh.includes('BTC'),
    'Translation should contain BTC',
  );
  const btcSentiment = result1.sentiments.find((s) => s.tokenSymbol === 'BTC');
  const ethSentiment = result1.sentiments.find((s) => s.tokenSymbol === 'ETH');
  assert.ok(btcSentiment, 'Should have sentiment for BTC');
  assert.ok(ethSentiment, 'Should have sentiment for ETH');
  assert.equal(btcSentiment.sentiment, 'positive', 'BTC should be positive');
  assert.equal(ethSentiment.sentiment, 'negative', 'ETH should be negative');
  console.log('PASS Test 1');

  // Test 2: Chinese text — should skip
  console.log('\n--- Test 2: Chinese text (skip) ---');
  const result2 = await model.enrichTweet({
    tweetId: 'test-2',
    text: '今天行情不错，看好比特币',
    mentions: [
      { tokenSymbol: 'BTC', tokenAddress: null, matchSource: 'ticker' as const },
    ],
  });
  console.log('Result 2:', JSON.stringify(result2, null, 2));
  assert.equal(result2.translationZh, null, 'Chinese text should have null translation');
  console.log('PASS Test 2');

  // Test 3: Non-English short text — should skip
  console.log('\n--- Test 3: Non-English short text (skip) ---');
  const result3 = await model.enrichTweet({
    tweetId: 'test-3',
    text: '行情分析',
    mentions: [],
  });
  console.log('Result 3:', JSON.stringify(result3, null, 2));
  assert.equal(result3.translationZh, null, 'Non-English short text should have null translation');
  console.log('PASS Test 3');

  // Extra: isLikelyEnglish unit test
  console.log('\n--- Extra: isLikelyEnglish unit tests ---');
  assert.equal(isLikelyEnglish('Bullish on $BTC'), true);
  assert.equal(isLikelyEnglish('今天行情不错'), false);
  assert.equal(isLikelyEnglish('hi'), false); // only 1 Latin word
  assert.equal(isLikelyEnglish('好 market 分析'), false); // CJK > Latin
  console.log('PASS isLikelyEnglish tests');

  console.log('\nAll tests passed!');
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
