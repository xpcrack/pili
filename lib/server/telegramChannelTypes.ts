import 'server-only';

export type TelegramChannelSourceStatus = 'pending' | 'ready' | 'auth_required' | 'unavailable' | 'error';
export type TelegramChannelSourceKind = 'auto' | 'manual';

export interface TelegramChannelSource {
  id: string;
  userId: string;
  channelRef: string;
  channelRefNormalized: string;
  channelTitle: string | null;
  channelUsername: string | null;
  channelChatId: string | null;
  accessHash: string | null;
  sourceKind: TelegramChannelSourceKind;
  enabled: boolean;
  syncStatus: TelegramChannelSourceStatus;
  lastMessageId: number | null;
  lastSyncedAtMs: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface TelegramChannelPost {
  id: number;
  channelChatId: string;
  channelUsername: string | null;
  channelTitle: string | null;
  messageId: number;
  groupedId: string | null;
  postedAtMs: number;
  editDateMs: number | null;
  text: string;
  textEntities: unknown[];
  media: string[];
  linkUrls: string[];
  forwardInfo: Record<string, unknown> | null;
  views: number | null;
  forwards: number | null;
  replies: number | null;
  raw: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface TelegramChannelResolved {
  channelChatId: string;
  channelUsername: string | null;
  channelTitle: string | null;
  accessHash: string | null;
}

export interface TelegramChannelResolveInput {
  channelRef: string;
  channelUsername?: string | null;
  channelChatId?: string | null;
  accessHash?: string | null;
}

export interface TelegramChannelRemoteMessage {
  messageId: number;
  groupedId: string | null;
  postedAtMs: number;
  editDateMs: number | null;
  text: string;
  textEntities: unknown[];
  media: string[];
  linkUrls: string[];
  forwardInfo: Record<string, unknown> | null;
  views: number | null;
  forwards: number | null;
  replies: number | null;
  raw: Record<string, unknown>;
}

export interface TelegramAgentReadItem {
  messageId: number;
  date: number;
  text: string;
  sender: {
    id: string | null;
    username: string | null;
    displayName: string | null;
  } | null;
}

export interface TelegramChannelHistoryPage {
  messages: TelegramChannelRemoteMessage[];
  oldestScannedMessageId: number | null;
  oldestScannedMessageTimeMs: number | null;
  reachedHistoryBoundary: boolean;
  nextBeforeMessageId: number | null;
}

export interface TelegramBridgeHistoryPage {
  messages: import('../../scripts/telegram-bridge-core').TelegramMessageLike[];
  oldestScannedMessageId: number | null;
  oldestScannedMessageTimeMs: number | null;
  reachedHistoryBoundary: boolean;
  nextBeforeMessageId: number | null;
}

export interface TelegramChannelSyncClient {
  resolveChannel(input: TelegramChannelResolveInput): Promise<TelegramChannelResolved>;
  listChannelMessages(params: {
    source: TelegramChannelSource;
    resolved: TelegramChannelResolved;
    minMessageId: number | null;
    limit?: number;
  }): Promise<TelegramChannelRemoteMessage[]>;
  listChannelHistoryPage?(params: {
    source: TelegramChannelSource;
    resolved: TelegramChannelResolved;
    beforeMessageId?: number | null;
    startMs?: number | null;
    endMs?: number | null;
    limit?: number;
  }): Promise<TelegramChannelHistoryPage>;
  listBridgeChatMessages?(params: { chatId: string; limit: number }): Promise<import('../../scripts/telegram-bridge-core').TelegramMessageLike[]>;
  listBridgeChatHistoryPage?(params: {
    chatId: string;
    beforeMessageId?: number | null;
    startMs?: number | null;
    endMs?: number | null;
    limit: number;
  }): Promise<TelegramBridgeHistoryPage>;
  listAgentChatMessages?(params: { chatId: string; limit: number }): Promise<TelegramAgentReadItem[]>;
  searchAgentChatMessages?(params: { chatId: string; query: string; limit: number }): Promise<{
    searchMode: 'telegram' | 'recent-scan';
    items: TelegramAgentReadItem[];
  }>;
  disconnect?(): Promise<void>;
}
