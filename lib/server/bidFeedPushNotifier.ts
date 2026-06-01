import 'server-only';

import { legacyFeedItemToCanonicalEvent } from '@/lib/canonical';
import { signInternalBidToken } from '@/lib/server/internalBidAuth';
import type { Activity, ChainType, User } from '@/types';

const DEFAULT_PUSH_URL = 'http://127.0.0.1:5050/api/internal/pilipili/feed-events';
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 200;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 2_000;

type FeedRow = { user: User; activity: Activity };

type BidFeedPushLog = (message: string, meta?: Record<string, unknown>) => void;

interface BidFeedPushDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: BidFeedPushLog;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  attemptTimeoutMs?: number;
}

export type BidFeedPushResult =
  | { ok: true; status: 'sent'; attempts: number; events: number; trades: number }
  | { ok: false; status: 'skipped-empty' | 'skipped-missing-config' | 'failed'; attempts: number; error?: string; events?: number; trades?: number };

interface BidPushOnchainEvent {
  eventId: string;
  userId: string;
  userName: string;
  sourceAddressName: string | null;
  chain: ChainType;
  trackedWalletAddress: string;
  trackedWalletAddressRaw: string;
  tokenAddress: string;
  tokenSymbol: string | null;
  txHash: string | null;
  action: 'buy' | 'sell' | 'send' | null;
  actionVariant: 'open' | 'add' | 'reduce' | 'close' | 'send' | null;
  eventTimeMs: number;
  walletAliasLabel: string | null;
  walletGroupLabel: string | null;
  marketCapUsd: number | null;
  messageLinks: string[];
}

interface BidPushTrade {
  eventId: string;
  userId: string;
  userName: string;
  sourceAddressName: string | null;
  chain: ChainType;
  trackedWalletAddress: string;
  trackedWalletAddressRaw: string;
  tokenAddress: string;
  tokenSymbol: string | null;
  txHash: string | null;
  action: 'buy' | 'sell';
  actionVariant: 'open' | 'add' | 'reduce' | 'close';
  eventTimeMs: number;
  tokenAmount: number;
  amountUsd: number | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  quoteSymbol: string | null;
  quoteAmount: number | null;
  costDataStatus: 'complete' | 'missing-usd' | 'missing-market-cap' | 'partial';
}

export interface BidFeedPushPayload {
  events: BidPushOnchainEvent[];
  trades: BidPushTrade[];
}

function normalizeText(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeChainAddress(chain: ChainType, value: string) {
  const trimmed = normalizeText(value);
  return chain === 'solana' ? trimmed : trimmed.toLowerCase();
}

function parseNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.trim().replace(/,/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeConfigValue(value: string | undefined) {
  return (value || '').trim();
}

function resolvePushUrl(env: NodeJS.ProcessEnv) {
  return normalizeConfigValue(env.BID_FEED_PUSH_URL) || DEFAULT_PUSH_URL;
}

function hasSigningSecret(env: NodeJS.ProcessEnv) {
  return Boolean(normalizeConfigValue(env.INTERNAL_BID_HMAC_SECRET));
}

function normalizePositiveInteger(value: number | undefined, fallback: number) {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value!)) : fallback;
}

function computeRetryDelayMs(attempt: number, retryBaseDelayMs: number) {
  return retryBaseDelayMs * 2 ** Math.max(0, attempt - 1);
}

function formatUnknownError(error: unknown) {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'string') return error;
  return 'unknown error';
}

function formatResponseFailure(status: number, detail: string) {
  const normalizedDetail = detail.trim();
  return normalizedDetail ? `BID push responded ${status}: ${normalizedDetail}` : `BID push responded ${status}`;
}

function createDefaultLogger(): BidFeedPushLog {
  return (message, meta) => {
    if (meta) {
      console.error(`[bidFeedPushNotifier] ${message}`, meta);
      return;
    }
    console.error(`[bidFeedPushNotifier] ${message}`);
  };
}

