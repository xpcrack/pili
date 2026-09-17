import assert from 'node:assert/strict';

import { readTelegramMtprotoPolicy } from '@/lib/server/telegramMtprotoPolicy';
import { TimeoutError, sleep, withTimeout } from '@/lib/timing';

/**
 * 2026-09-03 事故回归：telegram channel worker 的一轮 cycle 在 MTProto 断连后永久挂起，
 * 且当时没有任何超时保护 → 进程假活 13 天、频道消息零入库。
 *
 * 本测试钉住两件契约：
 * 1) withTimeout 对「永不 settle 的操作」必须按时抛 TimeoutError（否则 worker 无法自愈）；
 * 2) 正常操作必须原样返回，且不残留计时器（否则 worker 循环会被误杀）。
 * 3) policy 暴露 channelCycleTimeoutMs，可用环境变量覆盖。
 */

async function run() {
  // 1) 正常操作原样返回
  const fast = await withTimeout(async () => {
    await sleep(10);
    return { status: 'idle' as const };
  }, 1000, 'fast');
  assert.deepEqual(fast, { status: 'idle' });

  // 2) 永不 settle → TimeoutError，且在超时附近（不能提前，也不能拖太久）
  const startedAt = Date.now();
  let thrown: unknown = null;
  try {
    await withTimeout(() => new Promise<never>(() => {}), 120, 'hang');
  } catch (error) {
    thrown = error;
  }
  const elapsedMs = Date.now() - startedAt;
  assert.ok(thrown instanceof TimeoutError, `expected TimeoutError, got ${String(thrown)}`);
  assert.match(String((thrown as Error).message), /hang timed out after 120ms/);
  assert.ok(elapsedMs >= 110, `timed out too early: ${elapsedMs}ms`);
  assert.ok(elapsedMs < 1000, `timed out too late: ${elapsedMs}ms`);

  // 3) 抛错的操作保持原错误类型（不被超时包装）
  await assert.rejects(
    withTimeout(async () => {
      throw new Error('boom');
    }, 1000, 'boom'),
    /boom/
  );

  // 4) policy：默认 180s，环境变量可覆盖
  delete process.env.TELEGRAM_CHANNEL_CYCLE_TIMEOUT_MS;
  assert.equal(readTelegramMtprotoPolicy().channelCycleTimeoutMs, 180_000);
  process.env.TELEGRAM_CHANNEL_CYCLE_TIMEOUT_MS = '45000';
  assert.equal(readTelegramMtprotoPolicy().channelCycleTimeoutMs, 45_000);
  process.env.TELEGRAM_CHANNEL_CYCLE_TIMEOUT_MS = 'not-a-number';
  assert.equal(readTelegramMtprotoPolicy().channelCycleTimeoutMs, 180_000);
  delete process.env.TELEGRAM_CHANNEL_CYCLE_TIMEOUT_MS;

  console.log('test-telegram-channel-cycle-timeout: ok');
}

void run().catch((error) => {
  console.error(error);
  process.exit(1);
});
