/**
 * Backfill missing metadata.marketCapAtTxUsd on trade events.
 *
 * Priority:
 *   1. telegram_monitor_events exact tx match  → telegram-monitor-exact
 *   2. nearest same-token MC in telegram_monitor_events (≤ window)
 *   3. nearest same-token MC already on events (≤ window)
 *   4. (optional) resolveTransactionTimeMarketCap external estimate
 *
 * Usage:
 *   npx tsx scripts/backfill-trade-market-cap.ts --dry
 *   npx tsx scripts/backfill-trade-market-cap.ts --force-prod-db
 *   npx tsx scripts/backfill-trade-market-cap.ts --force-prod-db --external
 *   npx tsx scripts/backfill-trade-market-cap.ts --force-prod-db --window-h=6 --batch=500
 */
import './server-only-shim.cjs';

import { exitIfProdDbHeavyJobBlocked } from './lib/prodDbGuard';

type MissingRow = {
  eventId: string;
  chain: string;
  /** Original token address (Solana base58 is case-sensitive). */
  tokenAddress: string;
  /** lower(tokenAddress) for joins / maps. */
  tokenLower: string;
  txLower: string;
  timestamp: number;
};

type McPoint = {
  timeMs: number;
  marketCapUsd: number;
  source: 'telegram-monitor-exact' | 'telegram-neighbor' | 'events-neighbor';
};

function parseArgs(argv: string[]) {
  let dry = false;
  let forceProd = false;
  let external = false;
  /** Skip historical OKX; only fill with current token MC (fast bulk). */
  let currentOnly = false;
  let windowH = 6;
  let batch = 500;
  let limit = 0;
  for (const arg of argv) {
    if (arg === '--dry') dry = true;
    else if (arg === '--force-prod-db') forceProd = true;
    else if (arg === '--external') external = true;
    else if (arg === '--current-only') {
      external = true;
      currentOnly = true;
    } else if (arg.startsWith('--window-h=')) {
      const n = Number.parseInt(arg.slice('--window-h='.length), 10);
      // 0 = unbounded nearest neighbor
      if (Number.isFinite(n) && n >= 0) windowH = n;
    } else if (arg.startsWith('--batch=')) {
      const n = Number.parseInt(arg.slice('--batch='.length), 10);
      if (Number.isFinite(n) && n > 0) batch = n;
    } else if (arg.startsWith('--limit=')) {
      const n = Number.parseInt(arg.slice('--limit='.length), 10);
      if (Number.isFinite(n) && n > 0) limit = n;
    }
  }
  return { dry, forceProd, external, currentOnly, windowH, batch, limit };
}

function tokenKey(chain: string, tokenLower: string) {
  return `${chain}|${tokenLower}`;
}

