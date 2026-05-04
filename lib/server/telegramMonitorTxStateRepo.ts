import 'server-only';

import type { Activity } from '@/types';
import { buildTelegramMonitorTxAggregateKey } from '@/lib/telegramMonitorIdentity';
import { getDb } from '@/lib/server/sqlite';

function normalize(value: string | null | undefined) {
  return (value || '').trim().toLowerCase();
}

export function buildTelegramMonitorTxStateLookupKey(
  chain: string | null | undefined,
  trackedWalletAddress: string | null | undefined,
  txHash: string | null | undefined
) {
  const normalizedChain = normalize(chain);
  const normalizedTrackedWalletAddress = normalize(trackedWalletAddress);
  const normalizedTxHash = normalize(txHash);

  if (!normalizedChain || !normalizedTrackedWalletAddress || !normalizedTxHash) {
    return null;
  }

  return `${normalizedChain}|${normalizedTrackedWalletAddress}|${normalizedTxHash}`;
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

export interface TelegramMonitorTxState {
  userId: string;
  chain: string;
  trackedWalletAddress: string;
  txHash: string;
  tokenAddress: string | null;
  tokenSymbol: string | null;
  provisionalAction: 'buy' | 'sell' | 'send' | null;
  provisionalActionLabel: '建仓' | '加仓' | '减仓' | '清仓' | '发送' | null;
  provisionalActionVariant: 'open' | 'add' | 'reduce' | 'close' | 'send' | null;
  provisionalQuoteAmount: number | null;
  provisionalQuoteSymbol: string | null;
  provisionalTokenAmount: number | null;
  provisionalTokenSymbol: string | null;
  provisionalPriceUsd: number | null;
  provisionalMarketCapUsd: number | null;
  provisionalRawText: string | null;
  provisionalMessageLinks: string[];
  provisionalWalletLabel: string | null;
  provisionalWalletGroupLabel: string | null;
  provisionalWalletAliasLabel: string | null;
  eventTimeMs: number;
  canonicalActivity: Activity | null;
  reconciliationStatus: 'pending' | 'reconciled' | 'failed';
  reconciledSource: 'xxyy' | 'okx-address' | 'okx-detail' | null;
  firstSeenAt: number;
  lastSeenAt: number;
  reconciledAt: number | null;
  nextRetryAt: number | null;
  repairClaimedAt: number | null;
  retryCount: number;
  lastError: string | null;
  updatedAt: number;
  aggregateKey: string;
}

interface TelegramMonitorTxStateRow {
  user_id: string;
  chain: string;
  tracked_wallet_address: string;
  tx_hash: string;
  token_address: string | null;
  token_symbol: string | null;
  provisional_action: string | null;
  provisional_action_label: string | null;
  provisional_action_variant: string | null;
  provisional_quote_amount: number | null;
  provisional_quote_symbol: string | null;
  provisional_token_amount: number | null;
  provisional_token_symbol: string | null;
  provisional_price_usd: number | null;
  provisional_market_cap_usd: number | null;
  provisional_raw_text: string | null;
  provisional_message_links_json: string | null;
  provisional_wallet_label: string | null;
  provisional_wallet_group_label: string | null;
  provisional_wallet_alias_label: string | null;
  event_time_ms: number | null;
  canonical_activity_json: string | null;
  reconciliation_status: string;
  reconciled_source: string | null;
  first_seen_at: number;
  last_seen_at: number;
  reconciled_at: number | null;
  next_retry_at: number | null;
  repair_claimed_at: number | null;
  retry_count: number;
  last_error: string | null;
  updated_at: number;
}

const TELEGRAM_MONITOR_TX_STATE_SELECT_COLUMN_NAMES = [
  'user_id',
  'chain',
  'tracked_wallet_address',
  'tx_hash',
  'token_address',
  'token_symbol',
  'provisional_action',
  'provisional_action_label',
  'provisional_action_variant',
  'provisional_quote_amount',
  'provisional_quote_symbol',
  'provisional_token_amount',
  'provisional_token_symbol',
  'provisional_price_usd',
  'provisional_market_cap_usd',
  'provisional_raw_text',
  'provisional_message_links_json',
  'provisional_wallet_label',
  'provisional_wallet_group_label',
  'provisional_wallet_alias_label',
  'event_time_ms',
  'canonical_activity_json',
  'reconciliation_status',
  'reconciled_source',
  'first_seen_at',
  'last_seen_at',
  'reconciled_at',
  'next_retry_at',
  'repair_claimed_at',
  'retry_count',
  'last_error',
  'updated_at',
] as const;

function buildTelegramMonitorTxStateSelectColumns(alias?: string) {
  const prefix = alias ? `${alias}.` : '';
  return TELEGRAM_MONITOR_TX_STATE_SELECT_COLUMN_NAMES.map((column) => `${prefix}${column} AS ${column}`).join(',\n         ');
}

export interface UpsertTelegramMonitorTxStateProvisionalInput {
  userId: string;
  chain: string;
  trackedWalletAddress: string;
  txHash: string;
  tokenAddress?: string | null;
  tokenSymbol?: string | null;
  provisionalAction?: 'buy' | 'sell' | 'send' | null;
  provisionalActionLabel?: '建仓' | '加仓' | '减仓' | '清仓' | '发送' | null;
  provisionalActionVariant?: 'open' | 'add' | 'reduce' | 'close' | 'send' | null;
  provisionalQuoteAmount?: number | null;
  provisionalQuoteSymbol?: string | null;
  provisionalTokenAmount?: number | null;
  provisionalTokenSymbol?: string | null;
  provisionalPriceUsd?: number | null;
  provisionalMarketCapUsd?: number | null;
  provisionalRawText?: string | null;
  provisionalMessageLinks?: string[] | null;
  provisionalWalletLabel?: string | null;
  provisionalWalletGroupLabel?: string | null;
  provisionalWalletAliasLabel?: string | null;
  eventTimeMs?: number | null;
}

function mapRow(row: TelegramMonitorTxStateRow | undefined | null) {
  if (!row) {
    return null;
  }

  const aggregateKey = buildTelegramMonitorTxAggregateKey(
    row.chain,
    row.tracked_wallet_address,
    row.tx_hash
  );
  if (!aggregateKey) {
    return null;
  }

  return {
    userId: row.user_id,
    chain: row.chain,
    trackedWalletAddress: row.tracked_wallet_address,
    txHash: row.tx_hash,
    tokenAddress: row.token_address,
    tokenSymbol: row.token_symbol,
    provisionalAction:
      row.provisional_action === 'buy' || row.provisional_action === 'sell' || row.provisional_action === 'send'
        ? row.provisional_action
        : null,
    provisionalActionLabel:
      row.provisional_action_label === '建仓' ||
      row.provisional_action_label === '加仓' ||
      row.provisional_action_label === '减仓' ||
      row.provisional_action_label === '清仓' ||
      row.provisional_action_label === '发送'
        ? row.provisional_action_label
        : null,
    provisionalActionVariant:
      row.provisional_action_variant === 'open' ||
      row.provisional_action_variant === 'add' ||
      row.provisional_action_variant === 'reduce' ||
      row.provisional_action_variant === 'close' ||
      row.provisional_action_variant === 'send'
        ? row.provisional_action_variant
        : null,
    provisionalQuoteAmount: row.provisional_quote_amount,
    provisionalQuoteSymbol: row.provisional_quote_symbol,
    provisionalTokenAmount: row.provisional_token_amount,
    provisionalTokenSymbol: row.provisional_token_symbol,
    provisionalPriceUsd: row.provisional_price_usd,
    provisionalMarketCapUsd: row.provisional_market_cap_usd,
    provisionalRawText: row.provisional_raw_text,
    provisionalMessageLinks: normalizeMessageLinks(parseJson<string[]>(row.provisional_message_links_json, [])),
    provisionalWalletLabel: row.provisional_wallet_label,
    provisionalWalletGroupLabel: row.provisional_wallet_group_label,
    provisionalWalletAliasLabel: row.provisional_wallet_alias_label,
    eventTimeMs: typeof row.event_time_ms === 'number' ? row.event_time_ms : row.updated_at,
    canonicalActivity: parseJson<Activity | null>(row.canonical_activity_json, null),
    reconciliationStatus:
      row.reconciliation_status === 'reconciled' || row.reconciliation_status === 'failed'
        ? row.reconciliation_status
        : 'pending',
    reconciledSource:
      row.reconciled_source === 'xxyy' ||
      row.reconciled_source === 'okx-address' ||
      row.reconciled_source === 'okx-detail'
        ? row.reconciled_source
        : null,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    reconciledAt: row.reconciled_at,
    nextRetryAt: row.next_retry_at,
    repairClaimedAt: row.repair_claimed_at,
    retryCount: row.retry_count,
    lastError: row.last_error,
    updatedAt: row.updated_at,
    aggregateKey,
  } satisfies TelegramMonitorTxState;
}

function selectByKey(chain: string, trackedWalletAddress: string, txHash: string) {
  const db = getDb();
  return db
    .prepare(
      `SELECT
         ${buildTelegramMonitorTxStateSelectColumns()}
       FROM telegram_monitor_tx_states
       WHERE chain = ?
         AND tracked_wallet_address_lower = ?
         AND tx_hash_lower = ?
       LIMIT 1`
    )
    .get(normalize(chain), normalize(trackedWalletAddress), normalize(txHash)) as TelegramMonitorTxStateRow | undefined;
}

export function getTelegramMonitorTxState(params: {
  chain: string;
  trackedWalletAddress: string;
  txHash: string;
}) {
  return mapRow(selectByKey(params.chain, params.trackedWalletAddress, params.txHash));
}

export function listTelegramMonitorTxStatesByKeys(
  keys: Array<{ chain: string; trackedWalletAddress: string; txHash: string }>
) {
  const normalizedKeys = Array.from(
    new Map(
      keys
        .map((key) => {
          const lookupKey = buildTelegramMonitorTxStateLookupKey(key.chain, key.trackedWalletAddress, key.txHash);
          if (!lookupKey) {
            return null;
          }

          const [chain, trackedWalletAddressLower, txHashLower] = lookupKey.split('|');
          return [
            lookupKey,
            {
              chain,
              trackedWalletAddressLower,
              txHashLower,
            },
          ] as const;
        })
        .filter(
          (
            entry
          ): entry is readonly [string, { chain: string; trackedWalletAddressLower: string; txHashLower: string }] =>
            Boolean(entry)
        )
    ).values()
  );

  if (normalizedKeys.length === 0) {
    return new Map<string, TelegramMonitorTxState>();
  }

  const db = getDb();
  const valuesSql = normalizedKeys.map(() => '(?, ?, ?)').join(', ');
  const rows = db
    .prepare(
      `WITH requested_keys(chain, tracked_wallet_address_lower, tx_hash_lower) AS (
         VALUES ${valuesSql}
       )
       SELECT
         ${buildTelegramMonitorTxStateSelectColumns('state')}
       FROM telegram_monitor_tx_states state
       INNER JOIN requested_keys keys
         ON state.chain = keys.chain
        AND state.tracked_wallet_address_lower = keys.tracked_wallet_address_lower
        AND state.tx_hash_lower = keys.tx_hash_lower`
    )
    .all(...normalizedKeys.flatMap((key) => [key.chain, key.trackedWalletAddressLower, key.txHashLower])) as
    TelegramMonitorTxStateRow[];

  const statesByKey = new Map<string, TelegramMonitorTxState>();
  for (const row of rows) {
    const state = mapRow(row);
    const lookupKey = buildTelegramMonitorTxStateLookupKey(row.chain, row.tracked_wallet_address, row.tx_hash);
    if (!state || !lookupKey) {
      continue;
    }
    statesByKey.set(lookupKey, state);
  }

  return statesByKey;
}

export function upsertTelegramMonitorTxStateProvisional(input: UpsertTelegramMonitorTxStateProvisionalInput) {
  const db = getDb();
  const now = Date.now();
  const chain = normalize(input.chain);
  const trackedWalletAddress = (input.trackedWalletAddress || '').trim();
  const trackedWalletAddressLower = normalize(trackedWalletAddress);
  const txHash = (input.txHash || '').trim();
  const txHashLower = normalize(txHash);
  const tokenAddress = input.tokenAddress ? input.tokenAddress.trim() : null;
  const tokenAddressLower = normalize(tokenAddress);

  if (!input.userId.trim() || !chain || !trackedWalletAddressLower || !txHashLower) {
    return null;
  }

  const existing = selectByKey(chain, trackedWalletAddress, txHash);
  const messageLinksJson = JSON.stringify(normalizeMessageLinks(input.provisionalMessageLinks));

  if (existing) {
    db.prepare(
      `UPDATE telegram_monitor_tx_states
       SET user_id = ?,
           token_address = ?,
           token_address_lower = ?,
           token_symbol = ?,
           provisional_action = ?,
           provisional_action_label = ?,
           provisional_action_variant = ?,
           provisional_quote_amount = ?,
           provisional_quote_symbol = ?,
           provisional_token_amount = ?,
           provisional_token_symbol = ?,
           provisional_price_usd = ?,
           provisional_market_cap_usd = ?,
           provisional_raw_text = ?,
           provisional_message_links_json = ?,
           provisional_wallet_label = ?,
           provisional_wallet_group_label = ?,
           provisional_wallet_alias_label = ?,
           event_time_ms = ?,
           reconciliation_status = CASE WHEN reconciliation_status = 'reconciled' THEN reconciliation_status ELSE 'pending' END,
           next_retry_at = CASE WHEN reconciliation_status = 'reconciled' THEN next_retry_at ELSE ? END,
           repair_claimed_at = CASE WHEN reconciliation_status = 'reconciled' THEN repair_claimed_at ELSE NULL END,
           last_error = CASE WHEN reconciliation_status = 'reconciled' THEN last_error ELSE NULL END,
           last_seen_at = ?,
           updated_at = ?
       WHERE chain = ?
         AND tracked_wallet_address_lower = ?
         AND tx_hash_lower = ?`
    ).run(
      input.userId.trim(),
      tokenAddress,
      tokenAddressLower || null,
      input.tokenSymbol || null,
      input.provisionalAction || null,
      input.provisionalActionLabel || null,
      input.provisionalActionVariant || null,
      typeof input.provisionalQuoteAmount === 'number' && Number.isFinite(input.provisionalQuoteAmount)
        ? input.provisionalQuoteAmount
        : null,
      input.provisionalQuoteSymbol || null,
      typeof input.provisionalTokenAmount === 'number' && Number.isFinite(input.provisionalTokenAmount)
        ? input.provisionalTokenAmount
        : null,
      input.provisionalTokenSymbol || null,
      typeof input.provisionalPriceUsd === 'number' && Number.isFinite(input.provisionalPriceUsd)
        ? input.provisionalPriceUsd
        : null,
      typeof input.provisionalMarketCapUsd === 'number' && Number.isFinite(input.provisionalMarketCapUsd)
        ? input.provisionalMarketCapUsd
        : null,
      input.provisionalRawText || '',
      messageLinksJson,
      input.provisionalWalletLabel || null,
      input.provisionalWalletGroupLabel || null,
      input.provisionalWalletAliasLabel || null,
      typeof input.eventTimeMs === 'number' && Number.isFinite(input.eventTimeMs) ? Math.floor(input.eventTimeMs) : now,
      now,
      now,
      now,
      chain,
      trackedWalletAddressLower,
      txHashLower
    );
  } else {
    db.prepare(
      `INSERT INTO telegram_monitor_tx_states (
         user_id,
         chain,
         tracked_wallet_address,
         tracked_wallet_address_lower,
         tx_hash,
         tx_hash_lower,
         token_address,
         token_address_lower,
         token_symbol,
         provisional_action,
         provisional_action_label,
         provisional_action_variant,
         provisional_quote_amount,
         provisional_quote_symbol,
         provisional_token_amount,
         provisional_token_symbol,
         provisional_price_usd,
         provisional_market_cap_usd,
         provisional_raw_text,
         provisional_message_links_json,
         provisional_wallet_label,
         provisional_wallet_group_label,
         provisional_wallet_alias_label,
         event_time_ms,
         canonical_activity_json,
         reconciliation_status,
         first_seen_at,
         last_seen_at,
         next_retry_at,
         repair_claimed_at,
         retry_count,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending', ?, ?, ?, NULL, 0, ?)`
    ).run(
      input.userId.trim(),
      chain,
      trackedWalletAddress,
      trackedWalletAddressLower,
      txHash,
      txHashLower,
      tokenAddress,
      tokenAddressLower || null,
      input.tokenSymbol || null,
      input.provisionalAction || null,
      input.provisionalActionLabel || null,
      input.provisionalActionVariant || null,
      typeof input.provisionalQuoteAmount === 'number' && Number.isFinite(input.provisionalQuoteAmount)
        ? input.provisionalQuoteAmount
        : null,
      input.provisionalQuoteSymbol || null,
      typeof input.provisionalTokenAmount === 'number' && Number.isFinite(input.provisionalTokenAmount)
        ? input.provisionalTokenAmount
        : null,
      input.provisionalTokenSymbol || null,
      typeof input.provisionalPriceUsd === 'number' && Number.isFinite(input.provisionalPriceUsd)
        ? input.provisionalPriceUsd
        : null,
      typeof input.provisionalMarketCapUsd === 'number' && Number.isFinite(input.provisionalMarketCapUsd)
        ? input.provisionalMarketCapUsd
        : null,
      input.provisionalRawText || '',
      messageLinksJson,
      input.provisionalWalletLabel || null,
      input.provisionalWalletGroupLabel || null,
      input.provisionalWalletAliasLabel || null,
      typeof input.eventTimeMs === 'number' && Number.isFinite(input.eventTimeMs) ? Math.floor(input.eventTimeMs) : now,
      now,
      now,
      now,
      now
    );
  }

  return getTelegramMonitorTxState({
    chain,
    trackedWalletAddress,
    txHash,
  });
}

export function markTelegramMonitorTxStateReconciled(input: {
  chain: string;
  trackedWalletAddress: string;
  txHash: string;
  activity: Activity;
  source: 'okx-address' | 'okx-detail' | 'xxyy';
}) {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `UPDATE telegram_monitor_tx_states
     SET canonical_activity_json = ?,
         reconciliation_status = 'reconciled',
         reconciled_source = ?,
         reconciled_at = ?,
         next_retry_at = NULL,
         repair_claimed_at = NULL,
         last_error = NULL,
         updated_at = ?
     WHERE chain = ?
       AND tracked_wallet_address_lower = ?
       AND tx_hash_lower = ?`
  ).run(
    JSON.stringify(input.activity),
    input.source,
    now,
    now,
    normalize(input.chain),
    normalize(input.trackedWalletAddress),
    normalize(input.txHash)
  );

  return getTelegramMonitorTxState(input);
}

