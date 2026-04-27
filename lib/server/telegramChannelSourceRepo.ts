import 'server-only';

import crypto from 'node:crypto';

import { extractTelegramHandleFromUrl, normalizeTelegramUrl } from '@/lib/canonical';
import { getDb, withTransaction } from '@/lib/server/sqlite';
import { listTrackedUsers } from '@/lib/server/trackedUsersRepo';
import type {
  TelegramChannelSource,
  TelegramChannelSourceKind,
  TelegramChannelSourceStatus,
} from '@/lib/server/telegramChannelTypes';

interface TelegramChannelSourceRow {
  id: string;
  user_id: string;
  channel_ref: string;
  channel_ref_normalized: string;
  channel_title: string | null;
  channel_username: string | null;
  channel_chat_id: string | null;
  access_hash: string | null;
  source_kind: string;
  enabled: number;
  sync_status: string;
  last_message_id: number | null;
  last_synced_at_ms: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

function normalizeOptional(value: string | null | undefined) {
  const next = (value || '').trim();
  return next || null;
}

function normalizeSourceStatus(value: string | null | undefined): TelegramChannelSourceStatus {
  if (value === 'ready' || value === 'auth_required' || value === 'unavailable' || value === 'error') {
    return value;
  }
  return 'pending';
}

function normalizeSourceKind(value: string | null | undefined): TelegramChannelSourceKind {
  return value === 'manual' ? 'manual' : 'auto';
}

function resolveSourceKind(
  requestedKind: TelegramChannelSourceKind | undefined,
  existingKind: string | null | undefined
): TelegramChannelSourceKind {
  const normalizedExisting = existingKind ? normalizeSourceKind(existingKind) : null;
  if (requestedKind === 'manual') {
    return 'manual';
  }
  if (normalizedExisting === 'manual') {
    return 'manual';
  }
  if (requestedKind === 'auto') {
    return 'auto';
  }
  return normalizedExisting || 'manual';
}

function normalizeChannelRef(input: string) {
  const telegramUrl = normalizeTelegramUrl(input);
  const handle = extractTelegramHandleFromUrl(telegramUrl || input);
  if (!handle) {
    return {
      channelRef: input.trim(),
      channelRefNormalized: input.trim().replace(/^@+/, '').toLowerCase(),
    };
  }

  return {
    channelRef: `@${handle}`,
    channelRefNormalized: handle.toLowerCase(),
  };
}

function mapRow(row: TelegramChannelSourceRow): TelegramChannelSource {
  return {
    id: row.id,
    userId: row.user_id,
    channelRef: row.channel_ref,
    channelRefNormalized: row.channel_ref_normalized,
    channelTitle: row.channel_title,
    channelUsername: row.channel_username,
    channelChatId: row.channel_chat_id,
    accessHash: row.access_hash,
    sourceKind: normalizeSourceKind(row.source_kind),
    enabled: row.enabled === 1,
    syncStatus: normalizeSourceStatus(row.sync_status),
    lastMessageId: typeof row.last_message_id === 'number' ? row.last_message_id : null,
    lastSyncedAtMs: typeof row.last_synced_at_ms === 'number' ? row.last_synced_at_ms : null,
    lastError: row.last_error || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function upsertTelegramChannelSource(input: {
  userId: string;
  channelRef: string;
  enabled?: boolean;
  sourceKind?: TelegramChannelSourceKind;
}) {
  const { channelRef, channelRefNormalized } = normalizeChannelRef(input.channelRef);
  const now = Date.now();
  const db = getDb();
  const existing = db
    .prepare(
      `SELECT id, enabled, source_kind
       FROM telegram_channel_sources
       WHERE user_id = ?
         AND channel_ref_normalized = ?
       LIMIT 1`
    )
    .get(input.userId, channelRefNormalized) as { id: string; enabled: number; source_kind: string } | undefined;
  const id = existing?.id || crypto.randomUUID();
  const enabledValue = input.enabled !== undefined ? (input.enabled ? 1 : 0) : existing?.enabled ?? 1;
  const sourceKind = resolveSourceKind(input.sourceKind, existing?.source_kind);

  db.prepare(
    `INSERT INTO telegram_channel_sources (
       id,
       user_id,
       channel_ref,
       channel_ref_normalized,
       source_kind,
       enabled,
       sync_status,
       created_at,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
     ON CONFLICT(user_id, channel_ref_normalized) DO UPDATE SET
       channel_ref = excluded.channel_ref,
       source_kind = excluded.source_kind,
       enabled = excluded.enabled,
       updated_at = CASE
         WHEN telegram_channel_sources.channel_ref != excluded.channel_ref
           OR telegram_channel_sources.source_kind != excluded.source_kind
           OR telegram_channel_sources.enabled != excluded.enabled
         THEN excluded.updated_at
         ELSE telegram_channel_sources.updated_at
       END`
  ).run(id, input.userId, channelRef, channelRefNormalized, sourceKind, enabledValue, now, now);

  return getTelegramChannelSourceById(id)!;
}

export function bootstrapTelegramChannelSourcesFromTrackedUsers() {
  return withTransaction(() => {
    let count = 0;
    const db = getDb();
    for (const user of listTrackedUsers()) {
      const telegram = normalizeOptional(user.telegram);
      const autoSources = db
        .prepare(
          `SELECT id, channel_ref_normalized
           FROM telegram_channel_sources
           WHERE user_id = ?
             AND source_kind = 'auto'`
        )
        .all(user.id) as Array<{ id: string; channel_ref_normalized: string }>;

      const currentNormalized = telegram ? normalizeChannelRef(telegram).channelRefNormalized : '';
      if (telegram && currentNormalized) {
        upsertTelegramChannelSource({
          userId: user.id,
          channelRef: telegram,
          sourceKind: 'auto',
        });
        count += 1;
      }

      for (const staleSource of autoSources) {
        if (currentNormalized && staleSource.channel_ref_normalized === currentNormalized) {
          continue;
        }
        db.prepare(
          `UPDATE telegram_channel_sources
           SET enabled = 0,
               channel_title = null,
               channel_username = null,
               channel_chat_id = null,
               access_hash = null,
               sync_status = 'pending',
               last_message_id = null,
               last_synced_at_ms = null,
               last_error = null,
               updated_at = ?
           WHERE id = ?`
        ).run(Date.now(), staleSource.id);
      }
    }
    return count;
  });
}

export function getTelegramChannelSourceById(id: string) {
  const row = getDb()
    .prepare(
      `SELECT
         id,
         user_id,
         channel_ref,
         channel_ref_normalized,
         channel_title,
         channel_username,
         channel_chat_id,
         access_hash,
         source_kind,
         enabled,
         sync_status,
         last_message_id,
         last_synced_at_ms,
         last_error,
         created_at,
         updated_at
       FROM telegram_channel_sources
       WHERE id = ?
       LIMIT 1`
    )
    .get(id) as TelegramChannelSourceRow | undefined;

  return row ? mapRow(row) : null;
}

export function listTelegramChannelSources(params?: { enabledOnly?: boolean }) {
  const rows = getDb()
    .prepare(
      `SELECT
         id,
         user_id,
         channel_ref,
         channel_ref_normalized,
         channel_title,
         channel_username,
         channel_chat_id,
         access_hash,
         source_kind,
         enabled,
         sync_status,
         last_message_id,
         last_synced_at_ms,
         last_error,
         created_at,
         updated_at
       FROM telegram_channel_sources
       ${params?.enabledOnly ? 'WHERE enabled = 1' : ''}
       ORDER BY updated_at DESC, created_at DESC`
    )
    .all() as TelegramChannelSourceRow[];

  return rows.map(mapRow);
}

export function updateTelegramChannelSourceState(
  id: string,
  updates: {
    channelTitle?: string | null;
    channelUsername?: string | null;
    channelChatId?: string | null;
    accessHash?: string | null;
    enabled?: boolean;
    syncStatus?: TelegramChannelSourceStatus;
    lastMessageId?: number | null;
    lastSyncedAtMs?: number | null;
    lastError?: string | null;
  }
) {
  const current = getTelegramChannelSourceById(id);
  if (!current) {
    throw new Error(`telegram channel source not found: ${id}`);
  }

  const next = {
    channelTitle: updates.channelTitle !== undefined ? normalizeOptional(updates.channelTitle) : current.channelTitle,
    channelUsername:
      updates.channelUsername !== undefined ? normalizeOptional(updates.channelUsername) : current.channelUsername,
    channelChatId: updates.channelChatId !== undefined ? normalizeOptional(updates.channelChatId) : current.channelChatId,
    accessHash: updates.accessHash !== undefined ? normalizeOptional(updates.accessHash) : current.accessHash,
    enabled: updates.enabled !== undefined ? updates.enabled : current.enabled,
    syncStatus: updates.syncStatus !== undefined ? updates.syncStatus : current.syncStatus,
    lastMessageId:
      updates.lastMessageId !== undefined && typeof updates.lastMessageId === 'number'
        ? Math.max(0, Math.floor(updates.lastMessageId))
        : updates.lastMessageId === null
          ? null
          : current.lastMessageId,
    lastSyncedAtMs:
      updates.lastSyncedAtMs !== undefined && typeof updates.lastSyncedAtMs === 'number'
        ? Math.max(0, Math.floor(updates.lastSyncedAtMs))
        : updates.lastSyncedAtMs === null
          ? null
          : current.lastSyncedAtMs,
    lastError: updates.lastError !== undefined ? normalizeOptional(updates.lastError) : current.lastError,
  };

  getDb()
    .prepare(
      `UPDATE telegram_channel_sources
       SET channel_title = ?,
           channel_username = ?,
           channel_chat_id = ?,
           access_hash = ?,
           enabled = ?,
           sync_status = ?,
           last_message_id = ?,
           last_synced_at_ms = ?,
           last_error = ?,
           updated_at = ?
       WHERE id = ?`
    )
    .run(
      next.channelTitle,
      next.channelUsername,
      next.channelChatId,
      next.accessHash,
      next.enabled ? 1 : 0,
      next.syncStatus,
      next.lastMessageId,
      next.lastSyncedAtMs,
      next.lastError,
      Date.now(),
      id
    );

  return getTelegramChannelSourceById(id)!;
}
