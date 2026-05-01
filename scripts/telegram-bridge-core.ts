import { readFileSync } from 'node:fs';

export interface TelegramMessageEntityLike {
  type?: string;
  url?: string;
  offset?: number;
  length?: number;
}

export interface TelegramInlineKeyboardButtonLike {
  text?: string;
  url?: string;
}

export interface TelegramMessageLike {
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

export interface TelegramUpdateLike {
  update_id: number;
  message?: TelegramMessageLike;
  channel_post?: TelegramMessageLike;
  edited_message?: TelegramMessageLike;
  edited_channel_post?: TelegramMessageLike;
}

export interface ParsedTwitterRelayPayload {
  sourceChatId: string;
  messageId: number | null;
  tweetId?: string;
  action: 'tweet' | 'quote' | 'reply';
  content: string;
  url?: string;
  authorHandle: string;
  createdAtMs: number;
}

export type BridgeHandleResult =
  | {
      kind: 'skip';
      reason: string;
      chatId: string;
      source: string;
      preview: string;
    }
  | {
      kind: 'telegram-monitor-forwarded';
      chatId: string;
      source: string;
      preview: string;
    }
  | {
      kind: 'twitter-relay-forwarded';
      chatId: string;
      source: string;
      preview: string;
      payload: ParsedTwitterRelayPayload;
    }
  | {
      kind: 'twitter-relay-parse-failed';
      chatId: string;
      source: string;
      preview: string;
      reason: string;
    };

const TWITTER_URL_PATTERN = /https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[^\s)]+/gi;
const TWITTER_RESERVED_PATHS = new Set([
  'explore',
  'home',
  'i',
  'intent',
  'login',
  'messages',
  'notifications',
  'search',
  'settings',
  'share',
]);

function normalize(value: string | undefined | null) {
  return (value || '').trim();
}

function normalizeLower(value: string | undefined | null) {
  return normalize(value).toLowerCase();
}

function isValidTwitterHandle(value: string) {
  return /^[A-Za-z0-9_]{1,15}$/.test(value);
}

function getMessageText(message: TelegramMessageLike) {
  return normalize(message.text || message.caption || '');
}

function getMessageEntities(message: TelegramMessageLike) {
  return Array.isArray(message.caption_entities) && message.caption_entities.length > 0
    ? message.caption_entities
    : Array.isArray(message.entities)
      ? message.entities
      : [];
}

function collectInlineKeyboardUrls(message: TelegramMessageLike) {
  const urls: string[] = [];
  for (const row of message.reply_markup?.inline_keyboard || []) {
    for (const button of row || []) {
      const url = normalize(button?.url);
      if (url) {
        urls.push(url);
      }
    }
  }
  return urls;
}

function collectEntityUrls(text: string, entities: TelegramMessageEntityLike[]) {
  const urls: string[] = [];
  for (const entity of entities) {
    if (!entity || typeof entity !== 'object') {
      continue;
    }

    if (entity.type === 'text_link') {
      const url = normalize(entity.url);
      if (url) {
        urls.push(url);
      }
      continue;
    }

    if (entity.type !== 'url') {
      continue;
    }

    const offset = typeof entity.offset === 'number' && Number.isFinite(entity.offset) ? Math.max(0, entity.offset) : -1;
    const length = typeof entity.length === 'number' && Number.isFinite(entity.length) ? Math.max(0, entity.length) : -1;
    if (offset < 0 || length <= 0) {
      continue;
    }

    const extracted = normalize(text.slice(offset, offset + length));
    if (extracted) {
      urls.push(extracted);
    }
  }
  return urls;
}

export function collectTwitterUrls(message: TelegramMessageLike) {
  const text = getMessageText(message);
  const urls = new Set<string>();

  for (const candidate of collectEntityUrls(text, getMessageEntities(message))) {
    urls.add(candidate);
  }
  for (const candidate of collectInlineKeyboardUrls(message)) {
    urls.add(candidate);
  }
  for (const match of text.match(TWITTER_URL_PATTERN) || []) {
    urls.add(match);
  }

  return Array.from(urls.values());
}

function collectStructuredTwitterUrls(text: string) {
  const urls: string[] = [];
  for (const line of text.replace(/\r/g, '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('🔗')) {
      continue;
    }
    for (const match of trimmed.match(TWITTER_URL_PATTERN) || []) {
      urls.push(match);
    }
  }
  return urls;
}

