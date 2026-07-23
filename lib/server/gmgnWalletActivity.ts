/**
 * Fetch wallet buy/sell activity via local gmgn-cli (already signed).
 * Ported lightly from newone adapters — no newone dependency.
 */
import { runGmgnCliAsync, runGmgnCliSync, resolveGmgnCliBin } from '@/lib/server/gmgnCli';

export type GmgnChain = 'sol' | 'eth' | 'bsc' | 'base' | 'robinhood';

export type GmgnActivityItem = {
  wallet?: string;
  chain?: string;
  tx_hash?: string;
  timestamp?: number;
  event_type?: string;
  token?: {
    address?: string;
    symbol?: string;
    name?: string;
    total_supply?: string | number | null;
    totalSupply?: string | number | null;
    supply?: string | number | null;
  };
  token_amount?: string | number;
  cost_usd?: string | number | null;
  price_usd?: string | number | null;
  [k: string]: unknown;
};

export function inferChainsForAddress(address: string): GmgnChain[] {
  const a = address.trim();
  if (a.startsWith('0x') || a.startsWith('0X')) {
    // robinhood first — stock/token activity is a separate GMGN chain for EVM wallets
    return ['robinhood', 'base', 'eth', 'bsc'];
  }
  return ['sol'];
}

export function normalizeGmgnChainToPili(chain: string): string {
  const c = chain.toLowerCase();
  if (c === 'sol' || c === 'solana') return 'solana';
  if (c === 'eth' || c === 'ethereum') return 'ethereum';
  if (c === 'bsc') return 'bsc';
  if (c === 'base') return 'base';
  if (c === 'robinhood') return 'robinhood';
  return c;
}

export function toGmgnChain(piliChain: string): GmgnChain {
  const c = piliChain.toLowerCase();
  if (c === 'solana' || c === 'sol') return 'sol';
  if (c === 'ethereum' || c === 'eth') return 'eth';
  if (c === 'bsc') return 'bsc';
  if (c === 'base') return 'base';
  if (c === 'robinhood') return 'robinhood';
  return c as GmgnChain;
}

function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function extractNextCursor(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  for (const key of ['next', 'cursor', 'next_cursor', 'nextCursor']) {
    const value = o[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  const data = o.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return extractNextCursor(data);
  }
  return null;
}

export function extractActivityItems(parsed: unknown): GmgnActivityItem[] {
  if (!parsed) return [];
  if (Array.isArray(parsed)) return parsed as GmgnActivityItem[];
  if (typeof parsed !== 'object') return [];
  const o = parsed as Record<string, unknown>;
  const data = o.data;
  if (Array.isArray(data)) return data as GmgnActivityItem[];
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    for (const k of ['activities', 'list', 'items', 'history', 'rows']) {
      if (Array.isArray(d[k])) return d[k] as GmgnActivityItem[];
    }
  }
  for (const k of ['activities', 'list', 'items']) {
    if (Array.isArray(o[k])) return o[k] as GmgnActivityItem[];
  }
  return [];
}

function buildActivityArgs(opts: {
  chain: GmgnChain | string;
  wallet: string;
  limit?: number;
  type?: string | string[];
  token?: string;
  cursor?: string;
}) {
  const args = [
    'portfolio',
    'activity',
    '--chain',
    String(opts.chain),
    '--wallet',
    opts.wallet,
    '--raw',
  ];
  if (opts.limit != null) args.push('--limit', String(opts.limit));
  if (opts.token) args.push('--token', opts.token);
  if (opts.cursor) args.push('--cursor', opts.cursor);
  const types = Array.isArray(opts.type)
    ? opts.type
    : opts.type
      ? [opts.type]
      : ['buy', 'sell'];
  for (const t of types) args.push('--type', t);
  return args;
}

async function runGmgnActivityCli(bin: string, args: string[], signal?: AbortSignal): Promise<string> {
  try {
    return await runGmgnCliAsync({ args, bin, signal });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (/aborted/i.test(msg)) throw new Error('gmgn-cli activity aborted');
    throw new Error(msg.replace(/^gmgn-cli exited/, 'gmgn-cli activity exit'));
  }
}

function parseActivityOutput(rawText: string) {
  const text = rawText.trim();
  if (!text) return { items: [], next: null, raw: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`gmgn-cli activity invalid JSON: ${text.slice(0, 200)}`);
  }
  return {
    items: extractActivityItems(parsed),
    next: extractNextCursor(parsed),
    raw: parsed,
  };
}

