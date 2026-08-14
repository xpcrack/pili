/**
 * Repair telegram_monitor_tx_states where OKX reconcile collapsed the trade token
 * to UNKNOWN / native mint (So1111…), while provisional XXYY data still has the real ticker.
 *
 * Writes in small SQL batches (no per-row heal path) to reduce SQLITE_BUSY with prod WAL.
 *
 * Usage:
 *   NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/repair-collapsed-unknown-canonical.ts
 *   NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/repair-collapsed-unknown-canonical.ts --apply
 *   NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/repair-collapsed-unknown-canonical.ts --apply --tx=3dtgw8Ay...
 */

import './server-only-shim.cjs';

import { getDb } from '../lib/server/sqlite';
import { repairCollapsedCanonicalActivitySync } from '../lib/server/telegramMonitorActivity';
import { listTrackedUsers } from '../lib/server/trackedUsersRepo';
import type { Activity, User } from '../types';

const SOLANA_NATIVE_MINTS = new Set([
  'so11111111111111111111111111111111111111111',
  'so11111111111111111111111111111111111111112',
]);
const NATIVE_SYMBOLS = new Set(['sol', 'wsol', 'bnb', 'wbnb', 'eth', 'weth']);
const PLACEHOLDER_SYMBOLS = new Set(['unknown', 'token', '']);

type CandidateRow = {
  id: number;
  user_id: string;
  chain: string;
  tracked_wallet_address: string;
  tracked_wallet_address_lower?: string;
  tx_hash: string;
  tx_hash_lower?: string;
  token_address: string | null;
  token_address_lower?: string | null;
  token_symbol: string | null;
  provisional_token_symbol: string | null;
  provisional_action: string | null;
  provisional_action_label: string | null;
  provisional_action_variant: string | null;
  provisional_quote_amount: number | null;
  provisional_quote_symbol: string | null;
  provisional_token_amount: number | null;
  provisional_price_usd: number | null;
  provisional_market_cap_usd: number | null;
  provisional_raw_text: string | null;
  provisional_wallet_label: string | null;
  provisional_wallet_group_label: string | null;
  provisional_wallet_alias_label: string | null;
  event_time_ms: number | null;
  reconciliation_status: string;
  reconciled_source: string | null;
  canonical_activity_json: string | null;
};

type PendingHeal = {
  row: CandidateRow;
  user: User;
  original: Activity;
  repaired: Activity;
  from: string;
  to: string;
};

function normalize(value: string | null | undefined) {
  return (value || '').trim().toLowerCase();
}

function sleepMs(ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // busy-wait: keep repair script dependency-free under tsx
  }
}

function isCollapsedCanonical(token: string | null | undefined, tokenAddress: string | null | undefined, chain: string) {
  const symbol = normalize(token);
  const address = normalize(tokenAddress);
  if (PLACEHOLDER_SYMBOLS.has(symbol)) return true;
  if (NATIVE_SYMBOLS.has(symbol)) return true;
  if (normalize(chain) === 'solana' && SOLANA_NATIVE_MINTS.has(address)) return true;
  return false;
}

function parseArgs(argv: string[]) {
  let apply = false;
  let txFilter: string | null = null;
  let limit = 5000;
  for (const arg of argv) {
    if (arg === '--apply') apply = true;
    else if (arg.startsWith('--tx=')) txFilter = arg.slice('--tx='.length).trim();
    else if (arg.startsWith('--limit=')) {
      const n = Number.parseInt(arg.slice('--limit='.length), 10);
      if (Number.isFinite(n) && n > 0) limit = n;
    }
  }
  return { apply, txFilter, limit };
}

