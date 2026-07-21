/**
 * GMGN token info via local gmgn-cli (signed). Used for logos / RH tokens
 * where DexScreener + OKX have no coverage.
 */
import 'server-only';

import { spawn } from 'node:child_process';

const GMGN_CLI_PATH = process.env.GMGN_CLI_PATH?.trim() || 'gmgn-cli';
const DEFAULT_TIMEOUT_MS = 12_000;

export type GmgnTokenInfo = {
  logoUrl: string | null;
  symbol: string | null;
  name: string | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
};

function toGmgnCliChain(chain: string): string | null {
  const c = chain.trim().toLowerCase();
  if (c === 'solana' || c === 'sol') return 'sol';
  if (c === 'ethereum' || c === 'eth') return 'eth';
  if (c === 'bsc') return 'bsc';
  if (c === 'base') return 'base';
  if (c === 'robinhood' || c === 'rh') return 'robinhood';
  return null;
}

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
  bin = GMGN_CLI_PATH
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (error: Error | null, output?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(output || '');
    };

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(new Error(`gmgn-cli token info timed out after ${DEFAULT_TIMEOUT_MS}ms`));
    }, DEFAULT_TIMEOUT_MS);

    if (signal) {
      if (signal.aborted) {
        child.kill('SIGTERM');
        finish(new Error('gmgn-cli token info aborted'));
        return;
      }
      signal.addEventListener(
        'abort',
        () => {
          child.kill('SIGTERM');
          finish(new Error('gmgn-cli token info aborted'));
        },
        { once: true }
      );
    }

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => finish(error));
    child.on('close', (code, exitSignal) => {
      if (code === 0) {
        finish(null, stdout);
        return;
      }
      finish(
        new Error(
          `gmgn-cli token info exit ${code ?? 'null'}${exitSignal ? ` signal ${exitSignal}` : ''}: ${stderr.trim().slice(0, 400)}`
        )
      );
    });
  });
}

export async function fetchGmgnTokenInfo(
  chain: string,
  tokenAddress: string,
  options?: { signal?: AbortSignal; bin?: string }
): Promise<GmgnTokenInfo | null> {
  const gmgnChain = toGmgnCliChain(chain);
  const address = tokenAddress.trim();
  if (!gmgnChain || !address) {
    return null;
  }

  try {
    const stdout = await runGmgnTokenInfoCli(
      ['token', 'info', '--chain', gmgnChain, '--address', address, '--raw'],
      options?.signal,
      options?.bin
    );
    const text = stdout.trim();
    if (!text) return null;
    return parseGmgnTokenInfoPayload(text);
  } catch (error) {
    console.warn(
      `[gmgnTokenInfo] failed chain=${chain} token=${address}:`,
      error instanceof Error ? error.message : error
    );
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
  return toGmgnCliChain(chain);
}
