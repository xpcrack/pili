/**
 * Live monitor env switches — kept tiny to avoid import cycles with telegram ingest.
 */
export type LiveSourceMode = 'dual' | 'alchemy' | 'xxyy';

/**
 * How XXYY TG trades enter the system:
 * - project: parse + write xxyy-monitor feed (legacy)
 * - doorbell: parse + write provisional feed + ring live-monitor → GMGN enriches/reconciles
 * - off: drop
 */
export type XxyyFeedMode = 'project' | 'doorbell' | 'off';

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

/**
 * Default: alchemy/dual → doorbell (XXYY provisional + GMGN enrichment); xxyy-only → project.
 * Override: PILI_XXYY_FEED=project|doorbell|off
 */
export function readXxyyFeedMode(env: EnvMap = process.env): XxyyFeedMode {
  const raw = (env.PILI_XXYY_FEED || '').trim().toLowerCase();
  if (raw === 'project' || raw === 'doorbell' || raw === 'off') return raw;
  return readLiveSourceMode(env) === 'xxyy' ? 'project' : 'doorbell';
}

/** Chains still accepted from XXYY when projecting feed. null = all chains. */
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
  // Doorbell mode: every chain can ring GMGN (Alchemy miss complement).
  if (readXxyyFeedMode(env) === 'doorbell') return true;
  if (readXxyyFeedMode(env) === 'off') return false;

  const allowed = readXxyyAllowedChains(env);
  if (allowed == null) return true;
  const c = (chain || '').trim().toLowerCase();
  if (!c) return false;
  return allowed.has(c);
}
