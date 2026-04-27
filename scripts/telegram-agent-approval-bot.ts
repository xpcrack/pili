import path from 'node:path';

import {
  deleteTelegramApprovalBotWebhook,
  runTelegramApprovalBotCycle,
} from '@/lib/server/telegramApprovalBotRuntime';

import './server-only-shim.cjs';
import { loadEnvFile } from './telegram-bridge-core';

loadEnvFile(path.join(process.cwd(), '.env.local'));

const IDLE_POLL_DELAY_MS = 100;
const FAILURE_SLEEP_MS = 3_000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  await deleteTelegramApprovalBotWebhook();
  console.log('[telegram-agent-approval-bot] webhook cleared');

  while (true) {
    const cycle = await runTelegramApprovalBotCycle();
    if (cycle.status === 'error' || cycle.status === 'missing-credentials') {
      console.error(
        `[telegram-agent-approval-bot] cycle ${cycle.status}: ${cycle.lastError || 'unknown error'} (sleep=${FAILURE_SLEEP_MS}ms)`
      );
      await sleep(FAILURE_SLEEP_MS);
      continue;
    }

    if (cycle.sleepMs > 0) {
      await sleep(cycle.sleepMs);
      continue;
    }

    if (cycle.updateCount === 0) {
      await sleep(IDLE_POLL_DELAY_MS);
    }
  }
}

void run().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[telegram-agent-approval-bot] failed: ${message}`);
  await sleep(FAILURE_SLEEP_MS);
  process.exit(1);
});