function findSourceAddressName(user: User, chain: ChainType, trackedWalletAddress: string) {
  const normalizedTrackedAddress = normalizeChainAddress(chain, trackedWalletAddress);
  const exact = user.addresses.find(
    (address) => address.chain === chain && normalizeChainAddress(address.chain, address.address) === normalizedTrackedAddress
  );
  if (exact) return exact.name || null;

  const fallback = user.addresses.find(
    (address) => normalizeChainAddress(address.chain, address.address) === normalizedTrackedAddress
  );
  return fallback?.name || null;
}

function toOnchainAction(action: unknown): 'buy' | 'sell' | 'send' | null {
  if (action === 'buy' || action === 'sell' || action === 'send') return action;
  return null;
}

function toOnchainActionVariant(action: unknown): 'open' | 'add' | 'reduce' | 'close' | 'send' | null {
  if (action === 'open' || action === 'add' || action === 'reduce' || action === 'close' || action === 'send') return action;
  return null;
}

function getCostDataStatus(input: { amountUsd: number | null; priceUsd: number | null; marketCapUsd: number | null }): BidPushTrade['costDataStatus'] {
  const hasUsd = input.amountUsd !== null && input.priceUsd !== null;
  const hasMarketCap = input.marketCapUsd !== null;
  if (hasUsd && hasMarketCap) return 'complete';
  if (!hasUsd && hasMarketCap) return 'missing-usd';
  if (hasUsd && !hasMarketCap) return 'missing-market-cap';
  return 'partial';
}

export function buildBidFeedPushPayload(rows: FeedRow[]): BidFeedPushPayload {
  const events: BidPushOnchainEvent[] = [];
  const trades: BidPushTrade[] = [];

  for (const row of rows) {
    const canonical = legacyFeedItemToCanonicalEvent(row);
    if (!canonical || (canonical.type !== 'trade' && canonical.type !== 'transfer')) continue;
    if (!canonical.chain || !canonical.tokenAddress) continue;

    const trackedWalletAddress = canonical.type === 'trade'
      ? canonical.walletAddress
      : canonical.action === 'send'
        ? canonical.fromAddress
        : canonical.toAddress;
    const tokenAddress = normalizeText(canonical.tokenAddress);
    const trackedRaw = normalizeText(trackedWalletAddress);
    if (!trackedRaw || !tokenAddress) continue;

    const action = canonical.type === 'trade'
      ? (canonical.action === 'open' || canonical.action === 'add' ? 'buy' : 'sell')
      : canonical.action === 'send'
        ? 'send'
        : null;
    const actionVariant = canonical.type === 'trade' ? canonical.action : canonical.action === 'send' ? 'send' : null;
    const eventId = canonical.id;
    const sourceAddressName = findSourceAddressName(row.user, canonical.chain, trackedRaw);
    const tokenSymbol = normalizeText(canonical.tokenSymbol) || null;
    const marketCapUsd = canonical.type === 'trade' ? canonical.marketCapUsd : parseNumber(row.activity.metadata.marketCapAtTxUsd);
    const messageLinks = Array.isArray(row.activity.metadata.telegramLinkUrls) ? row.activity.metadata.telegramLinkUrls : [];

    events.push({
      eventId,
      userId: row.user.id,
      userName: row.user.name,
      sourceAddressName,
      chain: canonical.chain,
      trackedWalletAddress: trackedRaw,
      trackedWalletAddressRaw: trackedRaw,
      tokenAddress,
      tokenSymbol,
      txHash: normalizeText(canonical.txHash) || null,
      action: toOnchainAction(action),
      actionVariant: toOnchainActionVariant(actionVariant),
      eventTimeMs: canonical.timestamp,
      walletAliasLabel: normalizeText(row.activity.metadata.monitorWalletAliasLabel) || null,
      walletGroupLabel: normalizeText(row.activity.metadata.monitorWalletGroupLabel) || null,
      marketCapUsd,
      messageLinks,
    });

    if (canonical.type !== 'trade') continue;
    const tokenAmount = parseNumber(canonical.tokenAmount);
    if (tokenAmount === null || tokenAmount <= 0) continue;

    const amountUsd = parseNumber(canonical.amountUsd);
    const priceUsd = parseNumber(canonical.priceUsd);
    trades.push({
      eventId,
      userId: row.user.id,
      userName: row.user.name,
      sourceAddressName,
      chain: canonical.chain,
      trackedWalletAddress: trackedRaw,
      trackedWalletAddressRaw: trackedRaw,
      tokenAddress,
      tokenSymbol,
      txHash: normalizeText(canonical.txHash) || null,
      action: canonical.action === 'open' || canonical.action === 'add' ? 'buy' : 'sell',
      actionVariant: canonical.action,
      eventTimeMs: canonical.timestamp,
      tokenAmount,
      amountUsd,
      priceUsd,
      marketCapUsd,
      quoteSymbol: normalizeText(canonical.quoteSymbol) || null,
      quoteAmount: parseNumber(canonical.quoteAmount),
      costDataStatus: getCostDataStatus({ amountUsd, priceUsd, marketCapUsd }),
    });
  }

  return { events, trades };
}

