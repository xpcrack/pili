import { getDb } from '../lib/server/sqlite';
import { upsertEventsFromFeedRows } from '../lib/server/eventsRepo';
import { projectTelegramMonitorEvent } from '../lib/server/telegramMonitorFeed';
import { parseXxyyTelegramText } from '../lib/server/xxyyTelegramParser';

interface TelegramMessageEntityLike {
  type?: string;
  url?: string;
}

interface TelegramInlineKeyboardButtonLike {
  url?: string;
}

interface TelegramMessageLike {
  date?: number;
  text?: string;
  caption?: string;
  entities?: TelegramMessageEntityLike[];
  caption_entities?: TelegramMessageEntityLike[];
  reply_markup?: {
    inline_keyboard?: TelegramInlineKeyboardButtonLike[][];
  };
}

interface TelegramUpdateLike {
  message?: TelegramMessageLike;
  channel_post?: TelegramMessageLike;
  edited_message?: TelegramMessageLike;
  edited_channel_post?: TelegramMessageLike;
}

interface TelegramMonitorRepairRow {
  id: number;
  provider: string;
  source_chat_id: string | null;
  source_message_id: number | null;
  update_id: number | null;
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
  payload_json: string;
  updated_at?: number;
}

interface LegacyEventCandidateRow {
  rowid: number;
  event_id: string;
  timestamp: number;
  token: string | null;
  action: string | null;
  ingest_source: string | null;
}

function normalize(value: string | null | undefined) {
  return (value || '').trim().toLowerCase();
}

function extractMessage(update: TelegramUpdateLike | null | undefined) {
  if (!update) return null;
  return update.message || update.channel_post || update.edited_message || update.edited_channel_post || null;
}

function collectMessageLinks(message: TelegramMessageLike | null | undefined) {
  const links = new Set<string>();
  if (!message) return [];

  const entities = [...(message.entities || []), ...(message.caption_entities || [])];
  for (const entity of entities) {
    if (entity.type === 'text_link' && typeof entity.url === 'string' && entity.url.trim()) {
      links.add(entity.url.trim());
    }
  }

  for (const row of message.reply_markup?.inline_keyboard || []) {
    for (const button of row || []) {
      if (typeof button?.url === 'string' && button.url.trim()) {
        links.add(button.url.trim());
      }
    }
  }

  return Array.from(links);
}

function extractText(row: TelegramMonitorRepairRow, message: TelegramMessageLike | null) {
  const payloadText =
    (typeof message?.text === 'string' && message.text.trim()) ||
    (typeof message?.caption === 'string' && message.caption.trim()) ||
    '';

  return payloadText || row.raw_text || '';
}

function parsePayload(rawPayload: string) {
  if (!rawPayload.trim()) return null;
  try {
    return JSON.parse(rawPayload) as TelegramUpdateLike;
  } catch {
    return null;
  }
}

const db = getDb();
const rows = db
  .prepare(
    `SELECT
       id,
       provider,
       source_chat_id,
       source_message_id,
       update_id,
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
       payload_json,
       updated_at
     FROM telegram_monitor_events
     WHERE provider = 'xxyy'
     ORDER BY id ASC`
  )
  .all() as TelegramMonitorRepairRow[];

const updateStmt = db.prepare(
  `UPDATE telegram_monitor_events
   SET chain = ?,
       token_address = ?,
       token_address_lower = ?,
       token_symbol = ?,
       tx_hash = ?,
       tx_hash_lower = ?,
       market_cap_usd = ?,
       price_usd = ?,
       quote_amount = ?,
       quote_symbol = ?,
       action = ?,
       action_label = ?,
       action_variant = ?,
       wallet_label = ?,
       wallet_group_label = ?,
       wallet_alias_label = ?,
       tracked_wallet_address = ?,
       tracked_wallet_address_lower = ?,
       event_time_ms = ?,
       raw_text = ?,
       updated_at = ?
   WHERE id = ?`
);

const CLEANUP_TIME_WINDOW_MS = 120 * 1000;

