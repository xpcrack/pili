import { NextRequest, NextResponse } from 'next/server';

import { enforceAdminRateLimit, requireAdmin } from '@/lib/server/apiGuard';
import { resolveTelegramBotToken } from '@/lib/server/telegramBotToken';

const TELEGRAM_API_BASE = 'https://api.telegram.org';

function getRelayConfig() {
  const relayBotToken = resolveTelegramBotToken();
  const relayTargetChatId = process.env.TELEGRAM_RELAY_TARGET_CHAT_ID?.trim() || '';
  return {
    relayBotToken,
    relayTargetChatId,
    enabled: Boolean(relayBotToken && relayTargetChatId),
  };
}

function getTextPayload(body: Record<string, unknown>) {
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const source = typeof body.source === 'string' ? body.source.trim() : 'xxyy-monitor';
  if (!text) return null;
  return {
    text,
    source,
  };
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const unauthorizedResponse = requireAdmin(request);
  if (unauthorizedResponse) {
    return unauthorizedResponse;
  }

  const rateLimitResponse = enforceAdminRateLimit(request, {
    endpoint: 'telegram-relay',
    max: 20,
    windowMs: 60_000,
  });
  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  const config = getRelayConfig();
  if (!config.enabled) {
    return NextResponse.json(
      {
        ok: false,
        error: '未配置 TELEGRAM_RELAY_BOT_TOKEN/TELEGRAM_BRIDGE_BOT_TOKEN 或 TELEGRAM_RELAY_TARGET_CHAT_ID',
      },
      { status: 503 }
    );
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    return NextResponse.json({ ok: false, error: '请求体必须是 JSON' }, { status: 400 });
  }

  const payload = getTextPayload(body);
  if (!payload) {
    return NextResponse.json({ ok: false, error: '缺少 text 字段' }, { status: 400 });
  }

  const caption = `📡 [${payload.source}]\n${payload.text}`;
  const endpoint = `${TELEGRAM_API_BASE}/bot${config.relayBotToken}/sendMessage`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      chat_id: config.relayTargetChatId,
      text: caption,
      disable_web_page_preview: true,
    }),
  });

  const resultText = await response.text();
  if (!response.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: `Telegram relay failed: ${response.status}`,
        detail: resultText.slice(0, 300),
      },
      { status: 502 }
    );
  }

  return NextResponse.json({ ok: true, relayed: true });
}