export function setTelegramMonitorTxStateCanonicalActivity(input: {
  chain: string;
  trackedWalletAddress: string;
  txHash: string;
  activity: Activity;
}) {
  const db = getDb();
  db.prepare(
    `UPDATE telegram_monitor_tx_states
     SET canonical_activity_json = ?,
         updated_at = ?
     WHERE chain = ?
       AND tracked_wallet_address_lower = ?
       AND tx_hash_lower = ?`
  ).run(
    JSON.stringify(input.activity),
    Date.now(),
    normalize(input.chain),
    normalize(input.trackedWalletAddress),
    normalize(input.txHash)
  );
}

export function markTelegramMonitorTxStateFailed(input: {
  chain: string;
  trackedWalletAddress: string;
  txHash: string;
  error: string;
}) {
  const db = getDb();
  const existing = getTelegramMonitorTxState(input);
  if (!existing) {
    return null;
  }

  const retryCount = existing.retryCount + 1;
  const now = Date.now();
  const retryDelayMs = Math.min(5 * 60_000, 30_000 * 2 ** Math.max(0, retryCount - 1));
  const nextRetryAt = now + retryDelayMs;

  db.prepare(
     `UPDATE telegram_monitor_tx_states
     SET reconciliation_status = 'failed',
         next_retry_at = ?,
         repair_claimed_at = NULL,
         retry_count = ?,
         last_error = ?,
         updated_at = ?
     WHERE chain = ?
       AND tracked_wallet_address_lower = ?
       AND tx_hash_lower = ?`
  ).run(
    nextRetryAt,
    retryCount,
    input.error.slice(0, 500),
    now,
    normalize(input.chain),
    normalize(input.trackedWalletAddress),
    normalize(input.txHash)
  );

  return getTelegramMonitorTxState(input);
}

