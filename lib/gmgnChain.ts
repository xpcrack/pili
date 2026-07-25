/** Shared pili ↔ GMGN chain segment mapping (client + server safe). */

export type GmgnChain = 'sol' | 'eth' | 'bsc' | 'base' | 'robinhood';

/** pili/internal chain name → GMGN URL / API segment. Null when unsupported. */
export function toGmgnChain(chain: string | null | undefined): GmgnChain | null {
  const c = (chain || '').trim().toLowerCase();
  if (c === 'solana' || c === 'sol') return 'sol';
  if (c === 'ethereum' || c === 'eth') return 'eth';
  if (c === 'bsc') return 'bsc';
  if (c === 'base') return 'base';
  if (c === 'robinhood' || c === 'rh') return 'robinhood';
  return null;
}

/** GMGN segment → pili chain id. */
export function normalizeGmgnChainToPili(chain: string): string {
  const c = chain.toLowerCase();
  if (c === 'sol' || c === 'solana') return 'solana';
  if (c === 'eth' || c === 'ethereum') return 'ethereum';
  if (c === 'bsc') return 'bsc';
  if (c === 'base') return 'base';
  if (c === 'robinhood' || c === 'rh') return 'robinhood';
  return c;
}
