import { NextRequest, NextResponse } from '@/lib/server/httpCompat';
import { fetchTokenLogo } from '@/lib/tokenLogo';

export const dynamic = 'force-dynamic';

const MAX_BATCH_SIZE = 40;
const PER_ITEM_TIMEOUT_MS = 5000;

interface BatchItemInput {
  chain?: string;
  tokenAddress?: string;
  tokenSymbol?: string;
  txTimestamp?: number | string;
  txHash?: string;
}

interface BatchItemResult {
  key: string;
  chain: string;
  tokenAddress: string;
  ok: boolean;
  logoUrl: string | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  marketCapAtTxUsd: number | null;
  marketCapAtTxEstimated: boolean;
  marketCapAtTxSource?: 'telegram-monitor-exact' | 'estimated';
  source: 'dexscreener' | 'okx' | 'gmgn' | 'xxyy' | 'telegram-monitor' | null;
  error?: string;
}

function buildItemKey(item: {
  chain: string;
  tokenAddress: string;
  tokenSymbol: string;
  txTimestampMs: number | null;
  txHash: string;
}) {
  const bucket =
    item.txTimestampMs && item.txTimestampMs > 0
      ? String(Math.floor(item.txTimestampMs / 60_000))
      : 'none';
  return [
    item.chain,
    // 与 lib/tokenInfoCache.ts 的键规则一致：EVM hex 小写归一，
    // solana base58 大小写敏感保留原样，避免键碰撞。
    /^0x[0-9a-fA-F]+$/.test(item.tokenAddress) ? item.tokenAddress.toLowerCase() : item.tokenAddress,
    item.tokenSymbol.toUpperCase(),
    bucket,
    item.txHash.toLowerCase() || 'none',
  ].join(':');
}

/**
 * POST /api/token-logo/batch
 * body: { items: [{ chain, tokenAddress, tokenSymbol?, txTimestamp?, txHash? }] }
 *
 * 首屏 400 条交易各自打一次 token-logo 会把浏览器和上游都打爆。
 * 这里一次收一批，服务端按 chain+ca 串行限流，客户端只发 1 次。
 */
export async function POST(request: NextRequest) {
  let body: { items?: BatchItemInput[] } | null = null;
  try {
    body = (await request.json()) as { items?: BatchItemInput[] };
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 });
  }

  const rawItems = Array.isArray(body?.items) ? body!.items : [];
  if (rawItems.length === 0) {
    return NextResponse.json({ ok: true, results: [] as BatchItemResult[] });
  }
  if (rawItems.length > MAX_BATCH_SIZE) {
    return NextResponse.json(
      { ok: false, error: `batch too large (max ${MAX_BATCH_SIZE})` },
      { status: 400 }
    );
  }

  // 去重：同 key 只打一次上游
  const unique = new Map<
    string,
    {
      chain: string;
      tokenAddress: string;
      tokenSymbol: string;
      txTimestampMs: number | null;
      txHash: string;
    }
  >();

  for (const raw of rawItems) {
    const chain = typeof raw.chain === 'string' ? raw.chain.trim().toLowerCase() : '';
    const tokenAddress = typeof raw.tokenAddress === 'string' ? raw.tokenAddress.trim() : '';
    if (!chain || !tokenAddress) continue;
    const tokenSymbol = typeof raw.tokenSymbol === 'string' ? raw.tokenSymbol.trim() : '';
    const txTimestampMs =
      typeof raw.txTimestamp === 'number'
        ? raw.txTimestamp
        : typeof raw.txTimestamp === 'string'
          ? Number.parseInt(raw.txTimestamp, 10)
          : null;
    const normalizedTs =
      typeof txTimestampMs === 'number' && Number.isFinite(txTimestampMs) && txTimestampMs > 0
        ? txTimestampMs
        : null;
    const txHash = typeof raw.txHash === 'string' ? raw.txHash.trim() : '';
    const key = buildItemKey({
      chain,
      tokenAddress,
      tokenSymbol,
      txTimestampMs: normalizedTs,
      txHash,
    });
    if (!unique.has(key)) {
      unique.set(key, {
        chain,
        tokenAddress,
        tokenSymbol,
        txTimestampMs: normalizedTs,
        txHash,
      });
    }
  }

  // 并发 4 + 15s 总期限：40 条最坏 40×5s=200s 串行会把客户端 20s abort
  // 之后的整批工作全废。期限到后未完成项标记 deadline 失败，客户端按 key
  // 逐项缓存，缺的项下次渲染再补，不丢数据。
  const BATCH_CONCURRENCY = 4;
  const BATCH_DEADLINE_MS = 15_000;
  const deadline = Date.now() + BATCH_DEADLINE_MS;
  const entries = [...unique.entries()];
  const results: BatchItemResult[] = [];
  let nextIdx = 0;
  const workers = Array.from(
    { length: Math.min(BATCH_CONCURRENCY, entries.length) },
    async () => {
      while (true) {
        const idx = nextIdx++;
        if (idx >= entries.length) return;
        const [key, item] = entries[idx]!;
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          results.push({
            key,
            chain: item.chain,
            tokenAddress: item.tokenAddress,
            ok: false,
            logoUrl: null,
            marketCapUsd: null,
            liquidityUsd: null,
            marketCapAtTxUsd: null,
            marketCapAtTxEstimated: false,
            source: null,
            error: 'batch deadline',
          });
          continue;
        }
        try {
          const result = await Promise.race([
            fetchTokenLogo(item.chain, item.tokenAddress, item.tokenSymbol, {
              txTimestampMs: item.txTimestampMs ?? undefined,
              txHash: item.txHash || undefined,
            }),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error(`timeout ${PER_ITEM_TIMEOUT_MS}ms`)),
                Math.min(PER_ITEM_TIMEOUT_MS, remaining)
              )
            ),
          ]);
          results.push({
            key,
            chain: item.chain,
            tokenAddress: item.tokenAddress,
            ok: true,
            logoUrl: result.logoUrl,
            marketCapUsd: result.marketCapUsd,
            liquidityUsd: result.liquidityUsd,
            marketCapAtTxUsd: result.marketCapAtTxUsd,
            marketCapAtTxEstimated: result.marketCapAtTxEstimated,
            marketCapAtTxSource: result.marketCapAtTxSource,
            source: result.source,
          });
        } catch (error) {
          results.push({
            key,
            chain: item.chain,
            tokenAddress: item.tokenAddress,
            ok: false,
            logoUrl: null,
            marketCapUsd: null,
            liquidityUsd: null,
            marketCapAtTxUsd: null,
            marketCapAtTxEstimated: false,
            source: null,
            error: error instanceof Error ? error.message : 'fetch failed',
          });
        }
      }
    }
  );
  await Promise.all(workers);

  return NextResponse.json({ ok: true, results });
}