export function listRecentTelegramMonitorTxStates(limit = 200) {
  const safeLimit = Math.max(1, Math.min(2000, Math.floor(limit)));
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT
         ${buildTelegramMonitorTxStateSelectColumns()}
       FROM telegram_monitor_tx_states
       ORDER BY COALESCE(event_time_ms, updated_at) DESC, updated_at DESC
       LIMIT ?`
    )
    .all(safeLimit) as TelegramMonitorTxStateRow[];

  return rows.map((row) => mapRow(row)).filter((row): row is TelegramMonitorTxState => Boolean(row));
}

export function listTelegramMonitorTxStatesForRepair(params: {
  limit: number;
  nowMs?: number;
}) {
  const safeLimit = Math.max(1, Math.min(200, Math.floor(params.limit)));
  const nowMs = typeof params.nowMs === 'number' ? params.nowMs : Date.now();
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT
         ${buildTelegramMonitorTxStateSelectColumns()}
       FROM telegram_monitor_tx_states
       WHERE reconciliation_status != 'reconciled'
         AND COALESCE(next_retry_at, 0) <= ?
       ORDER BY COALESCE(next_retry_at, 0) ASC,
                COALESCE(event_time_ms, updated_at) ASC,
                updated_at ASC
       LIMIT ?`
    )
    .all(nowMs, safeLimit) as TelegramMonitorTxStateRow[];

  return rows.map((row) => mapRow(row)).filter((row): row is TelegramMonitorTxState => Boolean(row));
}

