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
      importance: {
        version: 1,
        score: 88,
        sourceKind: 'wallet',
        sourceCount7d: 0,
        socialCount7d: 0,
        walletCount7d: 0,
        totalCount7d: 0,
        historicalMaxAssetUsd: 2_500_000,
        sourceRarity: 1,
        assetWeight: 0.91,
        totalFrequencyFactor: 1,
        dataConfidenceFactor: 1,
      },
    }),
    user,
    tradeValueDisplayMode: 'usd',
    resolvedTokenInfo: { marketCapUsd: null, marketCapAtTxUsd: null, marketCapAtTxEstimated: false, source: null },
  });

  assert.equal(trade.isTradeAction, true, 'trade variants should be treated as trade cards');
  assert.equal(trade.displayActionVariantLabel, '清仓');
  assert.equal(trade.displayTradeHeadlineText, '$115.5', 'USD mode should use transaction USD value');
  assert.equal(trade.shouldUseOutgoingAmountTone, true, 'close/reduce actions should use outgoing tone');
  assert.equal(trade.displayMarketCapText, '2.5M');
  assert.equal(trade.positionDeltaText, '-100%', 'close maps to -100%');
  assert.equal(trade.positionDeltaTone, 'down');
  assert.equal(trade.displayTradeUsdText, '$115.5');
  assert.equal(trade.explorerTxUrl, 'https://web3.okx.com/explorer/solana/tx/SwapTx111');
  assert.equal(trade.tokenGmgnUrl, 'https://gmgn.ai/sol/token/OgreMint111');

  const openTrade = buildActivityCardViewModel({
    activity: makeTransfer({
      chain: 'solana',
      txHash: 'OpenTx111',
      token: 'MOMO',
      tokenAddress: 'MomoMint111',
      value: '100',
      quoteToken: 'SOL',
      quoteAmount: '1.2',
      txActionVariant: 'open',
      displayActionVariantLabel: '建仓',
      trackedAddress: 'TrackedWallet111',
      fromAddress: 'TrackedWallet111',
      tradeAmountUsdAtTx: 180,
    }),
    user,
    tradeValueDisplayMode: 'native',
    resolvedTokenInfo: { marketCapUsd: null, marketCapAtTxUsd: null, marketCapAtTxEstimated: false, source: null },
  });
  assert.equal(openTrade.positionDeltaText, '建仓');
  assert.equal(openTrade.positionDeltaTone, 'up');

  const addTrade = buildActivityCardViewModel({
    activity: makeTransfer({
      chain: 'solana',
      txHash: 'AddTx111',
      token: 'HOOD',
      tokenAddress: 'HoodMint111',
      value: '10',
      quoteToken: 'SOL',
      quoteAmount: '0.5',
      txActionVariant: 'add',
      displayActionVariantLabel: '加仓',
      trackedAddress: 'TrackedWallet111',
      fromAddress: 'TrackedWallet111',
      tradeAmountUsdAtTx: 90,
      positionDeltaRatio: 0.348,
    }),
    user,
    tradeValueDisplayMode: 'native',
    resolvedTokenInfo: { marketCapUsd: null, marketCapAtTxUsd: null, marketCapAtTxEstimated: false, source: null },
  });
  assert.equal(addTrade.positionDeltaText, '+34.8%');
  assert.equal(addTrade.positionDeltaTone, 'up');

  const pendingAdd = buildActivityCardViewModel({
    activity: makeTransfer({
      chain: 'solana',
      txHash: 'AddPending111',
      token: 'HOOD',
      tokenAddress: 'HoodMint111',
      value: '10',
      quoteToken: 'SOL',
      quoteAmount: '0.5',
      txActionVariant: 'add',
      displayActionVariantLabel: '加仓',
      trackedAddress: 'TrackedWallet111',
      fromAddress: 'TrackedWallet111',
      tradeAmountUsdAtTx: 90,
    }),
    user,
    tradeValueDisplayMode: 'native',
    resolvedTokenInfo: { marketCapUsd: null, marketCapAtTxUsd: null, marketCapAtTxEstimated: false, source: null },
  });
  assert.equal(pendingAdd.positionDeltaText, '待补');
  assert.equal(pendingAdd.positionDeltaTone, 'muted');

  const rhTrade = buildActivityCardViewModel({
    activity: makeTransfer({
      chain: 'robinhood',
      txHash: '0xrhTx111',
      token: 'TENDIES',
      tokenAddress: '0x45242320dbb855eea8fd36804c6487e10e97fcf9',
      value: '1000',
      quoteToken: 'ETH',
      quoteAmount: '1',
      txActionVariant: 'add',
      displayActionVariantLabel: '加仓',
      trackedAddress: '0x50f27cdb650879a41fb07038bf2b818845c20e17',
      fromAddress: '0x50f27cdb650879a41fb07038bf2b818845c20e17',
      tradeAmountUsdAtTx: 200,
    }),
    user: {
      ...user,
      addresses: [
        {
          address: '0x50f27cdb650879a41fb07038bf2b818845c20e17',
          name: 'main',
          chain: 'base',
          totalAssetUsd: null,
          assetUpdatedAt: null,
        },
      ],
    },
    tradeValueDisplayMode: 'usd',
    resolvedTokenInfo: { marketCapUsd: null, marketCapAtTxUsd: null, marketCapAtTxEstimated: false, source: null },
  });
  assert.equal(
    rhTrade.tokenGmgnUrl,
    'https://gmgn.ai/robinhood/token/0x45242320dbb855eea8fd36804c6487e10e97fcf9',
    'RH ticker right-click must open gmgn.ai/robinhood/token/...'
  );
  assert.equal(
    rhTrade.trackedAddressGmgnUrl,
    'https://gmgn.ai/robinhood/address/0x50f27cdb650879a41fb07038bf2b818845c20e17'
  );
  assert.equal(
    rhTrade.explorerTxUrl,
    'https://robinhoodchain.blockscout.com/tx/0xrhTx111'
  );

  assert.equal(trade.importanceBadgeText, '88分');
  assert.equal(trade.importanceLevelLabel, '高重要');
  assert.match(trade.importanceTooltip || '', /同源稀缺分/);
  assert.match(trade.importanceTooltip || '', /总频率因子/);

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
    resolvedTokenInfo: { marketCapUsd: 1_000_000, marketCapAtTxUsd: null, marketCapAtTxEstimated: false, source: null },
  });

  assert.equal(send.isTradeAction, false, 'send transfers should not use trade USD headline');
  assert.equal(send.displayTradeHeadlineText, '1K USDC');
  assert.equal(send.counterpartyAddress, 'Counterparty111');
  assert.equal(send.displayMarketCapText, 'Friend', 'send/receive cards should show counterparty label');
  assert.equal(send.marketCapTooltip, '交易对象: Counterparty111');
  assert.equal(send.counterpartyGmgnUrl, 'https://gmgn.ai/sol/address/Counterparty111');

  console.log('activity card view model tests: ok');
}

run();