function writeBatch(pending: PendingHeal[]) {
  if (pending.length === 0) return;
  const db = getDb();
  const now = Date.now();
  const updateState = db.prepare(
    `UPDATE telegram_monitor_tx_states
     SET canonical_activity_json = ?,
         updated_at = ?
     WHERE id = ?`
  );
  const updateEventById = db.prepare(
    `UPDATE events
     SET token = ?,
         action = ?,
         content = ?,
         metadata_json = ?,
         activity_json = ?,
         updated_at = ?
     WHERE event_id = ?`
  );
  const updateEventByTx = db.prepare(
    `UPDATE events
     SET token = ?,
         action = ?,
         content = ?,
         metadata_json = ?,
         activity_json = ?,
         updated_at = ?
     WHERE lower(tx_hash) = lower(?)
       AND user_id = ?
       AND (ingest_source LIKE 'telegram-monitor%' OR event_id LIKE 'xxyy-monitor:%')`
  );

  const runOnce = db.transaction(() => {
    for (const item of pending) {
      const activityJson = JSON.stringify(item.repaired);
      const metadataJson = JSON.stringify(item.repaired.metadata || {});
      const token = String(item.repaired.metadata.token || '');
      const action = String(item.repaired.metadata.txAction || (item.repaired.metadata as { action?: unknown }).action || '');
      const content = String(item.repaired.content || '');

      updateState.run(activityJson, now, item.row.id);

      const eventId = String(item.repaired.id || item.original.id || '');
      if (eventId) {
        updateEventById.run(token, action, content, metadataJson, activityJson, now, eventId);
      }
      // Also heal any sibling event rows for the same user/tx under monitor ingest.
      updateEventByTx.run(
        token,
        action,
        content,
        metadataJson,
        activityJson,
        now,
        item.row.tx_hash,
        item.row.user_id
      );
    }
  });

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      runOnce();
      lastError = null;
      return;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/SQLITE_BUSY|database is locked|SQLITE_BUSY_SNAPSHOT/i.test(message) || attempt === 9) {
        throw error;
      }
      sleepMs(300 * (attempt + 1));
    }
  }
  if (lastError) throw lastError;
}

