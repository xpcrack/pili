import path from 'node:path';

import './server-only-shim.cjs';
import { loadEnvFile } from './telegram-bridge-core';

loadEnvFile(path.join(process.cwd(), '.env.local'));

async function run() {
  const { readTelegramClientConfig } = await import('../lib/server/telegramClientConfig');
  const { createTelegramGramjsClient } = await import('../lib/server/telegramGramjsClient');
  const { backfillTelegramBridgeHistory } = await import('../lib/server/telegramBridgeMtprotoBackfill');
  const { readTelegramMtprotoPolicy } = await import('../lib/server/telegramMtprotoPolicy');

  const config = readTelegramClientConfig();
  if (config.status === 'missing_credentials') {
    throw new Error('Missing TELEGRAM_API_ID or TELEGRAM_API_HASH');
  }
  if (config.status === 'auth_required') {
    throw new Error('Missing TELEGRAM_SESSION_STRING. Run telegram-channel-login first.');
  }

  const policy = readTelegramMtprotoPolicy();
  const client = await createTelegramGramjsClient();
  try {
    const result = await backfillTelegramBridgeHistory({
      client,
      limitPerChat: policy.bridgeBackfillLimit,
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await client.disconnect?.();
  }
}

void run().catch((error) => {
  console.error('[telegram-bridge-backfill] failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
