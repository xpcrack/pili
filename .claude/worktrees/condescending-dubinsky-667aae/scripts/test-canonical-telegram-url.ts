import assert from 'node:assert/strict';

import { extractTelegramHandleFromUrl, normalizeTelegramUrl } from '../lib/canonical';

function run() {
  assert.equal(normalizeTelegramUrl('https://web.telegram.org/k/#@BWEtradfi'), 'https://t.me/BWEtradfi');
  assert.equal(extractTelegramHandleFromUrl('https://web.telegram.org/k/#@BWEtradfi'), 'BWEtradfi');

  assert.equal(normalizeTelegramUrl('https://web.telegram.org/a/#-1001234567890'), null);

  console.log('canonical telegram url tests: ok');
}

run();
