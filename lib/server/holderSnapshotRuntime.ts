import 'server-only';

import { spawn } from 'node:child_process';

import {
  claimNextQueuedHolderSnapshotRun,
  completeHolderSnapshotRun,
  countQueuedHolderSnapshotRuns,
  ensureHolderSnapshotTables,
  failHolderSnapshotRun,
  queueManualHolderSnapshot,
  queuePeriodicHolderSnapshots,
  queueTradeTriggeredHolderSnapshots,
  readHolderSnapshotPeriodicCursor,
  readHolderSnapshotTradeCursor,
  type HolderSnapshotCollectedHolder,
} from '@/lib/server/holderSnapshotRepo';
import { getDb, type DbHandle } from '@/lib/server/sqlite';

const HOLDER_SNAPSHOT_TARGET_WALLET = 'CJ5fHkNPf3yd7fKnjv5VtBJTNDAWFiRfLCutpuTAnpis';
const HOLDER_SNAPSHOT_TARGET_CHAIN = 'solana';
const DEFAULT_IDLE_SLEEP_MS = 60_000;
const DEFAULT_BACKLOG_SLEEP_MS = 1_000;
const DEFAULT_POST_RUN_SLEEP_MS = 800;
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const GMGN_CLI_PATH = '/Users/xp/.nvm/versions/node/v24.11.1/bin/gmgn-cli';

interface HolderSnapshotPayload {
  list?: unknown;
  data?: {
    list?: unknown;
  };
}

interface RunHolderSnapshotCycleOptions {
  db?: DbHandle;
  walletAddress?: string;
  chain?: string;
  now?: () => number;
  signal?: AbortSignal;
  readHolderSnapshotPeriodicCursor?: typeof readHolderSnapshotPeriodicCursor;
  readHolderSnapshotTradeCursor?: typeof readHolderSnapshotTradeCursor;
  queueTradeTriggeredHolderSnapshots?: typeof queueTradeTriggeredHolderSnapshots;
  queuePeriodicHolderSnapshots?: typeof queuePeriodicHolderSnapshots;
  claimNextQueuedHolderSnapshotRun?: typeof claimNextQueuedHolderSnapshotRun;
  completeHolderSnapshotRun?: typeof completeHolderSnapshotRun;
  failHolderSnapshotRun?: typeof failHolderSnapshotRun;
  countQueuedHolderSnapshotRuns?: typeof countQueuedHolderSnapshotRuns;
  collectTokenHolders?: (input: {
    tokenAddress: string;
    signal?: AbortSignal;
  }) => Promise<{
    holders: HolderSnapshotCollectedHolder[];
    meta: Record<string, unknown>;
  }>;
}

export interface HolderSnapshotCycleResult {
  sleepMs: number;
  status: 'idle' | 'busy' | 'partial' | 'error';
  detail: {
    queuedRunCount: number;
    lastQueuedTradeId: number;
    lastPeriodicBucketStartMs: number | null;
    lastProcessedRunId: number | null;
    lastProcessedRunStatus: string | null;
    scannedTradeCount: number;
    queuedTradeCount: number;
    queuedPeriodicCount: number;
    processedHolderCount: number | null;
    lastError: string | null;
  };
}

function getDbOrDefault(db?: DbHandle) {
  return db ?? getDb();
}

function ensureNotAborted(signal?: AbortSignal) {
  if (!signal?.aborted) {
    return;
  }
  const reason = signal.reason;
  throw reason instanceof Error ? reason : new Error(typeof reason === 'string' ? reason : 'holder snapshot aborted');
}

function getCurrentBucketStart(nowMs: number) {
  return Math.floor(nowMs / SIX_HOURS_MS) * SIX_HOURS_MS;
}

function toNullableNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toStringOrNull(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function toBoolean(value: unknown) {
  return value === true || value === 1 || value === '1';
}

function mapRawHolder(raw: Record<string, unknown>, index: number): HolderSnapshotCollectedHolder | null {
  const address = toStringOrNull(raw.address) ?? toStringOrNull(raw.owner) ?? toStringOrNull(raw.wallet_address);
  if (!address) {
    return null;
  }

  return {
    holderRank: toNumber(raw.rank) ?? index + 1,
    address,
    accountAddress:
      toStringOrNull(raw.account_address) ??
      toStringOrNull(raw.token_account) ??
      toStringOrNull(raw.token_account_address),
    addrType: toNullableNumber(raw.addr_type),
    exchange: toStringOrNull(raw.exchange),
    walletTagV2: toStringOrNull(raw.wallet_tag_v2),
    name: toStringOrNull(raw.name),
    twitterUsername: toStringOrNull(raw.twitter_username) ?? toStringOrNull(raw.twitter),
    balance:
      toNullableNumber(raw.balance) ??
      toNullableNumber(raw.amount) ??
      toNullableNumber(raw.token_amount),
    amountPercentage:
      toNullableNumber(raw.amount_percentage) ??
      toNullableNumber(raw.percentage) ??
      toNullableNumber(raw.holding_ratio),
    usdValue: toNullableNumber(raw.usd_value) ?? toNullableNumber(raw.value_usd),
    cost: toNullableNumber(raw.cost),
    profit: toNullableNumber(raw.profit),
    avgCost: toNullableNumber(raw.avg_cost),
    realizedProfit: toNullableNumber(raw.realized_profit),
    unrealizedProfit: toNullableNumber(raw.unrealized_profit),
    buyTxCountCur: toNullableNumber(raw.buy_tx_count_cur) ?? toNullableNumber(raw.buy_tx_count),
    sellTxCountCur: toNullableNumber(raw.sell_tx_count_cur) ?? toNullableNumber(raw.sell_tx_count),
    isNew: toBoolean(raw.is_new),
    isSuspicious: toBoolean(raw.is_suspicious),
    raw,
  };
}

function parseHolderList(stdout: string) {
  const payload = JSON.parse(stdout) as HolderSnapshotPayload;
  const rows = payload?.data?.list ?? payload?.list ?? [];
  if (!Array.isArray(rows)) {
    throw new Error('gmgn-cli payload does not contain array list/data.list');
  }
  const holders = rows
    .map((row, index) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        return null;
      }
      return mapRawHolder(row as Record<string, unknown>, index);
    })
    .filter((row): row is HolderSnapshotCollectedHolder => Boolean(row));

  return {
    holders,
    payloadShape: Array.isArray(payload?.data?.list) ? 'data.list' : 'list',
  };
}