const findLegacyEventCandidatesStmt = db.prepare(
  `SELECT
     rowid,
     event_id,
     timestamp,
     token,
     action,
     ingest_source
   FROM events
  WHERE source = 'blockchain'
     AND tx_hash IS NULL
     AND ingest_source = 'telegram-monitor-webhook'
     AND user_id = ?
     AND chain = ?
     AND address = ?
     AND timestamp >= ?
     AND timestamp <= ?
     AND (? IS NULL OR lower(coalesce(token, '')) = ?)
     AND (? IS NULL OR lower(coalesce(action, '')) = ?)
   ORDER BY abs(timestamp - ?) ASC, rowid DESC
   LIMIT 5`
);

const deleteLegacyEventStmt = db.prepare(`DELETE FROM events WHERE rowid = ?`);

let repairedCount = 0;
let changedCount = 0;
let projectedCount = 0;
let projectedWithTxHashCount = 0;
let legacyDeleteCount = 0;
let legacyNoMatchCount = 0;
let legacyAmbiguousCount = 0;

for (const row of rows) {
  const payload = parsePayload(row.payload_json);
  const message = extractMessage(payload);
  const linkCandidates = collectMessageLinks(message);
  const text = extractText(row, message);
  if (!text.trim()) {
    continue;
  }

  const parsed = parseXxyyTelegramText(
    text,
    typeof message?.date === 'number' ? message.date * 1000 : row.event_time_ms || Date.now(),
    linkCandidates
  );

  const nextChain = parsed.chain || row.chain;
  const nextTokenAddress = parsed.tokenAddress || row.token_address;
  if (!nextChain || !nextTokenAddress) {
    continue;
  }

  const nextTxHash = parsed.txHash || row.tx_hash;
  const nextTrackedWalletAddress = parsed.trackedWalletAddress || row.tracked_wallet_address;
  const nextTokenSymbol = parsed.tokenSymbol ?? row.token_symbol;
  const nextMarketCapUsd = parsed.marketCapUsd ?? row.market_cap_usd;
  const nextPriceUsd = parsed.priceUsd ?? row.price_usd;
  const nextQuoteAmount = parsed.quoteAmount ?? row.quote_amount;
  const nextQuoteSymbol = parsed.quoteSymbol ?? row.quote_symbol;
  const nextAction = parsed.action ?? row.action;
  const nextActionLabel = parsed.actionLabel ?? row.action_label ?? null;
  const nextActionVariant = parsed.actionVariant ?? row.action_variant ?? null;
  const nextWalletLabel = parsed.walletLabel ?? row.wallet_label;
  const nextWalletGroupLabel = parsed.walletGroupLabel ?? row.wallet_group_label;
  const nextWalletAliasLabel = parsed.walletAliasLabel ?? row.wallet_alias_label;
  const nextEventTimeMs = parsed.eventTimeMs ?? row.event_time_ms;

  const changed =
    nextChain !== row.chain ||
    nextTokenAddress !== row.token_address ||
    (nextTokenSymbol || null) !== row.token_symbol ||
    (nextTxHash || null) !== row.tx_hash ||
    (nextMarketCapUsd ?? null) !== row.market_cap_usd ||
    (nextPriceUsd ?? null) !== row.price_usd ||
    (nextQuoteAmount ?? null) !== row.quote_amount ||
    (nextQuoteSymbol || null) !== row.quote_symbol ||
    (nextAction || null) !== row.action ||
    (nextActionLabel || null) !== (row.action_label || null) ||
    (nextActionVariant || null) !== (row.action_variant || null) ||
    (nextWalletLabel || null) !== row.wallet_label ||
    (nextWalletGroupLabel || null) !== row.wallet_group_label ||
    (nextWalletAliasLabel || null) !== row.wallet_alias_label ||
    (nextTrackedWalletAddress || null) !== row.tracked_wallet_address ||
    (nextEventTimeMs ?? null) !== row.event_time_ms ||
    text !== row.raw_text;

  updateStmt.run(
    nextChain,
    nextTokenAddress,
    normalize(nextTokenAddress),
    nextTokenSymbol || null,
    nextTxHash || null,
    normalize(nextTxHash) || null,
    nextMarketCapUsd ?? null,
    nextPriceUsd ?? null,
    nextQuoteAmount ?? null,
    nextQuoteSymbol || null,
    nextAction || null,
    nextActionLabel,
    nextActionVariant,
    nextWalletLabel || null,
    nextWalletGroupLabel || null,
    nextWalletAliasLabel || null,
    nextTrackedWalletAddress || null,
    normalize(nextTrackedWalletAddress) || null,
    nextEventTimeMs ?? null,
    text,
    Date.now(),
    row.id
  );

  const projected = await projectTelegramMonitorEvent({
    event: {
      chain: nextChain,
      tokenAddress: nextTokenAddress,
      tokenSymbol: nextTokenSymbol,
      txHash: nextTxHash,
      marketCapUsd: nextMarketCapUsd,
      priceUsd: nextPriceUsd,
      quoteAmount: nextQuoteAmount,
      quoteSymbol: nextQuoteSymbol,
      action: nextAction === 'buy' || nextAction === 'sell' || nextAction === 'send' ? nextAction : null,
      actionLabel:
        nextActionLabel === '建仓' ||
        nextActionLabel === '加仓' ||
        nextActionLabel === '减仓' ||
        nextActionLabel === '清仓' ||
        nextActionLabel === '发送'
          ? nextActionLabel
          : null,
      actionVariant:
        nextActionVariant === 'open' ||
        nextActionVariant === 'add' ||
        nextActionVariant === 'reduce' ||
        nextActionVariant === 'close' ||
        nextActionVariant === 'send'
          ? nextActionVariant
          : null,
      walletLabel: nextWalletLabel || null,
      walletGroupLabel: nextWalletGroupLabel || null,
      walletAliasLabel: nextWalletAliasLabel || null,
      trackedWalletAddress: nextTrackedWalletAddress || null,
      eventTimeMs: nextEventTimeMs ?? row.updated_at ?? Date.now(),
      rawText: text,
      messageLinks: linkCandidates,
      updatedAt: row.updated_at ?? Date.now(),
    },
  });

  if (projected) {
    upsertEventsFromFeedRows([projected], 'telegram-monitor-repair');
    projectedCount += 1;

    const normalizedChain = normalize(projected.activity.metadata.chain);
    const normalizedTrackedAddress = normalize(projected.activity.metadata.trackedAddress);
    const normalizedTxHash = normalize(projected.activity.metadata.txHash);
    if (normalizedChain && normalizedTrackedAddress && normalizedTxHash) {
      projectedWithTxHashCount += 1;

      const tokenFilter = normalize(projected.activity.metadata.token) || null;
      const actionFilter = normalize(projected.activity.metadata.txAction) || null;
      const timestamp = projected.activity.timestamp;
      const legacyCandidates = findLegacyEventCandidatesStmt.all(
        projected.user.id,
        normalizedChain,
        normalizedTrackedAddress,
        timestamp - CLEANUP_TIME_WINDOW_MS,
        timestamp + CLEANUP_TIME_WINDOW_MS,
        tokenFilter,
        tokenFilter,
        actionFilter,
        actionFilter,
        timestamp
      ) as LegacyEventCandidateRow[];

      if (legacyCandidates.length === 1) {
        const target = legacyCandidates[0];
        deleteLegacyEventStmt.run(target.rowid);
        legacyDeleteCount += 1;
        console.log(
          `[repair-cleanup] deleted legacy rowid=${target.rowid} event_id=${target.event_id} ts=${target.timestamp}`
        );
      } else if (legacyCandidates.length === 0) {
        legacyNoMatchCount += 1;
      } else {
        legacyAmbiguousCount += 1;
        console.warn(
          `[repair-cleanup] ambiguous tx=${normalizedTxHash} user=${projected.user.id} candidates=${legacyCandidates
            .map((item) => `${item.rowid}:${item.event_id}`)
            .join(',')}`
        );
      }
    }
  }

  repairedCount += 1;
  if (changed) {
    changedCount += 1;
    console.log(
      `[repair] updated id=${row.id} action=${nextAction || 'null'} wallet=${nextWalletLabel || 'null'} tracked=${nextTrackedWalletAddress || 'null'}`
    );
  } else {
    console.log(`[repair] unchanged id=${row.id}`);
  }
}

console.log(
  `[repair] completed rows=${repairedCount} changed=${changedCount} projected=${projectedCount} projectedWithTxHash=${projectedWithTxHashCount} legacyDeleted=${legacyDeleteCount} legacyNoMatch=${legacyNoMatchCount} legacyAmbiguous=${legacyAmbiguousCount}`
);
