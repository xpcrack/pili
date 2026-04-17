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
    titleIncludes: string;
    contentIncludes: string;
    uncertainFrom: boolean;
    detailFetches?: number;
    feedCount?: number;
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
      titleIncludes: '买入资产',
      contentIncludes: '买入 1200 MOON，花费 0.75 BNB',
      uncertainFrom: false,
      feedCount: 1,
      detailFetches: 0,
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
      titleIncludes: '卖出资产',
      contentIncludes: '卖出 800 MOON，获得 0.5 BNB',
      uncertainFrom: false,
      feedCount: 1,
      detailFetches: 0,
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
      titleIncludes: '买入资产',
      contentIncludes: '买入 400 OMEGA，花费 0.2 BNB',
      uncertainFrom: true,
      feedCount: 1,
      detailFetches: 1,
    },
  },
  {
    name: 'suspicious-receive-visible',
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
      feedCount: 1,
      detailFetches: 1,
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
