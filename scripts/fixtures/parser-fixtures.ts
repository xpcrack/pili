import type { OkxTransaction, OkxTransactionDetail } from '@/lib/okx';
import type { ChainType } from '@/types';

export const fixtureAddresses = {
  trackedA: '0x1111111111111111111111111111111111111111',
  trackedB: '0x2222222222222222222222222222222222222222',
  trackedC: '0x3333333333333333333333333333333333333333',
  trackedD: '0x4444444444444444444444444444444444444444',
  router: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  counterparty: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  suspiciousSender: '0xcccccccccccccccccccccccccccccccccccccccc',
  fanoutSender: '0xdddddddddddddddddddddddddddddddddddddddd',
  safeSender: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  usdt: '0x0000000000000000000000000000000000001000',
  moon: '0x0000000000000000000000000000000000002000',
  omega: '0x0000000000000000000000000000000000003000',
  scam: '0x0000000000000000000000000000000000004000',
} as const;

export interface ParserFixtureCase {
  name: string;
  chain: ChainType;
  trackedAddress: string;
  transactions: OkxTransaction[];
  detailByTxHash?: Record<string, OkxTransactionDetail>;
  expected: {
    txAction: 'buy' | 'sell' | 'send' | 'receive';
    token: string;
    value: string;
    quoteToken?: string;
    quoteAmount?: string;
    tradeAmountUsdAtTx?: number | null;
    titleIncludes: string;
    contentIncludes: string;
    uncertainFrom: boolean;
    detailFetches?: number;
    feedCount?: number;
    filterDecision?: 'visible' | 'hidden' | 'pending';
    filterReasonCode?: 'meets_min_usd' | 'below_min_usd' | 'pending_valuation';
    computedUsdValue?: number | null;
  };
}

export interface PoisonFixtureItem {
  txHash: string;
  chain: ChainType;
  trackedAddress: string;
  fromAddress: string;
  toAddress: string;
  token: string;
  tokenAddress: string;
  value: string;
  txAction: 'buy' | 'sell' | 'send' | 'receive';
  uncertainFrom: boolean;
  userId: string;
  userName: string;
}

export interface PoisonFixtureCase {
  name: string;
  items: PoisonFixtureItem[];
  expectedVisibleTxHashes: string[];
}

