import { convertToActivity } from './lib/parsing/toActivity';

async function main() {
  const activity = await convertToActivity({
    group: {
      txHash: '0xabc',
      entries: [
        {
          txHash: '0xabc',
          itype: '2',
          txTime: '1710000000000',
          symbol: 'ABC',
          amount: '10',
          tokenContractAddress: '0xToken',
          from: [{ address: '0xTracked', amount: '10' }],
          to: [{ address: '0xOther', amount: '10' }],
          txStatus: 'success',
        },
        {
          txHash: '0xabc',
          itype: '0',
          txTime: '1710000000000',
          symbol: 'BNB',
          amount: '0.5',
          tokenContractAddress: '',
          from: [{ address: '0xOther', amount: '0.5' }],
          to: [{ address: '0xTracked', amount: '0.5' }],
          txStatus: 'success',
        },
      ],
    },
    user: {
      id: 'u1',
      name: 'Test User',
      handle: 'test',
      avatar: '',
      addresses: [],
      totalAssetUsd: 0,
      historicalMaxAssetUsd: 0,
      assetUpdatedAt: null,
      tags: [],
    },
    addressInfo: {
      address: '0xTracked',
      name: 'Main',
      chain: 'bsc',
      totalAssetUsd: null,
      assetUpdatedAt: null,
    },
    requireTrackedInitiator: true,
  });
  console.log(JSON.stringify({
    title: activity?.title,
    content: activity?.content,
    txAction: activity?.metadata.txAction,
    quoteAmount: activity?.metadata.quoteAmount,
    trackedAddress: activity?.metadata.trackedAddress,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
