import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

import './server-only-shim.cjs';
// eslint-disable-next-line import/order -- must run before gmgnRateLimit import
import './test-gmgn-last-ban-age-setup.cjs';
import { gmgnLastBanAgeMs } from '@/lib/server/gmgnRateLimit';

const COOLDOWN_FILE = process.env.GMGN_BAN_COOLDOWN_FILE!;

async function testNeverBannedIsInfinity() {
  assert.equal(gmgnLastBanAgeMs(), Number.POSITIVE_INFINITY, 'no recorded ban ⇒ Infinity');
}

async function testRecentBanAge() {
  const twoMinAgo = new Date(Date.now() - 2 * 60_000).toISOString();
  writeFileSync(
    COOLDOWN_FILE,
    JSON.stringify({ untilMs: Date.now() - 60_000, lastBanAt: twoMinAgo }),
    'utf8'
  );
  const age = gmgnLastBanAgeMs();
  assert.ok(age >= 118_000 && age <= 122_000, `expected ~120s, got ${age}`);
}

async function testUntilOnlyFileIsNotABan() {
  writeFileSync(COOLDOWN_FILE, JSON.stringify({ untilMs: 0 }), 'utf8');
  assert.equal(gmgnLastBanAgeMs(), Number.POSITIVE_INFINITY, 'untilMs without lastBanAt ⇒ unknown, not a ban');
}

async function testFutureLastBanClampsToZero() {
  const future = new Date(Date.now() + 60_000).toISOString();
  writeFileSync(
    COOLDOWN_FILE,
    JSON.stringify({ untilMs: Date.now() + 120_000, lastBanAt: future }),
    'utf8'
  );
  assert.equal(gmgnLastBanAgeMs(), 0, 'future/clock-skewed lastBanAt clamps to 0 (ban just happened)');
}

(async () => {
  await testNeverBannedIsInfinity();
  await testRecentBanAge();
  await testUntilOnlyFileIsNotABan();
  await testFutureLastBanClampsToZero();
  console.log('test-gmgn-last-ban-age: all assertions passed');
})();
