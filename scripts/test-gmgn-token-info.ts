import assert from 'node:assert/strict';

import './server-only-shim.cjs';

import {
  parseGmgnTokenInfoForTests,
  toGmgnCliChainForTests,
} from '@/lib/server/gmgnTokenInfo';
import { buildGmgnTokenUrl, buildGmgnAddressUrl } from '@/lib/addressBook';

function run() {
  assert.equal(toGmgnCliChainForTests('robinhood'), 'robinhood');
  assert.equal(toGmgnCliChainForTests('rh'), 'robinhood');
  assert.equal(toGmgnCliChainForTests('solana'), 'sol');
  assert.equal(toGmgnCliChainForTests('ethereum'), 'eth');
  assert.equal(toGmgnCliChainForTests('unknown'), null);

  assert.equal(
    buildGmgnTokenUrl('robinhood', '0x45242320dbb855eea8fd36804c6487e10e97fcf9'),
    'https://gmgn.ai/robinhood/token/0x45242320dbb855eea8fd36804c6487e10e97fcf9'
  );
  assert.equal(
    buildGmgnAddressUrl('robinhood', '0x50f27cdb650879a41fb07038bf2b818845c20e17'),
    'https://gmgn.ai/robinhood/address/0x50f27cdb650879a41fb07038bf2b818845c20e17'
  );
  assert.equal(buildGmgnTokenUrl('solana', 'Mint111'), 'https://gmgn.ai/sol/token/Mint111');

  const parsed = parseGmgnTokenInfoForTests(
    JSON.stringify({
      address: '0x45242320dbb855eea8fd36804c6487e10e97fcf9',
      symbol: 'TENDIES',
      name: 'TENDIES',
      logo: 'https://gmgn.ai/external-res/78526595a952fcde4b5e89eec58733fc_v2.webp',
      circulating_supply: '1000000000',
      price: { price: '0.017' },
      liquidity: '1000000',
    })
  );
  assert.ok(parsed);
  assert.equal(parsed?.logoUrl, 'https://gmgn.ai/external-res/78526595a952fcde4b5e89eec58733fc_v2.webp');
  assert.equal(parsed?.symbol, 'TENDIES');
  assert.equal(parsed?.priceUsd, 0.017);
  assert.equal(parsed?.marketCapUsd, 0.017 * 1_000_000_000);
  assert.equal(parsed?.liquidityUsd, 1_000_000);

  const empty = parseGmgnTokenInfoForTests(JSON.stringify({ symbol: 'X' }));
  assert.equal(empty, null, 'payload without logo/price/mc should be null');

  console.log('gmgn token info tests: ok');
}

run();