function main() {
  const { apply, txFilter, limit } = parseArgs(process.argv.slice(2));
  const db = getDb();
  const usersById = new Map(listTrackedUsers().map((user) => [user.id, user]));

  const rows = db
    .prepare(
      `SELECT
         id,
         user_id,
         chain,
         tracked_wallet_address,
         tx_hash,
         token_address,
         token_symbol,
         provisional_token_symbol,
         provisional_action,
         provisional_action_label,
         provisional_action_variant,
         provisional_quote_amount,
         provisional_quote_symbol,
         provisional_token_amount,
         provisional_price_usd,
         provisional_market_cap_usd,
         provisional_raw_text,
         provisional_wallet_label,
         provisional_wallet_group_label,
         provisional_wallet_alias_label,
         event_time_ms,
         reconciliation_status,
         reconciled_source,
         canonical_activity_json
       FROM telegram_monitor_tx_states
       WHERE reconciliation_status = 'reconciled'
         AND canonical_activity_json IS NOT NULL
         AND COALESCE(provisional_token_symbol, token_symbol, '') != ''
         AND token_address IS NOT NULL
         AND token_address != ''
         ${txFilter ? 'AND (tx_hash = ? OR tx_hash_lower = lower(?))' : ''}
       ORDER BY id DESC
       LIMIT ?`
    )
    .all(...(txFilter ? [txFilter, txFilter, limit] : [limit])) as CandidateRow[];

  let candidates = 0;
  let healed = 0;
  let skippedNoUser = 0;
  let skippedNotCollapsed = 0;
  let skippedNoChange = 0;
  let healErrors = 0;
  const samples: Array<{ id: number; tx: string; from: string; to: string; mint: string }> = [];
  const errorSamples: string[] = [];
  const pending: PendingHeal[] = [];

  for (const row of rows) {
    const provisionalSymbol = (row.provisional_token_symbol || row.token_symbol || '').trim();
    if (
      !provisionalSymbol ||
      NATIVE_SYMBOLS.has(normalize(provisionalSymbol)) ||
      PLACEHOLDER_SYMBOLS.has(normalize(provisionalSymbol))
    ) {
      continue;
    }
    if (SOLANA_NATIVE_MINTS.has(normalize(row.token_address))) {
      continue;
    }

    let canonical: Activity | null = null;
    try {
      canonical = row.canonical_activity_json ? (JSON.parse(row.canonical_activity_json) as Activity) : null;
    } catch {
      continue;
    }
    if (!canonical?.metadata) continue;

    if (!isCollapsedCanonical(canonical.metadata.token, canonical.metadata.tokenAddress, row.chain)) {
      skippedNotCollapsed += 1;
      continue;
    }

    candidates += 1;
    const user = usersById.get(row.user_id);
    if (!user) {
      skippedNoUser += 1;
      continue;
    }

    const beforeToken = String(canonical.metadata.token || '');
    const beforeAddress = String(canonical.metadata.tokenAddress || '');

    const repaired = repairCollapsedCanonicalActivitySync({
      user,
      state: {
        chain: row.chain,
        trackedWalletAddress: row.tracked_wallet_address,
        txHash: row.tx_hash,
        tokenAddress: row.token_address,
        tokenSymbol: row.token_symbol,
        provisionalAction: (row.provisional_action as 'buy' | 'sell' | 'send' | null) || null,
        provisionalActionLabel:
          (row.provisional_action_label as '建仓' | '加仓' | '减仓' | '清仓' | '发送' | null) || null,
        provisionalActionVariant:
          (row.provisional_action_variant as 'open' | 'add' | 'reduce' | 'close' | 'send' | null) || null,
        provisionalQuoteAmount: row.provisional_quote_amount,
        provisionalQuoteSymbol: row.provisional_quote_symbol,
        provisionalTokenAmount: row.provisional_token_amount,
        provisionalTokenSymbol: row.provisional_token_symbol,
        provisionalPriceUsd: row.provisional_price_usd,
        provisionalMarketCapUsd: row.provisional_market_cap_usd,
        provisionalRawText: row.provisional_raw_text,
        provisionalWalletLabel: row.provisional_wallet_label,
        provisionalWalletGroupLabel: row.provisional_wallet_group_label,
        provisionalWalletAliasLabel: row.provisional_wallet_alias_label,
        eventTimeMs: row.event_time_ms || Date.now(),
        reconciliationStatus: 'reconciled',
        reconciledSource:
          row.reconciled_source === 'okx-detail' ||
          row.reconciled_source === 'okx-address' ||
          row.reconciled_source === 'xxyy'
            ? row.reconciled_source
            : null,
      },
      canonicalActivity: canonical,
    });

    const afterToken = String(repaired.metadata.token || '');
    const afterAddress = String(repaired.metadata.tokenAddress || '');
    if (afterToken === beforeToken && afterAddress === beforeAddress) {
      skippedNoChange += 1;
      continue;
    }

    healed += 1;
    const sample = {
      id: row.id,
      tx: row.tx_hash,
      from: `${beforeToken}/${beforeAddress.slice(0, 8)}…`,
      to: `${afterToken}/${afterAddress.slice(0, 8)}…`,
      mint: row.token_address || '',
    };
    if (samples.length < 10) samples.push(sample);

    pending.push({
      row,
      user,
      original: canonical,
      repaired,
      from: sample.from,
      to: sample.to,
    });
  }

  if (apply && pending.length > 0) {
    // Write in small batches to reduce lock windows against prod writers.
    const batchSize = 20;
    for (let i = 0; i < pending.length; i += batchSize) {
      const batch = pending.slice(i, i + batchSize);
      try {
        writeBatch(batch);
        sleepMs(80);
      } catch (error) {
        healErrors += batch.length;
        healed -= batch.length;
        if (errorSamples.length < 5) {
          const message = error instanceof Error ? error.message : String(error);
          errorSamples.push(`batch@${i}: ${message}`);
        }
      }
    }
  }

  console.log(
    JSON.stringify(
      {
        mode: apply ? 'apply' : 'dry-run',
        scanned: rows.length,
        candidates,
        wouldHealOrHealed: healed,
        healErrors,
        skippedNotCollapsed,
        skippedNoUser,
        skippedNoChange,
        samples,
        errorSamples,
      },
      null,
      2
    )
  );

  if (!apply) {
    console.log('\nDry-run only. Re-run with --apply to write repairs.');
  }
}

main();
