import 'server-only';

import type { Activity } from '@/types';
import { getDb } from '@/lib/server/sqlite';

function normalize(value: string | null | undefined) {
  return (value || '').trim().toLowerCase();
}

function normalizeMessageLinks(input: string[] | null | undefined) {
  const seen = new Set<string>();
  const links: string[] = [];
  for (const value of input || []) {
    const normalized = (value || '').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    links.push(normalized);
  }
  return links;
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export interface UpsertTelegramMonitorEventInput {
  provider: 'xxyy';
  sourceChatId?: string | null;
  sourceMessageId?: number | null;
  updateId?: number | null;
  chain: string;
  tokenAddress: string;
  tokenSymbol?: string | null;
  txHash?: string | null;
  marketCapUsd?: number | null;
  priceUsd?: number | null;
  quoteAmount?: number | null;
  quoteSymbol?: string | null;
  action?: string | null;
  actionLabel?: string | null;
  actionVariant?: string | null;
  walletLabel?: string | null;
  walletGroupLabel?: string | null;
  walletAliasLabel?: string | null;
  trackedWalletAddress?: string | null;
  eventTimeMs?: number | null;
  rawText?: string | null;
  messageLinks?: string[] | null;
  payload?: Record<string, unknown> | null;
}

interface TelegramMonitorEventRow {
  market_cap_usd: number | null;
  event_time_ms: number | null;
}

interface TelegramCapAtTxInput {
  chain: string;
  tokenAddress: string;
  txHash?: string | null;
}

export function upsertTelegramMonitorEvent(input: UpsertTelegramMonitorEventInput) {
  const db = getDb();
  const now = Date.now();
  const chain = normalize(input.chain);
  const tokenAddress = (input.tokenAddress || '').trim();
  const tokenAddressLower = normalize(tokenAddress);
  if (!chain || !tokenAddressLower) {
    return { ok: false as const, reason: 'missing_chain_or_token' as const };
  }

  const sourceChatId = input.sourceChatId ? String(input.sourceChatId).trim() : null;
  const sourceMessageId =
    typeof input.sourceMessageId === 'number' && Number.isFinite(input.sourceMessageId)
      ? Math.floor(input.sourceMessageId)
      : null;
  const updateId =
    typeof input.updateId === 'number' && Number.isFinite(input.updateId) ? Math.floor(input.updateId) : null;
  const txHash = input.txHash ? input.txHash.trim() : null;
  const txHashLower = normalize(txHash);
  const trackedWalletAddress = input.trackedWalletAddress ? input.trackedWalletAddress.trim() : null;
  const trackedWalletAddressLower = normalize(trackedWalletAddress);

  const stmt = db.prepare(
    `INSERT INTO telegram_monitor_events (
      provider,
      source_chat_id,
      source_message_id,
      update_id,
      chain,
      token_address,
      token_address_lower,
      token_symbol,
      tx_hash,
      tx_hash_lower,
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
      tracked_wallet_address_lower,
      event_time_ms,
      raw_text,
      message_links_json,
      payload_json,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider, source_chat_id, source_message_id)
    DO UPDATE SET
      update_id = excluded.update_id,
      chain = excluded.chain,
      token_address = excluded.token_address,
      token_address_lower = excluded.token_address_lower,
      token_symbol = excluded.token_symbol,
      tx_hash = excluded.tx_hash,
      tx_hash_lower = excluded.tx_hash_lower,
      market_cap_usd = excluded.market_cap_usd,
      price_usd = excluded.price_usd,
      quote_amount = excluded.quote_amount,
      quote_symbol = excluded.quote_symbol,
      action = excluded.action,
      action_label = excluded.action_label,
      action_variant = excluded.action_variant,
      wallet_label = excluded.wallet_label,
      wallet_group_label = excluded.wallet_group_label,
      wallet_alias_label = excluded.wallet_alias_label,
      tracked_wallet_address = excluded.tracked_wallet_address,
      tracked_wallet_address_lower = excluded.tracked_wallet_address_lower,
      event_time_ms = excluded.event_time_ms,
      raw_text = excluded.raw_text,
      message_links_json = excluded.message_links_json,
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at`
  );
  const messageLinks = normalizeMessageLinks(input.messageLinks);

  stmt.run(
    input.provider,
    sourceChatId,
    sourceMessageId,
    updateId,
    chain,
    tokenAddress,
    tokenAddressLower,
    input.tokenSymbol || null,
    txHash,
    txHashLower || null,
    typeof input.marketCapUsd === 'number' && Number.isFinite(input.marketCapUsd) ? input.marketCapUsd : null,
    typeof input.priceUsd === 'number' && Number.isFinite(input.priceUsd) ? input.priceUsd : null,
    typeof input.quoteAmount === 'number' && Number.isFinite(input.quoteAmount) ? input.quoteAmount : null,
    input.quoteSymbol || null,
    input.action || null,
    input.actionLabel || null,
    input.actionVariant || null,
    input.walletLabel || null,
    input.walletGroupLabel || null,
    input.walletAliasLabel || null,
    trackedWalletAddress,
    trackedWalletAddressLower || null,
    typeof input.eventTimeMs === 'number' && Number.isFinite(input.eventTimeMs) ? Math.floor(input.eventTimeMs) : null,
    input.rawText || '',
    JSON.stringify(messageLinks),
    JSON.stringify(input.payload || {}),
    now,
    now
  );

  return { ok: true as const };
}

export function findTelegramMonitorMarketCapAtTx(params: TelegramCapAtTxInput) {
  const db = getDb();
  const chain = normalize(params.chain);
  const tokenAddressLower = normalize(params.tokenAddress);
  const txHashLower = normalize(params.txHash);

  if (!chain || !tokenAddressLower || !txHashLower) {
    return null;
  }

  const byTx = db
    .prepare(
      `SELECT market_cap_usd, event_time_ms
       FROM telegram_monitor_events
       WHERE chain = ?
         AND token_address_lower = ?
         AND tx_hash_lower = ?
         AND market_cap_usd IS NOT NULL
       ORDER BY updated_at DESC
       LIMIT 1`
    )
    .get(chain, tokenAddressLower, txHashLower) as TelegramMonitorEventRow | undefined;

  if (byTx?.market_cap_usd && byTx.market_cap_usd > 0) {
    return {
      marketCapUsd: byTx.market_cap_usd,
      source: 'telegram-monitor-exact' as const,
      eventTimeMs: byTx.event_time_ms,
    };
  }

  return null;
}

interface TelegramFeedRow {
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
  raw_text: string | null;
  message_links_json: string | null;
  projected_activity_json: string | null;
  updated_at: number;
}

function mapTelegramFeedRow(row: TelegramFeedRow): TelegramMonitorFeedEvent {
  return {
    sourceChatId: row.source_chat_id,
    sourceMessageId: typeof row.source_message_id === 'number' ? row.source_message_id : null,
    chain: row.chain,
    tokenAddress: row.token_address,
    tokenSymbol: row.token_symbol,
    txHash: row.tx_hash,
    marketCapUsd: row.market_cap_usd,
    priceUsd: row.price_usd,
    quoteAmount: row.quote_amount,
    quoteSymbol: row.quote_symbol,
    action: row.action === 'buy' || row.action === 'sell' || row.action === 'send' ? row.action : null,
    actionLabel:
      row.action_label === '建仓' ||
      row.action_label === '加仓' ||
      row.action_label === '减仓' ||
      row.action_label === '清仓' ||
      row.action_label === '发送'
        ? row.action_label
        : null,
    actionVariant:
      row.action_variant === 'open' ||
      row.action_variant === 'add' ||
      row.action_variant === 'reduce' ||
      row.action_variant === 'close' ||
      row.action_variant === 'send'
        ? row.action_variant
        : null,
    walletLabel: row.wallet_label,
    walletGroupLabel: row.wallet_group_label,
    walletAliasLabel: row.wallet_alias_label,
    trackedWalletAddress: row.tracked_wallet_address,
    eventTimeMs: typeof row.event_time_ms === 'number' ? row.event_time_ms : row.updated_at,
    rawText: row.raw_text,
    messageLinks: (() => {
      if (!row.message_links_json) {
        return [] as string[];
      }
      try {
        const parsed = JSON.parse(row.message_links_json) as unknown;
        return normalizeMessageLinks(Array.isArray(parsed) ? (parsed as string[]) : []);
      } catch {
        return [] as string[];
      }
    })(),
    projectedActivity: parseJson<Activity | null>(row.projected_activity_json, null),
    updatedAt: row.updated_at,
  } satisfies TelegramMonitorFeedEvent;
}

export interface TelegramMonitorFeedEvent {
  sourceChatId?: string | null;
  sourceMessageId?: number | null;
  chain: string;
  tokenAddress: string;
  tokenSymbol: string | null;
  txHash: string | null;
  marketCapUsd: number | null;
  priceUsd: number | null;
  quoteAmount: number | null;
  quoteSymbol: string | null;
  action: 'buy' | 'sell' | 'send' | null;
  actionLabel: '建仓' | '加仓' | '减仓' | '清仓' | '发送' | null;
  actionVariant: 'open' | 'add' | 'reduce' | 'close' | 'send' | null;
  walletLabel: string | null;
  walletGroupLabel: string | null;
  walletAliasLabel: string | null;
  trackedWalletAddress: string | null;
  eventTimeMs: number;
  rawText: string | null;
  messageLinks?: string[];
  projectedActivity?: Activity | null;
  updatedAt: number;
}

export function updateTelegramMonitorEventProjectedActivity(input: {
  sourceChatId: string | null;
  sourceMessageId: number | null;
  txHash: string | null;
  activity: Activity;
}) {
  const db = getDb();
  db.prepare(
    `UPDATE telegram_monitor_events
     SET projected_activity_json = ?,
         updated_at = ?
     WHERE provider = 'xxyy'
       AND source_chat_id IS ?
       AND source_message_id IS ?
       AND tx_hash IS ?`
  ).run(
    JSON.stringify(input.activity),
    Date.now(),
    input.sourceChatId,
    input.sourceMessageId,
    input.txHash
  );
}

export function updateTelegramMonitorEventProjectedActivityIfMissing(input: {
  sourceChatId: string | null;
  sourceMessageId: number | null;
  txHash: string | null;
  activity: Activity;
}) {
  const db = getDb();
  db.prepare(
    `UPDATE telegram_monitor_events
     SET projected_activity_json = ?,
         updated_at = ?
     WHERE provider = 'xxyy'
       AND source_chat_id IS ?
       AND source_message_id IS ?
       AND tx_hash IS ?
       AND projected_activity_json IS NULL`
  ).run(
    JSON.stringify(input.activity),
    Date.now(),
    input.sourceChatId,
    input.sourceMessageId,
    input.txHash
  );
}

export interface ListTelegramMonitorEventsOptions {
  limit?: number;
  fromMs?: number | null;
  toMs?: number | null;
  cursor?: {
    eventTimeMs: number;
    eventKey: string;
  } | null;
}

function buildTelegramMonitorEventKey(row: TelegramFeedRow) {
  if (row.source_chat_id && typeof row.source_message_id === 'number') {
    return `xxyy:${row.source_chat_id}:${row.source_message_id}`;
  }

  return [
    'xxyy',
    row.chain || '',
    row.tracked_wallet_address || '',
    row.tx_hash || '',
    row.token_address || '',
    String(typeof row.event_time_ms === 'number' ? row.event_time_ms : row.updated_at),
  ].join(':');
}

export function listTelegramMonitorEvents(options?: ListTelegramMonitorEventsOptions) {
  const safeLimit = Math.max(1, Math.min(10000, Math.floor(options?.limit || 200)));
  const clauses = [`provider = 'xxyy'`];
  const values: Array<number | string> = [];

  if (typeof options?.fromMs === 'number' && Number.isFinite(options.fromMs)) {
    clauses.push('COALESCE(event_time_ms, updated_at) >= ?');
    values.push(Math.floor(options.fromMs));
  }

  if (typeof options?.toMs === 'number' && Number.isFinite(options.toMs)) {
    clauses.push('COALESCE(event_time_ms, updated_at) <= ?');
    values.push(Math.floor(options.toMs));
  }

  const db = getDb();
  const rows = db
    .prepare(
      `SELECT
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
         projected_activity_json,
         updated_at
       FROM telegram_monitor_events
       WHERE ${clauses.join(' AND ')}
       ORDER BY COALESCE(event_time_ms, updated_at) DESC, id DESC
       LIMIT ?`
    )
    .all(...values, safeLimit) as TelegramFeedRow[];

  if (!options?.cursor) {
    return rows.map((row) => mapTelegramFeedRow(row));
  }

  const filteredRows = rows.filter((row) => {
    const rowEventTimeMs = typeof row.event_time_ms === 'number' ? row.event_time_ms : row.updated_at;
    const rowEventKey = buildTelegramMonitorEventKey(row);
    if (rowEventTimeMs < options.cursor!.eventTimeMs) {
      return true;
    }
    if (rowEventTimeMs > options.cursor!.eventTimeMs) {
      return false;
    }
    return rowEventKey < options.cursor!.eventKey;
  });

  return filteredRows.map((row) => mapTelegramFeedRow(row));
}

export function listRecentTelegramMonitorEvents(limit = 200) {
  return listTelegramMonitorEvents({ limit: Math.max(1, Math.min(2000, Math.floor(limit))) });
}

export function listRecentTelegramMonitorFallbackEventsWithoutTxState(limit = 200) {
  const safeLimit = Math.max(1, Math.min(2000, Math.floor(limit)));
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT
         e.source_chat_id,
         e.source_message_id,
         e.chain,
         e.token_address,
         e.token_symbol,
         e.tx_hash,
         e.market_cap_usd,
         e.price_usd,
         e.quote_amount,
         e.quote_symbol,
         e.action,
         e.action_label,
         e.action_variant,
         e.wallet_label,
         e.wallet_group_label,
         e.wallet_alias_label,
         e.tracked_wallet_address,
         e.event_time_ms,
         e.raw_text,
         e.message_links_json,
         e.projected_activity_json,
         e.updated_at
       FROM telegram_monitor_events e
       WHERE e.provider = 'xxyy'
         AND (
           e.tx_hash_lower IS NULL
           OR e.tracked_wallet_address_lower IS NULL
           OR NOT EXISTS (
             SELECT 1
             FROM telegram_monitor_tx_states s
             WHERE s.chain = e.chain
               AND s.tracked_wallet_address_lower = e.tracked_wallet_address_lower
               AND s.tx_hash_lower = e.tx_hash_lower
           )
         )
       ORDER BY COALESCE(e.event_time_ms, e.updated_at) DESC, e.id DESC
       LIMIT ?`
    )
    .all(safeLimit) as TelegramFeedRow[];

  return rows.map((row) => mapTelegramFeedRow(row));
}
