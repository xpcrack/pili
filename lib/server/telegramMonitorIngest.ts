import 'server-only';

import { sendTelegramTextMessage } from '@/lib/server/telegramNotify';
import { consumeIngestAlertQuota } from '@/lib/server/ingestAlertRepo';
import { readSystemConfig } from '@/lib/server/systemConfigRepo';
import { listMonitoredUsers } from '@/lib/server/trackedUsersRepo';
import { isRobinhoodStockToken } from '@/lib/robinhoodStockTokens';
import { isOnchainStockToken } from '@/lib/onchainStockTokens';
import { enqueueLiveDoorbell } from '@/lib/server/liveDoorbellQueue';
import { readXxyyFeedMode, shouldAcceptXxyyChain } from '@/lib/server/liveMonitorConfig';
import { parseXxyyTelegramText } from '@/lib/server/xxyyTelegramParser';
import { upsertTelegramMonitorEvent } from '@/lib/server/telegramMonitorRepo';
import { isEvmChain } from '@/lib/addressBook';
import { projectAndPersistTelegramMonitorUpdate } from '@/lib/server/telegramMonitorProjectionService';
import {
  collectTelegramMessageLinks,
  extractTelegramMessage,
  extractTelegramMessageText,
  type TelegramUpdateLike,
} from '@/lib/server/telegramMonitorUpdateHelpers';

export type { TelegramMessageLike, TelegramUpdateLike } from '@/lib/server/telegramMonitorUpdateHelpers';

function getMonitorAuthConfig() {
  const relayToken = process.env.TELEGRAM_MONITOR_INGEST_TOKEN?.trim() || '';
  return {
    relayToken,
    enabled: Boolean(relayToken),
  };
}

export function authorizeTelegramMonitorHeaders(headers: Headers) {
  const config = getMonitorAuthConfig();
  if (!config.enabled) {
    return {
      ok: false as const,
      status: 503,
      body: {
        ok: false,
        error: '未配置 TELEGRAM_MONITOR_INGEST_TOKEN',
      },
    };
  }

  const authHeader = headers.get('authorization')?.trim() || '';
  const telegramSecretToken = headers.get('x-telegram-bot-api-secret-token')?.trim() || '';
  const expectedBearer = `Bearer ${config.relayToken}`;
  const matchesBearer = authHeader === expectedBearer;
  const matchesTelegramSecret = telegramSecretToken === config.relayToken;

  if (matchesBearer || matchesTelegramSecret) {
    return {
      ok: true as const,
    };
  }

  return {
    ok: false as const,
    status: 401,
    body: {
      ok: false,
      error: '鉴权失败',
    },
  };
}

const INGEST_ALERT_WINDOW_MS = 5 * 60 * 1000;

async function notifyIngestFormatIssue(params: {
  source: 'telegram-monitor';
  reason: string;
  sourceChatId: string | null;
  sourceMessageId: number | null;
  previewText: string;
}) {
  const config = readSystemConfig();
  const chatId = config.telegramUnknownPersonAlertChatId?.trim() || '';
  if (!chatId) {
    return;
  }

  const rateKey = `${params.source}|${params.sourceChatId || 'unknown'}|${params.reason}`;
  if (!consumeIngestAlertQuota(rateKey, INGEST_ALERT_WINDOW_MS)) {
    return;
  }

  const sourceRef = `${params.sourceChatId || 'unknown-chat'}:${params.sourceMessageId ?? 'unknown-message'}`;
  const text = [
    '⚠️ 拒收一条监控消息（格式/来源校验未通过）',
    `来源: ${params.source}`,
    `原因: ${params.reason}`,
    `消息定位: ${sourceRef}`,
    `预览: ${params.previewText.slice(0, 180) || '(empty)'}`,
  ].join('\n');

  await sendTelegramTextMessage({ chatId, text });
}

function isFeedCompatibleEvmChain(chain: string | null | undefined) {
  // Robinhood is feed-only EVM-compatible for wallet matching, not an address asset chain.
  return isEvmChain(chain) || chain === 'robinhood';
}

