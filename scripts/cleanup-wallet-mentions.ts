/**
 * One-shot cleanup: delete twitter_tweet_token_mentions rows whose address is a
 * wallet/EOA (0 DexScreener pairs), not a token mint.
 *
 * Background: the base58 extractor treated any Solana-shaped string as a token CA,
 * and inferChainAndTickerForAddress force-set chain='solana' even when DexScreener
 * returned 0 pairs — so wallet addresses (e.g. an analyst pasting 18 holder wallets)
 * survived the mention filter and rendered in the feed as tokens. The extractor fix
 * (return chain=null when DexScreener finds no pairs) stops new pollution; this
 * script removes the rows already in the DB.
 *
 * Safety: every suspect address is re-verified against DexScreener immediately
 * before deletion. If DexScreener currently reports ≥1 pair, the row is KEPT
 * (it's a real token). Only confirmed-0-pair addresses are deleted.
 *
 * Usage:
 *   npx tsx scripts/cleanup-wallet-mentions.ts                         # dry-run (read-only)
 *   npx tsx scripts/cleanup-wallet-mentions.ts --apply --force-prod-db # actually delete
 */
import { getDb } from '../lib/server/sqlite';
import { exitIfProdDbHeavyJobBlocked } from './lib/prodDbGuard';

const apply = process.argv.includes('--apply');
if (apply) {
  process.env.PILIPILI_ALLOW_PROD_DB_HEAVY = '1';
  exitIfProdDbHeavyJobBlocked({ jobName: 'cleanup-wallet-mentions' });
}

const db = getDb();

interface Suspect {
  token_address: string;
  token_address_lower: string;
  n: number;
}

async function dexPairsCount(addr: string): Promise<number> {
  // DexScreener latest/dex/tokens/{addr} returns pairs across ALL chains for a token.
  // 0 pairs ⟺ the address is not a tradeable token anywhere ⟺ a wallet/EOA.
  // Returns -1 on transport/HTTP error → treat as "unknown", never delete.
  // Retry with backoff: DexScreener rate-limits (429) under batch load.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${addr}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        const data = (await res.json()) as { pairs?: unknown[] };
        return Array.isArray(data.pairs) ? data.pairs.length : 0;
      }
      // non-ok (e.g. 429) → back off and retry
    } catch {
      // timeout / network → retry
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  return -1;
}

async function main() {
  const suspects = db
    .prepare(
      `SELECT token_address, token_address_lower, COUNT(*) AS n
       FROM twitter_tweet_token_mentions
       WHERE match_source = 'ca' AND (market_cap_usd IS NULL OR market_cap_usd = 0)
       GROUP BY token_address_lower`
    )
    .all() as Suspect[];

  console.log(`[cleanup] ${suspects.length} suspect CA addresses (no market cap) to re-verify`);

  let walletRows = 0;
  let walletAddrs = 0;
  let keptAddrs = 0;
  let unknown = 0;
  const toDelete: string[] = [];

  const concurrency = 2;
  for (let i = 0; i < suspects.length; i += concurrency) {
    const batch = suspects.slice(i, i + concurrency);
    const verified = await Promise.all(
      batch.map(async (s) => ({ s, pairs: await dexPairsCount(s.token_address) }))
    );
    for (const { s, pairs } of verified) {
      if (pairs === 0) {
        walletAddrs += 1;
        walletRows += s.n;
        toDelete.push(s.token_address_lower);
        console.log(`[wallet] ${s.token_address}  (0 pairs, ${s.n} rows)`);
      } else if (pairs > 0) {
        keptAddrs += 1;
        console.log(`[token ] ${s.token_address}  (${pairs} pairs) — KEEP`);
      } else {
        unknown += 1;
        console.log(`[unknown] ${s.token_address}  (DexScreener error) — skip`);
      }
    }
  }

  console.log(
    `\n[cleanup] wallets=${walletAddrs} addrs / ${walletRows} rows  |  kept=${keptAddrs}  |  unknown=${unknown}`
  );

  if (!apply) {
    console.log('[cleanup] DRY-RUN — nothing deleted. Re-run with --apply --force-prod-db to delete.');
    return;
  }
  if (toDelete.length === 0) {
    console.log('[cleanup] nothing to delete.');
    return;
  }

  const del = db.prepare(
    `DELETE FROM twitter_tweet_token_mentions WHERE token_address_lower = ?`
  );
  const tx = db.transaction((addrs: string[]) => {
    for (const a of addrs) del.run(a);
  });
  tx(toDelete);
  console.log(
    `[cleanup] DELETED ${walletRows} wallet-mention rows across ${walletAddrs} addresses.`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
