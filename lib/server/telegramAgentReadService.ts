import 'server-only';

import { getTelegramAgentGrantByToken, recordTelegramAgentGrantRead } from '@/lib/server/telegramAgentGrantRepo';
import { createTelegramGramjsClient } from '@/lib/server/telegramGramjsClient';
import { classifyTelegramMtprotoError } from '@/lib/server/telegramMtprotoPolicy';
import type { TelegramAgentGrant } from '@/lib/server/telegramAgentGrantRepo';
import type { TelegramAgentReadItem, TelegramChannelSyncClient } from '@/lib/server/telegramChannelTypes';

export type TelegramAgentReadMode = 'tail' | 'search';

export type TelegramAgentReadError =
  | 'invalid_token'
  | 'grant_not_found'
  | 'grant_revoked'
  | 'chat_mismatch'
  | 'scope_denied'
  | 'query_required'
  | 'telegram_auth_unavailable'
  | 'telegram_chat_unavailable';

export type TelegramAgentReadResult =
  | {
      ok: true;
      mode: 'tail';
      chatId: string;
      grant: { agentName: string; scope: string[] };
      items: TelegramAgentReadItem[];
    }
  | {
      ok: true;
      mode: 'search';
      chatId: string;
      query: string;
      searchMode: 'telegram' | 'recent-scan';
      grant: { agentName: string; scope: string[] };
      items: TelegramAgentReadItem[];
    }
  | { ok: false; error: TelegramAgentReadError };

export interface RunTelegramAgentReadInput {
  mode: TelegramAgentReadMode;
  chatId: string;
  token: string;
  query?: string | null;
  limit?: number | null;
  client?: TelegramChannelSyncClient;
}

type TelegramReadFailurePhase = 'create_client' | 'read_chat';

const CHAT_UNAVAILABLE_PATTERN =
  /USERNAME_INVALID|CHANNEL_INVALID|CHANNEL_PRIVATE|INVITE_HASH_INVALID|PEER_ID_INVALID|CHAT_ID_INVALID|CHAT_ADMIN_REQUIRED|INPUT_FETCH_ERROR|PEER|CHANNEL|CHAT/i;
const AUTH_UNAVAILABLE_PATTERN =
  /TELEGRAM_API_ID|TELEGRAM_API_HASH|TELEGRAM_SESSION_STRING|AUTH_KEY_UNREGISTERED|SESSION|AUTHORIZATION|AUTHORIZED|AUTH REQUIRED/i;

function normalizeString(value: string | null | undefined) {
  return (value || '').trim();
}

function clampLimit(mode: TelegramAgentReadMode, limit: number | null | undefined) {
  const fallback = mode === 'tail' ? 50 : 20;
  const maximum = mode === 'tail' ? 200 : 100;
  const candidate = typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : fallback;
  return Math.min(Math.max(candidate, 1), maximum);
}

function mapTelegramReadFailure(
  error: unknown,
  phase: TelegramReadFailurePhase
): 'telegram_auth_unavailable' | 'telegram_chat_unavailable' {
  const classified = classifyTelegramMtprotoError(error);
  if (classified.kind === 'auth_required') {
    return 'telegram_auth_unavailable';
  }
  if (classified.kind === 'unavailable') {
    return 'telegram_chat_unavailable';
  }

  const message = classified.message || (error instanceof Error ? error.message : String(error));
  if (CHAT_UNAVAILABLE_PATTERN.test(message)) {
    return 'telegram_chat_unavailable';
  }
  if (AUTH_UNAVAILABLE_PATTERN.test(message)) {
    return 'telegram_auth_unavailable';
  }
  return phase === 'create_client' ? 'telegram_auth_unavailable' : 'telegram_chat_unavailable';
}

function recordReadAudit(input: {
  grant: TelegramAgentGrant;
  mode: TelegramAgentReadMode;
  query: string | null;
  limit: number;
  resultCount: number | null;
  success: boolean;
  errorCode: TelegramAgentReadError | null;
}) {
  recordTelegramAgentGrantRead({
    grantId: input.grant.id,
    agentName: input.grant.agentName,
    chatId: input.grant.chatId,
    command: input.mode,
    scope: input.mode,
    query: input.query,
    limitValue: input.limit,
    resultCount: input.resultCount,
    success: input.success,
    errorCode: input.errorCode,
  });
}