function parseTwitterUrl(urlText: string) {
  const text = normalize(urlText);
  if (!text) {
    return null;
  }

  try {
    const url = new URL(text);
    const hostname = normalizeLower(url.hostname).replace(/^www\./, '');
    if (hostname !== 'x.com' && hostname !== 'twitter.com') {
      return null;
    }

    const parts = url.pathname
      .split('/')
      .map((part) => normalize(part))
      .filter(Boolean);
    if (parts.length === 0) {
      return null;
    }

    if (parts[0] === 'i' && parts[1] === 'status' && /^\d+$/.test(parts[2] || '')) {
      return {
        url: text,
        authorHandle: '',
        tweetId: parts[2],
        kind: 'status' as const,
      };
    }

    const first = parts[0];
    if (!isValidTwitterHandle(first) || TWITTER_RESERVED_PATHS.has(first.toLowerCase())) {
      return null;
    }

    if (parts[1] === 'status' && /^\d+$/.test(parts[2] || '')) {
      return {
        url: text,
        authorHandle: first,
        tweetId: parts[2],
        kind: 'status' as const,
      };
    }

    return {
      url: text,
      authorHandle: first,
      tweetId: '',
      kind: 'profile' as const,
    };
  } catch {
    return null;
  }
}

function findTwitterRefs(message: TelegramMessageLike) {
  const text = getMessageText(message);
  const structuredParsed = collectStructuredTwitterUrls(text)
    .map((candidate) => parseTwitterUrl(candidate))
    .filter((candidate): candidate is NonNullable<ReturnType<typeof parseTwitterUrl>> => Boolean(candidate));
  const parsed = collectTwitterUrls(message)
    .map((candidate) => parseTwitterUrl(candidate))
    .filter((candidate): candidate is NonNullable<ReturnType<typeof parseTwitterUrl>> => Boolean(candidate));

  return {
    status:
      structuredParsed.find((candidate) => candidate.kind === 'status') ||
      parsed.find((candidate) => candidate.kind === 'status') ||
      null,
    profile:
      structuredParsed.find((candidate) => candidate.kind === 'profile') ||
      parsed.find((candidate) => candidate.kind === 'profile') ||
      null,
  };
}

function extractAuthorHandleFromText(text: string) {
  const handleMatch = text.match(/@([A-Za-z0-9_]{1,15})\b/);
  if (handleMatch?.[1]) {
    return handleMatch[1];
  }

  const trackedUserLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^你关注的用户[:：]/.test(line));
  if (!trackedUserLine) {
    return '';
  }

  const suffix = trackedUserLine.replace(/^你关注的用户[:：]\s*/, '');
  const nicknameMatch = suffix.match(/\((?:备注[:：][^)]*?)?\s*@?([A-Za-z0-9_]{1,15})\)/);
  if (nicknameMatch?.[1]) {
    return nicknameMatch[1];
  }

  return '';
}

const TWITTER_CONTENT_LABEL_PATTERN = /^(?:推文内容|📝\s*推文)[:：]\s*/;
const TWITTER_CONTENT_STOP_PATTERN =
  /^(监控到新推文|✨监控到新推文|你关注的用户[:：]|用户所属分组[:：]|共建|X \(formerly Twitter\)|View Details\b|👤\s*原推作者[:：]|原推作者[:：]|📝\s*原推[:：]|🔗)/;

function extractTwitterContent(text: string) {
  const lines = text.replace(/\r/g, '').split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] || '';
    if (!TWITTER_CONTENT_LABEL_PATTERN.test(line.trim())) {
      continue;
    }

    const firstLine = line.replace(TWITTER_CONTENT_LABEL_PATTERN, '').trimEnd();
    const contentLines = firstLine ? [firstLine] : [];

    for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
      const nextLine = lines[nextIndex] || '';
      const trimmed = nextLine.trim();
      if (TWITTER_CONTENT_STOP_PATTERN.test(trimmed)) {
        break;
      }
      contentLines.push(nextLine.trimEnd());
    }

    const content = contentLines.join('\n').trim();
    if (content) {
      return content;
    }
  }

  return '';
}

