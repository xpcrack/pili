/**
 * Fetch wallet buy/sell activity.
 * Default path: openapi multi-key pool (concurrent-friendly).
 * Fallback: gmgn-cli when PILI_GMGN_ACTIVITY_VIA=cli or openapi fails hard.
 */
import { isRobinhoodStockToken } from '@/lib/robinhoodStockTokens';
import { isOnchainStockToken } from '@/lib/onchainStockTokens';
import { MAX_PLAUSIBLE_MARKET_CAP_USD } from '@/lib/walletPnl';
import {
  normalizeGmgnChainToPili,
  toGmgnChain as toGmgnChainOrNull,
  type GmgnChain,
} from '@/lib/gmgnChain';
import { runGmgnCliAsync, runGmgnCliSync, resolveGmgnCliBin } from '@/lib/server/gmgnCli';
import { getGmgnOpenApiClient } from '@/lib/server/gmgnOpenApiClient';
import { noteGmgnError } from '@/lib/server/gmgnRateLimit';

export type { GmgnChain };

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

export { normalizeGmgnChainToPili };

/** pili chain → GMGN segment; falls back to lowercased input for unknown chains (legacy callers). */
export function toGmgnChain(piliChain: string): GmgnChain {
  return toGmgnChainOrNull(piliChain) ?? (piliChain.toLowerCase() as GmgnChain);
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

async function runGmgnActivityCli(
  bin: string,
  args: string[],
  signal?: AbortSignal,
  timeoutMs?: number
): Promise<string> {
  try {
    return await runGmgnCliAsync({ args, bin, signal, timeoutMs });
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

function preferOpenApiActivity(): boolean {
  const v = (process.env.PILI_GMGN_ACTIVITY_VIA || 'openapi').trim().toLowerCase();
  return v !== 'cli' && v !== 'gmgn-cli';
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
  /** force openapi | cli; default from PILI_GMGN_ACTIVITY_VIA */
  via?: 'openapi' | 'cli';
}): Promise<{ items: GmgnActivityItem[]; next: string | null; raw: unknown }> {
  const activityTimeoutMs = Number(
    process.env.PILI_GMGN_ACTIVITY_TIMEOUT_MS ||
      process.env.PILI_LIVE_ACTIVITY_TIMEOUT_MS ||
      process.env.GMGN_FETCH_TIMEOUT_MS ||
      20_000
  );
  // The guarded wrapper may legitimately wait ~30s for the account bucket
  // before opening the upstream request. Keep the process timeout above that
  // pacing delay so safe throttling is not misclassified as a network timeout.
  const timeoutMs = Number.isFinite(activityTimeoutMs) && activityTimeoutMs > 0 ? activityTimeoutMs : 90_000;
  const via = opts.via ?? (preferOpenApiActivity() ? 'openapi' : 'cli');
  if (via === 'openapi') {
    try {
      if (opts.signal?.aborted) throw new Error('gmgn activity aborted');
      const types = Array.isArray(opts.type)
        ? opts.type
        : opts.type
          ? [opts.type]
          : ['buy', 'sell'];
      const data = await getGmgnOpenApiClient().walletActivity({
        chain: String(opts.chain),
        wallet: opts.wallet,
        limit: opts.limit,
        cursor: opts.cursor,
        token: opts.token,
        type: types,
        signal: opts.signal,
      });
      const parsed = data ?? null;
      if (!parsed) return { items: [], next: null, raw: null };
      // openapi client unwraps JSON.data → usually { activities, next }
      return {
        items: extractActivityItems(parsed),
        next: extractNextCursor(parsed),
        raw: parsed,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // ban / rate limit: do not silently fall back to cli (same quota)
      if (/RATE_LIMIT|BANNED|429/i.test(msg)) throw error instanceof Error ? error : new Error(msg);
      noteGmgnError(`openapi activity fallback→cli: ${msg}`);
      // fall through to cli
    }
  }

  const bin = resolveGmgnCliBin(opts.bin);
  const raw = await runGmgnActivityCli(bin, buildActivityArgs(opts), opts.signal, timeoutMs);
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
  /**
   * GMGN flag: 1 = full open (buy) or full close (sell).
   * Used to map side → open/close and fill 幅度 without balance history.
   */
  isOpenOrClose: boolean | null;
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
    if (value != null && value > 0 && value <= MAX_PLAUSIBLE_MARKET_CAP_USD) {
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
    if (Number.isFinite(mcap) && mcap > 0 && mcap <= MAX_PLAUSIBLE_MARKET_CAP_USD) {
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

    const tokenName = typeof it.token?.name === 'string' ? it.token.name : null;
    if (
      isRobinhoodStockToken({
        chain,
        tokenAddress: chain === 'solana' ? tokenAddr : tokenAddr.toLowerCase(),
        tokenName,
      })
    ) {
      continue;
    }
    // Drop on-chain stock tokens (tokenized stock: SPCXB/AAPLB/NVDAB/Ondo 系等) —
    // 这类代币常作 swap 借道中间币被误判成买入,不是监控人物的 meme 意图。
    if (
      isOnchainStockToken({
        tokenAddress: chain === 'solana' ? tokenAddr : tokenAddr.toLowerCase(),
        tokenName,
      })
    ) {
      continue;
    }

    const cost = num(it.cost_usd);
    if (minCost > 0 && (cost == null || cost < minCost)) continue;

    const tx = String(it.tx_hash || '').trim() || null;
    const openOrCloseRaw = num(
      (it as { is_open_or_close?: string | number | null }).is_open_or_close
    );
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
      isOpenOrClose: openOrCloseRaw == null ? null : openOrCloseRaw === 1,
      eventTimeMs: ts * 1000,
    });
  }

  out.sort((a, b) => a.eventTimeMs - b.eventTimeMs);
  return out;
}
