import assert from 'node:assert/strict';

import { FeedRequestArbiter } from '@/lib/feed/requestArbiter';

function run() {
  const arbiter = new FeedRequestArbiter();

  const fg1 = arbiter.start('foreground');
  assert.equal(fg1.accepted, true);
  const fgDup = arbiter.start('foreground');
  assert.equal(fgDup.accepted, false);
  assert.equal(fgDup.reason, 'foreground_inflight');
  fg1.finish();

  const bg = arbiter.start('background');
  assert.equal(bg.accepted, true);
  const bgDup = arbiter.start('background');
  assert.equal(bgDup.accepted, false);
  assert.equal(bgDup.reason, 'background_inflight');

  const fg = arbiter.start('foreground');
  assert.equal(fg.accepted, true);
  assert.equal(bg.abortedByPreemption?.(), true);
  assert.equal(bg.signal?.aborted, true);

  const bg2 = arbiter.start('background');
  assert.equal(bg2.accepted, false);
  assert.equal(bg2.reason, 'foreground_inflight');

  bg.finish();
  const bgWhileFgAlive = arbiter.start('background');
  assert.equal(bgWhileFgAlive.accepted, false);
  assert.equal(bgWhileFgAlive.reason, 'foreground_inflight');

  fg.finish();
  const fgNext = arbiter.start('foreground');
  assert.equal(fgNext.accepted, true);
  fgNext.finish();

  console.log('feed request arbiter tests: ok');
}

run();
