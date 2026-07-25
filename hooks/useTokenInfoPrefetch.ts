'use client';

import { useEffect } from 'react';
import type { Activity } from '@/types';
import { prefetchTokenInfo, type TokenInfoRequest } from '@/lib/tokenInfoCache';

/**
 * 在 feed 变化时批量预取 token logo / 市值，
 * 避免 ActivityCard 各自打 /api/token-logo（首屏 400 请求）。
 */
export function useTokenInfoPrefetch(
  items: Array<{ activity: Activity }>
) {
  useEffect(() => {
    const requests: TokenInfoRequest[] = [];
    for (const { activity } of items) {
      if (activity.source !== 'blockchain' || activity.type !== 'transfer') continue;
      const chain = activity.metadata.chain || '';
      const tokenAddress =
        activity.metadata.displayTokenAvatarTokenAddress || activity.metadata.tokenAddress || '';
      if (!chain || !tokenAddress) continue;
      requests.push({
        chain,
        tokenAddress,
        tokenSymbol: activity.metadata.token || '',
        txTimestampMs: activity.timestamp,
        txHash: activity.metadata.txHash || '',
      });
    }
    if (requests.length === 0) return;
    void prefetchTokenInfo(requests);
  }, [items]);
}