function nearestPoint(points: McPoint[], timeMs: number, windowMs: number): McPoint | null {
  if (!points.length) return null;
  // windowMs <= 0 → unbounded nearest
  const maxDist = windowMs > 0 ? windowMs : Number.POSITIVE_INFINITY;
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].timeMs < timeMs) lo = mid + 1;
    else hi = mid;
  }
  const candidates: McPoint[] = [];
  if (lo < points.length) candidates.push(points[lo]);
  if (lo > 0) candidates.push(points[lo - 1]);
  if (lo + 1 < points.length) candidates.push(points[lo + 1]);

  let best: McPoint | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const p of candidates) {
    const dist = Math.abs(p.timeMs - timeMs);
    if (dist <= maxDist && dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  return best;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.forceProd) {
    process.env.PILIPILI_ALLOW_PROD_DB_HEAVY = '1';
  }
  exitIfProdDbHeavyJobBlocked({ jobName: 'backfill-trade-market-cap' });

  const { getDb } = await import('../lib/server/sqlite');
  const db = getDb();
  const windowMs = args.windowH * 60 * 60 * 1000;

  console.log(
    `[mc-backfill] dry=${args.dry} external=${args.external} currentOnly=${args.currentOnly} windowH=${args.windowH} batch=${args.batch} limit=${args.limit || 'all'}`
  );

  const missingSql = `
    SELECT
      event_id AS eventId,
      lower(COALESCE(json_extract(activity_json, '$.metadata.chain'), chain, '')) AS chain,
      COALESCE(json_extract(activity_json, '$.metadata.tokenAddress'), '') AS tokenAddress,
      lower(COALESCE(json_extract(activity_json, '$.metadata.txHash'), tx_hash, '')) AS txLower,
      timestamp AS timestamp
    FROM events
    WHERE kind = 'transfer'
      AND action IN ('buy', 'sell')
      AND json_extract(activity_json, '$.metadata.marketCapAtTxUsd') IS NULL
      AND COALESCE(json_extract(activity_json, '$.metadata.tokenAddress'), '') != ''
    ORDER BY timestamp DESC
  `;

  let missing = (db.prepare(missingSql).all() as Array<{
    eventId: string;
    chain: string;
    tokenAddress: string;
    txLower: string;
    timestamp: number;
  }>).map((row) => {
    const chain = String(row.chain || '').toLowerCase();
    const rawToken = String(row.tokenAddress || '').trim();
    // EVM addresses are case-insensitive; Solana base58 must keep case for GMGN/Dex.
    const tokenAddress =
      chain === 'solana' || chain === 'sol' ? rawToken : rawToken.toLowerCase();
    return {
      eventId: row.eventId,
      chain,
      tokenAddress,
      tokenLower: tokenAddress.toLowerCase(),
      txLower: String(row.txLower || '').toLowerCase(),
      timestamp: row.timestamp,
    } satisfies MissingRow;
  });
  if (args.limit > 0) missing = missing.slice(0, args.limit);
  console.log(`[mc-backfill] missing rows: ${missing.length}`);

  // --- load telegram exact tx map + neighbor series ---
  const tgExact = new Map<string, number>(); // chain|token|tx → mc
  const tgSeries = new Map<string, McPoint[]>();
  const tgRows = db
    .prepare(
      `SELECT chain, token_address_lower AS tokenLower, tx_hash_lower AS txLower,
              event_time_ms AS timeMs, market_cap_usd AS marketCapUsd
       FROM telegram_monitor_events
       WHERE market_cap_usd IS NOT NULL AND market_cap_usd > 0
         AND token_address_lower IS NOT NULL AND token_address_lower != ''`
    )
    .all() as Array<{
    chain: string;
    tokenLower: string;
    txLower: string | null;
    timeMs: number | null;
    marketCapUsd: number;
  }>;

  for (const row of tgRows) {
    const chain = String(row.chain || '').toLowerCase();
    const tokenLower = String(row.tokenLower || '').toLowerCase();
    if (!chain || !tokenLower) continue;
    const mc = Number(row.marketCapUsd);
    if (!Number.isFinite(mc) || mc <= 0) continue;
    const txLower = row.txLower ? String(row.txLower).toLowerCase() : '';
    if (txLower) {
      tgExact.set(`${chain}|${tokenLower}|${txLower}`, mc);
    }
    const timeMs = typeof row.timeMs === 'number' && Number.isFinite(row.timeMs) ? row.timeMs : null;
    if (timeMs != null && timeMs > 0) {
      const key = tokenKey(chain, tokenLower);
      const list = tgSeries.get(key) || [];
      list.push({ timeMs, marketCapUsd: mc, source: 'telegram-neighbor' });
      tgSeries.set(key, list);
    }
  }
  for (const list of tgSeries.values()) {
    list.sort((a, b) => a.timeMs - b.timeMs);
  }
  console.log(`[mc-backfill] telegram exact keys=${tgExact.size} series=${tgSeries.size}`);

  // --- load events that already have MC as neighbor series ---
  const evSeries = new Map<string, McPoint[]>();
  const evRows = db
    .prepare(
      `SELECT
         lower(COALESCE(json_extract(activity_json, '$.metadata.chain'), chain, '')) AS chain,
         lower(COALESCE(json_extract(activity_json, '$.metadata.tokenAddress'), '')) AS tokenLower,
         timestamp AS timeMs,
         json_extract(activity_json, '$.metadata.marketCapAtTxUsd') AS marketCapUsd
       FROM events
       WHERE kind = 'transfer'
         AND action IN ('buy', 'sell')
         AND json_extract(activity_json, '$.metadata.marketCapAtTxUsd') IS NOT NULL
         AND json_extract(activity_json, '$.metadata.marketCapAtTxUsd') > 0
         AND COALESCE(json_extract(activity_json, '$.metadata.tokenAddress'), '') != ''`
    )
    .all() as Array<{
    chain: string;
    tokenLower: string;
    timeMs: number;
    marketCapUsd: number;
  }>;
  for (const row of evRows) {
    const chain = String(row.chain || '').toLowerCase();
    const tokenLower = String(row.tokenLower || '').toLowerCase();
    const mc = Number(row.marketCapUsd);
    const timeMs = Number(row.timeMs);
    if (!chain || !tokenLower || !Number.isFinite(mc) || mc <= 0 || !Number.isFinite(timeMs)) continue;
    const key = tokenKey(chain, tokenLower);
    const list = evSeries.get(key) || [];
    list.push({ timeMs, marketCapUsd: mc, source: 'events-neighbor' });
    evSeries.set(key, list);
  }
  for (const list of evSeries.values()) {
    list.sort((a, b) => a.timeMs - b.timeMs);
  }
  console.log(`[mc-backfill] events neighbor series=${evSeries.size}`);

  type Resolution = {
    eventId: string;
    marketCapUsd: number;
    source: string;
    estimated: boolean;
  };

  const resolutions: Resolution[] = [];
  const unresolved: MissingRow[] = [];
  const stats = {
    telegramExact: 0,
    telegramNeighbor: 0,
    eventsNeighbor: 0,
    external: 0,
    stillMissing: 0,
  };

  for (const row of missing) {
    const chain = row.chain;
    const tokenLower = row.tokenLower;
    const txLower = row.txLower;
    if (!chain || !tokenLower) {
      unresolved.push(row);
      continue;
    }

    if (txLower) {
      const exact = tgExact.get(`${chain}|${tokenLower}|${txLower}`);
      if (exact != null && exact > 0) {
        resolutions.push({
          eventId: row.eventId,
          marketCapUsd: exact,
          source: 'telegram-monitor-exact',
          estimated: false,
        });
        stats.telegramExact += 1;
        continue;
      }
    }

    const tgNear = nearestPoint(tgSeries.get(tokenKey(chain, tokenLower)) || [], row.timestamp, windowMs);
    if (tgNear) {
      resolutions.push({
        eventId: row.eventId,
        marketCapUsd: tgNear.marketCapUsd,
        source: 'telegram-neighbor',
        estimated: true,
      });
      stats.telegramNeighbor += 1;
      continue;
    }

    const evNear = nearestPoint(evSeries.get(tokenKey(chain, tokenLower)) || [], row.timestamp, windowMs);
    if (evNear) {
      resolutions.push({
        eventId: row.eventId,
        marketCapUsd: evNear.marketCapUsd,
        source: 'events-neighbor',
        estimated: true,
      });
      stats.eventsNeighbor += 1;
      continue;
    }

    unresolved.push(row);
  }

  console.log(
    `[mc-backfill] local resolved=${resolutions.length} unresolved=${unresolved.length} ` +
      `exact=${stats.telegramExact} tgNear=${stats.telegramNeighbor} evNear=${stats.eventsNeighbor}`
  );

  if (args.external && unresolved.length > 0) {
    const { fetchTokenLogo } = await import('../lib/tokenLogo');
    const concurrency = args.currentOnly ? 6 : 3;
    const byToken = new Map<string, MissingRow[]>();
    for (const row of unresolved) {
      // Group by case-preserved address so Solana fetch keeps base58 case.
      const key = `${row.chain}|${row.tokenAddress}`;
      const list = byToken.get(key) || [];
      list.push(row);
      byToken.set(key, list);
    }
    const tokenEntries = Array.from(byToken.entries());
    console.log(
      `[mc-backfill] external by-token: ${tokenEntries.length} tokens / ${unresolved.length} rows ` +
        `(currentOnly=${args.currentOnly}, concurrency=${concurrency})`
    );

    let tokenCursor = 0;
    let tokensDone = 0;
    const stillMissing: MissingRow[] = [];

    async function tokenWorker() {
      while (tokenCursor < tokenEntries.length) {
        const idx = tokenCursor;
        tokenCursor += 1;
        const entry = tokenEntries[idx];
        if (!entry) return;
        const [key, rows] = entry;
        const sample = rows[0];
        if (!sample) continue;
        let mc: number | null = null;
        let source = 'current-fallback';
        let estimated = true;
        try {
          // fetchTokenLogo already resolves current MC (+ optional tx-time estimate).
          // For bulk current-only we pass no tx so it skips historical OKX.
          // IMPORTANT: pass original-case tokenAddress (Solana base58).
          const logo = await fetchTokenLogo(sample.chain, sample.tokenAddress, undefined, {
            txTimestampMs: args.currentOnly ? undefined : sample.timestamp,
            txHash: args.currentOnly ? undefined : sample.txLower || undefined,
          });
          if (!args.currentOnly && logo.marketCapAtTxUsd && logo.marketCapAtTxUsd > 0) {
            mc = logo.marketCapAtTxUsd;
            source = logo.marketCapAtTxSource || 'estimated';
            estimated = Boolean(logo.marketCapAtTxEstimated);
          } else if (logo.marketCapUsd && logo.marketCapUsd > 0) {
            mc = logo.marketCapUsd;
            source = 'current-fallback';
            estimated = true;
          } else if (logo.marketCapAtTxUsd && logo.marketCapAtTxUsd > 0) {
            mc = logo.marketCapAtTxUsd;
            source = logo.marketCapAtTxSource || 'estimated';
            estimated = Boolean(logo.marketCapAtTxEstimated);
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          if (tokensDone % 40 === 0) {
            console.warn(`[mc-backfill] token fail ${key}: ${msg.slice(0, 120)}`);
          }
        }

        if (mc && mc > 0) {
          for (const row of rows) {
            resolutions.push({
              eventId: row.eventId,
              marketCapUsd: mc,
              source,
              estimated,
            });
            stats.external += 1;
          }
        } else {
          stillMissing.push(...rows);
        }

        tokensDone += 1;
        if (tokensDone % 50 === 0 || tokensDone === tokenEntries.length) {
          console.log(
            `[mc-backfill] tokens ${tokensDone}/${tokenEntries.length} filledRows=${stats.external}`
          );
        }
      }
    }

    await Promise.all(Array.from({ length: concurrency }, () => tokenWorker()));
    stats.stillMissing = stillMissing.length;
    console.log(`[mc-backfill] external filledRows=${stats.external} stillMissing=${stats.stillMissing}`);
  } else {
    stats.stillMissing = unresolved.length;
  }

  if (args.dry) {
    console.log(JSON.stringify({ dry: true, stats, wouldWrite: resolutions.length }, null, 2));
    return;
  }

  const updateStmt = db.prepare(
    `UPDATE events
     SET
       activity_json = json_set(
         json_set(
           json_set(COALESCE(activity_json, '{}'), '$.metadata.marketCapAtTxUsd', ?),
           '$.metadata.marketCapAtTxEstimated',
           ?
         ),
         '$.metadata.marketCapAtTxSource',
         ?
       ),
       metadata_json = json_set(
         json_set(
           json_set(COALESCE(metadata_json, '{}'), '$.marketCapAtTxUsd', ?),
           '$.marketCapAtTxEstimated',
           ?
         ),
         '$.marketCapAtTxSource',
         ?
       ),
       updated_at = ?
     WHERE event_id = ?
       AND json_extract(activity_json, '$.metadata.marketCapAtTxUsd') IS NULL`
  );

  let written = 0;
  const now = Date.now();
  for (let i = 0; i < resolutions.length; i += args.batch) {
    const chunk = resolutions.slice(i, i + args.batch);
    const tx = db.transaction((rows: Resolution[]) => {
      for (const row of rows) {
        const estimatedFlag = row.estimated ? 1 : 0;
        const result = updateStmt.run(
          row.marketCapUsd,
          estimatedFlag,
          row.source,
          row.marketCapUsd,
          estimatedFlag,
          row.source,
          now,
          row.eventId
        );
        written += result.changes || 0;
      }
    });
    tx(chunk);
    console.log(
      `[mc-backfill] wrote batch ${Math.min(i + chunk.length, resolutions.length)}/${resolutions.length} changes=${written}`
    );
  }

  const remaining = (
    db
      .prepare(
        `SELECT COUNT(1) AS n FROM events
         WHERE kind = 'transfer'
           AND action IN ('buy', 'sell')
           AND json_extract(activity_json, '$.metadata.marketCapAtTxUsd') IS NULL
           AND COALESCE(json_extract(activity_json, '$.metadata.tokenAddress'), '') != ''`
      )
      .get() as { n: number }
  ).n;

  console.log(
    JSON.stringify(
      {
        dry: false,
        stats,
        resolved: resolutions.length,
        written,
        remainingMissing: remaining,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