export async function notifyBidFeedPush(rows: FeedRow[], deps: BidFeedPushDeps = {}): Promise<BidFeedPushResult> {
  const payload = buildBidFeedPushPayload(rows);
  if (payload.events.length === 0 && payload.trades.length === 0) {
    return { ok: false, status: 'skipped-empty', attempts: 0, events: 0, trades: 0 };
  }

  const env = deps.env || process.env;
  const url = resolvePushUrl(env);
  if (!url || !hasSigningSecret(env)) {
    return {
      ok: false,
      status: 'skipped-missing-config',
      attempts: 0,
      events: payload.events.length,
      trades: payload.trades.length,
    };
  }

  const fetchImpl = deps.fetchImpl || fetch;
  const sleep = deps.sleep || ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = deps.log || createDefaultLogger();
  const maxAttempts = normalizePositiveInteger(deps.maxAttempts, DEFAULT_MAX_ATTEMPTS);
  const retryBaseDelayMs = Number.isFinite(deps.retryBaseDelayMs)
    ? Math.max(0, Math.floor(deps.retryBaseDelayMs!))
    : DEFAULT_RETRY_BASE_DELAY_MS;
  const attemptTimeoutMs = normalizePositiveInteger(deps.attemptTimeoutMs, DEFAULT_ATTEMPT_TIMEOUT_MS);
  const body = JSON.stringify(payload);

  let lastError = 'unknown error';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort(new Error(`BID push timed out after ${attemptTimeoutMs}ms`));
    }, attemptTimeoutMs);

    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          authorization: `Bearer ${signInternalBidToken({ scope: 'internal:bid:write' })}`,
        },
        body,
        signal: controller.signal,
      });

      const responseText = await response.text().catch(() => '');
      if (response.ok) {
        const responsePayload = responseText ? JSON.parse(responseText) as { ok?: boolean; error?: string } : { ok: true };
        if (responsePayload.ok !== false) {
          return {
            ok: true,
            status: 'sent',
            attempts: attempt,
            events: payload.events.length,
            trades: payload.trades.length,
          };
        }
        lastError = responsePayload.error || 'BID push rejected';
      } else {
        lastError = formatResponseFailure(response.status, responseText);
      }

      log('push request failed', { attempt, maxAttempts, error: lastError });
    } catch (error) {
      lastError = formatUnknownError(error);
      log('push request threw', { attempt, maxAttempts, error: lastError });
    } finally {
      clearTimeout(timeoutId);
    }

    if (attempt < maxAttempts) {
      await sleep(computeRetryDelayMs(attempt, retryBaseDelayMs));
    }
  }

  return {
    ok: false,
    status: 'failed',
    attempts: maxAttempts,
    error: lastError,
    events: payload.events.length,
    trades: payload.trades.length,
  };
}

const inFlightBidFeedPushTasks = new Set<Promise<BidFeedPushResult>>();

function trackBidFeedPushTask(task: Promise<BidFeedPushResult>) {
  inFlightBidFeedPushTasks.add(task);
  void task.finally(() => {
    inFlightBidFeedPushTasks.delete(task);
  });
}

export function triggerBidFeedPush(rows: FeedRow[], deps: BidFeedPushDeps = {}) {
  trackBidFeedPushTask(notifyBidFeedPush(rows, deps));
}

export async function waitForBidFeedPushDrain() {
  while (inFlightBidFeedPushTasks.size > 0) {
    await Promise.allSettled(Array.from(inFlightBidFeedPushTasks));
  }
}
