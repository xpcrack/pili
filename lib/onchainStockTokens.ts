/**
 * 链上股票代币(tokenized stock)— 蹭股票名/代币化股票,不是监控人物的 meme 意图。
 *
 * 典型场景:监控人物在 PancakeSwap 买 starman,路由 `BUSD → SPCXB → starman`,
 * SPCXB 只是被借道的中间股票代币,链上监控却把它当成"买了 ~290U 的 SPCXB"入库。
 * 这类代币整体过滤,不在 pili feed 出现。
 *
 * 识别口径(用户决策:地址黑名单 + Tokenized 标记,零误杀):
 * 1) 已知链上股票代币地址黑名单(SPCXB/AAPLB/NVDAB/Ondo 系等),跨链,小写。
 * 2) token name 含 "Tokenized"(自动命中 Ondo 的 "NVIDIA (Ondo Tokenized)" 等)。
 *
 * 与 robinhoodStockTokens 的区别:那个只认 robinhood 链的官方股票 wrapper;
 * 本模块认 BSC/ETH 等链上的代币化股票,与链无关。两者并列,各管各的。
 */

/** name 里出现这个就判为代币化股票(Ondo 系命名规律)。 */
const TOKENIZED_NAME_RE = /Tokenized/i;

/**
 * 已知链上股票代币合约(小写)。
 * 新出现的链上股票代币手动加进这里即可。
 */
export const ONCHAIN_STOCK_ADDRESSES = new Set<string>([
  // SPCXB — SpaceX (bstocks, BSC)
  '0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1',
  // AAPLB — Apple (bstocks, BSC)
  '0x431a3bee82e2ca41e49895cbece5bb0f76a89b7a',
  // NVDAB — NVIDIA Corp (bstocks, BSC)
  '0x02fca66c1d1afb4e2a7884261eb00f63598a7436',
  // AAPLon — Apple (Ondo Tokenized, BSC)
  '0x390a684ef9cade28a7ad0dfa61ab1eb3842618c4',
  // NVDAon — NVIDIA (Ondo Tokenized, BSC)
  '0xa9ee28c80f960b889dfbd1902055218cba016f75',
]);

export function isOnchainStockAddress(address: string | null | undefined): boolean {
  const a = (address || '').trim().toLowerCase();
  return Boolean(a && ONCHAIN_STOCK_ADDRESSES.has(a));
}

export function isOnchainStockTokenName(name: string | null | undefined): boolean {
  return Boolean(name && TOKENIZED_NAME_RE.test(name));
}

/**
 * True when this token is an on-chain stock token and should be excluded from feed.
 * 跨链:不限定 chain,只要地址命中或 name 含 Tokenized 即过滤。
 */
export function isOnchainStockToken(params: {
  tokenAddress?: string | null;
  tokenName?: string | null;
}): boolean {
  if (isOnchainStockAddress(params.tokenAddress)) return true;
  if (isOnchainStockTokenName(params.tokenName)) return true;
  return false;
}
