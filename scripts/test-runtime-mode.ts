import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function run() {
  const repoRoot = process.cwd();
  const ecosystemPath = join(repoRoot, 'pm2', 'ecosystem.config.cjs');
  const runtimeMode = readFileSync(join(repoRoot, 'scripts', 'runtime-mode.ts'), 'utf8');
  const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };

  assert.equal(existsSync(ecosystemPath), true, 'pm2/ecosystem.config.cjs should exist');

  const ecosystemConfig = readFileSync(ecosystemPath, 'utf8');
  for (const appName of ['pili-web-prod', 'pili-web-dev']) {
    assert.match(
      ecosystemConfig,
      new RegExp(`name:\\s*['\"]${appName}['\"]`),
      `ecosystem config should define ${appName}`
    );
  }

  assert.doesNotMatch(
    ecosystemConfig,
    /pili-telegram-channel-worker/,
    'ecosystem config should retire the old telegram worker pm2 app'
  );
  assert.doesNotMatch(
    ecosystemConfig,
    /pili-completeness-worker/,
    'ecosystem config should retire the old completeness worker pm2 app'
  );

  assert.doesNotMatch(ecosystemConfig, /npm run start/, 'production pm2 app should not wrap Bun in npm');
  assert.match(
    ecosystemConfig,
    /\.bun\/bin\/bun[\s\S]*server\/runtime\.ts[\s\S]*prod/,
    'production pm2 app should let pm2 manage the Bun runtime process directly'
  );
  assert.match(
    ecosystemConfig,
    /max_memory_restart:\s*['"]1200M['"]/,
    'production pm2 app should keep the Bun memory restart guardrail'
  );
  assert.match(ecosystemConfig, /npm run dev/, 'ecosystem config should run npm run dev');
  assert.match(ecosystemConfig, /PORT:\s*['\"]3013['\"]/, 'ecosystem config should pin production port 3013');
  assert.match(ecosystemConfig, /PORT:\s*['\"]3005['\"]/, 'ecosystem config should pin dev port 3005');

  const expectedScripts = {
    'runtime:status': 'tsx scripts/runtime-mode.ts status',
    'runtime:dev:on': 'tsx scripts/runtime-mode.ts dev-on',
    'runtime:dev:off': 'tsx scripts/runtime-mode.ts dev-off',
    'runtime:refresh': 'tsx scripts/runtime-mode.ts refresh',
    'test:runtime-mode': 'tsx scripts/test-runtime-mode.ts',
  } satisfies Record<string, string>;

  for (const [scriptName, expectedCommand] of Object.entries(expectedScripts)) {
    assert.equal(
      packageJson.scripts?.[scriptName],
      expectedCommand,
      `package.json should expose ${scriptName}`
    );
  }

  assert.match(runtimeMode, /execFileSync\('pm2', \['jlist'\]/, 'runtime-mode should inspect pm2 jlist');
  assert.match(runtimeMode, /JSON\.parse/, 'runtime-mode should parse pm2 jlist JSON output');
  assert.match(runtimeMode, /name\s*===\s*processName/, 'runtime-mode should check process existence by name');
  assert.match(
    runtimeMode,
    /type RuntimeModeCommand = 'status' \| 'dev-on' \| 'dev-off' \| 'refresh';/,
    'runtime-mode should include refresh in command union'
  );
  assert.match(
    runtimeMode,
    /if \(!command \|\| !\['status', 'dev-on', 'dev-off', 'refresh'\]\.includes\(command\)\)/,
    'runtime-mode should accept refresh command from argv'
  );
  assert.match(
    runtimeMode,
    /stopIfPresent\('pili'\)/,
    'runtime-mode should retire the legacy pili process'
  );
  assert.match(
    runtimeMode,
    /if \(command === 'refresh'\) \{[\s\S]*runNpm\(\['run', 'build'\]\);[\s\S]*pili-web-prod[\s\S]*\}/,
    'refresh flow should run build before operating production web process'
  );
  assert.match(
    runtimeMode,
    /if \(command === 'refresh'\) \{[\s\S]*deleteIfPresent\('pili-web-prod'\);[\s\S]*startPm2Process\('pili-web-prod'\);[\s\S]*\}/,
    'refresh flow should recreate pili-web-prod from the ecosystem config so script changes take effect'
  );
  assert.doesNotMatch(
    runtimeMode,
    /if \(command === 'refresh'\) \{[\s\S]*pili-telegram-channel-worker[\s\S]*\}/,
    'refresh flow should not touch telegram worker process'
  );
  assert.doesNotMatch(
    runtimeMode,
    /if \(command === 'refresh'\) \{[\s\S]*pili-completeness-worker[\s\S]*\}/,
    'refresh flow should not touch completeness worker process'
  );
  assert.doesNotMatch(
    runtimeMode,
    /Process or Namespace["']?\)\s*&&\s*output\.includes\(['\"]not found['\"]\)/,
    'runtime-mode should not rely on thrown pm2 stop error strings to detect missing processes'
  );

  console.log('runtime mode tests: ok');
}

run();
