import { NextRequest, NextResponse } from 'next/server';
import { fetchTokenLogo } from '@/lib/tokenLogo';

export const dynamic = 'force-dynamic';

const LOGO_CACHE_TTL_MS = 30 * 60 * 1000;
const logoCache = new Map<
  string,
  {
    logoUrl: string | null;
    marketCapUsd: number | null;
    marketCapAtTxUsd: number | null;
    marketCapAtTxEstimated: boolean;
    source: 'dexscreener' | 'okx' | 'xxyy' | 'telegram-monitor' | null;
    expiresAt: number;
  }
>();

function buildCacheKey(
  chain: string,
  tokenAddress: string,
  tokenSymbol?: string,
  txTimestampBucket?: string,
  txHashLower?: string
) {
  return `${chain.toLowerCase()}::${tokenAddress.toLowerCase()}::${(tokenSymbol || '').toUpperCase()}::${
    txTimestampBucket || 'none'
  }::${txHashLower || 'none'}`;
}

export async function GET(request: NextRequest) {
  const chain = request.nextUrl.searchParams.get('chain')?.trim().toLowerCase() || '';
  const tokenAddress = request.nextUrl.searchParams.get('tokenAddress')?.trim() || '';
  const tokenSymbol = request.nextUrl.searchParams.get('tokenSymbol')?.trim() || '';
  const txTimestampRaw = request.nextUrl.searchParams.get('txTimestamp')?.trim() || '';
  const txHash = request.nextUrl.searchParams.get('txHash')?.trim() || '';
  const txTimestampMs = Number.parseInt(txTimestampRaw, 10);
  const txHashLower = txHash ? txHash.toLowerCase() : '';
  const normalizedTxTimestampMs = Number.isFinite(txTimestampMs) && txTimestampMs > 0 ? txTimestampMs : null;
  const txTimestampBucket = normalizedTxTimestampMs ? String(Math.floor(normalizedTxTimestampMs / 60_000)) : undefined;

  if (!chain || !tokenAddress) {
    return NextResponse.json(
      {
        ok: false,
        error: '缺少 chain 或 tokenAddress 参数',
      },
      { status: 400 }
    );
  }

  const cacheKey = buildCacheKey(chain, tokenAddress, tokenSymbol, txTimestampBucket, txHashLower);
  const cached = logoCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return NextResponse.json({
      ok: true,
      logoUrl: cached.logoUrl,
      marketCapUsd: cached.marketCapUsd,
      marketCapAtTxUsd: cached.marketCapAtTxUsd,
      marketCapAtTxEstimated: cached.marketCapAtTxEstimated,
      source: cached.source,
      cached: true,
    });
  }

  const result = await fetchTokenLogo(chain, tokenAddress, tokenSymbol, {
    txTimestampMs: normalizedTxTimestampMs ?? undefined,
    txHash: txHash || undefined,
  });
  logoCache.set(cacheKey, {
    logoUrl: result.logoUrl,
    marketCapUsd: result.marketCapUsd,
    marketCapAtTxUsd: result.marketCapAtTxUsd,
    marketCapAtTxEstimated: result.marketCapAtTxEstimated,
    source: result.source,
    expiresAt: Date.now() + LOGO_CACHE_TTL_MS,
  });

  return NextResponse.json({
    ok: true,
    logoUrl: result.logoUrl,
    marketCapUsd: result.marketCapUsd,
    marketCapAtTxUsd: result.marketCapAtTxUsd,
    marketCapAtTxEstimated: result.marketCapAtTxEstimated,
    source: result.source,
    cached: false,
  });
}