export async function fetchGmgnWalletActivityAsync(opts: {
  chain: GmgnChain | string;
  wallet: string;
  limit?: number;
  type?: string | string[];
  token?: string;
  cursor?: string;
  bin?: string;
  signal?: AbortSignal;
}): Promise<{ items: GmgnActivityItem[]; next: string | null; raw: unknown }> {
  const bin = resolveGmgnCliBin(opts.bin);
  const raw = await runGmgnActivityCli(bin, buildActivityArgs(opts), opts.signal);
  return parseActivityOutput(raw);
}

export function fetchGmgnWalletActivity(opts: {
  chain: GmgnChain | string;
  wallet: string;
  limit?: number;
  type?: string | string[];
  token?: string;
  cursor?: string;
  bin?: string;
}): { items: GmgnActivityItem[]; next: string | null; raw: unknown } {
  const bin = resolveGmgnCliBin(opts.bin);
  const args = buildActivityArgs(opts);
  const r = runGmgnCliSync({ args, bin });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(
      `gmgn-cli activity exit ${r.status}: ${(r.stderr || r.stdout || '').slice(0, 400)}`
    );
  }
  const rawText = (r.stdout || '').trim();
  if (!rawText) return { items: [], next: null, raw: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error(`gmgn-cli activity invalid JSON: ${rawText.slice(0, 200)}`);
  }
  return {
    items: extractActivityItems(parsed),
    next: extractNextCursor(parsed),
    raw: parsed,
  };
}

export type NormalizedLiveTrade = {
  chain: string;
  wallet: string;
  txHash: string | null;
  tokenAddress: string;
  tokenSymbol: string | null;
  side: 'buy' | 'sell';
  tokenAmount: number | null;
  costUsd: number | null;
  priceUsd: number | null;
  /** Circulating MC at trade time when GMGN provides it (optional). */
  marketCapUsd: number | null;
  eventTimeMs: number;
};

/**
 * Prefer explicit MC fields; if absent, fall back to price_usd × total_supply
 * (GMGN openapi often omits market_cap but still has price + supply).
 * Cap at $100B to drop obvious unit/scale errors.
 */
export function extractMarketCapUsd(item: GmgnActivityItem): number | null {
  const token = item.token && typeof item.token === 'object' ? (item.token as Record<string, unknown>) : null;
  const candidates = [
    item.market_cap,
    item.mcap,
    item.marketCap,
    token?.market_cap,
    token?.mcap,
    token?.marketCap,
  ];
  for (const candidate of candidates) {
    const value = num(candidate as string | number | null | undefined);
    if (value != null && value > 0 && value <= 100_000_000_000) {
      return value;
    }
  }

  const price = num(item.price_usd);
  const supply = num(
    (token?.total_supply as string | number | null | undefined) ??
      (token?.totalSupply as string | number | null | undefined) ??
      (token?.supply as string | number | null | undefined)
  );
  if (price != null && price > 0 && supply != null && supply > 0) {
    const mcap = price * supply;
    if (Number.isFinite(mcap) && mcap > 0 && mcap <= 100_000_000_000) {
      return mcap;
    }
  }
  return null;
}

export function normalizeGmgnActivityItems(
  items: GmgnActivityItem[],
  opts: {
    wallet: string;
    chain: string;
    min_cost_usd?: number;
    /** unix seconds — keep events with timestamp > this */
    after_ts?: number;
  }
): NormalizedLiveTrade[] {
  const minCost = opts.min_cost_usd ?? 0;
  const after = opts.after_ts ?? 0;
  const chain = normalizeGmgnChainToPili(opts.chain);
  const out: NormalizedLiveTrade[] = [];

  for (const it of items) {
    const ts = Number(it.timestamp || 0);
    if (!ts || ts <= after) continue;
    const side = String(it.event_type || '').toLowerCase();
    if (side !== 'buy' && side !== 'sell') continue;

    const tokenAddr = String(it.token?.address || '').trim();
    if (!tokenAddr) continue;

    const cost = num(it.cost_usd);
    if (minCost > 0 && (cost == null || cost < minCost)) continue;

    const tx = String(it.tx_hash || '').trim() || null;
    out.push({
      chain,
      wallet: opts.wallet,
      txHash: tx,
      tokenAddress: chain === 'solana' ? tokenAddr : tokenAddr.toLowerCase(),
      tokenSymbol: it.token?.symbol ?? null,
      side,
      tokenAmount: num(it.token_amount),
      costUsd: cost,
      priceUsd: num(it.price_usd),
      marketCapUsd: extractMarketCapUsd(it),
      eventTimeMs: ts * 1000,
    });
  }

  out.sort((a, b) => a.eventTimeMs - b.eventTimeMs);
  return out;
}
