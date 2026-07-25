/**
 * 共享 token 信息缓存 + 批量预取。
 *
 * 原本 ActivityCard 每张卡各自打 /api/token-logo（首屏 400 条 = 400 请求）。
 * 这里：
 * 1. 模块级缓存（带 LRU 上限）
 * 2. 按 chain:ca:symbol:bucket:txHash 去重
 * 3. 一次 POST /api/token-logo/batch，最多 40 条/批
 * 4. 订阅者（卡片）从缓存读，不自己发请求
 */

export interface TokenInfoSnapshot {
  logoUrl: string | null;
  marketCapUsd: number | null;
  marketCapAtTxUsd: number | null;
  marketCapAtTxEstimated: boolean;
  source?: 'dexscreener' | 'okx' | 'gmgn' | 'xxyy' | 'telegram-monitor' | null;
}

export interface TokenInfoRequest {
  chain: string;
  tokenAddress: string;
  tokenSymbol?: string;
  txTimestampMs?: number | null;
  txHash?: string | null;
}

const TOKEN_INFO_CACHE_MAX = 2000;
const TOKEN_AVATAR_CACHE_MAX = 1000;
const BATCH_SIZE = 40;

const tokenInfoCache = new Map<string, TokenInfoSnapshot>();
const tokenAvatarCache = new Map<string, string | null>();
const inFlightKeys = new Set<string>();
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeTokenInfoCache(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function lruSet<K, V>(map: Map<K, V>, key: K, value: V, max: number) {
  if (map.has(key)) {
    map.delete(key);
  } else if (map.size >= max) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

export function buildTokenInfoKey(req: TokenInfoRequest) {
  const chain = (req.chain || '').trim().toLowerCase();
  const ca = (req.tokenAddress || '').trim().toLowerCase();
  const symbol = (req.tokenSymbol || '').trim().toUpperCase();
  const ts =
    typeof req.txTimestampMs === 'number' && Number.isFinite(req.txTimestampMs) && req.txTimestampMs > 0
      ? Math.floor(req.txTimestampMs / 60_000)
      : 'none';
  const hash = (req.txHash || '').trim().toLowerCase() || 'none';
  return `${chain}:${ca}:${symbol}:${ts}:${hash}`;
}

export function buildTokenAvatarKey(chain: string, tokenAddress: string) {
  return `${(chain || '').trim().toLowerCase()}:${(tokenAddress || '').trim().toLowerCase()}`;
}

export function getCachedTokenInfo(key: string): TokenInfoSnapshot | undefined {
  return tokenInfoCache.get(key);
}

export function getCachedTokenAvatar(key: string): string | null | undefined {
  return tokenAvatarCache.get(key);
}

function putResult(key: string, avatarKey: string, info: TokenInfoSnapshot) {
  lruSet(tokenInfoCache, key, info, TOKEN_INFO_CACHE_MAX);
  if (info.logoUrl) {
    lruSet(tokenAvatarCache, avatarKey, info.logoUrl, TOKEN_AVATAR_CACHE_MAX);
  } else if (!tokenAvatarCache.has(avatarKey)) {
    lruSet(tokenAvatarCache, avatarKey, null, TOKEN_AVATAR_CACHE_MAX);
  }
}

/**
 * 批量预取。已缓存 / 进行中的 key 会自动跳过。
 * 调用方（feed 层）在 feed 变化时调用一次即可。
 */
export async function prefetchTokenInfo(requests: TokenInfoRequest[]): Promise<void> {
  const pending: Array<TokenInfoRequest & { key: string; avatarKey: string }> = [];
  const seen = new Set<string>();

  for (const req of requests) {
    const chain = (req.chain || '').trim();
    const tokenAddress = (req.tokenAddress || '').trim();
    if (!chain || !tokenAddress) continue;
    const key = buildTokenInfoKey(req);
    if (seen.has(key)) continue;
    seen.add(key);
    if (tokenInfoCache.has(key) || inFlightKeys.has(key)) continue;
    pending.push({
      ...req,
      chain,
      tokenAddress,
      key,
      avatarKey: buildTokenAvatarKey(chain, tokenAddress),
    });
  }

  if (pending.length === 0) return;

  for (const item of pending) inFlightKeys.add(item.key);

  try {
    for (let offset = 0; offset < pending.length; offset += BATCH_SIZE) {
      const chunk = pending.slice(offset, offset + BATCH_SIZE);
      try {
        const response = await fetch('/api/token-logo/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            items: chunk.map((item) => ({
              chain: item.chain,
              tokenAddress: item.tokenAddress,
              tokenSymbol: item.tokenSymbol || '',
              txTimestamp: item.txTimestampMs ?? undefined,
              txHash: item.txHash || undefined,
            })),
          }),
        });

        if (!response.ok) {
          // 失败时也要写空结果，避免无限重试
          for (const item of chunk) {
            putResult(item.key, item.avatarKey, {
              logoUrl: null,
              marketCapUsd: null,
              marketCapAtTxUsd: null,
              marketCapAtTxEstimated: false,
              source: null,
            });
          }
          continue;
        }

        const payload = (await response.json()) as {
          ok?: boolean;
          results?: Array<{
            key: string;
            logoUrl?: string | null;
            marketCapUsd?: number | null;
            marketCapAtTxUsd?: number | null;
            marketCapAtTxEstimated?: boolean;
            source?: TokenInfoSnapshot['source'];
          }>;
        };

        const byKey = new Map((payload.results || []).map((row) => [row.key, row] as const));
        for (const item of chunk) {
          const row = byKey.get(item.key);
          putResult(item.key, item.avatarKey, {
            logoUrl: typeof row?.logoUrl === 'string' && row.logoUrl.trim() ? row.logoUrl : null,
            marketCapUsd:
              typeof row?.marketCapUsd === 'number' && Number.isFinite(row.marketCapUsd)
                ? row.marketCapUsd
                : null,
            marketCapAtTxUsd:
              typeof row?.marketCapAtTxUsd === 'number' && Number.isFinite(row.marketCapAtTxUsd)
                ? row.marketCapAtTxUsd
                : null,
            marketCapAtTxEstimated: Boolean(row?.marketCapAtTxEstimated),
            source: row?.source || null,
          });
        }
      } catch {
        for (const item of chunk) {
          putResult(item.key, item.avatarKey, {
            logoUrl: null,
            marketCapUsd: null,
            marketCapAtTxUsd: null,
            marketCapAtTxEstimated: false,
            source: null,
          });
        }
      }
    }
  } finally {
    for (const item of pending) inFlightKeys.delete(item.key);
    notify();
  }
}
