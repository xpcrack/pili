import assert from 'node:assert/strict';

import { extractMessage } from './telegram-bridge-core';

// 复刻 telegram-bridge.ts 的 checkBatchLag 语义（脚本不是模块导出，
// 这里对齐同一段逻辑做回归：连续 N 批 avg lag 超阈值才告警，低滞后清零）。
const LAG_ALERT_THRESHOLD_SEC = 300;
const LAG_ALERT_CONSECUTIVE_BATCHES = 3;
const LAG_REALERT_MS = 30 * 60 * 1000;

function makeWatchdog() {
  let consecutiveHighLagBatches = 0;
  let alerts: number[] = [];
  let lastLagAlertAtMs = 0;
  return {
    alerts: () => alerts,
    check(lagsSec: number[], nowMs: number) {
      if (lagsSec.length === 0) return;
      const avgLag = lagsSec.reduce((sum, v) => sum + v, 0) / lagsSec.length;
      if (avgLag >= LAG_ALERT_THRESHOLD_SEC) {
        consecutiveHighLagBatches += 1;
        if (
          consecutiveHighLagBatches >= LAG_ALERT_CONSECUTIVE_BATCHES &&
          nowMs - lastLagAlertAtMs >= LAG_REALERT_MS
        ) {
          lastLagAlertAtMs = nowMs;
          alerts.push(avgLag);
        }
      } else {
        consecutiveHighLagBatches = 0;
      }
    },
  };
}

async function main() {
  const wd = makeWatchdog();
  // t0 取大值，避免 lastLagAlertAtMs=0 时首轮被 REALERT 节流误挡
  const t0 = 10 * LAG_REALERT_MS;

  // 1) 单批高滞后（低于 N=3）不告警
  wd.check([600, 610, 620], t0);
  assert.equal(wd.alerts().length, 0, '单批高滞后不应告警');
  // 2) 连续第 2 批仍不告警
  wd.check([600], t0 + 1000);
  assert.equal(wd.alerts().length, 0, '两批高滞后不应告警');
  // 3) 第 3 批 → 告警 1 次
  wd.check([600, 700], t0 + 2000);
  assert.equal(wd.alerts().length, 1, '连续 3 批应告警');
  // 4) REALERT 节流：30min 内再触发也不告警
  wd.check([600], t0 + 3000);
  wd.check([600], t0 + 4000);
  wd.check([600], t0 + 5000);
  assert.equal(wd.alerts().length, 1, '节流窗口内不应重复告警');
  // 5) 低滞后批清零计数，再触发需重新连续 3 批
  const t1 = t0 + LAG_REALERT_MS + 60_000;
  wd.check([10], t1);
  wd.check([600], t1 + 1000);
  wd.check([600], t1 + 2000);
  assert.equal(wd.alerts().length, 1, '低滞后清零后 2 批不应告警');
  wd.check([600], t1 + 3000);
  assert.equal(wd.alerts().length, 2, '清零后重新连续 3 批应告警');
  // 6) 空批不触发也不清零
  wd.check([], t1 + 4000);
  assert.equal(wd.alerts().length, 2, '空批不触发');

  // 7) extractMessage().date 是 lag 采样源（字段存在性回归）
  const update = { update_id: 1, message: { date: 1_700_000_000, text: 'x' } };
  const msg = extractMessage(update as never);
  assert.equal(typeof msg?.date, 'number');

  console.log('telegram bridge lag watchdog tests: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
