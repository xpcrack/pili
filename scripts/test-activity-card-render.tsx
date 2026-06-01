import assert from 'node:assert/strict';

import { renderToStaticMarkup } from 'react-dom/server';

import { ActivityCard } from '@/components/ActivityCard';
import type { Activity, User } from '@/types';

function makeUser(): User {
  return {
    id: 'user-1',
    name: 'cooker',
    handle: 'cooker',
    avatar: '',
    twitter: 'cookerflips',
    addresses: [],
    totalAssetUsd: 0,
    historicalMaxAssetUsd: 0,
    assetUpdatedAt: null,
    tags: [],
  };
}

function makeQuoteActivity(): Activity {
  return {
    id: 'twitter:2051340798957113505',
    userId: 'user-1',
    source: 'twitter',
    type: 'post',
    title: '引用推文',
    content: '',
    timestamp: 1_777_912_752_000,
    metadata: {
      tweetId: '2051340798957113505',
      tweetUrl: 'https://x.com/cookerflips/status/2051340798957113505',
      tweetKind: 'quote',
      quotedTweetAuthorHandle: 'tradexyz',
      quotedTweetContent: 'DRAM is now live. 20x leverage, 24/7, 365.',
      importance: {
        version: 1,
        score: 49,
        sourceKind: 'social',
        sourceCount7d: 0,
        socialCount7d: 0,
        walletCount7d: 0,
        totalCount7d: 0,
        historicalMaxAssetUsd: 0,
        sourceRarity: 1,
        assetWeight: 0,
        totalFrequencyFactor: 1,
        dataConfidenceFactor: 1,
      },
    },
  };
}

function makeTranslatedTwitterActivity(): Activity {
  return {
    id: 'twitter:translated-1',
    userId: 'user-1',
    source: 'twitter',
    type: 'post',
    title: '发布推文',
    content: 'Bullish on BTC and ETH.',
    timestamp: 1_777_912_752_111,
    metadata: {
      tweetId: 'translated-1',
      tweetUrl: 'https://x.com/cookerflips/status/translated-1',
      tweetKind: 'tweet',
      translationZh: '看好 BTC 和 ETH。',
      translationStatus: 'succeeded',
      mentionedTickers: ['BTC', 'ETH'],
      tokenSentiments: [
        { tokenSymbol: 'BTC', sentiment: 'positive', matchSource: 'ticker' },
        { tokenSymbol: 'ETH', sentiment: 'positive', matchSource: 'ticker' },
      ],
      importance: {
        version: 1,
        score: 42,
        sourceKind: 'social',
        sourceCount7d: 0,
        socialCount7d: 0,
        walletCount7d: 0,
        totalCount7d: 0,
        historicalMaxAssetUsd: 0,
        sourceRarity: 1,
        assetWeight: 0,
        totalFrequencyFactor: 1,
        dataConfidenceFactor: 1,
      },
    },
  };
}

function run() {
  const markup = renderToStaticMarkup(
    <ActivityCard
      activity={makeQuoteActivity()}
      user={makeUser()}
    />
  );

  assert.doesNotMatch(markup, /普通/, 'activity card should no longer render the importance level label');
  assert.doesNotMatch(markup, /https:\/\/t\.co\/MU3UISkJ0r/, 'activity card should not show the quote stub url as正文');
  assert.match(markup, /引用 @tradexyz/, 'activity card should render the quoted author handle');
  assert.match(markup, /DRAM is now live\. 20x leverage, 24\/7, 365\./, 'activity card should render the quoted tweet content');

  const translatedMarkup = renderToStaticMarkup(
    <ActivityCard
      activity={makeTranslatedTwitterActivity()}
      user={makeUser()}
    />
  );

  assert.match(translatedMarkup, /看好 BTC 和 ETH。/, 'activity card should render the translated tweet text');
  assert.doesNotMatch(translatedMarkup, /Original:/, 'activity card should not show the original text when translation exists');

  console.log('activity card render tests: ok');
}

run();