export const parserFixtureCases: ParserFixtureCase[] = [
  {
    name: 'transfer-send',
    chain: 'bsc',
    trackedAddress: fixtureAddresses.trackedA,
    transactions: [
      {
        txHash: '0xtransfer-send',
        txTime: '1710000000000',
        iType: '2',
        symbol: 'USDT',
        amount: '25',
        tokenContractAddress: fixtureAddresses.usdt,
        from: [{ address: fixtureAddresses.trackedA, amount: '25' }],
        to: [{ address: fixtureAddresses.counterparty, amount: '25' }],
        txStatus: 'success',
      },
    ],
    expected: {
      txAction: 'send',
      token: 'USDT',
      value: '25',
      titleIncludes: '发送转账',
      contentIncludes: '发送 25 USDT',
      uncertainFrom: false,
      feedCount: 1,
      detailFetches: 1,
      filterDecision: 'visible',
      filterReasonCode: 'meets_min_usd',
      computedUsdValue: 25,
    },
  },
  {
    name: 'stable-send-at-threshold-remains-visible',
    chain: 'bsc',
    trackedAddress: fixtureAddresses.trackedA,
    transactions: [
      {
        txHash: '0xstable-threshold',
        txTime: '1710000000500',
        iType: '2',
        symbol: 'USDT',
        amount: '5',
        tokenContractAddress: fixtureAddresses.usdt,
        from: [{ address: fixtureAddresses.trackedA, amount: '5' }],
        to: [{ address: fixtureAddresses.counterparty, amount: '5' }],
        txStatus: 'success',
      },
    ],
    expected: {
      txAction: 'send',
      token: 'USDT',
      value: '5',
      titleIncludes: '发送转账',
      contentIncludes: '发送 5 USDT',
      uncertainFrom: false,
      feedCount: 1,
      detailFetches: 1,
      filterDecision: 'visible',
      filterReasonCode: 'meets_min_usd',
      computedUsdValue: 5,
    },
  },
  {
    name: 'stable-send-below-threshold-is-hidden',
    chain: 'bsc',
    trackedAddress: fixtureAddresses.trackedA,
    transactions: [
      {
        txHash: '0xstable-hidden',
        txTime: '1710000000750',
        iType: '2',
        symbol: 'USDT',
        amount: '4.5',
        tokenContractAddress: fixtureAddresses.usdt,
        from: [{ address: fixtureAddresses.trackedA, amount: '4.5' }],
        to: [{ address: fixtureAddresses.counterparty, amount: '4.5' }],
        txStatus: 'success',
      },
    ],
    expected: {
      txAction: 'send',
      token: 'USDT',
      value: '4.5',
      titleIncludes: '发送转账',
      contentIncludes: '发送 4.5 USDT',
      uncertainFrom: false,
      feedCount: 0,
      detailFetches: 1,
      filterDecision: 'hidden',
      filterReasonCode: 'below_min_usd',
      computedUsdValue: 4.5,
    },
  },
  {
    name: 'grouped-buy',
    chain: 'bsc',
    trackedAddress: fixtureAddresses.trackedA,
    transactions: [
      {
        txHash: '0xgrouped-buy',
        txTime: '1710000001000',
        iType: '1',
        symbol: 'BNB',
        amount: '0.75',
        tokenAddress: '',
        from: [{ address: fixtureAddresses.trackedA, amount: '0.75' }],
        to: [{ address: fixtureAddresses.router, amount: '0.75' }],
        txStatus: 'success',
      },
      {
        txHash: '0xgrouped-buy',
        txTime: '1710000001001',
        iType: '1',
        symbol: 'MOON',
        amount: '1200',
        tokenContractAddress: fixtureAddresses.moon,
        from: [{ address: fixtureAddresses.router, amount: '1200' }],
        to: [{ address: fixtureAddresses.trackedA, amount: '1200' }],
        txStatus: 'success',
      },
    ],
    expected: {
      txAction: 'buy',
      token: 'MOON',
      value: '1200',
      quoteToken: 'BNB',
      quoteAmount: '0.75',
      tradeAmountUsdAtTx: 450,
      titleIncludes: '买入资产',
      contentIncludes: '买入 1200 MOON，花费 0.75 BNB',
      uncertainFrom: false,
      feedCount: 1,
      detailFetches: 0,
      filterDecision: 'visible',
      filterReasonCode: 'meets_min_usd',
    },
  },
  {
    name: 'grouped-sell',
    chain: 'bsc',
    trackedAddress: fixtureAddresses.trackedA,
    transactions: [
      {
        txHash: '0xgrouped-sell',
        txTime: '1710000002000',
        iType: '1',
        symbol: 'MOON',
        amount: '800',
        tokenContractAddress: fixtureAddresses.moon,
        from: [{ address: fixtureAddresses.trackedA, amount: '800' }],
        to: [{ address: fixtureAddresses.router, amount: '800' }],
        txStatus: 'success',
      },
      {
        txHash: '0xgrouped-sell',
        txTime: '1710000002001',
        iType: '1',
        symbol: 'BNB',
        amount: '0.5',
        tokenAddress: '',
        from: [{ address: fixtureAddresses.router, amount: '0.5' }],
        to: [{ address: fixtureAddresses.trackedA, amount: '0.5' }],
        txStatus: 'success',
      },
    ],
    expected: {
      txAction: 'sell',
      token: 'MOON',
      value: '800',
      quoteToken: 'BNB',
      quoteAmount: '0.5',
      tradeAmountUsdAtTx: 300,
      titleIncludes: '卖出资产',
      contentIncludes: '卖出 800 MOON，获得 0.5 BNB',
      uncertainFrom: false,
      feedCount: 1,
      detailFetches: 0,
      filterDecision: 'visible',
      filterReasonCode: 'meets_min_usd',
    },
  },
  {
    name: 'detail-probe-buy',
    chain: 'bsc',
    trackedAddress: fixtureAddresses.trackedA,
    transactions: [
      {
        txHash: '0xdetail-probe-buy',
        txTime: '1710000003000',
        iType: '2',
        symbol: 'OMEGA',
        amount: '400',
        tokenContractAddress: fixtureAddresses.omega,
        from: [{ address: fixtureAddresses.router, amount: '400' }],
        to: [{ address: fixtureAddresses.trackedA, amount: '400' }],
        txStatus: 'success',
      },
    ],
    detailByTxHash: {
      '0xdetail-probe-buy': {
        txHash: '0xdetail-probe-buy',
        txStatus: 'success',
        tokenTransferDetails: [
          {
            from: fixtureAddresses.trackedA,
            to: fixtureAddresses.router,
            symbol: 'BNB',
            amount: '0.2',
          },
          {
            from: fixtureAddresses.router,
            to: fixtureAddresses.trackedA,
            symbol: 'OMEGA',
            tokenContractAddress: fixtureAddresses.omega,
            amount: '400',
          },
        ],
      },
    },
    expected: {
      txAction: 'buy',
      token: 'OMEGA',
      value: '400',
      quoteToken: 'BNB',
      quoteAmount: '0.2',
      tradeAmountUsdAtTx: 120,
      titleIncludes: '买入资产',
      contentIncludes: '买入 400 OMEGA，花费 0.2 BNB',
      uncertainFrom: true,
      feedCount: 1,
      detailFetches: 1,
      filterDecision: 'visible',
      filterReasonCode: 'meets_min_usd',
    },
  },
  {
    name: 'suspicious-receive-pending-valuation',
    chain: 'bsc',
    trackedAddress: fixtureAddresses.trackedA,
    transactions: [
      {
        txHash: '0xsuspicious-receive',
        txTime: '1710000004000',
        iType: '2',
        symbol: 'SCAM',
        amount: '1',
        tokenContractAddress: fixtureAddresses.scam,
        from: [{ address: fixtureAddresses.suspiciousSender, amount: '1' }],
        to: [{ address: fixtureAddresses.trackedA, amount: '1' }],
        txStatus: 'success',
      },
    ],
    expected: {
      txAction: 'receive',
      token: 'SCAM',
      value: '1',
      titleIncludes: '收到转账',
      contentIncludes: '收到 1 SCAM',
      uncertainFrom: true,
      feedCount: 0,
      detailFetches: 1,
      filterDecision: 'pending',
      filterReasonCode: 'pending_valuation',
      computedUsdValue: null,
    },
  },
  {
    name: 'small-native-send-is-hidden',
    chain: 'solana',
    trackedAddress: fixtureAddresses.trackedA,
    transactions: [
      {
        txHash: '0xsmall-native-send',
        txTime: '1710000005000',
        iType: '0',
        symbol: 'SOL',
        amount: '0.01',
        from: [{ address: fixtureAddresses.trackedA, amount: '0.01' }],
        to: [{ address: fixtureAddresses.counterparty, amount: '0.01' }],
        txStatus: 'success',
      },
    ],
    expected: {
      txAction: 'send',
      token: 'SOL',
      value: '0.01',
      titleIncludes: '发送转账',
      contentIncludes: '发送 0.01 SOL',
      uncertainFrom: false,
      feedCount: 0,
      detailFetches: 0,
      filterDecision: 'hidden',
      filterReasonCode: 'below_min_usd',
      computedUsdValue: 1.5,
    },
  },
];

