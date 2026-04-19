import { NextRequest, NextResponse } from 'next/server';

import { sendTelegramTextMessage } from '@/lib/server/telegramNotify';
import { readSystemConfig } from '@/lib/server/systemConfigRepo';
import { listTrackedUsers } from '@/lib/server/trackedUsersRepo';
import { parseXxyyTelegramText } from '@/lib/server/xxyyTelegramParser';
import { upsertTelegramMonitorEvent } from '@/lib/server/telegramMonitorRepo';

function getMonitorAuthConfig() {
  const relayToken = process.env.TELEGRAM_MONITOR_INGEST_TOKEN?.trim() || '';
  return {
    relayToken,
    enabled: Boolean(relayToken),
  };
}

function isAuthorized(request: NextRequest) {
  const config = getMonitorAuthConfig();
  if (!config.enabled) {
    return { ok: false as const, reason: 'missing_token' as const };
  }

  const authHeader = request.headers.get('authorization')?.trim() || '';
  const telegramSecretToken = request.headers.get('x-telegram-bot-api-secret-token')?.trim() || '';
  const expectedBearer = `Bearer ${config.relayToken}`;
  const matchesBearer = authHeader === expectedBearer;
  const matchesTelegramSecret = telegramSecretToken === config.relayToken;

  return {
    ok: matchesBearer || matchesTelegramSecret,
    reason: matchesBearer || matchesTelegramSecret ? null : ('unauthorized' as const),
  };
}

interface TelegramMessageEntityLike {
  type?: string;
  url?: string;
}

interface TelegramInlineKeyboardButtonLike {
  url?: string;
}

interface TelegramMessageLike {
  message_id?: number;
  date?: number;
  chat?: {
    id?: number | string;
  };
  text?: string;
  caption?: string;
  entities?: TelegramMessageEntityLike[];
  caption_entities?: TelegramMessageEntityLike[];
  reply_markup?: {
    inline_keyboard?: TelegramInlineKeyboardButtonLike[][];
  };
}

interface TelegramUpdateLike {
  update_id?: number;
  message?: TelegramMessageLike;
  channel_post?: TelegramMessageLike;
}

function extractMessage(update: TelegramUpdateLike) {
  if (update.message) return update.message;
  if (update.channel_post) return update.channel_post;
  return null;
}

function collectMessageLinks(message: TelegramMessageLike) {
  const links = new Set<string>();
  const entities = [...(message.entities || []), ...(message.caption_entities || [])];

  for (const entity of entities) {
    if (entity.type === 'text_link' && typeof entity.url === 'string' && entity.url.trim()) {
      links.add(entity.url.trim());
    }
  }

  for (const row of message.reply_markup?.inline_keyboard || []) {
    for (const button of row || []) {
      if (typeof button?.url === 'string' && button.url.trim()) {
        links.add(button.url.trim());
      }
    }
  }

  return Array.from(links);
}

function normalizeAlias(value: string | null | undefined) {
  return (value || '')
    .trim()
    .toLowerCase()
    .replace(/#/g, '');
}

function isEvmChain(chain: string | null | undefined) {
  return chain === 'bsc' || chain === 'ethereum';
}

function isCompatibleChain(addressChain: string, eventChain: string) {
  if (addressChain === eventChain) {
    return true;
  }
  return isEvmChain(addressChain) && isEvmChain(eventChain);
}

function hasTrackedUserMatch(parsed: {
  chain: string | null;
  walletAliasLabel: string | null;
  walletLabel: string | null;
  trackedWalletAddress: string | null;
}) {
  if (!parsed.chain) {
    return false;
  }

  const users = listTrackedUsers();
  const chain = parsed.chain;
  const trackedWalletAddress = (parsed.trackedWalletAddress || '').trim().toLowerCase();
  const aliasLabel = normalizeAlias(parsed.walletAliasLabel || parsed.walletLabel);

  for (const user of users) {
    for (const address of user.addresses) {
      if (!isCompatibleChain(address.chain, chain)) continue;

      if (trackedWalletAddress && address.address.trim().toLowerCase() === trackedWalletAddress) {
        return true;
      }

      if (aliasLabel) {
        const userAlias = normalizeAlias(user.name);
        const addressAlias = normalizeAlias(address.name);
        if (aliasLabel === `${userAlias}${addressAlias}` || aliasLabel === addressAlias || aliasLabel === userAlias) {
          return true;
        }
      }
    }
  }

  return false;
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

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const auth = isAuthorized(request);
  if (!auth.ok) {
    const status = auth.reason === 'missing_token' ? 503 : 401;
    return NextResponse.json(
      {
        ok: false,
        error: auth.reason === 'missing_token' ? '未配置 TELEGRAM_MONITOR_INGEST_TOKEN' : '鉴权失败',
      },
      { status }
    );
  }

  const body = (await request.json().catch(() => null)) as TelegramUpdateLike | null;
  if (!body) {
    return NextResponse.json({ ok: false, error: '请求体必须是 JSON' }, { status: 400 });
  }

  const message = extractMessage(body);
  if (!message) {
    return NextResponse.json({ ok: true, ignored: true, reason: 'no-message' });
  }

  const text =
    (typeof message.text === 'string' && message.text.trim()) ||
    (typeof message.caption === 'string' && message.caption.trim()) ||
    '';

  if (!text) {
    return NextResponse.json({ ok: true, ignored: true, reason: 'empty-text' });
  }

  const messageLinks = collectMessageLinks(message);
  const parsed = parseXxyyTelegramText(
    text,
    typeof message.date === 'number' ? message.date * 1000 : Date.now(),
    messageLinks
  );

  if (!parsed.chain || !parsed.tokenAddress) {
    return NextResponse.json({ ok: true, ignored: true, reason: 'missing-chain-or-ca' });
  }

  if (!hasTrackedUserMatch(parsed)) {
    await notifyUnknownTrackedUser({
      parsed,
      sourceChatId: message.chat?.id ? String(message.chat.id) : null,
      sourceMessageId: typeof message.message_id === 'number' ? message.message_id : null,
    });

    return NextResponse.json({
      ok: true,
      ignored: true,
      reason: 'unknown-tracked-user',
      parsed: {
        chain: parsed.chain,
        walletLabel: parsed.walletLabel,
        walletAliasLabel: parsed.walletAliasLabel,
        trackedWalletAddress: parsed.trackedWalletAddress,
      },
    });
  }

  const saved = upsertTelegramMonitorEvent({
    provider: 'xxyy',
    sourceChatId: message.chat?.id ? String(message.chat.id) : null,
    sourceMessageId: typeof message.message_id === 'number' ? message.message_id : null,
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
    eventTimeMs: parsed.eventTimeMs,
    rawText: text,
    payload: body as unknown as Record<string, unknown>,
  });

  return NextResponse.json({
    ok: true,
    saved,
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
  });
}
