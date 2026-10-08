import assert from 'node:assert/strict';
import './server-only-shim.cjs';

import {
  parseFomoTradePostFields,
  stripTelegramMarkdown,
} from '../lib/server/fomoTradePostParsing';

const BUY_SOL = `**$HOOKED**** buy** **0xLeaf🍃** (@3ethtomoon)

Bought: **$5,000.00**
Position: **$78,199.68**
Average cost: **$0.0092868**
Return: **0.00%**
Swaps: 10
Market cap: **$9.03M**
Solana: \`C1mBfBoDkwWfd6uTFZp62ARHLjeVp3bDpCDMfMZtPngE\`
gmgn · fomo`;

const SELL_ETH = `**$ZC**** sell** **Tendychallenge** (@TendersAlt)

Proceeds: **$3,161.23**
Remaining position: **-$0.00**
Realized PnL: **$4,085.15 (+16.36%)**
Market cap: **$17.03M**
Ethereum: \`0x4e67db19044549ff420860834c91b45bad298722\`
gmgn · fomo`;

const BUY_BSC_CN = `**$龙虾 buy** **MIRRO🔶 BNB** (@Mirro7777)

Bought: **$10,000.00**
Position: **$9,985.00**
Average cost: **$0.0559**
Return: **0.00%**
Swaps: 1
Market cap: **$55.89M**
BSC: \`0xeccbb861c0dda7efd964010085488b69317e4444\`
gmgn · fomo`;

async function run() {
  // strip
  assert.equal(stripTelegramMarkdown('**$9.03M**'), '$9.03M');
  assert.equal(stripTelegramMarkdown('`0xabc`'), '0xabc');

  const buy = parseFomoTradePostFields(BUY_SOL);
  assert.ok(buy, 'buy post should parse');
  assert.equal(buy!.tokenSymbol, 'HOOKED');
  assert.equal(buy!.tokenAddress, 'C1mBfBoDkwWfd6uTFZp62ARHLjeVp3bDpCDMfMZtPngE');
  assert.equal(buy!.chain, 'solana');
  assert.equal(buy!.tradeAction, 'buy');
  assert.equal(buy!.tradeAmountUsd, 5000);
  assert.equal(buy!.marketCapUsd, 9_030_000);

  const sell = parseFomoTradePostFields(SELL_ETH);
  assert.ok(sell, 'sell post should parse');
  assert.equal(sell!.tokenSymbol, 'ZC');
  assert.equal(sell!.chain, 'ethereum');
  assert.equal(sell!.tradeAction, 'sell');
  assert.equal(sell!.tradeAmountUsd, 3161.23);
  assert.equal(sell!.marketCapUsd, 17_030_000);

  const bsc = parseFomoTradePostFields(BUY_BSC_CN);
  assert.ok(bsc, 'bsc post should parse');
  assert.equal(bsc!.tokenSymbol, '龙虾');
  assert.equal(bsc!.chain, 'bsc');
  assert.equal(bsc!.tradeAmountUsd, 10_000);
  assert.equal(bsc!.marketCapUsd, 55_890_000);

  // thesis 帖 / 普通帖不误判
  assert.equal(parseFomoTradePostFields('**$memestock thesis** some view'), null);
  assert.equal(parseFomoTradePostFields('[yry]\n🟢 Buy more ETH\nToken: 1 [TSMI]'), null);
  assert.equal(parseFomoTradePostFields(''), null);
  assert.equal(parseFomoTradePostFields(null), null);

  // extractRawMcapText（经由 buildTradeDisplayMetadata 间接验证）— 剥星号回归
  const { buildTradeDisplayMetadata } = await import('../lib/tradeDisplay');
  const display = buildTradeDisplayMetadata({
    rawText: 'Market cap: **$9.03M**',
    tokenSymbol: 'HOOKED',
    marketCapUsd: null,
  });
  assert.equal(display.displayMarketCapText, '$9.03M', 'displayMarketCapText must strip markdown bold');

  console.log('OK fomo-trade-post-parsing');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
