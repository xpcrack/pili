import assert from 'node:assert/strict';

import {
  isRobinhoodChain,
  isRobinhoodOfficialStockAddress,
  isRobinhoodStockToken,
  isRobinhoodStockTokenName,
  ROBINHOOD_OFFICIAL_STOCK_ADDRESSES,
} from '@/lib/robinhoodStockTokens';
import { normalizeGmgnActivityItems } from '@/lib/server/gmgnWalletActivity';

function testNameAndAddressMatchers() {
  assert.equal(isRobinhoodChain('robinhood'), true);
  assert.equal(isRobinhoodChain('rh'), true);
  assert.equal(isRobinhoodChain('base'), false);

  assert.equal(isRobinhoodStockTokenName('NVIDIA • Robinhood Token'), true);
  assert.equal(isRobinhoodStockTokenName('GameStop • Robinhood Token'), true);
  assert.equal(isRobinhoodStockTokenName('GAMESTOP'), false);
  assert.equal(isRobinhoodStockTokenName('Artificial Inu'), false);

  assert.equal(
    isRobinhoodOfficialStockAddress('0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC'),
    true
  );
  assert.equal(
    isRobinhoodOfficialStockAddress('0x2e8c31162b855a2ffa90f6f8634643ad6f111e18'),
    false
  );
  assert.ok(ROBINHOOD_OFFICIAL_STOCK_ADDRESSES.size >= 10);
  console.log('PASS name/address matchers');
}

function testIsRobinhoodStockToken() {
  // Official CA on RH
  assert.equal(
    isRobinhoodStockToken({
      chain: 'robinhood',
      tokenAddress: '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec',
    }),
    true
  );
  // Name match even if CA unknown
  assert.equal(
    isRobinhoodStockToken({
      chain: 'robinhood',
      tokenAddress: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      tokenName: 'Some Co • Robinhood Token',
    }),
    true
  );
  // Meme same ticker, not stock
  assert.equal(
    isRobinhoodStockToken({
      chain: 'robinhood',
      tokenAddress: '0xc32e0a4fd976cb2285c1ba7528aaff9473dd1e18',
      tokenName: 'GAMESTOP',
    }),
    false
  );
  // Other chain never filtered
  assert.equal(
    isRobinhoodStockToken({
      chain: 'base',
      tokenAddress: '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec',
      tokenName: 'NVIDIA • Robinhood Token',
    }),
    false
  );
  console.log('PASS isRobinhoodStockToken');
}

function testGmgnNormalizeDropsStock() {
  const trades = normalizeGmgnActivityItems(
    [
      {
        event_type: 'buy',
        timestamp: 1_700_000_100,
        tx_hash: '0xnvda',
        token: {
          address: '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec',
          symbol: 'NVDA',
          name: 'NVIDIA • Robinhood Token',
        },
        cost_usd: '185',
        price_usd: '208',
      },
      {
        event_type: 'buy',
        timestamp: 1_700_000_110,
        tx_hash: '0xai',
        token: {
          address: '0x2e8c31162b855a2ffa90f6f8634643ad6f111e18',
          symbol: 'AI',
          name: 'Artificial Inu',
        },
        cost_usd: '182',
        price_usd: '0.00001',
      },
      {
        // name-only stock (CA not in denylist) still dropped
        event_type: 'sell',
        timestamp: 1_700_000_120,
        tx_hash: '0xnewstock',
        token: {
          address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          symbol: 'XYZ',
          name: 'Acme Corp • Robinhood Token',
        },
        cost_usd: '50',
      },
    ],
    { wallet: '0xwallet', chain: 'robinhood', after_ts: 1_700_000_000 }
  );

  assert.equal(trades.length, 1);
  assert.equal(trades[0].tokenSymbol, 'AI');
  assert.equal(trades[0].txHash, '0xai');
  console.log('PASS gmgn normalize drops RH stock');
}

function main() {
  testNameAndAddressMatchers();
  testIsRobinhoodStockToken();
  testGmgnNormalizeDropsStock();
  console.log('ALL PASS robinhood-stock-filter');
}

main();
