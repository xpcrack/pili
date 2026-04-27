import 'server-only';

import crypto from 'node:crypto';

import { getDb, withTransaction } from '@/lib/server/sqlite';
import { hashTelegramAgentToken } from '@/lib/server/telegramAgentToken';

type TelegramAgentPendingGrantStatus = 'waiting_agent_name' | 'cancelled';
type TelegramAgentGrantStatus = 'active' | 'revoked';

interface TelegramAgentPendingGrantRow {
  id: string;
  approval_chat_id: string;
  requested_chat_id: string;
  requested_by_telegram_user_id: string;
  requested_by_telegram_username: string | null;
  status: string;
  created_at: number;
  updated_at: number;
}

interface TelegramAgentGrantRow {
  id: string;
  approval_chat_id: string;
  agent_name: string;
  chat_id: string;
  scope_json: string;
  token_hash: string;
  token_preview: string;
  status: string;
  created_by_telegram_user_id: string;
  created_by_telegram_username: string | null;
  created_at: number;
  updated_at: number;
  revoked_at: number | null;
  revoked_by_telegram_user_id: string | null;
  last_used_at: number | null;
  use_count: number;
}

export interface TelegramAgentPendingGrant {
  id: string;
  approvalChatId: string;
  requestedChatId: string;
  requestedByTelegramUserId: string;
  requestedByTelegramUsername: string | null;
  status: TelegramAgentPendingGrantStatus;
  createdAt: number;
  updatedAt: number;
}

export interface TelegramAgentGrant {
  id: string;
  approvalChatId: string;
  agentName: string;
  chatId: string;
  scope: string[];
  tokenHash: string;
  tokenPreview: string;
  status: TelegramAgentGrantStatus;
  createdByTelegramUserId: string;
  createdByTelegramUsername: string | null;
  createdAt: number;
  updatedAt: number;
  revokedAt: number | null;
  revokedByTelegramUserId: string | null;
  lastUsedAt: number | null;
  useCount: number;
}

export interface SavePendingTelegramAgentGrantInput {
  approvalChatId: string;
  requestedChatId: string;
  requestedByTelegramUserId: string;
  requestedByTelegramUsername?: string | null;
}

export interface UpsertTelegramAgentGrantInput {
  approvalChatId: string;
  agentName: string;
  chatId: string;
  scope: string[];
  tokenHash: string;
  tokenPreview: string;
  createdByTelegramUserId: string;
  createdByTelegramUsername?: string | null;
}

export interface RevokeTelegramAgentGrantInput {
  agentName: string;
  chatId: string;
  revokedByTelegramUserId: string;
}

export interface RecordTelegramAgentGrantReadInput {
  grantId: string;
  agentName: string;
  chatId: string;
  command: string;
  scope: string;
  query: string | null;
  limitValue: number | null;
  resultCount: number | null;
  success: boolean;
  errorCode: string | null;
}

function normalizeOptional(value: string | null | undefined) {
  const trimmed = (value || '').trim();
  return trimmed || null;
}

function parseScope(scopeJson: string) {
  try {
    const parsed = JSON.parse(scopeJson) as unknown;
    if (!Array.isArray(parsed)) {
      return [] as string[];
    }
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [] as string[];
  }
}

