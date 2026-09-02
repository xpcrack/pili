import 'server-only';

/**
 * 花费监控 runtime：周期轮询 watch 地址的 OKX 交易，检测「净花费」——
 * 做 LP / 买入时必然付出的 quote/native 币。达到阈值则 Bark 通知 + 写 events。
 * 仅后台 worker 运行（runtime-tasks 注册，prod 进程不注册）。
 */
import { pushBark } from '@/lib/server/barkNotify';
import {
  isSpendCandidate,
  readSpendMonitorConfig,
  type SpendChain,
  type SpendLeg,
  type SpendMonitorConfig,
} from '@/lib/server/spendMonitor';
import { normalizeOkxSpendTransaction, getSymbolUsdPrice } from '@/lib/server/okxSpendNormalizer';
import type { OkxTransaction } from '@/lib/okx';
import { getDb, withSqliteBusyRetry } from '@/lib/server/sqlite';
import { listTrackedUsers } from '@/lib/server/trackedUsersRepo';
import type { User } from '@/types';

const CYCLE_INTERVAL_MS = 5 * 60_000;
const MAX_TRANSACTIONS_PER_WALLET_CHAIN = 100;

interface SpendMonitorDeps {
  fetchTransactions?: (address: string, chain: string, beginMs?: number) => Promise<{
    ok: boolean;
    transactions: OkxTransaction[];
    error?: string | null;
  }>;
  price?: (symbol: string, chain: SpendChain) => Promise<number | null>;
  config?: SpendMonitorConfig;
  now?: () => number;
}

/** Async wrapper: net spend USD with an async price oracle (ETH/BNB from OKX market, stables=$1). */
async function computeWalletNetSpendUsdAsync(
  tx: import('@/lib/server/spendMonitor').SpendTransaction,
  price: (symbol: string, chain: SpendChain) => Promise<number | null>
): Promise<number> {
  let total = 0;
  for (const leg of tx.outLegs) {
    const p = await price(leg.symbol, leg.chain);
    if (p != null) total += leg.amount * p;
  }
  for (const leg of tx.inLegs) {
    const p = await price(leg.symbol, leg.chain);
    if (p != null) total -= leg.amount * p;
  }
  return total;
}

function findUserByAddress(users: User[], address: string): User | null {
  const lower = address.toLowerCase();
  for (const user of users) {
    for (const addr of user.addresses || []) {
      if (addr.address.toLowerCase() === lower) return user;
    }
  }
  return null;
}

/** 聚合窗口内「同一地址×目标」的净花费，返回超过阈值的一组。 */
function aggregateCandidates(
  candidates: Array<{
    wallet: string;
    chain: string;
    timeMs: number;
    netUsd: number;
    legs: SpendLeg[];
    txHash: string;
    symbol: string;
  }>,
  windowMs: number,
  thresholdUsd: number,
  now: number
): Array<{ wallet: string; chain: string; totalUsd: number; count: number; latest: number }> {
  const groups = new Map<string, Array<(typeof candidates)[number]>>();
  for (const c of candidates) {
    const key = `${c.wallet}|${c.chain}`;
    const list = groups.get(key) || [];
    list.push(c);
    groups.set(key, list);
  }

  const out: Array<{ wallet: string; chain: string; totalUsd: number; count: number; latest: number }> = [];
  for (const [key, list] of groups) {
    // Only keep candidates in the window
    const inWindow = list.filter((c) => now - c.timeMs <= windowMs);
    if (inWindow.length === 0) continue;
    const totalUsd = inWindow.reduce((sum, c) => sum + c.netUsd, 0);
    const latest = Math.max(...inWindow.map((c) => c.timeMs));
    if (totalUsd >= thresholdUsd) {
      const [wallet, chain] = key.split('|');
      out.push({ wallet, chain, totalUsd, count: inWindow.length, latest });
    }
  }
  return out;
}

function persistSpendAlert(params: {
  userId: string;
  userJson: string;
  wallet: string;
  chain: string;
  totalUsd: number;
  count: number;
  latestMs: number;
  key: string;
}): void {
  withSqliteBusyRetry(
    () => {
      const db = getDb();
      const now = Date.now();
      db.prepare(
        `INSERT INTO trade_signal_alerts (
           dedupe_key, signal_type, user_id, chain, token_address_lower, token_symbol,
           trade_amount_usd, market_cap_usd, detail_json, triggered_at, sent_at, delivered
         ) VALUES (?, 'spend-monitor', ?, ?, ?, NULL, ?, NULL, ?, ?, ?, 1)
         ON CONFLICT(dedupe_key) DO NOTHING`
      ).run(
        params.key,
        params.userId,
        params.chain,
        params.wallet.toLowerCase(),
        params.totalUsd,
        JSON.stringify({
          wallet: params.wallet,
          totalUsd: params.totalUsd,
          txCount: params.count,
          userJson: params.userJson,
        }),
        params.latestMs,
        now
      );
    },
    { label: 'spendMonitor.persistSpendAlert' }
  );
}