export function claimTelegramMonitorTxStatesForRepair(params: {
  limit: number;
  nowMs?: number;
  leaseMs?: number;
}) {
  const safeLimit = Math.max(1, Math.min(200, Math.floor(params.limit)));
  const nowMs = typeof params.nowMs === 'number' ? params.nowMs : Date.now();
  const leaseMs =
    typeof params.leaseMs === 'number' && Number.isFinite(params.leaseMs) && params.leaseMs > 0
      ? Math.floor(params.leaseMs)
      : 60_000;
  const claimCutoffMs = nowMs - leaseMs;
  const db = getDb();

  const tx = db.transaction(() => {
    const activeClaimCount = (
      db
        .prepare(
          `SELECT COUNT(*) as count
           FROM telegram_monitor_tx_states
           WHERE reconciliation_status != 'reconciled'
             AND repair_claimed_at IS NOT NULL
             AND repair_claimed_at > ?`
        )
        .get(claimCutoffMs) as { count: number }
    ).count;
    const availableSlots = Math.max(0, safeLimit - activeClaimCount);
    if (availableSlots === 0) {
      return [] as TelegramMonitorTxState[];
    }

    const candidates = db
      .prepare(
        `SELECT chain, tracked_wallet_address, tx_hash
         FROM telegram_monitor_tx_states
         WHERE reconciliation_status != 'reconciled'
           AND COALESCE(next_retry_at, 0) <= ?
           AND (repair_claimed_at IS NULL OR repair_claimed_at <= ?)
         ORDER BY COALESCE(next_retry_at, 0) ASC,
                  COALESCE(event_time_ms, updated_at) ASC,
                  updated_at ASC
         LIMIT ?`
      )
      .all(nowMs, claimCutoffMs, availableSlots) as Array<{
      chain: string;
      tracked_wallet_address: string;
      tx_hash: string;
    }>;

    if (candidates.length === 0) {
      return [] as TelegramMonitorTxState[];
    }

    const claimStmt = db.prepare(
      `UPDATE telegram_monitor_tx_states
       SET repair_claimed_at = ?
       WHERE chain = ?
         AND tracked_wallet_address_lower = ?
         AND tx_hash_lower = ?
         AND reconciliation_status != 'reconciled'
         AND COALESCE(next_retry_at, 0) <= ?
         AND (repair_claimed_at IS NULL OR repair_claimed_at <= ?)`
    );

    const claimed: TelegramMonitorTxState[] = [];
    for (const candidate of candidates) {
      const result = claimStmt.run(
        nowMs,
        normalize(candidate.chain),
        normalize(candidate.tracked_wallet_address),
        normalize(candidate.tx_hash),
        nowMs,
        claimCutoffMs
      );
      if (result.changes !== 1) {
        continue;
      }

      const state = getTelegramMonitorTxState({
        chain: candidate.chain,
        trackedWalletAddress: candidate.tracked_wallet_address,
        txHash: candidate.tx_hash,
      });
      if (state) {
        claimed.push(state);
      }
    }

    return claimed;
  });

  return tx();
}
