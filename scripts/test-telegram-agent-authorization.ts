import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';

async function run() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pilipili-telegram-agent-auth-'));
  const previousDataDir = process.env.PILIPILI_DATA_DIR;
  const previousDbPath = process.env.PILIPILI_DB_PATH;
  const previousApprovalAdminIds = process.env.TELEGRAM_APPROVAL_ADMIN_USER_IDS;
  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');
  process.env.TELEGRAM_APPROVAL_ADMIN_USER_IDS = '42';

  try {
    const {
      savePendingTelegramAgentGrant,
      readPendingTelegramAgentGrantForUser,
      upsertTelegramAgentGrant,
      getTelegramAgentGrantByToken,
      revokeTelegramAgentGrant,
      recordTelegramAgentGrantRead,
      listActiveTelegramAgentGrants,
    } = await import('../lib/server/telegramAgentGrantRepo');
    const { getDb } = await import('../lib/server/sqlite');
    const { hashTelegramAgentToken } = await import('../lib/server/telegramAgentToken');

    const pending = savePendingTelegramAgentGrant({
      approvalChatId: '-5130530086',
      requestedChatId: '-1001234567890',
      requestedByTelegramUserId: '42',
      requestedByTelegramUsername: 'xp',
    });
    assert.equal(pending.status, 'waiting_agent_name');
    assert.equal(readPendingTelegramAgentGrantForUser('42')?.requestedChatId, '-1001234567890');

    const rawToken = 'tgagt_fixture_token';
    const grant = upsertTelegramAgentGrant({
      approvalChatId: '-5130530086',
      agentName: 'researcher-a',
      chatId: '-1001234567890',
      scope: ['search', 'tail'],
      tokenHash: hashTelegramAgentToken(rawToken),
      tokenPreview: rawToken.slice(0, 8),
      createdByTelegramUserId: '42',
      createdByTelegramUsername: 'xp',
    });
    assert.equal(grant.status, 'active');
    assert.equal(getTelegramAgentGrantByToken(rawToken)?.agentName, 'researcher-a');
    assert.equal(getTelegramAgentGrantByToken(rawToken)?.useCount, 0);
    assert.equal(getTelegramAgentGrantByToken(rawToken)?.lastUsedAt, null);

    recordTelegramAgentGrantRead({
      grantId: grant.id,
      agentName: grant.agentName,
      chatId: grant.chatId,
      command: 'tail',
      scope: 'tail',
      query: null,
      limitValue: 50,
      resultCount: 12,
      success: true,
      errorCode: null,
    });
    const readCountRow = getDb()
      .prepare(
        `SELECT count(*) AS count
         FROM telegram_agent_grant_reads
         WHERE grant_id = ?`
      )
      .get(grant.id) as { count: number };
    assert.equal(readCountRow.count, 1);
    const usedGrant = getTelegramAgentGrantByToken(rawToken);
    assert.equal(usedGrant?.useCount, 1);
    assert.equal(typeof usedGrant?.lastUsedAt, 'number');

    assert.throws(() => {
      recordTelegramAgentGrantRead({
        grantId: 'missing-grant-id',
        agentName: grant.agentName,
        chatId: grant.chatId,
        command: 'tail',
        scope: 'tail',
        query: null,
        limitValue: 25,
        resultCount: 0,
        success: false,
        errorCode: 'missing_grant',
      });
    });
    const readCountAfterInvalidGrant = getDb()
      .prepare(
        `SELECT count(*) AS count
         FROM telegram_agent_grant_reads
         WHERE grant_id = ?`
      )
      .get(grant.id) as { count: number };
    assert.equal(readCountAfterInvalidGrant.count, 1);

    assert.equal(listActiveTelegramAgentGrants().length, 1);

    revokeTelegramAgentGrant({
      agentName: 'researcher-a',
      chatId: '-1001234567890',
      revokedByTelegramUserId: '42',
    });
    assert.equal(getTelegramAgentGrantByToken(rawToken)?.status, 'revoked');

    const { handleTelegramApprovalBotMessage } = await import('../lib/server/telegramAgentApprovalBot');
    const replies: Array<{ chatId: string; text: string }> = [];
    const sendReply = async ({ chatId, text }: { chatId: string; text: string }) => {
      replies.push({ chatId, text });
    };

    const grantReply = await handleTelegramApprovalBotMessage({
      approvalChatId: '-5130530086',
      text: '/grant -1001234567890',
      fromUserId: '42',
      fromUsername: 'xp',
      sendMessage: sendReply,
    });
    assert.equal(grantReply.handled, true);
    assert.match(replies.at(-1)?.text || '', /请继续发送/);

    const agentReply = await handleTelegramApprovalBotMessage({
      approvalChatId: '-5130530086',
      text: '/agent researcher-a',
      fromUserId: '42',
      fromUsername: 'xp',
      sendMessage: sendReply,
    });
    assert.equal(agentReply.handled, true);
    assert.match(replies.at(-1)?.text || '', /授权已创建/);
    assert.match(replies.at(-1)?.text || '', /researcher-a/);

    const accessReply = await handleTelegramApprovalBotMessage({
      approvalChatId: '-5130530086',
      text: '/access agent researcher-a',
      fromUserId: '42',
      fromUsername: 'xp',
      sendMessage: sendReply,
    });
    assert.equal(accessReply.handled, true);
    assert.match(replies.at(-1)?.text || '', /active chats/);

    const denied = await handleTelegramApprovalBotMessage({
      approvalChatId: '-5130530086',
      text: '/grant -1009999999999',
      fromUserId: '100',
      fromUsername: 'guest',
      sendMessage: sendReply,
    });
    assert.equal(denied.handled, true);
    assert.match(replies.at(-1)?.text || '', /无权限|not allowed/i);

    console.log('PASS telegram agent authorization repo');
  } finally {
    if (typeof previousDataDir === 'string') {
      process.env.PILIPILI_DATA_DIR = previousDataDir;
    } else {
      delete process.env.PILIPILI_DATA_DIR;
    }
    if (typeof previousDbPath === 'string') {
      process.env.PILIPILI_DB_PATH = previousDbPath;
    } else {
      delete process.env.PILIPILI_DB_PATH;
    }
    if (typeof previousApprovalAdminIds === 'string') {
      process.env.TELEGRAM_APPROVAL_ADMIN_USER_IDS = previousApprovalAdminIds;
    } else {
      delete process.env.TELEGRAM_APPROVAL_ADMIN_USER_IDS;
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
}

void run().catch((error) => {
  console.error(error);
  process.exit(1);
});
