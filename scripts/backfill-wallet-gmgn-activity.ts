/**
 * Backfill wallet buy/sell into events via GMGN portfolio activity.
 *
 *   npx tsx scripts/backfill-wallet-gmgn-activity.ts --user finn
 *   npx tsx scripts/backfill-wallet-gmgn-activity.ts --address CJ5f... --since-ms 1784453796000
 *   npx tsx scripts/backfill-wallet-gmgn-activity.ts --user finn --expect-tx 3eNh...
 *   npx tsx scripts/backfill-wallet-gmgn-activity.ts --all-monitored --days 30
 *   npx tsx scripts/backfill-wallet-gmgn-activity.ts --all-monitored --days 30 --resume
 */
import './server-only-shim.cjs';

import fs from 'node:fs';
import path from 'node:path';

import { getDb } from '../lib/server/sqlite';
import {
  fetchGmgnWalletActivity,
  inferChainsForAddress,
  normalizeGmgnActivityItems,
  type NormalizedLiveTrade,
} from '../lib/server/gmgnWalletActivity';
import { upsertLiveMonitorTrades } from '../lib/server/liveMonitorIngest';
import { listMonitoredUsers, listTrackedUsers } from '../lib/server/trackedUsersRepo';
import type { User } from '../types';

const DEFAULT_PROGRESS_PATH = path.join(
  process.cwd(),
  '.data',
  'backfill-wallet-gmgn-progress.json'
);

type ProgressState = {
  startedAt: string;
  updatedAt: string;
  sinceMs: number;
  days?: number;
  doneKeys: string[];
  stats: {
    totalRaw: number;
    totalUpserted: number;
    usersDone: number;
    addressesDone: number;
    fails: number;
  };
};

function parseArgs(argv: string[]) {
  const out: {
    user?: string;
    address?: string[];
    sinceMs?: number;
    days?: number;
    limit: number;
    expectTx?: string;
    dryRun: boolean;
    allMonitored: boolean;
    resume: boolean;
    progressPath: string;
    maxPages: number;
    sleepMs: number;
  } = {
    limit: 100,
    dryRun: false,
    address: [],
    allMonitored: false,
    resume: false,
    progressPath: DEFAULT_PROGRESS_PATH,
    maxPages: 80,
    sleepMs: 150,
  };

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
    } else if (arg === '--days' && next) {
      out.days = Math.max(1, Number(next) || 30);
      i += 1;
    } else if (arg === '--limit' && next) {
      out.limit = Math.max(1, Number(next) || 100);
      i += 1;
    } else if (arg === '--expect-tx' && next) {
      out.expectTx = next;
      i += 1;
    } else if (arg === '--dry-run') {
      out.dryRun = true;
    } else if (arg === '--all-monitored') {
      out.allMonitored = true;
    } else if (arg === '--resume') {
      out.resume = true;
    } else if (arg === '--progress' && next) {
      out.progressPath = next;
      i += 1;
    } else if (arg === '--max-pages' && next) {
      out.maxPages = Math.max(1, Number(next) || 80);
      i += 1;
    } else if (arg === '--sleep-ms' && next) {
      out.sleepMs = Math.max(0, Number(next) || 0);
      i += 1;
    }
  }
  return out;
}

