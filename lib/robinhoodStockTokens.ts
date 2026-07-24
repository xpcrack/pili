/**
 * Robinhood Chain equity tokens (official "• Robinhood Token" stock/ETF wrappers).
 * These are not meme intent — drop them from pili feed at ingest + history purge.
 *
 * Detection:
 * 1) Known official contract denylist (covers XXYY path with no token name)
 * 2) Token name matching /Robinhood\s+Token/i (covers GMGN activity with name)
 *
 * Same-ticker memes (e.g. GME without "• Robinhood Token") stay visible.
 */

const ROBINHOOD_STOCK_NAME_RE = /Robinhood\s+Token/i;

/** Official equity token contracts seen on RH feed (lowercased). */
export const ROBINHOOD_OFFICIAL_STOCK_ADDRESSES = new Set<string>([
  // GME — GameStop • Robinhood Token
  '0x1b0e319c6a659f002271b69db8a7df2f911c153e',
  // NVDA
  '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec',
  // TSLA
  '0x322f0929c4625ed5bad873c95208d54e1c003b2d',
  // GOOGL
  '0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3',
  // AAPL
  '0xaf3d76f1834a1d425780943c99ea8a608f8a93f9',
  // MU
  '0xff080c8ce2e5feadaca0da81314ae59d232d4afd',
  // SPY
  '0x117cc2133c37b721f49de2a7a74833232b3b4c0c',
  // MSFT
  '0xe93237c50d904957cf27e7b1133b510c669c2e74',
  // COIN
  '0x6330d8c3178a418788df01a47479c0ce7ccf450b',
  // AMZN
  '0x12f190a9f9d7d37a250758b26824b97ce941bf54',
  // INTC
  '0xc72b96e0e48ecd4dc75e1e45396e26300bc39681',
  // META
  '0xc0d6457c16cc70d6790dd43521c899c87ce02f35',
  // AMD
  '0x86923f96303d656e4aa86d9d42d1e57ad2023fdc',
  // PLTR
  '0x894e1ec2d74ffe5aef8dc8a9e84686accb964f2a',
  // ORCL
  '0xb0992820e760d836549ba69bc7598b4af75dee03',
  // AMAT
  '0x36046893810a7e7fce501229d57dc3fc8c8716d0',
  // MRVL
  '0x62fd0668e10d8b72339be2dcf7643001688ff13b',
  // NFLX
  '0xe0444ef8bf4ed74f74fd73686e2ddf4c1c5591e8',
]);

export function isRobinhoodChain(chain: string | null | undefined): boolean {
  const c = (chain || '').trim().toLowerCase();
  return c === 'robinhood' || c === 'rh';
}

export function isRobinhoodStockTokenName(name: string | null | undefined): boolean {
  return Boolean(name && ROBINHOOD_STOCK_NAME_RE.test(name));
}

export function isRobinhoodOfficialStockAddress(address: string | null | undefined): boolean {
  const a = (address || '').trim().toLowerCase();
  return Boolean(a && ROBINHOOD_OFFICIAL_STOCK_ADDRESSES.has(a));
}

/**
 * True when this RH token should be excluded from feed.
 * Non-robinhood chains always return false.
 */
export function isRobinhoodStockToken(params: {
  chain?: string | null;
  tokenAddress?: string | null;
  tokenName?: string | null;
}): boolean {
  if (!isRobinhoodChain(params.chain)) return false;
  if (isRobinhoodOfficialStockAddress(params.tokenAddress)) return true;
  if (isRobinhoodStockTokenName(params.tokenName)) return true;
  return false;
}
