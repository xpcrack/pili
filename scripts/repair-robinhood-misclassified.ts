import Database from 'better-sqlite3';
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { parseXxyyTelegramText } from '../lib/server/xxyyTelegramParser';

type MonitorEventRow = {
  id: number;
  source_chat_id: string | null;
  source_message_id: number | null;
  chain: string;
  token_address: string;
  token_symbol: string | null;
  action: string | null;
  action_label: string | null;
  action_variant: string | null;
  tracked_wallet_address: string | null;
  event_time_ms: number | null;
  market_cap_usd: number | null;
  price_usd: number | null;
  quote_amount: number | null;
  quote_symbol: string | null;
  wallet_label: string | null;
  wallet_group_label: string | null;
  wallet_alias_label: string | null;
  raw_text: string;
  message_links_json: string | null;
  tx_hash: string | null;
};

function loadEnvFile(filePath: string) {
  if (!existsSync(filePath)) return {} as Record<string, string>;
  const out: Record<string, string> = {};
  for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx < 0) continue;
    let key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function b64url(input: Buffer | string) {
  return Buffer.from(input).toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function signInternalBidToken(secret: string, scope = 'internal:bid:write') {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now,
    exp: now + 60,
    svc: 'bid' as const,
    scope,
  };
  const payloadB64 = b64url(JSON.stringify(payload));
  const sig = createHmac('sha256', secret).update(payloadB64).digest();
  return `${payloadB64}.${b64url(sig)}`;
}

function parseLinks(raw: string | null | undefined) {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch {
    return [] as string[];
  }
}

