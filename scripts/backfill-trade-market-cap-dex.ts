/**
 * Fast remaining MC fill via DexScreener bulk + optional GMGN for robinhood.
 * Writes after every batch (crash-safe). Preserves Solana base58 case.
 *
 *   npx tsx scripts/backfill-trade-market-cap-dex.ts --force-prod-db --dry
 *   npx tsx scripts/backfill-trade-market-cap-dex.ts --force-prod-db
 *   npx tsx scripts/backfill-trade-market-cap-dex.ts --force-prod-db --with-gmgn
 */
import './server-only-shim.cjs';

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { exitIfProdDbHeavyJobBlocked } from './lib/prodDbGuard';

const execFileAsync = promisify(execFile);

type MissingRow = {
  eventId: string;
  chain: string;
  tokenAddress: string;
  tokenLower: string;
};

function parseArgs(argv: string[]) {
  let dry = false;
  let forceProd = false;
  let withGmgn = false;
  let gmgnOnly = false;
  let batchTokens = 20;
  let writeBatch = 400;
  for (const arg of argv) {
    if (arg === '--dry') dry = true;
    else if (arg === '--force-prod-db') forceProd = true;
    else if (arg === '--with-gmgn') withGmgn = true;
    else if (arg === '--gmgn-only') {
      withGmgn = true;
      gmgnOnly = true;
    } else if (arg.startsWith('--batch-tokens=')) {
      const n = Number.parseInt(arg.slice('--batch-tokens='.length), 10);
      if (Number.isFinite(n) && n > 0) batchTokens = n;
    }
  }
  return { dry, forceProd, withGmgn, gmgnOnly, batchTokens, writeBatch };
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function parseUsd(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

async function fetchDexMcBatch(tokenAddresses: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (tokenAddresses.length === 0) return result;
  // Node undici + this machine's HTTPS_PROXY often hangs on SYN_SENT.
  // curl through the same proxy works reliably — use it for bulk pulls.
  const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddresses.map(encodeURIComponent).join(',')}`;
  try {
    const { stdout } = await execFileAsync(
      'curl',
      ['-sS', '-m', '15', '-H', 'user-agent: pili-mc-backfill/1.0', url],
      { maxBuffer: 8 * 1024 * 1024, env: process.env }
    );
    if (!stdout.trim()) return result;
    const payload = JSON.parse(stdout) as { pairs?: Array<Record<string, unknown>> | null };
    const pairs = Array.isArray(payload.pairs) ? payload.pairs : [];
    for (const pair of pairs) {
      const base = pair.baseToken as { address?: string } | undefined;
      const addr = typeof base?.address === 'string' ? base.address : '';
      if (!addr) continue;
      const mc = parseUsd(pair.marketCap) ?? parseUsd(pair.fdv);
      if (!mc) continue;
      const lower = addr.toLowerCase();
      const prev = result.get(lower);
      if (prev == null || mc > prev) result.set(lower, mc);
    }
  } catch {
    // swallow — caller continues
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.forceProd) process.env.PILIPILI_ALLOW_PROD_DB_HEAVY = '1';
  exitIfProdDbHeavyJobBlocked({ jobName: 'backfill-trade-market-cap-dex' });

  const { getDb } = await import('../lib/server/sqlite');
  const db = getDb();

  const rows = (
    db
      .prepare(
        `SELECT
           event_id AS eventId,
           lower(COALESCE(json_extract(activity_json, '$.metadata.chain'), chain, '')) AS chain,
           COALESCE(json_extract(activity_json, '$.metadata.tokenAddress'), '') AS tokenAddress
         FROM events
         WHERE kind = 'transfer'
           AND action IN ('buy', 'sell')
           AND json_extract(activity_json, '$.metadata.marketCapAtTxUsd') IS NULL
           AND COALESCE(json_extract(activity_json, '$.metadata.tokenAddress'), '') != ''`
      )
      .all() as Array<{ eventId: string; chain: string; tokenAddress: string }>
  ).map((row) => {
    const chain = String(row.chain || '').toLowerCase();
    const raw = String(row.tokenAddress || '').trim();
    const tokenAddress = chain === 'solana' || chain === 'sol' ? raw : raw.toLowerCase();
    return {
      eventId: row.eventId,
      chain,
      tokenAddress,
      tokenLower: tokenAddress.toLowerCase(),
    } satisfies MissingRow;
  });

  console.log(
    `[mc-dex] missing rows=${rows.length} dry=${args.dry} withGmgn=${args.withGmgn} gmgnOnly=${args.gmgnOnly}`
  );

  // unique tokens per chain (dexscreener ignores chain in /latest/dex/tokens)
  const tokenToEvents = new Map<string, string[]>(); // tokenLower -> eventIds
  const tokenCase = new Map<string, string>(); // tokenLower -> best-case address
  for (const row of rows) {
    const list = tokenToEvents.get(row.tokenLower) || [];
    list.push(row.eventId);
    tokenToEvents.set(row.tokenLower, list);
    if (!tokenCase.has(row.tokenLower)) tokenCase.set(row.tokenLower, row.tokenAddress);
  }
  const uniqueTokens = Array.from(tokenCase.entries()).map(([lower, addr]) => ({ lower, addr }));
  console.log(`[mc-dex] unique tokens=${uniqueTokens.length}`);

  const updateStmt = db.prepare(
    `UPDATE events
     SET
       activity_json = json_set(
         json_set(
           json_set(COALESCE(activity_json, '{}'), '$.metadata.marketCapAtTxUsd', ?),
           '$.metadata.marketCapAtTxEstimated',
           1
         ),
         '$.metadata.marketCapAtTxSource',
         ?
       ),
       metadata_json = json_set(
         json_set(
           json_set(COALESCE(metadata_json, '{}'), '$.marketCapAtTxUsd', ?),
           '$.marketCapAtTxEstimated',
           1
         ),
         '$.marketCapAtTxSource',
         ?
       ),
       updated_at = ?
     WHERE event_id = ?
       AND json_extract(activity_json, '$.metadata.marketCapAtTxUsd') IS NULL`
  );

  let written = 0;
  let tokensHit = 0;
  let tokensMiss = 0;
  const now = () => Date.now();

  if (!args.gmgnOnly) {
    const batches = chunk(uniqueTokens, args.batchTokens);
    for (let bi = 0; bi < batches.length; bi++) {
      const batch = batches[bi];
      const mcMap = await fetchDexMcBatch(batch.map((t) => t.addr));
      const resolutions: Array<{ eventId: string; mc: number; source: string }> = [];
      for (const t of batch) {
        const mc = mcMap.get(t.lower);
        if (mc && mc > 0) {
          tokensHit += 1;
          for (const eventId of tokenToEvents.get(t.lower) || []) {
            resolutions.push({ eventId, mc, source: 'dexscreener-current' });
          }
        } else {
          tokensMiss += 1;
        }
      }

      if (!args.dry && resolutions.length > 0) {
        const tx = db.transaction((items: typeof resolutions) => {
          for (const item of items) {
            const r = updateStmt.run(item.mc, item.source, item.mc, item.source, now(), item.eventId);
            written += r.changes || 0;
          }
        });
        tx(resolutions);
      } else if (args.dry) {
        written += resolutions.length;
      }

      if ((bi + 1) % 5 === 0 || bi === batches.length - 1) {
        console.log(
          `[mc-dex] batch ${bi + 1}/${batches.length} hitTokens=${tokensHit} missTokens=${tokensMiss} written=${written}`
        );
      }
      // gentle pacing
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  // Optional robinhood / leftovers via GMGN token info (slow)
  if (args.withGmgn) {
    const { fetchGmgnTokenInfo } = await import('../lib/server/gmgnTokenInfo');
    const still = (
      db
        .prepare(
          `SELECT
             event_id AS eventId,
             lower(COALESCE(json_extract(activity_json, '$.metadata.chain'), chain, '')) AS chain,
             COALESCE(json_extract(activity_json, '$.metadata.tokenAddress'), '') AS tokenAddress
           FROM events
           WHERE kind = 'transfer'
             AND action IN ('buy', 'sell')
             AND json_extract(activity_json, '$.metadata.marketCapAtTxUsd') IS NULL
             AND COALESCE(json_extract(activity_json, '$.metadata.tokenAddress'), '') != ''`
        )
        .all() as Array<{ eventId: string; chain: string; tokenAddress: string }>
    ).map((row) => {
      const chain = String(row.chain || '').toLowerCase();
      const raw = String(row.tokenAddress || '').trim();
      const tokenAddress = chain === 'solana' || chain === 'sol' ? raw : raw.toLowerCase();
      return { eventId: row.eventId, chain, tokenAddress, tokenLower: tokenAddress.toLowerCase() };
    });

    const byToken = new Map<string, MissingRow[]>();
    for (const row of still) {
      const key = `${row.chain}|${row.tokenAddress}`;
      const list = byToken.get(key) || [];
      list.push(row);
      byToken.set(key, list);
    }
    console.log(`[mc-dex] gmgn leftovers tokens=${byToken.size} rows=${still.length}`);

    let ti = 0;
    for (const [, group] of byToken) {
      ti += 1;
      const sample = group[0];
      if (!sample) continue;
      let mc: number | null = null;
      try {
        const info = await fetchGmgnTokenInfo(sample.chain, sample.tokenAddress);
        if (info?.marketCapUsd && info.marketCapUsd > 0) mc = info.marketCapUsd;
      } catch {
        // ignore
      }
      if (!mc || mc <= 0) {
        if (ti % 50 === 0) console.log(`[mc-dex] gmgn ${ti}/${byToken.size} written=${written}`);
        continue;
      }
      if (args.dry) {
        written += group.length;
      } else {
        const tx = db.transaction(() => {
          for (const row of group) {
            const r = updateStmt.run(mc, 'gmgn-current', mc, 'gmgn-current', now(), row.eventId);
            written += r.changes || 0;
          }
        });
        tx();
      }
      if (ti % 50 === 0) console.log(`[mc-dex] gmgn ${ti}/${byToken.size} written=${written}`);
      await new Promise((r) => setTimeout(r, 200));
    }
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
        dry: args.dry,
        tokensHit,
        tokensMiss,
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
