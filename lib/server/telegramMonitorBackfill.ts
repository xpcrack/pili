import 'server-only';

import { getDb } from '@/lib/server/sqlite';
import { findTrackedUserMatch } from '@/lib/server/telegramMonitorIngest';
import { projectAndPersistTelegramMonitorUpdate } from '@/lib/server/telegramMonitorProjectionService';
import { parseXxyyTelegramText } from '@/lib/server/xxyyTelegramParser';

interface RawTelegramMonitorEventRow {
  id: number;
  source_chat_id: string | null;
  source_message_id: number | null;
  chain: string;
  token_address: string;
  token_symbol: string | null;
  tx_hash: string | null;
  market_cap_usd: number | null;
  price_usd: number | null;
  quote_amount: number | null;
  quote_symbol: string | null;
  action: string | null;
  action_label: string | null;
  action_variant: string | null;
  wallet_label: string | null;
  wallet_group_label: string | null;
  wallet_alias_label: string | null;
  tracked_wallet_address: string | null;
  event_time_ms: number | null;
  raw_text: string;
  message_links_json: string | null;
  updated_at: number;
}

export type TelegramMonitorBackfillStatus =
  | 'projected'
  | 'already-visible'
  | 'dry-run'
  | 'not-found'
  | 'unmatched-user'
  | 'invalid-event'
  | 'projection-failed';

export interface TelegramMonitorBackfillResult {
  status: TelegramMonitorBackfillStatus;
  txHash: string;
  rawEventId: number | null;
  userId: string | null;
  feedRows: number;
  txStates: number;
  reason?: string;
}

function normalize(value: string | null | undefined) {
  return (value || '').trim().toLowerCase();
}

function parseLinks(value: string | null) {
  if (!value) return [] as string[];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

function countProjectionRows(params: {
  userId: string;
  chain: string;
  trackedWalletAddress: string;
  txHash: string;
  tokenAddress: string;
}) {
  const db = getDb();
  const feedRows = (
    db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM events
         WHERE user_id = ?
           AND lower(COALESCE(chain, '')) = ?
           AND lower(COALESCE(address, '')) = ?
           AND lower(COALESCE(tx_hash, '')) = ?
           AND lower(COALESCE(json_extract(activity_json, '$.metadata.tokenAddress'), '')) = ?`
      )
      .get(
        params.userId,
        normalize(params.chain),
        normalize(params.trackedWalletAddress),
        normalize(params.txHash),
        normalize(params.tokenAddress)
      ) as { count: number }
  ).count;
  const txStates = (
    db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM telegram_monitor_tx_states
         WHERE lower(chain) = ?
           AND tracked_wallet_address_lower = ?
           AND tx_hash_lower = ?`
      )
      .get(normalize(params.chain), normalize(params.trackedWalletAddress), normalize(params.txHash)) as {
      count: number;
    }
  ).count;
  return { feedRows, txStates };
}

function findRawEvent(txHash: string) {
  return getDb()
    .prepare(
      `SELECT
         id,
         source_chat_id,
         source_message_id,
         chain,
         token_address,
         token_symbol,
         tx_hash,
         market_cap_usd,
         price_usd,
         quote_amount,
         quote_symbol,
         action,
         action_label,
         action_variant,
         wallet_label,
         wallet_group_label,
         wallet_alias_label,
         tracked_wallet_address,
         event_time_ms,
         raw_text,
         message_links_json,
         updated_at
       FROM telegram_monitor_events
       WHERE provider = 'xxyy'
         AND tx_hash_lower = ?
       ORDER BY updated_at DESC, id DESC
       LIMIT 1`
    )
    .get(normalize(txHash)) as RawTelegramMonitorEventRow | undefined;
}