function inferTwitterAction(text: string, content: string): 'tweet' | 'quote' | 'reply' {
  const headline = text.split(/\r?\n/)[0]?.trim() || '';
  if (/回复了(?:\s|@|$)/.test(headline)) {
    return 'reply';
  }
  if (/(?:引用推文|转推)/.test(headline)) {
    return 'quote';
  }
  if (/发推/.test(headline)) {
    return 'tweet';
  }

  const trimmed = content.trim();
  if (/^RT\s*@/i.test(trimmed)) {
    return 'quote';
  }
  if (/^@\w/.test(trimmed)) {
    return 'reply';
  }
  return 'tweet';
}

export function looksLikeTwitterRelayMessage(message: TelegramMessageLike) {
  const text = getMessageText(message);
  if (!text) {
    return false;
  }

  if (/(?:^|\n)✨?监控到新推文\b/.test(text)) {
    return true;
  }
  if (/你关注的用户[:：]/.test(text) && /推文内容[:：]/.test(text)) {
    return true;
  }

  const refs = findTwitterRefs(message);
  return Boolean(refs.status || refs.profile);
}

export function parseTwitterRelayPayload(message: TelegramMessageLike): ParsedTwitterRelayPayload | null {
  if (!looksLikeTwitterRelayMessage(message)) {
    return null;
  }

  const text = getMessageText(message);
  const refs = findTwitterRefs(message);
  const content = extractTwitterContent(text);
  const authorHandle = normalizeLower(refs.status?.authorHandle || refs.profile?.authorHandle || extractAuthorHandleFromText(text));
  const tweetId = normalize(refs.status?.tweetId);
  const url = normalize(refs.status?.url);
  const sourceChatId = normalize(message.chat?.id ? String(message.chat.id) : '');
  const createdAtMs =
    typeof message.date === 'number' && Number.isFinite(message.date) ? Math.max(0, Math.floor(message.date * 1000)) : Date.now();
  const messageId =
    typeof message.message_id === 'number' && Number.isFinite(message.message_id) ? Math.floor(message.message_id) : null;

  if (!sourceChatId || !content || !authorHandle || (!tweetId && !url)) {
    return null;
  }

  return {
    sourceChatId,
    messageId,
    tweetId: tweetId || undefined,
    action: inferTwitterAction(text, content),
    content,
    url: url || undefined,
    authorHandle,
    createdAtMs,
  };
}

export function extractMessage(update: TelegramUpdateLike) {
  return update.message || update.channel_post || update.edited_message || update.edited_channel_post || null;
}

export function describeMessage(update: TelegramUpdateLike) {
  const message = extractMessage(update);
  const chatId = message?.chat?.id ? String(message.chat.id) : 'unknown';
  const source = message?.from?.username || (message?.from?.is_bot ? 'bot' : 'user');
  const preview = getMessageText(message || {}).split('\n')[0]?.slice(0, 120) || '(no text)';

  return {
    message,
    chatId,
    source,
    preview,
  };
}

export function shouldProcessBotMessage(update: TelegramUpdateLike) {
  const { message } = describeMessage(update);
  if (!message) {
    return false;
  }
  if (message.from?.is_bot !== true) {
    return false;
  }
  return Boolean(getMessageText(message));
}

export async function handleBridgeUpdate(
  update: TelegramUpdateLike,
  handlers: {
    forwardTelegramMonitor: (update: TelegramUpdateLike) => Promise<unknown>;
    forwardTwitterRelay: (payload: ParsedTwitterRelayPayload) => Promise<unknown>;
  }
): Promise<BridgeHandleResult> {
  const { message, chatId, source, preview } = describeMessage(update);
  if (!message) {
    return { kind: 'skip', reason: 'missing-message', chatId, source, preview };
  }
  if (message.from?.is_bot !== true) {
    return { kind: 'skip', reason: 'non-bot', chatId, source, preview };
  }
  if (!getMessageText(message)) {
    return { kind: 'skip', reason: 'empty-text', chatId, source, preview };
  }

  if (looksLikeTwitterRelayMessage(message)) {
    const payload = parseTwitterRelayPayload(message);
    if (!payload) {
      return {
        kind: 'twitter-relay-parse-failed',
        reason: 'missing-tweet-ref-or-author-or-content',
        chatId,
        source,
        preview,
      };
    }

    await handlers.forwardTwitterRelay(payload);
    return {
      kind: 'twitter-relay-forwarded',
      chatId,
      source,
      preview,
      payload,
    };
  }

  await handlers.forwardTelegramMonitor(update);
  return {
    kind: 'telegram-monitor-forwarded',
    chatId,
    source,
    preview,
  };
}

export function loadEnvFile(filePath: string) {
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
