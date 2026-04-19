import { readFileSync } from 'node:fs';
import path from 'node:path';

function loadEnvFile(filePath: string) {
  try {
    const content = readFileSync(filePath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch {
    // ignore missing file
  }
}

loadEnvFile(path.join(process.cwd(), '.env.local'));

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const BRIDGE_BOT_TOKEN = process.env.TELEGRAM_BRIDGE_BOT_TOKEN?.trim() || '';
const MONITOR_INGEST_TOKEN = process.env.TELEGRAM_MONITOR_INGEST_TOKEN?.trim() || '';
const MONITOR_ENDPOINT = process.env.TELEGRAM_MONITOR_ENDPOINT?.trim() || 'http://localhost:3005/api/telegram/monitor';
const TARGET_CHAT_ID = process.env.TELEGRAM_BRIDGE_TARGET_CHAT_ID?.trim() || '-5108676923';
const POLL_TIMEOUT_SECONDS = 30;
const RETRY_DELAY_MS = 3000;

interface TelegramMessageEntityLike {
  type?: string;
  url?: string;
}

interface TelegramInlineKeyboardButtonLike {
  text?: string;
  url?: string;
}

interface TelegramMessageLike {
  message_id?: number;
  date?: number;
  from?: {
    id?: number;
    is_bot?: boolean;
    username?: string;
  };
  chat?: {
    id?: number | string;
    type?: string;
    title?: string;
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
  update_id: number;
  message?: TelegramMessageLike;
  channel_post?: TelegramMessageLike;
  edited_message?: TelegramMessageLike;
  edited_channel_post?: TelegramMessageLike;
}

function getApiUrl(method: string) {
  return `${TELEGRAM_API_BASE}/bot${BRIDGE_BOT_TOKEN}/${method}`;
}

async function telegramApi<T>(method: string, body?: Record<string, unknown>) {
  const response = await fetch(getApiUrl(method), {
    method: body ? 'POST' : 'GET',
    headers: body
      ? {
          'Content-Type': 'application/json',
        }
      : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  const payload = (await response.json().catch(() => null)) as { ok?: boolean; result?: T; description?: string } | null;
  if (!response.ok || !payload?.ok) {
    throw new Error(`Telegram ${method} failed: ${response.status} ${payload?.description || 'unknown error'}`);
  }

  return payload.result as T;
}

function extractMessage(update: TelegramUpdateLike) {
  return update.message || update.channel_post || update.edited_message || update.edited_channel_post || null;
}

function shouldForward(update: TelegramUpdateLike) {
  const message = extractMessage(update);
  if (!message) return false;
  const chatId = message.chat?.id ? String(message.chat.id) : '';
  if (TARGET_CHAT_ID && chatId !== TARGET_CHAT_ID) return false;
  const hasText = Boolean((message.text || '').trim() || (message.caption || '').trim());
  if (!hasText) return false;
  return message.from?.is_bot === true;
}

async function forwardUpdate(update: TelegramUpdateLike) {
  const response = await fetch(MONITOR_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-telegram-bot-api-secret-token': MONITOR_INGEST_TOKEN,
    },
    body: JSON.stringify(update),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Monitor ingest failed: ${response.status} ${text}`);
  }

  return text;
}

async function bootstrap() {
  if (!BRIDGE_BOT_TOKEN) {
    throw new Error('Missing TELEGRAM_BRIDGE_BOT_TOKEN');
  }
  if (!MONITOR_INGEST_TOKEN) {
    throw new Error('Missing TELEGRAM_MONITOR_INGEST_TOKEN');
  }

  await telegramApi('deleteWebhook', { drop_pending_updates: false });
  const me = await telegramApi<{ username?: string; first_name?: string }>('getMe');
  console.log(`[bridge] bot ready: ${me.username || me.first_name || 'unknown'}`);
  console.log(`[bridge] target chat: ${TARGET_CHAT_ID || '(all chats)'}`);
  console.log(`[bridge] monitor endpoint: ${MONITOR_ENDPOINT}`);
}

async function main() {
  await bootstrap();

  let offset = 0;

  while (true) {
    try {
      const updates = await telegramApi<TelegramUpdateLike[]>('getUpdates', {
        timeout: POLL_TIMEOUT_SECONDS,
        offset,
        allowed_updates: ['message', 'channel_post', 'edited_message', 'edited_channel_post'],
      });

      for (const update of updates) {
        offset = update.update_id + 1;
        const message = extractMessage(update);
        if (!message) continue;

        const chatId = message.chat?.id ? String(message.chat.id) : 'unknown';
        const source = message.from?.username || (message.from?.is_bot ? 'bot' : 'user');
        const preview = (message.text || message.caption || '').split('\n')[0]?.slice(0, 120) || '(no text)';

        if (!shouldForward(update)) {
          console.log(`[bridge] skip chat=${chatId} source=${source} preview=${preview}`);
          continue;
        }

        await forwardUpdate(update);
        console.log(`[bridge] forwarded chat=${chatId} source=${source} preview=${preview}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[bridge] error: ${message}`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