export async function backfillTelegramMonitorEventByTxHash(
  txHashInput: string,
  options?: { dryRun?: boolean }
): Promise<TelegramMonitorBackfillResult> {
  const txHash = txHashInput.trim();
  const notFound = (status: TelegramMonitorBackfillStatus, extra?: Partial<TelegramMonitorBackfillResult>) => ({
    status,
    txHash,
    rawEventId: null,
    userId: null,
    feedRows: 0,
    txStates: 0,
    ...extra,
  });

  if (!txHash) return notFound('not-found', { reason: 'empty-tx-hash' });

  const raw = findRawEvent(txHash);
  if (!raw) return notFound('not-found', { reason: 'raw-event-not-found' });

  const messageLinks = parseLinks(raw.message_links_json);
  const parsed = parseXxyyTelegramText(raw.raw_text, raw.event_time_ms ?? raw.updated_at, messageLinks);
  const chain = parsed.chain || raw.chain;
  const tokenAddress = parsed.tokenAddress || raw.token_address;
  const trackedWalletAddress = parsed.trackedWalletAddress || raw.tracked_wallet_address;
  const parsedTxHash = parsed.txHash || raw.tx_hash;
  const action = parsed.action || (raw.action as 'buy' | 'sell' | 'send' | null);

  if (!chain || !tokenAddress || !trackedWalletAddress || !parsedTxHash || !action) {
    return notFound('invalid-event', {
      rawEventId: raw.id,
      reason: 'raw-event-missing-projection-fields',
    });
  }

  const trackedMatch = findTrackedUserMatch({
    chain,
    walletAliasLabel: parsed.walletAliasLabel || raw.wallet_alias_label,
    walletLabel: parsed.walletLabel || raw.wallet_label,
    trackedWalletAddress,
  });
  if (!trackedMatch) {
    return notFound('unmatched-user', {
      rawEventId: raw.id,
      reason: 'tracked-wallet-is-not-monitored',
    });
  }

  const existing = countProjectionRows({
    userId: trackedMatch.user.id,
    chain,
    trackedWalletAddress,
    txHash: parsedTxHash,
    tokenAddress,
  });
  if (existing.feedRows > 0) {
    return {
      status: 'already-visible',
      txHash: parsedTxHash,
      rawEventId: raw.id,
      userId: trackedMatch.user.id,
      ...existing,
    };
  }

  if (options?.dryRun) {
    return {
      status: 'dry-run',
      txHash: parsedTxHash,
      rawEventId: raw.id,
      userId: trackedMatch.user.id,
      ...existing,
      reason: 'would-project-provisional-feed-row',
    };
  }

  const projection = await projectAndPersistTelegramMonitorUpdate({
    parsed: {
      ...parsed,
      chain,
      tokenAddress,
      txHash: parsedTxHash,
      tokenSymbol: parsed.tokenSymbol || raw.token_symbol,
      marketCapUsd: parsed.marketCapUsd ?? raw.market_cap_usd,
      priceUsd: parsed.priceUsd ?? raw.price_usd,
      quoteAmount: parsed.quoteAmount ?? raw.quote_amount,
      quoteSymbol: parsed.quoteSymbol || raw.quote_symbol,
      action,
      actionLabel: parsed.actionLabel || (raw.action_label as '建仓' | '加仓' | '减仓' | '清仓' | '发送' | null),
      actionVariant: parsed.actionVariant || (raw.action_variant as 'open' | 'add' | 'reduce' | 'close' | 'send' | null),
      walletLabel: parsed.walletLabel || raw.wallet_label,
      walletGroupLabel: parsed.walletGroupLabel || raw.wallet_group_label,
      walletAliasLabel: parsed.walletAliasLabel || raw.wallet_alias_label,
      trackedWalletAddress,
      eventTimeMs: parsed.eventTimeMs ?? raw.event_time_ms,
    },
    user: trackedMatch.user,
    sourceChatId: raw.source_chat_id,
    sourceMessageId: raw.source_message_id,
    eventTimeMs: parsed.eventTimeMs ?? raw.event_time_ms ?? raw.updated_at,
    rawText: raw.raw_text,
    messageLinks,
    feedMode: 'doorbell',
    autoReconcile: false,
  });

  const after = countProjectionRows({
    userId: trackedMatch.user.id,
    chain,
    trackedWalletAddress,
    txHash: parsedTxHash,
    tokenAddress,
  });

  return {
    status: projection.projected ? 'projected' : 'projection-failed',
    txHash: parsedTxHash,
    rawEventId: raw.id,
    userId: trackedMatch.user.id,
    ...after,
    reason: projection.projected ? undefined : 'projection-service-returned-no-activity',
  };
}
