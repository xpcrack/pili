import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

import './server-only-shim.cjs';

const require = createRequire(import.meta.url);

async function run() {
  const { readSystemConfig } = await import('../lib/server/systemConfigRepo');

  const before = readSystemConfig();
  const child = spawnSync(
    process.execPath,
    [require.resolve('tsx/cli'), 'scripts/test-parser-fixtures.ts'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_OPTIONS: `--require ${path.join(process.cwd(), 'scripts/server-only-shim.cjs')}`,
        PARSER_FIXTURE_TEST_CRASH_AFTER_SYSTEM_CONFIG: '1',
      },
      encoding: 'utf8',
    }
  );

  assert.notEqual(child.status, 0, 'expected parser fixtures crash marker to stop the subprocess');
  assert.match(
    `${child.stdout}\n${child.stderr}`,
    /parser-fixtures-intentional-crash-after-system-config/,
    'expected crash marker in parser fixtures output'
  );

  const after = readSystemConfig();
  assert.deepEqual(after, before, 'parser fixtures crash should not mutate the live system config');

  console.log('parser fixtures isolation test: ok');
}

void run();
