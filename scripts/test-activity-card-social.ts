import assert from 'node:assert/strict';

import {
  collapseActivityCardText,
  getActivityCardTypeLabel,
  getTelegramCardPrimaryText,
  usesSocialBodyLayout,
} from '@/lib/activityCardSocial';

function run() {
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

  console.log('activity card social tests: ok');
}

run();
