/**
 * Alchemy (live-monitor) vs XXYY (telegram_monitor_events) coverage report.
 *
 * Usage:
 *   npx tsx scripts/report-live-vs-xxyy-coverage.ts
 *   npx tsx scripts/report-live-vs-xxyy-coverage.ts --hours=24
 *   npx tsx scripts/report-live-vs-xxyy-coverage.ts --since-live   # from first live-monitor row
 *
 * Read-only. Uses production sqlite via getDb (short queries).
 */
import './server-only-shim.cjs';

import { getDb } from '../lib/server/sqlite';

function parseArgs(argv: string[]) {
  let hours: number | null = null;
  let sinceLive = false;
  for (const arg of argv) {
    if (arg === '--since-live') sinceLive = true;
    else if (arg.startsWith('--hours=')) {
      const n = Number.parseInt(arg.slice('--hours='.length), 10);
      if (Number.isFinite(n) && n > 0) hours = n;
    }
  }
  return { hours, sinceLive };
}

function pct(num: number, den: number) {
  if (den <= 0) return den === 0 && num === 0 ? 'n/a' : '∞';
  return `${((100 * num) / den).toFixed(1)}%`;
}

function main() {
  const { hours, sinceLive } = parseArgs(process.argv.slice(2));
  const db = getDb();

  const firstLive = db
    .prepare(
      `SELECT MIN(timestamp) AS t FROM events WHERE event_id LIKE 'live-monitor:%'`
    )
    .get() as { t: number | null };
  const now = Date.now();
  let windowStart: number;
  let windowLabel: string;
  if (sinceLive || hours == null) {
    windowStart = firstLive.t ?? now - 24 * 3600_000;
    windowLabel = firstLive.t
      ? `since first live-monitor (${new Date(firstLive.t).toLocaleString()})`
      : 'last 24h (no live-monitor rows yet)';
  } else {
    windowStart = now - hours * 3600_000;
    windowLabel = `last ${hours}h`;
  }

  const byChain = db
    .prepare(
      `
    WITH enabled_wallets AS (
      SELECT address_lower AS wallet
      FROM tracked_addresses
      WHERE COALESCE(monitoring_enabled, 1) = 1
    ),
    live_txs AS (
      SELECT DISTINCT lower(chain) AS chain, lower(tx_hash) AS tx, lower(address) AS wallet
      FROM events
      WHERE source = 'blockchain'
        AND timestamp >= ?
        AND tx_hash IS NOT NULL AND length(tx_hash) > 8
        AND lower(address) IN (SELECT wallet FROM enabled_wallets)
        AND (
          event_id LIKE 'live-monitor:%'
          OR ingest_source LIKE 'live-monitor%'
          OR json_extract(activity_json, '$.metadata.liveSource') = 'alchemy-gmgn'
        )
    ),
    xxyy_txs AS (
      SELECT DISTINCT
        lower(chain) AS chain,
        lower(tx_hash) AS tx,
        lower(COALESCE(tracked_wallet_address, '')) AS wallet
      FROM telegram_monitor_events
      WHERE event_time_ms >= ?
        AND tx_hash IS NOT NULL AND length(tx_hash) > 8
        AND lower(COALESCE(tracked_wallet_address, '')) IN (SELECT wallet FROM enabled_wallets)
    ),
    chains AS (
      SELECT chain FROM live_txs
      UNION
      SELECT chain FROM xxyy_txs
    )
    SELECT
      c.chain AS chain,
      (SELECT count(*) FROM live_txs l WHERE l.chain = c.chain) AS live_n,
      (SELECT count(*) FROM xxyy_txs x WHERE x.chain = c.chain) AS xxyy_n,
      (SELECT count(*) FROM live_txs l
         JOIN xxyy_txs x ON l.chain = x.chain AND l.tx = x.tx
           AND (l.wallet = x.wallet OR x.wallet = '' OR l.wallet = '')
         WHERE l.chain = c.chain) AS both_n,
      (SELECT count(*) FROM live_txs l
         WHERE l.chain = c.chain
           AND NOT EXISTS (
             SELECT 1 FROM xxyy_txs x
             WHERE x.chain = l.chain AND x.tx = l.tx
               AND (x.wallet = l.wallet OR x.wallet = '' OR l.wallet = '')
           )) AS live_only,
      (SELECT count(*) FROM xxyy_txs x
         WHERE x.chain = c.chain
           AND NOT EXISTS (
             SELECT 1 FROM live_txs l
             WHERE l.chain = x.chain AND l.tx = x.tx
               AND (l.wallet = x.wallet OR x.wallet = '' OR l.wallet = '')
           )) AS xxyy_only
    FROM chains c
    ORDER BY (live_n + xxyy_n) DESC
  `
    )
    .all(windowStart, windowStart) as Array<{
    chain: string;
    live_n: number;
    xxyy_n: number;
    both_n: number;
    live_only: number;
    xxyy_only: number;
  }>;

  const misses = db
    .prepare(
      `
    WITH enabled_wallets AS (
      SELECT address_lower AS wallet
      FROM tracked_addresses
      WHERE COALESCE(monitoring_enabled, 1) = 1
    ),
    live_txs AS (
      SELECT DISTINCT lower(chain) AS chain, lower(tx_hash) AS tx, lower(address) AS wallet
      FROM events
      WHERE source = 'blockchain'
        AND timestamp >= ?
        AND tx_hash IS NOT NULL AND length(tx_hash) > 8
        AND lower(address) IN (SELECT wallet FROM enabled_wallets)
        AND (
          event_id LIKE 'live-monitor:%'
          OR ingest_source LIKE 'live-monitor%'
          OR json_extract(activity_json, '$.metadata.liveSource') = 'alchemy-gmgn'
        )
    ),
    miss AS (
      SELECT
        lower(chain) AS chain,
        lower(tx_hash) AS tx,
        lower(COALESCE(tracked_wallet_address, '')) AS wallet,
        MIN(event_time_ms) AS et,
        MIN(token_symbol) AS tok,
        MIN(action) AS act,
        MIN(quote_amount) AS q
      FROM telegram_monitor_events
      WHERE event_time_ms >= ?
        AND tx_hash IS NOT NULL AND length(tx_hash) > 8
        AND lower(chain) IN ('solana', 'bsc', 'base', 'ethereum')
        AND lower(COALESCE(tracked_wallet_address, '')) IN (SELECT wallet FROM enabled_wallets)
      GROUP BY 1, 2, 3
    )
    SELECT
      m.chain,
      m.tok,
      m.act,
      m.q,
      m.et,
      m.wallet,
      m.tx,
      (SELECT tu.name FROM tracked_users tu
         JOIN tracked_addresses ta ON ta.user_id = tu.id
         WHERE lower(ta.address) = m.wallet LIMIT 1) AS user_name
    FROM miss m
    WHERE NOT EXISTS (
      SELECT 1 FROM live_txs l
      WHERE l.chain = m.chain AND l.tx = m.tx
        AND (l.wallet = m.wallet OR m.wallet = '' OR l.wallet = '')
    )
    ORDER BY m.et DESC
    LIMIT 30
  `
    )
    .all(windowStart, windowStart) as Array<{
    chain: string;
    tok: string | null;
    act: string | null;
    q: number | null;
    et: number;
    wallet: string;
    tx: string;
    user_name: string | null;
  }>;

  console.log(`# live-monitor vs XXYY coverage`);
  console.log(`window: ${windowLabel}`);
  console.log(`generated: ${new Date().toLocaleString()}`);
  console.log('');
  console.log(
    [
      'chain'.padEnd(12),
      'live'.padStart(6),
      'xxyy'.padStart(6),
      'both'.padStart(6),
      'liveOnly'.padStart(8),
      'xxyyOnly'.padStart(8),
      'live÷xxyy'.padStart(10),
    ].join(' ')
  );

  let sumLive = 0;
  let sumXxyy = 0;
  let sumBoth = 0;
  let sumLiveOnly = 0;
  let sumXxyyOnly = 0;
  let nonRhLive = 0;
  let nonRhXxyy = 0;
  let nonRhBoth = 0;
  let nonRhXxyyOnly = 0;

  for (const row of byChain) {
    sumLive += row.live_n;
    sumXxyy += row.xxyy_n;
    sumBoth += row.both_n;
    sumLiveOnly += row.live_only;
    sumXxyyOnly += row.xxyy_only;
    if (row.chain !== 'robinhood') {
      nonRhLive += row.live_n;
      nonRhXxyy += row.xxyy_n;
      nonRhBoth += row.both_n;
      nonRhXxyyOnly += row.xxyy_only;
    }
    console.log(
      [
        row.chain.padEnd(12),
        String(row.live_n).padStart(6),
        String(row.xxyy_n).padStart(6),
        String(row.both_n).padStart(6),
        String(row.live_only).padStart(8),
        String(row.xxyy_only).padStart(8),
        pct(row.both_n, row.xxyy_n).padStart(10),
      ].join(' ')
    );
  }

  console.log('-'.repeat(64));
  console.log(
    [
      'ALL'.padEnd(12),
      String(sumLive).padStart(6),
      String(sumXxyy).padStart(6),
      String(sumBoth).padStart(6),
      String(sumLiveOnly).padStart(8),
      String(sumXxyyOnly).padStart(8),
      pct(sumBoth, sumXxyy).padStart(10),
    ].join(' ')
  );
  console.log(
    [
      'non-RH'.padEnd(12),
      String(nonRhLive).padStart(6),
      String(nonRhXxyy).padStart(6),
      String(nonRhBoth).padStart(6),
      ''.padStart(8),
      String(nonRhXxyyOnly).padStart(8),
      pct(nonRhBoth, nonRhXxyy).padStart(10),
    ].join(' ')
  );

  console.log('');
  console.log('## interpretation');
  console.log(
    `- live÷xxyy = share of XXYY txs also seen by Alchemy+GMGN (rekey-aware via telegram_monitor_events)`
  );
  console.log(
    `- cutover heuristic: non-RH live÷xxyy ≥ 98% for ≥3d continuous dual, and sol/bsc/base each ≥95%`
  );
  console.log(
    `- RH is expected weaker until Address Activity/watchlist is proven; keep XXYY residual for RH`
  );
  console.log(
    `- note: pili default does NOT push Alchemy watchlist (PILI_ALCHEMY_MANAGE_WATCHLIST!=1); newone/feishu owns it`
  );
  console.log(
    `- coverage counts only monitoring_enabled=1 wallets (Feishu enablement mirror)`
  );

  if (misses.length) {
    console.log('');
    console.log('## recent non-RH xxyy-only (Alchemy missed)');
    for (const m of misses) {
      console.log(
        [
          m.chain,
          m.act || '-',
          m.tok || '-',
          m.q != null ? `$${Number(m.q).toFixed(4)}` : '?',
          new Date(m.et).toLocaleString(),
          m.user_name || '?',
          m.wallet,
          m.tx,
        ].join(' | ')
      );
    }
  }

  // recommendation line
  const ready =
    nonRhXxyy > 0 && nonRhBoth / nonRhXxyy >= 0.98 && nonRhXxyyOnly / nonRhXxyy <= 0.02;
  console.log('');
  console.log(
    ready
      ? '## recommendation: READY to try PILI_LIVE_SOURCE=alchemy + PILI_LIVE_XXYY_CHAINS=robinhood'
      : '## recommendation: NOT READY — keep dual; fix misses / extend sample window'
  );
}

main();
