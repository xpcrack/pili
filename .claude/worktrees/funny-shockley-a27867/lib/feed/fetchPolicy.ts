export type FeedSyncStrategy = 'refresh' | 'local' | 'backfill';

export function resolveFeedSyncStrategy(explicitStrategy?: FeedSyncStrategy): FeedSyncStrategy {
  return explicitStrategy ?? 'local';
}