function isRobinhoodMisclassified(row: MonitorEventRow) {
  if ((row.chain || '').toLowerCase() === 'robinhood') return false;
  const text = row.raw_text || '';
  const links = parseLinks(row.message_links_json).join('\n');
  if (/(?:^|\n)\s*#(?:🟢)?Robinhood\s*[；;。.]?\s*(?:\n|$)/im.test(text)) return true;
  if (/robinhoodchain\.blockscout\.com|rpc\.mainnet\.chain\.robinhood\.com/i.test(text)) return true;
  if (/xxyy\.io\/robin(?:hood)?\//i.test(links) || /robinhoodchain\.blockscout\.com/i.test(links)) return true;
  return false;
}

function normalizeAddress(value: string | null | undefined) {
  return (value || '').trim();
}

function extractTxHash(links: string[], rawText: string) {
  for (const link of links) {
    const m = link.match(/\/tx\/(0x[a-fA-F0-9]{64})/i);
    if (m?.[1]) return m[1];
  }
  const textMatch = rawText.match(/\b(?:TX|Tx|tx|Hash|哈希)\s*:\s*(0x[a-fA-F0-9]{64})/);
  return textMatch?.[1] || null;
}

function buildEventId(params: {
  sourceChatId: string | null;
  sourceMessageId: number | null;
  chain: string;
  trackedWalletAddress: string | null;
  txHash: string | null;
  tokenAddress: string;
  eventTimeMs: number;
}) {
  if (params.sourceChatId && typeof params.sourceMessageId === 'number') {
    return `xxyy:${params.sourceChatId}:${params.sourceMessageId}`;
  }
  return [
    'xxyy',
    params.chain,
    params.trackedWalletAddress || '',
    params.txHash || '',
    params.tokenAddress,
    String(params.eventTimeMs),
  ].join(':');
}

async function main() {
  const repoRoot = process.cwd();
  const dbPath = path.join(repoRoot, '.data', 'web3-feed.sqlite');
  const env = {
    ...loadEnvFile(path.join(repoRoot, '.env.local')),
    ...loadEnvFile(path.join(repoRoot, '.env')),
    ...process.env,
  };
  const secret = (env.INTERNAL_BID_HMAC_SECRET || '').trim();
  const pushUrl = (env.BID_FEED_PUSH_URL || 'http://127.0.0.1:5050/api/internal/pilipili/feed-events').trim();
  if (!secret) throw new Error('INTERNAL_BID_HMAC_SECRET missing');

  const db = new Database(dbPath);
  const rows = db.prepare(
    `SELECT id, source_chat_id, source_message_id, chain, token_address, token_symbol,
            action, action_label, action_variant, tracked_wallet_address, event_time_ms,
            market_cap_usd, price_usd, quote_amount, quote_symbol, wallet_label,
            wallet_group_label, wallet_alias_label, raw_text, message_links_json, tx_hash
     FROM telegram_monitor_events
     WHERE chain != 'robinhood'
       AND (
         raw_text LIKE '%#🟢Robinhood%'
         OR raw_text LIKE '%#Robinhood%'
         OR message_links_json LIKE '%xxyy.io/robin/%'
         OR message_links_json LIKE '%xxyy.io/robinhood/%'
         OR message_links_json LIKE '%robinhoodchain.blockscout%'
       )
     ORDER BY event_time_ms ASC, id ASC`
  ).all() as MonitorEventRow[];

  const targets = rows.filter(isRobinhoodMisclassified);
  console.log(`found ${targets.length} misclassified robinhood events`);

  const updateEvent = db.prepare(
    `UPDATE telegram_monitor_events
     SET chain = 'robinhood',
         projected_activity_json = NULL,
         updated_at = ?
     WHERE id = ?`
  );
  const updateTxState = db.prepare(
    `UPDATE telegram_monitor_tx_states
     SET chain = 'robinhood',
         reconciliation_status = CASE WHEN reconciliation_status = 'reconciled' THEN reconciliation_status ELSE 'failed' END,
         last_error = CASE WHEN reconciliation_status = 'reconciled' THEN last_error ELSE 'robinhood-feed-only-skip-okx' END,
         next_retry_at = NULL,
         repair_claimed_at = NULL,
         updated_at = ?
     WHERE lower(token_address) = lower(?)
       AND (
         (? != '' AND lower(tx_hash) = lower(?))
         OR (? = '' AND lower(tracked_wallet_address) = lower(?))
       )`
  );

  const now = Date.now();
  const tx = db.transaction((items: MonitorEventRow[]) => {
    for (const item of items) {
      updateEvent.run(now, item.id);
      const links = parseLinks(item.message_links_json);
      const txHash = normalizeAddress(item.tx_hash) || extractTxHash(links, item.raw_text) || '';
      const tracked = normalizeAddress(item.tracked_wallet_address);
      updateTxState.run(
        now,
        item.token_address,
        txHash,
        txHash,
        txHash,
        tracked,
      );
    }
  });
  tx(targets);
  console.log(`updated sqlite events/tx_states to robinhood: ${targets.length}`);

  // Build unique push payloads by CA + event source message, prefer latest.
  const byKey = new Map<string, MonitorEventRow>();
  for (const item of targets) {
    const key = `${item.source_chat_id || ''}:${item.source_message_id || item.id}`;
    byKey.set(key, item);
  }

  const events = Array.from(byKey.values()).map((item) => {
    const links = parseLinks(item.message_links_json);
    const parsed = parseXxyyTelegramText(item.raw_text, item.event_time_ms || now, links);
    const chain = 'robinhood';
    const tokenAddress = normalizeAddress(item.token_address || parsed.tokenAddress);
    const trackedWalletAddress = normalizeAddress(
      item.tracked_wallet_address || parsed.trackedWalletAddress
    );
    const txHash = normalizeAddress(item.tx_hash) || extractTxHash(links, item.raw_text) || parsed.txHash;
    const eventTimeMs = item.event_time_ms || parsed.eventTimeMs || now;
    const action = (item.action || parsed.action || null) as 'buy' | 'sell' | 'send' | null;
    const actionVariant = (item.action_variant || parsed.actionVariant || null) as
      | 'open' | 'add' | 'reduce' | 'close' | 'send' | null;
    const userAlias = item.wallet_alias_label || parsed.walletAliasLabel || item.wallet_label || parsed.walletLabel || 'unknown';
    const userName = String(userAlias).replace(/#\d+$/, '') || 'unknown';

    return {
      eventId: buildEventId({
        sourceChatId: item.source_chat_id,
        sourceMessageId: item.source_message_id,
        chain,
        trackedWalletAddress,
        txHash,
        tokenAddress,
        eventTimeMs,
      }),
      userId: `repair:${userName}`,
      userName,
      sourceAddressName: item.wallet_alias_label || parsed.walletAliasLabel || null,
      chain,
      trackedWalletAddress,
      trackedWalletAddressRaw: trackedWalletAddress,
      tokenAddress,
      tokenSymbol: item.token_symbol || parsed.tokenSymbol,
      txHash,
      action,
      actionVariant,
      eventTimeMs,
      walletAliasLabel: item.wallet_alias_label || parsed.walletAliasLabel,
      walletGroupLabel: item.wallet_group_label || parsed.walletGroupLabel,
      marketCapUsd: item.market_cap_usd ?? parsed.marketCapUsd,
      messageLinks: links,
      // Keep original alias for BID binding via single-user mode / name matching downstream.
      _sourceMessageId: item.source_message_id,
      _tokenAddress: tokenAddress,
    };
  }).filter((item) => item.tokenAddress && item.trackedWalletAddress);

  // Prefer real user ids from tx_states when available.
  const resolveUserByTx = db.prepare(
    `SELECT user_id, provisional_wallet_alias_label
     FROM telegram_monitor_tx_states
     WHERE lower(token_address) = lower(?)
       AND lower(tx_hash) = lower(?)
     ORDER BY updated_at DESC
     LIMIT 1`
  );
  const resolveUserByWallet = db.prepare(
    `SELECT user_id, provisional_wallet_alias_label
     FROM telegram_monitor_tx_states
     WHERE lower(token_address) = lower(?)
       AND lower(tracked_wallet_address) = lower(?)
     ORDER BY updated_at DESC
     LIMIT 1`
  );
  const resolveUserByToken = db.prepare(
    `SELECT user_id, provisional_wallet_alias_label
     FROM telegram_monitor_tx_states
     WHERE lower(token_address) = lower(?)
     ORDER BY updated_at DESC
     LIMIT 1`
  );
  for (const event of events as any[]) {
    const row = (
      (event.txHash && resolveUserByTx.get(event.tokenAddress, event.txHash))
      || (event.trackedWalletAddress && resolveUserByWallet.get(event.tokenAddress, event.trackedWalletAddress))
      || resolveUserByToken.get(event.tokenAddress)
    ) as { user_id?: string; provisional_wallet_alias_label?: string } | undefined;
    if (row?.user_id) {
      event.userId = row.user_id;
    }
    if (!event.sourceAddressName && row?.provisional_wallet_alias_label) {
      event.sourceAddressName = row.provisional_wallet_alias_label;
    }
  }

  // Push in chunks to BID.
  const chunkSize = 20;
  let pushed = 0;
  let failed = 0;
  for (let i = 0; i < events.length; i += chunkSize) {
    const chunk = events.slice(i, i + chunkSize).map((event) => {
      const { _sourceMessageId, _tokenAddress, ...rest } = event as any;
      return rest;
    });
    const token = signInternalBidToken(secret);
    try {
      const response = await fetch(pushUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ events: chunk, trades: [] }),
      });
      const text = await response.text();
      if (!response.ok) {
        failed += chunk.length;
        console.error(`push failed status=${response.status} body=${text}`);
      } else {
        pushed += chunk.length;
        console.log(`pushed ${chunk.length}: ${text}`);
      }
    } catch (error) {
      failed += chunk.length;
      console.error('push threw', error);
    }
  }

  // Cleanup wrong ethereum projected events in pili events table for these CAs.
  const cas = Array.from(new Set(events.map((event) => event.tokenAddress.toLowerCase())));
  const cleanupEvents = db.prepare(
    `UPDATE events
     SET chain = 'robinhood',
         metadata_json = json_set(COALESCE(metadata_json, '{}'), '$.chain', 'robinhood'),
         activity_json = json_set(COALESCE(activity_json, '{}'), '$.metadata.chain', 'robinhood'),
         updated_at = ?
     WHERE lower(json_extract(metadata_json, '$.tokenAddress')) = ?
       AND (chain = 'ethereum' OR json_extract(metadata_json, '$.chain') = 'ethereum')`
  );
  const cleanupTx = db.transaction(() => {
    for (const ca of cas) {
      cleanupEvents.run(now, ca);
    }
  });
  cleanupTx();

  console.log(JSON.stringify({
    sqliteUpdated: targets.length,
    uniquePushEvents: events.length,
    uniqueCas: cas.length,
    pushed,
    failed,
    sampleCas: cas.slice(0, 10),
  }, null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
