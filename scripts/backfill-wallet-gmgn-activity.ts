/**
 * Backfill wallet buy/sell into events via GMGN portfolio activity.
 *
 *   npx tsx scripts/backfill-wallet-gmgn-activity.ts --user finn
 *   npx tsx scripts/backfill-wallet-gmgn-activity.ts --address CJ5f... --since-ms 1784453796000
 *   npx tsx scripts/backfill-wallet-gmgn-activity.ts --user finn --expect-tx 3eNh...
 */
import './server-only-shim.cjs';

import { getDb } from '../lib/server/sqlite';
import {
  fetchGmgnWalletActivity,
  inferChainsForAddress,
  normalizeGmgnActivityItems,
  type NormalizedLiveTrade,
} from '../lib/server/gmgnWalletActivity';
import { upsertLiveMonitorTrades } from '../lib/server/liveMonitorIngest';
import { listTrackedUsers } from '../lib/server/trackedUsersRepo';
import type { User } from '../types';

function parseArgs(argv: string[]) {
  const out: {
    user?: string;
    address?: string[];
    sinceMs?: number;
    limit: number;
    expectTx?: string;
    dryRun: boolean;
  } = { limit: 50, dryRun: false, address: [] };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--user' && next) {
      out.user = next;
      i += 1;
    } else if (arg === '--address' && next) {
      out.address = out.address || [];
      out.address.push(next);
      i += 1;
    } else if (arg === '--since-ms' && next) {
      out.sinceMs = Number(next);
      i += 1;
    } else if (arg === '--limit' && next) {
      out.limit = Math.max(1, Number(next) || 50);
      i += 1;
    } else if (arg === '--expect-tx' && next) {
      out.expectTx = next;
      i += 1;
    } else if (arg === '--dry-run') {
      out.dryRun = true;
    }
  }
  return out;
}

