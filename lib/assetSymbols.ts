// Symbols exempt from the liquidity≥$5k display filter because DexScreener does
// not track liquidity for native gas tokens and mainstream stablecoins, yet they
// are unambiguously liquid. Shared by the sidebar total (trackedUsersRepo) and
// the holdings detail panel (SelectedUserDetailsPanel) so both apply one list —
// a second copy here is how the total/holdings口径 drifted apart before.
export const LIQUID_ASSET_SYMBOLS = ['SOL', 'BNB', 'ETH', 'WETH', 'USDT', 'USDC'] as const;

const LIQUID_ASSET_SYMBOL_SET = new Set(LIQUID_ASSET_SYMBOLS.map((symbol) => symbol.toUpperCase()));

export function isStableOrNativeSymbol(symbol: string | null | undefined): boolean {
  if (!symbol) return false;
  return LIQUID_ASSET_SYMBOL_SET.has(symbol.toUpperCase());
}
