/**
 * One-off: drain the alchemy inbox backlog via the Cloudflare D1 REST API,
 * bypassing the flaky workers.dev /pull route (DNS-poisoned direct, lossy
 * proxy). Feeds rows through the same parse + upsert path as live-monitor.
 *
 * - Reads pili's cursor (app_state alchemy:inbox:pili) as the start position.
 * - Idempotent: upsertLiveMonitorTrades keys on activity_key (UNIQUE).
 * - Advances the shared cursor only after a page is fully ingested.
 * Run: npm run inbox:backfill  (Ctrl-C safe; rerun resumes from cursor)
 */
import './server-only-shim.cjs';
import { readFileSync } from 'node:fs';

import { parseAlchemyInboxTrades } from '@/lib/server/alchemyDirectTrade';
import { readAlchemyInboxCursor, writeAlchemyInboxCursor } from '@/lib/server/alchemyInbox';
import { withSqliteBusyRetry } from '@/lib/server/sqlite';
import { upsertLiveMonitorTrades } from '@/lib/server/liveMonitorIngest';
import { listMonitoredUsers } from '@/lib/server/trackedUsersRepo';
import type { AlchemyInboxEvent } from '@/lib/server/alchemyInbox';
import type { User } from '@/types';

const ENV_FILE = '.env.local';
const PAGE_SIZE = 200;
const MAX_PAGES = Number(process.env.PILI_INBOX_BACKFILL_PAGES || 0) || Infinity;

function envValue(key: string): string {
  const line = readFileSync(ENV_FILE, 'utf8')
    .split('\n')
    .find((l) => l.startsWith(`${key}=`));
  if (!line) throw new Error(`missing ${key} in ${ENV_FILE}`);
  return line.slice(key.length + 1).trim();
}

function wranglerToken(): string {
  const toml = readFileSync(`${process.env.HOME}/Library/Preferences/.wrangler/config/default.toml`, 'utf8');
  const m = toml.match(/oauth_token = "([^"]+)"/);
  if (!m) throw new Error('no oauth_token in wrangler config');
  return m[1];
}

const ACCOUNT_ID = '4303fe4c38a3f946c44dbe40a6da40d2';
const D1_DB_ID = 'b0584153-af9c-47f0-8303-a873904a81a6';
const TOKEN = wranglerToken();

async function d1Query<T>(sql: string, params: unknown[]): Promise<T[]> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${D1_DB_ID}/query`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, params }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!res.ok) throw new Error(`D1 API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { success: boolean; errors: unknown[]; result: { results: T[] }[] };
  if (!body.success) throw new Error(`D1 query failed: ${JSON.stringify(body.errors).slice(0, 200)}`);
  return body.result[0]?.results ?? [];
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function main() {
  const users: User[] = listMonitoredUsers();
  const byLower = new Map<string, { user: User; address: string }>();
  for (const user of users) {
    for (const addr of user.addresses || []) {
      const address = (addr.address || '').trim();
      if (!address) continue;
      const key = address.toLowerCase();
      if (!byLower.has(key)) byLower.set(key, { user, address });
    }
  }
  const watched = [...byLower.values()].map((v) => v.address);
  console.log(`watched addresses: ${watched.length} across ${users.length} users`);

  let cursor = readAlchemyInboxCursor();
  const startCursor = cursor;
  let totalEvents = 0;
  let totalUpserted = 0;
  let page = 0;

  while (page < MAX_PAGES) {
    const rows = await d1Query<{
      id: number;
      event_key: string;
      network: string | null;
      received_at: string;
      payload_json: string;
    }>(
      `SELECT id, event_key, network, received_at, payload_json
       FROM webhook_events WHERE id > ? ORDER BY id ASC LIMIT ?`,
      [cursor, PAGE_SIZE],
    );
    if (rows.length === 0) break;

    const events: AlchemyInboxEvent[] = rows.map((r) => ({
      id: r.id,
      event_key: r.event_key,
      network: r.network,
      received_at: r.received_at,
      payload: JSON.parse(r.payload_json) as Record<string, unknown>,
    }));

    // Page-level retry: upserts are idempotent (activity_key UNIQUE), so on a
    // transient failure (SQLITE_BUSY storm from co-running workers) just redo
    // the whole page after a pause instead of aborting the backfill.
    let pageTrades = 0;
    for (let attempt = 1; ; attempt += 1) {
      try {
        const trades = await parseAlchemyInboxTrades({ events, watchedAddresses: watched });
        pageTrades = trades.length;

        const byUser = new Map<User, typeof trades>();
        for (const trade of trades) {
          const owner = byLower.get(trade.wallet.toLowerCase());
          if (!owner) continue;
          const group = byUser.get(owner.user) ?? [];
          group.push(trade);
          byUser.set(owner.user, group);
        }

        for (const [user, group] of byUser) {
          // Backlog fill: skip per-row importance scans (importance:backfill
          // covers it later); fastBulk = plain INSERT OR REPLACE.
          const result = withSqliteBusyRetry(
            () => upsertLiveMonitorTrades({
              user,
              trades: group,
              skipImportanceScore: true,
              fastBulk: true,
            }),
            { attempts: 10, label: 'inbox-backfill-upsert' },
          );
          totalUpserted += result.upserted;
        }
        break;
      } catch (error) {
        if (attempt >= 5) throw error;
        console.warn(`page attempt ${attempt} failed (${error instanceof Error ? error.message : error}), retrying in 10s`);
        await delay(10_000);
      }
    }

    cursor = events[events.length - 1]!.id;
    totalEvents += events.length;
    page += 1;
    withSqliteBusyRetry(() => writeAlchemyInboxCursor(cursor), { attempts: 10, label: 'inbox-backfill-cursor' });

    const newestTs = events.length ? events[events.length - 1]!.received_at : '-';
    console.log(`page ${page}: ids→${cursor}, events=${events.length}, trades=${pageTrades}, upserted=${totalUpserted}, newest=${newestTs}`);

    if (rows.length < PAGE_SIZE) break;
    await delay(800);
  }

  console.log(`done: scanned ${totalEvents} events (${startCursor} → ${cursor}), upserted ${totalUpserted} trades`);
}

main().catch((err) => {
  console.error('backfill failed:', err);
  process.exit(1);
});
