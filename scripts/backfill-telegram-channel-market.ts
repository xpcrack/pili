/**
 * Backfill TG channel post market/ticker enrichment for recent CA-only chips.
 *
 * Usage:
 *   HTTPS_PROXY=http://127.0.0.1:7897 NODE_USE_ENV_PROXY=1 npx tsx scripts/backfill-telegram-channel-market.ts
 *   npx tsx scripts/backfill-telegram-channel-market.ts --days=3
 *   npx tsx scripts/backfill-telegram-channel-market.ts --event-id='user:telegram:chat:msg'
 *   npx tsx scripts/backfill-telegram-channel-market.ts --dry
 *   npx tsx scripts/backfill-telegram-channel-market.ts --force-prod-db
 */

import { getDb } from '../lib/server/sqlite';
import { upsertEventsFromFeedRows } from '../lib/server/eventsRepo';
import { listTrackedUsers } from '../lib/server/trackedUsersRepo';
import {
  enrichTelegramChannelPost,
  telegramChannelEnrichmentHasUpdates,
} from '../lib/server/telegramChannelProjector';
import type { Activity, User } from '../types';
import { exitIfProdDbHeavyJobBlocked } from './lib/prodDbGuard';
import './server-only-shim.cjs';

function parseArgs(argv: string[]) {
  let days = 3;
  let dry = false;
  let forceProd = false;
  let eventId: string | null = null;
  let limit = 50;
  for (const arg of argv) {
    if (arg.startsWith('--days=')) {
      const n = Number.parseInt(arg.slice('--days='.length), 10);
      if (Number.isFinite(n) && n > 0) days = n;
    } else if (arg.startsWith('--limit=')) {
      const n = Number.parseInt(arg.slice('--limit='.length), 10);
      if (Number.isFinite(n) && n > 0) limit = n;
    } else if (arg.startsWith('--event-id=')) {
      eventId = arg.slice('--event-id='.length).trim() || null;
    } else if (arg === '--dry') {
      dry = true;
    } else if (arg === '--force-prod-db') {
      forceProd = true;
    }
  }
  return { days, dry, forceProd, eventId, limit };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  if (!process.env.HTTP_PROXY && !process.env.HTTPS_PROXY && !process.env.ALL_PROXY) {
    process.env.HTTP_PROXY = 'http://127.0.0.1:7897';
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7897';
    process.env.ALL_PROXY = 'http://127.0.0.1:7897';
  }
  if (!process.env.NODE_USE_ENV_PROXY) {
    process.env.NODE_USE_ENV_PROXY = '1';
  }

  const args = parseArgs(process.argv.slice(2));
  exitIfProdDbHeavyJobBlocked({ force: args.forceProd, jobLabel: 'telegram-channel market backfill' });

  const db = getDb();
  const usersById = new Map(listTrackedUsers().map((user) => [user.id, user] as const));

  type Row = { event_id: string; user_id: string | null; activity_json: string; timestamp: number };
  let rows: Row[];
  if (args.eventId) {
    rows = db
      .prepare(
        `SELECT event_id, user_id, activity_json, timestamp
         FROM events
         WHERE event_id = ? AND source = 'telegram' AND kind = 'post'`
      )
      .all(args.eventId) as Row[];
  } else {
    const sinceMs = Date.now() - args.days * 24 * 60 * 60 * 1000;
    rows = db
      .prepare(
        `SELECT event_id, user_id, activity_json, timestamp
         FROM events
         WHERE source = 'telegram'
           AND kind = 'post'
           AND timestamp >= ?
           AND (
             json_extract(activity_json, '$.metadata.tokenSentiments[0].tokenAddress') IS NOT NULL
             AND (
               json_extract(activity_json, '$.metadata.tokenSentiments[0].tokenSymbol') IS NULL
               OR json_extract(activity_json, '$.metadata.tokenSentiments[0].marketCapAtPostUsd') IS NULL
             )
           )
         ORDER BY timestamp DESC
         LIMIT ?`
      )
      .all(sinceMs, args.limit) as Row[];
  }

  console.log(`candidates=${rows.length} dry=${args.dry}`);
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    let activity: Activity;
    try {
      activity = JSON.parse(row.activity_json) as Activity;
    } catch {
      console.warn(`skip bad json ${row.event_id}`);
      failed += 1;
      continue;
    }

    const userId = row.user_id || activity.userId;
    const user = (userId && usersById.get(userId)) || null;
    if (!user) {
      console.warn(`skip missing user ${row.event_id}`);
      failed += 1;
      continue;
    }

    try {
      const enriched = await enrichTelegramChannelPost(activity);
      const hasUpdates = telegramChannelEnrichmentHasUpdates({ before: activity, after: enriched });
      const first = enriched.metadata.tokenSentiments?.[0];
      console.log(
        `${row.event_id} hasUpdates=${hasUpdates} symbol=${first?.tokenSymbol || '-'} mc=${first?.marketCapAtPostUsd ?? '-'} chain=${first?.chain || '-'}`
      );
      if (!hasUpdates) {
        skipped += 1;
        continue;
      }
      if (!args.dry) {
        upsertEventsFromFeedRows([{ user: user as User, activity: enriched }], 'telegram-channel-enrichment');
      }
      updated += 1;
      await sleep(300);
    } catch (error) {
      failed += 1;
      console.warn(
        `failed ${row.event_id}:`,
        error instanceof Error ? error.message : error
      );
    }
  }

  console.log(`done updated=${updated} skipped=${skipped} failed=${failed}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
