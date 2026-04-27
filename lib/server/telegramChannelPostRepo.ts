import 'server-only';

import { getDb } from '@/lib/server/sqlite';
import type { TelegramChannelPost } from '@/lib/server/telegramChannelTypes';

interface TelegramChannelPostRow {
  id: number;
  channel_chat_id: string;
  channel_username: string | null;
  channel_title: string | null;
  message_id: number;
  grouped_id: string | null;
  posted_at_ms: number;
  edit_date_ms: number | null;
  text: string;
  text_entities_json: string;
  media_json: string;
  link_urls_json: string;
  forward_info_json: string | null;
  views: number | null;
  forwards: number | null;
  replies: number | null;
  raw_json: string;
  created_at: number;
  updated_at: number;
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeOptional(value: string | null | undefined) {
  const next = (value || '').trim();
  return next || null;
}

function normalizeStringArray(values: string[] | null | undefined) {
  const deduped = new Set<string>();
  for (const value of values || []) {
    const trimmed = (value || '').trim();
    if (!trimmed) continue;
    deduped.add(trimmed);
  }
  return Array.from(deduped.values());
}

function mapRow(row: TelegramChannelPostRow): TelegramChannelPost {
  return {
    id: row.id,
    channelChatId: row.channel_chat_id,
    channelUsername: row.channel_username,
    channelTitle: row.channel_title,
    messageId: row.message_id,
    groupedId: row.grouped_id,
    postedAtMs: row.posted_at_ms,
    editDateMs: typeof row.edit_date_ms === 'number' ? row.edit_date_ms : null,
    text: row.text,
    textEntities: parseJson<unknown[]>(row.text_entities_json, []),
    media: parseJson<string[]>(row.media_json, []),
    linkUrls: parseJson<string[]>(row.link_urls_json, []),
    forwardInfo: parseJson<Record<string, unknown> | null>(row.forward_info_json, null),
    views: typeof row.views === 'number' ? row.views : null,
    forwards: typeof row.forwards === 'number' ? row.forwards : null,
    replies: typeof row.replies === 'number' ? row.replies : null,
    raw: parseJson<Record<string, unknown>>(row.raw_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function upsertTelegramChannelPost(input: {
  channelChatId: string;
  channelUsername?: string | null;
  channelTitle?: string | null;
  messageId: number;
  groupedId?: string | null;
  postedAtMs: number;
  editDateMs?: number | null;
  text: string;
  textEntities?: unknown[];
  media?: string[];
  linkUrls?: string[];
  forwardInfo?: Record<string, unknown> | null;
  views?: number | null;
  forwards?: number | null;
  replies?: number | null;
  raw: Record<string, unknown>;
}) {
  const db = getDb();
  const now = Date.now();

  db.prepare(
    `INSERT INTO telegram_channel_posts (
       channel_chat_id,
       channel_username,
       channel_title,
       message_id,
       grouped_id,
       posted_at_ms,
       edit_date_ms,
       text,
       text_entities_json,
       media_json,
       link_urls_json,
       forward_info_json,
       views,
       forwards,
       replies,
       raw_json,
       created_at,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(channel_chat_id, message_id) DO UPDATE SET
       channel_username = excluded.channel_username,
       channel_title = excluded.channel_title,
       grouped_id = excluded.grouped_id,
       posted_at_ms = excluded.posted_at_ms,
       edit_date_ms = excluded.edit_date_ms,
       text = excluded.text,
       text_entities_json = excluded.text_entities_json,
       media_json = excluded.media_json,
       link_urls_json = excluded.link_urls_json,
       forward_info_json = excluded.forward_info_json,
       views = excluded.views,
       forwards = excluded.forwards,
       replies = excluded.replies,
       raw_json = excluded.raw_json,
       updated_at = excluded.updated_at`
  ).run(
    input.channelChatId,
    normalizeOptional(input.channelUsername),
    normalizeOptional(input.channelTitle),
    Math.max(0, Math.floor(input.messageId)),
    normalizeOptional(input.groupedId),
    Math.max(0, Math.floor(input.postedAtMs)),
    typeof input.editDateMs === 'number' && Number.isFinite(input.editDateMs) ? Math.floor(input.editDateMs) : null,
    input.text || '',
    JSON.stringify(input.textEntities || []),
    JSON.stringify(normalizeStringArray(input.media)),
    JSON.stringify(normalizeStringArray(input.linkUrls)),
    input.forwardInfo ? JSON.stringify(input.forwardInfo) : null,
    typeof input.views === 'number' && Number.isFinite(input.views) ? Math.max(0, Math.floor(input.views)) : null,
    typeof input.forwards === 'number' && Number.isFinite(input.forwards)
      ? Math.max(0, Math.floor(input.forwards))
      : null,
    typeof input.replies === 'number' && Number.isFinite(input.replies)
      ? Math.max(0, Math.floor(input.replies))
      : null,
    JSON.stringify(input.raw || {}),
    now,
    now
  );

  return getTelegramChannelPostByMessage(input.channelChatId, input.messageId)!;
}

export function getTelegramChannelPostByMessage(channelChatId: string, messageId: number) {
  const row = getDb()
    .prepare(
      `SELECT
         id,
         channel_chat_id,
         channel_username,
         channel_title,
         message_id,
         grouped_id,
         posted_at_ms,
         edit_date_ms,
         text,
         text_entities_json,
         media_json,
         link_urls_json,
         forward_info_json,
         views,
         forwards,
         replies,
         raw_json,
         created_at,
         updated_at
       FROM telegram_channel_posts
       WHERE channel_chat_id = ?
         AND message_id = ?
       LIMIT 1`
    )
    .get(channelChatId, Math.max(0, Math.floor(messageId))) as TelegramChannelPostRow | undefined;

  return row ? mapRow(row) : null;
}