export const poisonFixtureCases: PoisonFixtureCase[] = [
  {
    name: 'single-suspicious-receive-remains-visible',
    items: [
      {
        txHash: '0xsingle-suspicious',
        chain: 'bsc',
        trackedAddress: fixtureAddresses.trackedA,
        fromAddress: fixtureAddresses.suspiciousSender,
        toAddress: fixtureAddresses.trackedA,
        token: 'SCAM',
        tokenAddress: fixtureAddresses.scam,
        value: '1',
        txAction: 'receive',
        uncertainFrom: true,
        userId: 'user-a',
        userName: 'Alpha',
      },
    ],
    expectedVisibleTxHashes: ['0xsingle-suspicious'],
  },
  {
    name: 'fanout-poison-is-quarantined',
    items: [
      {
        txHash: '0xfanout-a',
        chain: 'bsc',
        trackedAddress: fixtureAddresses.trackedA,
        fromAddress: fixtureAddresses.fanoutSender,
        toAddress: fixtureAddresses.trackedA,
        token: 'SCAM',
        tokenAddress: fixtureAddresses.scam,
        value: '1',
        txAction: 'receive',
        uncertainFrom: true,
        userId: 'user-a',
        userName: 'Alpha',
      },
      {
        txHash: '0xfanout-b',
        chain: 'bsc',
        trackedAddress: fixtureAddresses.trackedB,
        fromAddress: fixtureAddresses.fanoutSender,
        toAddress: fixtureAddresses.trackedB,
        token: 'SCAM',
        tokenAddress: fixtureAddresses.scam,
        value: '1',
        txAction: 'receive',
        uncertainFrom: true,
        userId: 'user-b',
        userName: 'Beta',
      },
      {
        txHash: '0xfanout-c',
        chain: 'bsc',
        trackedAddress: fixtureAddresses.trackedC,
        fromAddress: fixtureAddresses.fanoutSender,
        toAddress: fixtureAddresses.trackedC,
        token: 'SCAM',
        tokenAddress: fixtureAddresses.scam,
        value: '1',
        txAction: 'receive',
        uncertainFrom: true,
        userId: 'user-c',
        userName: 'Gamma',
      },
      {
        txHash: '0xsafe-single',
        chain: 'bsc',
        trackedAddress: fixtureAddresses.trackedD,
        fromAddress: fixtureAddresses.safeSender,
        toAddress: fixtureAddresses.trackedD,
        token: 'SCAM',
        tokenAddress: fixtureAddresses.scam,
        value: '1',
        txAction: 'receive',
        uncertainFrom: true,
        userId: 'user-d',
        userName: 'Delta',
      },
    ],
    expectedVisibleTxHashes: ['0xsafe-single'],
  },
];

