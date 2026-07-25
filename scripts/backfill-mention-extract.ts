/**
 * Lightweight re-extract of tweet token mentions for last N days.
 * Does NOT call LLM / vision — only rule extractor.
 * INSERT-only for missing symbols/CAs — never DELETE/replace (preserves created_at_ms).
 *
 * Fixes Chinese #tag / $ticker (e.g. #熊猫头) that rule-v2 missed.
 *
 * Usage:
 *   npx tsx scripts/backfill-mention-extract.ts
 *   npx tsx scripts/backfill-mention-extract.ts --days=7
 *   npx tsx scripts/backfill-mention-extract.ts --dry
 *   npx tsx scripts/backfill-mention-extract.ts --force-prod-db
 *   npx tsx scripts/backfill-mention-extract.ts --repair-created-at
 *     # one-shot: if a prior replace run stamped created_at_ms=now, reset to tweet time
 */

import { extractTweetTokenMentions } from '../lib/twitter/extractTweetTokenMentions';
import { getPrimaryPoolSymbolAllowlist } from '../lib/server/primaryPoolSymbols';
import { getDb } from '../lib/server/sqlite';
import { exitIfProdDbHeavyJobBlocked } from './lib/prodDbGuard';

function parseArgs(argv: string[]) {
  let days = 7;
  let dry = false;
  let forceProd = false;
  let repairCreatedAt = false;
  for (const arg of argv) {
    if (arg.startsWith('--days=')) {
      const n = Number.parseInt(arg.slice('--days='.length), 10);
      if (Number.isFinite(n) && n > 0) days = n;
    } else if (arg === '--dry') {
      dry = true;
    } else if (arg === '--force-prod-db') {
      forceProd = true;
    } else if (arg === '--repair-created-at') {
      repairCreatedAt = true;
    }
  }
  return { days, dry, forceProd, repairCreatedAt };
}

function normSym(v: string | null | undefined) {
  return (v || '').trim().toLowerCase();
}

function main() {
  const { days, dry, forceProd, repairCreatedAt } = parseArgs(process.argv.slice(2));
  if (forceProd) {
    process.env.PILIPILI_ALLOW_PROD_DB_HEAVY = '1';
  }
  exitIfProdDbHeavyJobBlocked({ jobName: 'backfill-mention-extract' });

  const db = getDb();

  if (repairCreatedAt) {
    // Mentions rewritten in last 2h by a bad replace run → stamp back to tweet time
    const sinceRepair = Date.now() - 2 * 60 * 60 * 1000;
    const info = dry
      ? { changes: (db.prepare(
          `SELECT COUNT(*) AS c FROM twitter_tweet_token_mentions m
           JOIN twitter_tweets t ON t.tweet_id = m.tweet_id
           WHERE m.created_at_ms >= ? AND m.created_at_ms > t.created_at_ms + 60000`,
        ).get(sinceRepair) as { c: number }).c }
      : db.prepare(
          `UPDATE twitter_tweet_token_mentions
           SET created_at_ms = (
             SELECT t.created_at_ms FROM twitter_tweets t
             WHERE t.tweet_id = twitter_tweet_token_mentions.tweet_id
           ),
           updated_at_ms = updated_at_ms
           WHERE created_at_ms >= ?
             AND EXISTS (
               SELECT 1 FROM twitter_tweets t
               WHERE t.tweet_id = twitter_tweet_token_mentions.tweet_id
                 AND twitter_tweet_token_mentions.created_at_ms > t.created_at_ms + 60000
             )`,
        ).run(sinceRepair);
    console.log(`repair-created-at dry=${dry} affected=${'changes' in info ? info.changes : info}`);
    if (repairCreatedAt && !dry) {
      // continue to also run extract pass
    }
  }

  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const tweets = db
    .prepare(
      `SELECT tweet_id, full_text, created_at_ms
       FROM twitter_tweets
       WHERE created_at_ms >= ?
       ORDER BY created_at_ms DESC`,
    )
    .all(sinceMs) as Array<{ tweet_id: string; full_text: string; created_at_ms: number }>;

  console.log(`tweets in last ${days}d: ${tweets.length} dry=${dry}`);

  const listExisting = db.prepare(
    `SELECT token_symbol_lower, token_address_lower
     FROM twitter_tweet_token_mentions WHERE tweet_id = ?`,
  );
  const insertStmt = db.prepare(
    `INSERT INTO twitter_tweet_token_mentions (
       tweet_id,
       token_address,
       token_address_lower,
       token_symbol,
       token_symbol_lower,
       chain,
       match_source,
       sentiment,
       confidence,
       rank_in_tweet,
       origin,
       market_cap_usd,
       market_cap_at_post_usd,
       market_cap_at_post_estimated,
       market_cap_source,
       resolved_at_ms,
       created_at_ms,
       updated_at_ms
     ) VALUES (?, ?, ?, ?, ?, NULL, ?, 'neutral', NULL, ?, 'text', NULL, NULL, 0, NULL, NULL, ?, ?)`,
  );

  let scanned = 0;
  let updated = 0;
  let addedMentions = 0;
  let skipped = 0;

  const bareSymbolAllowlist = getPrimaryPoolSymbolAllowlist({ forceRefresh: true });
  console.log(`primary-pool bare allowlist size=${bareSymbolAllowlist.size}`);

  const run = db.transaction(() => {
    for (const t of tweets) {
      scanned += 1;
      const extracted = extractTweetTokenMentions(t.full_text || '', { bareSymbolAllowlist });
      if (!extracted.length) {
        skipped += 1;
        continue;
      }

      const existing = listExisting.all(t.tweet_id) as Array<{
        token_symbol_lower: string | null;
        token_address_lower: string | null;
      }>;
      const existingSyms = new Set(
        existing.map((m) => normSym(m.token_symbol_lower)).filter(Boolean),
      );
      const existingAddrs = new Set(
        existing.map((m) => (m.token_address_lower || '').trim().toLowerCase()).filter(Boolean),
      );

      const missing = extracted.filter((m) => {
        const sym = normSym(m.tokenSymbol);
        const addr = (m.tokenAddress || '').trim().toLowerCase();
        if (sym && existingSyms.has(sym)) return false;
        if (addr && existingAddrs.has(addr)) return false;
        return Boolean(sym || addr);
      });

      if (!missing.length) {
        skipped += 1;
        continue;
      }

      console.log(
        `+ ${t.tweet_id} +${missing.length} [${missing.map((m) => m.tokenSymbol || m.tokenAddress).join(', ')}]`,
      );
      addedMentions += missing.length;
      updated += 1;

      if (dry) continue;

      // created_at_ms = tweet time so 7d window matches tweet age (not backfill wall clock)
      const createdAt = Math.max(0, Math.floor(t.created_at_ms || Date.now()));
      const now = Date.now();
      let rankBase = existing.length;
      for (const m of missing) {
        rankBase += 1;
        const addr = m.tokenAddress ? m.tokenAddress.trim() : null;
        const sym = m.tokenSymbol ? m.tokenSymbol.trim() : null;
        insertStmt.run(
          t.tweet_id,
          addr,
          addr ? addr.toLowerCase() : null,
          sym,
          sym ? sym.toLowerCase() : null,
          m.matchSource,
          rankBase,
          createdAt,
          now,
        );
        if (sym) existingSyms.add(sym.toLowerCase());
        if (addr) existingAddrs.add(addr.toLowerCase());
      }
    }
  });

  run();

  console.log(
    `done scanned=${scanned} updated=${updated} added_mentions=${addedMentions} skipped=${skipped} dry=${dry}`,
  );
}

main();