function resolveTargets(opts: {
  user?: string;
  address?: string[];
  allMonitored?: boolean;
}): Array<{ user: User; address: string }> {
  const users = opts.allMonitored ? listMonitoredUsers() : listTrackedUsers();
  const out: Array<{ user: User; address: string }> = [];
  const seen = new Set<string>();

  const push = (user: User, address: string) => {
    const key = `${user.id}:${address.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ user, address });
  };

  if (opts.allMonitored) {
    for (const user of users) {
      for (const addr of user.addresses) {
        push(user, addr.address);
      }
    }
    if (out.length === 0) {
      throw new Error('listMonitoredUsers returned 0 addresses');
    }
    return out;
  }

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
    throw new Error(
      'provide --all-monitored and/or --user <name|id|handle> and/or --address <wallet>'
    );
  }
  return out;
}

function loadProgress(filePath: string, sinceMs: number, resume: boolean): ProgressState {
  if (resume && fs.existsSync(filePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as ProgressState;
      if (parsed && Array.isArray(parsed.doneKeys) && Number(parsed.sinceMs) === sinceMs) {
        console.log(
          `[backfill-wallet-gmgn] resume from ${filePath} doneKeys=${parsed.doneKeys.length}`
        );
        return parsed;
      }
      console.warn(
        `[backfill-wallet-gmgn] progress sinceMs mismatch or invalid — starting fresh`
      );
    } catch (error) {
      console.warn('[backfill-wallet-gmgn] progress load failed, starting fresh', error);
    }
  }
  return {
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sinceMs,
    doneKeys: [],
    stats: {
      totalRaw: 0,
      totalUpserted: 0,
      usersDone: 0,
      addressesDone: 0,
      fails: 0,
    },
  };
}

function saveProgress(filePath: string, state: ProgressState) {
  state.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, filePath);
}

function targetKey(userId: string, address: string) {
  return `${userId}:${address.toLowerCase()}`;
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
  maxPages: number;
}): { rawCount: number; trades: NormalizedLiveTrade[]; pages: number } {
  const allItems: ReturnType<typeof fetchGmgnWalletActivity>['items'] = [];
  let cursor: string | undefined;
  let pages = 0;

  while (pages < params.maxPages) {
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
  return { rawCount: allItems.length, trades, pages };
}

async function upsertTradesChunked(user: User, trades: NormalizedLiveTrade[]) {
  let upserted = 0;
  // larger chunks ok once importance scoring is skipped for backfill
  const chunkSize = 100;
  for (let i = 0; i < trades.length; i += chunkSize) {
    const chunk = trades.slice(i, i + chunkSize);
    let lastError: unknown;
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      try {
        const result = upsertLiveMonitorTrades({
          user,
          trades: chunk,
          skipImportanceScore: true,
          fastBulk: true,
        });
        upserted += result.upserted;
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        const msg = error instanceof Error ? error.message : String(error);
        const busy = /database is locked|SQLITE_BUSY/i.test(msg);
        if (!busy || attempt === 8) break;
        const waitMs = 250 * attempt;
        console.warn(`  busy retry ${attempt}/8 wait ${waitMs}ms (${chunk.length} trades)`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
    if (lastError) throw lastError;
  }
  return upserted;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const targets = resolveTargets({
    user: opts.user,
    address: opts.address,
    allMonitored: opts.allMonitored,
  });
  const uniqueAddrs = [...new Set(targets.map((t) => t.address))];
  const sinceMs =
    opts.sinceMs != null && Number.isFinite(opts.sinceMs)
      ? opts.sinceMs
      : opts.days != null
        ? Date.now() - opts.days * 24 * 60 * 60 * 1000
        : defaultSinceMsForAddresses(uniqueAddrs);
  const afterTsSec = Math.floor(sinceMs / 1000);

  const progress = loadProgress(opts.progressPath, sinceMs, opts.resume);
  progress.sinceMs = sinceMs;
  progress.days = opts.days;
  const doneSet = new Set(progress.doneKeys);

  console.log('[backfill-wallet-gmgn] start', {
    targets: targets.length,
    uniqueAddrs: uniqueAddrs.length,
    since: new Date(sinceMs).toISOString(),
    days: opts.days ?? null,
    allMonitored: opts.allMonitored,
    dryRun: opts.dryRun,
    resume: opts.resume,
    alreadyDone: doneSet.size,
    progressPath: opts.progressPath,
  });

  let totalRaw = progress.stats.totalRaw || 0;
  let totalUpserted = progress.stats.totalUpserted || 0;
  let fails = progress.stats.fails || 0;
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

  const userEntries = [...byUser.values()];
  let userIndex = 0;
  for (const { user, addresses } of userEntries) {
    userIndex += 1;
    const pending = addresses.filter((a) => !doneSet.has(targetKey(user.id, a)));
    if (pending.length === 0) {
      console.log(
        `[skip] ${userIndex}/${userEntries.length} ${user.name} all ${addresses.length} addrs done`
      );
      continue;
    }

    console.log(
      `\n[${userIndex}/${userEntries.length}] ${user.name} pending ${pending.length}/${addresses.length}`
    );

    // Per-address fetch + upsert so progress survives mid-user crashes / SQLITE_BUSY.
    for (const address of pending) {
      const chains = inferChainsForAddress(address);
      let addrRaw = 0;
      let addrKept = 0;
      const trades: NormalizedLiveTrade[] = [];
      for (const chain of chains) {
        try {
          const { rawCount, trades: pageTrades, pages } = fetchAllSince({
            chain,
            wallet: address,
            afterTsSec,
            pageLimit: opts.limit,
            maxPages: opts.maxPages,
          });
          totalRaw += rawCount;
          addrRaw += rawCount;
          addrKept += pageTrades.length;
          console.log(
            `  ${address} chain=${chain} pages=${pages} raw=${rawCount} kept=${pageTrades.length}`
          );
          for (const trade of pageTrades) {
            trades.push(trade);
            if (trade.txHash) seenTx.add(trade.txHash.toLowerCase());
            byChain[trade.chain] = (byChain[trade.chain] || 0) + 1;
          }
          if (opts.sleepMs > 0) {
            await new Promise((r) => setTimeout(r, opts.sleepMs));
          }
        } catch (error) {
          fails += 1;
          console.error(
            `  FAIL ${user.name} ${address} chain=${chain}:`,
            error instanceof Error ? error.message : error
          );
        }
      }

      if (opts.dryRun) {
        console.log(
          `  [dry-run] ${address} raw=${addrRaw} would upsert ${trades.length}`
        );
        totalUpserted += trades.length;
      } else if (trades.length > 0) {
        const n = await upsertTradesChunked(user, trades);
        totalUpserted += n;
        console.log(
          `  upserted ${n}/${trades.length} for ${user.name} ${address} (raw=${addrRaw})`
        );
      } else {
        console.log(`  nothing to upsert ${address} raw=${addrRaw} kept=${addrKept}`);
      }

      const key = targetKey(user.id, address);
      if (!doneSet.has(key)) {
        doneSet.add(key);
        progress.doneKeys.push(key);
      }
      progress.stats = {
        totalRaw,
        totalUpserted,
        usersDone: userIndex,
        addressesDone: doneSet.size,
        fails,
      };
      if (!opts.dryRun) {
        saveProgress(opts.progressPath, progress);
      }
    }
  }

  console.log('[backfill-wallet-gmgn] done', {
    totalRaw,
    totalUpserted,
    byChain,
    uniqueTxThisRun: seenTx.size,
    addressesDone: doneSet.size,
    fails,
    progressPath: opts.progressPath,
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