export interface TelegramMonitorFixtureCase {
  name: string;
  text: string;
  linkCandidates: string[];
  fallbackTimestampMs: number;
  expected: {
    action: 'buy' | 'sell' | 'send' | null;
    actionLabel: '建仓' | '加仓' | '减仓' | '清仓' | '发送' | null;
    actionVariant: 'open' | 'add' | 'reduce' | 'close' | 'send' | null;
    quoteAmount: number | null;
    quoteSymbol: string | null;
    tokenAmount: number | null;
    tokenSymbol: string | null;
    marketCapUsd: number | null;
    chain: string | null;
    tokenAddress: string | null;
    walletGroupLabel: string | null;
    walletAliasLabel: string | null;
    trackedWalletAddress: string | null;
    txHash: string | null;
    tradeAmountUsdAtTx?: number | null;
  };
}

export const telegramMonitorFixtureCases: TelegramMonitorFixtureCase[] = [
  {
    name: 'xxyy-single-label-buy-more-sol',
    text: "[user_b#1]\n🟢 Buy more 0.9901 SOL\nToken: 2307118.34  [SNOW]\nPrice: $0.0{4}371\nMCAP: $37.1K\nPlatform: Pump AMM\nCA: 3ck56U2buNB9bMNjR9Vgfc8MomB4D9rfZ1ZJAvprizZh\n#prizZh",
    linkCandidates: [
      'https://www.xxyy.io/sol/3ck56U2buNB9bMNjR9Vgfc8MomB4D9rfZ1ZJAvprizZh?wallet=5nR5qtq2aYHm2DawQ6hFdFvQ9M7M1f6xk1FQmYhQm9wA&ref=',
    ],
    fallbackTimestampMs: 1713458000000,
    expected: {
      action: 'buy',
      actionLabel: '加仓',
      actionVariant: 'add',
      quoteAmount: 0.9901,
      quoteSymbol: 'SOL',
      tokenAmount: 2307118.34,
      tokenSymbol: 'SNOW',
      marketCapUsd: 37_100,
      chain: 'solana',
      tokenAddress: '3ck56U2buNB9bMNjR9Vgfc8MomB4D9rfZ1ZJAvprizZh',
      walletGroupLabel: null,
      walletAliasLabel: 'user_b#1',
      trackedWalletAddress: '5nR5qtq2aYHm2DawQ6hFdFvQ9M7M1f6xk1FQmYhQm9wA',
      txHash: null,
    },
  },
  {
    name: 'xxyy-single-label-sell-all',
    text: "[金狗挖掘机#1]\n🔴 Sell All 0.4085 BNB\nToken: 56255512.46  [BNB]\nPrice: $0.0{5}459\nMCAP: $4.5K\nPlatform: Four.meme\nCA: 0x9be6ca49cbe612c5b3633c14b672485089f64444\n#f64444",
    linkCandidates: [
      'https://www.xxyy.io/bsc/0x9be6ca49cbe612c5b3633c14b672485089f64444?wallet=0x7a2363a401b2340c7941dd2eeff0196a5078d2e6&ref=',
    ],
    fallbackTimestampMs: 1713457000000,
    expected: {
      action: 'sell',
      actionLabel: '清仓',
      actionVariant: 'close',
      quoteAmount: 0.4085,
      quoteSymbol: 'BNB',
      tokenAmount: 56255512.46,
      tokenSymbol: 'BNB',
      marketCapUsd: 4500,
      chain: 'bsc',
      tokenAddress: '0x9be6ca49cbe612c5b3633c14b672485089f64444',
      walletGroupLabel: null,
      walletAliasLabel: '金狗挖掘机#1',
      trackedWalletAddress: '0x7a2363a401b2340c7941dd2eeff0196a5078d2e6',
      txHash: null,
    },
  },
  {
    name: 'xxyy-bot-to-bot-buy',
    text: `[xp] [user_d#1]\n🟢 New buy 0.1336 BNB\nToken: 23423.53  [共建]\nPrice: $0.0036\nMCAP: $3.6M\nPlatform: Pancake V2\nCA: 0xb2acf3ae051c7f0b0b8de90cbb4ed99312574444\n#574444`,
    linkCandidates: [
      'https://www.xxyy.io/bsc/0xb2acf3ae051c7f0b0b8de90cbb4ed99312574444?wallet=0x1111111111111111111111111111111111111111&ref=',
      'https://bscscan.com/tx/0x51c5fa650a72458b0a476b3ff85cd7a21b9c76bddcc1bb3f5e35504f2d650ca4',
    ],
    fallbackTimestampMs: 1713456000000,
    expected: {
      action: 'buy',
      actionLabel: '建仓',
      actionVariant: 'open',
      quoteAmount: 0.1336,
      quoteSymbol: 'BNB',
      tokenAmount: 23423.53,
      tokenSymbol: '共建',
      marketCapUsd: 3_600_000,
      chain: 'bsc',
      tokenAddress: '0xb2acf3ae051c7f0b0b8de90cbb4ed99312574444',
      walletGroupLabel: 'xp',
      walletAliasLabel: 'user_d#1',
      trackedWalletAddress: '0x1111111111111111111111111111111111111111',
      txHash: '0x51c5fa650a72458b0a476b3ff85cd7a21b9c76bddcc1bb3f5e35504f2d650ca4',
      tradeAmountUsdAtTx: 84.324708,
    },
  },
  {
    name: 'xxyy-send-to-sol',
    text: "[user_b#1]\n📤 Send to\nToken: 120000  [SNOW]\nPrice: $0.0{4}371\nMCAP: $37.1K\nPlatform: Pump AMM\nCA: 3ck56U2buNB9bMNjR9Vgfc8MomB4D9rfZ1ZJAvprizZh\n#prizZh",
    linkCandidates: [
      'https://www.xxyy.io/sol/3ck56U2buNB9bMNjR9Vgfc8MomB4D9rfZ1ZJAvprizZh?wallet=5nR5qtq2aYHm2DawQ6hFdFvQ9M7M1f6xk1FQmYhQm9wA&ref=',
    ],
    fallbackTimestampMs: 1713458600000,
    expected: {
      action: 'send',
      actionLabel: '发送',
      actionVariant: 'send',
      quoteAmount: null,
      quoteSymbol: null,
      tokenAmount: 120000,
      tokenSymbol: 'SNOW',
      marketCapUsd: 37_100,
      chain: 'solana',
      tokenAddress: '3ck56U2buNB9bMNjR9Vgfc8MomB4D9rfZ1ZJAvprizZh',
      walletGroupLabel: null,
      walletAliasLabel: 'user_b#1',
      trackedWalletAddress: '5nR5qtq2aYHm2DawQ6hFdFvQ9M7M1f6xk1FQmYhQm9wA',
      txHash: null,
    },
  },
  {
    name: 'xxyy-eth-buy-more',
    text: "[user_c#1]\n🟢 Buy more 0.59 ETH\nToken: 1695428.83  [ASS]\nPrice: $0.0{4}801\nMCAP: $80.1K\nPlatform: Uniswap V3\nCA: 0x6948396ace3f686efd1fdcd12fb3289d0ea0d20b\n#a0d20b",
    linkCandidates: [
      'https://www.xxyy.io/eth/0x6948396ace3f686efd1fdcd12fb3289d0ea0d20b?wallet=0x1111111111111111111111111111111111111111&ref=',
    ],
    fallbackTimestampMs: 1713459900000,
    expected: {
      action: 'buy',
      actionLabel: '加仓',
      actionVariant: 'add',
      quoteAmount: 0.59,
      quoteSymbol: 'ETH',
      tokenAmount: 1695428.83,
      tokenSymbol: 'ASS',
      marketCapUsd: 80_100,
      chain: 'ethereum',
      tokenAddress: '0x6948396ace3f686efd1fdcd12fb3289d0ea0d20b',
      walletGroupLabel: null,
      walletAliasLabel: 'user_c#1',
      trackedWalletAddress: '0x1111111111111111111111111111111111111111',
      txHash: null,
    },
  },
  {
    name: 'xxyy-eth-sell-part',
    text: "[user_c#1]\n🔴 Sell Part 0.59 ETH\nToken: 1695438.83  [ASS]\nPrice: $0.0{4}801\nMCAP: $80.1K\nPlatform: Uniswap V3\nCA: 0x6948396ace3f686efd1fdcd12fb3289d0ea0d20b\n#a0d20b",
    linkCandidates: [
      'https://www.xxyy.io/eth/0x6948396ace3f686efd1fdcd12fb3289d0ea0d20b?wallet=0x1111111111111111111111111111111111111111&ref=',
    ],
    fallbackTimestampMs: 1713459960000,
    expected: {
      action: 'sell',
      actionLabel: '减仓',
      actionVariant: 'reduce',
      quoteAmount: 0.59,
      quoteSymbol: 'ETH',
      tokenAmount: 1695438.83,
      tokenSymbol: 'ASS',
      marketCapUsd: 80_100,
      chain: 'ethereum',
      tokenAddress: '0x6948396ace3f686efd1fdcd12fb3289d0ea0d20b',
      walletGroupLabel: null,
      walletAliasLabel: 'user_c#1',
      trackedWalletAddress: '0x1111111111111111111111111111111111111111',
      txHash: null,
    },
  },
];
