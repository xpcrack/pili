'use client';

import { useEffect, type MutableRefObject } from 'react';
import { User, Activity } from '@/types';
import {
  buildFeedDebugEntries,
  filterPoisonFromFeed,
  type FeedDebugEntry,
} from '@/lib/feed/feedPoisonFilter';

type FeedItem = { user: User; activity: Activity };

export function useFeedDebugBridge(feedRef: MutableRefObject<FeedItem[]>) {
  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const target = window as Window & {
      __feedDebug?: {
        findTx: (txHash: string) => {
          raw: FeedDebugEntry[];
          visibleAfterFilter: boolean;
          filtered: FeedDebugEntry[];
        };
      };
    };

    target.__feedDebug = {
      findTx: (txHash: string) => {
        const rawEntries = buildFeedDebugEntries(feedRef.current, txHash);
        const filteredFeed = filterPoisonFromFeed(feedRef.current);
        const filteredEntries = buildFeedDebugEntries(filteredFeed, txHash);
        return {
          raw: rawEntries,
          visibleAfterFilter: filteredEntries.length > 0,
          filtered: filteredEntries,
        };
      },
    };

    return () => {
      delete target.__feedDebug;
    };
  }, [feedRef]);
}
