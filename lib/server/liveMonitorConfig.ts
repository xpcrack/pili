/**
 * Live monitor env switches — kept tiny to avoid import cycles with telegram ingest.
 */
export type LiveSourceMode = 'dual' | 'alchemy' | 'xxyy';

/** Loose env map so unit tests can pass plain objects. */
export type EnvMap = Record<string, string | undefined>;

export function readLiveSourceMode(env: EnvMap = process.env): LiveSourceMode {
  const raw = (env.PILI_LIVE_SOURCE || '').trim().toLowerCase();
  if (raw === 'alchemy' || raw === 'xxyy' || raw === 'dual') return raw;
  const hasInbox = Boolean(
    (env.PILI_ALCHEMY_INBOX_URL || env.NEWONE_ALCHEMY_INBOX_URL || '').trim() &&
      (env.PILI_ALCHEMY_PULL_TOKEN || env.NEWONE_ALCHEMY_PULL_TOKEN || '').trim()
  );
  return hasInbox ? 'dual' : 'xxyy';
}

/** Chains still accepted from XXYY TG. null = all chains. */
export function readXxyyAllowedChains(env: EnvMap = process.env): Set<string> | null {
  const mode = readLiveSourceMode(env);
  if (mode === 'xxyy') return null;
  if (mode === 'dual') {
    const raw = (env.PILI_LIVE_XXYY_CHAINS || '').trim().toLowerCase();
    if (!raw) return null;
    return new Set(
      raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    );
  }
  // alchemy-only: residual XXYY chains (default robinhood for Gate0 hybrid)
  const raw = (env.PILI_LIVE_XXYY_CHAINS || 'robinhood').trim().toLowerCase();
  if (raw === '*' || raw === 'all') return null;
  if (raw === 'none' || raw === '-') return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

export function shouldAcceptXxyyChain(
  chain: string | null | undefined,
  env: EnvMap = process.env
): boolean {
  const allowed = readXxyyAllowedChains(env);
  if (allowed == null) return true;
  const c = (chain || '').trim().toLowerCase();
  if (!c) return false;
  return allowed.has(c);
}