function normalizeScope(scope: string[]) {
  return scope
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function mapPendingGrantRow(row: TelegramAgentPendingGrantRow): TelegramAgentPendingGrant {
  return {
    id: row.id,
    approvalChatId: row.approval_chat_id,
    requestedChatId: row.requested_chat_id,
    requestedByTelegramUserId: row.requested_by_telegram_user_id,
    requestedByTelegramUsername: row.requested_by_telegram_username,
    status:
      row.status === 'cancelled'
        ? 'cancelled'
        : ('waiting_agent_name' satisfies TelegramAgentPendingGrantStatus),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapGrantRow(row: TelegramAgentGrantRow): TelegramAgentGrant {
  return {
    id: row.id,
    approvalChatId: row.approval_chat_id,
    agentName: row.agent_name,
    chatId: row.chat_id,
    scope: parseScope(row.scope_json),
    tokenHash: row.token_hash,
    tokenPreview: row.token_preview,
    status: row.status === 'revoked' ? 'revoked' : ('active' satisfies TelegramAgentGrantStatus),
    createdByTelegramUserId: row.created_by_telegram_user_id,
    createdByTelegramUsername: row.created_by_telegram_username,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at,
    revokedByTelegramUserId: row.revoked_by_telegram_user_id,
    lastUsedAt: row.last_used_at,
    useCount: row.use_count,
  };
}

function readGrantByAgentAndChat(agentName: string, chatId: string) {
  const row = getDb()
    .prepare(
      `SELECT
         id,
         approval_chat_id,
         agent_name,
         chat_id,
         scope_json,
         token_hash,
         token_preview,
         status,
         created_by_telegram_user_id,
         created_by_telegram_username,
         created_at,
         updated_at,
         revoked_at,
         revoked_by_telegram_user_id,
         last_used_at,
         use_count
       FROM telegram_agent_grants
       WHERE agent_name = ?
         AND chat_id = ?
       LIMIT 1`
    )
    .get(agentName, chatId) as TelegramAgentGrantRow | undefined;

  return row ? mapGrantRow(row) : null;
}

export function savePendingTelegramAgentGrant(input: SavePendingTelegramAgentGrantInput) {
  return withTransaction((db) => {
    const now = Date.now();
    const id = crypto.randomUUID();

    db.prepare(
      `UPDATE telegram_agent_pending_grants
       SET status = 'cancelled',
           updated_at = ?
       WHERE requested_by_telegram_user_id = ?
         AND status = 'waiting_agent_name'`
    ).run(now, input.requestedByTelegramUserId);

    db.prepare(
      `INSERT INTO telegram_agent_pending_grants (
         id,
         approval_chat_id,
         requested_chat_id,
         requested_by_telegram_user_id,
         requested_by_telegram_username,
         status,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, 'waiting_agent_name', ?, ?)`
    ).run(
      id,
      input.approvalChatId,
      input.requestedChatId,
      input.requestedByTelegramUserId,
      normalizeOptional(input.requestedByTelegramUsername),
      now,
      now
    );

    const row = db
      .prepare(
        `SELECT
           id,
           approval_chat_id,
           requested_chat_id,
           requested_by_telegram_user_id,
           requested_by_telegram_username,
           status,
           created_at,
           updated_at
         FROM telegram_agent_pending_grants
         WHERE id = ?
         LIMIT 1`
      )
      .get(id) as TelegramAgentPendingGrantRow | undefined;

    if (!row) {
      throw new Error('failed to save pending telegram agent grant');
    }

    return mapPendingGrantRow(row);
  });
}

export function readPendingTelegramAgentGrantForUser(requestedByTelegramUserId: string) {
  const row = getDb()
    .prepare(
      `SELECT
         id,
         approval_chat_id,
         requested_chat_id,
         requested_by_telegram_user_id,
         requested_by_telegram_username,
         status,
         created_at,
         updated_at
       FROM telegram_agent_pending_grants
       WHERE requested_by_telegram_user_id = ?
         AND status = 'waiting_agent_name'
       ORDER BY updated_at DESC
       LIMIT 1`
    )
    .get(requestedByTelegramUserId) as TelegramAgentPendingGrantRow | undefined;
  return row ? mapPendingGrantRow(row) : null;
}

export function cancelPendingTelegramAgentGrantForUser(requestedByTelegramUserId: string) {
  const now = Date.now();
  const result = getDb()
    .prepare(
      `UPDATE telegram_agent_pending_grants
       SET status = 'cancelled',
           updated_at = ?
       WHERE requested_by_telegram_user_id = ?
         AND status = 'waiting_agent_name'`
    )
    .run(now, requestedByTelegramUserId);
  return result.changes > 0;
}

export function upsertTelegramAgentGrant(input: UpsertTelegramAgentGrantInput) {
  const normalizedScope = normalizeScope(input.scope);
  const now = Date.now();
  const db = getDb();
  const existing = db
    .prepare(
      `SELECT id
       FROM telegram_agent_grants
       WHERE agent_name = ?
         AND chat_id = ?
       LIMIT 1`
    )
    .get(input.agentName, input.chatId) as { id: string } | undefined;
  const id = existing?.id || crypto.randomUUID();

  db.prepare(
    `INSERT INTO telegram_agent_grants (
       id,
       approval_chat_id,
       agent_name,
       chat_id,
       scope_json,
       token_hash,
       token_preview,
       status,
       created_by_telegram_user_id,
       created_by_telegram_username,
       created_at,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
     ON CONFLICT(agent_name, chat_id) DO UPDATE SET
       approval_chat_id = excluded.approval_chat_id,
       scope_json = excluded.scope_json,
       token_hash = excluded.token_hash,
       token_preview = excluded.token_preview,
       status = 'active',
       created_by_telegram_user_id = excluded.created_by_telegram_user_id,
       created_by_telegram_username = excluded.created_by_telegram_username,
       updated_at = excluded.updated_at,
       revoked_at = NULL,
       revoked_by_telegram_user_id = NULL`
  ).run(
    id,
    input.approvalChatId,
    input.agentName,
    input.chatId,
    JSON.stringify(normalizedScope),
    input.tokenHash,
    input.tokenPreview,
    input.createdByTelegramUserId,
    normalizeOptional(input.createdByTelegramUsername),
    now,
    now
  );

  const row = readGrantByAgentAndChat(input.agentName, input.chatId);
  if (!row) {
    throw new Error('failed to upsert telegram agent grant');
  }
  return row;
}

export function getTelegramAgentGrantByToken(rawToken: string) {
  const tokenHash = hashTelegramAgentToken(rawToken);
  const row = getDb()
    .prepare(
      `SELECT
         id,
         approval_chat_id,
         agent_name,
         chat_id,
         scope_json,
         token_hash,
         token_preview,
         status,
         created_by_telegram_user_id,
         created_by_telegram_username,
         created_at,
         updated_at,
         revoked_at,
         revoked_by_telegram_user_id,
         last_used_at,
         use_count
       FROM telegram_agent_grants
       WHERE token_hash = ?
       LIMIT 1`
    )
    .get(tokenHash) as TelegramAgentGrantRow | undefined;
  return row ? mapGrantRow(row) : null;
}

export function listActiveTelegramAgentGrants() {
  const rows = getDb()
    .prepare(
      `SELECT
         id,
         approval_chat_id,
         agent_name,
         chat_id,
         scope_json,
         token_hash,
         token_preview,
         status,
         created_by_telegram_user_id,
         created_by_telegram_username,
         created_at,
         updated_at,
         revoked_at,
         revoked_by_telegram_user_id,
         last_used_at,
         use_count
       FROM telegram_agent_grants
       WHERE status = 'active'
       ORDER BY updated_at DESC, created_at DESC`
    )
    .all() as TelegramAgentGrantRow[];
  return rows.map(mapGrantRow);
}

export function revokeTelegramAgentGrant(input: RevokeTelegramAgentGrantInput) {
  const now = Date.now();
  getDb()
    .prepare(
      `UPDATE telegram_agent_grants
       SET status = 'revoked',
           updated_at = ?,
           revoked_at = ?,
           revoked_by_telegram_user_id = ?
       WHERE agent_name = ?
         AND chat_id = ?
         AND status = 'active'`
    )
    .run(now, now, input.revokedByTelegramUserId, input.agentName, input.chatId);

  return readGrantByAgentAndChat(input.agentName, input.chatId);
}

export function recordTelegramAgentGrantRead(input: RecordTelegramAgentGrantReadInput) {
  withTransaction((db) => {
    const now = Date.now();
    db.prepare(
      `INSERT INTO telegram_agent_grant_reads (
         grant_id,
         agent_name,
         chat_id,
         command,
         scope,
         query,
         limit_value,
         result_count,
         success,
         error_code,
         used_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      input.grantId,
      input.agentName,
      input.chatId,
      input.command,
      input.scope,
      normalizeOptional(input.query),
      input.limitValue,
      input.resultCount,
      input.success ? 1 : 0,
      normalizeOptional(input.errorCode),
      now
    );

    db.prepare(
      `UPDATE telegram_agent_grants
       SET last_used_at = ?,
           use_count = use_count + 1,
           updated_at = ?
       WHERE id = ?
         AND status = 'active'`
    ).run(now, now, input.grantId);
  });
}
