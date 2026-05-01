import assert from 'node:assert/strict';

import { buildActivityCardViewModel } from '@/lib/activityCardViewModel';
import type { Activity, User } from '@/types';

function makeUser(): User {
  return {
    id: 'u1',
    name: 'CryptoD',
    handle: 'cryptod',
    avatar: '',
    addresses: [{ address: 'TrackedWallet111', name: 'main', chain: 'solana', totalAssetUsd: null, assetUpdatedAt: null }],
    totalAssetUsd: 0,
    historicalMaxAssetUsd: 0,
    assetUpdatedAt: null,
    tags: [],
  };
}

function makeTransfer(metadata: Partial<Activity['metadata']>): Activity {
  return {
    id: 'activity-1',
    userId: 'u1',
    source: 'blockchain',
    type: 'transfer',
    content: 'transfer',
    title: 'transfer',
    timestamp: 1_700_000_000_000,
    metadata,
  };
}

function run() {
  const user = makeUser();

  const trade = buildActivityCardViewModel({
    activity: makeTransfer({
      chain: 'solana',
      txHash: 'SwapTx111',
      token: 'OGRECOIN',
      tokenAddress: 'OgreMint111',
      value: '1200',
      quoteToken: 'SOL',
      quoteAmount: '0.762',
      txActionVariant: 'close',
      displayActionVariantLabel: '清仓',
      trackedAddress: 'TrackedWallet111',
      fromAddress: 'TrackedWallet111',
      tradeAmountUsdAtTx: 115.5,
      marketCapAtTxUsd: 2_500_000,
    }),
    user,
    tradeValueDisplayMode: 'usd',
    resolvedTokenInfo: { marketCapUsd: null, marketCapAtTxUsd: null, marketCapAtTxEstimated: false, source: null },
  });

  assert.equal(trade.isTradeAction, true, 'trade variants should be treated as trade cards');
  assert.equal(trade.displayActionVariantLabel, '清仓');
  assert.equal(trade.displayTradeHeadlineText, '$115.5', 'USD mode should use transaction USD value');
  assert.equal(trade.shouldUseOutgoingAmountTone, true, 'close/reduce actions should use outgoing tone');
  assert.equal(trade.displayMarketCapText, '$2.5M');
  assert.equal(trade.explorerTxUrl, 'https://web3.okx.com/explorer/solana/tx/SwapTx111');
  assert.equal(trade.tokenGmgnUrl, 'https://gmgn.ai/sol/token/OgreMint111');

  const send = buildActivityCardViewModel({
    activity: makeTransfer({
      chain: 'solana',
      txHash: 'SendTx111',
      token: 'USDC',
      tokenAddress: 'UsdcMint111',
      value: '1000',
      txAction: 'send',
      txActionLabel: '发送',
      trackedAddress: 'TrackedWallet111',
      fromAddress: 'TrackedWallet111',
      toAddress: 'Counterparty111',
    }),
    user,
    tradeValueDisplayMode: 'usd',
    addressAliasMap: new Map([['counterparty111', 'Friend']]),
    activeAddress: 'Counterparty111',
    resolvedTokenInfo: { marketCapUsd: 1_000_000, marketCapAtTxUsd: null, marketCapAtTxEstimated: false, source: null },
  });

  assert.equal(send.isTradeAction, false, 'send transfers should not use trade USD headline');
  assert.equal(send.displayTradeHeadlineText, '1K USDC');
  assert.equal(send.counterpartyAddress, 'Counterparty111');
  assert.equal(send.displayMarketCapText, 'Friend', 'send/receive cards should show counterparty label');
  assert.equal(send.marketCapTooltip, '交易对象: Counterparty111');
  assert.equal(send.isCounterpartyAddressHighlighted, true);
  assert.equal(send.counterpartyGmgnUrl, 'https://gmgn.ai/sol/address/Counterparty111');

  console.log('activity card view model tests: ok');
}

run();
