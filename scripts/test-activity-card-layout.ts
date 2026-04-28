import assert from 'node:assert/strict';

import { getActivityCardContentColumnClass } from '@/lib/activityCardLayout';

function run() {
  assert.equal(
    getActivityCardContentColumnClass({
      isTransfer: true,
      isBlockchain: true,
      isTwitter: false,
      isTelegram: false,
    }),
    'md:col-start-1 md:col-span-3 md:justify-self-stretch md:pl-1 md:pr-1',
    'transfer cards should span the full row'
  );

  assert.equal(
    getActivityCardContentColumnClass({
      isTransfer: false,
      isBlockchain: true,
      isTwitter: false,
      isTelegram: false,
    }),
    'md:col-start-1 md:col-span-2 md:justify-self-stretch md:pl-1 md:pr-1',
    'blockchain cards should keep body on the left and profile on the right'
  );

  assert.equal(
    getActivityCardContentColumnClass({
      isTransfer: false,
      isBlockchain: false,
      isTwitter: true,
      isTelegram: false,
    }),
    'md:col-start-1 md:col-span-2 md:justify-self-stretch md:pl-1 md:pr-1',
    'twitter cards should keep body on the left and profile on the right'
  );

  assert.equal(
    getActivityCardContentColumnClass({
      isTransfer: false,
      isBlockchain: false,
      isTwitter: false,
      isTelegram: true,
    }),
    'md:col-start-1 md:col-span-2 md:justify-self-stretch md:pl-1 md:pr-1',
    'telegram cards should not share the same grid column as the profile header'
  );

  console.log('activity card layout tests: ok');
}

run();