function alreadySent(db: ReturnType<typeof getDb>, key: string): boolean {
  const row = db
    .prepare('SELECT dedupe_key FROM trade_signal_alerts WHERE dedupe_key = ? LIMIT 1')
    .get(key) as { dedupe_key: string } | undefined;
  return Boolean(row);
}

export async function runSpendMonitorCycle(deps: SpendMonitorDeps = {}): Promise<{
  sleepMs: number;
  status: string;
  detail: Record<string, unknown>;
}> {
  const config = deps.config ?? readSpendMonitorConfig();
  const now = deps.now ?? Date.now;
  const fetchTransactions =
    deps.fetchTransactions ??
    (async (address: string, chain: string, beginMs?: number) => {
      const { fetchOkxTransactionsByAddress } = await import('@/lib/okx');
      const result = await fetchOkxTransactionsByAddress(address, chain, { beginMs });
      return {
        ok: result.ok,
        transactions: (result.transactions ?? []) as OkxTransaction[],
        error: result.error ?? null,
      };
    });
  const price = deps.price ?? getSymbolUsdPrice;

  if (config.watchAddresses.length === 0) {
    return {
      sleepMs: CYCLE_INTERVAL_MS,
      status: 'idle',
      detail: { reason: 'no-watch-addresses', watchAddresses: 0 },
    };
  }

  const users = listTrackedUsers();
  const userByAddress = new Map<string, User>();
  for (const user of users) {
    for (const addr of user.addresses || []) {
      userByAddress.set(addr.address.toLowerCase(), user);
    }
  }

  const beginMs = now() - config.lookbackMs;
  const db = getDb();
  let candidates: Array<{
    wallet: string;
    chain: SpendChain;
    timeMs: number;
    netUsd: number;
    legs: SpendLeg[];
    txHash: string;
    symbol: string;
  }> = [];

  for (const wallet of config.watchAddresses) {
    for (const chain of config.chains) {
      const result = await fetchTransactions(wallet, chain, beginMs);
      if (!result.ok || result.transactions.length === 0) continue;

      for (const raw of result.transactions) {
        const tx = normalizeOkxSpendTransaction(raw, chain, (raw as OkxTransaction).chainIndex || '', wallet);
        if (!tx) continue;
        if (!isSpendCandidate(tx)) continue;

        // Precise USD uses the real async oracle; ETH/BNB from OKX market ticker,
        // stables = $1, unknown symbols omitted.
        const netUsd = await computeWalletNetSpendUsdAsync(tx, price);
        if (netUsd > 0) {
          candidates.push({
            wallet,
            chain,
            timeMs: tx.timeMs,
            netUsd,
            legs: [...tx.outLegs, ...tx.inLegs],
            txHash: tx.txHash,
            symbol: tx.symbol || '',
          });
        }
      }
    }
  }

  // netUsd 已在检测循环内用真实 oracle 算好（candidates 只保留净花费>0 者）。
  const alerts = aggregateCandidates(candidates, config.windowMs, config.spendThresholdUsd, now());

  let pushed = 0;
  for (const alert of alerts) {
    const user = userByAddress.get(alert.wallet);
    if (!user) continue;
    const key = `spend-monitor:${alert.wallet}:${alert.chain}:${Math.floor(alert.latest / 60_000)}`;
    if (alreadySent(db, key)) continue;

    const body = `${user.name} 在 ${alert.chain.toUpperCase()} 净花费 $${Math.round(alert.totalUsd)}（${alert.count} 笔，10 分钟）`;
    const result = await pushBark({
      title: `💰 ${user.name} 花钱了`,
      body,
      group: 'pili-spend',
      level: 'timeSensitive',
    });
    persistSpendAlert({
      userId: user.id,
      userJson: JSON.stringify(user),
      wallet: alert.wallet,
      chain: alert.chain,
      totalUsd: alert.totalUsd,
      count: alert.count,
      latestMs: alert.latest,
      key,
    });
    pushed += result.delivered > 0 ? 1 : 0;
  }

  return {
    sleepMs: CYCLE_INTERVAL_MS,
    status: pushed > 0 ? 'busy' : 'ok',
    detail: {
      watchAddresses: config.watchAddresses.length,
      candidates: candidates.length,
      alerts: alerts.length,
      pushed,
    },
  };
}

/** Runtime task entrypoint — background worker only. */
export async function runSpendMonitorCycleTask(): Promise<{
  sleepMs: number;
  status: string;
  detail: Record<string, unknown>;
}> {
  return runSpendMonitorCycle();
}
