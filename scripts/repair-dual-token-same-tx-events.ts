/**
 * Repair same-tx multi-token collapses caused by legacy 3-part xxyy-monitor event ids
 * and cross-token quote summing.
 *
 * Usage:
 *   NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/repair-dual-token-same-tx-events.ts
 *   NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/repair-dual-token-same-tx-events.ts --apply
 *   NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/repair-dual-token-same-tx-events.ts --apply --tx=0xf14b...
 *   NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/repair-dual-token-same-tx-events.ts --days=7
 */

import './server-only-shim.cjs';

import { scoreFeedRowsAgainstDatabase } from '../lib/server/activityImportanceService';
import { upsertEventsFromFeedRows } from '../lib/server/eventsRepo';
import { getDb } from '../lib/server/sqlite';
import { buildActivityFromSnapshot } from '../lib/server/telegramMonitorActivity';
import { summarizeTelegramMonitorTxProvisional } from '../lib/server/telegramMonitorRepo';
import { upsertTelegramMonitorTxStateProvisional } from '../lib/server/telegramMonitorTxStateRepo';
import { listTrackedUsers } from '../lib/server/trackedUsersRepo';
import type { User } from '../types';

type DualTokenGroup = {
  chain: string;
  tracked_wallet_address: string;
  tracked_wallet_address_lower: string;
  tx_hash: string;
  tx_hash_lower: string;
  token_count: number;
  tokens: string;
};

type TokenLeg = {
  token_address: string;
  token_symbol: string | null;
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

function isBusyError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code || '')
      : '';
  return code.includes('BUSY') || /database is locked|SQLITE_BUSY/i.test(message);
}

async function withBusyRetry<T>(label: string, fn: () => T | Promise<T>, attempts = 8): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isBusyError(error) || attempt === attempts) {
        throw error;
      }
      const delay = Math.min(5_000, 200 * 2 ** (attempt - 1));
      console.error(JSON.stringify({ busyRetry: true, label, attempt, delay }));
      sleepMs(delay);
    }
  }
  throw lastError;
}

function parseArgs(argv: string[]) {
  let apply = false;
  let txFilter: string | null = null;
  let days = 14;
  let limit = 500;
  for (const arg of argv) {
    if (arg === '--apply') apply = true;
    else if (arg.startsWith('--tx=')) txFilter = arg.slice('--tx='.length).trim();
    else if (arg.startsWith('--days=')) {
      const n = Number.parseInt(arg.slice('--days='.length), 10);
      if (Number.isFinite(n) && n > 0) days = n;
    } else if (arg.startsWith('--limit=')) {
      const n = Number.parseInt(arg.slice('--limit='.length), 10);
      if (Number.isFinite(n) && n > 0) limit = n;
    }
  }
  return { apply, txFilter, days, limit };
}

function buildLegacyEventId(chain: string, wallet: string, txHash: string) {
  return `xxyy-monitor:${normalize(chain)}:${normalize(wallet)}:${normalize(txHash)}`;
}

