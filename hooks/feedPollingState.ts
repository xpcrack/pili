import type { User, Activity } from '@/types';
import type { ActivityBreakdown, CompletenessWindow } from '@/lib/activitiesApi';
import type { ActivityFeedSummary, AddressDiagnostic } from '@/lib/activityFeed';

export type FeedItem = { user: User; activity: Activity };

export interface FeedPollingState {
  loading: boolean;
  error: string | null;
  feed: FeedItem[];
  userActivities: Map<string, Activity[]>;
  latestActivityAtByUser: Map<string, number>;
  lastUpdate: Date | null;
  summary: ActivityFeedSummary | null;
  diagnostics: AddressDiagnostic[];
  hasMore: boolean;
  historyComplete: boolean | null;
  localQualifiedCount: number;
  activityBreakdown: ActivityBreakdown | null;
  completenessWindow: CompletenessWindow | null;
  prewarmLabel: string | null;
}

export type FeedPollingAction =
  | { type: 'set_loading'; loading: boolean }
  | { type: 'set_error'; error: string | null }
  | { type: 'set_last_update'; lastUpdate: Date | null }
  | { type: 'set_prewarm_label'; prewarmLabel: string | null }
  | { type: 'set_has_more'; hasMore: boolean }
  | {
      type: 'clear_all';
    }
  | {
      type: 'apply_success';
      feed: FeedItem[];
      userActivities: Map<string, Activity[]>;
      /** null = leave latestActivityAtByUser unchanged (append path) */
      latestActivityAtByUser: Map<string, number> | null;
      summary?: ActivityFeedSummary | null;
      diagnostics?: AddressDiagnostic[];
      hasMore?: boolean;
      historyComplete?: boolean | null;
      localQualifiedCount?: number;
      activityBreakdown?: ActivityBreakdown | null;
      completenessWindow?: CompletenessWindow | null;
      prewarmLabel?: string | null;
      /** false for silent/poll background paths that shouldn't flip loading */
      clearLoading: boolean;
    }
  | {
      type: 'apply_error';
      error: string;
      clearLoading: boolean;
    }
  | {
      type: 'touch_ok';
    };

export function createInitialFeedPollingState(params: {
  feed?: FeedItem[];
  latestActivityAtByUser?: Map<string, number>;
  hasMore?: boolean;
  historyComplete?: boolean | null;
  localQualifiedCount?: number;
  activityBreakdown?: ActivityBreakdown | null;
  completenessWindow?: CompletenessWindow | null;
  summary?: ActivityFeedSummary | null;
  diagnostics?: AddressDiagnostic[];
  prewarmLabel?: string | null;
}): FeedPollingState {
  return {
    loading: true,
    error: null,
    feed: params.feed || [],
    userActivities: new Map(),
    latestActivityAtByUser: params.latestActivityAtByUser || new Map(),
    lastUpdate: null,
    summary: params.summary || null,
    diagnostics: params.diagnostics || [],
    hasMore: params.hasMore || false,
    historyComplete: params.historyComplete ?? null,
    localQualifiedCount: params.localQualifiedCount || 0,
    activityBreakdown: params.activityBreakdown || null,
    completenessWindow: params.completenessWindow || null,
    prewarmLabel: params.prewarmLabel || null,
  };
}

export function feedPollingReducer(
  state: FeedPollingState,
  action: FeedPollingAction
): FeedPollingState {
  switch (action.type) {
    case 'set_loading':
      return state.loading === action.loading ? state : { ...state, loading: action.loading };
    case 'set_error':
      return state.error === action.error ? state : { ...state, error: action.error };
    case 'set_last_update':
      return { ...state, lastUpdate: action.lastUpdate };
    case 'set_prewarm_label':
      return state.prewarmLabel === action.prewarmLabel
        ? state
        : { ...state, prewarmLabel: action.prewarmLabel };
    case 'set_has_more':
      return state.hasMore === action.hasMore ? state : { ...state, hasMore: action.hasMore };
    case 'clear_all':
      return {
        ...state,
        feed: [],
        userActivities: new Map(),
        latestActivityAtByUser: new Map(),
        summary: {
          userCount: 0,
          addressCount: 0,
          transactionCount: 0,
          successfulAddressCount: 0,
          failedAddressCount: 0,
          emptyAddressCount: 0,
          completedAt: Date.now(),
        },
        diagnostics: [],
        hasMore: false,
        historyComplete: null,
        localQualifiedCount: 0,
        activityBreakdown: null,
        completenessWindow: null,
        lastUpdate: new Date(),
        error: null,
        loading: false,
      };
    case 'touch_ok':
      // 服务端确认 unchanged：刷新联通时间，清错误。不改 feed。
      return {
        ...state,
        lastUpdate: new Date(),
        error: null,
      };
    case 'apply_error':
      return {
        ...state,
        error: action.error,
        loading: action.clearLoading ? false : state.loading,
      };
    case 'apply_success': {
      return {
        ...state,
        feed: action.feed,
        userActivities: action.userActivities,
        latestActivityAtByUser:
          action.latestActivityAtByUser ?? state.latestActivityAtByUser,
        summary: action.summary !== undefined ? action.summary : state.summary,
        diagnostics: action.diagnostics !== undefined ? action.diagnostics : state.diagnostics,
        hasMore: action.hasMore !== undefined ? action.hasMore : state.hasMore,
        historyComplete:
          action.historyComplete !== undefined ? action.historyComplete : state.historyComplete,
        localQualifiedCount:
          action.localQualifiedCount !== undefined
            ? action.localQualifiedCount
            : state.localQualifiedCount,
        activityBreakdown:
          action.activityBreakdown !== undefined
            ? action.activityBreakdown
            : state.activityBreakdown,
        completenessWindow:
          action.completenessWindow !== undefined
            ? action.completenessWindow
            : state.completenessWindow,
        prewarmLabel:
          action.prewarmLabel !== undefined ? action.prewarmLabel : state.prewarmLabel,
        lastUpdate: new Date(),
        error: null,
        loading: action.clearLoading ? false : state.loading,
      };
    }
    default:
      return state;
  }
}
