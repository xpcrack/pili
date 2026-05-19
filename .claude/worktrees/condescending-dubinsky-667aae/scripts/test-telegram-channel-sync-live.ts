import path from 'node:path';

import './server-only-shim.cjs';
import { loadEnvFile } from './telegram-bridge-core';

loadEnvFile(path.join(process.cwd(), '.env.local'));

async function run() {
  const { readTelegramClientConfig } = await import('../lib/server/telegramClientConfig');
  const config = readTelegramClientConfig();

  if (config.status === 'missing_credentials') {
    throw new Error('Missing TELEGRAM_API_ID or TELEGRAM_API_HASH');
  }
  if (config.status === 'auth_required') {
    throw new Error('Missing TELEGRAM_SESSION_STRING. Run telegram-channel-login first.');
  }

  const { bootstrapTelegramChannelSourcesFromTrackedUsers, listTelegramChannelSources } = await import(
    '../lib/server/telegramChannelSourceRepo'
  );
  const { createTelegramGramjsClient } = await import('../lib/server/telegramGramjsClient');

  bootstrapTelegramChannelSourcesFromTrackedUsers();
  const [source] = listTelegramChannelSources({ enabledOnly: true });
  if (!source) {
    throw new Error('No enabled telegram channel source found. Fill tracked_users.telegram first.');
  }

  const client = await createTelegramGramjsClient();
  try {
    const resolved = await client.resolveChannel({
      channelRef: source.channelRef,
      channelUsername: source.channelUsername,
      channelChatId: source.channelChatId,
      accessHash: source.accessHash,
    });
    const messages = await client.listChannelMessages({
      source,
      resolved,
      minMessageId: source.lastMessageId,
      limit: 3,
    });
    console.log(
      JSON.stringify(
        {
          source: source.channelRef,
          resolved,
          messageCount: messages.length,
          latestMessageId: messages[messages.length - 1]?.messageId || null,
        },
        null,
        2
      )
    );
  } finally {
    await client.disconnect?.();
  }
}

void run().catch((error) => {
  console.error('[test-telegram-channel-sync-live] failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
