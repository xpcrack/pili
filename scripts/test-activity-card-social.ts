import assert from 'node:assert/strict';

import * as activityCardSocial from '@/lib/activityCardSocial';
import {
  cleanTwitterDisplayText,
  collapseActivityCardText,
  getActivityCardTypeLabel,
  getFomoCardFullBodyText,
  getTelegramCardPrimaryText,
  usesSocialBodyLayout,
} from '@/lib/activityCardSocial';
import type { Activity } from '@/types';

type FeedSourceColorResolver = (activity: Pick<Activity, 'source' | 'metadata'>) => string;

function getFeedSourceColorForTest() {
  const candidate = (activityCardSocial as Record<string, unknown>).getFeedSourceColor;
  assert.equal(typeof candidate, 'function', 'getFeedSourceColor should be exported');
  return candidate as FeedSourceColorResolver;
}

function run() {
  const makeActivity = (source: Activity['source'], chain?: string): Pick<Activity, 'source' | 'metadata'> => ({
    source,
    metadata: chain === undefined ? {} : { chain },
  });
  const getFeedSourceColor = getFeedSourceColorForTest();

  assert.equal(getFeedSourceColor(makeActivity('blockchain', 'solana')), '#9945FF');
  assert.equal(getFeedSourceColor(makeActivity('blockchain', 'ethereum')), '#627EEA');
  assert.equal(getFeedSourceColor(makeActivity('blockchain', 'bsc')), '#F3BA2F');
  assert.equal(getFeedSourceColor(makeActivity('blockchain', 'base')), '#0052FF');
  assert.equal(getFeedSourceColor(makeActivity('blockchain', 'robinhood')), '#CCFF00');
  assert.equal(getFeedSourceColor(makeActivity('blockchain', 'SOL')), '#9945FF');
  assert.equal(getFeedSourceColor(makeActivity('twitter')), '#1D9BF0');
  assert.equal(getFeedSourceColor(makeActivity('telegram')), '#1D9BF0');
  assert.equal(getFeedSourceColor(makeActivity('blockchain', 'unknown')), '#71717A');
  assert.equal(getFeedSourceColor(makeActivity('blockchain')), '#71717A');

  assert.equal(usesSocialBodyLayout('telegram'), true, 'telegram cards should use the social body layout');
  assert.equal(usesSocialBodyLayout('twitter'), true, 'twitter cards should use the social body layout');
  assert.equal(usesSocialBodyLayout('blockchain'), false, 'blockchain cards should keep the existing layout');

  assert.equal(
    getActivityCardTypeLabel({
      source: 'telegram',
      activityType: 'post',
      twitterKindLabel: null,
    }),
    'TG',
    'telegram cards should show TG in the meta label'
  );

  assert.equal(
    getTelegramCardPrimaryText('主网今天需要留意的两个ca\n\nlife\n0x123'),
    '主网今天需要留意的两个ca\nlife\n0x123',
    'telegram body text should collapse empty lines and render the post body directly'
  );

  assert.equal(getTelegramCardPrimaryText('   '), '(empty)', 'empty telegram posts should keep the empty placeholder');

  assert.equal(
    collapseActivityCardText('A\r\n\r\nB'),
    'A\nB',
    'social body copy should normalize line endings and collapse blank lines'
  );

  assert.equal(
    cleanTwitterDisplayText('DRAM is now live. 20x leverage, 24/7, 365. https://t.co/4671GVIP0h'),
    'DRAM is now live. 20x leverage, 24/7, 365.',
    'twitter card text should hide inline urls while preserving the surrounding sentence'
  );

  assert.equal(
    cleanTwitterDisplayText('https://t.co/MU3UISkJ0r'),
    '',
    'twitter card text should hide url-only quote stubs'
  );

  const fomoSample = {
    content: '@tendersalt 喊单$TikTok：Slowly but surely this pumpfun update meta is getting some interest.',
    metadata: {
      rawText:
        '**$TikTok thesis** **Tendychallenge** (@TendersAlt)\n\nSlowly but surely this pumpfun update meta is getting some interest.\n\nImo the most interesting, and the one with the biggest snowball possibility is tiktok.\n\nImagine when tiktok goat traders have a real power on tiktok coins and are able to push the good ones who are paired with tiktok\n\nI\'m in love with this thesis\n这个pumpfun更新元数据正逐渐引起关注。\nPosition: **$18,557.81**\nUnrealized PnL: **-$4,577.88 (-19.79%)**\nMarket cap: **$846.11K**\nSolana: `64oAuE88tNP7KsSyaiJTKGP4sWmLMFGWLUs9eBTLYgCp`\ngmgn · fomo',
    },
  } as unknown as Parameters<typeof getFomoCardFullBodyText>[0];
  const fomoBody = getFomoCardFullBodyText(fomoSample);
  assert.ok(
    fomoBody.includes('snowball possibility is tiktok'),
    'fomo body should keep the full thesis text from rawText'
  );
  assert.ok(!fomoBody.includes('**'), 'fomo body should strip markdown bold asterisks');
  assert.ok(!/gmgn\s*·\s*fomo/i.test(fomoBody), 'fomo body should drop the trailing gmgn signature line');
  assert.ok(fomoBody.includes('Position: $18,557.81'), 'fomo body should keep position lines without bold markers');

  const fomoFallback = getFomoCardFullBodyText({
    content: 'fallback content',
    metadata: {},
  } as unknown as Parameters<typeof getFomoCardFullBodyText>[0]);
  assert.equal(fomoFallback, 'fallback content', 'fomo body should fall back to content when rawText is missing');

  console.log('activity card social tests: ok');
}

run();