async function collectTokenHoldersWithCli(input: { tokenAddress: string; signal?: AbortSignal }) {
  const startedAt = Date.now();

  return await new Promise<{ holders: HolderSnapshotCollectedHolder[]; meta: Record<string, unknown> }>(
    (resolve, reject) => {
      const args = ['token', 'holders', '--chain', 'sol', '--address', input.tokenAddress, '--limit', '100', '--raw'];
      const child = spawn(GMGN_CLI_PATH, args, {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const abort = () => {
        if (settled) {
          return;
        }
        child.kill('SIGTERM');
      };

      input.signal?.addEventListener('abort', abort, { once: true });

      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });

      child.on('error', (error) => {
        settled = true;
        input.signal?.removeEventListener('abort', abort);
        reject(error);
      });

      child.on('exit', (code, signal) => {
        if (settled) {
          return;
        }
        settled = true;
        input.signal?.removeEventListener('abort', abort);

        const durationMs = Date.now() - startedAt;
        if (input.signal?.aborted) {
          reject(new Error('gmgn-cli aborted'));
          return;
        }
        if (code !== 0) {
          reject(
            new Error(
              `gmgn-cli exited with code ${code ?? 'null'}${signal ? ` signal ${signal}` : ''}: ${stderr.trim().slice(0, 500)}`
            )
          );
          return;
        }

        try {
          const parsed = parseHolderList(stdout);
          resolve({
            holders: parsed.holders,
            meta: {
              durationMs,
              payloadShape: parsed.payloadShape,
              stdoutBytes: Buffer.byteLength(stdout),
              stderrPreview: stderr.trim().slice(0, 500),
            },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          reject(new Error(`failed to parse gmgn-cli output: ${message}`));
        }
      });
    }
  );
}

export async function queueManualHolderSnapshotRun(input: {
  tokenAddress: string;
  tokenSymbol?: string | null;
  walletAddress?: string;
  chain?: string;
  db?: DbHandle;
}) {
  const db = getDbOrDefault(input.db);
  ensureHolderSnapshotTables(db);
  return queueManualHolderSnapshot({
    walletAddress: input.walletAddress || HOLDER_SNAPSHOT_TARGET_WALLET,
    chain: input.chain || HOLDER_SNAPSHOT_TARGET_CHAIN,
    tokenAddress: input.tokenAddress,
    tokenSymbol: input.tokenSymbol,
    db,
  });
}

export async function runHolderSnapshotCycle(
  options: RunHolderSnapshotCycleOptions = {}
): Promise<HolderSnapshotCycleResult> {
  const db = getDbOrDefault(options.db);
  ensureHolderSnapshotTables(db);
  ensureNotAborted(options.signal);

  const now = options.now ?? Date.now;
  const walletAddress = options.walletAddress || HOLDER_SNAPSHOT_TARGET_WALLET;
  const chain = options.chain || HOLDER_SNAPSHOT_TARGET_CHAIN;
  const queueTradeImpl = options.queueTradeTriggeredHolderSnapshots ?? queueTradeTriggeredHolderSnapshots;
  const queuePeriodicImpl = options.queuePeriodicHolderSnapshots ?? queuePeriodicHolderSnapshots;
  const claimNextImpl = options.claimNextQueuedHolderSnapshotRun ?? claimNextQueuedHolderSnapshotRun;
  const completeRunImpl = options.completeHolderSnapshotRun ?? completeHolderSnapshotRun;
  const failRunImpl = options.failHolderSnapshotRun ?? failHolderSnapshotRun;
  const countQueuedImpl = options.countQueuedHolderSnapshotRuns ?? countQueuedHolderSnapshotRuns;
  const collectImpl = options.collectTokenHolders ?? collectTokenHoldersWithCli;
  const readTradeCursorImpl = options.readHolderSnapshotTradeCursor ?? readHolderSnapshotTradeCursor;
  const readPeriodicCursorImpl = options.readHolderSnapshotPeriodicCursor ?? readHolderSnapshotPeriodicCursor;

  const detail: HolderSnapshotCycleResult['detail'] = {
    queuedRunCount: 0,
    lastQueuedTradeId: readTradeCursorImpl(db),
    lastPeriodicBucketStartMs: readPeriodicCursorImpl(db),
    lastProcessedRunId: null,
    lastProcessedRunStatus: null,
    scannedTradeCount: 0,
    queuedTradeCount: 0,
    queuedPeriodicCount: 0,
    processedHolderCount: null,
    lastError: null,
  };

  try {
    const tradeQueueResult = queueTradeImpl({
      walletAddress,
      chain,
      db,
    });
    detail.scannedTradeCount = tradeQueueResult.scannedCount;
    detail.queuedTradeCount = tradeQueueResult.queuedCount;
    detail.lastQueuedTradeId = tradeQueueResult.lastSeenId ?? detail.lastQueuedTradeId;

    const nowMs = now();
    const bucketStartMs = getCurrentBucketStart(nowMs);
    const previousBucket = readPeriodicCursorImpl(db);
    if (previousBucket === null || bucketStartMs > previousBucket) {
      const periodicResult = queuePeriodicImpl({
        walletAddress,
        chain,
        bucketStartMs,
        db,
      });
      detail.queuedPeriodicCount = periodicResult.queuedCount;
      detail.lastPeriodicBucketStartMs = periodicResult.bucketStartMs;
    }

    ensureNotAborted(options.signal);

    const claimedRun = claimNextImpl(db);
    if (!claimedRun) {
      detail.queuedRunCount = countQueuedImpl(db);
      return {
        sleepMs: detail.queuedRunCount > 0 ? DEFAULT_BACKLOG_SLEEP_MS : DEFAULT_IDLE_SLEEP_MS,
        status: detail.queuedRunCount > 0 ? 'busy' : 'idle',
        detail,
      };
    }

    detail.lastProcessedRunId = claimedRun.id;

    const collected = await collectImpl({
      tokenAddress: claimedRun.tokenAddress,
      signal: options.signal,
    });
    ensureNotAborted(options.signal);

    const completedRun = completeRunImpl({
      runId: claimedRun.id,
      holders: collected.holders,
      meta: {
        ...collected.meta,
        collectedAt: now(),
      },
      db,
    });

    detail.lastProcessedRunStatus = completedRun?.status ?? 'completed';
    detail.processedHolderCount = completedRun?.holderCount ?? collected.holders.length;
    detail.queuedRunCount = countQueuedImpl(db);

    return {
      sleepMs: detail.queuedRunCount > 0 ? DEFAULT_BACKLOG_SLEEP_MS : DEFAULT_POST_RUN_SLEEP_MS,
      status: detail.queuedRunCount > 0 ? 'busy' : 'idle',
      detail,
    };
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    detail.lastError = message;

    if (detail.lastProcessedRunId) {
      failRunImpl({
        runId: detail.lastProcessedRunId,
        error: message,
        meta: {
          failedAt: now(),
        },
        db,
      });
      detail.lastProcessedRunStatus = 'failed';
    }

    detail.queuedRunCount = countQueuedImpl(db);
    return {
      sleepMs: DEFAULT_IDLE_SLEEP_MS,
      status: detail.lastProcessedRunId ? 'partial' : 'error',
      detail,
    };
  }
}

export function createHolderSnapshotCycleRunner(overrides: RunHolderSnapshotCycleOptions = {}) {
  return async function runHolderSnapshotCycleWithDeps(options: RunHolderSnapshotCycleOptions = {}) {
    return runHolderSnapshotCycle({
      ...overrides,
      ...options,
    });
  };
}
