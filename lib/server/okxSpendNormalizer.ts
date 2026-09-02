import 'server-only';

/**
 * OKX 交易 → spend-monitor 归一化。
 * - itype 0 = native 币（ETH/BNB）；itype 2 = ERC20 转账。
 * - from/to 是 [{address, amount}] 数组；native 交易从/to 数组的 amount 常为空字符串，
 *   真实金额在顶层 `amount` 字段（实测 OKX native tx 即如此）。
 * - 方向判定：from 含 tracked → 花钱（outLegs）；to 含 tracked → 收到（inLegs）。
 */
import {
  type SpendChain,
  type SpendLeg,
  type SpendTransaction,
  isNativeSymbol,
} from '@/lib/server/spendMonitor';
import {
  fetchOkxTransactionsByAddress,
  fetchOkxMarketUsdPrice,
  type OkxTransaction,
} from '@/lib/okx';

const OKX_INDEX_TO_CHAIN: Record<string, SpendChain> = {
  '1': 'ethereum',
  '56': 'bsc',
  '8453': 'base',
};

function chainFromTx(chain: string, chainIndex: string): SpendChain | null {
  const explicit = OKX_INDEX_TO_CHAIN[chainIndex || ''];
  if (explicit) return explicit;
  const value = chain.trim().toLowerCase();
  if (value === 'ethereum' || value === 'bsc' || value === 'base') return value;
  return null;
}

function toSpendLeg(
  entry: { address?: string; amount?: string } | undefined,
  symbol: string,
  chain: SpendChain
): SpendLeg | null {
  if (!entry?.address) return null;
  const amount = parseFloat(entry.amount || '');
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return { address: entry.address, amount, symbol, chain };
}

function resolveSymbol(tx: OkxTransaction, chain: SpendChain): string {
  const s = (tx.symbol || '').trim().toLowerCase();
  if (s) return s;
  if (chain === 'bsc') return 'bnb';
  if (chain === 'ethereum' || chain === 'base') return 'eth';
  return s;
}

/** Normalize one OKX transaction row into SpendTransaction (filtered by chain). */
export function normalizeOkxSpendTransaction(
  tx: OkxTransaction,
  chainInput: string,
  chainIndexInput: string,
  trackedAddress: string
): SpendTransaction | null {
  const chain = chainFromTx(chainInput, chainIndexInput);
  if (!chain) return null;

  const methodId = tx.methodId || null;
  const symbol = resolveSymbol(tx, chain);
  const isNative = isNativeSymbol(symbol);
  const trackedLower = trackedAddress.trim().toLowerCase();

  const outLegs: SpendLeg[] = [];
  const inLegs: SpendLeg[] = [];

  const fromIsTracked = (tx.from || []).some(
    (entry) => (entry?.address || '').toLowerCase() === trackedLower
  );
  const toIsTracked = (tx.to || []).some(
    (entry) => (entry?.address || '').toLowerCase() === trackedLower
  );

  if (!fromIsTracked && !toIsTracked) {
    // 交易与该地址无关——跳过（正常不会出现，因为接口按地址查询）。
    if (!isNative) return null;
  }

  // 取该方向的精确金额：优先 per-leg 金额（>0），否则回退顶层 tx.amount。
  const directionAmount = (entries: Array<{ address?: string; amount?: string }> | undefined) => {
    for (const entry of entries || []) {
      if ((entry?.address || '').toLowerCase() !== trackedLower) continue;
      const leg = toSpendLeg(entry, symbol, chain);
      if (leg) return leg.amount;
    }
    const top = parseFloat(tx.amount || '');
    return Number.isFinite(top) && top > 0 ? top : null;
  };

  if (fromIsTracked) {
    const amount = directionAmount(tx.from);
    if (amount != null) outLegs.push({ address: trackedLower, amount, symbol, chain });
  }
  if (toIsTracked) {
    const amount = directionAmount(tx.to);
    if (amount != null) inLegs.push({ address: trackedLower, amount, symbol, chain });
  }

  const txHash = tx.txHash || '';
  const timeMs = Number(tx.txTime || '') || 0;

  return {
    txHash,
    chain,
    timeMs,
    methodId,
    symbol,
    outLegs,
    inLegs,
  };
}

export { isNativeSymbol };

/** Price oracle: get USD price for a quote/native symbol via OKX market ticker. */
export async function getSymbolUsdPrice(symbol: string, chain: SpendChain): Promise<number | null> {
  const normalized = symbol.toLowerCase();
  if (normalized === 'eth' || normalized === 'weth') {
    return fetchOkxMarketUsdPrice('ETH') ?? null;
  }
  if (normalized === 'bnb' || normalized === 'wbnb') {
    return fetchOkxMarketUsdPrice('BNB') ?? null;
  }
  if (normalized === 'usdc' || normalized === 'usdt' || normalized === 'dai' || normalized === 'busd') {
    // stablecoin ≈ $1
    return 1;
  }
  return null;
}
