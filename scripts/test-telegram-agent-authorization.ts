import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';
import type { TelegramChannelSyncClient } from '../lib/server/telegramChannelTypes';

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

    const { runTelegramAgentRead } = await import('../lib/server/telegramAgentReadService');
    const stubClient: TelegramChannelSyncClient = {
      async resolveChannel() {
        throw new Error('unused');
      },
      async listChannelMessages() {
        return [];
      },
      async listAgentChatMessages() {
        return [{ messageId: 1, date: 1710000000, text: 'hello', sender: null }];
      },
      async searchAgentChatMessages() {
        return { searchMode: 'telegram' as const, items: [] };
      },
    };

    const okTail = await runTelegramAgentRead({
      mode: 'tail',
      chatId: '-1001234567890',
      token: rawToken,
      limit: 2,
      client: stubClient,
    });
    assert.equal(okTail.ok, true);
    if (okTail.ok) {
      assert.equal(okTail.mode, 'tail');
      assert.equal(okTail.items.length, 1);
    }

    const invalidToken = await runTelegramAgentRead({
      mode: 'tail',
      chatId: '-1001234567890',
      token: '',
      limit: 2,
      client: stubClient,
    });
    assert.equal(invalidToken.ok, false);
    if (!invalidToken.ok) {
      assert.equal(invalidToken.error, 'invalid_token');
    }

    const mismatch = await runTelegramAgentRead({
      mode: 'tail',
      chatId: '-1009999999999',
      token: rawToken,
      limit: 2,
      client: stubClient,
    });
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok) {
      assert.equal(mismatch.error, 'chat_mismatch');
    }

    const tailOnlyToken = 'tgagt_tail_only_token';
    upsertTelegramAgentGrant({
      approvalChatId: '-5130530086',
      agentName: 'researcher-tail-only',
      chatId: '-1001234567890',
      scope: ['tail'],
      tokenHash: hashTelegramAgentToken(tailOnlyToken),
      tokenPreview: tailOnlyToken.slice(0, 8),
      createdByTelegramUserId: '42',
      createdByTelegramUsername: 'xp',
    });
    const scopeDenied = await runTelegramAgentRead({
      mode: 'search',
      chatId: '-1001234567890',
      token: tailOnlyToken,
      query: 'hello',
      limit: 2,
      client: stubClient,
    });
    assert.equal(scopeDenied.ok, false);
    if (!scopeDenied.ok) {
      assert.equal(scopeDenied.error, 'scope_denied');
    }

    const searchOnlyToken = 'tgagt_search_only_token';
    upsertTelegramAgentGrant({
      approvalChatId: '-5130530086',
      agentName: 'researcher-search-only',
      chatId: '-1001234567890',
      scope: ['search'],
      tokenHash: hashTelegramAgentToken(searchOnlyToken),
      tokenPreview: searchOnlyToken.slice(0, 8),
      createdByTelegramUserId: '42',
      createdByTelegramUsername: 'xp',
    });
    const queryRequired = await runTelegramAgentRead({
      mode: 'search',
      chatId: '-1001234567890',
      token: searchOnlyToken,
      limit: 2,
      client: stubClient,
    });
    assert.equal(queryRequired.ok, false);
    if (!queryRequired.ok) {
      assert.equal(queryRequired.error, 'query_required');
    }

    const chatUnavailableClient: TelegramChannelSyncClient = {
      async resolveChannel() {
        throw new Error('unused');
      },
      async listChannelMessages() {
        return [];
      },
      async listAgentChatMessages() {
        throw new Error('CHANNEL_INVALID');
      },
      async searchAgentChatMessages() {
        return { searchMode: 'telegram' as const, items: [] };
      },
    };
    const chatUnavailable = await runTelegramAgentRead({
      mode: 'tail',
      chatId: '-1001234567890',
      token: rawToken,
      limit: 2,
      client: chatUnavailableClient,
    });
    assert.equal(chatUnavailable.ok, false);
    if (!chatUnavailable.ok) {
      assert.equal(chatUnavailable.error, 'telegram_chat_unavailable');
    }

    const authUnavailableClient: TelegramChannelSyncClient = {
      async resolveChannel() {
        throw new Error('unused');
      },
      async listChannelMessages() {
        return [];
      },
      async listAgentChatMessages() {
        throw new Error('Missing TELEGRAM_SESSION_STRING');
      },
      async searchAgentChatMessages() {
        return { searchMode: 'telegram' as const, items: [] };
      },
    };
    const authUnavailable = await runTelegramAgentRead({
      mode: 'tail',
      chatId: '-1001234567890',
      token: rawToken,
      limit: 2,
      client: authUnavailableClient,
    });
    assert.equal(authUnavailable.ok, false);
    if (!authUnavailable.ok) {
      assert.equal(authUnavailable.error, 'telegram_auth_unavailable');
    }

    const failClosedToken = 'tgagt_fail_closed_token';
    upsertTelegramAgentGrant({
      approvalChatId: '-5130530086',
      agentName: 'researcher-fail-closed',
      chatId: '-1001234567890',
      scope: ['tail'],
      tokenHash: hashTelegramAgentToken(failClosedToken),
      tokenPreview: failClosedToken.slice(0, 8),
      createdByTelegramUserId: '42',
      createdByTelegramUsername: 'xp',
    });
    const auditFailureClient: TelegramChannelSyncClient = {
      async resolveChannel() {
        throw new Error('unused');
      },
      async listChannelMessages() {
        return [];
      },
      async listAgentChatMessages() {
        revokeTelegramAgentGrant({
          agentName: 'researcher-fail-closed',
          chatId: '-1001234567890',
          revokedByTelegramUserId: '42',
        });
        return [{ messageId: 11, date: 1710001234, text: 'race', sender: null }];
      },
      async searchAgentChatMessages() {
        return { searchMode: 'telegram' as const, items: [] };
      },
    };
    const auditFailure = await runTelegramAgentRead({
      mode: 'tail',
      chatId: '-1001234567890',
      token: failClosedToken,
      limit: 2,
      client: auditFailureClient,
    });
    assert.equal(auditFailure.ok, false);
    if (!auditFailure.ok) {
      assert.equal(auditFailure.error, 'grant_revoked');
    }

    revokeTelegramAgentGrant({
      agentName: 'researcher-a',
      chatId: '-1001234567890',
      revokedByTelegramUserId: '42',
    });
    assert.equal(getTelegramAgentGrantByToken(rawToken)?.status, 'revoked');

    const revoked = await runTelegramAgentRead({
      mode: 'search',
      chatId: '-1001234567890',
      token: rawToken,
      query: 'hello',
      limit: 2,
      client: stubClient,
    });
    assert.equal(revoked.ok, false);
    if (!revoked.ok) {
      assert.equal(revoked.error, 'grant_revoked');
    }

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

    const linkGrantReply = await handleTelegramApprovalBotMessage({
      approvalChatId: '-5130530086',
      text: '/grant https://t.me/publicchan',
      fromUserId: '42',
      fromUsername: 'xp',
      sendMessage: sendReply,
      resolveGrantTarget: async (target) => {
        assert.equal(target, 'https://t.me/publicchan');
        return {
          requestedChatId: '-1007777777777',
          displayRef: '@publicchan',
        };
      },
    });
    assert.equal(linkGrantReply.handled, true);
    assert.match(replies.at(-1)?.text || '', /-1007777777777/);
    assert.match(replies.at(-1)?.text || '', /来源:\s*@publicchan/);
    assert.equal(readPendingTelegramAgentGrantForUser('42')?.requestedChatId, '-1007777777777');

    const mentionedCommandForThisBot = await handleTelegramApprovalBotMessage({
      approvalChatId: '-5130530086',
      text: '/grant@xpcrack_god_bot -1001234567890',
      fromUserId: '42',
      fromUsername: 'xp',
      sendMessage: sendReply,
      botUsername: 'xpcrack_god_bot',
    });
    assert.equal(mentionedCommandForThisBot.handled, true);
    assert.match(replies.at(-1)?.text || '', /请继续发送/);

    const infraDeniedGrant = await handleTelegramApprovalBotMessage({
      approvalChatId: '-5130530086',
      text: '/grant https://t.me/publicchan',
      fromUserId: '42',
      fromUsername: 'xp',
      sendMessage: sendReply,
      resolveGrantTarget: async () => {
        throw new Error('Missing TELEGRAM_SESSION_STRING');
      },
    });
    assert.equal(infraDeniedGrant.handled, true);
    assert.match(replies.at(-1)?.text || '', /TELEGRAM_SESSION_STRING|会话|登录/i);

    const denied = await handleTelegramApprovalBotMessage({
      approvalChatId: '-5130530086',
      text: '/grant -1009999999999',
      fromUserId: '100',
      fromUsername: 'guest',
      sendMessage: sendReply,
    });
    assert.equal(denied.handled, true);
    assert.match(replies.at(-1)?.text || '', /无权限|not allowed/i);
    assert.equal(readPendingTelegramAgentGrantForUser('100'), null);
    assert.equal(
      listActiveTelegramAgentGrants().some(
        (activeGrant) => activeGrant.chatId === '-1009999999999' && activeGrant.createdByTelegramUserId === '100'
      ),
      false
    );

    const noSlashCommand = await handleTelegramApprovalBotMessage({
      approvalChatId: '-5130530086',
      text: 'grant -1001234567890',
      fromUserId: '42',
      fromUsername: 'xp',
      sendMessage: sendReply,
    });
    assert.equal(noSlashCommand.handled, false);

    const mentionedCommand = await handleTelegramApprovalBotMessage({
      approvalChatId: '-5130530086',
      text: '/grant@otherbot -1001234567890',
      fromUserId: '42',
      fromUsername: 'xp',
      sendMessage: sendReply,
      botUsername: 'xpcrack_god_bot',
    });
    assert.equal(mentionedCommand.handled, false);

    const { runTelegramApprovalBotCycle } = await import('../lib/server/telegramApprovalBotRuntime');
    const seenMessages: string[] = [];
    let savedOffset = -1;
    const cycle = await runTelegramApprovalBotCycle({
      approvalChatId: '-5130530086',
      fetchUpdates: async () => [
        {
          update_id: 10,
          message: {
            chat: { id: '-5130530086' },
            from: { id: 42, username: 'xp' },
            text: '/grant -1001234567890',
          },
        },
      ],
      handleMessage: async ({ text }) => {
        seenMessages.push(text);
        return { handled: true };
      },
      readOffset: () => 0,
      saveOffset: (value) => {
        savedOffset = value;
      },
    });
    assert.equal(cycle.lastUpdateId, 10);
    assert.equal(savedOffset, 10);
    assert.deepEqual(seenMessages, ['/grant -1001234567890']);

    let crossChatHandled = false;
    const crossChatOffsets: number[] = [];
    const crossChatCycle = await runTelegramApprovalBotCycle({
      approvalChatId: '-5130530086',
      fetchUpdates: async () => [
        {
          update_id: 20,
          message: {
            chat: { id: '-1000000000001' },
            from: { id: 42, username: 'xp' },
            text: '/grant -1001234567890',
          },
        },
      ],
      handleMessage: async () => {
        crossChatHandled = true;
        return { handled: true };
      },
      readOffset: () => 0,
      saveOffset: (value) => {
        crossChatOffsets.push(value);
      },
    });
    assert.equal(crossChatHandled, false);
    assert.equal(crossChatCycle.lastUpdateId, 20);
    assert.deepEqual(crossChatOffsets, [20]);

    const partialBatchOffsets: number[] = [];
    const partialBatchSeen: string[] = [];
    const partialBatchCycle = await runTelegramApprovalBotCycle({
      approvalChatId: '-5130530086',
      fetchUpdates: async () => [
        {
          update_id: 30,
          message: {
            chat: { id: '-5130530086' },
            from: { id: 42, username: 'xp' },
            text: '/grant -1001234567890',
          },
        },
        {
          update_id: 31,
          message: {
            chat: { id: '-5130530086' },
            from: { id: 42, username: 'xp' },
            text: '/agent researcher-a',
          },
        },
      ],
      handleMessage: async ({ text }) => {
        partialBatchSeen.push(text);
        if (text.includes('/agent')) {
          throw new Error('boom-on-second-update');
        }
        return { handled: true };
      },
      readOffset: () => 0,
      saveOffset: (value) => {
        partialBatchOffsets.push(value);
      },
    });
    assert.deepEqual(partialBatchSeen, ['/grant -1001234567890', '/agent researcher-a']);
    assert.deepEqual(partialBatchOffsets, [30]);
    assert.equal(partialBatchCycle.status, 'error');
    assert.equal(partialBatchCycle.lastUpdateId, 30);

    const duplicateSeen: string[] = [];
    await runTelegramApprovalBotCycle({
      approvalChatId: '-5130530086',
      fetchUpdates: async () => [
        {
          update_id: 77,
          message: {
            chat: { id: '-5130530086' },
            from: { id: 42, username: 'xp' },
            text: '/grant -1001234567890',
          },
        },
      ],
      handleMessage: async ({ text }) => {
        duplicateSeen.push(text);
        return { handled: true };
      },
      readOffset: () => 0,
      saveOffset: () => {},
    });
    await runTelegramApprovalBotCycle({
      approvalChatId: '-5130530086',
      fetchUpdates: async () => [
        {
          update_id: 77,
          message: {
            chat: { id: '-5130530086' },
            from: { id: 42, username: 'xp' },
            text: '/grant -1001234567890',
          },
        },
      ],
      handleMessage: async ({ text }) => {
        duplicateSeen.push(text);
        return { handled: true };
      },
      readOffset: () => 0,
      saveOffset: () => {},
    });
    assert.deepEqual(duplicateSeen, ['/grant -1001234567890']);

    const concurrentSeen: string[] = [];
    const concurrentRuns = await Promise.all([
      runTelegramApprovalBotCycle({
        approvalChatId: '-5130530086',
        fetchUpdates: async () => {
          await new Promise((resolve) => setTimeout(resolve, 25));
          return [
            {
              update_id: 88,
              message: {
                chat: { id: '-5130530086' },
                from: { id: 42, username: 'xp' },
                text: '/grant -1001234567890',
              },
            },
          ];
        },
        handleMessage: async ({ text }) => {
          concurrentSeen.push(text);
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { handled: true };
        },
        readOffset: () => 0,
        saveOffset: () => {},
      }),
      runTelegramApprovalBotCycle({
        approvalChatId: '-5130530086',
        fetchUpdates: async () => {
          await new Promise((resolve) => setTimeout(resolve, 25));
          return [
            {
              update_id: 88,
              message: {
                chat: { id: '-5130530086' },
                from: { id: 42, username: 'xp' },
                text: '/grant -1001234567890',
              },
            },
          ];
        },
        handleMessage: async ({ text }) => {
          concurrentSeen.push(text);
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { handled: true };
        },
        readOffset: () => 0,
        saveOffset: () => {},
      }),
    ]);
    assert.equal(concurrentRuns[0].status === 'idle' || concurrentRuns[0].status === 'running', true);
    assert.equal(concurrentRuns[1].status === 'idle' || concurrentRuns[1].status === 'running', true);
    assert.equal(concurrentSeen.length, 1);

    const {
      assertTelegramSearchFallbackOrThrow,
      isUnsupportedTelegramSearchError,
      mapTelegramMessageToAgentReadItem,
    } = await import(
      '../lib/server/telegramGramjsClient'
    );
    assert.equal(
      isUnsupportedTelegramSearchError({
        errorCode: 400,
        errorMessage: 'SEARCH_WITH_LINK_NOT_SUPPORTED',
      }),
      true
    );
    assert.equal(
      isUnsupportedTelegramSearchError({
        message: 'search is unsupported right now',
      }),
      false
    );
    assert.doesNotThrow(() => {
      assertTelegramSearchFallbackOrThrow({
        errorCode: 400,
        errorMessage: 'SEARCH_WITH_LINK_NOT_SUPPORTED',
      });
    });
    assert.throws(() => {
      assertTelegramSearchFallbackOrThrow({
        message: 'search is unsupported right now',
      });
    });
    const mapped = mapTelegramMessageToAgentReadItem({
      id: 501,
      message: 'alpha beta',
      date: new Date(1710000000000),
      fromId: { userId: BigInt(77) },
      sender: {
        id: 77,
        username: 'alice',
        firstName: 'Alice',
        lastName: 'Z',
      },
    } as Record<string, unknown>);
    assert.equal(mapped?.messageId, 501);
    assert.equal(mapped?.text, 'alpha beta');
    assert.equal(mapped?.sender?.username, 'alice');
    assert.equal(mapped?.sender?.displayName, 'Alice Z');

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