function isCompatibleChain(addressChain: string, eventChain: string) {
  if (addressChain === eventChain) {
    return true;
  }
  return isFeedCompatibleEvmChain(addressChain) && isFeedCompatibleEvmChain(eventChain);
}

/**
 * Match XXYY push to a Feishu-enabled (monitoring_enabled=1) wallet by address only.
 * Alias/person-name matching is intentionally NOT used: a disabled wallet still
 * labeled "Tendy" in XXYY must not attach to another enabled Tendy address.
 */
export function findTrackedUserMatch(parsed: {
  chain: string | null;
  walletAliasLabel?: string | null;
  walletLabel?: string | null;
  trackedWalletAddress: string | null;
}) {
  if (!parsed.chain) {
    return null;
  }

  const trackedWalletAddress = (parsed.trackedWalletAddress || '').trim().toLowerCase();
  if (!trackedWalletAddress) {
    return null;
  }

  // Only Feishu-enabled wallets (monitoring_enabled=1) are match targets.
  const users = listMonitoredUsers();
  const chain = parsed.chain;

  for (const user of users) {
    for (const address of user.addresses) {
      if (!isCompatibleChain(address.chain, chain)) continue;
      if (address.address.trim().toLowerCase() === trackedWalletAddress) {
        return { user, address };
      }
    }
  }

  return null;
}

async function notifyUnknownTrackedUser(params: {
  parsed: {
    walletAliasLabel: string | null;
    walletLabel: string | null;
    trackedWalletAddress: string | null;
    tokenSymbol: string | null;
    tokenAddress: string | null;
    chain: string | null;
  };
  sourceChatId: string | null;
  sourceMessageId: number | null;
}) {
  const config = readSystemConfig();
  const chatId = config.telegramUnknownPersonAlertChatId;
  if (!chatId) {
    return;
  }

  const person = params.parsed.walletAliasLabel || params.parsed.walletLabel || '未知人物';
  const tracked = params.parsed.trackedWalletAddress || '未知地址';
  const token = params.parsed.tokenSymbol || params.parsed.tokenAddress || '未知Token';
  const chain = params.parsed.chain || 'unknown';
  const source = `${params.sourceChatId || 'unknown-chat'}:${params.sourceMessageId ?? 'unknown-message'}`;

  const text = [
    '⚠️ 拒收一条 XXYY 监控消息（人物未在 pilipili 中）',
    `人物: ${person}`,
    `链: ${chain}`,
    `钱包: ${tracked}`,
    `Token: ${token}`,
    `来源: ${source}`,
    '请去 xxyy 取消该人物跟踪。',
  ].join('\n');

  await sendTelegramTextMessage({ chatId, text });
}

function shouldAutoTriggerTelegramMonitorReconciliation() {
  return (process.env.PILI_DISABLE_TELEGRAM_MONITOR_AUTO_RECONCILE || '').trim() !== '1';
}