function recordReadAuditOrReturnRevoked(input: {
  grant: TelegramAgentGrant;
  mode: TelegramAgentReadMode;
  query: string | null;
  limit: number;
  resultCount: number | null;
  success: boolean;
  errorCode: TelegramAgentReadError | null;
}): TelegramAgentReadResult | null {
  try {
    recordReadAudit(input);
    return null;
  } catch {
    return { ok: false, error: 'grant_revoked' };
  }
}

export async function runTelegramAgentRead(input: RunTelegramAgentReadInput): Promise<TelegramAgentReadResult> {
  const mode = input.mode;
  const token = normalizeString(input.token);
  if (!token) {
    return { ok: false, error: 'invalid_token' };
  }

  const grant = getTelegramAgentGrantByToken(token);
  if (!grant) {
    return { ok: false, error: 'grant_not_found' };
  }
  if (grant.status !== 'active') {
    return { ok: false, error: 'grant_revoked' };
  }

  const chatId = normalizeString(input.chatId);
  const query = normalizeString(input.query || '') || null;
  const limitValue = clampLimit(mode, input.limit);

  if (chatId !== grant.chatId) {
    const auditFailure = recordReadAuditOrReturnRevoked({
      grant,
      mode,
      query,
      limit: limitValue,
      resultCount: null,
      success: false,
      errorCode: 'chat_mismatch',
    });
    if (auditFailure) {
      return auditFailure;
    }
    return { ok: false, error: 'chat_mismatch' };
  }

  if (!grant.scope.includes(mode)) {
    const auditFailure = recordReadAuditOrReturnRevoked({
      grant,
      mode,
      query,
      limit: limitValue,
      resultCount: null,
      success: false,
      errorCode: 'scope_denied',
    });
    if (auditFailure) {
      return auditFailure;
    }
    return { ok: false, error: 'scope_denied' };
  }

  if (mode === 'search' && !query) {
    const auditFailure = recordReadAuditOrReturnRevoked({
      grant,
      mode,
      query: null,
      limit: limitValue,
      resultCount: null,
      success: false,
      errorCode: 'query_required',
    });
    if (auditFailure) {
      return auditFailure;
    }
    return { ok: false, error: 'query_required' };
  }

  let client = input.client || null;
  let createdClient = false;
  let failurePhase: TelegramReadFailurePhase = client ? 'read_chat' : 'create_client';

  try {
    if (!client) {
      client = await createTelegramGramjsClient();
      createdClient = true;
      failurePhase = 'read_chat';
    }

    if (mode === 'tail') {
      if (!client.listAgentChatMessages) {
        throw new Error('telegram client does not support tail reads');
      }
      const items = await client.listAgentChatMessages({ chatId, limit: limitValue });
      const auditFailure = recordReadAuditOrReturnRevoked({
        grant,
        mode,
        query: null,
        limit: limitValue,
        resultCount: items.length,
        success: true,
        errorCode: null,
      });
      if (auditFailure) {
        return auditFailure;
      }
      return {
        ok: true,
        mode: 'tail',
        chatId,
        grant: {
          agentName: grant.agentName,
          scope: grant.scope,
        },
        items,
      };
    }

    if (!client.searchAgentChatMessages) {
      throw new Error('telegram client does not support search reads');
    }
    const searchResult = await client.searchAgentChatMessages({ chatId, query: query || '', limit: limitValue });

    const auditFailure = recordReadAuditOrReturnRevoked({
      grant,
      mode,
      query,
      limit: limitValue,
      resultCount: searchResult.items.length,
      success: true,
      errorCode: null,
    });
    if (auditFailure) {
      return auditFailure;
    }
    return {
      ok: true,
      mode: 'search',
      chatId,
      query: query || '',
      searchMode: searchResult.searchMode,
      grant: {
        agentName: grant.agentName,
        scope: grant.scope,
      },
      items: searchResult.items,
    };
  } catch (error) {
    const mappedError = mapTelegramReadFailure(error, failurePhase);
    const auditFailure = recordReadAuditOrReturnRevoked({
      grant,
      mode,
      query,
      limit: limitValue,
      resultCount: null,
      success: false,
      errorCode: mappedError,
    });
    if (auditFailure) {
      return auditFailure;
    }
    return { ok: false, error: mappedError };
  } finally {
    if (createdClient) {
      await client?.disconnect?.();
    }
  }
}
