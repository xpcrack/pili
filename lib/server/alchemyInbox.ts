/**
 * Pull Alchemy Address Activity raw events from the shared CF inbox.
 * Cursor is pili-local (app_state) so newone and pili do not steal progress.
 */
import 'server-only';
import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';

import { getDb } from '@/lib/server/sqlite';

export const PILI_ALCHEMY_INBOX_CURSOR_KEY = 'alchemy:inbox:pili';
let proxyAgent: EnvHttpProxyAgent | null = null;

function inboxFetch(input: URL, init: RequestInit) {
  const hasProxy = Boolean(process.env.HTTPS_PROXY || process.env.HTTP_PROXY);
  if (!hasProxy) return fetch(input, init);
  proxyAgent ??= new EnvHttpProxyAgent();
  return undiciFetch(input, { ...init, dispatcher: proxyAgent } as never) as unknown as Promise<Response>;
}

export type AlchemyInboxEvent = {
  id: number;
  event_key: string;
  network: string | null;
  received_at: string;
  payload: Record<string, unknown>;
};

type PullResponse = {
  ok: boolean;
  next_after: number;
  events: AlchemyInboxEvent[];
};

function collectStrings(value: unknown, keys: string[], out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, keys, out);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (keys.includes(key)) {
      if (typeof item === 'string') out.add(item);
      else if (Array.isArray(item)) {
        for (const address of item) if (typeof address === 'string') out.add(address);
      }
    } else {
      collectStrings(item, keys, out);
    }
  }
}

export function extractAddressesFromAlchemyPayload(payload: unknown): string[] {
  const candidates = new Set<string>();
  collectStrings(payload, ['fromAddress', 'toAddress', 'account_keys'], candidates);
  return [...candidates];
}

export function matchedWatchedWallets(payload: unknown, watchedAddresses: string[]): string[] {
  const candidates = extractAddressesFromAlchemyPayload(payload);
  const watched = new Map(
    watchedAddresses.map((address) => [address.toLowerCase(), address] as const)
  );
  return candidates
    .map((address) => watched.get(address.toLowerCase()))
    .filter((address): address is string => Boolean(address));
}

export function readAlchemyInboxCursor(db = getDb()): number {
  const row = db
    .prepare('SELECT value_json FROM app_state WHERE key = ? LIMIT 1')
    .get(PILI_ALCHEMY_INBOX_CURSOR_KEY) as { value_json: string } | undefined;
  if (!row?.value_json) return 0;
  try {
    const parsed = JSON.parse(row.value_json) as { after?: number | string } | number | string;
    if (typeof parsed === 'number') return Number.isFinite(parsed) ? parsed : 0;
    if (typeof parsed === 'string') {
      const n = Number(parsed);
      return Number.isFinite(n) ? n : 0;
    }
    const n = Number(parsed?.after ?? 0);
    return Number.isFinite(n) ? n : 0;
  } catch {
    const n = Number(row.value_json);
    return Number.isFinite(n) ? n : 0;
  }
}

export function writeAlchemyInboxCursor(after: number, db = getDb()) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO app_state (key, value_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value_json = excluded.value_json,
       updated_at = excluded.updated_at`
  ).run(PILI_ALCHEMY_INBOX_CURSOR_KEY, JSON.stringify({ after }), now);
}

export async function pullAlchemyInbox(opts: {
  base_url: string;
  token: string;
  watched_addresses: string[];
  limit?: number;
  since_id?: number;
  write_cursor?: boolean;
}): Promise<{
  since_id: number;
  next_id: number;
  events: number;
  wallets: string[];
  raw_events: AlchemyInboxEvent[];
}> {
  const sinceId =
    typeof opts.since_id === 'number' && Number.isFinite(opts.since_id)
      ? opts.since_id
      : readAlchemyInboxCursor();
  const base = opts.base_url.replace(/\/+$/, '');
  const pullUrl = new URL(`${base}/pull`);
  pullUrl.searchParams.set('after', String(sinceId));
  pullUrl.searchParams.set('limit', String(opts.limit ?? 100));

  const response = await inboxFetch(pullUrl, {
    headers: { Authorization: `Bearer ${opts.token}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(
      `Alchemy inbox ${response.status}: ${(await response.text()).slice(0, 200)}`
    );
  }
  const page = (await response.json()) as PullResponse;
  const wallets = new Set<string>();
  for (const event of page.events ?? []) {
    for (const wallet of matchedWatchedWallets(event.payload, opts.watched_addresses)) {
      wallets.add(wallet);
    }
  }
  const nextId = Number(page.next_after ?? sinceId);
  if (opts.write_cursor !== false && nextId > sinceId) {
    writeAlchemyInboxCursor(nextId);
  }
  return {
    since_id: sinceId,
    next_id: nextId,
    events: page.events?.length ?? 0,
    wallets: [...wallets],
    raw_events: page.events ?? [],
  };
}