export async function ingestTelegramMonitorUpdate(
  body: TelegramUpdateLike,
  channelType?: 'news' | 'social',
) {
  const message = extractTelegramMessage(body);
  if (!message) {
    return { ok: true, ignored: true, reason: 'no-message' as const };
  }

  const text = extractTelegramMessageText(message);

  if (!text) {
    return { ok: true, ignored: true, reason: 'empty-text' as const };
  }

  const sourceChatId = message.chat?.id ? String(message.chat.id) : null;
  const sourceMessageId = typeof message.message_id === 'number' ? message.message_id : null;
  const config = readSystemConfig();
  const allowedChatId = config.telegramTradeMonitorSourceChatId?.trim() || '';
  if (!allowedChatId) {
    await notifyIngestFormatIssue({
      source: 'telegram-monitor',
      reason: 'missing-monitor-chat-config',
      sourceChatId,
      sourceMessageId,
      previewText: text,
    });
    return { ok: true, ignored: true, reason: 'missing-monitor-chat-config' as const };
  }

  if (!sourceChatId || sourceChatId !== allowedChatId) {
    return { ok: true, ignored: true, reason: 'chat-not-allowed' as const };
  }

  const messageLinks = collectTelegramMessageLinks(message);
  const parsed = parseXxyyTelegramText(
    text,
    typeof message.date === 'number' ? message.date * 1000 : Date.now(),
    messageLinks
  );

  if (!parsed.chain || !parsed.tokenAddress || !parsed.action) {
    await notifyIngestFormatIssue({
      source: 'telegram-monitor',
      reason: 'invalid-trade-format',
      sourceChatId,
      sourceMessageId,
      previewText: text,
    });
    return { ok: true, ignored: true, reason: 'invalid-trade-format' as const };
  }

  if (!shouldAcceptXxyyChain(parsed.chain)) {
    return {
      ok: true,
      ignored: true,
      reason: 'xxyy-chain-filtered' as const,
      parsed: {
        chain: parsed.chain,
        walletLabel: parsed.walletLabel,
        walletAliasLabel: parsed.walletAliasLabel,
        trackedWalletAddress: parsed.trackedWalletAddress,
      },
    };
  }

  // Drop official RH equity tokens (stock/ETF wrappers) — not meme intent.
  if (
    isRobinhoodStockToken({
      chain: parsed.chain,
      tokenAddress: parsed.tokenAddress,
    })
  ) {
    return {
      ok: true,
      ignored: true,
      reason: 'robinhood-stock-token-filtered' as const,
      parsed: {
        chain: parsed.chain,
        walletLabel: parsed.walletLabel,
        walletAliasLabel: parsed.walletAliasLabel,
        trackedWalletAddress: parsed.trackedWalletAddress,
        tokenAddress: parsed.tokenAddress,
        tokenSymbol: parsed.tokenSymbol,
      },
    };
  }

  // Drop on-chain stock tokens (tokenized stock: SPCXB/AAPLB/NVDAB/Ondo 系等) —
  // 蹭股票名/代币化股票,不是监控人物的 meme 意图。XXYY parser 无 tokenName,靠地址黑名单。
  if (
    isOnchainStockToken({
      tokenAddress: parsed.tokenAddress,
    })
  ) {
    return {
      ok: true,
      ignored: true,
      reason: 'onchain-stock-token-filtered' as const,
      parsed: {
        chain: parsed.chain,
        walletLabel: parsed.walletLabel,
        walletAliasLabel: parsed.walletAliasLabel,
        trackedWalletAddress: parsed.trackedWalletAddress,
        tokenAddress: parsed.tokenAddress,
        tokenSymbol: parsed.tokenSymbol,
      },
    };
  }

  const trackedMatch = findTrackedUserMatch(parsed);
  if (!trackedMatch) {
    await notifyUnknownTrackedUser({
      parsed,
      sourceChatId,
      sourceMessageId,
    });

    return {
      ok: true,
      ignored: true,
      reason: 'unknown-tracked-user' as const,
      parsed: {
        chain: parsed.chain,
        walletLabel: parsed.walletLabel,
        walletAliasLabel: parsed.walletAliasLabel,
        trackedWalletAddress: parsed.trackedWalletAddress,
      },
    };
  }

  const eventTimeMs = parsed.eventTimeMs ?? (typeof message.date === 'number' ? message.date * 1000 : Date.now());
  const saved = upsertTelegramMonitorEvent({
    provider: 'xxyy',
    sourceChatId,
    sourceMessageId,
    updateId: typeof body.update_id === 'number' ? body.update_id : null,
    chain: parsed.chain,
    tokenAddress: parsed.tokenAddress,
    tokenSymbol: parsed.tokenSymbol,
    txHash: parsed.txHash,
    marketCapUsd: parsed.marketCapUsd,
    priceUsd: parsed.priceUsd,
    quoteAmount: parsed.quoteAmount,
    quoteSymbol: parsed.quoteSymbol,
    action: parsed.action,
    actionLabel: parsed.actionLabel,
    actionVariant: parsed.actionVariant,
    walletLabel: parsed.walletLabel,
    walletGroupLabel: parsed.walletGroupLabel,
    walletAliasLabel: parsed.walletAliasLabel,
    trackedWalletAddress: parsed.trackedWalletAddress,
    eventTimeMs,
    rawText: text,
    messageLinks,
    payload: body as unknown as Record<string, unknown>,
  });

  if (!saved.ok) {
    throw new Error(`telegram monitor event save failed: ${saved.reason}`);
  }

  const xxyyFeedMode = readXxyyFeedMode();

  let doorbellEnqueued: boolean | undefined;

  // Ring first so a local projection failure never prevents the GMGN follow-up.
  if (xxyyFeedMode === 'doorbell') {
    const ringAddress =
      (trackedMatch.address.address || '').trim() ||
      (parsed.trackedWalletAddress || '').trim();
    const doorbell = enqueueLiveDoorbell({
      address: ringAddress,
      userId: trackedMatch.user.id,
      chain: parsed.chain,
      source: 'xxyy',
    });
    doorbellEnqueued = Boolean(doorbell.enqueued);
  }

  if (xxyyFeedMode === 'off') {
    return {
      ok: true,
      saved,
      projected: false,
      feedMode: 'off' as const,
      ignored: true,
      reason: 'xxyy-feed-off' as const,
      parsed: {
        chain: parsed.chain,
        tokenAddress: parsed.tokenAddress,
        txHash: parsed.txHash,
        marketCapUsd: parsed.marketCapUsd,
        action: parsed.action,
        actionLabel: parsed.actionLabel,
        actionVariant: parsed.actionVariant,
        walletLabel: parsed.walletLabel,
        walletGroupLabel: parsed.walletGroupLabel,
        walletAliasLabel: parsed.walletAliasLabel,
        trackedWalletAddress: parsed.trackedWalletAddress,
      },
    };
  }

  try {
    const projection = await projectAndPersistTelegramMonitorUpdate({
      parsed: {
        ...parsed,
        chain: parsed.chain,
        tokenAddress: parsed.tokenAddress,
        action: parsed.action,
      },
      user: trackedMatch.user,
      sourceChatId,
      sourceMessageId,
      eventTimeMs,
      rawText: text,
      messageLinks,
      feedMode: xxyyFeedMode,
      autoReconcile: shouldAutoTriggerTelegramMonitorReconciliation(),
    });

    return {
      ok: true,
      saved,
      projected: projection.projected,
      doorbell: doorbellEnqueued,
      feedMode: xxyyFeedMode,
      parsed: {
        chain: parsed.chain,
        tokenAddress: parsed.tokenAddress,
        txHash: parsed.txHash,
        marketCapUsd: parsed.marketCapUsd,
        action: parsed.action,
        actionLabel: parsed.actionLabel,
        actionVariant: parsed.actionVariant,
        walletLabel: parsed.walletLabel,
        walletGroupLabel: parsed.walletGroupLabel,
        walletAliasLabel: parsed.walletAliasLabel,
        trackedWalletAddress: parsed.trackedWalletAddress,
      },
    };
  } catch (error) {
    if (xxyyFeedMode !== 'doorbell') throw error;
    console.error('[telegram-monitor-ingest] provisional doorbell projection failed', {
      sourceChatId,
      sourceMessageId,
      chain: parsed.chain,
      trackedWalletAddress: parsed.trackedWalletAddress,
      txHash: parsed.txHash,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: true,
      saved,
      projected: false,
      doorbell: doorbellEnqueued,
      feedMode: 'doorbell' as const,
      parsed: {
        chain: parsed.chain,
        tokenAddress: parsed.tokenAddress,
        txHash: parsed.txHash,
        marketCapUsd: parsed.marketCapUsd,
        action: parsed.action,
        actionLabel: parsed.actionLabel,
        actionVariant: parsed.actionVariant,
        walletLabel: parsed.walletLabel,
        walletGroupLabel: parsed.walletGroupLabel,
        walletAliasLabel: parsed.walletAliasLabel,
        trackedWalletAddress: parsed.trackedWalletAddress,
      },
    };
  }
}
