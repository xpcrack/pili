import 'server-only';

/**
 * 花费监控（spend monitor）：检测特定人物的「净花费」——做 LP / 买入时必然
 * 付出的 native/quote 币（ETH/BNB/SOL/USDC/...），这些动作 GMGN wallet_activity
 * 不认、Alchemy webhook 也不投递，但余额必然变化。
 *
 * 检测口径（与 Finn 确认，2026-09-01）：
 *   - 监控：指定地址（默认 ROP 0x50f27cdb…）全 EVM 链（BSC/ETH/Base）
 *   - 信号：native 币单笔大额转出即「花钱」（买 gas / 做 LP 都触发）
 *   - 阈值：同一目标合约 10 分钟窗口内累计净花费 ≥ $50 才通知
 *   - 过滤：approve（0x095ea7b3）、0 金额、纯回流（转出又被自己接回）
 *
 * 数据源：OKX `transactions-by-address`（fetchOkxTransactionsByAddress）。
 * 复用现有 pushBark（通知）+ events 表（前端展示）。
 */

// ─── 常量 ───────────────────────────────────────────────

/** EVM approve 落地的 methodId —— 只授权不花钱，必须过滤。 */
const APPROVE_METHOD_IDS = new Set(['0x095ea7b3', '0x095ea7b3', '0x095ea7b3']);

/** Quote 币符号（单位 USD 价值近似）。ETH/BSC 的 native 是 ETH/BNB。 */
const QUOTE_SYMBOLS = new Set(['eth', 'weth', 'bnb', 'wbnb', 'usdc', 'usdt', 'dai', 'busd']);
const NATIVE_SYMBOLS = new Set(['eth', 'bnb']);

export type SpendChain = 'bsc' | 'ethereum' | 'base';

/** A native/quote leg that moved in a tx. */
export interface SpendLeg {
  address: string;
  amount: number;
  symbol: string;
  /** Resolved chain index → 'ethereum' | 'bsc' | 'base'. */
  chain: SpendChain;
}

/** One OKX transaction row, normalized for spend detection. */
export interface SpendTransaction {
  txHash: string;
  chain: SpendChain;
  timeMs: number;
  methodId: string | null;
  symbol: string;
  /** Legs that moved AWAY from the tracked wallet (spend / inflow we ignore). */
  outLegs: SpendLeg[];
  /** Legs that moved INTO the tracked wallet (rebase / swap reflux). */
  inLegs: SpendLeg[];
}

/** 目标是"该地址"的净花费，用注入的价格 oracle 折算 USD。保留同步版供测试用。 */
export interface PriceOracle {
  (symbol: string, chain: SpendChain): number | null;
}

/**
 * 是否为「纯 approve」——整笔交易只有 approve 授权、没有实际代币移动。
 * 单 approve 无 out/in legs（amount 0）也应过滤。
 */
export function isApprovalOnly(tx: SpendTransaction): boolean {
  if (APPROVE_METHOD_IDS.has((tx.methodId || '').toLowerCase())) return true;
  return tx.outLegs.length === 0 && tx.inLegs.length === 0;
}

/**
 * 计算「该地址」的净花费 USD（quote/native 流出 − 流入）。
 * outLegs/inLegs 已按 trackedAddress 过滤（见 normalizeOkxSpendTransaction），
 * 所以这里只累加 amount × price，不再需要按 wallet 过滤。
 */
export function computeWalletNetSpendUsd(
  tx: SpendTransaction,
  price: PriceOracle
): number {
  let total = 0;
  for (const leg of tx.outLegs) {
    const p = price(leg.symbol, leg.chain);
    if (p == null) continue;
    total += leg.amount * p;
  }
  for (const leg of tx.inLegs) {
    const p = price(leg.symbol, leg.chain);
    if (p == null) continue;
    total -= leg.amount * p;
  }
  return total;
}

export function isSymbolQuote(symbol: string | null | undefined): boolean {
  return QUOTE_SYMBOLS.has((symbol || '').toLowerCase());
}

export function isNativeSymbol(symbol: string | null | undefined): boolean {
  return NATIVE_SYMBOLS.has((symbol || '').toLowerCase());
}

/** 一条交易是否值得被当作「花钱」候选：有 quote/native 流向该地址、且非 approve 纯授权。 */
export function isSpendCandidate(tx: SpendTransaction): boolean {
  if (isApprovalOnly(tx)) return false;
  // 只看有 quote/native leg 的交易（ETH/BNB/USDC 等流出/流入）。
  const hasQuoteLeg = [...tx.outLegs, ...tx.inLegs].some((leg) => isSymbolQuote(leg.symbol));
  return hasQuoteLeg;
}

/**
 * 聚合：把同一目标合约（此处按交易方法 + 合约 = 净花费来源）在窗口内的
 * 多笔净花费累加。在调用侧做窗口聚合（见 spendMonitorRuntime）。
 */

// ─── 配置读取 ───────────────────────────────────────────

export interface SpendMonitorConfig {
  /** 要监控的地址列表（lowercased）。 */
  watchAddresses: string[];
  /** 每个地址监控的链。 */
  chains: SpendChain[];
  /** 单笔净花费 USD 阈值。 */
  spendThresholdUsd: number;
  /** 聚合窗口（同一目标合约内多笔累计）。 */
  windowMs: number;
  /** 轮询 lookback。 */
  lookbackMs: number;
}

export function readSpendMonitorConfig(env: Record<string, string | undefined> = process.env): SpendMonitorConfig {
  const watchRaw = env.PILI_SPEND_MONITOR_ADDRESSES || process.env.PILI_SPEND_MONITOR_ADDRESSES || '';
  const watchAddresses = watchRaw
    .split(',')
    .map((address) => address.trim().toLowerCase())
    .filter(Boolean);

  const chainsRaw = (env.PILI_SPEND_MONITOR_CHAINS || 'ethereum,bsc,base').trim().toLowerCase();
  const chains = chainsRaw
    .split(',')
    .map((chain) => chain.trim() as SpendChain)
    .filter((chain): chain is SpendChain =>
      chain === 'ethereum' || chain === 'bsc' || chain === 'base'
    );

  const spendThresholdUsd = parseFloat(env.PILI_SPEND_THRESHOLD_USD || '50');
  const windowMs = parseFloat(env.PILI_SPEND_WINDOW_MS || String(10 * 60_000));
  const lookbackMs = parseFloat(env.PILI_SPEND_LOOKBACK_MS || String(30 * 60_000));

  return {
    watchAddresses: [...new Set(watchAddresses)],
    chains: chains.length > 0 ? chains : ['ethereum', 'bsc', 'base'],
    spendThresholdUsd: Number.isFinite(spendThresholdUsd) && spendThresholdUsd > 0 ? spendThresholdUsd : 50,
    windowMs: Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 10 * 60_000,
    lookbackMs: Number.isFinite(lookbackMs) && lookbackMs > 0 ? lookbackMs : 30 * 60_000,
  };
}
