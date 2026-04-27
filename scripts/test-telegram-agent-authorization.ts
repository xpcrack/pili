import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';

async function run() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pilipili-telegram-agent-auth-'));
  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');

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
    assert.equal(listActiveTelegramAgentGrants().length, 1);

    revokeTelegramAgentGrant({
      agentName: 'researcher-a',
      chatId: '-1001234567890',
      revokedByTelegramUserId: '42',
    });
    assert.equal(getTelegramAgentGrantByToken(rawToken)?.status, 'revoked');

    console.log('PASS telegram agent authorization repo');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

void run().catch((error) => {
  console.error(error);
  process.exit(1);
});