async function main() {
  const { apply, txFilter, days, limit } = parseArgs(process.argv.slice(2));
  const db = getDb();
  try {
    db.pragma('busy_timeout = 5000');
  } catch {
    // ignore
  }

  const sinceMs = Date.now() - days * 86_400_000;
  const allUsers = listTrackedUsers();
  const usersById = new Map(allUsers.map((user) => [user.id, user] as const));
  const usersByWallet = new Map<string, User>();
  for (const user of allUsers) {
    for (const address of user.addresses || []) {
      const key = normalize(address.address);
      if (key) usersByWallet.set(key, user);
    }
  }

  const groups = (
    txFilter
      ? (db
          .prepare(
            `SELECT
               chain,
               tracked_wallet_address,
               tracked_wallet_address_lower,
               tx_hash,
               tx_hash_lower,
               COUNT(DISTINCT token_address_lower) AS token_count,
               GROUP_CONCAT(DISTINCT token_symbol) AS tokens
             FROM telegram_monitor_events
             WHERE provider = 'xxyy'
               AND tx_hash_lower = ?
               AND tracked_wallet_address_lower IS NOT NULL
               AND tracked_wallet_address_lower != ''
             GROUP BY chain, tracked_wallet_address_lower, tx_hash_lower
             HAVING token_count > 1
             LIMIT ?`
          )
          .all(normalize(txFilter), limit) as DualTokenGroup[])
      : (db
          .prepare(
            `SELECT
               chain,
               tracked_wallet_address,
               tracked_wallet_address_lower,
               tx_hash,
               tx_hash_lower,
               COUNT(DISTINCT token_address_lower) AS token_count,
               GROUP_CONCAT(DISTINCT token_symbol) AS tokens
             FROM telegram_monitor_events
             WHERE provider = 'xxyy'
               AND tx_hash_lower IS NOT NULL
               AND tx_hash_lower != ''
               AND tracked_wallet_address_lower IS NOT NULL
               AND tracked_wallet_address_lower != ''
               AND COALESCE(event_time_ms, updated_at) >= ?
             GROUP BY chain, tracked_wallet_address_lower, tx_hash_lower
             HAVING token_count > 1
             ORDER BY MAX(COALESCE(event_time_ms, updated_at)) DESC
             LIMIT ?`
          )
          .all(sinceMs, limit) as DualTokenGroup[])
  );

  console.log(
    JSON.stringify(
      {
        mode: apply ? 'apply' : 'dry-run',
        days,
        limit,
        txFilter,
        dualTokenGroups: groups.length,
      },
      null,
      2
    )
  );

  let repairedGroups = 0;
  let skippedOk = 0;
  let skippedMissingUser = 0;
  let deletedLegacy = 0;
  let upsertedLegs = 0;
  let failedGroups = 0;

  for (const group of groups) {
    const legs = db
      .prepare(
        `SELECT token_address, token_symbol
         FROM telegram_monitor_events
         WHERE provider = 'xxyy'
           AND chain = ?
           AND tx_hash_lower = ?
           AND tracked_wallet_address_lower = ?
           AND token_address IS NOT NULL
           AND token_address != ''
         GROUP BY token_address_lower
         ORDER BY MIN(id)`
      )
      .all(group.chain, group.tx_hash_lower, group.tracked_wallet_address_lower) as TokenLeg[];

    if (legs.length < 2) {
      continue;
    }

    const legacyEventId = buildLegacyEventId(group.chain, group.tracked_wallet_address, group.tx_hash);
    const legacyRow = db
      .prepare(
        `SELECT event_id, user_id, token,
                json_extract(activity_json, '$.metadata.quoteAmount') AS quote_amount
         FROM events
         WHERE event_id = ?
         LIMIT 1`
      )
      .get(legacyEventId) as
      | { event_id: string; user_id: string; token: string | null; quote_amount: string | null }
      | undefined;

    const feedRows = db
      .prepare(
        `SELECT event_id, user_id, token,
                json_extract(activity_json, '$.metadata.quoteAmount') AS quote_amount,
                json_extract(activity_json, '$.metadata.tokenAddress') AS token_address
         FROM events
         WHERE source = 'blockchain'
           AND chain = ?
           AND LOWER(COALESCE(tx_hash, '')) = ?
           AND LOWER(COALESCE(address, '')) = ?
           AND ingest_source LIKE 'telegram-monitor%'`
      )
      .all(group.chain, group.tx_hash_lower, group.tracked_wallet_address_lower) as Array<{
      event_id: string;
      user_id: string;
      token: string | null;
      quote_amount: string | null;
      token_address: string | null;
    }>;

    const tokenAwareCount = feedRows.filter((row) => {
      const ca = normalize(row.token_address);
      return ca && row.event_id.includes(ca);
    }).length;

    const needsRepair =
      Boolean(legacyRow) ||
      tokenAwareCount < legs.length ||
      feedRows.some((row) => {
        const ca = normalize(row.token_address);
        return !ca || !row.event_id.includes(ca);
      });

    if (!needsRepair) {
      skippedOk += 1;
      continue;
    }

    const userId = legacyRow?.user_id || feedRows[0]?.user_id || null;
    const txStateUserId = (
      db
        .prepare(
          `SELECT user_id
           FROM telegram_monitor_tx_states
           WHERE chain = ?
             AND tracked_wallet_address_lower = ?
             AND tx_hash_lower = ?
           LIMIT 1`
        )
        .get(group.chain, group.tracked_wallet_address_lower, group.tx_hash_lower) as
        | { user_id: string }
        | undefined
    )?.user_id;
    const user: User | null =
      (userId ? usersById.get(userId) || null : null) ||
      (txStateUserId ? usersById.get(txStateUserId) || null : null) ||
      usersByWallet.get(group.tracked_wallet_address_lower) ||
      null;
    if (!user) {
      skippedMissingUser += 1;
      console.log(
        JSON.stringify({
          skip: true,
          reason: 'missing-user',
          chain: group.chain,
          wallet: group.tracked_wallet_address,
          tx: group.tx_hash,
          tokens: group.tokens,
        })
      );
      continue;
    }

    console.log(
      JSON.stringify({
        repair: true,
        chain: group.chain,
        wallet: group.tracked_wallet_address,
        tx: group.tx_hash,
        tokens: group.tokens,
        legs: legs.map((leg) => leg.token_symbol || leg.token_address),
        legacyEventId: legacyRow?.event_id || null,
        existingFeedRows: feedRows.length,
        tokenAwareCount,
      })
    );

    if (!apply) {
      repairedGroups += 1;
      continue;
    }

    try {
      await withBusyRetry(`delete:${group.tx_hash_lower}`, () => {
        const deleteResult = db
          .prepare(
            `DELETE FROM events
             WHERE source = 'blockchain'
               AND chain = ?
               AND LOWER(COALESCE(tx_hash, '')) = ?
               AND LOWER(COALESCE(address, '')) = ?
               AND ingest_source LIKE 'telegram-monitor%'`
          )
          .run(group.chain, group.tx_hash_lower, group.tracked_wallet_address_lower);
        deletedLegacy += Number(deleteResult.changes || 0);
      });

      for (const leg of legs) {
        const summary = summarizeTelegramMonitorTxProvisional({
          chain: group.chain,
          trackedWalletAddress: group.tracked_wallet_address,
          txHash: group.tx_hash,
          tokenAddress: leg.token_address,
        });
        if (!summary) {
          continue;
        }

        const txState = upsertTelegramMonitorTxStateProvisional({
          userId: user.id,
          chain: summary.chain,
          trackedWalletAddress: summary.trackedWalletAddress,
          txHash: summary.txHash,
          tokenAddress: summary.tokenAddress,
          tokenSymbol: summary.tokenSymbol,
          provisionalAction: summary.action,
          provisionalActionLabel: summary.actionLabel,
          provisionalActionVariant: summary.actionVariant,
          provisionalQuoteAmount: summary.quoteAmount,
          provisionalQuoteSymbol: summary.quoteSymbol,
          provisionalTokenAmount: summary.tokenAmount,
          provisionalTokenSymbol: summary.tokenSymbol,
          provisionalPriceUsd: summary.priceUsd,
          provisionalMarketCapUsd: summary.marketCapUsd,
          provisionalRawText: summary.rawText,
          provisionalMessageLinks: summary.messageLinks,
          provisionalWalletLabel: summary.walletLabel,
          provisionalWalletGroupLabel: summary.walletGroupLabel,
          provisionalWalletAliasLabel: summary.walletAliasLabel,
          eventTimeMs: summary.eventTimeMs,
        });
        if (!txState) {
          continue;
        }

        // Force provisional rebuild (ignore stale reconciled canonical).
        const activity = await buildActivityFromSnapshot({
          user,
          chain: summary.chain,
          tokenAddress: summary.tokenAddress,
          tokenSymbol: summary.tokenSymbol,
          txHash: summary.txHash,
          marketCapUsd: summary.marketCapUsd,
          quoteAmount: summary.quoteAmount,
          quoteSymbol: summary.quoteSymbol,
          tokenAmount: summary.tokenAmount,
          explicitPriceUsd: summary.priceUsd,
          rawText: summary.rawText,
          action: summary.action,
          actionLabel: summary.actionLabel,
          actionVariant: summary.actionVariant,
          walletLabel: summary.walletLabel,
          walletGroupLabel: summary.walletGroupLabel,
          walletAliasLabel: summary.walletAliasLabel,
          eventTimeMs: summary.eventTimeMs,
          trackedAddress: summary.trackedWalletAddress,
          monitorReconciliationStatus: 'pending',
          monitorReconciledSource: 'xxyy',
        });

        const scored = scoreFeedRowsAgainstDatabase([{ user, activity }])[0] || { user, activity };
        await withBusyRetry(`upsert:${group.tx_hash_lower}:${leg.token_address}`, () => {
          upsertEventsFromFeedRows([scored], 'telegram-monitor-repair-dual-token');
        });

        // Keep canonical in sync with the repaired activity.
        db.prepare(
          `UPDATE telegram_monitor_tx_states
           SET canonical_activity_json = ?,
               updated_at = ?
           WHERE chain = ?
             AND tracked_wallet_address_lower = ?
             AND tx_hash_lower = ?
             AND token_address_lower = ?`
        ).run(
          JSON.stringify(scored.activity),
          Date.now(),
          normalize(summary.chain),
          normalize(summary.trackedWalletAddress),
          normalize(summary.txHash),
          normalize(summary.tokenAddress)
        );

        upsertedLegs += 1;
        sleepMs(50);
      }

      repairedGroups += 1;
      sleepMs(100);
    } catch (error) {
      failedGroups += 1;
      console.error(
        JSON.stringify({
          failed: true,
          chain: group.chain,
          wallet: group.tracked_wallet_address,
          tx: group.tx_hash,
          error: error instanceof Error ? error.message : String(error),
        })
      );
      sleepMs(500);
    }
  }

  console.log(
    JSON.stringify(
      {
        done: true,
        mode: apply ? 'apply' : 'dry-run',
        repairedGroups,
        skippedOk,
        skippedMissingUser,
        failedGroups,
        deletedLegacy: apply ? deletedLegacy : 0,
        upsertedLegs: apply ? upsertedLegs : 0,
      },
      null,
      2
    )
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
