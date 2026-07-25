/**
 * GMGN token info via local gmgn-cli (signed). Used for logos / RH tokens
 * where DexScreener + OKX have no coverage.
 */
import 'server-only';

import { toGmgnChain } from '@/lib/gmgnChain';
import { runGmgnCliAsync, resolveGmgnCliBin } from '@/lib/server/gmgnCli';

const DEFAULT_TIMEOUT_MS = 12_000;

export type GmgnTokenInfo = {
  logoUrl: string | null;
  symbol: string | null;
  name: string | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
};

/** In-process token info cache — same token won't re-hit GMGN within TTL. */
const TOKEN_INFO_CACHE_TTL_MS = 10 * 60_000;
const tokenInfoCache = new Map<string, { expiresAt: number; value: GmgnTokenInfo | null }>();

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function pickLogoUrl(raw: Record<string, unknown>): string | null {
  for (const key of ['logo', 'logo_url', 'logoUrl', 'image', 'image_url', 'imageUrl']) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim().startsWith('http')) {
      return value.trim();
    }
  }
  return null;
}

function parseGmgnTokenInfoPayload(stdout: string): GmgnTokenInfo | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const root = parsed as Record<string, unknown>;
  // Some CLI versions nest under data.
  const data =
    root.data && typeof root.data === 'object' && !Array.isArray(root.data)
      ? (root.data as Record<string, unknown>)
      : root;

  const logoUrl = pickLogoUrl(data);
  const symbol = typeof data.symbol === 'string' && data.symbol.trim() ? data.symbol.trim() : null;
  const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : null;

  const priceObj =
    data.price && typeof data.price === 'object' && !Array.isArray(data.price)
      ? (data.price as Record<string, unknown>)
      : null;
  const priceUsd =
    toFiniteNumber(priceObj?.price) ??
    toFiniteNumber(data.price) ??
    toFiniteNumber(data.price_usd);

  const totalSupply =
    toFiniteNumber(data.circulating_supply) ??
    toFiniteNumber(data.total_supply) ??
    toFiniteNumber(data.max_supply);
  const marketCapUsd =
    toFiniteNumber(data.market_cap) ??
    toFiniteNumber(data.marketCap) ??
    (priceUsd != null && totalSupply != null ? priceUsd * totalSupply : null);

  const pool =
    data.pool && typeof data.pool === 'object' && !Array.isArray(data.pool)
      ? (data.pool as Record<string, unknown>)
      : null;
  const liquidityUsd =
    toFiniteNumber(data.liquidity) ?? toFiniteNumber(pool?.liquidity) ?? null;

  if (!logoUrl && priceUsd == null && marketCapUsd == null) {
    return null;
  }

  return {
    logoUrl,
    symbol,
    name,
    priceUsd,
    marketCapUsd,
    liquidityUsd,
  };
}

async function runGmgnTokenInfoCli(
  args: string[],
  signal?: AbortSignal,
  bin?: string
): Promise<string> {
  try {
    return await runGmgnCliAsync({
      args,
      bin: resolveGmgnCliBin(bin),
      signal,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (/aborted/i.test(msg)) throw new Error('gmgn-cli token info aborted');
    if (/timed out/i.test(msg)) {
      throw new Error(`gmgn-cli token info timed out after ${DEFAULT_TIMEOUT_MS}ms`);
    }
    throw new Error(msg.replace(/^gmgn-cli exited/, 'gmgn-cli token info exit'));
  }
}

export async function fetchGmgnTokenInfo(
  chain: string,
  tokenAddress: string,
  options?: { signal?: AbortSignal; bin?: string }
): Promise<GmgnTokenInfo | null> {
  const gmgnChain = toGmgnChain(chain);
  const address = tokenAddress.trim();
  if (!gmgnChain || !address) {
    return null;
  }

  const cacheKey = `${gmgnChain}:${address.toLowerCase()}`;
  const now = Date.now();
  const cached = tokenInfoCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  try {
    const stdout = await runGmgnTokenInfoCli(
      ['token', 'info', '--chain', gmgnChain, '--address', address, '--raw'],
      options?.signal,
      options?.bin
    );
    const text = stdout.trim();
    const value = text ? parseGmgnTokenInfoPayload(text) : null;
    tokenInfoCache.set(cacheKey, { expiresAt: now + TOKEN_INFO_CACHE_TTL_MS, value });
    // prevent unbounded growth in long-lived process
    if (tokenInfoCache.size > 5000) {
      const first = tokenInfoCache.keys().next().value;
      if (first) tokenInfoCache.delete(first);
    }
    return value;
  } catch (error) {
    console.warn(
      `[gmgnTokenInfo] failed chain=${chain} token=${address}:`,
      error instanceof Error ? error.message : error
    );
    // short negative cache on failure to avoid stampede during ban
    tokenInfoCache.set(cacheKey, { expiresAt: now + 60_000, value: null });
    return null;
  }
}

export async function fetchGmgnTokenLogo(
  chain: string,
  tokenAddress: string,
  options?: { signal?: AbortSignal; bin?: string }
): Promise<string | null> {
  const info = await fetchGmgnTokenInfo(chain, tokenAddress, options);
  return info?.logoUrl ?? null;
}

/** Test helper: parse CLI stdout without spawning. */
export function parseGmgnTokenInfoForTests(stdout: string) {
  return parseGmgnTokenInfoPayload(stdout);
}

export function toGmgnCliChainForTests(chain: string) {
  return toGmgnChain(chain);
}
