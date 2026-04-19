import 'server-only';

import { resolveTelegramBotToken } from '@/lib/server/telegramBotToken';

const TELEGRAM_API_BASE = 'https://api.telegram.org';

function getRelayBotToken() {
  return resolveTelegramBotToken();
}

export async function sendTelegramTextMessage(params: { chatId: string; text: string }) {
  const relayBotToken = getRelayBotToken();
  if (!relayBotToken) {
    return { ok: false as const, reason: 'missing_bot_token' as const };
  }

  const chatId = params.chatId.trim();
  const text = params.text.trim();
  if (!chatId || !text) {
    return { ok: false as const, reason: 'invalid_payload' as const };
  }

  const endpoint = `${TELEGRAM_API_BASE}/bot${relayBotToken}/sendMessage`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    return {
      ok: false as const,
      reason: 'telegram_request_failed' as const,
      status: response.status,
      detail: detail.slice(0, 300),
    };
  }

  return { ok: true as const };
}

