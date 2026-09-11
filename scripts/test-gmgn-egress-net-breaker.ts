import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import './server-only-shim.cjs';

// Project rule: GMGN tests must redirect cooldown/bucket paths to a temp dir.
// gmgnRateLimit captures GMGN_BAN_COOLDOWN_FILE at module load, so env must be
// set before the dynamic import below.
const testDir = mkdtempSync(path.join(os.tmpdir(), 'pili-net-breaker-'));
process.env.GMGN_BAN_COOLDOWN_FILE = path.join(testDir, 'cooldown.json');
process.env.GMGN_GLOBAL_BUCKET_FILE = path.join(testDir, 'bucket.json');

async function main() {
  const mod = await import('../lib/server/gmgnRateLimit');

  const {
    assertGmgnEgressAllowed,
    gmgnEgressNetQuarantineRemainingMs,
    isGmgnBanMessage,
    noteGmgnEgressNetworkError,
    noteGmgnEgressNetworkSuccess,
    resetGmgnEgressNetBreakers,
  } = mod;

  const scope = 'http://127.0.0.1:17891';
  const other = 'http://127.0.0.1:17892';

  // 1. below the fail limit the lane stays open
  for (let i = 0; i < 3; i++) noteGmgnEgressNetworkError(scope, 1000);
  assert.equal(gmgnEgressNetQuarantineRemainingMs(scope, 1000), 0);
  assert.doesNotThrow(() => assertGmgnEgressAllowed(scope, 1000));

  // 2. reaching the fail limit quarantines for 60s
  resetGmgnEgressNetBreakers();
  for (let i = 0; i < 4; i++) noteGmgnEgressNetworkError(scope, 2000);
  assert.equal(gmgnEgressNetQuarantineRemainingMs(scope, 2000), 60_000);
  assert.throws(
    () => assertGmgnEgressAllowed(scope, 2000),
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      return msg.startsWith('GMGN_COOLDOWN') && msg.includes('network flap');
    },
    'quarantined lane must throw a GMGN_COOLDOWN prefixed error'
  );
  // …and that message must not be treated as a fresh server ban
  assert.equal(isGmgnBanMessage('GMGN_COOLDOWN 60s remaining (egress network flap quarantine)'), false);

  // 3. a success resets the streak
  resetGmgnEgressNetBreakers();
  for (let i = 0; i < 3; i++) noteGmgnEgressNetworkError(scope, 3000);
  noteGmgnEgressNetworkSuccess(scope);
  for (let i = 0; i < 3; i++) noteGmgnEgressNetworkError(scope, 3000);
  assert.equal(gmgnEgressNetQuarantineRemainingMs(scope, 3000), 0);

  // 4. quarantine expires; a still-sick lane re-arms after one probe
  resetGmgnEgressNetBreakers();
  for (let i = 0; i < 4; i++) noteGmgnEgressNetworkError(scope, 4000);
  assert.equal(gmgnEgressNetQuarantineRemainingMs(scope, 4000), 60_000);
  assert.equal(gmgnEgressNetQuarantineRemainingMs(scope, 64_000), 0);
  assert.doesNotThrow(() => assertGmgnEgressAllowed(scope, 64_000));
  noteGmgnEgressNetworkError(scope, 64_000);
  assert.equal(gmgnEgressNetQuarantineRemainingMs(scope, 64_000), 60_000);

  // 5. scopes are isolated
  resetGmgnEgressNetBreakers();
  for (let i = 0; i < 4; i++) noteGmgnEgressNetworkError(scope, 5000);
  assert.doesNotThrow(() => assertGmgnEgressAllowed(other, 5000));

  // 6. in-process only — no shared file is written
  resetGmgnEgressNetBreakers();
  for (let i = 0; i < 4; i++) noteGmgnEgressNetworkError(scope, 6000);
  const files = readdirSync(testDir);
  assert.deepEqual(
    files.filter((f) => f.includes('cooldown') || f.includes('17891')),
    [],
    'breaker must never write the shared cooldown files'
  );

  // 7. empty scope is a no-op
  assert.equal(noteGmgnEgressNetworkError('', 7000), 0);
  noteGmgnEgressNetworkSuccess('');
  assert.equal(gmgnEgressNetQuarantineRemainingMs('', 7000), 0);

  console.log('gmgn egress net-flap breaker tests: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});