function resolveTargets(opts: {
  user?: string;
  address?: string[];
}): Array<{ user: User; address: string }> {
  const users = listTrackedUsers();
  const out: Array<{ user: User; address: string }> = [];
  const seen = new Set<string>();

  const push = (user: User, address: string) => {
    const key = `${user.id}:${address.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ user, address });
  };

  if (opts.user) {
    const needle = opts.user.trim().toLowerCase();
    const matched = users.filter(
      (u) =>
        u.id.toLowerCase() === needle ||
        (u.name || '').toLowerCase() === needle ||
        (u.handle || '').toLowerCase() === needle
    );
    if (matched.length === 0) {
      throw new Error(`no tracked user matched --user ${opts.user}`);
    }
    for (const user of matched) {
      for (const addr of user.addresses) {
        push(user, addr.address);
      }
    }
  }

  for (const raw of opts.address || []) {
    const lower = raw.trim().toLowerCase();
    if (!lower) continue;
    let found = false;
    for (const user of users) {
      for (const addr of user.addresses) {
        if (addr.address.toLowerCase() === lower) {
          push(user, addr.address);
          found = true;
        }
      }
    }
    if (!found) {
      throw new Error(`address not in tracked_addresses: ${raw}`);
    }
  }

  if (out.length === 0) {
    throw new Error('provide --user <name|id|handle> and/or --address <wallet>');
  }
  return out;
}

function defaultSinceMsForAddresses(addresses: string[]): number {
  const db = getDb();
  let maxTs = 0;
  for (const address of addresses) {
    const lower = address.toLowerCase();
    const row = db
      .prepare(
        `SELECT MAX(timestamp) AS ts FROM events
         WHERE LOWER(address) = ?
            OR event_id LIKE ?
            OR LOWER(json_extract(activity_json, '$.metadata.trackedAddress')) = ?`
      )
      .get(lower, `%${lower}%`, lower) as { ts: number | null } | undefined;
    if (row?.ts && row.ts > maxTs) maxTs = row.ts;
  }
  // if no prior events, last 7 days
  if (!maxTs) return Date.now() - 7 * 24 * 60 * 60 * 1000;
  return maxTs;
}

function fetchAllSince(params: {
  chain: string;
  wallet: string;
  afterTsSec: number;
  pageLimit: number;
}): { rawCount: number; trades: NormalizedLiveTrade[] } {
  const allItems: ReturnType<typeof fetchGmgnWalletActivity>['items'] = [];
  let cursor: string | undefined;
  let pages = 0;
  const maxPages = 40;

  while (pages < maxPages) {
    pages += 1;
    const page = fetchGmgnWalletActivity({
      chain: params.chain,
      wallet: params.wallet,
      limit: params.pageLimit,
      type: ['buy', 'sell'],
      cursor,
    });
    allItems.push(...page.items);
    if (!page.next || page.items.length === 0) break;

    // stop paging when oldest item on page is already before afterTs
    let oldest = Infinity;
    for (const it of page.items) {
      const ts = Number(it.timestamp || 0);
      if (ts > 0 && ts < oldest) oldest = ts;
    }
    if (Number.isFinite(oldest) && oldest <= params.afterTsSec) break;
    cursor = page.next;
  }

  const trades = normalizeGmgnActivityItems(allItems, {
    wallet: params.wallet,
    chain: params.chain,
    after_ts: params.afterTsSec,
    min_cost_usd: 0,
  });
  return { rawCount: allItems.length, trades };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const targets = resolveTargets({ user: opts.user, address: opts.address });
  const uniqueAddrs = [...new Set(targets.map((t) => t.address))];
  const sinceMs =
    opts.sinceMs != null && Number.isFinite(opts.sinceMs)
      ? opts.sinceMs
      : defaultSinceMsForAddresses(uniqueAddrs);
  const afterTsSec = Math.floor(sinceMs / 1000);

  console.log('[backfill-wallet-gmgn] targets', targets.length, 'since', new Date(sinceMs).toISOString());

  let totalRaw = 0;
  let totalUpserted = 0;
  const seenTx = new Set<string>();
  const byChain: Record<string, number> = {};

  // group by user so we upsert once per user batch
  const byUser = new Map<string, { user: User; addresses: string[] }>();
  for (const t of targets) {
    const cur = byUser.get(t.user.id) || { user: t.user, addresses: [] };
    if (!cur.addresses.some((a) => a.toLowerCase() === t.address.toLowerCase())) {
      cur.addresses.push(t.address);
    }
    byUser.set(t.user.id, cur);
  }

  for (const { user, addresses } of byUser.values()) {
    const trades: NormalizedLiveTrade[] = [];
    for (const address of addresses) {
      const chains = inferChainsForAddress(address);
      for (const chain of chains) {
        try {
          const { rawCount, trades: pageTrades } = fetchAllSince({
            chain,
            wallet: address,
            afterTsSec,
            pageLimit: opts.limit,
          });
          totalRaw += rawCount;
          console.log(
            `  ${user.name} ${address.slice(0, 8)}… chain=${chain} raw=${rawCount} kept=${pageTrades.length}`
          );
          for (const trade of pageTrades) {
            trades.push(trade);
            if (trade.txHash) seenTx.add(trade.txHash.toLowerCase());
            byChain[trade.chain] = (byChain[trade.chain] || 0) + 1;
          }
        } catch (error) {
          console.error(
            `  FAIL ${user.name} ${address} chain=${chain}:`,
            error instanceof Error ? error.message : error
          );
        }
      }
    }

    if (opts.dryRun) {
      console.log(`[dry-run] would upsert ${trades.length} for ${user.name}`);
      totalUpserted += trades.length;
      continue;
    }

    // Chunk + retry: production pili holds the same SQLite file.
    const chunkSize = 20;
    for (let i = 0; i < trades.length; i += chunkSize) {
      const chunk = trades.slice(i, i + chunkSize);
      let lastError: unknown;
      for (let attempt = 1; attempt <= 8; attempt += 1) {
        try {
          const result = upsertLiveMonitorTrades({ user, trades: chunk });
          totalUpserted += result.upserted;
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          const msg = error instanceof Error ? error.message : String(error);
          const busy = /database is locked|SQLITE_BUSY/i.test(msg);
          if (!busy || attempt === 8) break;
          const waitMs = 250 * attempt;
          console.warn(
            `  busy retry ${attempt}/8 wait ${waitMs}ms (${chunk.length} trades)`
          );
          await new Promise((r) => setTimeout(r, waitMs));
        }
      }
      if (lastError) throw lastError;
    }
    console.log(`  upserted done for ${user.name} (batch size ${trades.length})`);
  }

  console.log('[backfill-wallet-gmgn] done', {
    totalRaw,
    totalUpserted,
    byChain,
    uniqueTx: seenTx.size,
  });

  if (opts.expectTx) {
    const hit = seenTx.has(opts.expectTx.toLowerCase());
    const db = getDb();
    const row = db
      .prepare(
        `SELECT event_id, action, token, timestamp, ingest_source
         FROM events WHERE LOWER(tx_hash) = LOWER(?) LIMIT 1`
      )
      .get(opts.expectTx) as
      | { event_id: string; action: string; token: string; timestamp: number; ingest_source: string }
      | undefined;
    console.log('[expect-tx]', {
      tx: opts.expectTx,
      inFetchedSet: hit,
      inDb: Boolean(row),
      row: row || null,
    });
    if (!row) process.exitCode = 2;
  }
}

void main().catch((error) => {
  console.error('[backfill-wallet-gmgn] fatal', error);
  process.exit(1);
});
