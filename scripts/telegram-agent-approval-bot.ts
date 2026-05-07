import {
  deleteTelegramApprovalBotWebhook,
  runTelegramApprovalBotCycle,
} from '@/lib/server/telegramApprovalBotRuntime';
import { sleep } from '@/lib/timing';

import './server-only-shim.cjs';
import { loadWorkerEnv } from './lib/workerLifecycle';

loadWorkerEnv();

const IDLE_POLL_DELAY_MS = 100;
const FAILURE_SLEEP_MS = 3_000;
const LOG_PREFIX = '[telegram-agent-approval-bot]';
let webhookCleared = false;
let nextWebhookRetryAtMs = 0;

async function tryClearWebhook() {
  const nowMs = Date.now();
  if (webhookCleared || nowMs < nextWebhookRetryAtMs) {
    return;
  }

  try {
    await deleteTelegramApprovalBotWebhook();
    webhookCleared = true;
    console.log(`${LOG_PREFIX} webhook cleared`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    nextWebhookRetryAtMs = nowMs + FAILURE_SLEEP_MS;
    console.error(
      `${LOG_PREFIX} deleteWebhook failed: ${message} (retry in ${FAILURE_SLEEP_MS}ms)`
    );
  }
}

async function run() {
  while (true) {
    await tryClearWebhook();

    const cycle = await runTelegramApprovalBotCycle();
    if (cycle.status === 'error' || cycle.status === 'missing-credentials') {
      console.error(
        `${LOG_PREFIX} cycle ${cycle.status}: ${cycle.lastError || 'unknown error'} (sleep=${FAILURE_SLEEP_MS}ms)`
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
  console.error(`${LOG_PREFIX} failed: ${message}`);
  await sleep(FAILURE_SLEEP_MS);
  process.exit(1);
});
