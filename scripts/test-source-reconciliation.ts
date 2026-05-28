import assert from 'node:assert/strict';

import { type Activity } from '@/types';
import { buildActivityGlobalDedupKey, buildActivityScopedDedupKey } from '@/lib/activityIdentity';
import {
  chooseConflictWinner,
  detectConflictDomain,
  diffActivityForConflict,
} from '@/lib/server/sourceReconciliation';

function createActivity(source: Activity['source'], value: string): Activity {
  return {
    id: `${source}-activity`,
    userId: 'user-1',
    source,
    type: source === 'twitter' ? 'post' : 'swap',
    content: 'test activity',
    timestamp: 1_700_000_000_000,
    metadata: {
      token: 'ETH',
      tokenAddress: '0xabc',
      value,
      quoteToken: 'USDT',
      quoteAmount: '100',
      txAction: 'buy',
      txActionVariant: 'open',
      displayWalletLabel: 'wallet',
      displayTradeAmountText: '1 ETH',
      displayTokenSymbol: 'ETH',
      displayMarketCapText: '$1B',
    },
  };
}

function run() {
  const left = createActivity('blockchain', '1');
  const right = createActivity('blockchain', '2');
  const diff = diffActivityForConflict(left, right);

  assert.equal(diff.length, 1);
  assert.equal(diff[0]?.field, 'value');
  assert.equal(diff[0]?.left, '1');
  assert.equal(diff[0]?.right, '2');

  assert.equal(chooseConflictWinner('onchain'), 'api');
  assert.equal(chooseConflictWinner('twitter'), 'opencli');

  assert.equal(detectConflictDomain(createActivity('twitter', '1')), 'twitter');
  assert.equal(detectConflictDomain(createActivity('blockchain', '1')), 'onchain');

  {
    const normalizedLeft = createActivity('blockchain', '1');
    normalizedLeft.metadata.tokenAddress = '0xAbC123';
    normalizedLeft.metadata.displayTokenAvatarTokenAddress = '0xABCD';
    normalizedLeft.metadata.quoteAmount = '1';
    normalizedLeft.metadata.token = 'ETH';

    const normalizedRight = createActivity('blockchain', '1.0');
    normalizedRight.metadata.tokenAddress = '0xabc123';
    normalizedRight.metadata.displayTokenAvatarTokenAddress = '0xabcd';
    normalizedRight.metadata.quoteAmount = '1.0';
    normalizedRight.metadata.token = 'eth';
    normalizedRight.metadata.txAction = 'buy';
    (normalizedLeft.metadata as Record<string, unknown>).txAction = 'BUY';

    const normalizedDiff = diffActivityForConflict(normalizedLeft, normalizedRight);
    assert.equal(normalizedDiff.length, 0);
  }

  {
    const multiLeft = createActivity('blockchain', '1');
    const multiRight = createActivity('blockchain', '2');
    multiRight.metadata.quoteToken = 'USDC';
    multiRight.metadata.displayMarketCapText = '$2B';

    const multiDiff = diffActivityForConflict(multiLeft, multiRight);
    assert.equal(multiDiff.length, 3);
    assert.deepEqual(
      multiDiff.map((item) => item.field).sort(),
      ['displayMarketCapText', 'quoteToken', 'value']
    );
  }

  {
    const provisional = createActivity('blockchain', '45188.989541');
    provisional.type = 'transfer';
    provisional.metadata.chain = 'solana';
    provisional.metadata.txHash = '2tLRE1WugGAJquDrSph5XMMySFBBDmnxRgEsKPgr1tRCjqiFmLoT345V3DfkQASSdc3BMUx2brt3xEauGLsQNJsQ';
    provisional.metadata.trackedAddress = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
    provisional.metadata.quoteToken = 'SOL';
    provisional.metadata.quoteAmount = '0.1181';
    provisional.metadata.monitorTxAggregateKey =
      'xxyy-monitor:solana:cj5fhknpf3yd7fknjv5vtbjtndawfirflcutputanpis:2tlre1wuggajqudrsph5xmmysfbbdmnxrgeskpgr1trcjqifmlot345v3dfkqassdc3bmux2brt3xeauglsqnjsq';

    const canonical = createActivity('blockchain', '94464.94413');
    canonical.type = 'transfer';
    canonical.metadata.chain = 'solana';
    canonical.metadata.txHash = provisional.metadata.txHash;
    canonical.metadata.trackedAddress = provisional.metadata.trackedAddress;
    canonical.metadata.quoteToken = 'SOL';
    canonical.metadata.quoteAmount = '0.2502';
    canonical.metadata.monitorTxAggregateKey = provisional.metadata.monitorTxAggregateKey;

    assert.equal(
      buildActivityGlobalDedupKey(provisional),
      buildActivityGlobalDedupKey(canonical),
      'monitor aggregate activities should keep a stable global dedup key across amount corrections'
    );
    assert.equal(
      buildActivityScopedDedupKey(provisional, provisional.userId),
      buildActivityScopedDedupKey(canonical, canonical.userId),
      'monitor aggregate activities should keep a stable scoped dedup key across amount corrections'
    );
  }

  console.log('source reconciliation tests: ok');
}

run();
