import path from 'node:path';

import './server-only-shim.cjs';
import { loadEnvFile } from './telegram-bridge-core';

loadEnvFile(path.join(process.cwd(), '.env.local'));

async function run() {
  const { readTelegramClientConfig } = await import('../lib/server/telegramClientConfig');
  const { createTelegramGramjsClient } = await import('../lib/server/telegramGramjsClient');
  const { syncAllTelegramChannelSources } = await import('../lib/server/telegramChannelSync');

  const config = readTelegramClientConfig();
  if (config.status === 'missing_credentials') {
    throw new Error('Missing TELEGRAM_API_ID or TELEGRAM_API_HASH');
  }
  if (config.status === 'auth_required') {
    throw new Error('Missing TELEGRAM_SESSION_STRING. Run `npx tsx scripts/telegram-channel-login.ts` first.');
  }

  const client = await createTelegramGramjsClient();
  try {
    const result = await syncAllTelegramChannelSources({
      client,
    });
    if (result.sourceCount === 0) {
      console.log('[telegram-channel-sync] no enabled telegram channel sources');
      return;
    }

    for (const item of result.results) {
      if (item.ok) {
        console.log(
          `[telegram-channel-sync] ${item.channelRef} stored=${item.storedCount} projected=${item.projectedCount} lastMessageId=${item.lastMessageId ?? 'null'}`
        );
        continue;
      }
      console.log(`[telegram-channel-sync] ${item.channelRef} failed=${item.error || 'unknown error'}`);
    }

    if (result.errorCount > 0) {
      throw new Error(`telegram channel sync completed with ${result.errorCount} source error(s)`);
    }
  } finally {
    await client.disconnect?.();
  }
}

void run().catch((error) => {
  console.error('[telegram-channel-sync] failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
